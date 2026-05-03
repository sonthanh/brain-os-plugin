#!/usr/bin/env bun
//
// rubric-author.mts — author a per-base rubric-questions.md draft, walk the
// operator through it via interactive readline grill (one question at a time
// with a concrete sample record), then score the diff against the AI draft.
//
// Pipeline:
//   1. Vault scan (existing intelligence/decisions/research)
//   2. Airtable scan (tables + fields + 5 sample rows per table)
//   3. Angle generation (Opus): obvious / bold / creative
//   4. Synthesis (Opus): merge angles into N synthetic /think queries
//   5. Operator review (default: interactive grill; --editor: $EDITOR escape hatch)
//   6. Diff log: delta_metrics.json with edit_ratio bands
//
// Diff classifier — slot-by-slot vs original (position i ↔ position i):
//   * exact match (after whitespace normalize) → kept_verbatim
//   * Jaccard(word-tokens) ≥ 0.5                → edited
//   * Jaccard < 0.5                              → replaced
//   * lines past N_original                      → added_by_user
//
// edit_ratio = (edited + replaced) / N_original. added_by_user is reported
// separately and is NOT in the ratio.
//
// Interactive grill shortcuts (default flow):
//   k                  — keep current question (also: empty input)
//   d                  — drop current question
//   <free text>        — rewrite current question with that text
//   k 1-5              — batch keep questions 1..5
//   d 6,7              — batch drop 6 and 7
//   k 1-5 d 6,7 d 9-12 — multi-batch (each range needs explicit k/d prefix)
//   +                  — jump to add-mode now (remaining auto-kept)
// After the question loop, operator is invited to add new questions until an
// empty line is entered. See `references/rubric-author-flow.md` for examples.
//
// TODO(C3): cluster-aware angles — once cluster classification (#184) ships,
// feed cluster shape into angle prompts so cross-cluster questions surface.

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

// ---------- Types ------------------------------------------------------------

export interface AirtableField {
  id: string;
  name: string;
  type: string;
}

export interface AirtableTable {
  id: string;
  name: string;
  fields: AirtableField[];
}

export interface AirtableSample {
  table: string;
  records: { id: string; fields: Record<string, unknown> }[];
}

export interface AirtableScan {
  baseId: string;
  tables: AirtableTable[];
  samples: AirtableSample[];
}

export interface VaultExcerpt {
  path: string;
  excerpt: string;
}

export interface VaultScan {
  intelligence: VaultExcerpt[];
  decisions: VaultExcerpt[];
  research: VaultExcerpt[];
}

export interface RubricAngles {
  obvious: string[];
  bold: string[];
  creative: string[];
}

export interface DeltaMetrics {
  questions_kept_verbatim: number;
  edited_count: number;
  replaced_count: number;
  added_by_user: number;
  total_original: number;
  total_edited: number;
  edit_ratio: number;
}

export type Verdict = "pass" | "pass-with-improve" | "reject";

export interface EvaluateResult {
  verdict: Verdict;
  exitCode: 0 | 1;
}

export interface ClaudeRunner {
  (args: { model: "opus" | "sonnet"; prompt: string }): Promise<string>;
}

export interface GrillIO {
  prompt: (text: string) => Promise<string>;
  output: (text: string) => void;
  close?: () => void;
}

export interface RubricAuthorOptions {
  baseId: string;
  vaultRoot?: string;
  cacheDir?: string;
  runId?: string;
  fetch?: typeof globalThis.fetch;
  env?: Record<string, string | undefined>;
  configPath?: string;
  claudeRunner?: ClaudeRunner;
  /** Editor escape hatch — set `useEditor: true` to fall back to $EDITOR. */
  openEditor?: (filePath: string) => Promise<void>;
  /** Default false (interactive grill). True → call openEditor on the draft. */
  useEditor?: boolean;
  /** Injection point for the interactive grill. Defaults to a stdin/stderr readline IO. */
  grillIO?: GrillIO;
  questionsTarget?: number;
}

export interface RubricAuthorResult {
  outDir: string;
  draftPath: string;
  metricsPath: string;
  metaRubricPath: string;
  metrics: DeltaMetrics;
  evaluate: EvaluateResult;
}

