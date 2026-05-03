#!/usr/bin/env bun
/**
 * run-parallel.ts — Flat-list parallel orchestrator for /impl -p mode.
 *
 * Usage:
 *   bun run scripts/run-parallel.ts --issues 164,165 [-p PARALLEL]
 *   bun run scripts/run-parallel.ts --count 3 [-p PARALLEL] [--area plugin-brain-os]
 *
 * Spawns claude -w workers per issue with explicit cwd from area:* labels
 * (mirrors run-story.ts cwd-aware fix, ai-brain#161). Replaces the previous
 * Agent-tool spawn path which clones from orchestrator cwd and breaks isolation
 * when main session is in a different repo (ai-brain#173).
 *
 * Tested via bun test scripts/run-parallel.test.ts.
 *
 * Self-detach is the caller's job — invoke with `nohup bun run ... &` (see
 * /impl SKILL prose).
 */

import {
  clampParallel,
  cleanupWorker,
  decideWorkerAction,
  defaultAreaMap,
  inferRepoFromIssueArea,
  RealGh,
  RealSpawn,
  RealProcessChecker,
  RealNotifier,
  FileLogger,
  FileStatusWriter,
  type GhClient,
  type SpawnClient,
  type ProcessChecker,
  type Notifier,
  type Logger,
  type State,
} from "./run-story.ts";

// ---------------------------------------------------------------------------
// Pure helpers (covered by run-parallel.test.ts)
// ---------------------------------------------------------------------------

const HARD_CAP = 5;

export function parseIssueList(
  raw: string,
  hardCap: number = HARD_CAP,
): { issues: number[]; warnings: string[] } {
  if (raw.trim().length === 0) {
    throw new Error("parseIssueList: empty input");
  }
  const tokens = raw.split(",").map((t) => t.trim());
  const issues: number[] = [];
  const warnings: string[] = [];
  const seen = new Set<number>();

  for (const tok of tokens) {
    if (!/^\d+$/.test(tok)) {
      throw new Error(`invalid issue number in list: ${tok}`);
    }
    const n = Number(tok);
    if (n < 1) {
      throw new Error(`invalid issue number in list: ${tok}`);
    }
    if (seen.has(n)) {
      warnings.push(`WARN: dropped duplicate #${n} from list`);
      continue;
    }
    seen.add(n);
    issues.push(n);
  }

  if (issues.length > hardCap) {
    const dropped = issues.slice(hardCap);
    warnings.push(
      `WARN: clamped parallel list to first ${hardCap} (got ${issues.length}): dropped #${dropped.join(", #")}`,
    );
    return { issues: issues.slice(0, hardCap), warnings };
  }
  return { issues, warnings };
}

