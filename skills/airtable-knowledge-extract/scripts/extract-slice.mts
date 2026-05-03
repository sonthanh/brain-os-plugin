#!/usr/bin/env bun
/**
 * extract-slice.mts — C6 Phase-1 vertical-slice extractor.
 *
 * Sonnet worker. Input: `{baseId, clusterId, clusterType, tableIds, seedRecordId}`.
 *
 * 1. Fetches the cluster's full record subgraph from Airtable (Meta + Records APIs).
 * 2. BFS-traverses from the seed; truncates at `clusterContextBudget` (default 100K
 *    tokens estimated as chars/4) when the cluster is too large to fit in one prompt.
 * 3. Loads `prompts/extract.md`, picks the variant matching `clusterType`, substitutes
 *    `{{seed_record_id}}`, `{{cluster_id}}`, `{{subgraph}}`.
 * 4. Invokes Sonnet via the injectable `runSonnet` runner (default = spawn `claude -p
 *    --model … --output-format=stream-json --verbose`). Parses the stream-json output
 *    for accumulated assistant text and final usage.
 * 5. Writes one entity Markdown file per `entities[]` item to
 *    `<runDir>/out/<entity-type>/<slug>.md` with `sources:` + `base_id:` +
 *    `cluster_id:` frontmatter.
 * 6. Appends one cost-meter event to `<runDir>/cost-meter.jsonl` (the format
 *    `guard.mts` polls).
 * 7. Caches the result to `<runDir>/slice-cache/<seedRecordId>.json` for idempotent
 *    re-runs.
 *
 * CLI: `bun run extract-slice.mts <seed-id>`
 *   Reads `AIRTABLE_BASE_ID`, `AIRTABLE_CLUSTER_ID`, `AIRTABLE_CLUSTER_TYPE`,
 *   `AIRTABLE_TABLE_IDS` (comma-separated), `AIRTABLE_RUN_ID` from env. Outputs the
 *   ExtractSliceResult JSON to stdout.
 */
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  appendFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirtableTable } from "./classify-clusters.mts";
import type { AirtableRecord } from "./legacy-link-detector.mts";

export const CLUSTER_CONTEXT_BUDGET = 100_000;
const META_API_BASE = "https://api.airtable.com/v0/meta/bases";
const RECORDS_API_BASE = "https://api.airtable.com/v0";
const CHARS_PER_TOKEN = 4;
const DEFAULT_MODEL = "claude-sonnet-4-6";

export type ClusterType =
  | "crm"
  | "okr"
  | "decision"
  | "project"
  | "knowledge-note"
  | "orphan";

export interface ExtractSliceInput {
  baseId: string;
  clusterId: string;
  clusterType: ClusterType;
  tableIds: string[];
  seedRecordId: string;
}

export interface ExtractedEntity {
  type: string;
  slug: string;
  frontmatter?: Record<string, unknown>;
  body: string;
  source_record_ids: string[];
}

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

export interface ExtractSliceDeps {
  fetch?: typeof globalThis.fetch;
  runSonnet?: SonnetRunner;
  env?: Record<string, string | undefined>;
  configPath?: string;
  cacheDir?: string;
  runId?: string;
  promptsPath?: string;
  clusterContextBudget?: number;
  now?: () => string;
  warn?: (msg: string) => void;
}

