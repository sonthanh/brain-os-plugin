#!/usr/bin/env bun
/**
 * emit-edges.mts — interaction-table edge emitter (ai-brain#241, parent #237 AC#11).
 *
 * Walks every record of every Stage 0 `interaction`-classified table in a base
 * and writes one JSONL row per record to `${vault}/knowledge/graph/edges.jsonl`.
 *
 * Edge semantics: Zero Sonnet calls. Edge emission is purely deterministic per
 * the 2026-05-05 grill verdict — interaction records carry from/to via record-
 * link fields, plus optional amount/date/note pulled by name heuristics. The
 * Stage 0 LLM (#238) decided the table type once; emit-edges trusts that cache
 * and never re-invokes the model.
 *
 * Schema (line-anchored — every row carries every required key):
 *
 *   { id, type, from, to, source_record_id, source_table,
 *     amount?, date?, note? }
 *
 * - `id` = `${baseId}-${recordId}`. record_id-derived (per AC#11) AND globally
 *   unique across bases — Airtable record IDs are unique per base, not per
 *   workspace, so prefixing the base lets `edges.jsonl` accumulate as an SSOT.
 * - `type` = slugified table name (lower-kebab, no singularization). The
 *   table-name → type mapping is intentionally trivial: AC #11 requires zero
 *   Sonnet calls and the parent grill (Q2-Q18) settled on "deterministic per
 *   spec" — any per-table custom typing belongs in #245's rollup or in a
 *   future config, not here.
 * - `from` / `to` derivation walks `multipleRecordLinks` fields in schema
 *   order and applies the first matching rule:
 *     (a) ≥2 link fields with content → IDs[0] of first / IDs[0] of second.
 *     (b) Single link field with ≥2 IDs → IDs[0] / IDs[1].
 *     (c) Otherwise → record skipped (returned in `skipped[]`, not silently
 *         dropped — orphan interactions surface for debugging).
 * - Optional fields use case-insensitive field-name matchers (Amount/Inflow/
 *   Outflow/Net/Total/Value/Sum, Date/Timestamp/When, Note/Notes/Description/
 *   Memo/Comment) and pick the first matching field with a non-empty value.
 *
 * Idempotence: `appendEdgesToFile` reads the existing JSONL → merges by id
 * (last-write-wins on body) → rewrites the file sorted by id. Two consecutive
 * runs on identical input produce a byte-identical file (verified by
 * `tests/emit-edges.test.ts:idempotence`).
 *
 * No-op fall-throughs: emit-edges silently returns `skipped: true` when
 *   - the Stage 0 cache for the base is absent (legacy bases pre-#238); OR
 *   - the cache has zero `interaction` tables.
 * In neither case is `edges.jsonl` created or the Airtable API hit. This lets
 * the run.mts orchestrator call `emitEdges(baseId)` unconditionally — it's a
 * no-op until #238 has classified the base.
 *
 * CLI:
 *   bun run emit-edges.mts <base-id>
 *
 * NEVER imports `@anthropic-ai/sdk`, never spawns `claude`. The zero-Sonnet
 * contract is enforced by `tests/emit-edges.test.ts` via a module-source
 * audit; if the audit fails, AC#11's "LLM token counter shows 0" claim is
 * void. Don't add an LLM-runner option to this module — if a future strategy
 * needs LLM-assisted edge typing, it belongs in a sibling script that
 * dispatches to the LLM and writes its own JSONL channel, not here.
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
import type { AirtableTable, AirtableField } from "./classify-clusters.mts";
import type { AirtableRecord } from "./legacy-link-detector.mts";
import { resolveVaultPath } from "./outcome-log.mts";
import {
  entityFields,
  type TableTextFieldClassification,
} from "./classify-text-field-entities.mts";

const META_API_BASE = "https://api.airtable.com/v0/meta/bases";
const RECORDS_API_BASE = "https://api.airtable.com/v0";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EdgeRow {
  id: string;
  type: string;
  from: string;
  to: string;
  amount?: number;
  date?: string;
  note?: string;
  source_record_id: string;
  source_table: string;
}

export interface EmitEdgesForTableInput {
  table: AirtableTable;
  records: AirtableRecord[];
  baseId: string;
  /**
   * Optional S5a classification for this table — when present, classified
   * `from-like` / `to-like` text-field entity values override the default
   * link-field-derived `from`/`to` per side. See `pickEntityFromTo`.
   */
  classification?: TableTextFieldClassification;
}

export interface SkippedRecord {
  recordId: string;
  reason: string;
}

export interface EmitEdgesForTableResult {
  rows: EdgeRow[];
  skipped: SkippedRecord[];
}

