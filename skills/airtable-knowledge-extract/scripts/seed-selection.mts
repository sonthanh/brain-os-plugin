#!/usr/bin/env bun
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AirtableField {
  id: string;
  name: string;
  type: string;
  options?: { linkedTableId?: string };
}

export interface AirtableTable {
  id: string;
  name: string;
  fields: AirtableField[];
}

export interface AirtableRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

interface MetaApiTablesResponse {
  tables: AirtableTable[];
}

interface RecordsApiResponse {
  records: AirtableRecord[];
  offset?: string;
}

export interface Cluster {
  cluster_id: string;
  table_ids: string[];
  type: string;
  dominant_table: string;
}

export interface SeedRecord {
  id: string;
  tableId: string;
  connectivity: number;
  updatedAt: string;
}

export interface SeedSelectionOptions {
  fetch?: typeof globalThis.fetch;
  env?: Record<string, string | undefined>;
  configPath?: string;
  cacheDir?: string;
  runId?: string;
  n?: number;
  archivedFieldNames?: string[];
}

export interface SeedSelectionResult {
  seeds: SeedRecord[];
  cachePath: string;
}

const DEFAULT_N = 10;
const DEFAULT_ARCHIVED_FIELDS = ["Archived", "archived"];
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

export function isEmpty(record: AirtableRecord): boolean {
  return Object.keys(record.fields).length === 0;
}

export function isArchived(
  record: AirtableRecord,
  archivedFieldNames: string[],
): boolean {
  for (const name of archivedFieldNames) {
    if (record.fields[name]) return true;
  }
  return false;
}

export function computeConnectivity(
  record: AirtableRecord,
  linkFieldNames: string[],
): number {
  let count = 0;
  for (const name of linkFieldNames) {
    const v = record.fields[name];
    if (Array.isArray(v) && v.length > 0) count++;
  }
  return count;
}

export function resolveUpdatedAt(
  record: AirtableRecord,
  lastModifiedFieldName?: string,
): string {
  if (lastModifiedFieldName) {
    const v = record.fields[lastModifiedFieldName];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return record.createdTime;
}

export function rankSeedRecords(
  records: SeedRecord[],
  n: number,
): SeedRecord[] {
  const sorted = [...records].sort((a, b) => {
    if (b.connectivity !== a.connectivity) return b.connectivity - a.connectivity;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt.localeCompare(a.updatedAt);
    return a.id.localeCompare(b.id);
  });
  return sorted.slice(0, n);
}

function loadCluster(
  cacheDir: string,
  runId: string,
  baseId: string,
  clusterId: string,
): Cluster {
  const path = join(cacheDir, runId, `clusters-${baseId}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `Cluster cache not found at ${path}. Run classify-clusters first for run-id=${runId}.`,
    );
  }
  const clusters = JSON.parse(readFileSync(path, "utf8")) as Cluster[];
  const cluster = clusters.find((c) => c.cluster_id === clusterId);
  if (!cluster) {
    throw new Error(`Cluster ${clusterId} not found in ${path}`);
  }
  return cluster;
}

async function fetchTables(
  fetchImpl: typeof globalThis.fetch,
  baseId: string,
  token: string,
): Promise<AirtableTable[]> {
  const url = `${META_API_BASE}/${encodeURIComponent(baseId)}/tables`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Airtable Meta API ${res.status}: ${text || res.statusText}`);
  }
  const body = (await res.json()) as MetaApiTablesResponse;
  return body.tables ?? [];
}

async function fetchRecords(
  fetchImpl: typeof globalThis.fetch,
  baseId: string,
  tableId: string,
  token: string,
): Promise<AirtableRecord[]> {
  const out: AirtableRecord[] = [];
  let offset: string | undefined;
  do {
    const url = new URL(
      `${RECORDS_API_BASE}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}`,
    );
    if (offset) url.searchParams.set("offset", offset);
    const res = await fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Airtable Records API ${res.status}: ${text || res.statusText}`,
      );
    }
    const body = (await res.json()) as RecordsApiResponse;
    out.push(...(body.records ?? []));
    offset = body.offset;
  } while (offset);
  return out;
}

export async function seedSelection(
  baseId: string,
  clusterId: string,
  opts: SeedSelectionOptions = {},
): Promise<SeedSelectionResult> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const env = opts.env ?? process.env;
  const configPath = opts.configPath ?? join(homedir(), ".claude.json");
  const cacheDir =
    opts.cacheDir ?? join(homedir(), ".claude", "airtable-extract-cache");
  const runId = opts.runId ?? env.AIRTABLE_RUN_ID;
  if (!runId) {
    throw new Error(
      "runId required (set AIRTABLE_RUN_ID or pass opts.runId).",
    );
  }
  const n = opts.n ?? DEFAULT_N;
  const archivedFieldNames = opts.archivedFieldNames ?? DEFAULT_ARCHIVED_FIELDS;

  const cluster = loadCluster(cacheDir, runId, baseId, clusterId);
  const token = resolveToken(env, configPath);
  const tables = await fetchTables(fetchImpl, baseId, token);
  const byId = new Map(tables.map((t) => [t.id, t]));

  const candidates: SeedRecord[] = [];
  for (const tableId of cluster.table_ids) {
    const table = byId.get(tableId);
    if (!table) continue;

    const linkFieldNames = table.fields
      .filter((f) => f.type === "multipleRecordLinks")
      .map((f) => f.name);
    const lastModifiedField = table.fields.find(
      (f) => f.type === "lastModifiedTime",
    )?.name;

    const records = await fetchRecords(fetchImpl, baseId, tableId, token);
    for (const rec of records) {
      if (isEmpty(rec)) continue;
      if (isArchived(rec, archivedFieldNames)) continue;
      candidates.push({
        id: rec.id,
        tableId,
        connectivity: computeConnectivity(rec, linkFieldNames),
        updatedAt: resolveUpdatedAt(rec, lastModifiedField),
      });
    }
  }

  const seeds = rankSeedRecords(candidates, n);

  const runDir = join(cacheDir, runId);
  mkdirSync(runDir, { recursive: true });
  const cachePath = join(runDir, `seed-records-${baseId}-${clusterId}.json`);
  writeFileSync(cachePath, JSON.stringify(seeds, null, 2));

  return { seeds, cachePath };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const positional: string[] = [];
  let nFlag = DEFAULT_N;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-n" || a === "--n") {
      const next = args[++i];
      const parsed = Number.parseInt(next ?? "", 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        process.stderr.write(`seed-selection: invalid -n value: ${next}\n`);
        process.exit(1);
      }
      nFlag = parsed;
    } else {
      positional.push(a);
    }
  }
  const [baseId, clusterId] = positional;
  if (!baseId || !clusterId) {
    process.stderr.write(
      "usage: bun run seed-selection.mts <base-id> <cluster-id> [-n N]\n",
    );
    process.exit(1);
  }
  try {
    const { seeds } = await seedSelection(baseId, clusterId, {
      runId: process.env.AIRTABLE_RUN_ID,
      n: nFlag,
    });
    process.stdout.write(JSON.stringify(seeds, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`seed-selection: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
