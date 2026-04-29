#!/usr/bin/env bun
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AirtableBase {
  id: string;
  name: string;
  permissionLevel: string;
}

interface MetaApiResponse {
  bases: AirtableBase[];
  offset?: string;
}

export interface ListBasesOptions {
  fetch?: typeof globalThis.fetch;
  env?: Record<string, string | undefined>;
  configPath?: string;
  cacheDir?: string;
  runId?: string;
}

export interface ListBasesResult {
  bases: AirtableBase[];
  cachePath: string;
}

const META_API_URL = "https://api.airtable.com/v0/meta/bases";

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

export async function listBases(opts: ListBasesOptions = {}): Promise<ListBasesResult> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const env = opts.env ?? process.env;
  const configPath = opts.configPath ?? join(homedir(), ".claude.json");
  const cacheDir =
    opts.cacheDir ?? join(homedir(), ".claude", "airtable-extract-cache");
  const runId = opts.runId ?? new Date().toISOString().replace(/[:.]/g, "-");

  const token = resolveToken(env, configPath);

  const collected: AirtableBase[] = [];
  let offset: string | undefined;
  do {
    const url = offset
      ? `${META_API_URL}?offset=${encodeURIComponent(offset)}`
      : META_API_URL;
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Airtable Meta API ${res.status}: ${text || res.statusText}`);
    }
    const body = (await res.json()) as MetaApiResponse;
    collected.push(...(body.bases ?? []));
    offset = body.offset;
  } while (offset);

  const runDir = join(cacheDir, runId);
  mkdirSync(runDir, { recursive: true });
  const cachePath = join(runDir, "bases.json");
  writeFileSync(cachePath, JSON.stringify(collected, null, 2));

  return { bases: collected, cachePath };
}

if (import.meta.main) {
  try {
    const { bases } = await listBases({ runId: process.env.AIRTABLE_RUN_ID });
    process.stdout.write(JSON.stringify(bases, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`list-bases: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