export interface MergeEdgesResult {
  merged: EdgeRow[];
  added: number;
  updated: number;
}

export interface Stage0Classification {
  type: "entity" | "interaction" | "reject";
  reasoning: string;
  schema_hash: string;
  classified_at: string;
}

export interface EmitEdgesOptions {
  fetch?: typeof globalThis.fetch;
  env?: Record<string, string | undefined>;
  configPath?: string;
  cacheBaseDir?: string;
  /**
   * S5a (text-field-entities) cache directory — when present + populated for
   * this base, classified `from-like` / `to-like` text-field values override
   * the link-field defaults in edge `from`/`to`. Falls back silently to the
   * existing behaviour when the cache is absent (legacy bases pre-#251).
   */
  textFieldCacheBaseDir?: string;
  vaultPath?: string;
  warn?: (msg: string) => void;
}

export interface EmitEdgesResult {
  baseId: string;
  tablesProcessed: string[];
  edgesWritten: number;
  edgesAdded: number;
  edgesUpdated: number;
  outputPath: string | null;
  skipped: boolean;
  reason?: string;
  recordsSkipped: SkippedRecord[];
}

// ---------------------------------------------------------------------------
// Pure helpers — slugify / field-name matchers
// ---------------------------------------------------------------------------

const AMOUNT_NAME = /^(amount|inflow|outflow|net|total|value|sum)$/i;
const DATE_NAME = /^(date|datetime|timestamp|when|created|created_at)$/i;
const NOTE_NAME = /^(notes?|description|memo|comment)$/i;

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function deriveEdgeType(tableName: string): string {
  // Intentionally NO singularization — `Payments` stays `payments`. Plural→
  // singular heuristics are too fragile (Activities → Activitie, etc.) and the
  // grill (Q2-Q18) settled on "deterministic per spec" without singularization.
  return slugify(tableName);
}

function fieldByName(
  table: AirtableTable,
  pattern: RegExp,
): AirtableField | undefined {
  return table.fields.find((f) => pattern.test(f.name));
}

function readField(record: AirtableRecord, fieldName: string): unknown {
  return record.fields?.[fieldName];
}

