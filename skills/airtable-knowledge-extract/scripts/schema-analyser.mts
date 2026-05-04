#!/usr/bin/env bun
/**
 * schema-analyser.mts — Stage D1 natural-key scanner for entity tables (ai-brain#239).
 *
 * For each table classified as `entity` by Stage 0
 * (`cache/table-types/<base_id>.json`), scans records to find a natural key:
 * a scalar source-of-truth field whose values are unique on the full table.
 *
 * Algorithm (locked in #237 grill Q8 + Q9):
 *
 *   1. Fetch ≤ SAMPLE_SIZE (100) records as a routing sample.
 *   2. Compute per-field unique_rate; pick fields with rate >= SAMPLE_THRESHOLD
 *      (0.95) as candidates.
 *   3. If no candidates → reject (no full-table fetch required, cheap exit).
 *   4. Fetch full table, verify candidates in descending sample-rate order;
 *      lock the first that reaches FULL_TABLE_THRESHOLD (1.0).
 *   5. If no candidate reaches 1.0 → reject with the failure summary so the
 *      operator can rename a field, add a composite, or mark the table
 *      non-extractable.
 *
 * Derived field types are excluded via the SCALAR_NK_FIELD_TYPES allowlist
 * — formulas, lookups, rollups, AI-text, metadata, attachments, and link
 * arrays. Per #237 Q12 rationale: a derived field's value mirrors its
 * inputs; locking it as the natural key would destabilize entity identity
 * the next time the source field changes.
 *
 * Output (per-table, per AC#5):
 *   { [table_id]: { nk_field, unique_rate, sample_size } }   // accepted
 *   { [table_id]: { nk_field: null, reason } }               // rejected
 *
 * `unique_rate` is the verified rate (1.0 for accepted entries).
 * `sample_size` is the number of records examined to reach the verdict —
 * full-table count for accepted entries, sample count for entries rejected
 * at the routing step.
 *
 * Cache placement: `~/.claude/airtable-extract-cache/<run-id>/natural-keys-<base_id>.json`.
 * Per-run (mirrors `clusters-<base_id>.json`) because NK is data-dependent
 * and changes when records mutate; skill-folder caches are reserved for
 * schema-only judgements (Stage 0 classifier).
 *
 * Stage 0 cache is REQUIRED — scanner aborts if not found. Run
 * `classify-table-type.mts <base_id>` first.
 *
 * Escalation log: stderr WARN per reject (mirrors classify-table-type.mts).
 * Reason is also embedded in the JSON output. No separate escalation file
 * is written — downstream consumers (#242 dispatcher) read the JSON.
 *
 * CLI:
 *   bun run schema-analyser.mts <base-id>
 *     Reads AIRTABLE_API_KEY (or AIRTABLE_TOKEN) from env / ~/.claude.json.
 *     Reads AIRTABLE_RUN_ID from env (default: today's UTC date suffixed
 *     with `-airtable-extract`, matching `run.mts`).
 */
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirtableTable, AirtableField } from "./classify-clusters.mts";
import type { AirtableRecord } from "./legacy-link-detector.mts";
import type { TableTypeClassification } from "./classify-table-type.mts";

export const SAMPLE_SIZE = 100;
export const SAMPLE_THRESHOLD = 0.95;
export const FULL_TABLE_THRESHOLD = 1.0;

/**
 * Allowlist of scalar source-of-truth field types eligible as natural keys.
 *
 * Excludes (by omission):
 *   - Derived: aiText, formula, rollup, lookup, multipleLookupValues, count
 *   - Metadata: createdTime, lastModifiedTime, createdBy, lastModifiedBy
 *   - Arrays / binary: multipleSelects, multipleAttachments, attachment,
 *                      multipleRecordLinks
 *   - Non-data: button
 *
 * Allowlist over denylist so newly-added Airtable field types default to
 * SAFE (excluded) instead of UNSAFE (included). Add types here only after
 * verifying the value is a scalar source-of-truth.
 */
