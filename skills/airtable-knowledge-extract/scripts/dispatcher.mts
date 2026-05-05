#!/usr/bin/env bun
/**
 * dispatcher.mts — Stage D3 schema-driven dispatcher (ai-brain#242, parent #237 AC#7).
 *
 * For each connected component (S3 / cluster-classifier output), partitions the
 * component's tables by Stage 0 type (S0 / classify-table-type) and decides:
 *
 *   - entity_strategy ∈ {record-by-record, single-pass, chunked-by-AP, none}
 *   - interaction_handler ∈ {edge-emit, none}
 *
 * Decision rules (per #237 grill Q5/Q7 lock + #242 issue body strategy table):
 *
 *   entity strategy
 *     no extractable entity tables           → none
 *     orphan-shape component                 → record-by-record
 *     records > SIZE_THRESHOLD (100)         → chunked-by-AP
 *     est. tokens > TOKEN_THRESHOLD (100K)   → chunked-by-AP
 *     otherwise                              → single-pass
 *
 *   interaction handler
 *     ≥1 interaction-classified table        → edge-emit
 *     otherwise                              → none
 *
 * Naming note: `chunked-by-AP` is the canonical strategy name per parent AC#7 +
 * issue body. The child AC's enum description (`strategy=<single-pass|chunked|
 * record-by-record|edge-emit>`) writes `chunked` as a shorthand; we emit
 * `chunked-by-AP` everywhere (type, JSON output, log row) so audit / /improve
 * aggregation has one literal to grep on. The shorthand is descriptive only.
 *
 * Inputs (cache files — all REQUIRED, dispatcher aborts if any missing):
 *
 *   1. Stage 0 type cache:    skills/.../cache/table-types/<base_id>.json
 *      (durable across runs; written by classify-table-type.mts)
 *   2. Cluster shapes cache:  ~/.claude/airtable-extract-cache/<run-id>/
 *                              cluster-shapes-<base_id>.json
 *      (per-run; written by cluster-classifier.mts)
 *   3. Natural-keys cache:    ~/.claude/airtable-extract-cache/<run-id>/
 *                              natural-keys-<base_id>.json
 *      (per-run; written by schema-analyser.mts)
 *
 * Outputs:
 *
 *   - JSON to stdout (CLI):   `[{ component_id, entity_strategy, interaction_handler, ... }]`
 *   - JSON cache:             ~/.claude/airtable-extract-cache/<run-id>/
 *                              dispatch-<base_id>.json
 *   - Outcome log rows (one per component, per AC): vault
 *                              `daily/skill-outcomes/airtable-knowledge-extract.log`
 *     `{date} | airtable-knowledge-extract | dispatch | {repo} | {cache} |
 *      commit:none | pass | base_id=X run_id=Y component_id=Z shape=W
 *      records=N est_tokens=M strategy=<one-of-4> interaction_handler=<edge-emit|none>`
 *     (one-row-per-component is defensible against the AC's "logged ... row"
 *      and gives /improve a clean aggregator: `awk -F'|' '/dispatch/'` →
 *      grouped by `strategy=`.)
 *
 * Token estimation: `estimateEntityTokens(recordCount) = recordCount × 500`.
 * 500 is a coarse default (typical Airtable record + field set serialised to
 * JSON sits in the 200–1000-token range; 500 is the midpoint that keeps the
 * AC#7 token-threshold clause testable). Pinned in `tests/dispatcher.test.ts`
 * so any future tuning has to update an assertion.
 *
 * NEVER calls an LLM — strategy decisions are deterministic. The dispatcher
 * is the routing brain; the strategies it routes to (single-pass, chunked,
 * record-by-record, edge-emit) own their own LLM contracts (or lack thereof).
 *
 * CLI:
 *   bun run dispatcher.mts <base-id>
 *     Reads AIRTABLE_RUN_ID from env (default: today's UTC date suffixed with
 *     `-airtable-extract`, matching schema-analyser.mts).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClusterShape, ClusterShapeComponent } from "./cluster-classifier.mts";
import type { TableTypeClassification } from "./classify-table-type.mts";
import type { NaturalKeyOutput, NkAccepted } from "./schema-analyser.mts";
import { appendOutcomeLog } from "./outcome-log.mts";

// ---------------------------------------------------------------------------
// Constants — strategy thresholds (locked in #237 grill Q7)
// ---------------------------------------------------------------------------

export const SIZE_THRESHOLD = 100;
export const TOKEN_THRESHOLD = 100_000;
/**
 * Coarse per-record token estimate. Pinned in tests; tune via empirical
 * Sonnet-call accounting once the single-pass extractor (#243) has shipped
 * a few real runs.
 */
export const TOKENS_PER_RECORD_ESTIMATE = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EntityStrategy =
  | "single-pass"
  | "chunked-by-AP"
  | "record-by-record"
  | "none";

export type InteractionHandler = "edge-emit" | "none";

