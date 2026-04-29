#!/usr/bin/env bun
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildLinkGraph,
  findComponents,
  type AirtableTable,
} from "./classify-clusters.mts";

export interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
  createdTime?: string;
}

interface MetaApiTablesResponse {
  tables: AirtableTable[];
}

interface RecordsApiResponse {
  records: AirtableRecord[];
  offset?: string;
}

export interface LegacyLinkEdge {
  sourceTableId: string;
  sourceTableName: string;
  sourceFieldId: string;
  sourceFieldName: string;
  targetTableId: string;
  targetTableName: string;
  totalSourceRecords: number;
  linkedCount: number;
  sparseRatio: number;
  sparse: boolean;
  targetEmpty: boolean;
  targetArchived: boolean;
  broken: boolean;
  legacy: boolean;
  sourceClusterId: string;
  targetClusterId: string;
}

export interface PrunedCluster {
  cluster_id: string;
  table_ids: string[];
}

export interface DetectLegacyLinksOptions {
  fetch?: typeof globalThis.fetch;
  env?: Record<string, string | undefined>;
  configPath?: string;
  cacheDir?: string;
  runId?: string;
  sparseThreshold?: number;
}

export interface DetectLegacyLinksResult {
  edges: LegacyLinkEdge[];
  legacyEdges: LegacyLinkEdge[];
  prunedClusters: PrunedCluster[];
  metricsPath: string;
  cleanupPath: string;
}

const META_API_BASE = "https://api.airtable.com/v0/meta/bases";
const RECORDS_API_BASE = "https://api.airtable.com/v0";
const DEFAULT_SPARSE_THRESHOLD = 0.1;
const ARCHIVED_FIELD_PATTERN = /^(archived?|is.?archived)$/i;

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

function isTruthy(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  return false;
}

function isRecordArchived(rec: AirtableRecord): boolean {
  for (const [k, v] of Object.entries(rec.fields ?? {})) {
    if (ARCHIVED_FIELD_PATTERN.test(k) && isTruthy(v)) return true;
  }
  return false;
}

export interface SparseEdgeStats {
  totalSourceRecords: number;
  linkedCount: number;
  sparseRatio: number;
  sparse: boolean;
}

export function computeSparseEdge(
  sourceRecords: AirtableRecord[],
  fieldName: string,
  threshold: number,
): SparseEdgeStats {
  const total = sourceRecords.length;
  if (total === 0) {
    return { totalSourceRecords: 0, linkedCount: 0, sparseRatio: 0, sparse: true };
  }
  const linked = sourceRecords.filter((r) => {
    const v = r.fields?.[fieldName];
    return Array.isArray(v) && v.length > 0;
  }).length;
  const ratio = linked / total;
  return {
    totalSourceRecords: total,
    linkedCount: linked,
    sparseRatio: ratio,
    sparse: ratio < threshold,
  };
}

export interface BrokenTargetStats {
  empty: boolean;
  archived: boolean;
  broken: boolean;
}