export interface ExtractSliceResult {
  entities: ExtractedEntity[];
  entityPaths: string[];
  truncated: boolean;
  truncationReason: string | null;
  estimatedPromptTokens: number;
  cachedHit: boolean;
  costMeterPath: string;
  manifestPath: string;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit-test access
// ---------------------------------------------------------------------------

export function estimateTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

export function slugify(s: string): string {
  const base = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return base.length > 0 ? base : "untitled";
}

export function parsePromptVariants(content: string): Map<string, string> {
  const out = new Map<string, string>();
  const headerRe = /^##\s+([a-z0-9-]+)\s*$/i;
  let cur: string | null = null;
  let buf: string[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(headerRe);
    if (m) {
      if (cur !== null) out.set(cur, buf.join("\n").trim());
      cur = m[1].toLowerCase();
      buf = [];
    } else if (cur !== null) {
      buf.push(line);
    }
  }
  if (cur !== null) out.set(cur, buf.join("\n").trim());
  return out;
}

export function renderPrompt(
  template: string,
  ctx: {
    clusterType: string;
    clusterId: string;
    seedRecordId: string;
    subgraph: string;
  },
): string {
  return template
    .replace(/\{\{seed_record_id\}\}/g, ctx.seedRecordId)
    .replace(/\{\{cluster_id\}\}/g, ctx.clusterId)
    .replace(/\{\{cluster_type\}\}/g, ctx.clusterType)
    .replace(/\{\{subgraph\}\}/g, ctx.subgraph);
}

export interface RecordLink {
  fromRecordId: string;
  fromField: string;
  toRecordId: string;
  toTableId: string;
}

export function extractRecordLinks(
  records: AirtableRecord[],
  _tableId: string,
  table: AirtableTable,
): RecordLink[] {
  const links: RecordLink[] = [];
  for (const r of records) {
    for (const f of table.fields) {
      if (f.type !== "multipleRecordLinks") continue;
      const targetTableId = f.options?.linkedTableId;
      if (!targetTableId) continue;
      const v = r.fields[f.name];
      if (!Array.isArray(v)) continue;
      for (const linkedId of v) {
        if (typeof linkedId !== "string") continue;
        links.push({
          fromRecordId: r.id,
          fromField: f.name,
          toRecordId: linkedId,
          toTableId: targetTableId,
        });
      }
    }
  }
  return links;
}

export interface BFSResult {
  keptRecordIds: Set<string>;
  truncated: boolean;
  reason: string | null;
  estimatedTokens: number;
}

export function bfsFromSeed(
  seedId: string,
  recordsById: Map<string, AirtableRecord>,
  links: RecordLink[],
  budgetTokens: number,
): BFSResult {
  if (!recordsById.has(seedId)) {
    return {
      keptRecordIds: new Set(),
      truncated: false,
      reason: `seed ${seedId} not in cluster records`,
      estimatedTokens: 0,
    };
  }
  const adj = new Map<string, Set<string>>();
  const ensure = (id: string) => {
    if (!adj.has(id)) adj.set(id, new Set());
    return adj.get(id)!;
  };
  for (const l of links) {
    ensure(l.fromRecordId).add(l.toRecordId);
    ensure(l.toRecordId).add(l.fromRecordId);
  }

  const queue: string[] = [seedId];
  const queued = new Set<string>([seedId]);
  const kept = new Set<string>();
  let tokens = 0;
  let truncated = false;
  let reason: string | null = null;

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (kept.has(id)) continue;
    const rec = recordsById.get(id);
    if (!rec) continue;
    const recTokens = estimateTokens(JSON.stringify(rec));
    if (tokens + recTokens > budgetTokens && kept.size > 0) {
      truncated = true;
      reason = `budget ${budgetTokens} exceeded; kept ${kept.size} of ${recordsById.size} records`;
      break;
    }
    kept.add(id);
    tokens += recTokens;
    for (const neighbor of adj.get(id) ?? []) {
      if (kept.has(neighbor) || queued.has(neighbor)) continue;
      queue.push(neighbor);
      queued.add(neighbor);
    }
  }
  return { keptRecordIds: kept, truncated, reason, estimatedTokens: tokens };
}

export function airtableRecordUrl(
  baseId: string,
  tableId: string,
  recordId: string,
): string {
  return `https://airtable.com/${baseId}/${tableId}/${recordId}`;
}

export interface AiFieldEntry {
  field: string;
  value: string;
}

export function extractAiFields(
  record: AirtableRecord,
  table: AirtableTable,
): AiFieldEntry[] {
  const out: AiFieldEntry[] = [];
  for (const f of table.fields) {
    if (f.type !== "aiText") continue;
    const v = record.fields[f.name];
    let str: string | null = null;
    if (typeof v === "string") {
      str = v;
    } else if (v && typeof v === "object") {
      const candidate = (v as { value?: unknown }).value;
      if (typeof candidate === "string") str = candidate;
    }
    if (str !== null && str.length > 0) {
      out.push({ field: f.name, value: str });
    }
  }
  return out;
}

export interface AttachmentSummary {
  count: number;
  firstUrl: string | null;
}

export function extractAttachments(
  record: AirtableRecord,
  table: AirtableTable,
): AttachmentSummary {
  let count = 0;
  let firstUrl: string | null = null;
  for (const f of table.fields) {
    if (f.type !== "multipleAttachments") continue;
    const v = record.fields[f.name];
    if (!Array.isArray(v)) continue;
    for (const att of v) {
      if (att && typeof att === "object" && typeof (att as { url?: unknown }).url === "string") {
        count += 1;
        if (firstUrl === null) firstUrl = (att as { url: string }).url;
      }
    }
  }
  return { count, firstUrl };
}

