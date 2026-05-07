#!/usr/bin/env bun
/**
 * classify-text-field-entities.mts — Stage S5a text-field entity classifier
 * (ai-brain#251, parent #237).
 *
 * For each interaction-classified table (per Stage 0 / classify-table-type.mts),
 * runs ONE Opus call per table that inspects:
 *   - the table schema (field names + types)
 *   - up to N sample records (default 10) showing real values per text field
 *
 * and returns per-text-field:
 *   - kind ∈ {"person", "company", "none"}
 *   - role ∈ {"from-like", "to-like", "undirected", "none"}
 *   - confidence ∈ [0, 1]
 *   - reasoning (one sentence)
 *
 * Why per-table (not per-record): field semantics are a property of the column,
 * not the row. One table-level call is N× cheaper than the issue body's
 * "Sonnet call per record" sketch and gives the same information for the
 * deterministic dedup walker (S5b / extract-text-field-entities.mts).
 *
 * Why Opus directly (not Sonnet→Opus reviewer): user 2026-05-07 — "use opus
 * directly for this run to avoid sonnet stupid thing". Per-base call frequency
 * is once-per-base-per-schema-change, so the Opus token cost is trivial
 * (≈$0.05/base) and reliability dominates throughput at this volume. See
 * `feedback_opus_for_design_classifiers.md`.
 *
 * HITL audit gate: if any classified field has confidence < 0.85
 * (DEFAULT_CONFIDENCE_THRESHOLD), the classifier writes a decision-needed JSON
 * and throws `HitlPendingError` (exit 42, same export-decision-and-exit pattern
 * as `re-anchor.mts` and `self-improve.mts` per issue #232). The chat-grill
 * agent reads the needed-file, presents the ambiguous fields with sample
 * values, captures the user's decision, and writes the decision JSON. Worker
 * resumes on the next run-id replay.
 *
 * Cache:
 *   skills/airtable-knowledge-extract/cache/text-field-entities/{base_id}.json
 *
 * Like Stage 0, classification is durable across runs — keyed by
 * `schema_hash` so re-classification fires only on field add / remove /
 * rename / type change.
 *
 * NEVER use a Haiku-class model — the contract is `claude-opus-4-6` minimum
 * (`assertNotHaiku`). User preference is Opus directly; Sonnet would also be
 * accepted but invalidates the design-judgment quality bar.
 *
 * Public entry points:
 *   - `classifyTextFieldEntities(input, opts)` — single table.
 *   - `classifyAllInteractionTables(baseId, opts)` — reads Stage 0 cache,
 *     fetches schema + samples for `interaction` tables only, classifies each
 *     (or re-uses cached entries on schema_hash match), writes the cache JSON,
 *     throws `HitlPendingError` if any field below confidence threshold.
 *
 * CLI:
 *   bun run classify-text-field-entities.mts <base-id>
 */
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirtableTable, AirtableField } from "./classify-clusters.mts";
import type { AirtableRecord } from "./legacy-link-detector.mts";
import {
  computeSchemaHash,
  type TableTypeClassification,
} from "./classify-table-type.mts";
import {
  HITL_PENDING_EXIT_CODE,
  HitlPendingError,
  makeWakeToken,
} from "./hitl.mts";

export const DEFAULT_TEXT_FIELD_ENTITY_MODEL = "claude-opus-4-6";
export const DEFAULT_SAMPLE_SIZE = 10;
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.85;
export const DECISION_NEEDED_FILENAME = "text-field-entity-decision-needed.json";
export const DECISION_FILENAME = "text-field-entity-decision.json";

const META_API_BASE = "https://api.airtable.com/v0/meta/bases";
const RECORDS_API_BASE = "https://api.airtable.com/v0";

