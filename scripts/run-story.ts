#!/usr/bin/env bun
/**
 * run-story.ts — Greedy DAG drainer for multi-issue stories.
 *
 * Usage: bun run scripts/run-story.ts <parent-N> [-p PARALLEL]
 *
 * Reads parent issue body checklist + each child's "Blocked by" section to
 * build the DAG. Spawns AFK workers (claude -w + /impl) for owner:bot children
 * up to parallel cap (default 3, hard max 5). Surfaces owner:human children via
 * a focused Supaterm tab carrying the alert banner (falls back to osascript
 * notification if Supaterm unreachable). Ticks parent body checklist on each
 * close, closes parent + final-notifies on completion.
 *
 * Tested via bun test scripts/run-story.test.ts.
 *
 * Self-detach is the caller's job — invoke with `nohup bun run ... &` (see
 * /impl story SKILL prose).
 */

export type Owner = "bot" | "human";
export type State = "OPEN" | "CLOSED";

export interface Issue {
  number: number;
  deps: number[];
  owner: Owner;
  state: State;
  title: string;
  cwd: string;
}

// =========================================================================
// Pure parsers / helpers (covered by run-story.test.ts)
// =========================================================================

const CHECKLIST_RE = /^- \[[ x]\] (?:[\w-]+)?#(\d+)\b/gm;

export function parseChecklist(body: string): number[] {
  const nums: number[] = [];
  for (const m of body.matchAll(CHECKLIST_RE)) {
    nums.push(Number(m[1]));
  }
  return nums;
}