export interface RelatedLink {
  slug: string;
  recordId: string;
  tableName: string;
}

export function buildSlugMap(entities: ExtractedEntity[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of entities) {
    for (const rid of e.source_record_ids) {
      if (!m.has(rid)) m.set(rid, e.slug);
    }
  }
  return m;
}

export function findRelatedWikilinks(
  entity: ExtractedEntity,
  recordsById: Map<string, AirtableRecord>,
  recordToTable: Map<string, string>,
  tablesById: Map<string, AirtableTable>,
  slugMap: Map<string, string>,
): RelatedLink[] {
  const out: RelatedLink[] = [];
  const seen = new Set<string>();
  for (const recId of entity.source_record_ids) {
    const rec = recordsById.get(recId);
    if (!rec) continue;
    const tableId = recordToTable.get(recId);
    if (!tableId) continue;
    const table = tablesById.get(tableId);
    if (!table) continue;
    for (const f of table.fields) {
      if (f.type !== "multipleRecordLinks") continue;
      const v = rec.fields[f.name];
      if (!Array.isArray(v)) continue;
      for (const linkedId of v) {
        if (typeof linkedId !== "string") continue;
        const slug = slugMap.get(linkedId);
        if (!slug) continue;
        if (slug === entity.slug) continue;
        if (seen.has(slug)) continue;
        seen.add(slug);
        const linkedTableId = recordToTable.get(linkedId) ?? "";
        const linkedTableName = tablesById.get(linkedTableId)?.name ?? linkedTableId;
        out.push({ slug, recordId: linkedId, tableName: linkedTableName });
      }
    }
  }
  return out;
}

export type ReverseLookupReason = "match" | "no-match" | "ambiguous";

export interface ReverseLookupResult {
  recordId: string | null;
  reason: ReverseLookupReason;
  candidates?: string[];
}

export class SliceRejectedError extends Error {
  readonly entity: ExtractedEntity;
  readonly reason: ReverseLookupReason;
  readonly candidates?: string[];
  constructor(entity: ExtractedEntity, lookup: ReverseLookupResult) {
    const desc =
      lookup.reason === "ambiguous"
        ? `ambiguous (candidates: ${(lookup.candidates ?? []).join(", ")})`
        : "no-match";
    super(
      `extract-slice: entity '${entity.slug}' (type=${entity.type}) reverse-lookup ${desc}`,
    );
    this.name = "SliceRejectedError";
    this.entity = entity;
    this.reason = lookup.reason;
    this.candidates = lookup.candidates;
  }
}

function recordSlugCandidates(
  rec: AirtableRecord,
  table: AirtableTable,
  entityType: string,
): Set<string> {
  const out = new Set<string>();
  const fieldNames = new Set<string>();
  const primary = table.fields[0]?.name;
  if (primary) fieldNames.add(primary);
  fieldNames.add("Name");
  for (const fname of fieldNames) {
    const v = rec.fields[fname];
    if (typeof v !== "string" || v.length === 0) continue;
    out.add(slugify(v));
    if (entityType.length > 0) out.add(slugify(`${entityType}-${v}`));
  }
  return out;
}

export function findSourceRecordByEntity(
  entity: ExtractedEntity,
  recordsById: Map<string, AirtableRecord>,
  recordToTable: Map<string, string>,
  tablesById: Map<string, AirtableTable>,
): ReverseLookupResult {
  const matches: string[] = [];
  for (const [recId, rec] of recordsById) {
    const tableId = recordToTable.get(recId);
    if (!tableId) continue;
    const table = tablesById.get(tableId);
    if (!table) continue;
    if (recordSlugCandidates(rec, table, entity.type).has(entity.slug)) {
      matches.push(recId);
    }
  }
  if (matches.length === 0) return { recordId: null, reason: "no-match" };
  if (matches.length > 1) {
    return { recordId: null, reason: "ambiguous", candidates: matches };
  }
  return { recordId: matches[0], reason: "match" };
}

