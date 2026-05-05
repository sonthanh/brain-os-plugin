#!/usr/bin/env bun
/**
 * extract-single-pass.mts — Stage D4 single-pass entity extractor
 * (ai-brain#243, parent #237 AC#8).
 *
 * One Sonnet call per cluster. No anchor / no seed. Inputs: full cluster schema +
 * records + cross-table link context. Output: one entity page per entity-table
 * record with `source_record_id` matching its OWN record (NOT a seed) — replaces
 * the per-seed loop that produced the #234/#236 cross-table provenance bugs.
 *
 * Routing: invoked by S4 dispatcher (`dispatcher.mts`) when a connected component
 * has `entity_strategy = single-pass`. Component metadata (entity vs interaction
 * tables) is read from the dispatch cache `dispatch-<base_id>.json`.
 *
 * Subgraph: includes BOTH entity-table records AND interaction-table records.
 * Interaction records are context-only — only entity-table records produce
 * entity pages. Sonnet sees the full cluster so cross-table link context is
 * preserved (a person's `WorksAt` link → company entity in the same call).
 *
 * Reverse-lookup: each Sonnet-claimed `source_record_ids` is dropped and recomputed
 * via slug match against entity-table records (reuses
 * `findSourceRecordByEntity` from extract-slice.mts). This is the architectural
 * fix for #234/#236: the per-seed prompt was the source of bias; the slug
 * reverse-lookup discipline is sound and is reused verbatim.
 *
 * Cross-cluster overlap dedup: `out/<type>/<slug>.md` is keyed on slug; running
 * extract-single-pass on two components that produce the same slug → second run
 * overwrites (filesystem-level last-write-wins). No manifest. The within-call
 * dedup (`dedupEntitiesByRecordId`) handles the rare Sonnet duplicate-slug case
 * by keeping the last entity per `source_record_id`.
 *
 * CLI: `bun run extract-single-pass.mts <component_id>`
 *   Reads `AIRTABLE_BASE_ID` (required) and `AIRTABLE_RUN_ID` (default: today's
 *   UTC date suffixed with `-airtable-extract`, mirrors dispatcher.mts) from env.
 *   Loads dispatch-<baseId>.json, finds <component_id>, fetches Airtable Meta +
 *   Records, runs the single Sonnet pass, writes entity pages.
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
import type { ComponentDispatch } from "./dispatcher.mts";
import type { AirtableRecord } from "./legacy-link-detector.mts";
import {
  airtableRecordUrl,
  buildSlugMap,
  buildSubgraphContext,
  extractAiFields,
  extractAttachments,
  findRelatedWikilinks,
  findSourceRecordByEntity,
  parsePromptVariants,
  parseSonnetEntityResponse,
  parseStreamJsonLines,
  renderPrompt,
  slugify,
  SliceRejectedError,
  type AiFieldEntry,
  type ExtractedEntity,
  type RelatedLink,
  type SonnetResponse,
  type SonnetRunner,
} from "./extract-slice.mts";

const META_API_BASE = "https://api.airtable.com/v0/meta/bases";
const RECORDS_API_BASE = "https://api.airtable.com/v0";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const PROMPT_VARIANT = "single-pass";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractSinglePassInput {
  baseId: string;
  componentId: string;
  /** Tables in the component classified `entity` (Stage 0) — produce entity pages. */
  entityTables: string[];
  /** Tables classified `interaction` — context-only in the subgraph, no entity pages. */
  interactionTables: string[];
}

export interface ExtractSinglePassDeps {
  fetch?: typeof globalThis.fetch;
  runSonnet?: SonnetRunner;
  env?: Record<string, string | undefined>;
  configPath?: string;
  cacheDir?: string;
  runId?: string;
  promptsPath?: string;
  now?: () => string;
  warn?: (msg: string) => void;
}

export interface ExtractSinglePassResult {
  entities: ExtractedEntity[];
  entityPaths: string[];
  /** Always 0 (empty entity-table list) or 1 (one Sonnet call per cluster — AC#1). */
  sonnetCallCount: number;
  estimatedPromptTokens: number;
  outDir: string;
  costMeterPath: string;
  manifestPath: string;
}

interface MetaApiTablesResponse {
  tables: AirtableTable[];
}

