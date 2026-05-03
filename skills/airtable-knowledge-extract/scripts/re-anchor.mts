#!/usr/bin/env bun
/**
 * re-anchor.mts — C9 Phase-1 per-base re-anchor logic.
 *
 * Mandatory rung-0' shallow vertical-slice extract + HITL re-teach on every
 * new base entry. Prevents prior-base examples bank from biasing extraction
 * on a different domain (Airtable schema + slang differ per company base).
 *
 * Trigger contract: `run.mts` (orchestrator, #191) writes `state.json` with
 * `current_base` set to the next base it intends to process. On every cycle
 * boundary it spawns this script as a subprocess. The script:
 *
 *   1. Loads `<run-id>/state.json` and runs `detectBaseTransition`.
 *      - `current_base` unset                          → no-op exit 0.
 *      - `current_base` already in `confirmed_bases`   → no-op exit 0.
 *      - else                                          → re-anchor cycle.
 *   2. `getSeeds(baseId)` resolves N seeds (default 10, top connectivity).
 *   3. `runExtract(seed)` executes one slice per seed sequentially (-P 1).
 *      Returns `{sliceId, baseId, clusterId, clusterType, subgraph, entities}`.
 *   4. Bundles slices into a Reviewer batch and calls `runReview` (Opus 4.6,
 *      threshold default 0.95). Inherits `review-slice`'s contract — the
 *      Reviewer's own `pass` is advisory; the Reviewer's `pass_rate` is what
 *      the user judges in step 5.
 *   5. `prompt(ctx)` opens HITL channel (sp tab notify + stdin Press-Enter).
 *      Default = approve on bare Enter; type "reject <note>" to reject.
 *   6a. Approve → write per-base `examples.jsonl` (one positive example per
 *       passing slice, `raw == corrected`, `reason: "rung-0-anchor"`); update
 *       state.json to append baseId to `confirmed_bases` and advance
 *       `previous_base`.
 *   6b. Reject → write per-base `escalation.md` with verdict + user note;
 *       SIGTERM every `worker_pid`; update state.json with `phase:
 *       "escalated"`. Exit code 1.
 *
 * Cross-base isolation is enforced at write time: examples.jsonl is written
 * to `<basesDir>/<baseId>/examples.jsonl` only for the currently approved
 * base. Reviewer (#188) reads the same file via `loadBaseContext`.
 *
 * CLI: `bun run re-anchor.mts <run-id>`
 *   Reads `~/.claude/airtable-extract-cache/<run-id>/state.json`.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ClusterType,
  ExtractedEntity,
} from "./extract-slice.mts";
import {
  reviewBatch,
  type BatchVerdict,
  type ReviewBatchInput,
  type SliceForReview,
  type SliceVerdict,
} from "./review-slice.mts";
import {
  rankSeedRecords,
  seedSelection,
  type SeedRecord,
} from "./seed-selection.mts";
import { extractSlice } from "./extract-slice.mts";
import {
  HITL_PENDING_EXIT_CODE,
  HitlPendingError,
  makeWakeToken,
} from "./hitl.mts";

export const DEFAULT_SEED_COUNT = 10;
export const DEFAULT_THRESHOLD = 0.95;
export const RUNG_0_REASON = "rung-0-anchor";
export const DECISION_NEEDED_FILENAME = "re-anchor-decision-needed.json";
export const DECISION_FILENAME = "re-anchor-decision.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReAnchorState {
  start_ts: string;
  worker_pids: number[];
  quota_pct?: number | null;
  current_base?: string | null;
  previous_base?: string | null;
  confirmed_bases?: string[];
  phase?: string | null;
}

export interface SeedForReAnchor {
  recordId: string;
  baseId: string;
  clusterId: string;
  clusterType: ClusterType;
  tableIds: string[];
}

export interface ExtractResultLite {
  sliceId: string;
  baseId: string;
  clusterId: string;
  clusterType: ClusterType;
  subgraph: string;
  entities: ExtractedEntity[];
}

export interface HitlContext {
  baseId: string;
  runId: string;
  slices: ExtractResultLite[];
  verdict: BatchVerdict;
}

export interface HitlDecision {
  decision: "approve" | "reject";
  note?: string;
}

export interface ReAnchorDeps {
  loadState: () => ReAnchorState;
  saveState: (s: ReAnchorState) => void;
  getSeeds: (baseId: string) => Promise<SeedForReAnchor[]>;
  runExtract: (seed: SeedForReAnchor) => Promise<ExtractResultLite>;
  runReview: (input: ReviewBatchInput) => Promise<BatchVerdict>;
  prompt: (ctx: HitlContext) => Promise<HitlDecision>;
  notify: (title: string, body: string) => void;
  signal: (pid: number) => void;
  writeExamples: (baseId: string, lines: string[]) => string;
  writeEscalation: (baseId: string, content: string) => string;
  now: () => string;
  log: (msg: string) => void;
}

export interface ReAnchorResult {
  kind: "approved" | "rejected" | "no-op" | "hitl-pending";
  baseId?: string;
  examplesPath?: string;
  escalationPath?: string;
  verdict?: BatchVerdict;
  neededPaths?: string[];
}

export interface ReAnchorDecisionNeededPayload {
  phase: "re-anchor";
  run_id: string;
  base_id: string;
  context: {
    slices: Array<{
      slice_id: string;
      cluster_id: string;
      cluster_type: ClusterType;
      entity_count: number;
    }>;
    verdict: {
      pass_rate: number;
      threshold: number;
      slices: SliceVerdict[];
    };
    sample_entities: ExtractedEntity[];
  };
  decision_path: string;
  wake_token: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function detectBaseTransition(state: ReAnchorState): {
  needsReAnchor: boolean;
  baseId: string | null;
  reason: string;
} {
  const cur = state.current_base ?? null;
  if (!cur) {
    return { needsReAnchor: false, baseId: null, reason: "current_base unset" };
  }
  const confirmed = new Set(state.confirmed_bases ?? []);
  if (confirmed.has(cur)) {
    return {
      needsReAnchor: false,
      baseId: cur,
      reason: `${cur} already confirmed`,
    };
  }
  return {
    needsReAnchor: true,
    baseId: cur,
    reason: state.previous_base
      ? `transition ${state.previous_base} → ${cur}`
      : `first base ${cur}`,
  };
}

export function mergeStateApprove(
  state: ReAnchorState,
  baseId: string,
): ReAnchorState {
  const confirmed = state.confirmed_bases ?? [];
  const next = confirmed.includes(baseId)
    ? confirmed.slice()
    : [...confirmed, baseId];
  return {
    ...state,
    confirmed_bases: next,
    previous_base: baseId,
    phase: state.phase ?? null,
  };
}

export function mergeStateReject(state: ReAnchorState): ReAnchorState {
  return {
    ...state,
    phase: "escalated",
  };
}

export function formatExampleEntry(
  slice: SliceForReview,
  verdict: SliceVerdict,
  ts: string,
): string {
  const payload = {
    type: slice.cluster_type,
    cluster_id: slice.cluster_id,
    entities: slice.entities,
  };
  return JSON.stringify({
    base_id: slice.base_id,
    slice_id: slice.slice_id,
    reason: RUNG_0_REASON,
    verdict_score: verdict.score,
    extracted_at: ts,
    raw: payload,
    corrected: payload,
  });
}

export function formatEscalationMd(ctx: {
  runId: string;
  baseId: string;
  ts: string;
  verdict: BatchVerdict | null;
  userNote?: string;
  workerPids: number[];
  failureReason?: string;
}): string {
  const lines: string[] = [];
  lines.push(`# Escalation — ${ctx.baseId}`);
  lines.push("");
  lines.push(`- run-id: \`${ctx.runId}\``);
  lines.push(`- detected: ${ctx.ts}`);
  lines.push(`- base: \`${ctx.baseId}\``);
  if (ctx.failureReason) {
    lines.push(`- reason: ${ctx.failureReason}`);
  }
  if (ctx.verdict) {
    lines.push(`- pass_rate: \`${ctx.verdict.pass_rate.toFixed(3)}\``);
    lines.push(`- threshold: \`${ctx.verdict.threshold}\``);
    lines.push(`- reviewer-pass: \`${ctx.verdict.pass}\``);
  }
  lines.push(
    `- worker_pids: \`${ctx.workerPids.length ? ctx.workerPids.join(", ") : "(none)"}\``,
  );
  lines.push("");
  lines.push("## User note");
  lines.push("");
  lines.push(ctx.userNote && ctx.userNote.length > 0 ? ctx.userNote : "(none)");
  lines.push("");
  if (ctx.verdict && ctx.verdict.slices.length > 0) {
    lines.push("## Slice verdicts");
    lines.push("");
    for (const s of ctx.verdict.slices) {
      const fm = s.fail_modes.length > 0 ? ` [${s.fail_modes.join(", ")}]` : "";
      lines.push(
        `- \`${s.slice_id}\` — score=${s.score.toFixed(2)} pass=${s.pass}${fm}`,
      );
      if (s.reasoning) lines.push(`  - ${s.reasoning}`);
    }
    lines.push("");
  }
  lines.push("## Action taken");
  lines.push("");
  lines.push(
    "Run aborted. All registered worker PIDs were SIGTERMed. state.json `phase` set to `escalated`.",
  );
  lines.push("");
  return lines.join("\n");
}

export function buildReAnchorDecisionNeeded(args: {
  ctx: HitlContext;
  decisionPath: string;
  wakeToken: string;
  sampleEntityCap?: number;
}): ReAnchorDecisionNeededPayload {
  const cap = args.sampleEntityCap ?? 5;
  const sample: ExtractedEntity[] = [];
  for (const s of args.ctx.slices) {
    for (const e of s.entities) {
      if (sample.length >= cap) break;
      sample.push(e);
    }
    if (sample.length >= cap) break;
  }
  return {
    phase: "re-anchor",
    run_id: args.ctx.runId,
    base_id: args.ctx.baseId,
    context: {
      slices: args.ctx.slices.map((s) => ({
        slice_id: s.sliceId,
        cluster_id: s.clusterId,
        cluster_type: s.clusterType,
        entity_count: s.entities.length,
      })),
      verdict: {
        pass_rate: args.ctx.verdict.pass_rate,
        threshold: args.ctx.verdict.threshold,
        slices: args.ctx.verdict.slices,
      },
      sample_entities: sample,
    },
    decision_path: args.decisionPath,
    wake_token: args.wakeToken,
  };
}

export function parseReAnchorDecisionFile(raw: string): HitlDecision {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `re-anchor decision file: JSON parse failed — ${(err as Error).message}`,
    );
  }
  if (!obj || typeof obj !== "object") {
    throw new Error("re-anchor decision file: must be a JSON object");
  }
  const o = obj as Record<string, unknown>;
  if (o.verdict !== "approve" && o.verdict !== "reject") {
    throw new Error(
      `re-anchor decision file: verdict must be 'approve' or 'reject' (got ${JSON.stringify(o.verdict)})`,
    );
  }
  const note =
    typeof o.notes === "string" && o.notes.length > 0 ? o.notes : undefined;
  return { decision: o.verdict, note };
}

export function defaultExportAndExitPrompt(opts: {
  decisionDir: string;
  uuid?: () => string;
}): (ctx: HitlContext) => Promise<HitlDecision> {
  const uuid = opts.uuid ?? makeWakeToken;
  return async (ctx: HitlContext): Promise<HitlDecision> => {
    const decisionPath = join(opts.decisionDir, DECISION_FILENAME);
    if (existsSync(decisionPath)) {
      const raw = readFileSync(decisionPath, "utf8");
      const decision = parseReAnchorDecisionFile(raw);
      unlinkSync(decisionPath);
      return decision;
    }
    mkdirSync(opts.decisionDir, { recursive: true });
    const neededPath = join(opts.decisionDir, DECISION_NEEDED_FILENAME);
    const payload = buildReAnchorDecisionNeeded({
      ctx,
      decisionPath,
      wakeToken: uuid(),
    });
    writeFileSync(neededPath, `${JSON.stringify(payload, null, 2)}\n`);
    throw new HitlPendingError([neededPath]);
  };
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
// Main entry
// ---------------------------------------------------------------------------

export async function runReAnchor(
  runId: string,
  deps: ReAnchorDeps,
): Promise<ReAnchorResult> {
  const initialState = deps.loadState();
  const transition = detectBaseTransition(initialState);
  if (!transition.needsReAnchor || !transition.baseId) {
    deps.log(`[re-anchor ${runId}] no-op: ${transition.reason}`);
    return { kind: "no-op" };
  }

  const baseId = transition.baseId;
  deps.log(`[re-anchor ${runId}] ${transition.reason}`);

  const seeds = await deps.getSeeds(baseId);
  if (seeds.length === 0) {
    return rejectWith({
      runId,
      baseId,
      verdict: null,
      userNote: "",
      failureReason: "getSeeds returned no seeds — orchestrator must precompute clusters + seeds before re-anchor",
      state: initialState,
      deps,
    });
  }

  const slices: ExtractResultLite[] = [];
  for (const seed of seeds) {
    const sliceLite = await deps.runExtract(seed);
    slices.push(sliceLite);
  }

  const review: ReviewBatchInput = {
    batchId: `rung-0-${baseId}-${runId}`,
    baseId,
    slices: slices.map(toSliceForReview),
  };
  const verdict = await deps.runReview(review);

  let decision: HitlDecision;
  try {
    decision = await deps.prompt({ baseId, runId, slices, verdict });
  } catch (err) {
    if (err instanceof HitlPendingError) {
      deps.log(
        `[re-anchor ${runId}] HITL pending — needed: ${err.neededPaths.join(", ")}`,
      );
      return {
        kind: "hitl-pending",
        baseId,
        verdict,
        neededPaths: err.neededPaths,
      };
    }
    throw err;
  }

  if (decision.decision === "approve") {
    const ts = deps.now();
    const passingByBase = new Map<string, SliceVerdict>();
    for (const v of verdict.slices) {
      if (v.pass) passingByBase.set(v.slice_id, v);
    }
    const lines: string[] = [];
    for (const slice of review.slices) {
      const v = passingByBase.get(slice.slice_id);
      if (!v) continue;
      lines.push(formatExampleEntry(slice, v, ts));
    }

    const examplesPath = deps.writeExamples(baseId, lines);
    const nextState = mergeStateApprove(deps.loadState(), baseId);
    deps.saveState(nextState);
    deps.notify(
      "airtable-knowledge-extract: re-anchor approved",
      `base=${baseId} pass_rate=${verdict.pass_rate.toFixed(2)} examples=${lines.length}`,
    );
    deps.log(`[re-anchor ${runId}] approved ${baseId} → ${examplesPath}`);
    return {
      kind: "approved",
      baseId,
      examplesPath,
      verdict,
    };
  }

  return rejectWith({
    runId,
    baseId,
    verdict,
    userNote: decision.note ?? "",
    state: initialState,
    deps,
  });
}

function rejectWith(args: {
  runId: string;
  baseId: string;
  verdict: BatchVerdict | null;
  userNote: string;
  failureReason?: string;
  state: ReAnchorState;
  deps: ReAnchorDeps;
}): ReAnchorResult {
  const { runId, baseId, verdict, userNote, failureReason, deps } = args;
  const ts = deps.now();
  const state = deps.loadState();
  const md = formatEscalationMd({
    runId,
    baseId,
    ts,
    verdict,
    userNote,
    workerPids: state.worker_pids,
    failureReason,
  });
  const escalationPath = deps.writeEscalation(baseId, md);

  for (const pid of state.worker_pids) {
    try {
      deps.signal(pid);
    } catch (err) {
      deps.log(
        `[re-anchor ${runId}] signal failed for pid ${pid}: ${(err as Error).message ?? err}`,
      );
    }
  }

  deps.saveState(mergeStateReject(state));
  deps.notify(
    "airtable-knowledge-extract: re-anchor REJECTED",
    `base=${baseId}: ${failureReason ?? userNote ?? "user rejected"}`,
  );
  deps.log(`[re-anchor ${runId}] rejected ${baseId} → ${escalationPath}`);
  return {
    kind: "rejected",
    baseId,
    escalationPath,
    verdict: verdict ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Default I/O wiring (CLI)
// ---------------------------------------------------------------------------

interface CacheLayout {
  runDir: string;
  statePath: string;
  basesDir: string;
  hitlDir: string;
}

function resolveLayout(runId: string): CacheLayout {
  const runDir = join(homedir(), ".claude", "airtable-extract-cache", runId);
  return {
    runDir,
    statePath: join(runDir, "state.json"),
    basesDir: join(runDir, "bases"),
    hitlDir: join(runDir, "hitl"),
  };
}

function defaultLoadState(statePath: string): ReAnchorState {
  if (!existsSync(statePath)) {
    throw new Error(
      `state.json not found at ${statePath} — orchestrator must create it before re-anchor`,
    );
  }
  return JSON.parse(readFileSync(statePath, "utf8")) as ReAnchorState;
}

function defaultSaveState(statePath: string, s: ReAnchorState): void {
  mkdirSync(join(statePath, ".."), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(s, null, 2)}\n`);
}

interface ClusterFileEntry {
  cluster_id: string;
  table_ids: string[];
  type: ClusterType;
  dominant_table: string;
}

async function defaultGetSeeds(
  baseId: string,
  runId: string,
  runDir: string,
  n: number,
): Promise<SeedForReAnchor[]> {
  const clustersPath = join(runDir, `clusters-${baseId}.json`);
  if (!existsSync(clustersPath)) {
    throw new Error(
      `clusters file missing at ${clustersPath} — run classify-clusters.mts before re-anchor`,
    );
  }
  const clusters = JSON.parse(
    readFileSync(clustersPath, "utf8"),
  ) as ClusterFileEntry[];

  const collected: Array<SeedRecord & { clusterId: string; clusterType: ClusterType; tableIds: string[] }> = [];
  for (const c of clusters) {
    const seedFile = join(runDir, `seed-records-${baseId}-${c.cluster_id}.json`);
    let seeds: SeedRecord[] = [];
    if (existsSync(seedFile)) {
      seeds = JSON.parse(readFileSync(seedFile, "utf8")) as SeedRecord[];
    } else {
      const result = await seedSelection(baseId, c.cluster_id, { runId, n });
      seeds = result.seeds;
    }
    for (const s of seeds) {
      collected.push({
        ...s,
        clusterId: c.cluster_id,
        clusterType: c.type,
        tableIds: c.table_ids,
      });
    }
  }

  const ranked = rankSeedRecords(collected, n) as Array<
    SeedRecord & { clusterId: string; clusterType: ClusterType; tableIds: string[] }
  >;
  return ranked.map((r) => ({
    recordId: r.id,
    baseId,
    clusterId: r.clusterId,
    clusterType: r.clusterType,
    tableIds: r.tableIds,
  }));
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

async function strictStdinPrompt(ctx: HitlContext): Promise<HitlDecision> {
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync(
      "osascript",
      [
        "-e",
        `display notification "Re-anchor HITL: base=${ctx.baseId} pass_rate=${ctx.verdict.pass_rate.toFixed(2)} — review terminal" with title "airtable-knowledge-extract"`,
      ],
      { stdio: "ignore" },
    );
  } catch {
    // notification non-fatal
  }
  process.stderr.write(
    `\n\n=== re-anchor HITL: base ${ctx.baseId} ===\n` +
      `pass_rate: ${ctx.verdict.pass_rate.toFixed(3)} (threshold ${ctx.verdict.threshold})\n` +
      `slices: ${ctx.slices.length} (${ctx.verdict.slices.filter((v) => v.pass).length} pass)\n` +
      `Press <Enter> to APPROVE; type "reject <reason>" + <Enter> to REJECT.\n> `,
  );

  const line = await readStdinLine();
  const trimmed = line.trim();
  if (trimmed.length === 0) return { decision: "approve" };
  if (/^reject\b/i.test(trimmed)) {
    const note = trimmed.replace(/^reject\s*/i, "").trim();
    return { decision: "reject", note };
  }
  if (/^approve\b/i.test(trimmed)) return { decision: "approve" };
  return { decision: "reject", note: `unrecognized response: ${trimmed}` };
}

