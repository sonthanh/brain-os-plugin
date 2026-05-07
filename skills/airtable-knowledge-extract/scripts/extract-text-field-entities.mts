#!/usr/bin/env bun
/**
 * extract-text-field-entities.mts — Stage S5b text-field entity emitter
 * (ai-brain#251, parent #237).
 *
 * Reads the S5a cache (cache/text-field-entities/{base_id}.json) plus the
 * interaction records for that base, walks each classified `person` /
 * `company` text field, dedups values by canonical-name (case-insensitive
 * trim) and emits one entity page per unique name to:
 *
 *   {runDir}/bases/{base_id}/out/people/{slug}.md
 *   {runDir}/bases/{base_id}/out/companies/{slug}.md
 *
 * ZERO LLM CALLS. The deduplication + slug derivation is deterministic. The
 * Sonnet/Opus tier for `text-field` entities is paid once at S5a (per-table
 * field classification), not here.
 *
 * Page frontmatter:
 *   ---
 *   name: "John Doe"
 *   slug: john-doe
 *   kind: person
 *   extraction_strategy: text-field
 *   source_record_ids: ["appUV3hAWcRzrGjqK-recP1", ...]
 *   source_tables: ["Payments", ...]
 *   field_mentions:
 *     - field: "Payer Name"
 *       table: "Payments"
 *       count: 3
 *     - field: "Payee Name"
 *       table: "Payments"
 *       count: 1
 *   extracted_at: 2026-05-07T...
 *   base_id: appUV3hAWcRzrGjqK
 *   ---
 *
 *   {body — short factual paragraph noting the source}
 *
 * Idempotence: re-running on the same data overwrites pages with byte-stable
 * content (deterministic serialiser — sorted keys, sorted source lists).
 *
 * Cross-base dedup is OUT OF SCOPE (per #237 Q13). Each base writes to its own
 * `bases/{base_id}/out/people/` so cross-base "John Doe" collisions are
 * naturally separated. Merging across bases is a future concern (#176 vault
 * entity graph rollup).
 *
 * CLI:
 *   bun run extract-text-field-entities.mts <base-id>
 *     Reads AIRTABLE_RUN_ID env. Default: today's UTC date suffixed with
 *     `-airtable-extract` (matches dispatcher / schema-analyser convention).
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
import type { AirtableTable } from "./classify-clusters.mts";
import type { AirtableRecord } from "./legacy-link-detector.mts";
import {
  entityFields,
  type TableTextFieldClassification,
  type TextFieldKind,
  type TextFieldRole,
} from "./classify-text-field-entities.mts";
import type { TableTypeClassification } from "./classify-table-type.mts";
import { slugify } from "./emit-edges.mts";
import { canonicalName as sharedCanonicalName } from "./text-canonical.mts";

const META_API_BASE = "https://api.airtable.com/v0/meta/bases";
const RECORDS_API_BASE = "https://api.airtable.com/v0";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FieldMention {
  field: string;
  table: string;
  count: number;
}

export interface TextFieldEntity {
  /** Display name as first seen (preserves case/diacritics for vault page title). */
  name: string;
  /** Canonical name used for dedup (case-insensitive trim). */
  canonical: string;
  /** Slug derived from canonical (lower-kebab, ASCII). */
  slug: string;
  kind: TextFieldKind;
  /** Roles seen across all source mentions (e.g. {from-like, to-like}). */
  roles: TextFieldRole[];
  /** `${baseId}-${recordId}` keys, sorted ascending. */
  source_record_ids: string[];
  /** Distinct source-table names, sorted ascending. */
  source_tables: string[];
  /** Per-(table, field) mention counts, sorted by table then field. */
  field_mentions: FieldMention[];
}

export interface ExtractTextFieldEntitiesOptions {
  fetch?: typeof globalThis.fetch;
  env?: Record<string, string | undefined>;
  configPath?: string;
  cacheBaseDir?: string;
  stage0CacheBaseDir?: string;
  textFieldCacheBaseDir?: string;
  /** Override the run-id directory (default: ~/.claude/airtable-extract-cache/<run-id>). */
  runDir?: string;
  runId?: string;
  now?: () => string;
  warn?: (msg: string) => void;
}

