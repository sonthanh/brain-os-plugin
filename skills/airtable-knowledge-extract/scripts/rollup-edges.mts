#!/usr/bin/env bun
/**
 * rollup-edges.mts — entity-page edge rollup generator (ai-brain#245, parent #237 AC#12).
 *
 * Reads `${vault}/knowledge/graph/edges.jsonl` (the SSOT written by
 * `emit-edges.mts` per AC#11) and (re)generates `## Edges (incoming)` +
 * `## Edges (outgoing)` sections on every entity page found under
 * `${vault}/knowledge/`. Section content is purely derived — entity pages
 * never store edge data themselves; the rollup is a presentation layer.
 *
 * Section format:
 *
 *   <!-- BEGIN ROLLUP -->
 *
 *   ## Edges (incoming)
 *
 *   | Date | Counterparty | Amount | Note |
 *   | --- | --- | --- | --- |
 *   | 2026-01-03 | [[comp-b]] | 50 | refund |
 *
 *   ## Edges (outgoing)
 *
 *   | Date | Counterparty | Amount | Note |
 *   | --- | --- | --- | --- |
 *   | 2026-01-01 | [[comp-b]] | 100 | inv 1 |
 *
 *   <!-- END ROLLUP -->
 *
 * Counterparty resolution: the other endpoint of each edge (a record id) is
 * looked up in a vault-wide `recordId → page-slug` index built from every
 * entity page's `source_record_id` + `sources:` frontmatter; matches render
 * as `[[<slug>]]`, misses render as `` `<recordId>` `` (an inline-code id so
 * the row stays scannable but the missing page is visually obvious).
 *
 * Self-edges (`from === to` and both equal to the owner's record id) are
 * dropped — they would otherwise produce duplicate rows in both directions
 * with the page itself as counterparty, which is noise.
 *
 * Idempotence (AC#12 contract): the rollup block is bounded by deterministic
 * markers (`<!-- BEGIN ROLLUP -->` / `<!-- END ROLLUP -->`); replacement is
 * a single regex-anchored splice. Rows within a direction sort by `(date,
 * id)` ascending so input order doesn't perturb output. After computing the
 * new file content, the writer compares byte-for-byte with the existing
 * content and skips the write when equal — this preserves mtimes and gives
 * `git diff` an empty result on no-op reruns.
 *
 * Skip rules (no markers inserted, page left byte-identical):
 *   - Frontmatter lacks any record-id key (`source_record_id` / `sources:`).
 *   - Page has zero matching edges AND no existing rollup block.
 *
 * If a page has an existing rollup block but its edges have shrunk to zero,
 * the block is rewritten to render `_(none)_` in both directions — never
 * deleted. The markers stay so the next non-empty run flows back into them
 * idempotently.
 *
 * CLI:
 *   bun run rollup-edges.mts [--vault <path>] [--root <entity-pages-root>]
 *
 * NEVER imports `@anthropic-ai/sdk`, never spawns `claude`. Edge rollup is
 * pure presentation — zero LLM calls, zero network. Enforced indirectly by
 * the absence of any LLM API surface in this module.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { resolveVaultPath } from "./outcome-log.mts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ROLLUP_BEGIN = "<!-- BEGIN ROLLUP -->";
export const ROLLUP_END = "<!-- END ROLLUP -->";

const TABLE_HEADER = "| Date | Counterparty | Amount | Note |";
const TABLE_SEP = "| --- | --- | --- | --- |";
const EMPTY_CELL = "—";
const EMPTY_SECTION = "_(none)_";

const ROLLUP_BLOCK_RE = /<!-- BEGIN ROLLUP -->[\s\S]*?<!-- END ROLLUP -->/;

const SKIP_DIRS = new Set([
  ".git",
  ".obsidian",
  ".trash",
  ".cache",
  "node_modules",
]);

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

export interface EntityPage {
  path: string;
  slug: string | null;
  recordIds: string[];
  body: string;
}

export interface ParsedFrontmatter {
  frontmatter: Record<string, unknown> | null;
  body: string;
}

export interface RollupOptions {
  vaultPath?: string;
  entityPagesRoot?: string;
  entityPagesRoots?: string[];
  edgesPath?: string;
  env?: Record<string, string | undefined>;
  warn?: (msg: string) => void;
}

export interface RollupResult {
  vaultPath: string;
  edgesPath: string;
  edgesPathExists: boolean;
  entityPagesScanned: number;
  pagesUpdated: number;
  pagesUntouched: number;
  pagesSkipped: number;
  edgesIncomingTotal: number;
  edgesOutgoingTotal: number;
  unresolvedCounterparties: number;
  skipped: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Frontmatter parsing (line-based — only handles scalar + list values, which
// is all the entity-page schema needs)
// ---------------------------------------------------------------------------

const FM_DELIM_RE = /^---\s*$/;
const FM_SCALAR_RE = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/;
const FM_LIST_ITEM_RE = /^\s+-\s+(.+?)\s*$/;

export function parseFrontmatter(text: string): ParsedFrontmatter {
  const lines = text.split("\n");
  if (lines.length === 0 || !FM_DELIM_RE.test(lines[0])) {
    return { frontmatter: null, body: text };
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FM_DELIM_RE.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return { frontmatter: null, body: text };

  const fm: Record<string, unknown> = {};
  let currentListKey: string | null = null;
  for (let i = 1; i < endIdx; i++) {
    const line = lines[i];
    const listMatch = currentListKey != null ? FM_LIST_ITEM_RE.exec(line) : null;
    if (listMatch && currentListKey != null) {
      const arr = fm[currentListKey] as string[];
      arr.push(stripQuotes(listMatch[1]));
      continue;
    }
    const scalar = FM_SCALAR_RE.exec(line);
    if (!scalar) {
      currentListKey = null;
      continue;
    }
    const [, key, rawValue] = scalar;
    const value = rawValue.trim();
    if (value === "") {
      fm[key] = [];
      currentListKey = key;
    } else {
      fm[key] = stripQuotes(value);
      currentListKey = null;
    }
  }
  const body = lines.slice(endIdx + 1).join("\n");
  return { frontmatter: fm, body };
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

export function stripBasePrefix(id: string): string {
  return id.replace(/^app[A-Za-z0-9]{14}-/, "");
}

export function extractRecordIds(fm: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const single = fm.source_record_id;
  if (typeof single === "string" && single.length > 0) out.add(stripBasePrefix(single));
  const list = fm.sources;
  if (Array.isArray(list)) {
    for (const item of list) {
      if (typeof item === "string" && item.length > 0) out.add(stripBasePrefix(item));
    }
  }
  const plural = fm.source_record_ids;
  if (Array.isArray(plural)) {
    for (const item of plural) {
      if (typeof item === "string" && item.length > 0) out.add(stripBasePrefix(item));
    }
  }
  return [...out];
}

function extractSlug(fm: Record<string, unknown>): string | null {
  const v = fm.slug;
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}

// ---------------------------------------------------------------------------
// edges.jsonl parsing (mirrors emit-edges.parseJsonl semantics)
// ---------------------------------------------------------------------------

export function parseEdgesJsonl(text: string): EdgeRow[] {
  const out: EdgeRow[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line) as EdgeRow);
    } catch {
      // tolerate hand-edits — rebuilds shouldn't crash on a stray line.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

export function buildRecordIndex(pages: EntityPage[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const p of pages) {
    if (!p.slug) continue;
    for (const rid of p.recordIds) {
      if (!idx.has(rid)) idx.set(rid, p.slug);
    }
  }
  return idx;
}

export function groupEdgesByEntity(edges: EdgeRow[]): {
  outgoing: Map<string, EdgeRow[]>;
  incoming: Map<string, EdgeRow[]>;
} {
  const outgoing = new Map<string, EdgeRow[]>();
  const incoming = new Map<string, EdgeRow[]>();
  for (const e of edges) {
    if (typeof e.from === "string" && e.from.length > 0) {
      const arr = outgoing.get(e.from) ?? [];
      arr.push(e);
      outgoing.set(e.from, arr);
    }
    if (typeof e.to === "string" && e.to.length > 0) {
      const arr = incoming.get(e.to) ?? [];
      arr.push(e);
      incoming.set(e.to, arr);
    }
  }
  return { outgoing, incoming };
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderCell(v: string | number | undefined): string {
  if (v == null || v === "") return EMPTY_CELL;
  return escapeCell(String(v));
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|");
}

function renderCounterparty(
  identifier: string,
  recordIndex: Map<string, string>,
  slugIndex: Set<string>,
): string {
  const slug = recordIndex.get(identifier);
  if (slug) return `[[${slug}]]`;
  if (slugIndex.has(identifier)) return `[[${identifier}]]`;
  return `\`${identifier}\``;
}

export function renderEdgeRow(
  edge: EdgeRow,
  counterpartyId: string,
  recordIndex: Map<string, string>,
  slugIndex: Set<string> = new Set(),
): string {
  const date = renderCell(edge.date);
  const counterparty = renderCounterparty(counterpartyId, recordIndex, slugIndex);
  const amount = renderCell(edge.amount);
  const note = renderCell(edge.note);
  return `| ${date} | ${counterparty} | ${amount} | ${note} |`;
}

function compareEdgeRows(a: EdgeRow, b: EdgeRow): number {
  // Sort: dated rows first (asc by date), undated rows last; tiebreak by id asc
  const aHas = typeof a.date === "string" && a.date.length > 0;
  const bHas = typeof b.date === "string" && b.date.length > 0;
  if (aHas && !bHas) return -1;
  if (!aHas && bHas) return 1;
  if (aHas && bHas) {
    if (a.date! < b.date!) return -1;
    if (a.date! > b.date!) return 1;
  }
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function dropSelfEdges(edges: EdgeRow[], owners: Set<string>): EdgeRow[] {
  return edges.filter((e) => !(owners.has(e.from) && owners.has(e.to)));
}

export interface RenderRollupBlockInput {
  incoming: EdgeRow[];
  outgoing: EdgeRow[];
  recordIndex: Map<string, string>;
  slugIndex?: Set<string>;
  ownerRecordIds: string[];
  ownerSlug?: string | null;
}

function renderDirectionSection(
  title: string,
  edges: EdgeRow[],
  pickCounterpartyId: (e: EdgeRow) => string,
  recordIndex: Map<string, string>,
  slugIndex: Set<string>,
): string {
  const lines: string[] = [`## ${title}`, ""];
  if (edges.length === 0) {
    lines.push(EMPTY_SECTION);
    return lines.join("\n");
  }
  lines.push(TABLE_HEADER, TABLE_SEP);
  for (const e of [...edges].sort(compareEdgeRows)) {
    lines.push(renderEdgeRow(e, pickCounterpartyId(e), recordIndex, slugIndex));
  }
  return lines.join("\n");
}

export function renderRollupBlock(input: RenderRollupBlockInput): string {
  const owners = new Set([
    ...input.ownerRecordIds,
    ...(input.ownerSlug ? [input.ownerSlug] : []),
  ]);
  const slugIndex = input.slugIndex ?? new Set<string>();
  const incoming = dropSelfEdges(input.incoming, owners);
  const outgoing = dropSelfEdges(input.outgoing, owners);
  const sections: string[] = [
    ROLLUP_BEGIN,
    "",
    renderDirectionSection("Edges (incoming)", incoming, (e) => e.from, input.recordIndex, slugIndex),
    "",
    renderDirectionSection("Edges (outgoing)", outgoing, (e) => e.to, input.recordIndex, slugIndex),
    "",
    ROLLUP_END,
  ];
  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Page splice
// ---------------------------------------------------------------------------

export function applyRollupToPage(original: string, block: string): string {
  if (ROLLUP_BLOCK_RE.test(original)) {
    return original.replace(ROLLUP_BLOCK_RE, block);
  }
  const trimmed = original.replace(/\s+$/, "");
  return `${trimmed}\n\n${block}\n`;
}

// ---------------------------------------------------------------------------
// File walk + entity-page hydration
// ---------------------------------------------------------------------------

function walkMarkdownFiles(root: string, out: string[] = []): string[] {
  if (!existsSync(root)) return out;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    if (SKIP_DIRS.has(name)) continue;
    const full = join(root, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkMarkdownFiles(full, out);
    } else if (stat.isFile() && name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

function readEntityPage(path: string): EntityPage | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const { frontmatter } = parseFrontmatter(text);
  if (!frontmatter) {
    return { path, slug: null, recordIds: [], body: text };
  }
  const slug = extractSlug(frontmatter);
  // Text-field pages' source_record_ids are MENTION-records (where the entity name appeared),
  // not entity-records. Including them in recordIds would attribute mention-record edges
  // (cashflows/pnl-reports) to the entity. Match these pages by slug only.
  const isTextField = frontmatter.extraction_strategy === "text-field";
  const recordIds = isTextField ? [] : extractRecordIds(frontmatter);
  return { path, slug, recordIds, body: text };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function rollupEdges(opts: RollupOptions = {}): RollupResult {
  const env = opts.env ?? process.env;
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`));
  const vaultPath = opts.vaultPath ?? resolveVaultPath({ env });
  if (!vaultPath) {
    throw new Error(
      "rollup-edges: vault_path not resolvable. Set brain-os.config.md vault_path or pass opts.vaultPath.",
    );
  }
  const roots = opts.entityPagesRoots ??
    (opts.entityPagesRoot ? [opts.entityPagesRoot] : [
      join(vaultPath, "knowledge"),
      join(vaultPath, "companies"),
      join(vaultPath, "people"),
    ]);
  const edgesPath = opts.edgesPath ?? join(vaultPath, "knowledge", "graph", "edges.jsonl");

  const result: RollupResult = {
    vaultPath,
    edgesPath,
    edgesPathExists: existsSync(edgesPath),
    entityPagesScanned: 0,
    pagesUpdated: 0,
    pagesUntouched: 0,
    pagesSkipped: 0,
    edgesIncomingTotal: 0,
    edgesOutgoingTotal: 0,
    unresolvedCounterparties: 0,
    skipped: false,
  };

  if (!result.edgesPathExists) {
    result.skipped = true;
    result.reason = `edges.jsonl not found at ${edgesPath}`;
    return result;
  }

  const edges = parseEdgesJsonl(readFileSync(edgesPath, "utf8"));
  const grouped = groupEdgesByEntity(edges);

  const paths: string[] = [];
  for (const r of roots) walkMarkdownFiles(r, paths);
  const pages: EntityPage[] = [];
  for (const p of paths) {
    const ep = readEntityPage(p);
    if (ep) pages.push(ep);
  }
  result.entityPagesScanned = pages.length;

  const recordIndex = buildRecordIndex(pages);
  const slugIndex = new Set<string>();
  for (const p of pages) if (p.slug) slugIndex.add(p.slug);

  for (const page of pages) {
    if (page.recordIds.length === 0 && !page.slug) {
      result.pagesSkipped += 1;
      continue;
    }
    const matchKeys = new Set<string>([
      ...page.recordIds,
      ...(page.slug ? [page.slug] : []),
    ]);
    const incomingSeen = new Set<string>();
    const outgoingSeen = new Set<string>();
    const incoming: EdgeRow[] = [];
    const outgoing: EdgeRow[] = [];
    for (const key of matchKeys) {
      const inArr = grouped.incoming.get(key);
      if (inArr) {
        for (const e of inArr) {
          if (!incomingSeen.has(e.id)) {
            incomingSeen.add(e.id);
            incoming.push(e);
          }
        }
      }
      const outArr = grouped.outgoing.get(key);
      if (outArr) {
        for (const e of outArr) {
          if (!outgoingSeen.has(e.id)) {
            outgoingSeen.add(e.id);
            outgoing.push(e);
          }
        }
      }
    }

    const hadExisting = ROLLUP_BLOCK_RE.test(page.body);
    if (incoming.length === 0 && outgoing.length === 0 && !hadExisting) {
      result.pagesUntouched += 1;
      continue;
    }

    const block = renderRollupBlock({
      incoming,
      outgoing,
      recordIndex,
      slugIndex,
      ownerRecordIds: page.recordIds,
      ownerSlug: page.slug,
    });
    const next = applyRollupToPage(page.body, block);
    if (next === page.body) {
      result.pagesUntouched += 1;
      continue;
    }
    try {
      writeFileSync(page.path, next);
      result.pagesUpdated += 1;
    } catch (err) {
      warn(
        `rollup-edges: write failed for ${relative(vaultPath, page.path)}: ${(err as Error).message}`,
      );
    }

    for (const e of incoming) {
      if (!recordIndex.has(e.from) && !slugIndex.has(e.from)) {
        result.unresolvedCounterparties += 1;
      }
    }
    for (const e of outgoing) {
      if (!recordIndex.has(e.to) && !slugIndex.has(e.to)) {
        result.unresolvedCounterparties += 1;
      }
    }
    result.edgesIncomingTotal += incoming.length;
    result.edgesOutgoingTotal += outgoing.length;
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseCliArgs(argv: string[]): {
  vaultPath?: string;
  entityPagesRoot?: string;
  edgesPath?: string;
} {
  const args = argv.slice(2);
  const out: {
    vaultPath?: string;
    entityPagesRoot?: string;
    edgesPath?: string;
  } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--vault") out.vaultPath = args[++i];
    else if (a === "--root") out.entityPagesRoot = args[++i];
    else if (a === "--edges") out.edgesPath = args[++i];
  }
  return out;
}

if (import.meta.main) {
  try {
    const cli = parseCliArgs(process.argv);
    const result = rollupEdges(cli);
    if (result.skipped) {
      process.stderr.write(`rollup-edges: skipped — ${result.reason ?? "(no reason)"}\n`);
    } else {
      process.stderr.write(
        `rollup-edges: ${result.pagesUpdated} pages updated, ${result.pagesUntouched} untouched, ${result.pagesSkipped} skipped (no record id); ${result.edgesIncomingTotal} incoming + ${result.edgesOutgoingTotal} outgoing rendered, ${result.unresolvedCounterparties} unresolved counterparties\n`,
      );
    }
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`rollup-edges: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