export interface ComponentDispatch {
  component_id: string;
  shape: ClusterShape;
  size: number;
  /** Tables in the component classified `entity` AND with an accepted NK. */
  entity_tables: string[];
  /** Tables classified `interaction` (edge emitter consumes wholesale). */
  interaction_tables: string[];
  /** Stage-0-`reject` tables OR entity tables with no NK — skipped downstream. */
  rejected_tables: string[];
  entity_record_count: number;
  estimated_entity_tokens: number;
  entity_strategy: EntityStrategy;
  interaction_handler: InteractionHandler;
  reason: string;
}

export interface DispatchOptions {
  /** Run-cache root (default: ~/.claude/airtable-extract-cache). */
  cacheDir?: string;
  /** Run id; default mirrors schema-analyser (env AIRTABLE_RUN_ID → today). */
  runId?: string;
  /** Override Stage 0 cache path (skill-folder durable cache). */
  stage0CachePath?: string;
  env?: Record<string, string | undefined>;
  /** When true, append outcome log rows. Default true. */
  writeOutcomeLog?: boolean;
  /** When set, override vault path resolution for outcome log writes. */
  vaultPath?: string;
  warn?: (msg: string) => void;
}

export interface DispatchResult {
  baseId: string;
  runId: string;
  components: ComponentDispatch[];
  cachePath: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Coarse token estimate. Single-knob, deterministic, pinned by a unit test
 * so retuning has to update an assertion.
 */
export function estimateEntityTokens(recordCount: number): number {
  return Math.max(0, recordCount) * TOKENS_PER_RECORD_ESTIMATE;
}

export interface DecideEntityStrategyInput {
  shape: ClusterShape;
  hasEntityTables: boolean;
  recordCount: number;
  estimatedTokens: number;
}

export function decideEntityStrategy(
  input: DecideEntityStrategyInput,
): { strategy: EntityStrategy; reason: string } {
  if (!input.hasEntityTables) {
    return { strategy: "none", reason: "no extractable entity tables in component" };
  }
  if (input.shape === "orphan") {
    return { strategy: "record-by-record", reason: "orphan-shape component" };
  }
  if (input.recordCount > SIZE_THRESHOLD) {
    return {
      strategy: "chunked-by-AP",
      reason: `record count ${input.recordCount} > ${SIZE_THRESHOLD}`,
    };
  }
  if (input.estimatedTokens > TOKEN_THRESHOLD) {
    return {
      strategy: "chunked-by-AP",
      reason: `estimated tokens ${input.estimatedTokens} > ${TOKEN_THRESHOLD}`,
    };
  }
  return {
    strategy: "single-pass",
    reason: `records=${input.recordCount} tokens=${input.estimatedTokens} below thresholds`,
  };
}

export function decideInteractionHandler(
  interactionTableCount: number,
): InteractionHandler {
  return interactionTableCount > 0 ? "edge-emit" : "none";
}

export interface PartitionResult {
  entityExtractable: string[];
  interactions: string[];
  rejected: string[];
  entityRecordCount: number;
}

/**
 * Partition a component's tables by Stage 0 type, gated by the NK cache.
 *
 * Entity tables with no accepted NK count as `rejected` — schema-analyser
 * already escalates them via stderr; the dispatcher just doesn't route them
 * to an extractor. Stage-0-`reject` tables are also `rejected`. Tables in the
 * component but absent from the Stage 0 cache (race / partial run) are
 * treated as `rejected` and warned.
 */
export function partitionTablesForComponent(
  component: ClusterShapeComponent,
  classifications: Record<string, TableTypeClassification>,
  naturalKeys: NaturalKeyOutput,
  warn?: (msg: string) => void,
): PartitionResult {
  const entityExtractable: string[] = [];
  const interactions: string[] = [];
  const rejected: string[] = [];
  let entityRecordCount = 0;

  for (const tableId of component.tables) {
    const cls = classifications[tableId];
    if (!cls) {
      rejected.push(tableId);
      warn?.(
        `dispatcher: table ${tableId} in component ${component.component_id} ` +
          `has no Stage 0 classification — treating as reject`,
      );
      continue;
    }
    if (cls.type === "interaction") {
      interactions.push(tableId);
      continue;
    }
    if (cls.type === "reject") {
      rejected.push(tableId);
      continue;
    }
    // Stage 0 says entity — gate on NK acceptance.
    const nk = naturalKeys[tableId];
    if (!nk || nk.nk_field === null) {
      rejected.push(tableId);
      continue;
    }
    entityExtractable.push(tableId);
    entityRecordCount += (nk as NkAccepted).sample_size;
  }

  return { entityExtractable, interactions, rejected, entityRecordCount };
}

// ---------------------------------------------------------------------------
// Cache loaders
// ---------------------------------------------------------------------------

function defaultStage0CachePath(baseId: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "cache", "table-types", `${baseId}.json`);
}

function defaultRunId(env: Record<string, string | undefined>): string {
  if (env.AIRTABLE_RUN_ID) return env.AIRTABLE_RUN_ID;
  return `${new Date().toISOString().slice(0, 10)}-airtable-extract`;
}