export function parseBlockers(body: string): number[] {
  // Find the "## Blocked by" section, capture lines until next H2.
  const lines = body.split("\n");
  let inSection = false;
  const blockers: number[] = [];
  for (const line of lines) {
    if (/^## Blocked by\b/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^## /.test(line)) {
      break;
    }
    if (inSection) {
      const m = line.match(/ai-brain#(\d+)/);
      if (m) blockers.push(Number(m[1]));
    }
  }
  return blockers;
}

export function parseOwner(labels: string[]): Owner {
  for (const l of labels) {
    if (l === "owner:human") return "human";
    if (l === "owner:bot") return "bot";
  }
  return "bot";
}

// Public default area → repo path mapping. Extended at runtime from
// ${home}/.brain-os/areas.json so private deployments register their own
// areas without committing identifiers into this public source file.
export function defaultAreaMap(home: string): Record<string, string> {
  return {
    "plugin-brain-os": `${home}/work/brain-os-plugin`,
    "plugin-ai-leaders-vietnam": `${home}/work/ai-leaders-vietnam`,
    "vault": `${home}/work/brain`,
    "claude-config": `${home}/.claude`,
  };
}

export function inferRepoFromIssueArea(
  labels: string[],
  areaMap: Record<string, string>,
): string {
  for (const l of labels) {
    if (!l.startsWith("area:")) continue;
    const area = l.slice("area:".length);
    if (area in areaMap) return areaMap[area];
  }
  throw new Error(`no known area:* label in [${labels.join(", ")}]`);
}

export function tickChecklist(body: string, child: number): string {
  const re = new RegExp(`^- \\[ \\] #${child}\\b`, "gm");
  return body.replace(re, (m) => m.replace("[ ]", "[x]"));
}

export function clampParallel(p: number, hardCap: number): number {
  if (p < 1) return 1;
  if (p > hardCap) return hardCap;
  return p;
}

export function computeReady(issues: Issue[], closed: Set<number>): number[] {
  const ready: number[] = [];
  for (const issue of issues) {
    if (issue.state === "CLOSED") continue;
    if (closed.has(issue.number)) continue;
    const allDepsClosed = issue.deps.every((d) => closed.has(d));
    if (allDepsClosed) ready.push(issue.number);
  }
  return ready;
}

export function promoteWaiters(
  issues: Issue[],
  justClosed: number,
  closed: Set<number>,
  pending: Set<number>,
): number[] {
  const promoted: number[] = [];
  for (const issue of issues) {
    if (!pending.has(issue.number)) continue;
    if (!issue.deps.includes(justClosed)) continue;
    const allDepsClosed = issue.deps.every((d) => closed.has(d));
    if (allDepsClosed) promoted.push(issue.number);
  }
  return promoted;
}

// =========================================================================
// IO interfaces (mockable for integration tests)
// =========================================================================

export interface GhClient {
  viewBody(n: number): Promise<string>;
  viewFull(n: number): Promise<{ title: string; body: string; labels: string[]; state: State }>;
  viewState(n: number): Promise<State>;
  editBody(n: number, body: string): Promise<void>;
  closeIssue(n: number): Promise<void>;
  relabelHuman(n: number): Promise<void>;
}

export interface SpawnClient {
  spawnWorker(name: string, prompt: string, logPath: string, cwd: string): { pid: number };
  cleanupWorktree(name: string, cwd: string): void;
}

export interface ProcessChecker {
  isAlive(pid: number): boolean;
}

export interface Notifier {
  notify(message: string): void;
}

export interface Logger {
  log(msg: string): void;
}

export interface StoryStatus {
  ts: string;
  parent: number;
  phase: "starting" | "polling" | "done" | "died";
  pid: number;
  cap: number;
  watching: number[];
  ready: number[];
  closed: number[];
  failed: number[];
  hb: number;
  error?: string;
}

export interface StatusWriter {
  write(status: StoryStatus): void;
}

// Decide what to do with a watched AFK child after a poll cycle.
// Pure function — testable without IO.
export type WorkerAction = "running" | "closed" | "dead";

export function decideWorkerAction(pidAlive: boolean, state: State): WorkerAction {
  if (state === "CLOSED") return "closed";
  if (!pidAlive) return "dead"; // process gone but issue still OPEN = failure
  return "running";
}

// Remove worktree + branch left behind by a closed worker. Failures (locked
// dirs, missing branches, no-upstream protection) are logged and swallowed —
// a stuck cleanup must not block sibling drains.
export async function cleanupWorker(
  spawn: SpawnClient,
  name: string,
  cwd: string,
  logger: Logger,
): Promise<void> {
  try {
    spawn.cleanupWorktree(name, cwd);
    logger.log(`cleaned worktree: ${name} in ${cwd}`);
  } catch (err) {
    logger.log(`cleanup failed for ${name} in ${cwd}: ${(err as Error).message}`);
  }
}

// =========================================================================
// Real implementations (Bun.spawn / gh CLI / osascript)
// =========================================================================

class RealGh implements GhClient {
  constructor(private repo: string) {}

  private async run(args: string[]): Promise<string> {
    const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`gh ${args.join(" ")} exited ${code}: ${err}`);
    }
    return out.trim();
  }

  async viewBody(n: number): Promise<string> {
    return this.run(["issue", "view", String(n), "-R", this.repo, "--json", "body", "--jq", ".body"]);
  }

  async viewFull(n: number): Promise<{ title: string; body: string; labels: string[]; state: State }> {
    const json = await this.run(["issue", "view", String(n), "-R", this.repo, "--json", "title,body,labels,state"]);
    const data = JSON.parse(json);
    return {
      title: data.title,
      body: data.body,
      labels: data.labels.map((l: { name: string }) => l.name),
      state: data.state as State,
    };
  }

  async viewState(n: number): Promise<State> {
    const out = await this.run(["issue", "view", String(n), "-R", this.repo, "--json", "state", "--jq", ".state"]);
    return out as State;
  }

  async editBody(n: number, body: string): Promise<void> {
    const tmpFile = `/tmp/run-story-${n}-${Date.now()}.md`;
    await Bun.write(tmpFile, body);
    await this.run(["issue", "edit", String(n), "-R", this.repo, "--body-file", tmpFile]);
  }

  async closeIssue(n: number): Promise<void> {
    await this.run(["issue", "close", String(n), "-R", this.repo, "--reason", "completed"]);
  }

  async relabelHuman(n: number): Promise<void> {
    // Best-effort: remove status:in-progress + owner:bot, add status:ready + owner:human.
    // Each label op may fail individually if label not present — we tolerate that.
    const ops: string[][] = [
      ["issue", "edit", String(n), "-R", this.repo, "--remove-label", "status:in-progress", "--add-label", "status:ready"],
      ["issue", "edit", String(n), "-R", this.repo, "--remove-label", "owner:bot", "--add-label", "owner:human"],
    ];
    for (const args of ops) {
      try { await this.run(args); } catch { /* tolerate */ }
    }
  }
}

class RealSpawn implements SpawnClient {
  spawnWorker(name: string, prompt: string, logPath: string, cwd: string): { pid: number } {
    const fs = require("fs");
    const fd = fs.openSync(logPath, "a");
    try {
      const proc = Bun.spawn(
        [
          "claude",
          "-w",
          name,
          "--dangerously-skip-permissions",
          "-p",
          prompt,
        ],
        {
          stdin: "ignore",
          stdout: fd,
          stderr: fd,
          cwd,
        },
      );
      return { pid: proc.pid };
    } finally {
      fs.closeSync(fd);
    }
  }

