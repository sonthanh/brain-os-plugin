#!/usr/bin/env bun
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listBases, type AirtableBase } from "./list-bases.mts";

// ---------------- Exclusion regexes ----------------
// Mirror references/base-selection-rules.md verbatim. Keep in lockstep with that SSOT.

export const ARCHIVE_REGEX =
  /\barchived?\b|archived?\s+\d{4}|^.*Archive (\d{4})/i;
export const COPY_REGEX =
  /\b(copy|imported|duplicate|backup|clone)\b|^Imported Base$|^Grid view$/i;
export const TEST_REGEX =
  /\btest\b|\bquestion\s+\d|\bintern\b|\brequired\s+assignment\b|MCO\s+intern|HR\s+(admin|practice)/i;

// ---------------- Types ----------------

export type ExcludedBy = "archive" | "copy" | "test" | "inactive" | null;

export interface BaseTraceEntry {
  id: string;
  name: string;
  included: boolean;
  excluded_by: ExcludedBy;
  last_activity: string | null;
  table_count: number | null;
}

export interface AllowlistParse {
  ids: Set<string>;
  regexes: RegExp[];
  overrides: Set<string>;
}

export interface ActiveBasesOptions {
  fetch?: typeof globalThis.fetch;
  env?: Record<string, string | undefined>;
  configPath?: string;
  cacheDir?: string;
  runId?: string;
  allowlistPath?: string;
  now?: () => Date;
  concurrency?: number;
  minGapMs?: number;
}

export interface ActiveBasesResult {
  activeIds: string[];
  trace: BaseTraceEntry[];
  cachePath: string;
}

interface AirtableTablesResponse {
  tables: Array<{ id: string; name: string }>;
}

interface AirtableRecordsResponse {
  records: Array<{ id: string; createdTime?: string; fields?: Record<string, unknown> }>;
}

const META_API_BASE = "https://api.airtable.com/v0/meta/bases";

// ---------------- Allowlist parsing ----------------

export function parseAllowlist(text: string): AllowlistParse {
  const ids = new Set<string>();
  const regexes: RegExp[] = [];
  const overrides = new Set<string>();

  for (const rawLine of text.split("\n")) {
    let line = rawLine;
    // Strip inline # comments (don't touch # inside regex source — but allowlist lines don't have escaped #)
    const hashIdx = line.indexOf("#");
    if (hashIdx >= 0) line = line.slice(0, hashIdx);
    line = line.trim();
    if (!line) continue;

    if (line.startsWith("~")) {
      const src = line.slice(1).trim();
      if (!src) continue;
      try {
        regexes.push(new RegExp(src, "i"));
      } catch {
        // Invalid regex - skip silently
      }
      continue;
    }
    if (line.startsWith("!")) {
      const id = line.slice(1).trim();
      if (!id) continue;
      overrides.add(id);
      ids.add(id); // override implies inclusion
      continue;
    }
    ids.add(line);
  }

  return { ids, regexes, overrides };
}

function loadAllowlist(path: string): AllowlistParse | null {
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf8");
    return parseAllowlist(text);
  } catch {
    return null;
  }
}

function isInAllowlist(base: AirtableBase, allow: AllowlistParse): boolean {
  if (allow.ids.has(base.id)) return true;
  for (const rx of allow.regexes) {
    if (rx.test(base.name)) return true;
  }
  return false;
}

// ---------------- Activity probe ----------------

interface ProbeOutcome {
  last_activity: string | null;
  table_count: number;
  ok: boolean; // false = probe call failed
}

async function probeBaseActivity(
  baseId: string,
  token: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<ProbeOutcome> {
  const url = `${META_API_BASE}/${encodeURIComponent(baseId)}/tables`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    return { last_activity: null, table_count: 0, ok: false };
  }
  const body = (await res.json()) as AirtableTablesResponse;
  const tables = body.tables ?? [];

  let maxCreated: string | null = null;
  for (const t of tables) {
    try {
      const recUrl =
        `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(t.id)}` +
        `?maxRecords=1&sort%5B0%5D%5Bfield%5D=_createdTime&sort%5B0%5D%5Bdirection%5D=desc`;
      const r = await fetchImpl(recUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) continue;
      const rb = (await r.json()) as AirtableRecordsResponse;
      const rec = rb.records?.[0];
      if (rec?.createdTime) {
        if (!maxCreated || rec.createdTime > maxCreated) {
          maxCreated = rec.createdTime;
        }
      }
    } catch {
      // skip table
    }
  }

  return { last_activity: maxCreated, table_count: tables.length, ok: true };
}

// ---------------- Concurrency-limited queue ----------------

async function runWithConcurrency<T, U>(
  items: T[],
  worker: (item: T) => Promise<U>,
  concurrency: number,
  minGapMs: number,
): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let nextIdx = 0;
  let lastStart = 0;

  const runNext = async (): Promise<void> => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= items.length) return;
      // Min-gap pacing between request starts (rate limit friendlier)
      if (minGapMs > 0) {
        const elapsed = Date.now() - lastStart;
        if (elapsed < minGapMs) {
          await new Promise((r) => setTimeout(r, minGapMs - elapsed));
        }
        lastStart = Date.now();
      }
      results[idx] = await worker(items[idx]);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}

// ---------------- Token resolution (mirrors list-bases.mts) ----------------

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

// ---------------- Main entry ----------------

function classifyExclusion(name: string): Exclude<ExcludedBy, "inactive" | null> | null {
  if (ARCHIVE_REGEX.test(name)) return "archive";
  if (COPY_REGEX.test(name)) return "copy";
  if (TEST_REGEX.test(name)) return "test";
  return null;
}