export const SCALAR_NK_FIELD_TYPES: ReadonlySet<string> = new Set([
  "singleLineText",
  "multilineText",
  "richText",
  "email",
  "phoneNumber",
  "url",
  "number",
  "currency",
  "percent",
  "duration",
  "date",
  "dateTime",
  "singleSelect",
  "barcode",
  "autoNumber",
  "checkbox",
  "rating",
]);

export interface NkAccepted {
  nk_field: string;
  unique_rate: number;
  sample_size: number;
}

export interface NkRejected {
  nk_field: null;
  reason: string;
}

export type NkResult = NkAccepted | NkRejected;

export type NaturalKeyOutput = Record<string, NkResult>;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a field value to a comparable string. Returns null when the
 * value is missing, an empty string, or a non-scalar (defensive — array /
 * object types are already excluded by SCALAR_NK_FIELD_TYPES, but a malformed
 * record could still smuggle one in).
 */
export function normalizeValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const trimmed = v.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v) || typeof v === "object") return null;
  return String(v);
}

/**
 * unique_rate = distinct(non-null values) / count(non-null values).
 *
 * Records whose value is null/empty are excluded from BOTH numerator and
 * denominator — they neither help nor hurt uniqueness. A field where every
 * record has the same value yields 1 / N (low). A field where every record
 * has a distinct value yields N / N = 1.0. An all-empty field yields 0.
 */
export function uniqueRate(
  records: AirtableRecord[],
  fieldName: string,
): { rate: number; nonNullCount: number; distinctCount: number } {
  const seen = new Set<string>();
  let nonNullCount = 0;
  for (const r of records) {
    const v = normalizeValue((r.fields ?? {})[fieldName]);
    if (v === null) continue;
    nonNullCount += 1;
    seen.add(v);
  }
  if (nonNullCount === 0) return { rate: 0, nonNullCount: 0, distinctCount: 0 };
  return { rate: seen.size / nonNullCount, nonNullCount, distinctCount: seen.size };
}

export function isScannableField(field: AirtableField): boolean {
  return SCALAR_NK_FIELD_TYPES.has(field.type);
}

/**
 * Pick natural-key candidates from the routing sample. Returns fields whose
 * unique_rate clears SAMPLE_THRESHOLD, sorted (rate desc, name asc) so the
 * verifier tries the strongest candidate first and ordering is deterministic
 * across runs.
 */
export function pickCandidatesFromSample(
  table: AirtableTable,
  sample: AirtableRecord[],
): Array<{ field: string; rate: number }> {
  const candidates: Array<{ field: string; rate: number }> = [];
  for (const f of table.fields) {
    if (!isScannableField(f)) continue;
    const { rate } = uniqueRate(sample, f.name);
    if (rate >= SAMPLE_THRESHOLD) candidates.push({ field: f.name, rate });
  }
  candidates.sort((a, b) => {
    if (a.rate !== b.rate) return b.rate - a.rate;
    return a.field.localeCompare(b.field);
  });
  return candidates;
}

/** Verify a single candidate field on the full record set. */
export function verifyOnFullTable(
  records: AirtableRecord[],
  fieldName: string,
): { rate: number; recordCount: number } {
  const { rate, nonNullCount } = uniqueRate(records, fieldName);
  return { rate, recordCount: nonNullCount };
}

/**
 * Compose sample + full into a final NkResult.
 *
 * `full` may be the same array reference as `sample` when the table fits in
 * one API page (sample.length < SAMPLE_SIZE). When the sample is a full page,
 * the caller is expected to fetch the rest and pass a distinct array.
 */