  cleanupWorktree(name: string, cwd: string): void {
    const { execSync } = require("child_process");
    // Run both commands; collect first error so a missing worktree does not
    // skip the branch delete (and vice versa). Throw at end if anything failed
    // — caller (cleanupWorker) catches and logs.
    let firstErr: Error | null = null;
    const cmds = [
      ["git", "-C", cwd, "worktree", "remove", `.claude/worktrees/${name}`, "--force"],
      ["git", "-C", cwd, "branch", "-D", `worktree-${name}`],
    ];
    for (const cmd of cmds) {
      try {
        execSync(cmd.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(" "), { stdio: "pipe" });
      } catch (err) {
        if (!firstErr) firstErr = err as Error;
      }
    }
    if (firstErr) throw firstErr;
  }
}

class RealProcessChecker implements ProcessChecker {
  isAlive(pid: number): boolean {
    try {
      // Signal 0 doesn't actually send anything — just checks existence + permission.
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return false; // no such process
      if (code === "EPERM") return true; // exists but not ours; treat as alive
      return false;
    }
  }
}

class RealNotifier implements Notifier {
  private static readonly SP = "/Applications/supaterm.app/Contents/Resources/bin/sp";
  constructor(private parent: number) {}
  notify(message: string): void {
    const title = `Brain OS — Story #${this.parent}`;
    const escapedShell = (s: string) => s.replace(/'/g, "'\\''");
    const banner = [
      `clear`,
      `printf '\\033[1;33m=== %s ===\\033[0m\\n\\n' '${escapedShell(title)}'`,
      `printf '%s\\n\\n' '${escapedShell(message)}'`,
      `afplay /System/Library/Sounds/Glass.aiff &`,
      `read -r -p 'Press Enter to dismiss '`,
    ].join("; ");
    try {
      const sp = Bun.spawnSync({
        cmd: [RealNotifier.SP, "tab", "new", "--focus", "--quiet", "--script", banner],
        stdout: "ignore",
        stderr: "pipe",
      });
      if (sp.exitCode === 0) return;
    } catch {
      // sp binary missing or threw — fall through to osascript
    }
    const osaEscaped = message.replace(/"/g, '\\"');
    Bun.spawn([
      "osascript",
      "-e",
      `display notification "${osaEscaped}" with title "${title}" sound name "Glass"`,
    ]);
  }
}

class FileLogger implements Logger {
  constructor(private path: string) {}
  log(msg: string): void {
    const line = `${new Date().toISOString()} | ${msg}\n`;
    const fs = require("fs");
    fs.appendFileSync(this.path, line);
  }
}

class FileStatusWriter implements StatusWriter {
  constructor(private path: string) {}
  write(status: StoryStatus): void {
    const fs = require("fs");
    fs.writeFileSync(this.path, JSON.stringify(status));
  }
}

// =========================================================================
// Orchestrator
// =========================================================================

export interface OrchestratorDeps {
  gh: GhClient;
  spawn: SpawnClient;
  proc: ProcessChecker;
  notify: Notifier;
  logger: Logger;
  status: StatusWriter;
  pollIntervalMs: number;
  workerLogDir: string;
  areaMap: Record<string, string>;
}

export async function runStory(
  parent: number,
  parallel: number,
  deps: OrchestratorDeps,
): Promise<{ closed: number[]; failed: number[] }> {
  const HARD_CAP = 5;
  const cap = clampParallel(parallel, HARD_CAP);
  const { gh, spawn, proc, notify, logger, status, pollIntervalMs, workerLogDir, areaMap } = deps;
  const failed: number[] = [];
  let hb = 0;

  logger.log(`=== run-story start | parent=#${parent} parallel=${cap} ===`);
  status.write({
    ts: new Date().toISOString(),
    parent,
    phase: "starting",
    pid: process.pid,
    cap,
    watching: [],
    ready: [],
    closed: [],
    failed: [],
    hb,
  });
  notify.notify(`Orchestrator started for #${parent} (PID ${process.pid}, cap ${cap})`);

  const parentBody = await gh.viewBody(parent);
  const childNums = parseChecklist(parentBody);
  if (childNums.length === 0) {
    logger.log(`ERROR: no checklist children found in parent #${parent}`);
    notify.notify(`Story #${parent} — no checklist children found, aborting`);
    return { closed: [], failed: [] };
  }
  logger.log(`children: ${childNums.join(", ")}`);

  // Build issue index
  const issues: Issue[] = [];
  for (const n of childNums) {
    const full = await gh.viewFull(n);
    const blockers = parseBlockers(full.body).filter((b) => b !== parent);
    const owner = parseOwner(full.labels);
    let cwd: string;
    try {
      cwd = inferRepoFromIssueArea(full.labels, areaMap);
    } catch (err) {
      logger.log(`ERROR: cannot resolve cwd for #${n}: ${(err as Error).message}`);
      notify.notify(`Story #${parent} — #${n} has no recognized area:* label, aborting`);
      throw err;
    }
    issues.push({ number: n, deps: blockers, owner, state: full.state, title: full.title, cwd });
    logger.log(`  #${n} owner=${owner} state=${full.state} cwd=${cwd} deps=[${blockers.join(",")}] "${full.title}"`);
  }

  // Initial closed set (children that came in already CLOSED)
  const closed = new Set<number>(issues.filter((i) => i.state === "CLOSED").map((i) => i.number));
  // Pending = open children not yet running
  const pending = new Set<number>(issues.filter((i) => i.state === "OPEN").map((i) => i.number));

  // Initial ready queue
  let ready: number[] = computeReady(issues, closed);
  logger.log(`initial ready: [${ready.join(",")}]`);

  // Watching: child → "afk:PID" or "hitl"
  const watching = new Map<number, string>();

  const afkRunning = (): number => {
    let n = 0;
    for (const v of watching.values()) if (v.startsWith("afk:")) n++;
    return n;
  };

  const issueByNum = new Map<number, Issue>();
  for (const i of issues) issueByNum.set(i.number, i);

  // Drain loop
  while (ready.length > 0 || watching.size > 0) {
    // Top up: HITL anytime, AFK within cap
    const stillReady: number[] = [];
    for (const n of ready) {
      const issue = issueByNum.get(n)!;
      if (issue.owner === "human") {
        notify.notify(`HITL: #${n} needs human. Run: cr /pickup ${n}`);
        logger.log(`HITL surfaced: #${n} — ${issue.title}`);
        watching.set(n, "hitl");
        pending.delete(n);
      } else if (afkRunning() < cap) {
        const workerLog = `${workerLogDir}/${parent}-worker-${n}.log`;
        const { pid } = spawn.spawnWorker(
          `story-${parent}-issue-${n}`,
          `/impl ${n}`,
          workerLog,
          issue.cwd,
        );
        logger.log(`spawned AFK worker for #${n} (pid=${pid}, cwd=${issue.cwd}, log=${workerLog})`);
        watching.set(n, `afk:${pid}`);
        pending.delete(n);
      } else {
        stillReady.push(n);
      }
    }
    ready = stillReady;

    // Heartbeat status BEFORE sleep — captures current state for external pings
    hb++;
    status.write({
      ts: new Date().toISOString(),
      parent,
      phase: "polling",
      pid: process.pid,
      cap,
      watching: [...watching.keys()],
      ready: [...ready],
      closed: [...closed],
      failed: [...failed],
      hb,
    });

    // Sleep then poll
    await Bun.sleep(pollIntervalMs);

    for (const [n] of [...watching.entries()]) {
      let state: State;
      try {
        state = await gh.viewState(n);
      } catch (err) {
        logger.log(`gh viewState(#${n}) errored, retrying next cycle: ${(err as Error).message}`);
        continue;
      }

      const watchKind = watching.get(n)!;
      const isAfk = watchKind.startsWith("afk:");
      const pid = isAfk ? Number(watchKind.slice(4)) : null;
      const pidAlive = pid !== null ? proc.isAlive(pid) : true; // HITL has no PID, treat as "alive" (waiting on human)
      const action = decideWorkerAction(pidAlive, state);

      if (action === "running") {
        continue;
      }

      if (action === "dead") {
        // Worker process gone but issue still OPEN — failure mode
        logger.log(`WORKER DEAD: #${n} (pid=${pid}) exited without closing issue — re-labeling owner:human`);
        try {
          await gh.relabelHuman(n);
        } catch (err) {
          logger.log(`relabelHuman(#${n}) errored: ${(err as Error).message}`);
        }
        notify.notify(`Worker died on #${n}. Re-labeled owner:human. Run: cr /pickup ${n}`);
        watching.delete(n);
        failed.push(n);
        // Do NOT promote waiters — failed child blocks them. Surface to user.
        continue;
      }

      if (action === "closed") {
        logger.log(`child #${n} closed (${watchKind})`);
        watching.delete(n);
        closed.add(n);

        // Cleanup worktree + branch left by closed AFK worker. HITL children
        // never spawned a worktree (notify-only) so skip cleanup for them.
        if (isAfk) {
          const issue = issueByNum.get(n)!;
          await cleanupWorker(spawn, `story-${parent}-issue-${n}`, issue.cwd, logger);
        }

        // Tick parent checklist
        const currBody = await gh.viewBody(parent);
        const newBody = tickChecklist(currBody, n);
        if (newBody !== currBody) {
          await gh.editBody(parent, newBody);
          logger.log(`ticked #${n} in parent #${parent}`);
        }

        // Promote waiters
        const promoted = promoteWaiters(issues, n, closed, pending);
        for (const p of promoted) {
          if (!ready.includes(p)) {
            ready.push(p);
            logger.log(`promoted #${p} (deps cleared)`);
          }
        }
      }
    }
  }

  // Close parent only if no failures
  const parentState = await gh.viewState(parent);
  if (failed.length > 0) {
    logger.log(`drain finished with ${failed.length} failures: [${failed.join(",")}] — leaving parent #${parent} OPEN`);
    notify.notify(`Story #${parent} drained with ${failed.length} failed children. Run: cr /pickup <N> to resolve.`);
  } else {
    if (parentState !== "CLOSED") {
      await gh.closeIssue(parent);
      logger.log(`closed parent #${parent}`);
    }
    notify.notify(`Story #${parent} complete. Run: cr /story-debrief ${parent} for review`);
  }
  logger.log(`=== run-story DONE ===`);
  status.write({
    ts: new Date().toISOString(),
    parent,
    phase: "done",
    pid: process.pid,
    cap,
    watching: [],
    ready: [],
    closed: Array.from(closed),
    failed,
    hb,
  });

  return {
    closed: Array.from(closed),
    failed,
  };
}

// =========================================================================
// Entry point
// =========================================================================

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("usage: bun run scripts/run-story.ts <parent-N> [-p PARALLEL]");
    process.exit(1);
  }