export function assessBrokenTarget(records: AirtableRecord[]): BrokenTargetStats {
  if (records.length === 0) {
    return { empty: true, archived: false, broken: true };
  }
  const empty = records.every((r) => Object.keys(r.fields ?? {}).length === 0);
  const archived = !empty && records.every((r) => isRecordArchived(r));
  return { empty, archived, broken: empty || archived };
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

interface RawEdge {
  sourceTableId: string;
  sourceTableName: string;
  sourceFieldId: string;
  sourceFieldName: string;
  targetTableId: string;
  targetTableName: string;
}

function enumerateEdges(tables: AirtableTable[]): RawEdge[] {
  const byId = new Map(tables.map((t) => [t.id, t]));
  const edges: RawEdge[] = [];
  for (const t of tables) {
    for (const f of t.fields) {
      if (f.type !== "multipleRecordLinks") continue;
      const targetId = f.options?.linkedTableId;
      if (!targetId || targetId === t.id) continue;
      const target = byId.get(targetId);
      if (!target) continue;
      edges.push({
        sourceTableId: t.id,
        sourceTableName: t.name,
        sourceFieldId: f.id,
        sourceFieldName: f.name,
        targetTableId: target.id,
        targetTableName: target.name,
      });
    }
  }
  return edges;
}

function clusterIdByTable(comps: string[][]): Map<string, string> {
  const m = new Map<string, string>();
  comps.forEach((tableIds, i) => {
    const id = `cluster-${i + 1}`;
    for (const t of tableIds) m.set(t, id);
  });
  return m;
}

function suggestedAction(edge: LegacyLinkEdge): string {
  if (edge.targetEmpty && edge.targetArchived) {
    return `Drop the \`${edge.sourceFieldName}\` field on \`${edge.sourceTableName}\` AND archive/delete the \`${edge.targetTableName}\` table.`;
  }
  if (edge.targetEmpty) {
    return `Drop the \`${edge.sourceFieldName}\` field on \`${edge.sourceTableName}\` — \`${edge.targetTableName}\` has no usable records.`;
  }
  if (edge.targetArchived) {
    return `Drop the \`${edge.sourceFieldName}\` field on \`${edge.sourceTableName}\`, or migrate the ${edge.linkedCount} linking record(s) to the active table.`;
  }
  return `Review the \`${edge.sourceFieldName}\` link from \`${edge.sourceTableName}\`.`;
}

function renderCleanupMarkdown(
  baseId: string,
  threshold: number,
  edges: LegacyLinkEdge[],
  legacyEdges: LegacyLinkEdge[],
): string {
  const lines: string[] = [];
  lines.push(`# Airtable cleanup tasks — base \`${baseId}\``);
  lines.push("");
  lines.push(
    `Detected **${legacyEdges.length} legacy** link edge(s) out of ${edges.length} total. ` +
      `Each is sparse (<${(threshold * 100).toFixed(1)}% of source records carry it) AND broken (target empty or archived).`,
  );
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Base: \`${baseId}\``);
  lines.push(`- Sparse threshold: <${(threshold * 100).toFixed(1)}%`);
  lines.push(`- Total edges scanned: ${edges.length}`);
  lines.push(`- Legacy edges: ${legacyEdges.length}`);
  lines.push("");

  if (legacyEdges.length === 0) {
    lines.push("## Cleanup recommendations");
    lines.push("");
    lines.push("_None — no legacy edges detected._");
    lines.push("");
    return lines.join("\n");
  }

  lines.push("## Cleanup recommendations");
  lines.push("");

  const bySource = new Map<string, LegacyLinkEdge[]>();
  for (const e of legacyEdges) {
    if (!bySource.has(e.sourceTableId)) bySource.set(e.sourceTableId, []);
    bySource.get(e.sourceTableId)!.push(e);
  }
  const sourceIds = [...bySource.keys()].sort((a, b) => {
    const na = bySource.get(a)![0].sourceTableName;
    const nb = bySource.get(b)![0].sourceTableName;
    return na.localeCompare(nb);
  });

  for (const sId of sourceIds) {
    const group = bySource.get(sId)!;
    lines.push(`### From \`${group[0].sourceTableName}\``);
    lines.push("");
    for (const e of group) {
      const reasons: string[] = [];
      if (e.targetEmpty) reasons.push("target has no usable records");
      if (e.targetArchived) reasons.push("all target records flagged archived");
      const ratioPct = e.totalSourceRecords > 0 ? (e.sparseRatio * 100).toFixed(1) : "0.0";
      lines.push(
        `- **\`${e.sourceFieldName}\` → \`${e.targetTableName}\`** — ${e.linkedCount} of ${e.totalSourceRecords} records carry this link (${ratioPct}%). ` +
          (reasons.length ? `Target broken: ${reasons.join(", ")}. ` : "") +
          `Suggested action: ${suggestedAction(e)}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

export async function detectLegacyLinks(
  baseId: string,
  opts: DetectLegacyLinksOptions = {},
): Promise<DetectLegacyLinksResult> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const env = opts.env ?? process.env;
  const configPath = opts.configPath ?? join(homedir(), ".claude.json");
  const cacheDir =
    opts.cacheDir ?? join(homedir(), ".claude", "airtable-extract-cache");
  const runId = opts.runId ?? new Date().toISOString().replace(/[:.]/g, "-");
  const threshold = opts.sparseThreshold ?? DEFAULT_SPARSE_THRESHOLD;

  const token = resolveToken(env, configPath);

  const metaUrl = `${META_API_BASE}/${encodeURIComponent(baseId)}/tables`;
  const metaRes = await fetchImpl(metaUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!metaRes.ok) {
    const text = await metaRes.text().catch(() => "");
    throw new Error(`Airtable Meta API ${metaRes.status}: ${text || metaRes.statusText}`);
  }
  const metaBody = (await metaRes.json()) as MetaApiTablesResponse;
  const tables = metaBody.tables ?? [];

  const rawEdges = enumerateEdges(tables);

  const tableIdsToFetch = new Set<string>();
  for (const e of rawEdges) {
    tableIdsToFetch.add(e.sourceTableId);
    tableIdsToFetch.add(e.targetTableId);
  }
  const recordsByTable = new Map<string, AirtableRecord[]>();
  for (const tId of tableIdsToFetch) {
    recordsByTable.set(tId, await fetchAllRecords(baseId, tId, token, fetchImpl));
  }

  const edges: LegacyLinkEdge[] = rawEdges.map((re) => {
    const sparseStats = computeSparseEdge(
      recordsByTable.get(re.sourceTableId) ?? [],
      re.sourceFieldName,
      threshold,
    );
    const brokenStats = assessBrokenTarget(recordsByTable.get(re.targetTableId) ?? []);
    return {
      ...re,
      ...sparseStats,
      targetEmpty: brokenStats.empty,
      targetArchived: brokenStats.archived,
      broken: brokenStats.broken,
      legacy: sparseStats.sparse && brokenStats.broken,
      sourceClusterId: "",
      targetClusterId: "",
    };
  });

  const prunedAdj = buildLinkGraph(tables);
  for (const e of edges) {
    if (!e.legacy) continue;
    prunedAdj.get(e.sourceTableId)?.delete(e.targetTableId);
    prunedAdj.get(e.targetTableId)?.delete(e.sourceTableId);
  }
  const prunedComponents = findComponents(prunedAdj);
  const prunedClusters: PrunedCluster[] = prunedComponents.map((tableIds, i) => ({
    cluster_id: `cluster-${i + 1}`,
    table_ids: tableIds,
  }));
  const clusterByTable = clusterIdByTable(prunedComponents);
  for (const e of edges) {
    e.sourceClusterId = clusterByTable.get(e.sourceTableId) ?? "";
    e.targetClusterId = clusterByTable.get(e.targetTableId) ?? "";
  }

  const legacyEdges = edges.filter((e) => e.legacy);

  const runDir = join(cacheDir, runId);
  const metricsDir = join(runDir, "metrics");
  const outDir = join(runDir, "out");
  mkdirSync(metricsDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  const metricsPath = join(metricsDir, "legacy-links.json");
  const cleanupPath = join(outDir, "airtable-cleanup-tasks.md");

  const metricsBody = {
    base_id: baseId,
    sparse_threshold: threshold,
    total_edges: edges.length,
    legacy_count: legacyEdges.length,
    edges: edges.map((e) => ({
      source_table_id: e.sourceTableId,
      source_table_name: e.sourceTableName,
      source_field_id: e.sourceFieldId,
      source_field_name: e.sourceFieldName,
      target_table_id: e.targetTableId,
      target_table_name: e.targetTableName,
      total_source_records: e.totalSourceRecords,
      linked_count: e.linkedCount,
      sparse_ratio: e.sparseRatio,
      sparse: e.sparse,
      target_empty: e.targetEmpty,
      target_archived: e.targetArchived,
      broken: e.broken,
      legacy: e.legacy,
      source_cluster_id: e.sourceClusterId,
      target_cluster_id: e.targetClusterId,
    })),
    pruned_clusters: prunedClusters,
  };
  writeFileSync(metricsPath, JSON.stringify(metricsBody, null, 2));
  writeFileSync(cleanupPath, renderCleanupMarkdown(baseId, threshold, edges, legacyEdges));

  return { edges, legacyEdges, prunedClusters, metricsPath, cleanupPath };
}

if (import.meta.main) {
  const baseId = process.argv[2];
  if (!baseId) {
    process.stderr.write("usage: bun run legacy-link-detector.mts <base-id>\n");
    process.exit(1);
  }
  try {
    const { legacyEdges, prunedClusters, metricsPath, cleanupPath } = await detectLegacyLinks(baseId, {
      runId: process.env.AIRTABLE_RUN_ID,
    });
    process.stdout.write(
      JSON.stringify(
        { legacy_count: legacyEdges.length, pruned_clusters: prunedClusters, metricsPath, cleanupPath },
        null,
        2,
      ) + "\n",
    );
  } catch (err) {
    process.stderr.write(`legacy-link-detector: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