export interface ExtractTextFieldEntitiesResult {
  baseId: string;
  peopleWritten: number;
  companiesWritten: number;
  /** Sorted by slug. */
  entities: TextFieldEntity[];
  outputDir: string;
  skipped: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Re-export of `text-canonical.mts:canonicalName` for back-compat with tests
 * + downstream callers. Single source of truth lives in `text-canonical.mts`
 * — drift between this and `emit-edges.mts:pickEntityFromTo` would orphan
 * slug references in `edges.jsonl` (per-record edge `from` no longer matches
 * the canonical-named entity page filename).
 */
export const canonicalName = sharedCanonicalName;

/** Render a deterministic frontmatter+body string for a single entity page. */
export function renderEntityPage(
  entity: TextFieldEntity,
  baseId: string,
  extractedAt: string,
): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`name: ${JSON.stringify(entity.name)}`);
  lines.push(`slug: ${entity.slug}`);
  lines.push(`kind: ${entity.kind}`);
  lines.push(`extraction_strategy: text-field`);
  lines.push(`base_id: ${baseId}`);
  lines.push(`roles:`);
  for (const r of entity.roles) lines.push(`  - ${r}`);
  lines.push(`source_record_ids:`);
  for (const id of entity.source_record_ids) lines.push(`  - ${id}`);
  lines.push(`source_tables:`);
  for (const t of entity.source_tables) lines.push(`  - ${JSON.stringify(t)}`);
  lines.push(`field_mentions:`);
  for (const m of entity.field_mentions) {
    lines.push(`  - field: ${JSON.stringify(m.field)}`);
    lines.push(`    table: ${JSON.stringify(m.table)}`);
    lines.push(`    count: ${m.count}`);
  }
  lines.push(`extracted_at: ${extractedAt}`);
  lines.push("---");
  lines.push("");
  const totalMentions = entity.field_mentions.reduce((a, m) => a + m.count, 0);
  const tableList = entity.source_tables
    .map((t) => `\`${t}\``)
    .join(", ");
  lines.push(
    `${entity.name} appears as a ${entity.kind} reference in ${totalMentions} record${totalMentions === 1 ? "" : "s"} across ${tableList} (base \`${baseId}\`). Extracted from text fields via the schema-driven dispatch pipeline (see \`#251\`).`,
  );
  lines.push("");
  return lines.join("\n");
}

interface MentionAccumulator {
  // canonical → working entity
  byCanonical: Map<string, TextFieldEntity>;
  // canonical → tableName -> fieldName -> Set<recordId>
  rawMentions: Map<string, Map<string, Map<string, Set<string>>>>;
  rolesByCanonical: Map<string, Set<TextFieldRole>>;
  warnings: string[];
}

function emptyAcc(): MentionAccumulator {
  return {
    byCanonical: new Map(),
    rawMentions: new Map(),
    rolesByCanonical: new Map(),
    warnings: [],
  };
}

function recordMention(
  acc: MentionAccumulator,
  args: {
    rawValue: string;
    kind: TextFieldKind;
    role: TextFieldRole;
    table: AirtableTable;
    fieldName: string;
    recordId: string;
    baseId: string;
  },
): void {
  const trimmed = args.rawValue.trim();
  if (trimmed.length === 0) return;
  const canonical = canonicalName(trimmed);
  const slug = slugify(canonical);
  if (slug.length === 0) return; // value normalised to nothing useful

  let entity = acc.byCanonical.get(canonical);
  if (!entity) {
    entity = {
      name: trimmed,
      canonical,
      slug,
      kind: args.kind,
      roles: [],
      source_record_ids: [],
      source_tables: [],
      field_mentions: [],
    };
    acc.byCanonical.set(canonical, entity);
  } else if (entity.kind !== args.kind) {
    acc.warnings.push(
      `kind conflict: '${entity.name}' first seen as ${entity.kind}, now ${args.kind} on ${args.table.name}.${args.fieldName} (record ${args.recordId}) — keeping ${entity.kind}`,
    );
  }

  const roleSet = acc.rolesByCanonical.get(canonical) ?? new Set<TextFieldRole>();
  roleSet.add(args.role);
  acc.rolesByCanonical.set(canonical, roleSet);

  let perTable = acc.rawMentions.get(canonical);
  if (!perTable) {
    perTable = new Map();
    acc.rawMentions.set(canonical, perTable);
  }
  let perField = perTable.get(args.table.name);
  if (!perField) {
    perField = new Map();
    perTable.set(args.table.name, perField);
  }
  let perRec = perField.get(args.fieldName);
  if (!perRec) {
    perRec = new Set();
    perField.set(args.fieldName, perRec);
  }
  perRec.add(`${args.baseId}-${args.recordId}`);
}

