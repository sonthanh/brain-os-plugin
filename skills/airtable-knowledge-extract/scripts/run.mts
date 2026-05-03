#!/usr/bin/env bun
/**
 * run.mts — C12 Phase-1 per-base orchestrator.
 *
 * One invocation processes ONE base end-to-end:
 *
 *   1. Load (or initialize) `state.json` keyed by run-id.
 *   2. Start the guard daemon (`guard.mts`) on first invocation only;
 *      resume invocations skip the spawn.
 *   3. Set `current_base` and run C9 (`re-anchor.mts`):
 *        - `approve` → continue (re-anchor mutates `confirmed_bases`).
 *        - `no-op`   → continue (base already confirmed).
 *        - `reject`  → exit with `kind=escalated-re-anchor`.
 *   4. Resolve rung-1 seeds via C5, chunk into `args.parallelism`-sized
 *      batches, then for each remaining batch:
 *        - Extract via C6 (one slice per seed, `Promise.all` over the chunk).
 *        - Review via C7. Pass → record + advance.
 *        - Fail → invoke C8 self-improve, then re-extract + re-review at
 *          half parallelism. Pass → record. Still fail → record
 *          `fail-after-retry` and bump `consec_fails`.
 *        - `consec_fails >= maxConsecFails` → SIGTERM workers, write
 *          metrics, exit with `kind=escalated-batch`.
 *   5. All batches passed → write `metrics/base-<id>-rung-1.jsonl`,
 *      mark base `done`, set state.phase = `paused`, exit. Phase 1 has no
 *      Coordinator agent — user reinvokes for the next base.
 *
 * State is the single resume primitive: re-running the same `run-id`
 * picks up at `batches_done`. `getSeedsForBase` MUST be deterministic
 * for resume to produce identical batch slices (Phase 1 relies on
 * `seed-selection.mts`'s cache to provide that determinism).
 *
 * CLI: `bun run run.mts --base <id> [--run-id <id>] [-P 5]`
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  reviewBatch,
  type BatchVerdict,
  type ReviewBatchInput,
  type SliceForReview,
} from "./review-slice.mts";
import {
  selfImprove,
  type RejectBatch,
  type RejectedSlice,
  type SelfImproveResult,
} from "./self-improve.mts";
import type {
  ExtractResultLite,
  SeedForReAnchor,
} from "./re-anchor.mts";
import { extractSlice } from "./extract-slice.mts";
import { appendOutcomeLog } from "./outcome-log.mts";
import {
  HITL_PENDING_EXIT_CODE,
  HitlPendingError,
} from "./hitl.mts";

export const DEFAULT_PARALLELISM = 5;
export const DEFAULT_THRESHOLD = 0.95;
export const DEFAULT_MAX_CONSEC_FAILS = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunPhase =
  | "init"
  | "re-anchor"
  | "rung-1"
  | "paused"
  | "done"
  | "escalated"
  | "hitl-pending";

export interface BatchResult {
  batch_id: string;
  attempt: 1 | 2;
  parallelism: number;
  pass_rate: number;
  threshold: number;
  outcome: "pass" | "fail-after-retry";
  ts: string;
}

export interface BaseProgress {
  base_id: string;
  rung: 0 | 1;
  total_batches: number;
  batches_done: number;
  consec_fails: number;
  phase: RunPhase;
  batch_results: BatchResult[];
  started_ts: string;
  finished_ts?: string | null;
}

export interface RunState {
  run_id: string;
  start_ts: string;
  last_updated_ts: string;
  worker_pids: number[];
  guard_pid?: number | null;
  quota_pct?: number | null;
  current_base?: string | null;
  previous_base?: string | null;
  confirmed_bases?: string[];
  phase: RunPhase;
  base_progress: Record<string, BaseProgress>;
  processing_order: string[];
}

export interface RunArgs {
  runId: string;
  baseId?: string;
  parallelism: number;
  threshold: number;
  maxConsecFails: number;
}

export interface ReAnchorOutcome {
  kind: "approved" | "rejected" | "no-op" | "hitl-pending";
  baseId?: string;
  neededPaths?: string[];
}

export interface RunDeps {
  loadState: () => RunState | null;
  saveState: (s: RunState) => void;
  startGuard: (runId: string) => number;
  runReAnchor: (runId: string) => Promise<ReAnchorOutcome>;
  getSeedsForBase: (baseId: string) => Promise<SeedForReAnchor[]>;
  runExtract: (seed: SeedForReAnchor) => Promise<ExtractResultLite>;
  runReview: (input: ReviewBatchInput) => Promise<BatchVerdict>;
  runSelfImprove: (input: {
    batch: RejectBatch;
    basePath: string;
  }) => Promise<SelfImproveResult>;
  basePathFor: (baseId: string) => string;
  writeMetrics: (baseId: string, rung: number, lines: string[]) => string;
  notify: (title: string, body: string) => void;
  signal: (pid: number) => void;
  now: () => string;
  log: (msg: string) => void;
  uuid: () => string;
}

export interface RunResult {
  kind:
    | "paused"
    | "no-bases"
    | "escalated-re-anchor"
    | "escalated-batch"
    | "hitl-pending";
  baseId?: string;
  state: RunState;
  metricsPath?: string;
  reason?: string;
  neededPaths?: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk: size must be > 0");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export function initState(runId: string, ts: string): RunState {
  return {
    run_id: runId,
    start_ts: ts,
    last_updated_ts: ts,
    worker_pids: [],
    confirmed_bases: [],
    phase: "init",
    base_progress: {},
    processing_order: [],
  };
}

export function nextBaseToProcess(state: RunState): string | null {
  for (const b of state.processing_order) {
    const p = state.base_progress[b];
    if (!p || p.phase !== "done") return b;
  }
  return null;
}

export function rejectsFromVerdict(
  slices: SliceForReview[],
  verdict: BatchVerdict,
): RejectedSlice[] {
  const bySliceId = new Map<string, SliceForReview>();
  for (const s of slices) bySliceId.set(s.slice_id, s);
  const rejects: RejectedSlice[] = [];
  for (const v of verdict.slices) {
    if (v.pass) continue;
    const slice = bySliceId.get(v.slice_id);
    if (!slice) continue;
    rejects.push({
      slice_id: v.slice_id,
      raw: {
        type: slice.cluster_type,
        cluster_id: slice.cluster_id,
        entities: slice.entities,
      },
      reasoning: v.reasoning,
      fail_modes: v.fail_modes,
    });
  }
  return rejects;
}

export function formatBaseSummaryJsonl(progress: BaseProgress): string {
  const passed = progress.batch_results.filter(
    (r) => r.outcome === "pass",
  ).length;
  const total = progress.batch_results.length;
  return JSON.stringify({
    base_id: progress.base_id,
    rung: progress.rung,
    total_batches: progress.total_batches,
    batches_done: progress.batches_done,
    pass_rate: total === 0 ? 0 : passed / total,
    consec_fails: progress.consec_fails,
    phase: progress.phase,
    started_ts: progress.started_ts,
    finished_ts: progress.finished_ts ?? null,
    batches: progress.batch_results,
  });
}

function toSliceForReview(e: ExtractResultLite): SliceForReview {
  return {
    slice_id: e.sliceId,
    base_id: e.baseId,
    cluster_id: e.clusterId,
    cluster_type: e.clusterType,
    subgraph: e.subgraph,
    entities: e.entities,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runOrchestrator(
  args: RunArgs,
  deps: RunDeps,
): Promise<RunResult> {
  const existing = deps.loadState();
  let state: RunState =
    existing ?? initState(args.runId, deps.now());

  const baseId = args.baseId ?? nextBaseToProcess(state);
  if (!baseId) {
    state = { ...state, phase: "done", last_updated_ts: deps.now() };
    deps.saveState(state);
    return { kind: "no-bases", state, reason: "no remaining bases" };
  }

  if (!state.processing_order.includes(baseId)) {
    state = {
      ...state,
      processing_order: [...state.processing_order, baseId],
    };
  }

  if (state.guard_pid == null) {
    const pid = deps.startGuard(args.runId);
    state = { ...state, guard_pid: pid };
  }

  state = {
    ...state,
    current_base: baseId,
    phase: "re-anchor",
    last_updated_ts: deps.now(),
  };
  deps.saveState(state);

  const reAnchorResult = await deps.runReAnchor(args.runId);
  state = deps.loadState() ?? state;
  if (reAnchorResult.kind === "rejected") {
    deps.log(`[run ${args.runId}] re-anchor rejected for ${baseId}`);
    return {
      kind: "escalated-re-anchor",
      baseId,
      state,
      reason: "re-anchor rejected",
    };
  }
  if (reAnchorResult.kind === "hitl-pending") {
    state = {
      ...state,
      phase: "hitl-pending",
      last_updated_ts: deps.now(),
    };
    deps.saveState(state);
    deps.log(
      `[run ${args.runId}] re-anchor HITL pending for ${baseId} — needed: ${(reAnchorResult.neededPaths ?? []).join(", ")}`,
    );
    return {
      kind: "hitl-pending",
      baseId,
      state,
      reason: "re-anchor needs human decision",
      neededPaths: reAnchorResult.neededPaths,
    };
  }

  const seeds = await deps.getSeedsForBase(baseId);
  const allBatches = chunk(seeds, args.parallelism);

  let progress = state.base_progress[baseId];
  if (!progress) {
    progress = {
      base_id: baseId,
      rung: 1,
      total_batches: allBatches.length,
      batches_done: 0,
      consec_fails: 0,
      phase: "rung-1",
      batch_results: [],
      started_ts: deps.now(),
      finished_ts: null,
    };
    state = {
      ...state,
      phase: "rung-1",
      base_progress: { ...state.base_progress, [baseId]: progress },
      last_updated_ts: deps.now(),
    };
    deps.saveState(state);
  } else if (progress.phase === "done") {
    return {
      kind: "paused",
      baseId,
      state,
      reason: `${baseId} already done`,
    };
  } else {
    state = {
      ...state,
      phase: "rung-1",
      last_updated_ts: deps.now(),
    };
    deps.saveState(state);
  }

  for (let i = progress.batches_done; i < allBatches.length; i++) {
    const batch = allBatches[i];
    const batchId = `${baseId}-rung-1-batch-${i}-${args.runId}`;

    const slices = await Promise.all(batch.map((s) => deps.runExtract(s)));
    const sliceReviews = slices.map(toSliceForReview);

    let verdict = await deps.runReview({
      batchId,
      baseId,
      slices: sliceReviews,
    });
    let attempt: 1 | 2 = 1;
    let parallelismUsed = args.parallelism;
    let outcome: "pass" | "fail-after-retry";

    if (verdict.pass_rate >= args.threshold) {
      outcome = "pass";
    } else {
      const rejects = rejectsFromVerdict(sliceReviews, verdict);
      if (rejects.length > 0) {
        try {
          await deps.runSelfImprove({
            batch: { base_id: baseId, rung: 1, rejects },
            basePath: deps.basePathFor(baseId),
          });
        } catch (err) {
          if (err instanceof HitlPendingError) {
            state = {
              ...state,
              phase: "hitl-pending",
              last_updated_ts: deps.now(),
            };
            deps.saveState(state);
            deps.log(
              `[run ${args.runId}] self-improve HITL pending for ${baseId} — needed: ${err.neededPaths.join(", ")}`,
            );
            return {
              kind: "hitl-pending",
              baseId,
              state,
              reason: "self-improve needs human corrections",
              neededPaths: err.neededPaths,
            };
          }
          throw err;
        }
      }
      const halfP = Math.max(1, Math.floor(args.parallelism / 2));
      parallelismUsed = halfP;
      const retrySlices = await Promise.all(
        batch.map((s) => deps.runExtract(s)),
      );
      const retryReviews = retrySlices.map(toSliceForReview);
      verdict = await deps.runReview({
        batchId: `${batchId}-retry`,
        baseId,
        slices: retryReviews,
      });
      attempt = 2;
      outcome = verdict.pass_rate >= args.threshold ? "pass" : "fail-after-retry";
    }

    const batchResult: BatchResult = {
      batch_id: batchId,
      attempt,
      parallelism: parallelismUsed,
      pass_rate: verdict.pass_rate,
      threshold: args.threshold,
      outcome,
      ts: deps.now(),
    };

    progress = {
      ...progress,
      batches_done: i + 1,
      consec_fails:
        outcome === "pass" ? 0 : progress.consec_fails + 1,
      batch_results: [...progress.batch_results, batchResult],
    };
    state = {
      ...state,
      base_progress: { ...state.base_progress, [baseId]: progress },
      last_updated_ts: deps.now(),
    };
    deps.saveState(state);

    if (progress.consec_fails >= args.maxConsecFails) {
      progress = {
        ...progress,
        phase: "escalated",
        finished_ts: deps.now(),
      };
      state = {
        ...state,
        phase: "escalated",
        base_progress: { ...state.base_progress, [baseId]: progress },
        last_updated_ts: deps.now(),
      };
      deps.saveState(state);

      const summary = formatBaseSummaryJsonl(progress);
      const metricsPath = deps.writeMetrics(baseId, 1, [summary]);

      const toSignal = [
        ...state.worker_pids,
        ...(state.guard_pid != null ? [state.guard_pid] : []),
      ];
      for (const pid of toSignal) {
        try {
          deps.signal(pid);
        } catch (err) {
          deps.log(
            `[run ${args.runId}] signal failed for pid ${pid}: ${(err as Error).message ?? err}`,
          );
        }
      }
      deps.notify(
        "airtable-knowledge-extract: rung escalated",
        `base ${baseId} hit ${args.maxConsecFails} consecutive batch failures`,
      );
      return {
        kind: "escalated-batch",
        baseId,
        state,
        metricsPath,
        reason: `${args.maxConsecFails} consec fails`,
      };
    }
  }

  progress = {
    ...progress,
    phase: "done",
    finished_ts: deps.now(),
  };
  state = {
    ...state,
    phase: "paused",
    previous_base: baseId,
    base_progress: { ...state.base_progress, [baseId]: progress },
    last_updated_ts: deps.now(),
  };
  deps.saveState(state);

  const summary = formatBaseSummaryJsonl(progress);
  const metricsPath = deps.writeMetrics(baseId, 1, [summary]);

  deps.notify(
    "airtable-knowledge-extract: base done",
    `base ${baseId} rung-1 ${progress.batches_done}/${progress.total_batches} batches; pause for scale decision`,
  );
  return { kind: "paused", baseId, state, metricsPath };
}

// ---------------------------------------------------------------------------
// Default I/O wiring (CLI)
// ---------------------------------------------------------------------------

interface CacheLayout {
  runDir: string;
  statePath: string;
  basesDir: string;
  metricsDir: string;
  costMeterPath: string;
}

function resolveLayout(runId: string): CacheLayout {
  const runDir = join(homedir(), ".claude", "airtable-extract-cache", runId);
  return {
    runDir,
    statePath: join(runDir, "state.json"),
    basesDir: join(runDir, "bases"),
    metricsDir: join(runDir, "metrics"),
    costMeterPath: join(runDir, "cost-meter.jsonl"),
  };
}

function defaultLoadState(statePath: string): RunState | null {
  if (!existsSync(statePath)) return null;
  return JSON.parse(readFileSync(statePath, "utf8")) as RunState;
}

function defaultSaveState(statePath: string, s: RunState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(s, null, 2)}\n`);
}

function defaultStartGuard(runId: string): number {
  const here = dirname(fileURLToPath(import.meta.url));
  const guardPath = join(here, "guard.mts");
  const child = spawn("bun", ["run", guardPath, runId], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  if (child.pid == null) {
    throw new Error("startGuard: failed to spawn guard.mts");
  }
  return child.pid;
}

function defaultWriteMetrics(
  metricsDir: string,
  baseId: string,
  rung: number,
  lines: string[],
): string {
  mkdirSync(metricsDir, { recursive: true });
  const path = join(metricsDir, `base-${baseId}-rung-${rung}.jsonl`);
  for (const l of lines) appendFileSync(path, `${l}\n`);
  return path;
}

function defaultNotify(title: string, body: string): void {
  try {
    const { execFileSync } = require("node:child_process") as {
      execFileSync: (
        cmd: string,
        args: string[],
        opts?: { stdio?: "ignore" | "inherit" },
      ) => unknown;
    };
    execFileSync(
      "osascript",
      [
        "-e",
        `display notification "${body.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`,
      ],
      { stdio: "ignore" },
    );
  } catch {
    // non-fatal
  }
}

function defaultUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `run-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

// re-anchor.mts owns its own state-file I/O. CLI shells out to it and
// maps the JSON result on stdout back to ReAnchorOutcome. Exit codes:
// 0 = approved or no-op, 1 = rejected, 42 = hitl-pending (issue #232),
// 2 = FATAL (no stdout). On 2 we surface the stderr in the thrown error.
export function parseReAnchorSubprocessOutcome(input: {
  code: number | null;
  stdout: string;
  stderr: string;
}): ReAnchorOutcome {
  const trimmed = input.stdout.trim();
  if (!trimmed) {
    throw new Error(
      `re-anchor exited ${input.code} with empty stdout: ${input.stderr.trim().slice(-400)}`,
    );
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `re-anchor stdout parse failed (exit=${input.code}): ${(err as Error).message}; raw=${trimmed.slice(0, 200)}`,
    );
  }
  const kind = obj.kind as ReAnchorOutcome["kind"];
  return {
    kind,
    baseId: typeof obj.baseId === "string" ? obj.baseId : undefined,
    neededPaths: Array.isArray(obj.neededPaths)
      ? (obj.neededPaths as string[])
      : undefined,
  };
}

async function defaultRunReAnchor(runId: string): Promise<ReAnchorOutcome> {
  return await new Promise<ReAnchorOutcome>((resolve, reject) => {
    const here = dirname(fileURLToPath(import.meta.url));
    const reAnchorPath = join(here, "re-anchor.mts");
    const child = spawn("bun", ["run", reAnchorPath, runId], {
      stdio: ["inherit", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr!.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve(parseReAnchorSubprocessOutcome({ code, stdout, stderr }));
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function defaultRunExtract(
  seed: SeedForReAnchor,
  runId: string,
): Promise<ExtractResultLite> {
  const result = await extractSlice(
    {
      baseId: seed.baseId,
      clusterId: seed.clusterId,
      clusterType: seed.clusterType,
      tableIds: seed.tableIds,
      seedRecordId: seed.recordId,
    },
    { runId },
  );
  return {
    sliceId: `${seed.baseId}-${seed.recordId}`,
    baseId: seed.baseId,
    clusterId: seed.clusterId,
    clusterType: seed.clusterType,
    subgraph: "(persisted via extract-slice manifest)",
    entities: result.entities,
  };
}

async function defaultRunReview(
  input: ReviewBatchInput,
  layout: CacheLayout,
): Promise<BatchVerdict> {
  return reviewBatch(input, {
    basePath: join(layout.basesDir, input.baseId),
    costMeterPath: layout.costMeterPath,
  });
}

async function defaultRunSelfImprove(args: {
  batch: RejectBatch;
  basePath: string;
}): Promise<SelfImproveResult> {
  return selfImprove(args);
}

async function defaultGetSeedsForBase(
  baseId: string,
  runId: string,
  runDir: string,
): Promise<SeedForReAnchor[]> {
  // Phase 1: depend on classify-clusters + seed-selection cache files
  // produced upstream. Aggregate every cluster's cached seeds for this base.
  const clustersPath = join(runDir, `clusters-${baseId}.json`);
  if (!existsSync(clustersPath)) {
    throw new Error(
      `clusters file missing at ${clustersPath} — run classify-clusters.mts before run.mts`,
    );
  }
  const clusters = JSON.parse(readFileSync(clustersPath, "utf8")) as Array<{
    cluster_id: string;
    table_ids: string[];
    type: string;
    dominant_table: string;
  }>;
  const seeds: SeedForReAnchor[] = [];
  for (const c of clusters) {
    const seedFile = join(
      runDir,
      `seed-records-${baseId}-${c.cluster_id}.json`,
    );
    if (!existsSync(seedFile)) continue;
    const list = JSON.parse(readFileSync(seedFile, "utf8")) as Array<{
      id: string;
      tableId: string;
    }>;
    for (const s of list) {
      seeds.push({
        recordId: s.id,
        baseId,
        clusterId: c.cluster_id,
        clusterType: c.type as SeedForReAnchor["clusterType"],
        tableIds: c.table_ids,
      });
    }
  }
  return seeds;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

interface ParsedArgs {
  runId: string;
  baseId?: string;
  parallelism: number;
  threshold: number;
  maxConsecFails: number;
}

export function parseRunArgs(argv: string[]): ParsedArgs {
  let runId: string | undefined;
  let baseId: string | undefined;
  let parallelism = DEFAULT_PARALLELISM;
  let threshold = DEFAULT_THRESHOLD;
  let maxConsecFails = DEFAULT_MAX_CONSEC_FAILS;

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--base") baseId = args[++i];
    else if (a === "--run-id") runId = args[++i];
    else if (a === "--threshold") threshold = Number(args[++i]);
    else if (a === "--max-consec-fails") maxConsecFails = Number(args[++i]);
    else if (a === "-P" || a === "--parallelism")
      parallelism = Number(args[++i]);
  }

  if (!Number.isFinite(parallelism) || parallelism <= 0) {
    throw new Error("--parallelism must be a positive integer");
  }
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("--threshold must be in [0,1]");
  }
  if (!Number.isFinite(maxConsecFails) || maxConsecFails <= 0) {
    throw new Error("--max-consec-fails must be a positive integer");
  }

  return {
    runId: runId ?? defaultUuid(),
    baseId,
    parallelism,
    threshold,
    maxConsecFails,
  };
}

async function main(parsed: ParsedArgs): Promise<number> {
  const layout = resolveLayout(parsed.runId);
  mkdirSync(layout.runDir, { recursive: true });

  const deps: RunDeps = {
    loadState: () => defaultLoadState(layout.statePath),
    saveState: (s) => defaultSaveState(layout.statePath, s),
    startGuard: (runId) => defaultStartGuard(runId),
    runReAnchor: (runId) => defaultRunReAnchor(runId),
    getSeedsForBase: (baseId) =>
      defaultGetSeedsForBase(baseId, parsed.runId, layout.runDir),
    runExtract: (seed) => defaultRunExtract(seed, parsed.runId),
    runReview: (input) => defaultRunReview(input, layout),
    runSelfImprove: defaultRunSelfImprove,
    basePathFor: (baseId) => join(layout.basesDir, baseId),
    writeMetrics: (baseId, rung, lines) =>
      defaultWriteMetrics(layout.metricsDir, baseId, rung, lines),
    notify: defaultNotify,
    signal: (pid) => process.kill(pid, "SIGTERM"),
    now: () => new Date().toISOString(),
    log: (msg) => process.stderr.write(`${msg}\n`),
    uuid: defaultUuid,
  };

  const args: RunArgs = {
    runId: parsed.runId,
    baseId: parsed.baseId,
    parallelism: parsed.parallelism,
    threshold: parsed.threshold,
    maxConsecFails: parsed.maxConsecFails,
  };
  const result = await runOrchestrator(args, deps);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  writeSkillOutcomeLog(result, parsed.runId);

  switch (result.kind) {
    case "paused":
    case "no-bases":
      return 0;
    case "escalated-re-anchor":
    case "escalated-batch":
      return 1;
    case "hitl-pending":
      process.stderr.write(
        `[run ${parsed.runId}] HITL pending — write decision to:\n` +
          `${(result.neededPaths ?? []).map((p) => `  ${p}`).join("\n")}\n` +
          `Then re-run: bun run run.mts --run-id ${parsed.runId} --base ${result.baseId}\n`,
      );
      return HITL_PENDING_EXIT_CODE;
  }
}

function writeSkillOutcomeLog(result: RunResult, runId: string): void {
  const action = "extract";
  const sourceRepo = "~/work/brain-os-plugin";
  const today = new Date().toISOString().slice(0, 10);

  const outResult: "pass" | "partial" | "fail" =
    result.kind === "paused" || result.kind === "no-bases"
      ? "pass"
      : result.kind === "hitl-pending"
        ? "partial"
        : "fail";

  const fields: Record<string, string | number> = { run_id: runId };
  if (result.baseId) fields.base_id = result.baseId;
  if (result.kind === "escalated-batch") fields.escalation = "batch";
  if (result.kind === "escalated-re-anchor") fields.escalation = "re-anchor";
  if (result.kind === "hitl-pending") fields.escalation = "hitl-pending";

  if (result.baseId) {
    const progress = result.state.base_progress[result.baseId];
    if (progress) {
      fields.batches_done = progress.batches_done;
      fields.total_batches = progress.total_batches;
      const passed = progress.batch_results.filter(
        (r) => r.outcome === "pass",
      ).length;
      const total = progress.batch_results.length;
      fields.pass_rate = total === 0 ? "0" : (passed / total).toFixed(2);
    }
  }

  const outputPath =
    result.metricsPath ??
    join(homedir(), ".claude", "airtable-extract-cache", runId);

  const writeResult = appendOutcomeLog({
    date: today,
    skill: "airtable-knowledge-extract",
    action,
    source_repo: sourceRepo,
    output_path: outputPath,
    commit_hash: "none",
    result: outResult,
    fields,
  });

  if (!writeResult.ok) {
    process.stderr.write(
      `outcome-log: skipped (${writeResult.reason})\n`,
    );
  }
}

if (import.meta.main) {
  try {
    const parsed = parseRunArgs(process.argv);
    const code = await main(parsed);
    process.exit(code);
  } catch (err) {
    process.stderr.write(`run: ${(err as Error).message}\n`);
    process.exit(2);
  }
}

// re-export shared types for status.mts + tests
export type {
  ExtractResultLite,
  SeedForReAnchor,
} from "./re-anchor.mts";