export function resolveEntitySourceIds(
  entity: ExtractedEntity,
  recordsById: Map<string, AirtableRecord>,
  recordToTable: Map<string, string>,
  tablesById: Map<string, AirtableTable>,
  _seedRecordId: string,
  warn: (msg: string) => void,
): string[] {
  const dropped = entity.source_record_ids.filter((id) => !recordsById.has(id));
  if (dropped.length > 0) {
    warn(
      `extract-slice: entity '${entity.slug}' had hallucinated source IDs ${JSON.stringify(dropped)} — dropped`,
    );
  }
  const lookup = findSourceRecordByEntity(entity, recordsById, recordToTable, tablesById);
  if (lookup.reason === "match" && lookup.recordId) {
    return [lookup.recordId];
  }
  throw new SliceRejectedError(entity, lookup);
}

function writeEscalationMd(
  runDir: string,
  input: ExtractSliceInput,
  err: SliceRejectedError,
): void {
  const lines = [
    `# Slice rejected: ${input.baseId} / ${input.clusterId}`,
    "",
    `- Seed record: \`${input.seedRecordId}\``,
    `- Cluster type: ${input.clusterType}`,
    `- Tables: ${input.tableIds.map((t) => `\`${t}\``).join(", ")}`,
    "",
    `## Reason`,
    "",
    `Entity \`${err.entity.slug}\` (type=\`${err.entity.type}\`) failed reverse-lookup: **${err.reason}**.`,
  ];
  if (err.reason === "ambiguous" && err.candidates && err.candidates.length > 0) {
    lines.push("");
    lines.push(
      `Candidates: ${err.candidates.map((c) => `\`${c}\``).join(", ")}`,
    );
  }
  lines.push("");
  lines.push("## Next steps");
  lines.push("");
  lines.push(
    "- Inspect the entity slug — it must equal `slugify(<primary-field-value>)` or `slugify(<type>-<primary-field-value>)` for some record in the cluster.",
  );
  lines.push(
    "- If the target record is missing from the slice, regenerate the cluster or expand `tableIds`.",
  );
  lines.push(
    "- If multiple records share the natural key, disambiguate (rename one) before re-running.",
  );
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "escalation.md"), lines.join("\n") + "\n");
}

export function buildSubgraphContext(
  recordsById: Map<string, AirtableRecord>,
  keptIds: Set<string>,
  tablesById: Map<string, AirtableTable>,
  recordToTable: Map<string, string>,
): string {
  const grouped = new Map<string, string[]>();
  for (const id of keptIds) {
    const tableId = recordToTable.get(id) ?? "unknown";
    if (!grouped.has(tableId)) grouped.set(tableId, []);
    grouped.get(tableId)!.push(id);
  }
  const lines: string[] = [];
  const tableIds = [...grouped.keys()].sort();
  for (const tableId of tableIds) {
    const tableName = tablesById.get(tableId)?.name ?? tableId;
    lines.push(`### ${tableName} (${tableId})`);
    lines.push("");
    for (const id of grouped.get(tableId)!) {
      const rec = recordsById.get(id);
      if (!rec) continue;
      lines.push(`- record ${id}`);
      for (const [k, v] of Object.entries(rec.fields ?? {})) {
        lines.push(`  - ${k}: ${JSON.stringify(v)}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function parseStreamJsonLines(lines: string[]): SonnetResponse {
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
      const message = (obj as { message?: { content?: unknown; usage?: SonnetUsage; model?: string } }).message;
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

export function parseSonnetEntityResponse(text: string): ExtractedEntity[] {
  let cleaned = text.trim();
  cleaned = cleaned
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/, "")
    .trim();

  const objStart = cleaned.search(/[\{\[]/);
  if (objStart < 0) {
    throw new Error(`Sonnet output: no JSON object/array found in response`);
  }
  const candidate = cleaned.slice(objStart);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    throw new Error(`Sonnet output: JSON parse failed: ${(err as Error).message}`);
  }

  let entities: unknown;
  if (Array.isArray(parsed)) {
    entities = parsed;
  } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { entities?: unknown }).entities)) {
    entities = (parsed as { entities: unknown }).entities;
  } else {
    throw new Error("Sonnet output: expected {entities:[...]} or [...]");
  }

  const arr = entities as unknown[];
  for (const e of arr) {
    const ee = e as Partial<ExtractedEntity>;
    if (typeof ee?.type !== "string" || ee.type.length === 0) {
      throw new Error("Sonnet output: entity missing 'type'");
    }
    if (typeof ee?.slug !== "string" || ee.slug.length === 0) {
      throw new Error("Sonnet output: entity missing 'slug'");
    }
    if (typeof ee?.body !== "string") {
      throw new Error("Sonnet output: entity missing 'body'");
    }
    if (!Array.isArray(ee?.source_record_ids)) {
      // Lenient — caller backfills from seedRecordId. See ai-brain#230.
      ee.source_record_ids = [];
    }
  }
  return arr as ExtractedEntity[];
}

// ---------------------------------------------------------------------------
// I/O — Airtable + Sonnet + entity Markdown render
// ---------------------------------------------------------------------------

interface MetaApiTablesResponse {
  tables: AirtableTable[];
}

interface RecordsApiResponse {
  records: AirtableRecord[];
  offset?: string;
}

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

async function fetchAllRecords(
  baseId: string,
  tableId: string,
  token: string,
  fetchImpl: typeof globalThis.fetch,
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
      throw new Error(`Airtable Records API ${res.status}: ${text || res.statusText}`);
    }
    const body = (await res.json()) as RecordsApiResponse;
    collected.push(...(body.records ?? []));
    offset = body.offset;
  } while (offset);
  return collected;
}

function yamlScalar(v: unknown): string {
  if (v == null) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return JSON.stringify(String(v));
}

export interface EntityRenderExtras {
  source_record_id: string;
  source_table: string | null;
  source_url: string | null;
  ai_fields: AiFieldEntry[];
  attachments_count: number;
  first_attachment_url: string | null;
  related_links: RelatedLink[];
}

function appendRelatedSection(body: string, links: RelatedLink[]): string {
  const newLinks = links.filter((l) => !body.includes(`[[${l.slug}]]`));
  if (newLinks.length === 0) return body;
  const trailing = body.endsWith("\n") ? "" : "\n";
  const lines = ["", "## Related", ""];
  for (const l of newLinks) {
    lines.push(`- [[${l.slug}]] (${l.tableName} \`${l.recordId}\`)`);
  }
  return `${body}${trailing}${lines.join("\n")}\n`;
}

function renderEntityMarkdown(
  e: ExtractedEntity,
  input: ExtractSliceInput,
  ts: string,
  extras: EntityRenderExtras,
): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`type: ${e.type}`);
  lines.push(`slug: ${e.slug}`);
  lines.push(`base_id: ${input.baseId}`);
  lines.push(`cluster_id: ${input.clusterId}`);
  lines.push(`cluster_type: ${input.clusterType}`);
  lines.push(`seed_record_id: ${input.seedRecordId}`);
  lines.push(`source_record_id: ${extras.source_record_id}`);
  if (extras.source_table) {
    lines.push(`source_table: ${yamlScalar(extras.source_table)}`);
  }
  if (extras.source_url) {
    lines.push(`source_url: ${yamlScalar(extras.source_url)}`);
  }
  lines.push(`extracted_at: ${ts}`);
  lines.push(`sources:`);
  for (const rid of e.source_record_ids) {
    lines.push(`  - ${rid}`);
  }
  if (extras.ai_fields.length > 0) {
    lines.push("ai_fields:");
    for (const f of extras.ai_fields) {
      lines.push(`  - field: ${yamlScalar(f.field)}`);
      lines.push(`    value: ${yamlScalar(f.value)}`);
    }
  }
  if (extras.attachments_count > 0) {
    lines.push(`attachments_count: ${extras.attachments_count}`);
    if (extras.first_attachment_url) {
      lines.push(`first_attachment_url: ${yamlScalar(extras.first_attachment_url)}`);
    }
  }
  if (e.frontmatter) {
    for (const [k, v] of Object.entries(e.frontmatter)) {
      if (Array.isArray(v)) {
        if (v.length === 0) {
          lines.push(`${k}: []`);
        } else {
          lines.push(`${k}:`);
          for (const item of v) lines.push(`  - ${yamlScalar(item)}`);
        }
      } else {
        lines.push(`${k}: ${yamlScalar(v)}`);
      }
    }
  }
  lines.push("---");
  lines.push("");
  const body = appendRelatedSection(e.body, extras.related_links);
  lines.push(body);
  if (!body.endsWith("\n")) lines.push("");
  return lines.join("\n");
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
// Main entry
// ---------------------------------------------------------------------------