function finaliseEntities(acc: MentionAccumulator): TextFieldEntity[] {
  const out: TextFieldEntity[] = [];
  for (const [canonical, entity] of acc.byCanonical) {
    const roleSet = acc.rolesByCanonical.get(canonical) ?? new Set<TextFieldRole>();
    entity.roles = [...roleSet].sort();
    const recordIds = new Set<string>();
    const tableNames = new Set<string>();
    const mentions: FieldMention[] = [];
    const perTable = acc.rawMentions.get(canonical);
    if (perTable) {
      for (const [tableName, perField] of perTable) {
        tableNames.add(tableName);
        for (const [fieldName, recs] of perField) {
          for (const r of recs) recordIds.add(r);
          mentions.push({ field: fieldName, table: tableName, count: recs.size });
        }
      }
    }
    entity.source_record_ids = [...recordIds].sort();
    entity.source_tables = [...tableNames].sort();
    entity.field_mentions = mentions.sort((a, b) =>
      a.table === b.table ? a.field.localeCompare(b.field) : a.table.localeCompare(b.table),
    );
    out.push(entity);
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

// ---------------------------------------------------------------------------
// Cache I/O
// ---------------------------------------------------------------------------

function defaultStage0CacheBaseDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "cache", "table-types");
}

function defaultTextFieldCacheBaseDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "cache", "text-field-entities");
}

function defaultRunDir(env: Record<string, string | undefined>, runId?: string): string {
  const id =
    runId ??
    env.AIRTABLE_RUN_ID ??
    `${new Date().toISOString().slice(0, 10)}-airtable-extract`;
  return join(homedir(), ".claude", "airtable-extract-cache", id);
}

function readJsonOrNull<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
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
// Public API — pure walker (no I/O), useful for unit tests
// ---------------------------------------------------------------------------

export interface WalkInput {
  baseId: string;
  table: AirtableTable;
  records: AirtableRecord[];
  classification: TableTextFieldClassification;
}

export function walkTable(input: WalkInput, acc: MentionAccumulator): void {
  const fields = entityFields(input.classification);
  if (fields.length === 0) return;
  for (const r of input.records) {
    for (const ef of fields) {
      const v = r.fields?.[ef.name];
      if (typeof v !== "string") continue;
      recordMention(acc, {
        rawValue: v,
        kind: ef.kind,
        role: ef.role,
        table: input.table,
        fieldName: ef.name,
        recordId: r.id,
        baseId: input.baseId,
      });
    }
  }
}

export function buildEntities(inputs: WalkInput[]): {
  entities: TextFieldEntity[];
  warnings: string[];
} {
  const acc = emptyAcc();
  for (const input of inputs) walkTable(input, acc);
  return { entities: finaliseEntities(acc), warnings: acc.warnings };
}

// ---------------------------------------------------------------------------
// File output
// ---------------------------------------------------------------------------