export function analyseTable(
  table: AirtableTable,
  sample: AirtableRecord[],
  full: AirtableRecord[],
): NkResult {
  if (full.length === 0) {
    return {
      nk_field: null,
      reason: "table is empty (0 records); cannot scan for natural key",
    };
  }
  const candidates = pickCandidatesFromSample(table, sample);
  if (candidates.length === 0) {
    return {
      nk_field: null,
      reason: `no scalar field reached unique_rate >= ${SAMPLE_THRESHOLD} in sample of ${sample.length} records`,
    };
  }
  for (const cand of candidates) {
    const { rate } = verifyOnFullTable(full, cand.field);
    if (rate >= FULL_TABLE_THRESHOLD) {
      return {
        nk_field: cand.field,
        unique_rate: rate,
        sample_size: full.length,
      };
    }
  }
  const failedRates = candidates
    .map((c) => `${c.field}=sample ${c.rate.toFixed(3)}`)
    .join(", ");
  return {
    nk_field: null,
    reason: `no candidate verified at unique_rate=${FULL_TABLE_THRESHOLD} on full table of ${full.length} records (sample candidates: ${failedRates})`,
  };
}

// ---------------------------------------------------------------------------
// Token resolution + Airtable I/O
// ---------------------------------------------------------------------------

interface MetaApiTablesResponse {
  tables: AirtableTable[];
}

interface RecordsApiResponse {
  records: AirtableRecord[];
  offset?: string;
}

const META_API_BASE = "https://api.airtable.com/v0/meta/bases";
const RECORDS_API_BASE = "https://api.airtable.com/v0";

function resolveToken(
  env: Record<string, string | undefined>,
  configPath: string,
): string {
  const direct = env.AIRTABLE_API_KEY ?? env.AIRTABLE_TOKEN;
  if (direct) return direct;
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf8"));
      const fromCfg = cfg?.mcpServers?.airtable?.env?.AIRTABLE_API_KEY;
      if (typeof fromCfg === "string" && fromCfg.length > 0) return fromCfg;
    } catch {
      // fall through
    }
  }
  throw new Error(
    "AIRTABLE_API_KEY not found. Set AIRTABLE_API_KEY (or AIRTABLE_TOKEN) " +
      "in env, or configure mcpServers.airtable.env.AIRTABLE_API_KEY in ~/.claude.json.",
  );
}

async function fetchTables(
  baseId: string,
  fetchImpl: typeof globalThis.fetch,
  token: string,
): Promise<AirtableTable[]> {
  const url = `${META_API_BASE}/${encodeURIComponent(baseId)}/tables`;
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Airtable Meta API ${res.status}: ${text || res.statusText}`);
  }
  const body = (await res.json()) as MetaApiTablesResponse;
  return body.tables ?? [];
}

async function fetchSample(
  baseId: string,
  tableId: string,
  fetchImpl: typeof globalThis.fetch,
  token: string,
  pageSize: number,
): Promise<AirtableRecord[]> {
  const url = `${RECORDS_API_BASE}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}?pageSize=${pageSize}`;
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Airtable Records API ${res.status} for ${tableId}: ${text || res.statusText}`,
    );
  }
  const body = (await res.json()) as RecordsApiResponse;
  return body.records ?? [];
}

