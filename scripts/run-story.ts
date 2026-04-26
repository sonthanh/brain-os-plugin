#!/usr/bin/env bun
/**
 * run-story.ts — Greedy DAG drainer for multi-issue stories.
 *
 * Usage: bun run scripts/run-story.ts <parent-N> [-p PARALLEL]
 *
 * Reads parent issue body checklist + each child's "Blocked by" section to
 * build the DAG. Spawns AFK workers (claude -w + /impl) for owner:bot children
 * up to parallel cap (default 3, hard max 5). Surfaces owner:human children via
 * osascript notify (no spawn). Ticks parent body checklist on each close,
 * closes parent + final macOS-notifies on completion.
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
}

// =========================================================================
// Pure parsers / helpers (covered by run-story.test.ts)
// =========================================================================

const CHECKLIST_RE = /^- \[[ x]\] #(\d+)\b/gm;

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
}

export interface SpawnClient {
  spawnWorker(name: string, prompt: string, logPath: string): { pid: number };
}

export interface Notifier {
  notify(message: string): void;
}

export interface Logger {
  log(msg: string): void;
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
}

class RealSpawn implements SpawnClient {
  spawnWorker(name: string, prompt: string, logPath: string): { pid: number } {
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
        stdout: Bun.file(logPath).writer() as unknown as "pipe",
        stderr: Bun.file(logPath).writer() as unknown as "pipe",
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    return { pid: proc.pid };
  }
}

class RealNotifier implements Notifier {
  constructor(private parent: number) {}
  notify(message: string): void {
    const escaped = message.replace(/"/g, '\\"');
    Bun.spawn([
      "osascript",
      "-e",
      `display notification "${escaped}" with title "Brain OS — Story #${this.parent}" sound name "Glass"`,
    ]);
  }
}

class FileLogger implements Logger {
  constructor(private path: string) {}
  log(msg: string): void {
    const line = `${new Date().toISOString()} | ${msg}\n`;
    // Append synchronously via Node fs to avoid race
    const fs = require("fs");
    fs.appendFileSync(this.path, line);
    // Also tee to stderr for live tail
    process.stderr.write(line);
  }
}

// =========================================================================
// Orchestrator
// =========================================================================

export interface OrchestratorDeps {
  gh: GhClient;
  spawn: SpawnClient;
  notify: Notifier;
  logger: Logger;
  pollIntervalMs: number;
  workerLogDir: string;
}

export async function runStory(
  parent: number,
  parallel: number,
  deps: OrchestratorDeps,
): Promise<{ closed: number[]; failed: number[] }> {
  const HARD_CAP = 5;
  const cap = clampParallel(parallel, HARD_CAP);
  const { gh, spawn, notify, logger, pollIntervalMs, workerLogDir } = deps;

  logger.log(`=== run-story start | parent=#${parent} parallel=${cap} ===`);

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
    issues.push({ number: n, deps: blockers, owner, state: full.state, title: full.title });
    logger.log(`  #${n} owner=${owner} state=${full.state} deps=[${blockers.join(",")}] "${full.title}"`);
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
        const { pid } = spawn.spawnWorker(`story-${parent}-issue-${n}`, `/impl ${n}`, workerLog);
        logger.log(`spawned AFK worker for #${n} (pid=${pid}, log=${workerLog})`);
        watching.set(n, `afk:${pid}`);
        pending.delete(n);
      } else {
        stillReady.push(n);
      }
    }
    ready = stillReady;

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
      if (state === "CLOSED") {
        const watchKind = watching.get(n)!;
        logger.log(`child #${n} closed (${watchKind})`);
        watching.delete(n);
        closed.add(n);

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

  // Close parent
  const parentState = await gh.viewState(parent);
  if (parentState !== "CLOSED") {
    await gh.closeIssue(parent);
    logger.log(`closed parent #${parent}`);
  }

  notify.notify(`Story #${parent} complete. Run: cr /story-debrief ${parent} for review`);
  logger.log(`=== run-story DONE ===`);

  return {
    closed: Array.from(closed),
    failed: [],
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

  const logDir = `${home}/.local/state/impl-story`;
  const fs = await import("fs");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = `${logDir}/${parent}.log`;

  const logger = new FileLogger(logPath);
  const deps: OrchestratorDeps = {
    gh: new RealGh(repo),
    spawn: new RealSpawn(),
    notify: new RealNotifier(parent),
    logger,
    pollIntervalMs: 30_000,
    workerLogDir: logDir,
  };

  try {
    await runStory(parent, parallel, deps);
  } catch (err) {
    logger.log(`FATAL: ${(err as Error).message}`);
    new RealNotifier(parent).notify(`Story #${parent} crashed — see log`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