const TEXT_FIELD_TYPES = new Set([
  "singleLineText",
  "multilineText",
  "richText",
  "email",
  "phoneNumber",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TextFieldKind = "person" | "company" | "none";
export type TextFieldRole = "from-like" | "to-like" | "undirected" | "none";

export interface FieldClassification {
  kind: TextFieldKind;
  role: TextFieldRole;
  confidence: number;
  reasoning: string;
}

export interface TableTextFieldClassification {
  schema_hash: string;
  classified_at: string;
  fields: Record<string, FieldClassification>;
}

export interface ClassifyTextFieldEntitiesInput {
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

export interface ClassifyTextFieldEntitiesOptions {
  runClassifier?: ClassificationRunner;
  model?: string;
  now?: () => string;
  warn?: (msg: string) => void;
}

export interface ClassifyAllInteractionTablesOptions {
  fetch?: typeof globalThis.fetch;
  runClassifier?: ClassificationRunner;
  env?: Record<string, string | undefined>;
  configPath?: string;
  cacheBaseDir?: string;
  stage0CacheBaseDir?: string;
  hitlDir?: string;
  model?: string;
  sampleSize?: number;
  confidenceThreshold?: number;
  now?: () => string;
  warn?: (msg: string) => void;
}

export interface ClassifyAllInteractionTablesResult {
  classifications: Record<string, TableTextFieldClassification>;
  cachePath: string;
  tablesProcessed: string[];
  tablesSkippedCached: string[];
  llmCallsMade: number;
}

export interface DecisionNeededField {
  field_name: string;
  current: FieldClassification;
  sample_values: string[];
}

export interface DecisionNeededPayload {
  wake_token: string;
  base_id: string;
  table_id: string;
  table_name: string;
  schema_hash: string;
  fields_needing_review: DecisionNeededField[];
}

export interface DecisionResponse {
  decisions: Record<string, FieldClassification>;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function isTextField(f: AirtableField): boolean {
  return TEXT_FIELD_TYPES.has(f.type);
}

export function selectTextFields(table: AirtableTable): AirtableField[] {
  return table.fields.filter(isTextField);
}

function summarizeSchema(table: AirtableTable): string {
  const lines: string[] = [];
  for (const f of table.fields) {
    let line = `- ${f.name} :: ${f.type}`;
    if (f.options?.linkedTableId) {
      line += ` (links → ${f.options.linkedTableId})`;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function summarizeRecord(record: AirtableRecord, textFieldNames: string[]): string {
  const lines: string[] = [`- record ${record.id}`];
  for (const name of textFieldNames) {
    const v = record.fields?.[name];
    if (v == null || v === "") continue;
    lines.push(`  - ${name}: ${JSON.stringify(v)}`);
  }
  return lines.join("\n");
}

export function buildClassifyTextFieldEntitiesPrompt(
  input: ClassifyTextFieldEntitiesInput,
): string {
  const { table, sampleRecords } = input;
  const textFields = selectTextFields(table);
  const textFieldNames = textFields.map((f) => f.name);
  const fieldsBlock = summarizeSchema(table);
  const sampleBlock =
    sampleRecords.length === 0
      ? "(no records — empty table)"
      : sampleRecords.map((r) => summarizeRecord(r, textFieldNames)).join("\n");
  const textFieldList =
    textFieldNames.length === 0
      ? "(none — table has no text fields)"
      : textFieldNames.map((n) => `- ${n}`).join("\n");

  return `You are classifying text fields in an Airtable INTERACTION table for a knowledge-extraction pipeline.

The table itself has been classified \`interaction\` — each record is an event/edge (payment, cashflow, meeting, transaction). Some text fields (e.g. \`Payer Name\`, \`Payee Name\`, \`Salesperson\`) may carry the names of the entities (people / companies) the event connects, even when there is no separate Person or Company table to link to.

Your job: for each TEXT FIELD in this table, decide:

1. **kind**: is this field a reference to a Person, a Company, or Neither?
   - \`person\` — values are personal names (e.g. "John Doe", "Nguyễn Văn A").
   - \`company\` — values are organisation names (e.g. "Acme Corp", "Công ty XYZ").
   - \`none\` — values are descriptions, IDs, free text, statuses, dates-as-text, or anything that is NOT an entity reference.

2. **role**: how does this field relate to an edge \`from\`/\`to\`?
   - \`from-like\` — field names like Payer/Sender/Source/From/Owner/Salesperson/Initiator.
   - \`to-like\` — field names like Payee/Receiver/Target/To/Customer/Recipient.
   - \`undirected\` — Person/Company field with no clear from/to peer (e.g. \`Attendees\`, \`Contact\`, \`Lead Owner\` when there is no peer field).
   - \`none\` — only if kind == none.

3. **confidence**: 0.0–1.0. Use ≥0.90 only when the field name AND the sample values BOTH unambiguously support the choice. Use ≤0.70 when sample values are mixed or the name is ambiguous (e.g. \`Name\` could be person, company, or description).

4. **reasoning**: ONE sentence citing the field name and a sample value.

Pairing rules:
- If the table has TWO Person-classified fields with opposing role names (Payer/Payee, Sender/Receiver) → mark them \`from-like\` and \`to-like\` accordingly.
- If only ONE Person field is found → mark its role \`undirected\` (no peer).
- Three or more Person-classified fields with no clear pair → all get \`undirected\`.
- Cashflow-style \`Name\` fields whose values are transaction descriptions ("Funds received from angel investors…") → kind \`none\`, NOT \`person\`/\`company\`.

Table: ${table.name} (${table.id})

Schema (all fields, for context):
${fieldsBlock}

Text fields to classify:
${textFieldList}

Sample records (up to ${DEFAULT_SAMPLE_SIZE}, showing text-field values only):
${sampleBlock}

Return STRICT JSON, no prose, no fencing:

{
  "fields": {
    "<field_name>": {
      "kind": "person" | "company" | "none",
      "role": "from-like" | "to-like" | "undirected" | "none",
      "confidence": <number between 0 and 1>,
      "reasoning": "<one sentence>"
    },
    ...
  }
}

Include ONE entry per text field listed above, even if kind == none. Do NOT include non-text fields.
`;
}

export function parseClassifyTextFieldEntitiesResponse(text: string): {
  fields: Record<string, FieldClassification>;
} {
  let cleaned = text.trim();
  cleaned = cleaned
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/, "")
    .trim();

  const objStart = cleaned.search(/[\{\[]/);
  if (objStart < 0) {
    throw new Error(
      `classify-text-field-entities: no JSON found in response: ${text.slice(0, 200)}`,
    );
  }
  const candidate = cleaned.slice(objStart);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const trimmed = candidate.match(/^\s*\{[\s\S]*?\}\s*$/);
    if (!trimmed) {
      throw new Error(
        `classify-text-field-entities: JSON parse failed: ${text.slice(0, 200)}`,
      );
    }
    parsed = JSON.parse(trimmed[0]);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`classify-text-field-entities: response not an object`);
  }
  const obj = parsed as Record<string, unknown>;
  const fieldsRaw = obj.fields;
  if (!fieldsRaw || typeof fieldsRaw !== "object") {
    throw new Error(`classify-text-field-entities: missing or invalid 'fields' key`);
  }
  const out: Record<string, FieldClassification> = {};
  for (const [name, raw] of Object.entries(fieldsRaw as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") {
      throw new Error(
        `classify-text-field-entities: field '${name}' is not an object`,
      );
    }
    const r = raw as Record<string, unknown>;
    const kind = r.kind;
    const role = r.role;
    const confidence = r.confidence;
    const reasoning = r.reasoning;
    if (kind !== "person" && kind !== "company" && kind !== "none") {
      throw new Error(
        `classify-text-field-entities: field '${name}' has invalid kind ${JSON.stringify(kind)}`,
      );
    }
    if (
      role !== "from-like" &&
      role !== "to-like" &&
      role !== "undirected" &&
      role !== "none"
    ) {
      throw new Error(
        `classify-text-field-entities: field '${name}' has invalid role ${JSON.stringify(role)}`,
      );
    }
    if (
      typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      throw new Error(
        `classify-text-field-entities: field '${name}' has invalid confidence ${JSON.stringify(confidence)}`,
      );
    }
    if (typeof reasoning !== "string" || reasoning.length === 0) {
      throw new Error(
        `classify-text-field-entities: field '${name}' has missing/empty reasoning`,
      );
    }
    if (kind === "none" && role !== "none") {
      throw new Error(
        `classify-text-field-entities: field '${name}' has kind=none but role=${role} — must be none when kind is none`,
      );
    }
    out[name] = { kind, role, confidence, reasoning };
  }
  return { fields: out };
}

export function assertNotHaiku(model: string): void {
  if (/haiku/i.test(model)) {
    throw new Error(
      `classify-text-field-entities: refusing model ${JSON.stringify(model)} — Haiku is not capable enough; use claude-opus-4-6 or higher.`,
    );
  }
}

export function pickSampleRecords(
  records: AirtableRecord[],
  size: number = DEFAULT_SAMPLE_SIZE,
): AirtableRecord[] {
  return [...records].sort((a, b) => a.id.localeCompare(b.id)).slice(0, size);
}

export function lowConfidenceFields(
  classification: TableTextFieldClassification,
  threshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
): string[] {
  return Object.entries(classification.fields)
    .filter(([, c]) => c.confidence < threshold)
    .map(([name]) => name);
}

/**
 * Returns only field names whose classified `kind` is `person` or `company`.
 * Consumed by S5b (extract-text-field-entities) and the modified S7 emit-edges.
 */
export function entityFields(
  classification: TableTextFieldClassification,
): Array<{ name: string; kind: TextFieldKind; role: TextFieldRole }> {
  return Object.entries(classification.fields)
    .filter(([, c]) => c.kind === "person" || c.kind === "company")
    .map(([name, c]) => ({ name, kind: c.kind, role: c.role }));
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
  let model = DEFAULT_TEXT_FIELD_ENTITY_MODEL;
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
// Cache I/O
// ---------------------------------------------------------------------------

function defaultCacheBaseDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "cache", "text-field-entities");
}

function defaultStage0CacheBaseDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "cache", "table-types");
}

function readCache(
  cacheBaseDir: string,
  baseId: string,
): Record<string, TableTextFieldClassification> {
  const cachePath = join(cacheBaseDir, `${baseId}.json`);
  if (!existsSync(cachePath)) return {};
  try {
    return JSON.parse(readFileSync(cachePath, "utf8")) as Record<
      string,
      TableTextFieldClassification
    >;
  } catch {
    return {};
  }
}

function writeCache(
  cacheBaseDir: string,
  baseId: string,
  payload: Record<string, TableTextFieldClassification>,
): string {
  mkdirSync(cacheBaseDir, { recursive: true });
  const cachePath = join(cacheBaseDir, `${baseId}.json`);
  writeFileSync(cachePath, JSON.stringify(payload, null, 2));
  return cachePath;
}

function readStage0Cache(
  stage0CacheBaseDir: string,
  baseId: string,
): Record<string, TableTypeClassification> | null {
  const cachePath = join(stage0CacheBaseDir, `${baseId}.json`);
  if (!existsSync(cachePath)) return null;
  try {
    return JSON.parse(readFileSync(cachePath, "utf8")) as Record<
      string,
      TableTypeClassification
    >;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HITL helpers
// ---------------------------------------------------------------------------

function buildDecisionNeededPayload(args: {
  baseId: string;
  tableId: string;
  tableName: string;
  schemaHash: string;
  classification: TableTextFieldClassification;
  records: AirtableRecord[];
  threshold: number;
}): DecisionNeededPayload {
  const lowFields = lowConfidenceFields(args.classification, args.threshold);
  const fields_needing_review: DecisionNeededField[] = lowFields.map((name) => {
    const sampleValues: string[] = [];
    for (const r of args.records) {
      const v = r.fields?.[name];
      if (typeof v === "string" && v.length > 0) sampleValues.push(v);
      if (sampleValues.length >= 5) break;
    }
    return {
      field_name: name,
      current: args.classification.fields[name],
      sample_values: sampleValues,
    };
  });
  return {
    wake_token: makeWakeToken(),
    base_id: args.baseId,
    table_id: args.tableId,
    table_name: args.tableName,
    schema_hash: args.schemaHash,
    fields_needing_review,
  };
}

function readDecisionFile(decisionPath: string): DecisionResponse | null {
  if (!existsSync(decisionPath)) return null;
  try {
    return JSON.parse(readFileSync(decisionPath, "utf8")) as DecisionResponse;
  } catch {
    return null;
  }
}

function applyDecision(
  classification: TableTextFieldClassification,
  decision: DecisionResponse,
): TableTextFieldClassification {
  const merged: TableTextFieldClassification = {
    ...classification,
    fields: { ...classification.fields },
  };
  for (const [name, fc] of Object.entries(decision.decisions)) {
    merged.fields[name] = { ...fc, confidence: 1.0 };
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function classifyTextFieldEntities(
  input: ClassifyTextFieldEntitiesInput,
  opts: ClassifyTextFieldEntitiesOptions = {},
): Promise<TableTextFieldClassification> {
  const model = opts.model ?? DEFAULT_TEXT_FIELD_ENTITY_MODEL;
  assertNotHaiku(model);
  const runClassifier = opts.runClassifier ?? spawnClaudeClassifier;
  const now = opts.now ?? (() => new Date().toISOString());

  const textFields = selectTextFields(input.table);
  if (textFields.length === 0) {
    return {
      schema_hash: computeSchemaHash(input.table),
      classified_at: now(),
      fields: {},
    };
  }

  const prompt = buildClassifyTextFieldEntitiesPrompt(input);
  const response = await runClassifier(prompt, model);
  const parsed = parseClassifyTextFieldEntitiesResponse(response.rawText);

  for (const f of textFields) {
    if (!parsed.fields[f.name]) {
      throw new Error(
        `classify-text-field-entities: response missing classification for text field '${f.name}'`,
      );
    }
  }

  return {
    schema_hash: computeSchemaHash(input.table),
    classified_at: now(),
    fields: parsed.fields,
  };
}

export async function classifyAllInteractionTables(
  baseId: string,
  opts: ClassifyAllInteractionTablesOptions = {},
): Promise<ClassifyAllInteractionTablesResult> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const env = opts.env ?? process.env;
  const configPath = opts.configPath ?? join(homedir(), ".claude.json");
  const cacheBaseDir = opts.cacheBaseDir ?? defaultCacheBaseDir();
  const stage0CacheBaseDir =
    opts.stage0CacheBaseDir ?? defaultStage0CacheBaseDir();
  const model =
    opts.model ?? env.AIRTABLE_TEXT_FIELD_ENTITY_MODEL ?? DEFAULT_TEXT_FIELD_ENTITY_MODEL;
  const sampleSize = opts.sampleSize ?? DEFAULT_SAMPLE_SIZE;
  const threshold = opts.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const runClassifier = opts.runClassifier ?? spawnClaudeClassifier;
  const now = opts.now ?? (() => new Date().toISOString());
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`));

  assertNotHaiku(model);

  const stage0 = readStage0Cache(stage0CacheBaseDir, baseId);
  if (!stage0) {
    throw new Error(
      `classify-text-field-entities: Stage 0 cache absent for base ${baseId} — run classify-table-type.mts first`,
    );
  }
  const interactionIds = Object.entries(stage0)
    .filter(([, c]) => c.type === "interaction")
    .map(([id]) => id);

  const cached = readCache(cacheBaseDir, baseId);
  const out: Record<string, TableTextFieldClassification> = { ...cached };
  const tablesProcessed: string[] = [];
  const tablesSkippedCached: string[] = [];
  let llmCallsMade = 0;

  if (interactionIds.length === 0) {
    const cachePath = writeCache(cacheBaseDir, baseId, out);
    return {
      classifications: out,
      cachePath,
      tablesProcessed,
      tablesSkippedCached,
      llmCallsMade,
    };
  }

  const token = resolveToken(env, configPath);
  const tables = await fetchTables(baseId, fetchImpl, token);
  const wantedTables = tables.filter((t) => interactionIds.includes(t.id));

  const hitlDir =
    opts.hitlDir ??
    join(homedir(), ".claude", "airtable-extract-cache", "hitl", baseId);
  const decisionNeededPath = join(hitlDir, DECISION_NEEDED_FILENAME);
  const decisionPath = join(hitlDir, DECISION_FILENAME);

  for (const t of wantedTables) {
    const schemaHash = computeSchemaHash(t);
    const prior = cached[t.id];
    if (prior && prior.schema_hash === schemaHash) {
      tablesSkippedCached.push(t.id);
      out[t.id] = prior;
      continue;
    }

    const allRecords = await fetchSampleRecords(
      baseId,
      t.id,
      fetchImpl,
      token,
      sampleSize,
    );
    const sample = pickSampleRecords(allRecords, sampleSize);

    const classification = await classifyTextFieldEntities(
      { table: t, sampleRecords: sample },
      { runClassifier, model, now, warn },
    );
    llmCallsMade += 1;

    const lowFields = lowConfidenceFields(classification, threshold);
    if (lowFields.length > 0) {
      const decision = readDecisionFile(decisionPath);
      if (decision) {
        const merged = applyDecision(classification, decision);
        out[t.id] = merged;
        try {
          unlinkSync(decisionPath);
        } catch {
          // best-effort
        }
      } else {
        const payload = buildDecisionNeededPayload({
          baseId,
          tableId: t.id,
          tableName: t.name,
          schemaHash,
          classification,
          records: sample,
          threshold,
        });
        mkdirSync(hitlDir, { recursive: true });
        writeFileSync(decisionNeededPath, JSON.stringify(payload, null, 2));
        warn(
          `classify-text-field-entities: HITL pending — ${lowFields.length} low-confidence fields in ${t.id} (${t.name}). See ${decisionNeededPath}`,
        );
        throw new HitlPendingError([decisionNeededPath]);
      }
    } else {
      out[t.id] = classification;
    }
    tablesProcessed.push(t.id);
  }

  const cachePath = writeCache(cacheBaseDir, baseId, out);
  return {
    classifications: out,
    cachePath,
    tablesProcessed,
    tablesSkippedCached,
    llmCallsMade,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const baseId = process.argv[2];
  if (!baseId) {
    process.stderr.write("usage: bun run classify-text-field-entities.mts <base-id>\n");
    process.exit(1);
  }
  try {
    const result = await classifyAllInteractionTables(baseId);
    process.stderr.write(
      `classify-text-field-entities: ${result.tablesProcessed.length} processed, ${result.tablesSkippedCached.length} cached, ${result.llmCallsMade} LLM calls → ${result.cachePath}\n`,
    );
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (err) {
    if (err instanceof HitlPendingError) {
      process.stderr.write(`classify-text-field-entities: ${err.message}\n`);
      process.exit(HITL_PENDING_EXIT_CODE);
    }
    process.stderr.write(`classify-text-field-entities: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