// ---------- Pure helpers -----------------------------------------------------

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

function tokens(s: string): Set<string> {
  return new Set(
    normalize(s)
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
}

function jaccard(a: string, b: string): number {
  const at = tokens(a);
  const bt = tokens(b);
  if (at.size === 0 && bt.size === 0) return 1;
  let inter = 0;
  for (const w of at) if (bt.has(w)) inter += 1;
  const union = at.size + bt.size - inter;
  return union === 0 ? 0 : inter / union;
}

const SIMILARITY_THRESHOLD = 0.5;

export function computeDelta(
  original: string[],
  edited: string[],
): DeltaMetrics {
  const N = original.length;
  let kept = 0;
  let editedCount = 0;
  let replaced = 0;

  for (let i = 0; i < N; i++) {
    const o = normalize(original[i] ?? "");
    const e = normalize(edited[i] ?? "");
    if (e === "") {
      replaced += 1;
      continue;
    }
    if (o === e) {
      kept += 1;
      continue;
    }
    if (jaccard(o, e) >= SIMILARITY_THRESHOLD) editedCount += 1;
    else replaced += 1;
  }

  const added = Math.max(0, edited.length - N);
  const ratio = N === 0 ? 0 : (editedCount + replaced) / N;

  return {
    questions_kept_verbatim: kept,
    edited_count: editedCount,
    replaced_count: replaced,
    added_by_user: added,
    total_original: N,
    total_edited: edited.length,
    edit_ratio: ratio,
  };
}

export function evaluateDelta(m: DeltaMetrics): EvaluateResult {
  if (m.edit_ratio <= 0.3) return { verdict: "pass", exitCode: 0 };
  if (m.edit_ratio <= 0.7) return { verdict: "pass-with-improve", exitCode: 0 };
  return { verdict: "reject", exitCode: 1 };
}

// `reject` is a SIGNAL for /improve to fix the AI drafting prompt, not a control
// instruction to halt the pipeline — operator-curated divergence is legitimate.
// `--strict` opts into the historical halt-on-reject behavior for CI gates.
export function cliExitCode(verdict: Verdict, strict: boolean): 0 | 1 {
  if (!strict) return 0;
  return verdict === "reject" ? 1 : 0;
}

// ---------- Grill command parser --------------------------------------------

export interface BatchAction {
  kind: "keep" | "drop";
  nums: number[];
}

export type GrillCommand =
  | { kind: "keep" }
  | { kind: "drop" }
  | { kind: "rewrite"; text: string }
  | { kind: "add" }
  | { kind: "batch"; actions: BatchAction[] };

export function parseRange(s: string): number[] {
  const out: number[] = [];
  for (const part of s.split(",")) {
    const trimmed = part.trim();
    const m = trimmed.match(/^(\d+)-(\d+)$/);
    if (m) {
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (let i = lo; i <= hi; i++) out.push(i);
    } else if (/^\d+$/.test(trimmed)) {
      out.push(parseInt(trimmed, 10));
    }
  }
  return out;
}

export function parseGrillCommand(input: string): GrillCommand {
  const trimmed = input.trim();
  if (trimmed === "" || trimmed === "k") return { kind: "keep" };
  if (trimmed === "d") return { kind: "drop" };
  if (trimmed === "+") return { kind: "add" };

  const parts = trimmed.split(/\s+/);
  const actions: BatchAction[] = [];
  let consumedAll = true;
  let i = 0;
  while (i < parts.length) {
    const t = parts[i];
    const next = parts[i + 1];
    if ((t === "k" || t === "d") && next && /^[\d,-]+$/.test(next)) {
      const nums = parseRange(next);
      if (nums.length === 0) {
        consumedAll = false;
        break;
      }
      actions.push({ kind: t === "k" ? "keep" : "drop", nums });
      i += 2;
    } else {
      consumedAll = false;
      break;
    }
  }
  if (consumedAll && actions.length > 0) return { kind: "batch", actions };

  return { kind: "rewrite", text: trimmed };
}

// ---------- Token resolution (mirrors list-bases.mts) ------------------------

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

// ---------- Scanners ---------------------------------------------------------

function readMarkdownDir(dir: string, maxFiles = 12): VaultExcerpt[] {
  if (!existsSync(dir)) return [];
  const out: VaultExcerpt[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (entry.endsWith(".md")) {
        const body = readFileSync(p, "utf8");
        out.push({ path: p, excerpt: body.slice(0, 500) });
        if (out.length >= maxFiles) return;
      }
      if (out.length >= maxFiles) return;
    }
  };
  walk(dir);
  return out;
}

