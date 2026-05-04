#!/usr/bin/env bun
/**
 * classify-table-type.mts — Stage 0 LLM table-type classifier (ai-brain#238).
 *
 * Calls a Sonnet-minimum LLM with (table name, field schema, ≤5 sample records)
 * and returns one of `entity | interaction | reject` plus a 1-line reasoning.
 * Result cached per (base_id, table_id) at
 * `skills/airtable-knowledge-extract/cache/table-types/{base_id}.json`.
 * Re-classification triggers only when `schema_hash` changes (field add/remove/
 * rename, type change, or `multipleRecordLinks` `linkedTableId` retarget).
 *
 * Why is the cache in the skill folder rather than `~/.claude/airtable-extract-
 * cache/<run-id>/`? Classification is durable across runs — the LLM verdict is
 * a property of the table schema, not a property of the extraction run. Each
 * full per-run cache would re-burn the LLM call on every invocation.
 *
 * NEVER use a Haiku-class model: the contract is `claude-sonnet-4-6` minimum
 * (per ai-brain#238 acceptance) — see `assertNotHaiku`.
 *
 * Public entry points:
 *   - `classifyTableType(input, opts)` — single table.
 *   - `classifyAllTables(baseId, opts)` — fetches all tables + samples for a
 *     base via the Airtable Meta + Records APIs, classifies each (or re-uses
 *     cached entries on schema_hash match), writes the cache JSON, returns
 *     `{ classifications, cachePath }`.
 *
 * CLI:
 *   bun run classify-table-type.mts <base-id>
 *     Reads AIRTABLE_API_KEY (or AIRTABLE_TOKEN) from env / ~/.claude.json.
 *     Optional env: AIRTABLE_TABLE_TYPE_MODEL (default `claude-sonnet-4-6`).
 *     Writes cache to ${SKILL_DIR}/cache/table-types/{base_id}.json.
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
import { createHash } from "node:crypto";
import type { AirtableTable, AirtableField } from "./classify-clusters.mts";
import type { AirtableRecord } from "./legacy-link-detector.mts";

export const DEFAULT_TABLE_TYPE_MODEL = "claude-sonnet-4-6";
export const DEFAULT_SAMPLE_SIZE = 5;
const META_API_BASE = "https://api.airtable.com/v0/meta/bases";
const RECORDS_API_BASE = "https://api.airtable.com/v0";

export type TableType = "entity" | "interaction" | "reject";

export interface TableTypeClassification {
  type: TableType;
  reasoning: string;
  schema_hash: string;
  classified_at: string;
}

export interface ClassifyTableTypeInput {
  table: AirtableTable;
  sampleRecords: AirtableRecord[];
}

export interface ClassifierUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ClassifierResponse {
  rawText: string;
  usage: ClassifierUsage;
  model: string;
}

export type ClassificationRunner = (
  prompt: string,
  model: string,
) => Promise<ClassifierResponse>;

export interface ClassifyTableTypeOptions {
  runClassifier?: ClassificationRunner;
  model?: string;
  now?: () => string;
  warn?: (msg: string) => void;
}

export interface ClassifyAllTablesOptions {
  fetch?: typeof globalThis.fetch;
  runClassifier?: ClassificationRunner;
  env?: Record<string, string | undefined>;
  configPath?: string;
  cacheBaseDir?: string;
  model?: string;
  sampleSize?: number;
  now?: () => string;
  warn?: (msg: string) => void;
}

export interface ClassifyAllTablesResult {
  classifications: Record<string, TableTypeClassification>;
  cachePath: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Stable schema hash — included in cache so re-classification fires on:
 *   - field add / remove
 *   - field rename (name change)
 *   - field type change
 *   - multipleRecordLinks linkedTableId retarget (semantic shift — entity vs
 *     interaction can flip when a link points at a different table)
 *
 * The hash is independent of field order — fields are sorted by name before
 * hashing so reorder-only schema changes don't invalidate the cache.
 */
