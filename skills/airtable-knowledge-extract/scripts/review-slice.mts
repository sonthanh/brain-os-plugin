#!/usr/bin/env bun
/**
 * review-slice.mts — C7 Phase-1 subgraph reviewer.
 *
 * Opus 4.6 per-batch reviewer. Input: a batch file containing N (default 10)
 * slices, each `{slice_id, base_id, cluster_id, cluster_type, subgraph,
 * entities}`. The orchestrator (#191) is responsible for assembling each
 * batch entry — `extract-slice.mts` persists `entities` + `subgraph_context`
 * via its manifest is NOT yet persisting subgraph; the orchestrator MUST
 * carry the subgraph string forward when it queues a slice for review.
 *
 * 1. Loads the per-base context dir: `meta-rubric.md`, optional
 *    `examples.jsonl` (absent on first batch), `rubric-questions.md`.
 * 2. Renders `prompts/review.md` with the static prefix BEFORE the dynamic
 *    batch — order chosen so Anthropic's prompt cache hits on the prefix
 *    across batches in the same run.
 * 3. Invokes Opus via `runOpus` (default = spawn `claude -p --model
 *    $AIRTABLE_REVIEWER_MODEL --output-format=stream-json --verbose`).
 *    Model id is loose-coupled via `AIRTABLE_REVIEWER_MODEL`
 *    (default `claude-opus-4-6`).
 * 4. Parses the strict-JSON reviewer response into per-slice verdicts:
 *    `{slice_id, score, pass, reasoning, fail_modes}` + a batch summary.
 * 5. Re-asserts the batch threshold (default 0.95) on the parsed pass-rate.
 *    The reviewer's own `batch.pass` is advisory; runtime decides.
 * 6. Appends one cost-meter event to `<runDir>/cost-meter.jsonl` (same
 *    schema `extract-slice` writes; `guard.mts` polls one shape).
 *
 * CLI: `bun run review-slice.mts <batch-file>`
 *   Required env / flags:
 *     - `--base-path <dir>` (or `AIRTABLE_BASE_CONTEXT_DIR`): per-base
 *       context dir holding meta-rubric.md, examples.jsonl,
 *       rubric-questions.md.
 *     - `--cost-meter <path>` (or `AIRTABLE_COST_METER`): cost-meter file
 *       to append.
 *     - `--threshold <num>`: pass threshold; default 0.95.
 *   Output: BatchVerdict JSON on stdout. Exit code 0 on pass, 1 on fail.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtractedEntity } from "./extract-slice.mts";

export const DEFAULT_THRESHOLD = 0.95;
export const DEFAULT_REVIEWER_MODEL = "claude-opus-4-6";
export const SLICE_PASS_SCORE = 0.9;
export const FAIL_MODE_VOCABULARY = [
  "link-mismatch",
  "fact-invented",
  "schema-fail",
  "missing-entity",
  "slug-collision",
  "frontmatter-drift",
] as const;
export type FailMode = (typeof FAIL_MODE_VOCABULARY)[number];

export interface SliceForReview {
  slice_id: string;
  base_id: string;
  cluster_id: string;
  cluster_type: string;
  subgraph: string;
  entities: ExtractedEntity[];
}

export interface SliceVerdict {
  slice_id: string;
  score: number;
  pass: boolean;
  reasoning: string;
  fail_modes: FailMode[];
}

export interface OpusUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface OpusResponse {
  rawText: string;
  usage: OpusUsage;
  model: string;
}

export type OpusRunner = (
  prompt: string,
  model: string,
) => Promise<OpusResponse>;

export interface BatchVerdict {
  batch_id: string;
  base_id: string;
  pass_rate: number;
  pass: boolean;
  threshold: number;
  slices: SliceVerdict[];
  usage: OpusUsage;
  model: string;
}

export interface BaseContext {
  metaRubric: string;
  examples: string;
  rubricQuestions: string;
}

export interface ReviewBatchInput {
  batchId: string;
  baseId: string;
  slices: SliceForReview[];
}

export interface ReviewBatchDeps {
  runOpus?: OpusRunner;
  basePath?: string;
  baseContext?: BaseContext;
  promptsPath?: string;
  costMeterPath?: string;
  threshold?: number;
  model?: string;
  env?: Record<string, string | undefined>;
  now?: () => string;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit-test access
// ---------------------------------------------------------------------------

export function loadBaseContext(basePath: string): BaseContext {
  const metaRubricPath = join(basePath, "meta-rubric.md");
  const rubricQuestionsPath = join(basePath, "rubric-questions.md");
  const examplesPath = join(basePath, "examples.jsonl");

  if (!existsSync(metaRubricPath)) {
    throw new Error(`meta-rubric.md missing at ${metaRubricPath}`);
  }
  if (!existsSync(rubricQuestionsPath)) {
    throw new Error(`rubric-questions.md missing at ${rubricQuestionsPath}`);
  }
  return {
    metaRubric: readFileSync(metaRubricPath, "utf8"),
    examples: existsSync(examplesPath)
      ? readFileSync(examplesPath, "utf8")
      : "",
    rubricQuestions: readFileSync(rubricQuestionsPath, "utf8"),
  };
}

export function renderBatchSection(slices: SliceForReview[]): string {
  const lines: string[] = [];
  for (const s of slices) {
    lines.push(`## slice ${s.slice_id}`);
    lines.push(`base: ${s.base_id}`);
    lines.push(`cluster: ${s.cluster_id} (${s.cluster_type})`);
    lines.push("");
    lines.push("### Source subgraph");
    lines.push("");
    lines.push(s.subgraph.trim() || "(empty subgraph)");
    lines.push("");
    lines.push("### Extracted entities");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(s.entities, null, 2));
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}

export function renderReviewerPrompt(
  template: string,
  ctx: BaseContext,
  batchSection: string,
): string {
  return template
    .replace(/\{\{meta_rubric\}\}/g, ctx.metaRubric.trim() || "(missing)")
    .replace(
      /\{\{examples\}\}/g,
      ctx.examples.trim() || "(none yet — first batch on this base)",
    )
    .replace(
      /\{\{rubric_questions\}\}/g,
      ctx.rubricQuestions.trim() || "(missing)",
    )
    .replace(/\{\{batch\}\}/g, batchSection.trim());
}

export function parseStreamJsonLines(lines: string[]): OpusResponse {
  const assistantTexts: string[] = [];
  let resultText: string | null = null;
  let lastUsage: OpusUsage | null = null;
  let model = DEFAULT_REVIEWER_MODEL;

  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const type = (obj as { type?: string }).type;
    if (type === "system") {
      const m = (obj as { model?: string }).model;
      if (typeof m === "string") model = m;
    } else if (type === "assistant") {
      const message = (
        obj as {
          message?: { content?: unknown; usage?: OpusUsage; model?: string };
        }
      ).message;
      if (Array.isArray(message?.content)) {
        for (const c of message.content as Array<{
          type?: string;
          text?: string;
        }>) {
          if (c?.type === "text" && typeof c.text === "string") {
            assistantTexts.push(c.text);
          }
        }
      }
      if (message?.usage) lastUsage = message.usage;
      if (typeof message?.model === "string") model = message.model;
    } else if (type === "result") {
      const r = (obj as { result?: string }).result;
      if (typeof r === "string") resultText = r;
      const u = (obj as { usage?: OpusUsage }).usage;
      if (u) lastUsage = u;
    }
  }

  return {
    rawText: resultText ?? assistantTexts.join(""),
    usage: lastUsage ?? { input_tokens: 0, output_tokens: 0 },
    model,
  };
}

interface ReviewerOutput {
  slices: Array<{
    slice_id: unknown;
    score: unknown;
    pass: unknown;
    reasoning: unknown;
    fail_modes: unknown;
  }>;
  batch?: {
    pass_rate?: unknown;
    pass?: unknown;
  };
}

export function parseReviewerResponse(
  text: string,
  expectedSliceIds: string[],
): SliceVerdict[] {
  let cleaned = text.trim();
  cleaned = cleaned
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/, "")
    .trim();
  const objStart = cleaned.search(/[\{\[]/);
  if (objStart < 0) {
    throw new Error("Reviewer output: no JSON object/array found in response");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(objStart));
  } catch (err) {
    throw new Error(
      `Reviewer output: JSON parse failed: ${(err as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Reviewer output: expected JSON object with 'slices'");
  }
  const out = parsed as ReviewerOutput;
  if (!Array.isArray(out.slices)) {
    throw new Error("Reviewer output: 'slices' missing or not an array");
  }

  const expectedSet = new Set(expectedSliceIds);
  const seen = new Set<string>();
  const verdicts: SliceVerdict[] = [];

  for (const raw of out.slices) {
    if (typeof raw?.slice_id !== "string" || raw.slice_id.length === 0) {
      throw new Error("Reviewer output: slice missing 'slice_id'");
    }
    const sliceId = raw.slice_id;
    if (!expectedSet.has(sliceId)) {
      throw new Error(
        `Reviewer output: unexpected slice_id '${sliceId}' (not in input batch)`,
      );
    }
    if (seen.has(sliceId)) {
      throw new Error(
        `Reviewer output: duplicate slice_id '${sliceId}' in verdicts`,
      );
    }
    seen.add(sliceId);

    const score = typeof raw.score === "number" ? raw.score : NaN;
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      throw new Error(
        `Reviewer output: slice '${sliceId}' score must be a number in [0,1]`,
      );
    }
    const pass =
      typeof raw.pass === "boolean" ? raw.pass : score >= SLICE_PASS_SCORE;
    const reasoning = typeof raw.reasoning === "string" ? raw.reasoning : "";
    const failModesRaw = Array.isArray(raw.fail_modes) ? raw.fail_modes : [];
    const failModes: FailMode[] = [];
    for (const tag of failModesRaw) {
      if (
        typeof tag === "string" &&
        (FAIL_MODE_VOCABULARY as readonly string[]).includes(tag)
      ) {
        failModes.push(tag as FailMode);
      }
    }
    verdicts.push({
      slice_id: sliceId,
      score,
      pass,
      reasoning,
      fail_modes: pass ? [] : failModes,
    });
  }

  for (const id of expectedSliceIds) {
    if (!seen.has(id)) {
      throw new Error(
        `Reviewer output: missing verdict for slice '${id}' (input batch had it)`,
      );
    }
  }

  return verdicts;
}

export function computeBatchPassRate(verdicts: SliceVerdict[]): number {
  if (verdicts.length === 0) return 0;
  const passed = verdicts.filter((v) => v.pass).length;
  return passed / verdicts.length;
}

export interface FidelityMetrics {
  precision: number;
  recall: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
}

export function computeFidelityMetrics(
  verdicts: Array<{ slice_id: string; pass: boolean }>,
  groundTruth: Map<string, boolean>,
): FidelityMetrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const v of verdicts) {
    const truth = groundTruth.get(v.slice_id);
    if (truth === undefined) {
      throw new Error(
        `computeFidelityMetrics: slice '${v.slice_id}' not in ground truth`,
      );
    }
    if (v.pass && truth) tp += 1;
    else if (v.pass && !truth) fp += 1;
    else if (!v.pass && truth) fn += 1;
    else tn += 1;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  return {
    precision,
    recall,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    trueNegatives: tn,
  };
}

// ---------------------------------------------------------------------------
// Default Opus runner — spawn claude -p
// ---------------------------------------------------------------------------

async function spawnClaudeOpus(
  prompt: string,
  model: string,
): Promise<OpusResponse> {
  const { spawn } = await import("node:child_process");
  return await new Promise<OpusResponse>((resolve, reject) => {
    const child = spawn(
      "claude",
      [
        "-p",
        prompt,
        "--model",
        model,
        "--output-format",
        "stream-json",
        "--verbose",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claude -p exited ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(parseStreamJsonLines(stdout.split("\n")));
      } catch (err) {
        reject(err);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

function defaultPromptsPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "prompts", "review.md");
}

export async function reviewBatch(
  input: ReviewBatchInput,
  deps: ReviewBatchDeps = {},
): Promise<BatchVerdict> {
  const env = deps.env ?? process.env;
  const threshold = deps.threshold ?? DEFAULT_THRESHOLD;
  const model =
    deps.model ?? env.AIRTABLE_REVIEWER_MODEL ?? DEFAULT_REVIEWER_MODEL;
  const runOpus = deps.runOpus ?? spawnClaudeOpus;
  const promptsPath = deps.promptsPath ?? defaultPromptsPath();
  const now = deps.now ?? (() => new Date().toISOString());

  if (input.slices.length === 0) {
    throw new Error("reviewBatch: empty slice list");
  }

  let baseContext: BaseContext;
  if (deps.baseContext) {
    baseContext = deps.baseContext;
  } else if (deps.basePath) {
    baseContext = loadBaseContext(deps.basePath);
  } else {
    throw new Error("reviewBatch: deps.baseContext or deps.basePath required");
  }

  const template = readFileSync(promptsPath, "utf8");
  const batchSection = renderBatchSection(input.slices);
  const prompt = renderReviewerPrompt(template, baseContext, batchSection);

  const opusResp = await runOpus(prompt, model);
  const sliceIds = input.slices.map((s) => s.slice_id);
  const verdicts = parseReviewerResponse(opusResp.rawText, sliceIds);
  const passRate = computeBatchPassRate(verdicts);
  const pass = passRate >= threshold;

  if (deps.costMeterPath) {
    mkdirSync(dirname(deps.costMeterPath), { recursive: true });
    const costEvent: Record<string, unknown> = {
      ts: now(),
      model: opusResp.model,
      input_tokens: opusResp.usage.input_tokens,
      output_tokens: opusResp.usage.output_tokens,
      role: "reviewer",
      batch_id: input.batchId,
    };
    if (opusResp.usage.cache_creation_input_tokens != null) {
      costEvent.cache_creation_input_tokens =
        opusResp.usage.cache_creation_input_tokens;
    }
    if (opusResp.usage.cache_read_input_tokens != null) {
      costEvent.cache_read_input_tokens =
        opusResp.usage.cache_read_input_tokens;
    }
    appendFileSync(deps.costMeterPath, `${JSON.stringify(costEvent)}\n`);
  }

  return {
    batch_id: input.batchId,
    base_id: input.baseId,
    pass_rate: passRate,
    pass,
    threshold,
    slices: verdicts,
    usage: opusResp.usage,
    model: opusResp.model,
  };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

interface BatchFile {
  batch_id?: string;
  base_id?: string;
  slices: SliceForReview[];
}

function parseArgs(argv: string[]): {
  batchPath: string;
  basePath: string;
  costMeterPath?: string;
  threshold: number;
  model?: string;
} {
  let batchPath: string | undefined;
  let basePath: string | undefined = process.env.AIRTABLE_BASE_CONTEXT_DIR;
  let costMeterPath: string | undefined = process.env.AIRTABLE_COST_METER;
  let threshold = DEFAULT_THRESHOLD;
  let model: string | undefined;

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--base-path") basePath = args[++i];
    else if (a === "--cost-meter") costMeterPath = args[++i];
    else if (a === "--threshold") threshold = Number(args[++i]);
    else if (a === "--model") model = args[++i];
    else if (!batchPath) batchPath = a;
  }

  if (!batchPath) {
    throw new Error(
      "usage: review-slice.mts <batch-file> --base-path <dir> [--cost-meter <path>] [--threshold 0.95] [--model <id>]",
    );
  }
  if (!basePath) {
    throw new Error(
      "review-slice: --base-path or AIRTABLE_BASE_CONTEXT_DIR required",
    );
  }
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`review-slice: --threshold must be in [0,1]`);
  }
  return { batchPath, basePath, costMeterPath, threshold, model };
}

if (import.meta.main) {
  try {
    const { batchPath, basePath, costMeterPath, threshold, model } = parseArgs(
      process.argv,
    );
    const batchRaw = readFileSync(batchPath, "utf8");
    const batchFile = JSON.parse(batchRaw) as BatchFile;
    if (!Array.isArray(batchFile.slices) || batchFile.slices.length === 0) {
      throw new Error(`review-slice: batch file ${batchPath} has no slices`);
    }
    const baseId =
      batchFile.base_id ?? batchFile.slices[0]?.base_id ?? "unknown";
    const batchId =
      batchFile.batch_id ??
      `batch-${new Date().toISOString().replace(/[:.]/g, "-")}`;

    const verdict = await reviewBatch(
      { batchId, baseId, slices: batchFile.slices },
      {
        basePath,
        costMeterPath,
        threshold,
        model,
      },
    );

    process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
    process.exit(verdict.pass ? 0 : 1);
  } catch (err) {
    process.stderr.write(`review-slice: ${(err as Error).message}\n`);
    process.exit(2);
  }
}