async function scanVault(vaultRoot: string): Promise<VaultScan> {
  return {
    intelligence: readMarkdownDir(join(vaultRoot, "business", "intelligence")),
    decisions: readMarkdownDir(join(vaultRoot, "business", "decisions")),
    research: readMarkdownDir(join(vaultRoot, "knowledge", "research")),
  };
}

async function scanAirtable(
  baseId: string,
  fetchImpl: typeof globalThis.fetch,
  token: string,
): Promise<AirtableScan> {
  const tablesRes = await fetchImpl(
    `https://api.airtable.com/v0/meta/bases/${baseId}/tables`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!tablesRes.ok) {
    const text = await tablesRes.text().catch(() => "");
    throw new Error(`Airtable Meta tables ${tablesRes.status}: ${text || tablesRes.statusText}`);
  }
  const tablesBody = (await tablesRes.json()) as { tables: AirtableTable[] };
  const tables = tablesBody.tables ?? [];

  const samples: AirtableSample[] = [];
  for (const t of tables) {
    const recsRes = await fetchImpl(
      `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(t.name)}?maxRecords=5`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!recsRes.ok) {
      // record-fetch errors are non-fatal for the scan — include empty sample
      samples.push({ table: t.name, records: [] });
      continue;
    }
    const recsBody = (await recsRes.json()) as {
      records: { id: string; fields: Record<string, unknown> }[];
    };
    samples.push({ table: t.name, records: recsBody.records ?? [] });
  }

  return { baseId, tables, samples };
}

// ---------- LLM steps --------------------------------------------------------

function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fence ? fence[1] : text).trim();
  return JSON.parse(candidate);
}

function buildAnglesPrompt(vault: VaultScan, airtable: AirtableScan): string {
  const tableSummary = airtable.tables
    .map(
      (t) =>
        `- ${t.name} (${t.fields.length} fields: ${t.fields
          .slice(0, 8)
          .map((f) => `${f.name}:${f.type}`)
          .join(", ")})`,
    )
    .join("\n");
  const sampleSummary = airtable.samples
    .map((s) => `## ${s.table}\n${JSON.stringify(s.records.slice(0, 2), null, 2)}`)
    .join("\n\n");
  const vaultSummary = [
    ...vault.intelligence,
    ...vault.decisions,
    ...vault.research,
  ]
    .slice(0, 12)
    .map((v) => `- ${v.path}\n  ${v.excerpt.replace(/\n/g, " ").slice(0, 200)}`)
    .join("\n");

  return [
    "You are drafting evaluation angles for a knowledge-extraction rubric.",
    "Goal: every question must be a vault-grounded /think query — phrased as",
    `"can the vault answer X after import?".`,
    "",
    "Output strict JSON of shape:",
    '{ "obvious": string[], "bold": string[], "creative": string[] }',
    "",
    "- obvious: direct field-to-field queries (e.g., 'who founded company X?').",
    "- bold: cross-table relations (e.g., 'which OKR depends on which company?').",
    "- creative: time-series / trend queries the vault would enable.",
    "",
    "## Vault excerpts",
    vaultSummary || "(none — vault is empty)",
    "",
    "## Airtable tables",
    tableSummary || "(none)",
    "",
    "## Sample records",
    sampleSummary || "(none)",
  ].join("\n");
}

