#!/usr/bin/env bun
/**
 * outcome-log.mts — skill-spec § 11 outcome-log writer for
 * /airtable-knowledge-extract.
 *
 * Resolves the vault path from `~/.brain-os/brain-os.config.md` (preferred)
 * or `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md` (fallback) — same precedence
 * as `hooks/resolve-vault.sh`, ported to TS so the bun-only orchestrator
 * (`run.mts`) can append without shelling out.
 *
 * Append format (per skill-spec § 11):
 *   {date} | airtable-knowledge-extract | {action} | {source_repo} |
 *     {output_path} | commit:{hash} | {result} [optional k=v fields...]
 *
 * The append is best-effort: if the vault path can't be resolved we write
 * stderr and exit silently (the orchestrator's metrics file is the
 * authoritative record; the outcome log is for /improve consumption).
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface OutcomeLogLine {
  date: string;
  skill: string;
  action: string;
  source_repo: string;
  output_path: string;
  commit_hash: string;
  result: "pass" | "partial" | "fail";
  fields?: Record<string, string | number>;
}

export interface ResolveVaultPathOpts {
  env?: Record<string, string | undefined>;
  home?: string;
  pluginRoot?: string;
  readFile?: (path: string) => string;
  exists?: (path: string) => boolean;
}

export interface AppendOutcomeLogOpts extends ResolveVaultPathOpts {
  vaultPath?: string;
  append?: (path: string, data: string) => void;
  ensureDir?: (path: string) => void;
}

const VAULT_KEY = /^vault_path:\s*(.+)\s*$/m;

export function resolveVaultPath(opts: ResolveVaultPathOpts = {}): string | null {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const pluginRoot = opts.pluginRoot ?? env.CLAUDE_PLUGIN_ROOT ?? "";
  const readFile =
    opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const exists = opts.exists ?? existsSync;

  const candidates = [
    join(home, ".brain-os", "brain-os.config.md"),
    pluginRoot ? join(pluginRoot, "brain-os.config.md") : null,
  ].filter((p): p is string => p != null && p.length > 0);

  for (const path of candidates) {
    if (!exists(path)) continue;
    let body: string;
    try {
      body = readFile(path);
    } catch {
      continue;
    }
    const m = body.match(VAULT_KEY);
    if (!m) continue;
    const value = m[1].trim();
    if (value.length > 0) return value;
  }
  return null;
}

export function formatOutcomeLogLine(line: OutcomeLogLine): string {
  const head = [
    line.date,
    line.skill,
    line.action,
    line.source_repo,
    line.output_path,
    `commit:${line.commit_hash}`,
    line.result,
  ].join(" | ");
  if (!line.fields || Object.keys(line.fields).length === 0) return head;
  const tail = Object.entries(line.fields)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return `${head} | ${tail}`;
}

export function appendOutcomeLog(
  line: OutcomeLogLine,
  opts: AppendOutcomeLogOpts = {},
): { ok: true; path: string } | { ok: false; reason: string } {
  const vaultPath = opts.vaultPath ?? resolveVaultPath(opts);
  if (!vaultPath) {
    return { ok: false, reason: "vault_path not resolvable" };
  }
  const append =
    opts.append ?? ((p: string, d: string) => appendFileSync(p, d));
  const ensureDir =
    opts.ensureDir ?? ((p: string) => mkdirSync(p, { recursive: true }));
  const logPath = join(
    vaultPath,
    "daily",
    "skill-outcomes",
    `${line.skill}.log`,
  );
  ensureDir(dirname(logPath));
  append(logPath, `${formatOutcomeLogLine(line)}\n`);
  return { ok: true, path: logPath };
}

if (import.meta.main) {
  process.stderr.write(
    "outcome-log.mts is a library; import { appendOutcomeLog } from this module.\n",
  );
  process.exit(2);
}
