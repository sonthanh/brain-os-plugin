#!/usr/bin/env bun
/**
 * extract-record-by-record.mts — orphan-entity-table per-record extractor
 * (ai-brain#244, parent #237 AC#9).
 *
 * For an orphan-shape entity table (single-table cluster, no link fields, but
 * Stage 0 classified `entity` and the natural-key scanner accepted ≥1 field
 * with unique_rate ≥0.95), iterate records one-by-one and emit one entity
 * page per record.
 *
 * Identity is **deterministic** — never asked of the LLM:
 *   - `source_record_id` = `record.id` (Airtable native, unique per base)
 *   - `slug`              = `${slugify(nkValue)}-${slugify(record.id)}` when
 *                            the natural-key field has a value; else
 *                            `slugify(record.id)` alone.
 *                           The trailing `record.id` segment is the
 *                           collision-breaker — natural-key unique_rate is
 *                           accepted at ≥0.95, not 1.0, so two records can
 *                           share the same NK value (the Procurement
 *                           `description` field is unique_rate=0.99 in the
 *                           research data). Without baking record_id, the
 *                           second file would overwrite the first and the
 *                           AC#1 ("1 entity page per record") invariant
 *                           breaks on real input.
 *   - `type`              = `slugify(table.name)`
 *
 * Sonnet is asked ONLY for the entity body + optional supplemental
 * frontmatter. The prompt explicitly forbids returning `slug`, `type`, or
 * `source_record_id`. The response parser is doubly-defensive: if the model
 * returns those keys anyway, they are stripped before render. The tests
 * assert both the prompt-text contract and the parser-strip contract.
 *
 * Sonnet call count = N (one per record), per AC#3. The cost-meter records
 * one event per call to `<runDir>/cost-meter.jsonl` for budget tracking;
 * one outcome-log row per table run is appended to vault
 * `daily/skill-outcomes/airtable-knowledge-extract.log` for /improve
 * aggregation.
 *
 * CLI:
 *   bun run extract-record-by-record.mts <table-id>
 *     Reads AIRTABLE_BASE_ID, AIRTABLE_RUN_ID from env.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirtableTable } from "./classify-clusters.mts";
import type { AirtableRecord } from "./legacy-link-detector.mts";
import type { NaturalKeyOutput, NkAccepted } from "./schema-analyser.mts";
import { appendOutcomeLog, resolveVaultPath } from "./outcome-log.mts";

const META_API_BASE = "https://api.airtable.com/v0/meta/bases";
const RECORDS_API_BASE = "https://api.airtable.com/v0";
const DEFAULT_MODEL = "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Types — Sonnet contract
// ---------------------------------------------------------------------------

export interface SonnetUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface SonnetResponse {
  rawText: string;
  usage: SonnetUsage;
  model: string;
}

export type SonnetRunner = (
  prompt: string,
  model: string,
) => Promise<SonnetResponse>;

// ---------------------------------------------------------------------------
// Types — module entry / output
// ---------------------------------------------------------------------------

export interface ExtractRecordByRecordInput {
  baseId: string;
  tableId: string;
}

export interface PerRecordEntity {
  type: string;
  slug: string;
  source_record_id: string;
  body: string;
  frontmatter: Record<string, unknown>;
}

export interface ExtractRecordByRecordResult {
  baseId: string;
  tableId: string;
  tableName: string;
  entityType: string;
  naturalKeyField: string | null;
  recordsProcessed: number;
  entitiesEmitted: number;
  sonnetCallCount: number;
  entityPaths: string[];
  manifestPath: string;
  costMeterPath: string;
  cachedHit: boolean;
}

export interface ExtractRecordByRecordDeps {
  fetch?: typeof globalThis.fetch;
  runSonnet?: SonnetRunner;
  env?: Record<string, string | undefined>;
  configPath?: string;
  cacheDir?: string;
  runId?: string;
  /** Override the natural-keys cache path (default: per-run cache). */
  naturalKeysPath?: string;
  /** Override the Sonnet model (default: claude-sonnet-4-6). */
  model?: string;
  /** When true, append outcome-log row. Default true. */
  writeOutcomeLog?: boolean;
  /** Override vault resolution for outcome log writes. */
  vaultPath?: string;
  warn?: (msg: string) => void;
  now?: () => string;
}

