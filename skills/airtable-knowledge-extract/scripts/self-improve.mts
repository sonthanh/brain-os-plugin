#!/usr/bin/env bun
/**
 * self-improve.mts — C8 Phase-1 examples-bank grower.
 *
 * Runs after the Reviewer rejects a batch (`bun run review-slice.mts`
 * exits non-zero). For each rejected slice:
 *
 *   1. Surface raw + reasoning to user via HITL channel.
 *      - Default real impl: write a correction template JSON file under
 *        `<basePath>/corrections/correction-<slice_id>.json`, fire an
 *        osascript notification, then poll the file every second until
 *        the user fills in `corrected` + `reason` and saves.
 *      - Tests inject `promptUser` to skip I/O.
 *   2. Append `(raw, corrected, reason)` triple to `<basePath>/examples.jsonl`.
 *      Per-base path is the cross-base isolation guarantee — this script
 *      writes to exactly one file derived from the caller-provided base
 *      context dir; nothing else.
 *
 * NO autonomous prompt rewrite. The bank grows; the prompt itself stays
 * pinned. Examples become a cached prefix on the next Reviewer call —
 * in-context learning, not prompt mutation.
 *
 * The orchestrator (#191) is responsible for re-queueing the failed batch
 * at half concurrency (`-P/2`); this slice only grows the bank.
 *
 * CLI: `bun run self-improve.mts <reject-batch>`
 *   Required:
 *     - `--base-path <dir>` (or `AIRTABLE_BASE_CONTEXT_DIR`): per-base
 *       context dir holding examples.jsonl. Same dir review-slice.mts
 *       reads via `loadBaseContext`.
 *   Output: SelfImproveResult JSON on stdout. Exit 0 on success.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  HITL_PENDING_EXIT_CODE,
  HitlPendingError,
  makeWakeToken,
} from "./hitl.mts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RejectedSlice {
  slice_id: string;
  raw: unknown;
  reasoning: string;
  fail_modes?: string[];
}

export interface RejectBatch {
  base_id: string;
  rung?: 0 | 1;
  rejects: RejectedSlice[];
}

export interface UserCorrection {
  corrected: unknown;
  reason: string;
}

export interface ExampleTriple {
  ts: string;
  slice_id: string;
  raw: unknown;
  corrected: unknown;
  reason: string;
}

export interface PromptContext {
  base_id: string;
  rung: number;
  workspaceDir: string;
}

export type UserPromptFn = (
  reject: RejectedSlice,
  ctx: PromptContext,
) => Promise<UserCorrection>;

export type NotifyFn = (title: string, body: string) => void;

export interface SelfImproveDeps {
  promptUser?: UserPromptFn;
  notify?: NotifyFn;
  now?: () => string;
}

export interface SelfImproveInput {
  batch: RejectBatch;
  basePath: string;
}

export interface SelfImproveResult {
  base_id: string;
  rung: number;
  examples_path: string;
  appended: number;
  triples: ExampleTriple[];
}

export interface SelfImproveDecisionNeededPayload {
  phase: "self-improve";
  base_id: string;
  rung: number;
  slice_id: string;
  raw: unknown;
  reasoning: string;
  fail_modes: string[];
  decision_path: string;
  wake_token: string;
}

export function correctionNeededPathFor(basePath: string, sliceId: string): string {
  return join(basePath, "corrections", `correction-needed-${sliceId}.json`);
}

export function correctionDecidedPathFor(basePath: string, sliceId: string): string {
  return join(basePath, "corrections", `correction-decided-${sliceId}.json`);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function parseRejectBatch(raw: unknown): RejectBatch {
  if (!raw || typeof raw !== "object") {
    throw new Error("parseRejectBatch: input must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.base_id !== "string" || obj.base_id.length === 0) {
    throw new Error("parseRejectBatch: base_id (string) required");
  }
  if (!Array.isArray(obj.rejects)) {
    throw new Error("parseRejectBatch: rejects (array) required");
  }
  const rung = obj.rung ?? 0;
  if (rung !== 0 && rung !== 1) {
    throw new Error(`parseRejectBatch: rung must be 0 or 1 (got ${rung})`);
  }
  const rejects: RejectedSlice[] = obj.rejects.map((r, i) => {
    if (!r || typeof r !== "object") {
      throw new Error(`parseRejectBatch: rejects[${i}] must be an object`);
    }
    const ro = r as Record<string, unknown>;
    if (typeof ro.slice_id !== "string" || ro.slice_id.length === 0) {
      throw new Error(`parseRejectBatch: rejects[${i}].slice_id required`);
    }
    if (!("raw" in ro)) {
      throw new Error(`parseRejectBatch: rejects[${i}].raw required`);
    }
    if (typeof ro.reasoning !== "string") {
      throw new Error(`parseRejectBatch: rejects[${i}].reasoning required`);
    }
    const fail_modes = Array.isArray(ro.fail_modes)
      ? (ro.fail_modes as string[])
      : undefined;
    return {
      slice_id: ro.slice_id,
      raw: ro.raw,
      reasoning: ro.reasoning,
      fail_modes,
    };
  });
  return { base_id: obj.base_id, rung, rejects };
}

export function buildTriple(
  reject: RejectedSlice,
  correction: UserCorrection,
  ts: string,
): ExampleTriple {
  if (typeof correction.reason !== "string" || correction.reason.length === 0) {
    throw new Error(
      `buildTriple: correction.reason (string) required for slice ${reject.slice_id}`,
    );
  }
  if (!("corrected" in correction)) {
    throw new Error(
      `buildTriple: correction.corrected required for slice ${reject.slice_id}`,
    );
  }
  return {
    ts,
    slice_id: reject.slice_id,
    raw: reject.raw,
    corrected: correction.corrected,
    reason: correction.reason,
  };
}

export function appendTriples(
  basePath: string,
  triples: ExampleTriple[],
): string {
  const path = join(basePath, "examples.jsonl");
  if (triples.length === 0) return path;
  mkdirSync(basePath, { recursive: true });
  const payload = triples.map((t) => `${JSON.stringify(t)}\n`).join("");
  appendFileSync(path, payload);
  return path;
}

// ---------------------------------------------------------------------------
// Default HITL — export-decision-and-exit (issue #232)
// ---------------------------------------------------------------------------

export function buildSelfImproveDecisionNeeded(args: {
  reject: RejectedSlice;
  baseId: string;
  rung: number;
  decisionPath: string;
  wakeToken: string;
}): SelfImproveDecisionNeededPayload {
  return {
    phase: "self-improve",
    base_id: args.baseId,
    rung: args.rung,
    slice_id: args.reject.slice_id,
    raw: args.reject.raw,
    reasoning: args.reject.reasoning,
    fail_modes: args.reject.fail_modes ?? [],
    decision_path: args.decisionPath,
    wake_token: args.wakeToken,
  };
}

export function parseSelfImproveDecisionFile(raw: string): UserCorrection {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `self-improve decision file: JSON parse failed — ${(err as Error).message}`,
    );
  }
  if (!obj || typeof obj !== "object") {
    throw new Error("self-improve decision file: must be a JSON object");
  }
  const o = obj as Record<string, unknown>;
  if (!("corrected" in o)) {
    throw new Error(
      "self-improve decision file: 'corrected' key required",
    );
  }
  if (typeof o.reason !== "string" || o.reason.length === 0) {
    throw new Error(
      "self-improve decision file: 'reason' (non-empty string) required",
    );
  }
  return { corrected: o.corrected, reason: o.reason };
}

export function defaultExportAndExitPromptUser(opts: {
  uuid?: () => string;
}): UserPromptFn {
  const uuid = opts.uuid ?? makeWakeToken;
  return async (reject, ctx) => {
    mkdirSync(ctx.workspaceDir, { recursive: true });
    const decisionPath = join(
      ctx.workspaceDir,
      `correction-decided-${reject.slice_id}.json`,
    );
    if (existsSync(decisionPath)) {
      const correction = parseSelfImproveDecisionFile(
        readFileSync(decisionPath, "utf8"),
      );
      unlinkSync(decisionPath);
      return correction;
    }
    const neededPath = join(
      ctx.workspaceDir,
      `correction-needed-${reject.slice_id}.json`,
    );
    const payload = buildSelfImproveDecisionNeeded({
      reject,
      baseId: ctx.base_id,
      rung: ctx.rung,
      decisionPath,
      wakeToken: uuid(),
    });
    writeFileSync(neededPath, `${JSON.stringify(payload, null, 2)}\n`);
    throw new HitlPendingError([neededPath]);
  };
}

// ---------------------------------------------------------------------------
// Legacy HITL — file-poll prompt (opt-in via --strict-stdin-hitl)
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 60 * 60 * 1_000; // 1h cap

function renderCorrectionTemplate(
  reject: RejectedSlice,
  ctx: PromptContext,
): string {
  return JSON.stringify(
    {
      _instructions: [
        "Self-improve correction template.",
        "Edit `corrected` to the entity JSON the Reviewer should have produced.",
        "Edit `reason` to a short note (the WHY of the fix).",
        "Save the file. self-improve will detect the save and append the triple.",
      ],
      base_id: ctx.base_id,
      rung: ctx.rung,
      slice_id: reject.slice_id,
      reasoning: reject.reasoning,
      fail_modes: reject.fail_modes ?? [],
      raw: reject.raw,
      corrected: null,
      reason: "",
    },
    null,
    2,
  );
}

async function strictFilePollPromptUser(
  reject: RejectedSlice,
  ctx: PromptContext,
): Promise<UserCorrection> {
  mkdirSync(ctx.workspaceDir, { recursive: true });
  const file = join(
    ctx.workspaceDir,
    `correction-${reject.slice_id}.json`,
  );
  if (!existsSync(file)) {
    writeFileSync(file, renderCorrectionTemplate(reject, ctx));
  }

  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const txt = readFileSync(file, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(txt);
    } catch {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (parsed && typeof parsed === "object") {
      const p = parsed as Record<string, unknown>;
      if (
        "corrected" in p &&
        p.corrected !== null &&
        typeof p.reason === "string" &&
        p.reason.length > 0
      ) {
        return { corrected: p.corrected, reason: p.reason };
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `strictFilePollPromptUser: timed out waiting for ${file} (slice ${reject.slice_id})`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => {
    setTimeout(res, ms);
  });
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
      ["-e", `display notification ${jsString(body)} with title ${jsString(title)}`],
      { stdio: "ignore" },
    );
  } catch {
    process.stderr.write(`[self-improve notify] ${title}: ${body}\n`);
  }
}

function jsString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function selfImprove(
  input: SelfImproveInput,
  deps: SelfImproveDeps = {},
): Promise<SelfImproveResult> {
  if (!input.basePath) {
    throw new Error("selfImprove: basePath required");
  }
  const batch = parseRejectBatch(input.batch);
  const promptUser = deps.promptUser;
  const notify = deps.notify ?? defaultNotify;
  const now = deps.now ?? (() => new Date().toISOString());
  const examplesPath = join(input.basePath, "examples.jsonl");
  const workspaceDir = join(input.basePath, "corrections");

  // Default flow (no promptUser override): two-pass detection — atomic export
  // pattern. If any reject lacks a decision file, write needed-files for the
  // missing ones only and throw, without consuming any existing decisions.
  if (!promptUser) {
    const missing: RejectedSlice[] = [];
    for (const reject of batch.rejects) {
      const decisionPath = correctionDecidedPathFor(
        input.basePath,
        reject.slice_id,
      );
      if (!existsSync(decisionPath)) missing.push(reject);
    }
    if (missing.length > 0) {
      mkdirSync(workspaceDir, { recursive: true });
      const neededPaths: string[] = [];
      for (const reject of missing) {
        const decisionPath = correctionDecidedPathFor(
          input.basePath,
          reject.slice_id,
        );
        const neededPath = correctionNeededPathFor(
          input.basePath,
          reject.slice_id,
        );
        const payload = buildSelfImproveDecisionNeeded({
          reject,
          baseId: batch.base_id,
          rung: batch.rung ?? 0,
          decisionPath,
          wakeToken: makeWakeToken(),
        });
        writeFileSync(neededPath, `${JSON.stringify(payload, null, 2)}\n`);
        neededPaths.push(neededPath);
        notify(
          `airtable-knowledge-extract: HITL correction needed`,
          `slice ${reject.slice_id} (base ${batch.base_id}, rung ${batch.rung}): ${truncate(reject.reasoning, 120)}`,
        );
      }
      throw new HitlPendingError(neededPaths);
    }
  }

  // Either: all decision files present (default flow consumes via the prompt),
  // or a promptUser override is supplied (tests / --strict-stdin-hitl).
  const effectivePromptUser = promptUser ?? defaultExportAndExitPromptUser({});
  const triples: ExampleTriple[] = [];
  for (const reject of batch.rejects) {
    notify(
      `airtable-knowledge-extract: HITL correction needed`,
      `slice ${reject.slice_id} (base ${batch.base_id}, rung ${batch.rung}): ${truncate(reject.reasoning, 120)}`,
    );
    const correction = await effectivePromptUser(reject, {
      base_id: batch.base_id,
      rung: batch.rung ?? 0,
      workspaceDir,
    });
    triples.push(buildTriple(reject, correction, now()));
  }

  appendTriples(input.basePath, triples);

  return {
    base_id: batch.base_id,
    rung: batch.rung ?? 0,
    examples_path: examplesPath,
    appended: triples.length,
    triples,
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

export function parseSelfImproveCliArgs(argv: string[]): {
  batchPath: string;
  basePath: string;
  strictStdinHitl: boolean;
} {
  let batchPath: string | undefined;
  let basePath: string | undefined = process.env.AIRTABLE_BASE_CONTEXT_DIR;
  let strictStdinHitl = false;

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--base-path") basePath = args[++i];
    else if (a === "--strict-stdin-hitl") strictStdinHitl = true;
    else if (!batchPath) batchPath = a;
  }

  if (!batchPath) {
    throw new Error(
      "usage: self-improve.mts <reject-batch> --base-path <dir> [--strict-stdin-hitl]",
    );
  }
  if (!basePath) {
    throw new Error(
      "self-improve: --base-path or AIRTABLE_BASE_CONTEXT_DIR required",
    );
  }
  return { batchPath, basePath, strictStdinHitl };
}

if (import.meta.main) {
  try {
    const { batchPath, basePath, strictStdinHitl } = parseSelfImproveCliArgs(
      process.argv,
    );
    const raw = JSON.parse(readFileSync(batchPath, "utf8"));
    const deps: SelfImproveDeps = strictStdinHitl
      ? { promptUser: strictFilePollPromptUser }
      : {};
    const result = await selfImprove({ batch: raw, basePath }, deps);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(0);
  } catch (err) {
    if (err instanceof HitlPendingError) {
      process.stderr.write(
        `self-improve: HITL needed — write decision files at:\n${err.neededPaths
          .map(
            (p) =>
              `  ${p.replace("correction-needed-", "correction-decided-")}`,
          )
          .join("\n")}\nContext at:\n${err.neededPaths.map((p) => `  ${p}`).join("\n")}\n`,
      );
      process.exit(HITL_PENDING_EXIT_CODE);
    }
    process.stderr.write(`self-improve: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