interface RecordsApiResponse {
  records: AirtableRecord[];
  offset?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Within one Sonnet output, keep the last entity per `source_record_ids[0]`.
 * Drops entities with empty `source_record_ids` (caller already failed reverse-
 * lookup or Sonnet returned no IDs and the lenient parser inserted []).
 *
 * Cross-cluster (run-level) dedup is a separate concern handled at the file
 * level: `<outDir>/<type>/<slug>.md` writes overwrite naturally.
 */
export function dedupEntitiesByRecordId(
  entities: ExtractedEntity[],
): ExtractedEntity[] {
  const order: string[] = [];
  const byId = new Map<string, ExtractedEntity>();
  for (const e of entities) {
    const id = e.source_record_ids[0];
    if (!id) continue;
    if (!byId.has(id)) order.push(id);
    byId.set(id, e);
  }
  return order.map((id) => byId.get(id)!);
}

// ---------------------------------------------------------------------------
// Airtable I/O (mirrors extract-slice.mts but accepts a precomputed table set)
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

// ---------------------------------------------------------------------------
// Markdown render (single-pass variant — no seed_record_id, uses component_id)
// ---------------------------------------------------------------------------

function yamlScalar(v: unknown): string {
  if (v == null) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return JSON.stringify(String(v));
}

interface EntityRenderExtras {
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
  input: ExtractSinglePassInput,
  ts: string,
  extras: EntityRenderExtras,
): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`type: ${e.type}`);
  lines.push(`slug: ${e.slug}`);
  lines.push(`base_id: ${input.baseId}`);
  lines.push(`component_id: ${input.componentId}`);
  lines.push(`source_record_id: ${extras.source_record_id}`);
  if (extras.source_table) {
    lines.push(`source_table: ${yamlScalar(extras.source_table)}`);
  }
  if (extras.source_url) {
    lines.push(`source_url: ${yamlScalar(extras.source_url)}`);
  }
  lines.push(`extracted_at: ${ts}`);
  lines.push(`extraction_strategy: single-pass`);
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

// ---------------------------------------------------------------------------
// Sonnet runner default (real subprocess) — same shape as extract-slice.mts
// ---------------------------------------------------------------------------

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

function defaultPromptsPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "prompts", "extract.md");
}