async function fetchAll(
  baseId: string,
  tableId: string,
  fetchImpl: typeof globalThis.fetch,
  token: string,
  pageSize: number,
): Promise<AirtableRecord[]> {
  const all: AirtableRecord[] = [];
  let offset: string | undefined;
  do {
    const params = new URLSearchParams({ pageSize: String(pageSize) });
    if (offset) params.set("offset", offset);
    const url = `${RECORDS_API_BASE}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}?${params.toString()}`;
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Airtable Records API ${res.status} for ${tableId}: ${text || res.statusText}`,
      );
    }
    const body = (await res.json()) as RecordsApiResponse;
    all.push(...(body.records ?? []));
    offset = body.offset;
  } while (offset);
  return all;
}

// ---------------------------------------------------------------------------
// Public glue
// ---------------------------------------------------------------------------

export interface AnalyseAllEntityTablesOptions {
  fetch?: typeof globalThis.fetch;
  env?: Record<string, string | undefined>;
  configPath?: string;
  /** Run-cache root (default: ~/.claude/airtable-extract-cache). */
  cacheDir?: string;
  /** Run id used to locate the per-run cache subdirectory. Defaults to
   *  AIRTABLE_RUN_ID env, then today's UTC date + `-airtable-extract`. */
  runId?: string;
  /** Override the Stage 0 classifier cache path. */
  classificationsCachePath?: string;
  /** Override the routing sample size. Default SAMPLE_SIZE = 100. */
  sampleSize?: number;
  warn?: (msg: string) => void;
}

export interface AnalyseAllEntityTablesResult {
  output: NaturalKeyOutput;
  cachePath: string;
}

function defaultStage0CachePath(baseId: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "cache", "table-types", `${baseId}.json`);
}

function defaultRunId(env: Record<string, string | undefined>): string {
  if (env.AIRTABLE_RUN_ID) return env.AIRTABLE_RUN_ID;
  return `${new Date().toISOString().slice(0, 10)}-airtable-extract`;
}

export async function analyseAllEntityTables(
  baseId: string,
  opts: AnalyseAllEntityTablesOptions = {},
): Promise<AnalyseAllEntityTablesResult> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const env = opts.env ?? process.env;
  const configPath = opts.configPath ?? join(homedir(), ".claude.json");
  const cacheDir =
    opts.cacheDir ?? join(homedir(), ".claude", "airtable-extract-cache");
  const runId = opts.runId ?? defaultRunId(env);
  const sampleSize = opts.sampleSize ?? SAMPLE_SIZE;
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`));

  const stage0Path = opts.classificationsCachePath ?? defaultStage0CachePath(baseId);
  if (!existsSync(stage0Path)) {
    throw new Error(
      `schema-analyser: Stage 0 classifier cache not found at ${stage0Path}. ` +
        `Run \`bun run classify-table-type.mts ${baseId}\` first.`,
    );
  }
  const classifications = JSON.parse(readFileSync(stage0Path, "utf8")) as Record<
    string,
    TableTypeClassification
  >;

  const token = resolveToken(env, configPath);
  const tables = await fetchTables(baseId, fetchImpl, token);

  const output: NaturalKeyOutput = {};

  for (const table of tables) {
    const cls = classifications[table.id];
    if (!cls || cls.type !== "entity") continue;

    const sample = await fetchSample(baseId, table.id, fetchImpl, token, sampleSize);
    const candidates = pickCandidatesFromSample(table, sample);

    let result: NkResult;
    if (sample.length === 0) {
      result = {
        nk_field: null,
        reason: "table is empty (0 records); cannot scan for natural key",
      };
    } else if (candidates.length === 0) {
      result = {
        nk_field: null,
        reason: `no scalar field reached unique_rate >= ${SAMPLE_THRESHOLD} in sample of ${sample.length} records`,
      };
    } else {
      // Sample passed routing. Fetch the rest only if the sample was a full
      // page — otherwise the sample IS the full table and refetching is
      // wasted I/O.
      const full =
        sample.length < sampleSize
          ? sample
          : await fetchAll(baseId, table.id, fetchImpl, token, sampleSize);
      result = analyseTable(table, sample, full);
    }

    output[table.id] = result;
    if (result.nk_field === null) {
      warn(
        `schema-analyser: REJECT ${table.id} (${table.name}) — ${(result as NkRejected).reason}`,
      );
    }
  }

  const runCacheDir = join(cacheDir, runId);
  mkdirSync(runCacheDir, { recursive: true });
  const cachePath = join(runCacheDir, `natural-keys-${baseId}.json`);
  writeFileSync(cachePath, JSON.stringify(output, null, 2));

  return { output, cachePath };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const baseId = process.argv[2];
  if (!baseId) {
    process.stderr.write("usage: bun run schema-analyser.mts <base-id>\n");
    process.exit(1);
  }
  try {
    const { output, cachePath } = await analyseAllEntityTables(baseId);
    process.stderr.write(`schema-analyser: wrote ${cachePath}\n`);
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`schema-analyser: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