function defaultCutoff(now: Date): string {
  const year = now.getUTCFullYear();
  return `${year}-01-01T00:00:00Z`;
}

export async function activeBases(
  opts: ActiveBasesOptions = {},
): Promise<ActiveBasesResult> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const env = opts.env ?? process.env;
  const configPath = opts.configPath ?? join(homedir(), ".claude.json");
  const cacheDir =
    opts.cacheDir ?? join(homedir(), ".claude", "airtable-extract-cache");
  const runId = opts.runId ?? new Date().toISOString().replace(/[:.]/g, "-");
  const allowlistPath =
    opts.allowlistPath ?? join(homedir(), ".brain-os", "airtable-premium-bases.txt");
  const nowFn = opts.now ?? (() => new Date());
  const concurrency = opts.concurrency ?? 5;
  const minGapMs = opts.minGapMs ?? 200; // 5 req/s ceiling

  const runDir = join(cacheDir, runId);
  const cachePath = join(runDir, "active-bases.json");

  // Cache resume — if trace JSON already exists for this run-id, return it as-is.
  if (existsSync(cachePath)) {
    try {
      const cachedTrace = JSON.parse(readFileSync(cachePath, "utf8")) as BaseTraceEntry[];
      const activeIds = cachedTrace.filter((b) => b.included).map((b) => b.id);
      return { activeIds, trace: cachedTrace, cachePath };
    } catch {
      // Corrupt cache — fall through and recompute
    }
  }

  const token = resolveToken(env, configPath);

  const cutoffOverride = env.AIRTABLE_ACTIVITY_CUTOFF;
  const cutoffISO = cutoffOverride && cutoffOverride.length > 0
    ? cutoffOverride
    : defaultCutoff(nowFn());

  // 1. Pull full base list (uses listBases — propagates token / API errors).
  const { bases } = await listBases({
    fetch: fetchImpl,
    env,
    configPath,
    cacheDir,
    runId,
  });

  const allow = loadAllowlist(allowlistPath);

  // 2. First pass: synchronous filters (allowlist + name regexes). Identify which
  //    bases need an activity probe.
  type Pending = {
    base: AirtableBase;
    needsProbe: boolean;
    earlyVerdict: BaseTraceEntry | null;
  };
  const pending: Pending[] = bases.map((base) => {
    // Allowlist override — bypass all exclusions, no probe
    if (allow?.overrides.has(base.id)) {
      return {
        base,
        needsProbe: false,
        earlyVerdict: {
          id: base.id,
          name: base.name,
          included: true,
          excluded_by: null,
          last_activity: null,
          table_count: null,
        },
      };
    }

    // Inclusion — if allowlist exists and base not in it, drop
    if (allow && !isInAllowlist(base, allow)) {
      return {
        base,
        needsProbe: false,
        earlyVerdict: {
          id: base.id,
          name: base.name,
          included: false,
          excluded_by: null,
          last_activity: null,
          table_count: null,
        },
      };
    }

    // Exclusion regexes
    const excl = classifyExclusion(base.name);
    if (excl) {
      return {
        base,
        needsProbe: false,
        earlyVerdict: {
          id: base.id,
          name: base.name,
          included: false,
          excluded_by: excl,
          last_activity: null,
          table_count: null,
        },
      };
    }

    return { base, needsProbe: true, earlyVerdict: null };
  });

  // 3. Probe activity for bases that survived early filters, with concurrency cap.
  const probeTargets = pending.filter((p) => p.needsProbe);
  const probeResults = await runWithConcurrency(
    probeTargets,
    async (p) => {
      const probe = await probeBaseActivity(p.base.id, token, fetchImpl);
      return { p, probe };
    },
    concurrency,
    minGapMs,
  );

  const probeByBaseId = new Map<string, ProbeOutcome>();
  for (const { p, probe } of probeResults) {
    probeByBaseId.set(p.base.id, probe);
  }

  // 4. Build final trace.
  const trace: BaseTraceEntry[] = pending.map((p) => {
    if (p.earlyVerdict) return p.earlyVerdict;
    const probe = probeByBaseId.get(p.base.id);
    if (!probe || !probe.ok) {
      // Probe failed — treat as inactive (don't abort whole run)
      if (probe && !probe.ok) {
        process.stderr.write(
          `active-bases: probe failed for ${p.base.id} (${p.base.name}); marking inactive\n`,
        );
      }
      return {
        id: p.base.id,
        name: p.base.name,
        included: false,
        excluded_by: "inactive",
        last_activity: probe?.last_activity ?? null,
        table_count: probe?.table_count ?? null,
      };
    }
    const lastIso = probe.last_activity;
    const isActive = lastIso !== null && lastIso >= cutoffISO;
    return {
      id: p.base.id,
      name: p.base.name,
      included: isActive,
      excluded_by: isActive ? null : "inactive",
      last_activity: lastIso,
      table_count: probe.table_count,
    };
  });

  // 5. Persist trace.
  mkdirSync(runDir, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(trace, null, 2));

  const activeIds = trace.filter((b) => b.included).map((b) => b.id);
  return { activeIds, trace, cachePath };
}

if (import.meta.main) {
  try {
    const idsOnly = process.argv.includes("--ids");
    const { activeIds } = await activeBases({
      runId: process.env.AIRTABLE_RUN_ID,
    });
    if (idsOnly) {
      // Newline-separated IDs, one per line — shell-loop friendly
      process.stdout.write(activeIds.join("\n") + (activeIds.length ? "\n" : ""));
    } else {
      // Default: JSON array, suitable for `JSON.parse` or `jq -r '.[]'`
      process.stdout.write(JSON.stringify(activeIds) + "\n");
    }
  } catch (err) {
    process.stderr.write(`active-bases: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