function buildSynthesisPrompt(angles: RubricAngles, target: number): string {
  return [
    `Merge the three angles below into exactly ${target} specific, vault-grounded`,
    "/think queries. Each query is one sentence, ends with a question mark.",
    "",
    "Output strict JSON of shape:",
    `{ "questions": string[] }   // length must equal ${target}`,
    "",
    "## obvious",
    angles.obvious.map((q) => `- ${q}`).join("\n"),
    "",
    "## bold",
    angles.bold.map((q) => `- ${q}`).join("\n"),
    "",
    "## creative",
    angles.creative.map((q) => `- ${q}`).join("\n"),
  ].join("\n");
}

async function generateAngles(
  vault: VaultScan,
  airtable: AirtableScan,
  runner: ClaudeRunner,
): Promise<RubricAngles> {
  const raw = await runner({
    model: "opus",
    prompt: buildAnglesPrompt(vault, airtable),
  });
  const parsed = extractJson(raw) as Partial<RubricAngles>;
  return {
    obvious: parsed.obvious ?? [],
    bold: parsed.bold ?? [],
    creative: parsed.creative ?? [],
  };
}

async function synthesizeQuestions(
  angles: RubricAngles,
  target: number,
  runner: ClaudeRunner,
): Promise<string[]> {
  const raw = await runner({
    model: "opus",
    prompt: buildSynthesisPrompt(angles, target),
  });
  const parsed = extractJson(raw) as { questions?: unknown };
  const questions = Array.isArray(parsed.questions)
    ? parsed.questions.filter((q): q is string => typeof q === "string")
    : [];
  return padToTarget(questions, angles, target);
}

function padToTarget(
  questions: string[],
  angles: RubricAngles,
  target: number,
): string[] {
  if (questions.length >= target) return questions.slice(0, target);
  const flat = [...angles.obvious, ...angles.bold, ...angles.creative];
  const out = [...questions];
  let i = 0;
  while (out.length < target && flat.length > 0) {
    out.push(flat[i % flat.length]);
    i += 1;
  }
  while (out.length < target) {
    out.push(`Can the vault answer placeholder query #${out.length + 1}?`);
  }
  return out;
}

// ---------- Writers ----------------------------------------------------------

const META_RUBRIC = `# Meta-Rubric — Vault Extraction Quality

These criteria define the **WHAT** — the dimensions on which every
Airtable→vault extraction is judged. The per-base rubric-questions.md
operationalizes each criterion with concrete, vault-grounded queries.

1. **Entity completeness.** Every Airtable record with substantive content
   produces a vault page (or is intentionally skipped with a logged reason).
2. **Link fidelity.** Airtable record-links surface as [[wikilinks]] in the
   vault; missing or fabricated links are violations.
3. **Semantic preservation.** Field meaning is preserved, not just the
   structure. Compound fields (rich text, multi-select) decompose into prose.
4. **No hallucinated context.** Vault pages contain only content sourced from
   the Airtable record or a clearly cited adjacent record.
5. **Time fidelity.** Created-at, updated-at, and event dates round-trip
   without timezone drift.
6. **Cluster coherence.** A subgraph extract surfaces every cluster member; no
   orphaned references to records outside the import scope.
7. **Legacy-link transparency.** Sparse or broken record-links are pruned
   from the extract context AND surfaced in airtable-cleanup-tasks.md.

Frozen across all bases — do not edit per-base. Per-base operationalization
lives in rubric-questions.md.
`;

function renderDraft(questions: string[]): string {
  const lines = [
    "# Rubric questions — synthetic /think queries",
    "",
    "Each question asks: after this base imports into the vault, can /think",
    "answer it from the imported pages alone? The diff against the AI draft",
    "is logged to delta_metrics.json.",
    "",
  ];
  questions.forEach((q, i) => {
    lines.push(`${i + 1}. ${q}`);
  });
  lines.push("");
  return lines.join("\n");
}

function readQuestionsFromMarkdown(filePath: string): string[] {
  const body = readFileSync(filePath, "utf8");
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^\d+\.\s+(.*)$/);
    if (m) out.push(m[1]);
  }
  return out;
}

// ---------- Interactive grill ------------------------------------------------