function loadJsonOrAbort<T>(path: string, label: string, hint: string): T {
  if (!existsSync(path)) {
    throw new Error(
      `dispatcher: ${label} not found at ${path}. ${hint}`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function dispatchBase(
  baseId: string,
  opts: DispatchOptions = {},
): Promise<DispatchResult> {
  const env = opts.env ?? process.env;
  const cacheDir =
    opts.cacheDir ?? join(homedir(), ".claude", "airtable-extract-cache");
  const runId = opts.runId ?? defaultRunId(env);
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`));
  const writeLog = opts.writeOutcomeLog ?? true;

  const stage0Path = opts.stage0CachePath ?? defaultStage0CachePath(baseId);
  const classifications = loadJsonOrAbort<Record<string, TableTypeClassification>>(
    stage0Path,
    "Stage 0 classifier cache",
    `Run \`bun run classify-table-type.mts ${baseId}\` first.`,
  );

  const runDir = join(cacheDir, runId);
  const shapesPath = join(runDir, `cluster-shapes-${baseId}.json`);
  const components = loadJsonOrAbort<ClusterShapeComponent[]>(
    shapesPath,
    "cluster shapes cache",
    `Run \`bun run cluster-classifier.mts ${baseId}\` first (with AIRTABLE_RUN_ID=${runId}).`,
  );

  const nkPath = join(runDir, `natural-keys-${baseId}.json`);
  const naturalKeys = loadJsonOrAbort<NaturalKeyOutput>(
    nkPath,
    "natural-keys cache",
    `Run \`bun run schema-analyser.mts ${baseId}\` first (with AIRTABLE_RUN_ID=${runId}).`,
  );

  const dispatches: ComponentDispatch[] = [];
  for (const component of components) {
    const { entityExtractable, interactions, rejected, entityRecordCount } =
      partitionTablesForComponent(component, classifications, naturalKeys, warn);

    const estimatedTokens = estimateEntityTokens(entityRecordCount);
    const entityDecision = decideEntityStrategy({
      shape: component.shape,
      hasEntityTables: entityExtractable.length > 0,
      recordCount: entityRecordCount,
      estimatedTokens,
    });
    const interactionHandler = decideInteractionHandler(interactions.length);

    dispatches.push({
      component_id: component.component_id,
      shape: component.shape,
      size: component.size,
      entity_tables: entityExtractable,
      interaction_tables: interactions,
      rejected_tables: rejected,
      entity_record_count: entityRecordCount,
      estimated_entity_tokens: estimatedTokens,
      entity_strategy: entityDecision.strategy,
      interaction_handler: interactionHandler,
      reason: entityDecision.reason,
    });
  }

  mkdirSync(runDir, { recursive: true });
  const cachePath = join(runDir, `dispatch-${baseId}.json`);
  writeFileSync(cachePath, JSON.stringify(dispatches, null, 2));

  if (writeLog) {
    appendDispatchLogRows({
      baseId,
      runId,
      cachePath,
      dispatches,
      vaultPath: opts.vaultPath,
      env,
      warn,
    });
  }

  return { baseId, runId, components: dispatches, cachePath };
}

interface AppendLogArgs {
  baseId: string;
  runId: string;
  cachePath: string;
  dispatches: ComponentDispatch[];
  vaultPath?: string;
  env: Record<string, string | undefined>;
  warn: (msg: string) => void;
}

/**
 * One outcome-log row per component. The per-base AC reading would also work
 * but a per-component shape lets `/improve` aggregate strategy distribution
 * across runs without parsing a comma-list — `awk -F'|' '/| dispatch |/'`
 * grouped by `strategy=` is enough.
 */
function appendDispatchLogRows(args: AppendLogArgs): void {
  const today = new Date().toISOString().slice(0, 10);
  for (const d of args.dispatches) {
    // Strategy field follows the AC enum. `none` is emitted only when neither
    // entity nor interaction tables are present (a reject-only component); the
    // child AC enum doesn't list `none` explicitly but the run still needs an
    // audit row. /improve groupers should treat `strategy=none` as "skip".
    const strategy =
      d.entity_strategy !== "none" ? d.entity_strategy : d.interaction_handler;
    const fields: Record<string, string | number> = {
      base_id: args.baseId,
      run_id: args.runId,
      component_id: d.component_id,
      shape: d.shape,
      records: d.entity_record_count,
      est_tokens: d.estimated_entity_tokens,
      strategy,
      interaction_handler: d.interaction_handler,
    };
    const result = appendOutcomeLog(
      {
        date: today,
        skill: "airtable-knowledge-extract",
        action: "dispatch",
        source_repo: "~/work/brain-os-plugin",
        output_path: args.cachePath,
        commit_hash: "none",
        result: "pass",
        fields,
      },
      { vaultPath: args.vaultPath, env: args.env },
    );
    if (!result.ok) {
      args.warn(
        `dispatcher: outcome-log skipped for ${d.component_id} (${result.reason})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const baseId = process.argv[2];
  if (!baseId) {
    process.stderr.write("usage: bun run dispatcher.mts <base-id>\n");
    process.exit(1);
  }
  try {
    const { components, cachePath } = await dispatchBase(baseId);
    process.stderr.write(`dispatcher: wrote ${cachePath}\n`);
    process.stdout.write(JSON.stringify(components, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`dispatcher: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
