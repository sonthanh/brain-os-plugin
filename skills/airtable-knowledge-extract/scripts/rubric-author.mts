#!/usr/bin/env bun
//
// rubric-author.mts — author a per-base rubric-questions.md draft, hand it to
// the user for editing, then score the diff against the AI draft. Pipeline:
//
//   1. Vault scan (existing intelligence/decisions/research)
//   2. Airtable scan (tables + fields + 5 sample rows per table)
//   3. Angle generation (Opus): obvious / bold / creative
//   4. Synthesis (Opus): merge angles into N synthetic /think queries
//   5. User edit: open in $EDITOR, await save
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

export interface RubricAuthorOptions {
  baseId: string;
  vaultRoot?: string;
  cacheDir?: string;
  runId?: string;
  fetch?: typeof globalThis.fetch;
  env?: Record<string, string | undefined>;
  configPath?: string;
  claudeRunner?: ClaudeRunner;
  openEditor?: (filePath: string) => Promise<void>;
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
    "answer it from the imported pages alone? Edit freely — the diff against",
    "this AI draft is logged to delta_metrics.json.",
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
  const openEditor = opts.openEditor ?? defaultOpenEditor;
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

  await openEditor(draftPath);

  const editedQuestions = readQuestionsFromMarkdown(draftPath);
  const metrics = computeDelta(aiQuestions, editedQuestions);
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
  const baseId = process.argv[2];
  if (!baseId) {
    process.stderr.write("usage: rubric-author.mts <base-id>\n");
    process.exit(2);
  }
  const vaultRoot = process.env.BRAIN_VAULT ?? join(homedir(), "work", "brain");
  try {
    const result = await runRubricAuthor({
      baseId,
      vaultRoot,
      runId: process.env.AIRTABLE_RUN_ID,
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
    process.exit(result.evaluate.exitCode);
  } catch (err) {
    process.stderr.write(`rubric-author: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
