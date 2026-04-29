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

interface MetaApiTablesResponse {
  tables: AirtableTable[];
}

export type ClusterType =
  | "crm"
  | "okr"
  | "decision"
  | "project"
  | "knowledge-note"
  | "orphan";

export interface Cluster {
  cluster_id: string;
  table_ids: string[];
  type: ClusterType;
  dominant_table: string;
}

export interface ClassifyOptions {
  fetch?: typeof globalThis.fetch;
  env?: Record<string, string | undefined>;
  configPath?: string;
  cacheDir?: string;
  runId?: string;
}

export interface ClassifyResult {
  clusters: Cluster[];
  cachePath: string;
}

const META_API_BASE = "https://api.airtable.com/v0/meta/bases";

// Patterns mirror references/cluster-heuristics.md — keep in lockstep.
const TYPE_PATTERNS: Array<{ type: Exclude<ClusterType, "orphan">; patterns: RegExp[] }> = [
  {
    type: "crm",
    patterns: [
      /\bcontact/i,
      /\bcompan(?:y|ies)\b/i,
      /\blead/i,
      /\bdeal/i,
      /\baccount/i,
      /\bcustomer/i,
    ],
  },
  {
    type: "okr",
    patterns: [/\bokrs?\b/i, /\bobjective/i, /\bkey result/i, /\bkrs?\b/i],
  },
  {
    type: "decision",
    patterns: [/\bdecision/i, /\badr\b/i],
  },
  {
    type: "project",
    patterns: [/\bproject/i, /\btask/i, /\bmilestone/i, /\bepic/i, /\bsprint/i],
  },
  {
    type: "knowledge-note",
    patterns: [/\bnote/i, /\barticle/i, /\bknowledge/i, /\bwiki\b/i, /\bdoc/i],
  },
];

function tableMatches(name: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(name));
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

export function buildLinkGraph(tables: AirtableTable[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const t of tables) adj.set(t.id, new Set());
  for (const t of tables) {
    for (const f of t.fields) {
      if (f.type !== "multipleRecordLinks") continue;
      const target = f.options?.linkedTableId;
      if (!target || target === t.id) continue;
      if (!adj.has(target)) adj.set(target, new Set());
      adj.get(t.id)!.add(target);
      adj.get(target)!.add(t.id);
    }
  }
  return adj;
}

export function findComponents(adj: Map<string, Set<string>>): string[][] {
  const seen = new Set<string>();
  const comps: string[][] = [];
  const startNodes = [...adj.keys()].sort();
  for (const start of startNodes) {
    if (seen.has(start)) continue;
    const comp: string[] = [];
    const stack = [start];
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      comp.push(n);
      for (const nbr of adj.get(n) ?? []) {
        if (!seen.has(nbr)) stack.push(nbr);
      }
    }
    comp.sort();
    comps.push(comp);
  }
  return comps;
}

function classifyCluster(
  tableIds: string[],
  byId: Map<string, AirtableTable>,
  adj: Map<string, Set<string>>,
): Pick<Cluster, "type" | "dominant_table"> {
  const tablesInCluster = tableIds.map((id) => byId.get(id)!);

  let bestType: Exclude<ClusterType, "orphan"> | null = null;
  let bestCount = 0;
  for (const { type, patterns } of TYPE_PATTERNS) {
    const matchCount = tablesInCluster.filter((t) => tableMatches(t.name, patterns)).length;
    if (matchCount > bestCount) {
      bestCount = matchCount;
      bestType = type;
    }
  }

  const finalType: ClusterType = bestType ?? "orphan";

  const candidates =
    finalType === "orphan"
      ? tablesInCluster
      : tablesInCluster.filter((t) =>
          tableMatches(t.name, TYPE_PATTERNS.find((p) => p.type === finalType)!.patterns),
        );

  const pickFrom = candidates.length > 0 ? candidates : tablesInCluster;
  const ranked = [...pickFrom].sort((a, b) => {
    const da = adj.get(a.id)?.size ?? 0;
    const db = adj.get(b.id)?.size ?? 0;
    if (db !== da) return db - da;
    return a.name.localeCompare(b.name);
  });

  return { type: finalType, dominant_table: ranked[0].id };
}

export async function classifyClusters(
  baseId: string,
  opts: ClassifyOptions = {},
): Promise<ClassifyResult> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const env = opts.env ?? process.env;
  const configPath = opts.configPath ?? join(homedir(), ".claude.json");
  const cacheDir =
    opts.cacheDir ?? join(homedir(), ".claude", "airtable-extract-cache");
  const runId = opts.runId ?? new Date().toISOString().replace(/[:.]/g, "-");

  const token = resolveToken(env, configPath);

  const url = `${META_API_BASE}/${encodeURIComponent(baseId)}/tables`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Airtable Meta API ${res.status}: ${text || res.statusText}`);
  }
  const body = (await res.json()) as MetaApiTablesResponse;
  const tables = body.tables ?? [];

  const adj = buildLinkGraph(tables);
  const components = findComponents(adj);
  const byId = new Map(tables.map((t) => [t.id, t]));

  const clusters: Cluster[] = components.map((tableIds, i) => {
    const { type, dominant_table } = classifyCluster(tableIds, byId, adj);
    return {
      cluster_id: `cluster-${i + 1}`,
      table_ids: tableIds,
      type,
      dominant_table,
    };
  });

  const runDir = join(cacheDir, runId);
  mkdirSync(runDir, { recursive: true });
  const cachePath = join(runDir, `clusters-${baseId}.json`);
  writeFileSync(cachePath, JSON.stringify(clusters, null, 2));

  return { clusters, cachePath };
}

if (import.meta.main) {
  const baseId = process.argv[2];
  if (!baseId) {
    process.stderr.write("usage: bun run classify-clusters.mts <base-id>\n");
    process.exit(1);
  }
  try {
    const { clusters } = await classifyClusters(baseId, {
      runId: process.env.AIRTABLE_RUN_ID,
    });
    process.stdout.write(JSON.stringify(clusters, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`classify-clusters: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