function sampleForIndex(
  airtable: AirtableScan,
  idx: number,
): { table: string; preview: string } {
  const candidates = airtable.samples.filter((s) => s.records.length > 0);
  if (candidates.length === 0) {
    return { table: "(none)", preview: "(no sample records available)" };
  }
  const s = candidates[idx % candidates.length];
  const r = s.records[0];
  const json = JSON.stringify(r.fields, null, 2);
  return {
    table: s.table,
    preview: json.length > 400 ? json.slice(0, 400) + "…" : json,
  };
}

export async function runInteractiveGrill(args: {
  questions: string[];
  airtable: AirtableScan;
  io: GrillIO;
}): Promise<string[]> {
  const { questions, airtable, io } = args;
  const N = questions.length;

  // Per-slot decision: undefined (undecided) | "__KEEP__" | "__DROP__" | rewrite text.
  const decisions: (string | undefined)[] = new Array(N).fill(undefined);

  io.output(`\nReviewing ${N} AI-generated questions. Shortcuts:`);
  io.output(`  k = keep, d = drop, <text> = rewrite`);
  io.output(`  batch: 'k 1-5 d 6,7' (each range needs explicit k/d prefix)`);
  io.output(`  + = jump to add-mode (remaining auto-kept)\n`);

  let i = 0;
  while (i < N) {
    if (decisions[i] !== undefined) {
      i += 1;
      continue;
    }
    const q = questions[i];
    const sample = sampleForIndex(airtable, i);
    io.output(`Question ${i + 1}/${N}: ${q}`);
    io.output(`  Sample (${sample.table}):`);
    io.output(`  ${sample.preview.replace(/\n/g, "\n  ")}`);
    const input = await io.prompt(`Action [k/d/rewrite/batch/+]: `);
    const cmd = parseGrillCommand(input);

    switch (cmd.kind) {
      case "keep":
        decisions[i] = "__KEEP__";
        i += 1;
        break;
      case "drop":
        decisions[i] = "__DROP__";
        i += 1;
        break;
      case "rewrite":
        decisions[i] = cmd.text;
        i += 1;
        break;
      case "add":
        for (let j = i; j < N; j++) {
          if (decisions[j] === undefined) decisions[j] = "__KEEP__";
        }
        i = N;
        break;
      case "batch":
        for (const a of cmd.actions) {
          for (const n of a.nums) {
            if (n >= 1 && n <= N) {
              decisions[n - 1] = a.kind === "keep" ? "__KEEP__" : "__DROP__";
            }
          }
        }
        // Loop's auto-skip handles advancing past freshly-decided slots.
        break;
    }
  }

  io.output(`\nAdd new questions (empty line to finish):`);
  const added: string[] = [];
  while (true) {
    const line = (await io.prompt(`Add: `)).trim();
    if (line === "") break;
    added.push(line);
  }

  const out: string[] = [];
  for (let j = 0; j < N; j++) {
    const d = decisions[j] ?? "__KEEP__";
    if (d === "__KEEP__") out.push(questions[j]);
    else if (d === "__DROP__") continue;
    else out.push(d);
  }
  for (const a of added) out.push(a);
  return out;
}

// ---------- Default external collaborators -----------------------------------

async function defaultClaudeRunner(args: {
  model: "opus" | "sonnet";
  prompt: string;
}): Promise<string> {
  const proc = Bun.spawn(["claude", "-p", "--model", args.model, args.prompt], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  if (proc.exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`claude -p exited ${proc.exitCode}: ${err}`);
  }
  return out;
}