export function computeSchemaHash(table: AirtableTable): string {
  const canon = table.fields
    .map((f) => ({
      name: f.name,
      type: f.type,
      linkedTableId: f.options?.linkedTableId ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const json = JSON.stringify(canon);
  return createHash("sha256").update(json).digest("hex");
}

function summarizeSampleRecord(record: AirtableRecord): string {
  const lines: string[] = [`- record ${record.id}`];
  for (const [k, v] of Object.entries(record.fields ?? {})) {
    lines.push(`  - ${k}: ${JSON.stringify(v)}`);
  }
  return lines.join("\n");
}

function summarizeFields(fields: AirtableField[]): string {
  const lines: string[] = [];
  for (const f of fields) {
    let line = `- ${f.name} :: ${f.type}`;
    if (f.options?.linkedTableId) {
      line += ` (links → ${f.options.linkedTableId})`;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

export function buildClassificationPrompt(input: ClassifyTableTypeInput): string {
  const { table, sampleRecords } = input;
  const fieldsBlock = summarizeFields(table.fields);
  const sampleBlock =
    sampleRecords.length === 0
      ? "(no records — empty table)"
      : sampleRecords.map(summarizeSampleRecord).join("\n");

  return `You are classifying an Airtable table for a knowledge-extraction pipeline.

Choose ONE of three categories:

- **entity**: each record is a unique thing (person, company, project, decision,
  product, OKR, knowledge note, ...). The record itself is the noun. Records
  link to other entities via record-link fields. Extract → vault entity page,
  one page per record.
- **interaction**: each record is an event or edge connecting other entities
  (payments, cashflows, meetings, transactions, sales activities, log events,
  PnL reports, invoices). The record itself is a verb / fact / number. Extract
  → JSONL edge entry in knowledge/graph/edges.jsonl, NOT a vault page. Records
  in interaction tables tend to repeat names (same payer makes 5 payments) and
  carry timestamps + amounts.
- **reject**: the table is not extractable. Use this when:
   - There is no field with high uniqueness (no usable natural key).
   - Primary field is a composite (e.g. \`Personal Name/Company Name\`).
   - The table is a sandbox / scratch / "untitled" table with no clear domain.
   - Sample is empty or all-blank and the schema gives no signal.
  Provide a one-sentence reason for the reject.

Heuristics for entity vs interaction:
- A field named \`Date\` or \`Timestamp\` plus low uniqueness on the primary
  field is a strong interaction signal.
- A field named \`Amount\`, \`Inflow\`, \`Outflow\`, \`Currency\`, \`Net\`, or
  similar money/numeric primary signal is interaction.
- Two or more record-link fields pointing at distinct entity-ish tables
  (\`From Account\` + \`To Account\`, \`Payer\` + \`Payee\`, \`Lead\` + \`Owner\`)
  is interaction.
- A unique slug-ready primary (\`Reference Number\`, \`Invoice Number\`,
  \`Txn ID\`) does not by itself flip the verdict to entity — money / event
  records are still interactions.

Table: ${table.name} (${table.id})

Schema:
${fieldsBlock}

Sample records (up to ${DEFAULT_SAMPLE_SIZE}):
${sampleBlock}

Return STRICT JSON with two keys, no prose, no fencing:

{"type": "entity" | "interaction" | "reject", "reasoning": "<one sentence>"}
`;
}

export function parseClassificationResponse(text: string): {
  type: TableType;
  reasoning: string;
} {
  let cleaned = text.trim();
  cleaned = cleaned
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/, "")
    .trim();

  const objStart = cleaned.search(/[\{\[]/);
  if (objStart < 0) {
    throw new Error(`classify-table-type: no JSON found in response: ${text.slice(0, 200)}`);
  }
  const candidate = cleaned.slice(objStart);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    // Try truncating after the first balanced JSON object.
    const trimmed = candidate.match(/^\s*\{[\s\S]*?\}/);
    if (!trimmed) {
      throw new Error(`classify-table-type: JSON parse failed: ${text.slice(0, 200)}`);
    }
    parsed = JSON.parse(trimmed[0]);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`classify-table-type: response not an object`);
  }
  const obj = parsed as Record<string, unknown>;
  const type = obj.type;
  const reasoning = obj.reasoning;
  if (type !== "entity" && type !== "interaction" && type !== "reject") {
    throw new Error(
      `classify-table-type: invalid type ${JSON.stringify(type)} — must be entity|interaction|reject`,
    );
  }
  if (typeof reasoning !== "string" || reasoning.length === 0) {
    throw new Error(`classify-table-type: missing or empty 'reasoning'`);
  }
  return { type, reasoning };
}

export function assertNotHaiku(model: string): void {
  if (/haiku/i.test(model)) {
    throw new Error(
      `classify-table-type: refusing model ${JSON.stringify(model)} — Haiku is not capable enough; use claude-sonnet-4-6 or higher (per ai-brain#238 AC#1).`,
    );
  }
}

export function pickSampleRecords(
  records: AirtableRecord[],
  size: number = DEFAULT_SAMPLE_SIZE,
): AirtableRecord[] {
  return [...records].sort((a, b) => a.id.localeCompare(b.id)).slice(0, size);
}

/**
 * Downstream-pipeline gate (ai-brain#238 AC#5). The dispatcher (#242) calls
 * this on the classifyAllTables result to drop reject tables before routing.
 * Returned in input order so callers can preserve any external ordering.
 */
export function filterAcceptedTableIds(
  classifications: Record<string, TableTypeClassification>,
): string[] {
  return Object.entries(classifications)
    .filter(([, c]) => c.type !== "reject")
    .map(([id]) => id);
}

// ---------------------------------------------------------------------------
// Token resolution + Airtable I/O
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

async function fetchSampleRecords(
  baseId: string,
  tableId: string,
  fetchImpl: typeof globalThis.fetch,
  token: string,
  sampleSize: number,
): Promise<AirtableRecord[]> {
  const url = `${RECORDS_API_BASE}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}?pageSize=${Math.max(sampleSize * 4, 10)}`;
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

// ---------------------------------------------------------------------------
// Default LLM runner — spawns `claude -p --model <X> --output-format=stream-json`
// ---------------------------------------------------------------------------

interface StreamJsonAssistantMessage {
  message?: {
    content?: Array<{ type?: string; text?: string }>;
    usage?: ClassifierUsage;
    model?: string;
  };
}

function parseStreamJsonLines(lines: string[]): ClassifierResponse {
  const assistantTexts: string[] = [];
  let resultText: string | null = null;
  let lastUsage: ClassifierUsage | null = null;
  let model = DEFAULT_TABLE_TYPE_MODEL;
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = (obj as { type?: string }).type;
    if (type === "system") {
      const m = (obj as { model?: string }).model;
      if (typeof m === "string") model = m;
    } else if (type === "assistant") {
      const message = (obj as StreamJsonAssistantMessage).message;
      if (Array.isArray(message?.content)) {
        for (const c of message.content) {
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
      const u = (obj as { usage?: ClassifierUsage }).usage;
      if (u) lastUsage = u;
    }
  }
  return {
    rawText: resultText ?? assistantTexts.join(""),
    usage: lastUsage ?? { input_tokens: 0, output_tokens: 0 },
    model,
  };
}

async function spawnClaudeClassifier(
  prompt: string,
  model: string,
): Promise<ClassifierResponse> {
  const { spawn } = await import("node:child_process");
  return await new Promise<ClassifierResponse>((resolve, reject) => {
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
// Public API
// ---------------------------------------------------------------------------

export async function classifyTableType(
  input: ClassifyTableTypeInput,
  opts: ClassifyTableTypeOptions = {},
): Promise<TableTypeClassification> {
  const model = opts.model ?? DEFAULT_TABLE_TYPE_MODEL;
  assertNotHaiku(model);
  const runClassifier = opts.runClassifier ?? spawnClaudeClassifier;
  const now = opts.now ?? (() => new Date().toISOString());
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`));

  const prompt = buildClassificationPrompt(input);
  const response = await runClassifier(prompt, model);
  const parsed = parseClassificationResponse(response.rawText);

  const classification: TableTypeClassification = {
    type: parsed.type,
    reasoning: parsed.reasoning,
    schema_hash: computeSchemaHash(input.table),
    classified_at: now(),
  };

  if (classification.type === "reject") {
    warn(
      `classify-table-type: REJECT ${input.table.id} (${input.table.name}) — ${classification.reasoning}`,
    );
  }
  return classification;
}

function defaultCacheBaseDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // scripts/classify-table-type.mts → skill root → cache/table-types
  return join(here, "..", "cache", "table-types");
}

export async function classifyAllTables(
  baseId: string,
  opts: ClassifyAllTablesOptions = {},
): Promise<ClassifyAllTablesResult> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const env = opts.env ?? process.env;
  const configPath = opts.configPath ?? join(homedir(), ".claude.json");
  const cacheBaseDir = opts.cacheBaseDir ?? defaultCacheBaseDir();
  const model = opts.model ?? env.AIRTABLE_TABLE_TYPE_MODEL ?? DEFAULT_TABLE_TYPE_MODEL;
  const sampleSize = opts.sampleSize ?? DEFAULT_SAMPLE_SIZE;
  const runClassifier = opts.runClassifier ?? spawnClaudeClassifier;
  const now = opts.now ?? (() => new Date().toISOString());
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`));

  assertNotHaiku(model);

  const token = resolveToken(env, configPath);
  const tables = await fetchTables(baseId, fetchImpl, token);

  mkdirSync(cacheBaseDir, { recursive: true });
  const cachePath = join(cacheBaseDir, `${baseId}.json`);
  let cache: Record<string, TableTypeClassification> = {};
  if (existsSync(cachePath)) {
    try {
      cache = JSON.parse(readFileSync(cachePath, "utf8"));
    } catch (err) {
      warn(
        `classify-table-type: cache at ${cachePath} unreadable (${(err as Error).message}); re-classifying`,
      );
      cache = {};
    }
  }

  const out: Record<string, TableTypeClassification> = {};
  for (const table of tables) {
    const schemaHash = computeSchemaHash(table);
    const cached = cache[table.id];
    if (cached && cached.schema_hash === schemaHash) {
      out[table.id] = cached;
      if (cached.type === "reject") {
        warn(
          `classify-table-type: REJECT (cached) ${table.id} (${table.name}) — ${cached.reasoning}`,
        );
      }
      continue;
    }
    const records = await fetchSampleRecords(
      baseId,
      table.id,
      fetchImpl,
      token,
      sampleSize,
    );
    const sampleRecords = pickSampleRecords(records, sampleSize);
    const classification = await classifyTableType(
      { table, sampleRecords },
      { runClassifier, model, now, warn },
    );
    out[table.id] = classification;
  }

  writeFileSync(cachePath, JSON.stringify(out, null, 2));
  return { classifications: out, cachePath };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const baseId = process.argv[2];
  if (!baseId) {
    process.stderr.write("usage: bun run classify-table-type.mts <base-id>\n");
    process.exit(1);
  }
  try {
    const { classifications, cachePath } = await classifyAllTables(baseId);
    process.stderr.write(`classify-table-type: wrote ${cachePath}\n`);
    process.stdout.write(JSON.stringify(classifications, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`classify-table-type: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
