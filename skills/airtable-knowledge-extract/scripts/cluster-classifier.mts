#!/usr/bin/env bun
/**
 * cluster-classifier.mts — Cluster shape classifier (ai-brain#240).
 *
 * Builds the connected-component graph from `multipleRecordLinks` fields across
 * EVERY table in a base (no Stage 0 type filter — partition by type happens
 * downstream at the S4 dispatcher) and assigns each component a topological
 * shape from the locked vocabulary:
 *
 *   orphan     — single isolated table (size = 1, no edges)
 *   pair       — exactly 2 tables joined by 1 edge
 *   hub-spoke  — star (one node connected to every other; max degree = N - 1).
 *                For N = 3 trees both endpoints/center collapse to this — the
 *                middle node IS the natural hub anchor for the 1-pass strategy.
 *   chain      — path graph with no central hub (max degree ≤ 2, N ≥ 4)
 *   tree       — acyclic with branching (max degree ≥ 3 but < N - 1)
 *   graph      — has a cycle (E > N - 1) or any topology not matching the above
 *
 * Output JSON: `[{ component_id, tables, shape, size }]`. Cached at
 * `~/.claude/airtable-extract-cache/<run-id>/cluster-shapes-<base-id>.json`.
 *
 * The graph builder + component finder are reused from `classify-clusters.mts`
 * (same edge-extraction semantics — `multipleRecordLinks` only, ignore self-
 * links, ignore lookup/rollup field types). This script only adds the shape
 * label.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildLinkGraph,
  findComponents,
  type AirtableTable,
} from "./classify-clusters.mts";

export type ClusterShape =
  | "orphan"
  | "pair"
  | "chain"
  | "tree"
  | "hub-spoke"
  | "graph";

export interface ClusterShapeComponent {
  component_id: string;
  tables: string[];
  shape: ClusterShape;
  size: number;
}

export interface ClassifyShapeOptions {
  fetch?: typeof globalThis.fetch;
  env?: Record<string, string | undefined>;
  configPath?: string;
  cacheDir?: string;
  runId?: string;
}

export interface ClassifyShapeResult {
  components: ClusterShapeComponent[];
  cachePath: string;
}

interface MetaApiTablesResponse {
  tables: AirtableTable[];
}

const META_API_BASE = "https://api.airtable.com/v0/meta/bases";

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

export interface ShapeMetrics {
  size: number;
  edges: number;
  maxDegree: number;
}

/**
 * Pure shape classifier. Decision order matters:
 *   1. orphan / pair are size-pinned base cases.
 *   2. E > N - 1                  ⇒ has a cycle ⇒ graph.
 *   3. tree (E == N - 1):
 *      a. max_degree == N - 1     ⇒ hub-spoke (one node connects to every
 *         other). For N = 3 this collapses path and star to hub-spoke — both
 *         topologies have a natural center node, which is what downstream
 *         dispatchers want to seed the 1-pass strategy on.
 *      b. max_degree ≤ 2          ⇒ chain (path graph). Only reachable for
 *         N ≥ 4 since hub-spoke caught all smaller trees.
 *      c. otherwise               ⇒ tree (general acyclic with branching).
 *   4. fallback ⇒ graph (defensive — should not be reached given (1)–(3)).
 */
export function classifyShape({ size, edges, maxDegree }: ShapeMetrics): ClusterShape {
  if (size <= 0) return "graph";
  if (size === 1) return "orphan";
  if (size === 2) return "pair";
  if (edges > size - 1) return "graph";
  if (edges === size - 1) {
    if (maxDegree === size - 1) return "hub-spoke";
    if (maxDegree <= 2) return "chain";
    return "tree";
  }
  return "graph";
}

function componentMetrics(
  componentTables: string[],
  adj: Map<string, Set<string>>,
): ShapeMetrics {
  let edges = 0;
  let maxDegree = 0;
  const inComp = new Set(componentTables);
  for (const t of componentTables) {
    const deg = adj.get(t)?.size ?? 0;
    if (deg > maxDegree) maxDegree = deg;
    for (const nbr of adj.get(t) ?? []) {
      // Each undirected edge counted twice across the loop; halve at end.
      // Restrict to in-component pairs (defensive — components are by
      // construction self-contained, but cheap to assert).
      if (inComp.has(nbr)) edges++;
    }
  }
  return { size: componentTables.length, edges: edges / 2, maxDegree };
}

export async function classifyClusterShapes(
  baseId: string,
  opts: ClassifyShapeOptions = {},
): Promise<ClassifyShapeResult> {
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
  const componentLists = findComponents(adj);

  const components: ClusterShapeComponent[] = componentLists.map(
    (componentTables, i) => {
      const metrics = componentMetrics(componentTables, adj);
      return {
        component_id: `component-${i + 1}`,
        tables: componentTables,
        shape: classifyShape(metrics),
        size: metrics.size,
      };
    },
  );

  const runDir = join(cacheDir, runId);
  mkdirSync(runDir, { recursive: true });
  const cachePath = join(runDir, `cluster-shapes-${baseId}.json`);
  writeFileSync(cachePath, JSON.stringify(components, null, 2));

  return { components, cachePath };
}

if (import.meta.main) {
  const baseId = process.argv[2];
  if (!baseId) {
    process.stderr.write("usage: bun run cluster-classifier.mts <base-id>\n");
    process.exit(1);
  }
  try {
    const { components } = await classifyClusterShapes(baseId, {
      runId: process.env.AIRTABLE_RUN_ID,
    });
    process.stdout.write(JSON.stringify(components, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`cluster-classifier: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