async function defaultOpenEditor(filePath: string): Promise<void> {
  const editor = process.env.EDITOR;
  if (!editor || !process.stdin.isTTY) {
    throw new Error(
      `No interactive editor available (EDITOR=${editor || "unset"}, ` +
        `TTY=${Boolean(process.stdin.isTTY)}). Set $EDITOR and run from a ` +
        `terminal, or pass openEditor explicitly.`,
    );
  }
  const proc = Bun.spawn([editor, filePath], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  await proc.exited;
}

function defaultGrillIO(): GrillIO {
  if (!process.stdin.isTTY) {
    throw new Error(
      `No interactive TTY available for grill (stdin.isTTY=${Boolean(
        process.stdin.isTTY,
      )}). Run from a terminal, pass grillIO explicitly, or use --editor.`,
    );
  }
  // Prompts go to stderr so a `> /dev/null` redirect on stdout (used by the
  // SKILL.md supaterm flow) doesn't suppress the grill UI.
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return {
    prompt: (text) => rl.question(text),
    output: (text) => process.stderr.write(text + "\n"),
    close: () => rl.close(),
  };
}

// ---------- Orchestrator -----------------------------------------------------

export async function runRubricAuthor(
  opts: RubricAuthorOptions,
): Promise<RubricAuthorResult> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const env = opts.env ?? process.env;
  const configPath = opts.configPath ?? join(homedir(), ".claude.json");
  const cacheDir =
    opts.cacheDir ?? join(homedir(), ".claude", "airtable-extract-cache");
  const runId = opts.runId ?? new Date().toISOString().replace(/[:.]/g, "-");
  const claudeRunner = opts.claudeRunner ?? defaultClaudeRunner;
  const target = opts.questionsTarget ?? 20;

  const vaultRoot = opts.vaultRoot;
  if (!vaultRoot) {
    throw new Error(
      "vaultRoot required — pass via opts.vaultRoot or wire from config.",
    );
  }

  const token = resolveToken(env, configPath);

  const [vault, airtable] = await Promise.all([
    scanVault(vaultRoot),
    scanAirtable(opts.baseId, fetchImpl, token),
  ]);

  const angles = await generateAngles(vault, airtable, claudeRunner);
  const aiQuestions = await synthesizeQuestions(angles, target, claudeRunner);

  const outDir = join(cacheDir, runId, "gold-set");
  mkdirSync(outDir, { recursive: true });

  const draftPath = join(outDir, "rubric-questions.md");
  const metaRubricPath = join(outDir, "meta-rubric.md");
  const metricsPath = join(outDir, "delta_metrics.json");

  writeFileSync(draftPath, renderDraft(aiQuestions));
  writeFileSync(metaRubricPath, META_RUBRIC);

  let finalQuestions: string[];
  if (opts.useEditor) {
    const openEditor = opts.openEditor ?? defaultOpenEditor;
    await openEditor(draftPath);
    finalQuestions = readQuestionsFromMarkdown(draftPath);
  } else {
    const io = opts.grillIO ?? defaultGrillIO();
    try {
      finalQuestions = await runInteractiveGrill({
        questions: aiQuestions,
        airtable,
        io,
      });
    } finally {
      io.close?.();
    }
    writeFileSync(draftPath, renderDraft(finalQuestions));
  }

  const metrics = computeDelta(aiQuestions, finalQuestions);
  const verdict = evaluateDelta(metrics);

  writeFileSync(
    metricsPath,
    JSON.stringify(
      {
        ...metrics,
        verdict: verdict.verdict,
        baseId: opts.baseId,
        runId,
      },
      null,
      2,
    ),
  );

  return {
    outDir,
    draftPath,
    metricsPath,
    metaRubricPath,
    metrics,
    evaluate: verdict,
  };
}

// ---------- CLI --------------------------------------------------------------

if (import.meta.main) {
  const args = process.argv.slice(2);
  const useEditor = args.includes("--editor");
  const strict = args.includes("--strict");
  const positional = args.filter((a) => !a.startsWith("--"));
  const baseId = positional[0];
  if (!baseId) {
    process.stderr.write("usage: rubric-author.mts <base-id> [--editor] [--strict]\n");
    process.exit(2);
  }
  const vaultRoot = process.env.BRAIN_VAULT ?? join(homedir(), "work", "brain");
  try {
    const result = await runRubricAuthor({
      baseId,
      vaultRoot,
      runId: process.env.AIRTABLE_RUN_ID,
      useEditor,
    });
    process.stdout.write(
      JSON.stringify(
        {
          draftPath: result.draftPath,
          metaRubricPath: result.metaRubricPath,
          metricsPath: result.metricsPath,
          verdict: result.evaluate.verdict,
        },
        null,
        2,
      ) + "\n",
    );
    process.exit(cliExitCode(result.evaluate.verdict, strict));
  } catch (err) {
    process.stderr.write(`rubric-author: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