export function validateSameArea(
  issues: Array<{ number: number; labels: string[] }>,
): string {
  const findArea = (labels: string[]): string | null => {
    for (const l of labels) {
      if (l.startsWith("area:")) return l.slice("area:".length);
    }
    return null;
  };

  const areas: Array<{ number: number; area: string }> = [];
  for (const issue of issues) {
    const area = findArea(issue.labels);
    if (area === null) {
      throw new Error(`no area:* label on #${issue.number}`);
    }
    areas.push({ number: issue.number, area });
  }

  const first = areas[0].area;
  const mismatch = areas.find((a) => a.area !== first);
  if (mismatch) {
    throw new Error(
      `list spans multiple areas (#${areas[0].number} area:${first}, #${mismatch.number} area:${mismatch.area}). Run separate /impl invocations per area.`,
    );
  }
  return first;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParallelStatus {
  ts: string;
  batchId: string;
  phase: "starting" | "polling" | "done" | "died";
  pid: number;
  cap: number;
  watching: number[];
  closed: number[];
  failed: number[];
  hb: number;
  error?: string;
}

export interface ParallelStatusWriter {
  write(status: ParallelStatus): void;
}

export interface ParallelArgs {
  issues?: number[]; // explicit list mode (post-parse, post-dedupe, post-clamp)
  count?: number; // queue-pick mode
  parallel: number; // worker concurrency cap
  area?: string; // queue-pick area filter (without "area:" prefix)
}

export interface ParallelDeps {
  gh: GhClient;
  spawn: SpawnClient;
  proc: ProcessChecker;
  notify: Notifier;
  logger: Logger;
  status: ParallelStatusWriter;
  pollIntervalMs: number;
  workerLogDir: string;
  areaMap: Record<string, string>;
  batchId: string;
}

interface PreparedIssue {
  number: number;
  cwd: string;
  state: State;
  title: string;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runParallel(
  args: ParallelArgs,
  deps: ParallelDeps,
): Promise<{ closed: number[]; failed: number[] }> {
  const cap = clampParallel(args.parallel, HARD_CAP);
  const { gh, spawn, proc, notify, logger, status, pollIntervalMs, workerLogDir, areaMap, batchId } =
    deps;
  const failed: number[] = [];
  let hb = 0;

  logger.log(`=== run-parallel start | batch=${batchId} parallel=${cap} ===`);

  // --- Resolve issue list ---
  let issueNumbers: number[];
  if (args.issues && args.issues.length > 0) {
    issueNumbers = args.issues;
    logger.log(`mode=explicit list=[${issueNumbers.join(",")}]`);
  } else if (typeof args.count === "number" && args.count > 0) {
    if (!args.area) {
      throw new Error("count mode requires args.area");
    }
    const labels = [`area:${args.area}`, "status:ready", "owner:bot"];
    const fetched = await gh.listIssues(labels, args.count);
    issueNumbers = fetched.map((r) => r.number);
    logger.log(`mode=count area=${args.area} count=${args.count} fetched=[${issueNumbers.join(",")}]`);
    if (issueNumbers.length === 0) {
      logger.log("queue empty — nothing to do");
      status.write({
        ts: new Date().toISOString(),
        batchId,
        phase: "done",
        pid: process.pid,
        cap,
        watching: [],
        closed: [],
        failed: [],
        hb,
      });
      return { closed: [], failed: [] };
    }
  } else {
    throw new Error("ParallelArgs requires either issues[] or count + area");
  }

  // --- Fetch full state for each + same-area assertion ---
  const fullViews = await Promise.all(issueNumbers.map((n) => gh.viewFull(n)));
  const labelView = issueNumbers.map((n, i) => ({ number: n, labels: fullViews[i].labels }));
  validateSameArea(labelView); // throws on mismatch — caller's catch surfaces to user

  status.write({
    ts: new Date().toISOString(),
    batchId,
    phase: "starting",
    pid: process.pid,
    cap,
    watching: [],
    closed: [],
    failed: [],
    hb,
  });
  notify.notifyInfo(`Parallel batch ${batchId} started (PID ${process.pid}, cap ${cap}, ${issueNumbers.length} issues)`);

  // --- Prepare issues: detect already-CLOSED, claim OPEN, infer cwd ---
  const closed = new Set<number>();
  const prepared: PreparedIssue[] = [];

  for (let i = 0; i < issueNumbers.length; i++) {
    const n = issueNumbers[i];
    const full = fullViews[i];
    if (full.state === "CLOSED") {
      logger.log(`#${n} already CLOSED — skipping claim/spawn`);
      closed.add(n);
      continue;
    }
    let cwd: string;
    try {
      cwd = inferRepoFromIssueArea(full.labels, areaMap);
    } catch (err) {
      logger.log(`ERROR: cannot resolve cwd for #${n}: ${(err as Error).message}`);
      throw err;
    }
    try {
      await gh.claim(n);
      logger.log(`claimed #${n} (status:ready → status:in-progress)`);
    } catch (err) {
      logger.log(`claim(#${n}) errored: ${(err as Error).message} — relabeling human + skipping`);
      try {
        await gh.relabelHuman(n);
      } catch {
        /* tolerate */
      }
      failed.push(n);
      continue;
    }
    prepared.push({ number: n, cwd, state: full.state, title: full.title });
  }

  // --- Drain loop ---
  let ready: PreparedIssue[] = [...prepared];
  const watching = new Map<number, { pid: number; cwd: string; name: string }>();

  while (ready.length > 0 || watching.size > 0) {
    // Top up workers up to cap
    const stillReady: PreparedIssue[] = [];
    for (const issue of ready) {
      if (watching.size < cap) {
        const name = `parallel-${batchId}-issue-${issue.number}`;
        const workerLog = `${workerLogDir}/${batchId}-worker-${issue.number}.log`;
        const { pid } = spawn.spawnWorker(name, `/impl ${issue.number}`, workerLog, issue.cwd);
        logger.log(
          `spawned worker for #${issue.number} (pid=${pid}, cwd=${issue.cwd}, log=${workerLog})`,
        );
        watching.set(issue.number, { pid, cwd: issue.cwd, name });
      } else {
        stillReady.push(issue);
      }
    }
    ready = stillReady;

    // Heartbeat status BEFORE sleep
    hb++;
    status.write({
      ts: new Date().toISOString(),
      batchId,
      phase: "polling",
      pid: process.pid,
      cap,
      watching: [...watching.keys()],
      closed: [...closed],
      failed: [...failed],
      hb,
    });

    await Bun.sleep(pollIntervalMs);

    // Poll each watched
    for (const [n, w] of [...watching.entries()]) {
      let state: State;
      try {
        state = await gh.viewState(n);
      } catch (err) {
        logger.log(`gh viewState(#${n}) errored, retrying next cycle: ${(err as Error).message}`);
        continue;
      }

      const pidAlive = proc.isAlive(w.pid);
      const action = decideWorkerAction(pidAlive, state);

      if (action === "running") continue;

      if (action === "dead") {
        logger.log(
          `WORKER DEAD: #${n} (pid=${w.pid}) exited without closing issue — re-labeling owner:human`,
        );
        try {
          await gh.relabelHuman(n);
        } catch (err) {
          logger.log(`relabelHuman(#${n}) errored: ${(err as Error).message}`);
        }
        notify.notify(`Worker died on #${n}. Re-labeled owner:human. Run: cr /pickup ${n}`);
        watching.delete(n);
        failed.push(n);
        continue;
      }

      if (action === "closed") {
        logger.log(`#${n} closed (worker pid=${w.pid})`);
        watching.delete(n);
        closed.add(n);
        await cleanupWorker(spawn, w.name, w.cwd, logger);
      }
    }
  }

  // --- Finalize ---
  if (failed.length > 0) {
    notify.notify(
      `Parallel batch ${batchId} finished with ${failed.length} failed: [${failed.join(",")}]. Run: cr /pickup <N> to resolve.`,
    );
  } else {
    notify.notify(
      `Parallel batch ${batchId} complete — ${closed.size} closed.`,
    );
  }
  logger.log(`=== run-parallel DONE | closed=[${[...closed].join(",")}] failed=[${failed.join(",")}] ===`);
  status.write({
    ts: new Date().toISOString(),
    batchId,
    phase: "done",
    pid: process.pid,
    cap,
    watching: [],
    closed: [...closed],
    failed: [...failed],
    hb,
  });

  return { closed: [...closed], failed: [...failed] };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error(
      "usage: bun run scripts/run-parallel.ts (--issues N,M,... | --count N --area <label>) [-p PARALLEL]",
    );
    process.exit(1);
  }

  let issuesArg: string | undefined;
  let countArg: number | undefined;
  let areaArg: string | undefined;
  let parallel = 3;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--issues" && i + 1 < args.length) {
      issuesArg = args[++i];
    } else if (args[i] === "--count" && i + 1 < args.length) {
      countArg = Number(args[++i]);
    } else if (args[i] === "--area" && i + 1 < args.length) {
      areaArg = args[++i];
    } else if (args[i] === "-p" && i + 1 < args.length) {
      parallel = Number(args[++i]);
    }
  }

  if (!issuesArg && countArg === undefined) {
    console.error("--issues OR --count required");
    process.exit(1);
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
    /* default */
  }

  const areaMap = defaultAreaMap(home);
  try {
    const fs = await import("fs");
    const raw = fs.readFileSync(`${home}/.brain-os/areas.json`, "utf-8");
    const parsed = JSON.parse(raw);
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") areaMap[k] = v;
    }
  } catch {
    /* optional */
  }

  // Parse issues if given
  let parallelArgs: ParallelArgs;
  let batchId: string;
  if (issuesArg) {
    const { issues, warnings } = parseIssueList(issuesArg);
    for (const w of warnings) console.error(w);
    parallelArgs = { issues, parallel };
    batchId = `list-${issues.join("-")}`;
  } else {
    parallelArgs = { count: countArg!, parallel, area: areaArg ?? "plugin-brain-os" };
    batchId = `count-${countArg}-${areaArg ?? "plugin-brain-os"}-${Date.now()}`;
  }

  const logDir = `${home}/.local/state/impl-parallel`;
  const fs = await import("fs");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = `${logDir}/${batchId}.log`;
  const statusPath = `${logDir}/${batchId}.status`;

  const logger = new FileLogger(logPath);
  const status = new FileStatusWriter(statusPath);
  const deps: ParallelDeps = {
    gh: new RealGh(repo),
    spawn: new RealSpawn(),
    proc: new RealProcessChecker(),
    notify: new RealNotifier(`Brain OS — Parallel ${batchId}`),
    logger,
    status,
    pollIntervalMs: 30_000,
    workerLogDir: logDir,
    areaMap,
    batchId,
  };

  try {
    await runParallel(parallelArgs, deps);
  } catch (err) {
    const msg = (err as Error).message;
    logger.log(`FATAL: ${msg}`);
    status.write({
      ts: new Date().toISOString(),
      batchId,
      phase: "died",
      pid: process.pid,
      cap: clampParallel(parallel, HARD_CAP),
      watching: [],
      closed: [],
      failed: [],
      hb: -1,
      error: msg,
    });
    new RealNotifier(`Brain OS — Parallel ${batchId}`).notify(
      `Parallel batch ${batchId} crashed: ${msg.slice(0, 80)}`,
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