export function pickAmount(
  table: AirtableTable,
  record: AirtableRecord,
): number | undefined {
  const f = fieldByName(table, AMOUNT_NAME);
  if (!f) return undefined;
  const v = readField(record, f.name);
  if (v == null || v === "") return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function pickDate(
  table: AirtableTable,
  record: AirtableRecord,
): string | undefined {
  const f = fieldByName(table, DATE_NAME);
  if (!f) return undefined;
  const v = readField(record, f.name);
  if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

export function pickNote(
  table: AirtableTable,
  record: AirtableRecord,
): string | undefined {
  const f = fieldByName(table, NOTE_NAME);
  if (!f) return undefined;
  const v = readField(record, f.name);
  if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

// ---------------------------------------------------------------------------
// from/to derivation
// ---------------------------------------------------------------------------

interface LinkFieldEntry {
  field: AirtableField;
  ids: string[];
}

function collectLinkFieldEntries(
  table: AirtableTable,
  record: AirtableRecord,
): LinkFieldEntry[] {
  const out: LinkFieldEntry[] = [];
  for (const f of table.fields) {
    if (f.type !== "multipleRecordLinks") continue;
    const v = readField(record, f.name);
    if (!Array.isArray(v) || v.length === 0) continue;
    const ids = v.filter((x): x is string => typeof x === "string" && x.length > 0);
    if (ids.length === 0) continue;
    out.push({ field: f, ids });
  }
  return out;
}

export function pickFromTo(
  table: AirtableTable,
  record: AirtableRecord,
): { from: string; to: string } | null {
  const entries = collectLinkFieldEntries(table, record);
  if (entries.length >= 2) {
    return { from: entries[0].ids[0], to: entries[1].ids[0] };
  }
  if (entries.length === 1 && entries[0].ids.length >= 2) {
    return { from: entries[0].ids[0], to: entries[0].ids[1] };
  }
  return null;
}

/**
 * Per-side override (S5b/S7 integration, ai-brain#251). When the table has an
 * S5a classification with one `from-like` person/company text field with a
 * non-empty value, returns its slug as `from`; same for `to-like` → `to`.
 *
 * MUST produce slugs that match `extract-text-field-entities.mts`'s
 * `slug` field — both call `slugify` on the canonicalised value
 * (NFKC + trim + collapse whitespace + lowercase). Drift between the two
 * canonicalisations would mean S5b emits page `john-doe.md` while S7 emits
 * edge `from: "johndoe"` — orphan slug references in the graph.
 *
 * `undirected` and `none` roles are skipped (undirected entity pages are
 * still emitted by S5b but they don't drive an edge endpoint).
 */
export function pickEntityFromTo(
  table: AirtableTable,
  record: AirtableRecord,
  classification?: TableTextFieldClassification,
): { from?: string; to?: string } {
  if (!classification) return {};
  const fields = entityFields(classification);
  if (fields.length === 0) return {};
  let fromSlug: string | undefined;
  let toSlug: string | undefined;
  for (const ef of fields) {
    if (ef.role !== "from-like" && ef.role !== "to-like") continue;
    const v = record.fields?.[ef.name];
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (trimmed.length === 0) continue;
    const canonical = trimmed
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .toLowerCase();
    const slug = slugify(canonical);
    if (slug.length === 0) continue;
    if (ef.role === "from-like" && fromSlug === undefined) fromSlug = slug;
    if (ef.role === "to-like" && toSlug === undefined) toSlug = slug;
  }
  return { from: fromSlug, to: toSlug };
}

// ---------------------------------------------------------------------------
// Row construction
// ---------------------------------------------------------------------------

export interface BuildEdgeRowOptions {
  classification?: TableTextFieldClassification;
}

export function buildEdgeRow(
  table: AirtableTable,
  record: AirtableRecord,
  baseId: string,
  opts: BuildEdgeRowOptions = {},
): EdgeRow | null {
  const linkFt = pickFromTo(table, record);
  const entityFt = pickEntityFromTo(table, record, opts.classification);
  const from = entityFt.from ?? linkFt?.from;
  const to = entityFt.to ?? linkFt?.to;
  if (!from || !to) return null;
  const row: EdgeRow = {
    id: `${baseId}-${record.id}`,
    type: deriveEdgeType(table.name),
    from,
    to,
    source_record_id: record.id,
    source_table: table.id,
  };
  const amount = pickAmount(table, record);
  if (amount !== undefined) row.amount = amount;
  const date = pickDate(table, record);
  if (date !== undefined) row.date = date;
  const note = pickNote(table, record);
  if (note !== undefined) row.note = note;
  return row;
}

export function emitEdgesForTable(
  input: EmitEdgesForTableInput,
): EmitEdgesForTableResult {
  const rows: EdgeRow[] = [];
  const skipped: SkippedRecord[] = [];
  for (const r of input.records) {
    const row = buildEdgeRow(input.table, r, input.baseId, {
      classification: input.classification,
    });
    if (!row) {
      skipped.push({
        recordId: r.id,
        reason:
          "no derivable from/to (need ≥2 link IDs across ≥1 link field, or classified text-field entity values)",
      });
      continue;
    }
    rows.push(row);
  }
  return { rows, skipped };
}

// ---------------------------------------------------------------------------
// JSONL serialize / parse
// ---------------------------------------------------------------------------

export function formatJsonl(rows: EdgeRow[]): string {
  if (rows.length === 0) return "";
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

export function parseJsonl(text: string): EdgeRow[] {
  const out: EdgeRow[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line) as EdgeRow);
    } catch {
      // Skip malformed lines — rebuilds tolerate hand-edits without crashing.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Merge — last-write-wins by id, sorted output for byte-stable re-runs
// ---------------------------------------------------------------------------

export function mergeEdgesById(
  existing: EdgeRow[],
  incoming: EdgeRow[],
): MergeEdgesResult {
  const map = new Map<string, EdgeRow>();
  for (const r of existing) map.set(r.id, r);
  let added = 0;
  let updated = 0;
  for (const r of incoming) {
    if (map.has(r.id)) updated += 1;
    else added += 1;
    map.set(r.id, r);
  }
  const merged = [...map.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { merged, added, updated };
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

export function appendEdgesToFile(
  filePath: string,
  incoming: EdgeRow[],
): { written: number; total: number; added: number; updated: number; path: string } {
  mkdirSync(dirname(filePath), { recursive: true });
  let existing: EdgeRow[] = [];
  if (existsSync(filePath)) {
    existing = parseJsonl(readFileSync(filePath, "utf8"));
  }
  const { merged, added, updated } = mergeEdgesById(existing, incoming);
  writeFileSync(filePath, formatJsonl(merged));
  return {
    written: incoming.length,
    total: merged.length,
    added,
    updated,
    path: filePath,
  };
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
// Stage 0 cache
// ---------------------------------------------------------------------------

function defaultCacheBaseDir(): string {
  // scripts/emit-edges.mts → skill root → cache/table-types
  const here = dirname(new URL(import.meta.url).pathname);
  return join(here, "..", "cache", "table-types");
}

function defaultTextFieldCacheBaseDir(): string {
  const here = dirname(new URL(import.meta.url).pathname);
  return join(here, "..", "cache", "text-field-entities");
}

function readStage0Cache(
  cacheBaseDir: string,
  baseId: string,
): Record<string, Stage0Classification> | null {
  const cachePath = join(cacheBaseDir, `${baseId}.json`);
  if (!existsSync(cachePath)) return null;
  try {
    return JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, Stage0Classification>;
  } catch {
    return null;
  }
}

function readTextFieldCache(
  cacheBaseDir: string,
  baseId: string,
): Record<string, TableTextFieldClassification> | null {
  const cachePath = join(cacheBaseDir, `${baseId}.json`);
  if (!existsSync(cachePath)) return null;
  try {
    return JSON.parse(readFileSync(cachePath, "utf8")) as Record<
      string,
      TableTextFieldClassification
    >;
  } catch {
    return null;
  }
}

function interactionTableIds(
  classifications: Record<string, Stage0Classification>,
): string[] {
  return Object.entries(classifications)
    .filter(([, c]) => c.type === "interaction")
    .map(([id]) => id);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function emitEdges(
  baseId: string,
  opts: EmitEdgesOptions = {},
): Promise<EmitEdgesResult> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const env = opts.env ?? process.env;
  const configPath = opts.configPath ?? join(homedir(), ".claude.json");
  const cacheBaseDir = opts.cacheBaseDir ?? defaultCacheBaseDir();
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`));

  const cache = readStage0Cache(cacheBaseDir, baseId);
  if (!cache) {
    return {
      baseId,
      tablesProcessed: [],
      edgesWritten: 0,
      edgesAdded: 0,
      edgesUpdated: 0,
      outputPath: null,
      skipped: true,
      reason: `Stage 0 cache absent for base ${baseId} — run classify-table-type.mts first`,
      recordsSkipped: [],
    };
  }
  const wantedIds = interactionTableIds(cache);
  if (wantedIds.length === 0) {
    return {
      baseId,
      tablesProcessed: [],
      edgesWritten: 0,
      edgesAdded: 0,
      edgesUpdated: 0,
      outputPath: null,
      skipped: true,
      reason: `Stage 0 cache has no interaction tables for base ${baseId}`,
      recordsSkipped: [],
    };
  }

  const vaultPath = opts.vaultPath ?? resolveVaultPath({ env });
  if (!vaultPath) {
    throw new Error(
      "emit-edges: vault_path not resolvable. Set brain-os.config.md vault_path or pass opts.vaultPath.",
    );
  }

  const token = resolveToken(env, configPath);
  const tables = await fetchTables(baseId, fetchImpl, token);
  const wantedTables = tables.filter((t) => wantedIds.includes(t.id));

  const textFieldDir =
    opts.textFieldCacheBaseDir ?? defaultTextFieldCacheBaseDir();
  const textFieldCache = readTextFieldCache(textFieldDir, baseId) ?? {};

  const allRows: EdgeRow[] = [];
  const allSkipped: SkippedRecord[] = [];
  const tablesProcessed: string[] = [];
  for (const t of wantedTables) {
    const records = await fetchAllRecords(baseId, t.id, fetchImpl, token);
    const classification = textFieldCache[t.id];
    const { rows, skipped } = emitEdgesForTable({
      table: t,
      records,
      baseId,
      classification,
    });
    allRows.push(...rows);
    for (const s of skipped) {
      allSkipped.push({ recordId: s.recordId, reason: `${t.id}: ${s.reason}` });
      warn(`emit-edges: skip ${t.id}/${s.recordId} — ${s.reason}`);
    }
    tablesProcessed.push(t.id);
  }

  const edgesPath = join(vaultPath, "knowledge", "graph", "edges.jsonl");
  const written = appendEdgesToFile(edgesPath, allRows);

  return {
    baseId,
    tablesProcessed,
    edgesWritten: written.total,
    edgesAdded: written.added,
    edgesUpdated: written.updated,
    outputPath: written.path,
    skipped: false,
    recordsSkipped: allSkipped,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const baseId = process.argv[2];
  if (!baseId) {
    process.stderr.write("usage: bun run emit-edges.mts <base-id>\n");
    process.exit(1);
  }
  try {
    const result = await emitEdges(baseId);
    if (result.skipped) {
      process.stderr.write(`emit-edges: skipped — ${result.reason}\n`);
    } else {
      process.stderr.write(
        `emit-edges: ${result.edgesAdded} added, ${result.edgesUpdated} updated → ${result.outputPath}\n`,
      );
    }
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`emit-edges: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