export async function extractSlice(
  input: ExtractSliceInput,
  opts: ExtractSliceDeps = {},
): Promise<ExtractSliceResult> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const env = opts.env ?? process.env;
  const configPath = opts.configPath ?? join(homedir(), ".claude.json");
  const cacheDir =
    opts.cacheDir ?? join(homedir(), ".claude", "airtable-extract-cache");
  const runId = opts.runId ?? new Date().toISOString().replace(/[:.]/g, "-");
  const promptsPath =
    opts.promptsPath ?? defaultPromptsPath();
  const budget = opts.clusterContextBudget ?? CLUSTER_CONTEXT_BUDGET;
  const runSonnet = opts.runSonnet ?? spawnClaudeSonnet;
  const now = opts.now ?? (() => new Date().toISOString());

  const runDir = join(cacheDir, runId);
  const outDir = join(runDir, "out");
  const sliceCacheDir = join(runDir, "slice-cache");
  const costMeterPath = join(runDir, "cost-meter.jsonl");
  const manifestPath = join(sliceCacheDir, `${input.seedRecordId}.json`);

  mkdirSync(sliceCacheDir, { recursive: true });

  if (existsSync(manifestPath)) {
    const cached = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      entities: ExtractedEntity[];
      entity_paths: string[];
      truncated: boolean;
      truncation_reason: string | null;
      estimated_prompt_tokens: number;
    };
    return {
      entities: cached.entities,
      entityPaths: cached.entity_paths,
      truncated: cached.truncated,
      truncationReason: cached.truncation_reason ?? null,
      estimatedPromptTokens: cached.estimated_prompt_tokens ?? 0,
      cachedHit: true,
      costMeterPath,
      manifestPath,
    };
  }

  const token = resolveToken(env, configPath);

  const metaUrl = `${META_API_BASE}/${encodeURIComponent(input.baseId)}/tables`;
  const metaRes = await fetchImpl(metaUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!metaRes.ok) {
    const text = await metaRes.text().catch(() => "");
    throw new Error(`Airtable Meta API ${metaRes.status}: ${text || metaRes.statusText}`);
  }
  const metaBody = (await metaRes.json()) as MetaApiTablesResponse;
  const tablesById = new Map<string, AirtableTable>();
  for (const t of metaBody.tables ?? []) tablesById.set(t.id, t);

  const recordsById = new Map<string, AirtableRecord>();
  const recordToTable = new Map<string, string>();
  const allLinks: RecordLink[] = [];
  for (const tId of input.tableIds) {
    const t = tablesById.get(tId);
    if (!t) continue;
    const recs = await fetchAllRecords(input.baseId, tId, token, fetchImpl);
    for (const r of recs) {
      recordsById.set(r.id, r);
      recordToTable.set(r.id, tId);
    }
    allLinks.push(...extractRecordLinks(recs, tId, t));
  }

  if (!recordsById.has(input.seedRecordId)) {
    throw new Error(
      `seed record ${input.seedRecordId} not present in cluster ${input.clusterId} tables`,
    );
  }

  const bfs = bfsFromSeed(input.seedRecordId, recordsById, allLinks, budget);

  const promptsContent = readFileSync(promptsPath, "utf8");
  const variants = parsePromptVariants(promptsContent);
  const variant = variants.get(input.clusterType);
  if (!variant) {
    throw new Error(
      `prompt variant '${input.clusterType}' missing in ${promptsPath}`,
    );
  }

  const subgraph = buildSubgraphContext(
    recordsById,
    bfs.keptRecordIds,
    tablesById,
    recordToTable,
  );
  const prompt = renderPrompt(variant, {
    clusterType: input.clusterType,
    clusterId: input.clusterId,
    seedRecordId: input.seedRecordId,
    subgraph,
  });

  const sonnetResp = await runSonnet(prompt, DEFAULT_MODEL);
  const entities = parseSonnetEntityResponse(sonnetResp.rawText);
  const warn = opts.warn ?? ((msg: string) => process.stderr.write(`${msg}\n`));
  try {
    for (const e of entities) {
      e.source_record_ids = resolveEntitySourceIds(
        e,
        recordsById,
        recordToTable,
        tablesById,
        input.seedRecordId,
        warn,
      );
    }
  } catch (err) {
    if (err instanceof SliceRejectedError) {
      writeEscalationMd(runDir, input, err);
    }
    throw err;
  }

  mkdirSync(runDir, { recursive: true });
  const costEvent: Record<string, unknown> = {
    ts: now(),
    model: sonnetResp.model,
    input_tokens: sonnetResp.usage.input_tokens,
    output_tokens: sonnetResp.usage.output_tokens,
  };
  if (sonnetResp.usage.cache_creation_input_tokens != null) {
    costEvent.cache_creation_input_tokens =
      sonnetResp.usage.cache_creation_input_tokens;
  }
  if (sonnetResp.usage.cache_read_input_tokens != null) {
    costEvent.cache_read_input_tokens =
      sonnetResp.usage.cache_read_input_tokens;
  }
  appendFileSync(costMeterPath, `${JSON.stringify(costEvent)}\n`);

  const ts = now();
  const entityPaths: string[] = [];
  const slugMap = buildSlugMap(entities);
  for (const e of entities) {
    const primarySourceId = e.source_record_ids[0] ?? input.seedRecordId;
    const primaryTableId = recordToTable.get(primarySourceId) ?? null;
    const primaryTable = primaryTableId
      ? tablesById.get(primaryTableId) ?? null
      : null;
    const sourceTable = primaryTable?.name ?? null;
    const sourceUrl = primaryTableId
      ? airtableRecordUrl(input.baseId, primaryTableId, primarySourceId)
      : null;

    const aiFields: AiFieldEntry[] = [];
    let attachmentsCount = 0;
    let firstAttachmentUrl: string | null = null;
    for (const recId of e.source_record_ids) {
      const rec = recordsById.get(recId);
      if (!rec) continue;
      const tId = recordToTable.get(recId);
      if (!tId) continue;
      const t = tablesById.get(tId);
      if (!t) continue;
      aiFields.push(...extractAiFields(rec, t));
      const att = extractAttachments(rec, t);
      attachmentsCount += att.count;
      if (firstAttachmentUrl === null && att.firstUrl !== null) {
        firstAttachmentUrl = att.firstUrl;
      }
    }

    const relatedLinks = findRelatedWikilinks(
      e,
      recordsById,
      recordToTable,
      tablesById,
      slugMap,
    );

    const extras: EntityRenderExtras = {
      source_record_id: primarySourceId,
      source_table: sourceTable,
      source_url: sourceUrl,
      ai_fields: aiFields,
      attachments_count: attachmentsCount,
      first_attachment_url: firstAttachmentUrl,
      related_links: relatedLinks,
    };

    const path = join(outDir, e.type, `${slugify(e.slug)}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderEntityMarkdown(e, input, ts, extras));
    entityPaths.push(path);
  }

  const manifest = {
    seed_record_id: input.seedRecordId,
    cluster_id: input.clusterId,
    cluster_type: input.clusterType,
    base_id: input.baseId,
    table_ids: input.tableIds,
    entities,
    entity_paths: entityPaths,
    truncated: bfs.truncated,
    truncation_reason: bfs.reason,
    estimated_prompt_tokens: bfs.estimatedTokens,
    extracted_at: ts,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    entities,
    entityPaths,
    truncated: bfs.truncated,
    truncationReason: bfs.reason,
    estimatedPromptTokens: bfs.estimatedTokens,
    cachedHit: false,
    costMeterPath,
    manifestPath,
  };
}

function defaultPromptsPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "prompts", "extract.md");
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const seedRecordId = process.argv[2];
  if (!seedRecordId) {
    process.stderr.write("usage: bun run extract-slice.mts <seed-record-id>\n");
    process.exit(1);
  }
  const env = process.env;
  const baseId = env.AIRTABLE_BASE_ID;
  const clusterId = env.AIRTABLE_CLUSTER_ID;
  const clusterType = env.AIRTABLE_CLUSTER_TYPE as ClusterType | undefined;
  const tableIdsRaw = env.AIRTABLE_TABLE_IDS;
  if (!baseId || !clusterId || !clusterType || !tableIdsRaw) {
    process.stderr.write(
      "extract-slice: requires AIRTABLE_BASE_ID, AIRTABLE_CLUSTER_ID, AIRTABLE_CLUSTER_TYPE, AIRTABLE_TABLE_IDS env vars\n",
    );
    process.exit(1);
  }
  const tableIds = tableIdsRaw.split(",").map((s) => s.trim()).filter(Boolean);

  try {
    const result = await extractSlice(
      { baseId, clusterId, clusterType, tableIds, seedRecordId },
      { runId: env.AIRTABLE_RUN_ID },
    );
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`extract-slice: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