  const parent = Number(args[0]);
  if (Number.isNaN(parent)) {
    console.error(`invalid parent number: ${args[0]}`);
    process.exit(1);
  }

  let parallel = 3;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "-p" && i + 1 < args.length) {
      parallel = Number(args[++i]);
    }
  }

  // Resolve config
  const home = process.env.HOME!;
  const configPath = `${home}/.brain-os/brain-os.config.md`;
  let repo = "sonthanh/ai-brain";
  try {
    const fs = await import("fs");
    const conf = fs.readFileSync(configPath, "utf-8");
    const m = conf.match(/^gh_task_repo:\s*(\S+)/m);
    if (m) repo = m[1];
  } catch {
    // fall through to default
  }

  // Build areaMap: defaults + optional augmentation from ${home}/.brain-os/areas.json.
  // Private deployments register their own area:* labels there without touching
  // this public source file.
  const areaMap = defaultAreaMap(home);
  try {
    const fs = await import("fs");
    const raw = fs.readFileSync(`${home}/.brain-os/areas.json`, "utf-8");
    const parsed = JSON.parse(raw);
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") areaMap[k] = v;
    }
  } catch {
    // optional file
  }

  const logDir = `${home}/.local/state/impl-story`;
  const fs = await import("fs");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = `${logDir}/${parent}.log`;
  const statusPath = `${logDir}/${parent}.status`;

  const logger = new FileLogger(logPath);
  const status = new FileStatusWriter(statusPath);
  const deps: OrchestratorDeps = {
    gh: new RealGh(repo),
    spawn: new RealSpawn(),
    proc: new RealProcessChecker(),
    notify: new RealNotifier(parent),
    logger,
    status,
    pollIntervalMs: 30_000,
    workerLogDir: logDir,
    areaMap,
  };

  try {
    await runStory(parent, parallel, deps);
  } catch (err) {
    const msg = (err as Error).message;
    logger.log(`FATAL: ${msg}`);
    status.write({
      ts: new Date().toISOString(),
      parent,
      phase: "died",
      pid: process.pid,
      cap: clampParallel(parallel, 5),
      watching: [],
      ready: [],
      closed: [],
      failed: [],
      hb: -1,
      error: msg,
    });
    new RealNotifier(parent).notify(`Story #${parent} crashed: ${msg.slice(0, 80)}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