export function writeEntityPages(
  entities: TextFieldEntity[],
  outputDir: string,
  baseId: string,
  extractedAt: string,
): { peopleWritten: number; companiesWritten: number } {
  const peopleDir = join(outputDir, "people");
  const companiesDir = join(outputDir, "companies");
  let peopleWritten = 0;
  let companiesWritten = 0;
  for (const e of entities) {
    const dir = e.kind === "person" ? peopleDir : companiesDir;
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${e.slug}.md`);
    writeFileSync(path, renderEntityPage(e, baseId, extractedAt));
    if (e.kind === "person") peopleWritten += 1;
    else companiesWritten += 1;
  }
  return { peopleWritten, companiesWritten };
}

// ---------------------------------------------------------------------------
// Public API — orchestrated
// ---------------------------------------------------------------------------

export async function extractTextFieldEntities(
  baseId: string,
  opts: ExtractTextFieldEntitiesOptions = {},
): Promise<ExtractTextFieldEntitiesResult> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const env = opts.env ?? process.env;
  const configPath = opts.configPath ?? join(homedir(), ".claude.json");
  const stage0Dir = opts.stage0CacheBaseDir ?? defaultStage0CacheBaseDir();
  const tfDir = opts.textFieldCacheBaseDir ?? defaultTextFieldCacheBaseDir();
  const runDir = opts.runDir ?? defaultRunDir(env, opts.runId);
  const now = opts.now ?? (() => new Date().toISOString());
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`));

  const stage0 = readJsonOrNull<Record<string, TableTypeClassification>>(
    join(stage0Dir, `${baseId}.json`),
  );
  if (!stage0) {
    return {
      baseId,
      peopleWritten: 0,
      companiesWritten: 0,
      entities: [],
      outputDir: join(runDir, "bases", baseId, "out"),
      skipped: true,
      reason: `Stage 0 cache absent for ${baseId} — run classify-table-type.mts first`,
    };
  }
  const tfCache = readJsonOrNull<Record<string, TableTextFieldClassification>>(
    join(tfDir, `${baseId}.json`),
  );
  if (!tfCache) {
    return {
      baseId,
      peopleWritten: 0,
      companiesWritten: 0,
      entities: [],
      outputDir: join(runDir, "bases", baseId, "out"),
      skipped: true,
      reason: `Text-field-entity cache absent for ${baseId} — run classify-text-field-entities.mts first`,
    };
  }

  const interactionIds = Object.entries(stage0)
    .filter(([, c]) => c.type === "interaction")
    .map(([id]) => id);
  const tablesWithEntities = interactionIds.filter((id) => {
    const c = tfCache[id];
    return c && entityFields(c).length > 0;
  });

  if (tablesWithEntities.length === 0) {
    return {
      baseId,
      peopleWritten: 0,
      companiesWritten: 0,
      entities: [],
      outputDir: join(runDir, "bases", baseId, "out"),
      skipped: true,
      reason: `no interaction tables with classified person/company text fields in ${baseId}`,
    };
  }

  const token = resolveToken(env, configPath);
  const tables = await fetchTables(baseId, fetchImpl, token);
  const wantedTables = tables.filter((t) => tablesWithEntities.includes(t.id));

  const inputs: WalkInput[] = [];
  for (const t of wantedTables) {
    const records = await fetchAllRecords(baseId, t.id, fetchImpl, token);
    inputs.push({
      baseId,
      table: t,
      records,
      classification: tfCache[t.id],
    });
  }

  const { entities, warnings } = buildEntities(inputs);
  for (const w of warnings) warn(`extract-text-field-entities: ${w}`);

  const outputDir = join(runDir, "bases", baseId, "out");
  mkdirSync(outputDir, { recursive: true });
  const { peopleWritten, companiesWritten } = writeEntityPages(
    entities,
    outputDir,
    baseId,
    now(),
  );

  return {
    baseId,
    peopleWritten,
    companiesWritten,
    entities,
    outputDir,
    skipped: false,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const baseId = process.argv[2];
  if (!baseId) {
    process.stderr.write(
      "usage: bun run extract-text-field-entities.mts <base-id>\n",
    );
    process.exit(1);
  }
  try {
    const result = await extractTextFieldEntities(baseId);
    if (result.skipped) {
      process.stderr.write(`extract-text-field-entities: skipped — ${result.reason}\n`);
    } else {
      process.stderr.write(
        `extract-text-field-entities: ${result.peopleWritten} people, ${result.companiesWritten} companies → ${result.outputDir}\n`,
      );
    }
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`extract-text-field-entities: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