function readStdinLine(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer | string) => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx >= 0) {
        process.stdin.off("data", onData);
        process.stdin.pause();
        resolve(buf.slice(0, idx));
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

function defaultWriteExamples(
  basesDir: string,
  baseId: string,
  lines: string[],
): string {
  const dir = join(basesDir, baseId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "examples.jsonl");
  for (const l of lines) {
    appendFileSync(path, `${l}\n`);
  }
  return path;
}

function defaultWriteEscalation(
  basesDir: string,
  baseId: string,
  content: string,
): string {
  const dir = join(basesDir, baseId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "escalation.md");
  writeFileSync(path, content);
  return path;
}

function defaultNotify(title: string, body: string): void {
  try {
    const { execFileSync } = require("node:child_process");
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

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main(
  runId: string,
  opts: { strictStdinHitl: boolean },
): Promise<number> {
  const layout = resolveLayout(runId);

  const prompt = opts.strictStdinHitl
    ? strictStdinPrompt
    : defaultExportAndExitPrompt({ decisionDir: layout.hitlDir });

  const deps: ReAnchorDeps = {
    loadState: () => defaultLoadState(layout.statePath),
    saveState: (s) => defaultSaveState(layout.statePath, s),
    getSeeds: (baseId) =>
      defaultGetSeeds(baseId, runId, layout.runDir, DEFAULT_SEED_COUNT),
    runExtract: (seed) => defaultRunExtract(seed, runId),
    runReview: (input) =>
      reviewBatch(input, {
        basePath: join(layout.basesDir, input.baseId),
        costMeterPath: join(layout.runDir, "cost-meter.jsonl"),
        threshold: DEFAULT_THRESHOLD,
      }),
    prompt,
    notify: defaultNotify,
    signal: (pid) => process.kill(pid, "SIGTERM"),
    writeExamples: (baseId, lines) =>
      defaultWriteExamples(layout.basesDir, baseId, lines),
    writeEscalation: (baseId, content) =>
      defaultWriteEscalation(layout.basesDir, baseId, content),
    now: () => new Date().toISOString(),
    log: (msg) => process.stderr.write(`${msg}\n`),
  };

  const result = await runReAnchor(runId, deps);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  switch (result.kind) {
    case "approved":
    case "no-op":
      return 0;
    case "rejected":
      return 1;
    case "hitl-pending":
      process.stderr.write(
        `[re-anchor ${runId}] HITL needed — write decision to:\n  ${layout.hitlDir}/${DECISION_FILENAME}\n` +
          `Context at:\n  ${result.neededPaths?.join("\n  ") ?? "(none)"}\n`,
      );
      return HITL_PENDING_EXIT_CODE;
  }
}

interface ReAnchorCliArgs {
  runId: string;
  strictStdinHitl: boolean;
}

export function parseReAnchorCliArgs(argv: string[]): ReAnchorCliArgs {
  const args = argv.slice(2);
  let runId: string | undefined;
  let strictStdinHitl = false;
  for (const a of args) {
    if (a === "--strict-stdin-hitl") strictStdinHitl = true;
    else if (!runId) runId = a;
  }
  if (!runId) {
    throw new Error("usage: re-anchor.mts <run-id> [--strict-stdin-hitl]");
  }
  return { runId, strictStdinHitl };
}

if (import.meta.main) {
  let parsed: ReAnchorCliArgs;
  try {
    parsed = parseReAnchorCliArgs(process.argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(2);
  }
  try {
    const code = await main(parsed.runId, {
      strictStdinHitl: parsed.strictStdinHitl,
    });
    process.exit(code);
  } catch (err) {
    process.stderr.write(`re-anchor: ${(err as Error).message}\n`);
    process.exit(2);
  }
}