// ---------------------------------------------------------------------------
// Pure helpers — slugify + identity derivation
// ---------------------------------------------------------------------------

// Letters that NFKD does NOT decompose (no combining-mark form). Vietnamese
// `đ` / `Đ` are the canonical example — NFKD leaves them as-is, so a follow-up
// translit pass is required for clean ASCII slugs (`tien-dien-…`, not
// `tien-ien-…`).
const NON_DECOMPOSABLE_TRANSLIT: Record<string, string> = {
  "đ": "d",
  "Đ": "d",
  "ð": "d",
  "Ð": "d",
  "ø": "o",
  "Ø": "o",
  "ł": "l",
  "Ł": "l",
  "ß": "ss",
};

const NON_DECOMPOSABLE_RE = new RegExp(
  Object.keys(NON_DECOMPOSABLE_TRANSLIT).join("|"),
  "g",
);

export function slugify(s: string): string {
  const base = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(NON_DECOMPOSABLE_RE, (ch) => NON_DECOMPOSABLE_TRANSLIT[ch] ?? "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return base.length > 0 ? base : "untitled";
}

export function deriveEntityType(tableName: string): string {
  return slugify(tableName);
}

/**
 * Read the natural-key value for a record, returning a normalised string when
 * the value is a non-empty scalar. Mirrors `schema-analyser.normalizeValue`'s
 * scalar contract — array / object values yield null (the NK scanner would
 * never have accepted such a field anyway).
 */
function readNkValue(
  record: AirtableRecord,
  naturalKeyField: string | null,
): string | null {
  if (!naturalKeyField) return null;
  const v = record.fields?.[naturalKeyField];
  if (v == null) return null;
  if (typeof v === "string") {
    const t = v.trim();
    return t.length === 0 ? null : t;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/**
 * Slug formula:
 *   - NK value present → `${slugify(nk)}-${slugify(record.id)}`
 *     The trailing record-id suffix breaks NK collisions (unique_rate ≥0.95
 *     accepted, so duplicates are expected — see file-header comment).
 *   - NK value absent  → `slugify(record.id)` alone.
 */
export function deriveSlug(
  record: AirtableRecord,
  naturalKeyField: string | null,
): string {
  const recIdSlug = slugify(record.id);
  const nk = readNkValue(record, naturalKeyField);
  if (nk === null) return recIdSlug;
  const nkSlug = slugify(nk);
  return `${nkSlug}-${recIdSlug}`;
}

// ---------------------------------------------------------------------------
// Pure helpers — prompt + response
// ---------------------------------------------------------------------------

function summariseRecordForPrompt(record: AirtableRecord): string {
  const lines: string[] = [`record_id: ${record.id}`];
  const entries = Object.entries(record.fields ?? {});
  if (entries.length === 0) {
    lines.push("(no fields)");
    return lines.join("\n");
  }
  for (const [k, v] of entries) {
    lines.push(`- ${k}: ${JSON.stringify(v)}`);
  }
  return lines.join("\n");
}

/**
 * Build the per-record extraction prompt.
 *
 * Contract — the prompt explicitly:
 *   - tells the model the entity TYPE (deterministic, supplied by caller)
 *   - tells the model the SOURCE_RECORD_ID + SLUG (already derived; for
 *     reference only) WITHOUT asking the model to produce them
 *   - asks ONLY for `body` + optional `frontmatter` keys
 *
 * The "do NOT produce" list is the audit anchor. The
 * `parsePerRecordResponse` parser is the second-line defence — even if the
 * model ignores the prompt and returns those keys anyway, the parser strips
 * them so identity stays caller-controlled.
 */
export function buildPerRecordPrompt(args: {
  record: AirtableRecord;
  table: AirtableTable;
  entityType: string;
  slug: string;
  naturalKeyField: string | null;
}): string {
  const { record, table, entityType, slug, naturalKeyField } = args;
  const recordBlock = summariseRecordForPrompt(record);
  const nkLine = naturalKeyField
    ? `Natural-key field (deterministic, do not echo): ${naturalKeyField}`
    : "Natural-key field: (none — slug derived from record_id)";

  return `You are summarising one Airtable record into a knowledge-vault entity page.

Entity TYPE (deterministic, supplied — do NOT echo): ${entityType}
Source record_id (deterministic, supplied — do NOT echo): ${record.id}
Slug (deterministic, already derived — do NOT echo): ${slug}
${nkLine}

Source table: ${table.name} (${table.id})

Record:
${recordBlock}

Produce ONLY the markdown body of the entity page, plus an optional small
frontmatter map of supplemental fields (e.g. tags, status). Identity fields
(slug, source_record_id, type) are derived deterministically by the caller —
do not include them in your response. If you do, they will be discarded.

Return STRICT JSON, no prose, no fencing:

{"body": "<markdown body, 1-3 short paragraphs>", "frontmatter": { ... }}

The frontmatter object MUST NOT contain the keys: slug, source_record_id,
type, source_table, base_id. Use any other key names freely.
`;
}

const FORBIDDEN_TOP_KEYS = new Set([
  "slug",
  "source_record_id",
  "type",
]);

const FORBIDDEN_FRONTMATTER_KEYS = new Set([
  "slug",
  "source_record_id",
  "type",
  "source_table",
  "base_id",
]);

/**
 * Defensive parse: extract `{body, frontmatter}` and STRIP any forbidden
 * identity keys the model returned despite the prompt. The audit test
 * verifies the prompt forbids them; this function verifies the runtime
 * cannot leak them even if the prompt is ignored.
 *
 * Lenient on shape — accepts:
 *   - `{ "body": "…", "frontmatter": {…} }`
 *   - `{ "body": "…" }`                  (frontmatter defaulted to {})
 *   - bare prose                         (treated as body, frontmatter={})
 *   - JSON wrapped in ```...``` fences
 */
export function parsePerRecordResponse(
  text: string,
): { body: string; frontmatter: Record<string, unknown> } {
  let cleaned = text.trim();
  cleaned = cleaned
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/, "")
    .trim();

  const objStart = cleaned.search(/\{/);
  if (objStart < 0) {
    return { body: cleaned, frontmatter: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(objStart));
  } catch {
    const trimmed = cleaned.slice(objStart).match(/^\s*\{[\s\S]*\}/);
    if (!trimmed) {
      return { body: cleaned, frontmatter: {} };
    }
    try {
      parsed = JSON.parse(trimmed[0]);
    } catch {
      return { body: cleaned, frontmatter: {} };
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { body: cleaned, frontmatter: {} };
  }
  const obj = parsed as Record<string, unknown>;

  // Strip forbidden top-level identity keys (model ignored the prompt).
  for (const k of FORBIDDEN_TOP_KEYS) delete obj[k];

  const body =
    typeof obj.body === "string" && obj.body.length > 0 ? obj.body : "";

  let frontmatter: Record<string, unknown> = {};
  if (
    obj.frontmatter &&
    typeof obj.frontmatter === "object" &&
    !Array.isArray(obj.frontmatter)
  ) {
    frontmatter = { ...(obj.frontmatter as Record<string, unknown>) };
    for (const k of FORBIDDEN_FRONTMATTER_KEYS) delete frontmatter[k];
  }

  return { body, frontmatter };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function yamlScalar(v: unknown): string {
  if (v == null) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return JSON.stringify(String(v));
}

export function airtableRecordUrl(
  baseId: string,
  tableId: string,
  recordId: string,
): string {
  return `https://airtable.com/${baseId}/${tableId}/${recordId}`;
}

export interface RenderEntityMarkdownArgs {
  entity: PerRecordEntity;
  baseId: string;
  tableId: string;
  tableName: string;
  extractedAt: string;
}

export function renderEntityMarkdown(args: RenderEntityMarkdownArgs): string {
  const { entity, baseId, tableId, tableName, extractedAt } = args;
  const lines: string[] = [];
  lines.push("---");
  lines.push(`type: ${entity.type}`);
  lines.push(`slug: ${entity.slug}`);
  lines.push(`base_id: ${baseId}`);
  lines.push(`source_table: ${yamlScalar(tableName)}`);
  lines.push(`source_table_id: ${tableId}`);
  lines.push(`source_record_id: ${entity.source_record_id}`);
  lines.push(
    `source_url: ${yamlScalar(airtableRecordUrl(baseId, tableId, entity.source_record_id))}`,
  );
  lines.push(`extracted_at: ${extractedAt}`);
  lines.push(`extraction_strategy: record-by-record`);
  for (const [k, v] of Object.entries(entity.frontmatter)) {
    if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${k}: []`);
      } else {
        lines.push(`${k}:`);
        for (const item of v) lines.push(`  - ${yamlScalar(item)}`);
      }
    } else if (v && typeof v === "object") {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else {
      lines.push(`${k}: ${yamlScalar(v)}`);
    }
  }
  lines.push("---");
  lines.push("");
  const body = entity.body.length > 0 ? entity.body : `(empty body for ${entity.source_record_id})`;
  lines.push(body);
  if (!body.endsWith("\n")) lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Token + Airtable I/O
// ---------------------------------------------------------------------------

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

interface MetaApiTablesResponse {
  tables: AirtableTable[];
}

interface RecordsApiResponse {
  records: AirtableRecord[];
  offset?: string;
}

async function fetchTable(
  baseId: string,
  tableId: string,
  fetchImpl: typeof globalThis.fetch,
  token: string,
): Promise<AirtableTable> {
  const url = `${META_API_BASE}/${encodeURIComponent(baseId)}/tables`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Airtable Meta API ${res.status}: ${text || res.statusText}`);
  }
  const body = (await res.json()) as MetaApiTablesResponse;
  const t = (body.tables ?? []).find((x) => x.id === tableId);
  if (!t) {
    throw new Error(
      `extract-record-by-record: table ${tableId} not found in base ${baseId}`,
    );
  }
  return t;
}

async function fetchAllRecords(
  baseId: string,
  tableId: string,
  fetchImpl: typeof globalThis.fetch,
  token: string,
): Promise<AirtableRecord[]> {
  const collected: AirtableRecord[] = [];
  let offset: string | undefined;
  do {
    const params = new URLSearchParams();
    if (offset) params.set("offset", offset);
    const qs = params.toString();
    const url =
      `${RECORDS_API_BASE}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}` +
      (qs ? `?${qs}` : "");
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Airtable Records API ${res.status} for ${tableId}: ${text || res.statusText}`,
      );
    }
    const body = (await res.json()) as RecordsApiResponse;
    collected.push(...(body.records ?? []));
    offset = body.offset;
  } while (offset);
  return collected;
}

// ---------------------------------------------------------------------------
// Cache (per-run) + NK lookup
// ---------------------------------------------------------------------------

function defaultRunId(env: Record<string, string | undefined>): string {
  if (env.AIRTABLE_RUN_ID) return env.AIRTABLE_RUN_ID;
  return `${new Date().toISOString().slice(0, 10)}-airtable-extract`;
}

function loadNaturalKeyField(
  baseId: string,
  tableId: string,
  runDir: string,
  override: string | undefined,
  warn: (msg: string) => void,
): string | null {
  const path =
    override ?? join(runDir, `natural-keys-${baseId}.json`);
  if (!existsSync(path)) {
    warn(
      `extract-record-by-record: natural-keys cache absent at ${path} — slug will fall back to record_id only`,
    );
    return null;
  }
  let parsed: NaturalKeyOutput;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as NaturalKeyOutput;
  } catch (err) {
    warn(
      `extract-record-by-record: natural-keys cache parse error (${(err as Error).message}) — falling back to record_id`,
    );
    return null;
  }
  const entry = parsed[tableId];
  if (!entry || entry.nk_field === null) {
    warn(
      `extract-record-by-record: NK rejected for ${tableId} — slug will fall back to record_id only`,
    );
    return null;
  }
  return (entry as NkAccepted).nk_field;
}

// ---------------------------------------------------------------------------
// Sonnet spawner (default runner)
// ---------------------------------------------------------------------------

function parseStreamJsonLines(lines: string[]): SonnetResponse {
  const assistantTexts: string[] = [];
  let resultText: string | null = null;
  let lastUsage: SonnetUsage | null = null;
  let model = DEFAULT_MODEL;
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
      const message = (obj as {
        message?: { content?: unknown; usage?: SonnetUsage; model?: string };
      }).message;
      if (Array.isArray(message?.content)) {
        for (const c of message.content as Array<{ type?: string; text?: string }>) {
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
      const u = (obj as { usage?: SonnetUsage }).usage;
      if (u) lastUsage = u;
    }
  }
  return {
    rawText: resultText ?? assistantTexts.join(""),
    usage: lastUsage ?? { input_tokens: 0, output_tokens: 0 },
    model,
  };
}

async function spawnClaudeSonnet(
  prompt: string,
  model: string,
): Promise<SonnetResponse> {
  const { spawn } = await import("node:child_process");
  return await new Promise<SonnetResponse>((resolve, reject) => {
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
// Public entry
// ---------------------------------------------------------------------------

export async function extractRecordByRecord(
  input: ExtractRecordByRecordInput,
  opts: ExtractRecordByRecordDeps = {},
): Promise<ExtractRecordByRecordResult> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const env = opts.env ?? process.env;
  const configPath = opts.configPath ?? join(homedir(), ".claude.json");
  const cacheDir =
    opts.cacheDir ?? join(homedir(), ".claude", "airtable-extract-cache");
  const runId = opts.runId ?? defaultRunId(env);
  const runSonnet = opts.runSonnet ?? spawnClaudeSonnet;
  const model = opts.model ?? DEFAULT_MODEL;
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`));
  const writeLog = opts.writeOutcomeLog ?? true;
  const now = opts.now ?? (() => new Date().toISOString());

  const runDir = join(cacheDir, runId);
  const outDir = join(runDir, "out");
  const recCacheDir = join(runDir, "record-by-record-cache");
  const costMeterPath = join(runDir, "cost-meter.jsonl");
  const manifestPath = join(recCacheDir, `${input.tableId}.json`);

  mkdirSync(recCacheDir, { recursive: true });

  // Idempotent cache hit — short-circuits Sonnet calls.
  if (existsSync(manifestPath)) {
    const cached = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      base_id: string;
      table_id: string;
      table_name: string;
      entity_type: string;
      natural_key_field: string | null;
      records_processed: number;
      entities_emitted: number;
      sonnet_call_count: number;
      entity_paths: string[];
    };
    return {
      baseId: cached.base_id,
      tableId: cached.table_id,
      tableName: cached.table_name,
      entityType: cached.entity_type,
      naturalKeyField: cached.natural_key_field,
      recordsProcessed: cached.records_processed,
      entitiesEmitted: cached.entities_emitted,
      sonnetCallCount: cached.sonnet_call_count,
      entityPaths: cached.entity_paths,
      manifestPath,
      costMeterPath,
      cachedHit: true,
    };
  }

  const token = resolveToken(env, configPath);
  const table = await fetchTable(input.baseId, input.tableId, fetchImpl, token);
  const records = await fetchAllRecords(
    input.baseId,
    input.tableId,
    fetchImpl,
    token,
  );

  const naturalKeyField = loadNaturalKeyField(
    input.baseId,
    input.tableId,
    runDir,
    opts.naturalKeysPath,
    warn,
  );
  const entityType = deriveEntityType(table.name);

  mkdirSync(outDir, { recursive: true });
  const entityPaths: string[] = [];
  const entities: PerRecordEntity[] = [];
  let sonnetCallCount = 0;

  for (const record of records) {
    const slug = deriveSlug(record, naturalKeyField);
    const prompt = buildPerRecordPrompt({
      record,
      table,
      entityType,
      slug,
      naturalKeyField,
    });
    const response = await runSonnet(prompt, model);
    sonnetCallCount += 1;

    const costEvent: Record<string, unknown> = {
      ts: now(),
      strategy: "record-by-record",
      base_id: input.baseId,
      table_id: input.tableId,
      record_id: record.id,
      model: response.model,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    };
    if (response.usage.cache_creation_input_tokens != null) {
      costEvent.cache_creation_input_tokens =
        response.usage.cache_creation_input_tokens;
    }
    if (response.usage.cache_read_input_tokens != null) {
      costEvent.cache_read_input_tokens = response.usage.cache_read_input_tokens;
    }
    appendFileSync(costMeterPath, `${JSON.stringify(costEvent)}\n`);

    const { body, frontmatter } = parsePerRecordResponse(response.rawText);

    const entity: PerRecordEntity = {
      type: entityType,
      slug,
      source_record_id: record.id,
      body,
      frontmatter,
    };
    entities.push(entity);

    const path = join(outDir, entityType, `${slug}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      renderEntityMarkdown({
        entity,
        baseId: input.baseId,
        tableId: input.tableId,
        tableName: table.name,
        extractedAt: now(),
      }),
    );
    entityPaths.push(path);
  }

  const manifest = {
    base_id: input.baseId,
    table_id: input.tableId,
    table_name: table.name,
    entity_type: entityType,
    natural_key_field: naturalKeyField,
    records_processed: records.length,
    entities_emitted: entities.length,
    sonnet_call_count: sonnetCallCount,
    entity_paths: entityPaths,
    extracted_at: now(),
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  if (writeLog) {
    const today = new Date().toISOString().slice(0, 10);
    const result = appendOutcomeLog(
      {
        date: today,
        skill: "airtable-knowledge-extract",
        action: "extract-record-by-record",
        source_repo: "~/work/brain-os-plugin",
        output_path: manifestPath,
        commit_hash: "none",
        result: "pass",
        fields: {
          base_id: input.baseId,
          table_id: input.tableId,
          entity_type: entityType,
          records: records.length,
          sonnet_calls: sonnetCallCount,
          strategy: "record-by-record",
        },
      },
      { vaultPath: opts.vaultPath, env },
    );
    if (!result.ok) {
      warn(`extract-record-by-record: outcome-log skipped (${result.reason})`);
    }
  }

  return {
    baseId: input.baseId,
    tableId: input.tableId,
    tableName: table.name,
    entityType,
    naturalKeyField,
    recordsProcessed: records.length,
    entitiesEmitted: entities.length,
    sonnetCallCount,
    entityPaths,
    manifestPath,
    costMeterPath,
    cachedHit: false,
  };
}

// ---------------------------------------------------------------------------
// Resolve module-source path (used by tests for the prompt-text audit).
// Exported so a sibling test can read the .mts source as a string and grep.
// ---------------------------------------------------------------------------

export function moduleSourcePath(): string {
  return fileURLToPath(import.meta.url);
}

// ---------------------------------------------------------------------------
// Outcome-log re-export (kept for callers wiring run.mts).
// ---------------------------------------------------------------------------

export { resolveVaultPath };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const tableId = process.argv[2];
  if (!tableId) {
    process.stderr.write(
      "usage: bun run extract-record-by-record.mts <table-id>\n" +
        "  env: AIRTABLE_BASE_ID (required), AIRTABLE_RUN_ID (optional)\n",
    );
    process.exit(1);
  }
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!baseId) {
    process.stderr.write(
      "extract-record-by-record: AIRTABLE_BASE_ID env var required\n",
    );
    process.exit(1);
  }
  try {
    const result = await extractRecordByRecord({ baseId, tableId });
    process.stderr.write(
      `extract-record-by-record: ${result.entitiesEmitted} entities, ${result.sonnetCallCount} Sonnet calls → ${result.manifestPath}\n`,
    );
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(
      `extract-record-by-record: ${(err as Error).message}\n`,
    );
    process.exit(1);
  }
}