function defaultRunId(env: Record<string, string | undefined>): string {
  if (env.AIRTABLE_RUN_ID) return env.AIRTABLE_RUN_ID;
  return `${new Date().toISOString().slice(0, 10)}-airtable-extract`;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function extractSinglePass(
  input: ExtractSinglePassInput,
  opts: ExtractSinglePassDeps = {},
): Promise<ExtractSinglePassResult> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const configPath = opts.configPath ?? join(homedir(), ".claude.json");
  const cacheDir =
    opts.cacheDir ?? join(homedir(), ".claude", "airtable-extract-cache");
  const runId = opts.runId ?? defaultRunId(env);
  const promptsPath = opts.promptsPath ?? defaultPromptsPath();
  const runSonnet = opts.runSonnet ?? spawnClaudeSonnet;
  const now = opts.now ?? (() => new Date().toISOString());
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`));

  const runDir = join(cacheDir, runId);
  const outDir = join(runDir, "out");
  const sliceCacheDir = join(runDir, "single-pass-cache");
  const costMeterPath = join(runDir, "cost-meter.jsonl");
  const manifestPath = join(sliceCacheDir, `${input.componentId}.json`);

  mkdirSync(sliceCacheDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  if (input.entityTables.length === 0) {
    warn(
      `extract-single-pass: component ${input.componentId} has no entity tables — skipping (interaction tables route through edge-emit).`,
    );
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          component_id: input.componentId,
          base_id: input.baseId,
          entity_tables: [],
          interaction_tables: input.interactionTables,
          entities: [],
          entity_paths: [],
          sonnet_call_count: 0,
          estimated_prompt_tokens: 0,
          extracted_at: now(),
        },
        null,
        2,
      ),
    );
    return {
      entities: [],
      entityPaths: [],
      sonnetCallCount: 0,
      estimatedPromptTokens: 0,
      outDir,
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

  const allTableIds = [...input.entityTables, ...input.interactionTables];
  const recordsById = new Map<string, AirtableRecord>();
  const recordToTable = new Map<string, string>();
  for (const tId of allTableIds) {
    const t = tablesById.get(tId);
    if (!t) {
      warn(`extract-single-pass: table ${tId} missing from Meta API response — skipping`);
      continue;
    }
    const recs = await fetchAllRecords(input.baseId, tId, token, fetchImpl);
    for (const r of recs) {
      recordsById.set(r.id, r);
      recordToTable.set(r.id, tId);
    }
  }

  const entityTableSet = new Set(input.entityTables);
  const entityRecordsById = new Map<string, AirtableRecord>();
  const entityRecordToTable = new Map<string, string>();
  for (const [id, rec] of recordsById) {
    const tId = recordToTable.get(id);
    if (tId && entityTableSet.has(tId)) {
      entityRecordsById.set(id, rec);
      entityRecordToTable.set(id, tId);
    }
  }

  const subgraph = buildSubgraphContext(
    recordsById,
    new Set(recordsById.keys()),
    tablesById,
    recordToTable,
  );

  const promptsContent = readFileSync(promptsPath, "utf8");
  const variants = parsePromptVariants(promptsContent);
  const variant = variants.get(PROMPT_VARIANT);
  if (!variant) {
    throw new Error(
      `prompt variant '${PROMPT_VARIANT}' missing in ${promptsPath}`,
    );
  }
  const prompt = renderPrompt(variant, {
    clusterType: PROMPT_VARIANT,
    clusterId: input.componentId,
    seedRecordId: "",
    subgraph,
  });
  const estimatedPromptTokens = Math.ceil(prompt.length / 4);

  const sonnetResp = await runSonnet(prompt, DEFAULT_MODEL);
  const sonnetCallCount = 1;
  const rawEntities = parseSonnetEntityResponse(sonnetResp.rawText);

  // Reverse-lookup each entity against the entity-table records only.
  // Interaction-table records are context for the LLM but never the source of
  // an entity page (they flow through the deterministic edge emitter).
  const resolved: ExtractedEntity[] = [];
  for (const e of rawEntities) {
    const dropped = e.source_record_ids.filter((id) => !entityRecordsById.has(id));
    if (dropped.length > 0) {
      warn(
        `extract-single-pass: entity '${e.slug}' had hallucinated/non-entity source IDs ${JSON.stringify(dropped)} — dropped`,
      );
    }
    const lookup = findSourceRecordByEntity(
      e,
      entityRecordsById,
      entityRecordToTable,
      tablesById,
    );
    if (lookup.reason !== "match" || !lookup.recordId) {
      throw new SliceRejectedError(e, lookup);
    }
    resolved.push({ ...e, source_record_ids: [lookup.recordId] });
  }

  const deduped = dedupEntitiesByRecordId(resolved);

  // Cost meter — one event per Sonnet call.
  const costEvent: Record<string, unknown> = {
    ts: now(),
    model: sonnetResp.model,
    input_tokens: sonnetResp.usage.input_tokens,
    output_tokens: sonnetResp.usage.output_tokens,
    component_id: input.componentId,
    strategy: "single-pass",
  };
  if (sonnetResp.usage.cache_creation_input_tokens != null) {
    costEvent.cache_creation_input_tokens = sonnetResp.usage.cache_creation_input_tokens;
  }
  if (sonnetResp.usage.cache_read_input_tokens != null) {
    costEvent.cache_read_input_tokens = sonnetResp.usage.cache_read_input_tokens;
  }
  appendFileSync(costMeterPath, `${JSON.stringify(costEvent)}\n`);

  const ts = now();
  const slugMap = buildSlugMap(deduped);
  const entityPaths: string[] = [];
  for (const e of deduped) {
    const primarySourceId = e.source_record_ids[0];
    const primaryTableId = entityRecordToTable.get(primarySourceId) ?? null;
    const primaryTable = primaryTableId ? tablesById.get(primaryTableId) ?? null : null;

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
      source_table: primaryTable?.name ?? null,
      source_url: primaryTableId
        ? airtableRecordUrl(input.baseId, primaryTableId, primarySourceId)
        : null,
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
    component_id: input.componentId,
    base_id: input.baseId,
    entity_tables: input.entityTables,
    interaction_tables: input.interactionTables,
    entities: deduped,
    entity_paths: entityPaths,
    sonnet_call_count: sonnetCallCount,
    estimated_prompt_tokens: estimatedPromptTokens,
    extracted_at: ts,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    entities: deduped,
    entityPaths,
    sonnetCallCount,
    estimatedPromptTokens,
    outDir,
    costMeterPath,
    manifestPath,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function loadComponentDispatch(
  cacheDir: string,
  runId: string,
  baseId: string,
  componentId: string,
): ComponentDispatch {
  const dispatchPath = join(cacheDir, runId, `dispatch-${baseId}.json`);
  if (!existsSync(dispatchPath)) {
    throw new Error(
      `extract-single-pass: dispatch cache not found at ${dispatchPath}. ` +
        `Run \`bun run dispatcher.mts ${baseId}\` first (with AIRTABLE_RUN_ID=${runId}).`,
    );
  }
  const dispatches = JSON.parse(readFileSync(dispatchPath, "utf8")) as ComponentDispatch[];
  const match = dispatches.find((d) => d.component_id === componentId);
  if (!match) {
    throw new Error(
      `extract-single-pass: component ${componentId} not found in ${dispatchPath}. ` +
        `Available: ${dispatches.map((d) => d.component_id).join(", ")}`,
    );
  }
  if (match.entity_strategy !== "single-pass") {
    throw new Error(
      `extract-single-pass: component ${componentId} routed to '${match.entity_strategy}', not 'single-pass'. ` +
        `Run the matching strategy script instead.`,
    );
  }
  return match;
}

if (import.meta.main) {
  const componentId = process.argv[2];
  if (!componentId) {
    process.stderr.write("usage: bun run extract-single-pass.mts <component_id>\n");
    process.stderr.write("  env: AIRTABLE_BASE_ID (required), AIRTABLE_RUN_ID (optional)\n");
    process.exit(1);
  }
  const env = process.env;
  const baseId = env.AIRTABLE_BASE_ID;
  if (!baseId) {
    process.stderr.write(
      "extract-single-pass: AIRTABLE_BASE_ID env var is required\n",
    );
    process.exit(1);
  }
  const runId = env.AIRTABLE_RUN_ID ?? defaultRunId(env);
  const cacheDir = join(homedir(), ".claude", "airtable-extract-cache");

  try {
    const dispatch = loadComponentDispatch(cacheDir, runId, baseId, componentId);
    const result = await extractSinglePass(
      {
        baseId,
        componentId: dispatch.component_id,
        entityTables: dispatch.entity_tables,
        interactionTables: dispatch.interaction_tables,
      },
      { runId, cacheDir },
    );
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`extract-single-pass: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
