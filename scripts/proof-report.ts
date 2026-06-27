#!/usr/bin/env -S bun run
/**
 * proof-report.ts — renders a per-acceptance-criterion PROOF report for a story.
 *
 * This is the net-new component of `/autodev` (the ultimate autonomous
 * goal→proof orchestrator). It answers the question the user actually wants
 * answered at the end of an autonomous run: "prove each acceptance criterion is
 * satisfied." It joins three things and emits a verdict per AC plus an overall
 * PROVEN | PARTIAL | UNPROVEN:
 *
 *   parent `## Acceptance` bullets  (§3.1)   — the contract + tick state
 *        ↕  by AC#N
 *   evidence comments               (§3.3 parent-form, §3.5 self-form)
 *        ↕
 *   verdict (verified / deferred / ticked-no-evidence / unverified)
 *
 * Two front-ends feed the SAME pure renderer:
 *   - `fromClosedStory(N)` — replays a real CLOSED story's GitHub evidence
 *     (read-only, zero side effects). This is the live e2e of the renderer.
 *   - `buildResultsToStory(...)` — the autodev Workflow's in-process results.
 *
 * SSOT discipline (references/ac-coverage-spec.md): the AC-bullet (§3.1) and
 * parent-evidence (§3.3) regexes are imported from run-story.ts, never
 * re-derived. The self-evidence regexes (§3.5) have no prior TS consumer, so
 * they are defined here citing §3.5 as their single source.
 */
import { ACCEPTANCE_AC_RE, PARENT_COMMENT_EVIDENCE_RE } from "./run-story";

// ── §3.5 self-acceptance evidence regexes (first TS consumer; cite the spec) ──
// references/ac-coverage-spec.md §3.5 — em-dash is U+2014 (literal —).
export const SELF_VERIFIED_RE = /^Self acceptance verified: AC#(\d+) — (.+)$/;
export const SELF_DEFERRED_RE = /^Self acceptance deferred: AC#(\d+) — (.+)$/;

// ── types ─────────────────────────────────────────────────────────────────
export interface AcBullet {
  id: number;
  /** Display criterion — the evidence-link / covered-by suffix stripped off. */
  text: string;
  ticked: boolean;
  /** Child issue numbers named by "covered by #N" / "(also covered by #M)". */
  coveredBy: number[];
  /** The `[evidence ↗](url)` link embedded in the bullet, if any. */
  evidenceUrl?: string;
}

export type EvidenceKind = "verified" | "self-verified" | "deferred";

export interface EvidenceLine {
  acId: number;
  kind: EvidenceKind;
  text: string;
  /** URL of the comment this line was parsed from, if known. */
  commentUrl?: string;
  /** Issue the comment lives on (parent for §3.3, the issue itself for §3.5). */
  sourceIssue?: number;
}

export type AcVerdict =
  | "verified" // a §3.3 / §3.5-verified evidence line exists
  | "deferred" // explicitly out-of-scope (§3.5 deferred), no verified line
  | "ticked-no-evidence" // box ticked but no evidence comment — weak/untrustworthy
  | "unverified"; // not ticked, no evidence

export interface AcProof {
  ac: AcBullet;
  verdict: AcVerdict;
  evidence: EvidenceLine[];
}

export type OverallVerdict = "PROVEN" | "PARTIAL" | "UNPROVEN";

export interface ChildRef {
  number: number;
  title?: string;
  state?: "closed" | "open" | "escalated";
  coversAc?: number[];
}

export interface StoryProof {
  goal?: string;
  parent: { number: number; title: string; url: string; acceptance: AcBullet[] };
  evidence: EvidenceLine[];
  children?: ChildRef[];
  generatedAt: string;
  /** Reference to the source grill / design doc, surfaced in the report head. */
  designRef?: string;
  /** Set when proof is rendered from a --dry-run autodev pass (nothing shipped). */
  dryRun?: boolean;
}

export interface ProofReport {
  overall: OverallVerdict;
  counts: {
    total: number;
    inScope: number;
    verified: number;
    deferred: number;
    unproven: number; // unverified + ticked-no-evidence
  };
  acProofs: AcProof[];
}

// ── parsers (reuse SSOT regexes) ────────────────────────────────────────────

/**
 * Parse parent `## Acceptance` bullets WITH tick state. Reuses §3.1
 * ACCEPTANCE_AC_RE; tick state is read from the matched line (`m[0]`) since the
 * canonical regex matches the whole bullet but does not group the checkbox.
 */
export function parseAcceptanceBullets(body: string): AcBullet[] {
  const out: AcBullet[] = [];
  // ACCEPTANCE_AC_RE carries the `g` flag — matchAll consumes a fresh iterator,
  // so reusing the shared object here is safe (no lastIndex leakage).
  for (const m of body.matchAll(ACCEPTANCE_AC_RE)) {
    const line = m[0];
    const id = Number(m[1]);
    const raw = m[2];
    const ticked = line.includes("[x]");
    const evMatch = raw.match(
      /\[evidence ↗\]\(([^)]+)\)/,
    );
    const coveredBy = [...raw.matchAll(/covered by #(\d+)/g)].map((x) =>
      Number(x[1]),
    );
    const text = raw
      .replace(/\s*—\s*\[evidence ↗\].*$/, "")
      .replace(/\s*\(also covered by[^)]*\)/g, "")
      .replace(/\s*covered by #\d+.*$/, "")
      .trim();
    out.push({
      id,
      text,
      ticked,
      coveredBy,
      evidenceUrl: evMatch ? evMatch[1] : undefined,
    });
  }
  return out;
}

/** Parse all evidence lines (§3.3 parent + §3.5 self/deferred) from one comment. */
export function parseEvidenceFromComment(
  commentBody: string,
  opts: { commentUrl?: string; sourceIssue?: number } = {},
): EvidenceLine[] {
  const out: EvidenceLine[] = [];
  for (const line of commentBody.split("\n")) {
    // Order matters only for readability — anchors are disjoint: a "Self
    // acceptance verified:" line does not start with "Acceptance verified:".
    let m = line.match(PARENT_COMMENT_EVIDENCE_RE);
    if (m) {
      out.push({ acId: Number(m[1]), kind: "verified", text: m[2], ...opts });
      continue;
    }
    m = line.match(SELF_VERIFIED_RE);
    if (m) {
      out.push({ acId: Number(m[1]), kind: "self-verified", text: m[2], ...opts });
      continue;
    }
    m = line.match(SELF_DEFERRED_RE);
    if (m) {
      out.push({ acId: Number(m[1]), kind: "deferred", text: m[2], ...opts });
      continue;
    }
  }
  return out;
}

// ── join + verdict (pure core) ──────────────────────────────────────────────

export function classifyAc(ac: AcBullet, evidence: EvidenceLine[]): AcVerdict {
  const mine = evidence.filter((e) => e.acId === ac.id);
  const hasVerified = mine.some(
    (e) => e.kind === "verified" || e.kind === "self-verified",
  );
  if (hasVerified) return "verified";
  if (mine.some((e) => e.kind === "deferred")) return "deferred";
  if (ac.ticked) return "ticked-no-evidence";
  return "unverified";
}

export function computeProof(story: StoryProof): ProofReport {
  const acProofs: AcProof[] = story.parent.acceptance.map((ac) => ({
    ac,
    verdict: classifyAc(ac, story.evidence),
    evidence: story.evidence.filter((e) => e.acId === ac.id),
  }));

  const total = acProofs.length;
  const deferred = acProofs.filter((p) => p.verdict === "deferred").length;
  const verified = acProofs.filter((p) => p.verdict === "verified").length;
  const inScope = total - deferred;
  const unproven = inScope - verified;

  let overall: OverallVerdict;
  if (inScope > 0 && verified === inScope) overall = "PROVEN";
  else if (verified > 0) overall = "PARTIAL";
  else overall = "UNPROVEN";

  return {
    overall,
    counts: { total, inScope, verified, deferred, unproven },
    acProofs,
  };
}

// ── render (pure) ───────────────────────────────────────────────────────────

const OVERALL_EMOJI: Record<OverallVerdict, string> = {
  PROVEN: "✅",
  PARTIAL: "⚠️",
  UNPROVEN: "❌",
};
const AC_EMOJI: Record<AcVerdict, string> = {
  verified: "✅",
  deferred: "⏭️",
  "ticked-no-evidence": "🟡",
  unverified: "❌",
};

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : flat.slice(0, n - 1) + "…";
}

export function renderProofReport(story: StoryProof): string {
  const report = computeProof(story);
  const { counts, overall, acProofs } = report;
  const L: string[] = [];

  L.push(`# Proof report — ${story.goal || story.parent.title}`);
  L.push("");
  L.push(
    `**Parent:** [ai-brain#${story.parent.number}](${story.parent.url}) — ${story.parent.title}`,
  );
  if (story.designRef) L.push(`**Design:** ${story.designRef}`);
  L.push(`**Generated:** ${story.generatedAt}`);
  L.push("");
  L.push(`## Verdict: ${OVERALL_EMOJI[overall]} ${overall}`);
  L.push("");
  if (story.dryRun)
    L.push(
      "> ⚠️ **DRY RUN** — nothing was filed, implemented, or pushed. This report proves the chain wiring, not real shipped work.\n",
    );
  L.push(
    `${counts.verified}/${counts.inScope} in-scope acceptance criteria verified · ` +
      `${counts.deferred} deferred · ${counts.unproven} unproven (of ${counts.total} total).`,
  );
  L.push("");

  // Summary table
  L.push("| AC | Criterion | Verdict | Proof |");
  L.push("|----|-----------|---------|-------|");
  for (const p of acProofs) {
    const ev = p.evidence[0];
    const proofCell = ev
      ? `${truncate(ev.text, 70)}${ev.commentUrl ? ` [↗](${ev.commentUrl})` : p.ac.evidenceUrl ? ` [↗](${p.ac.evidenceUrl})` : ""}`
      : "—";
    L.push(
      `| AC#${p.ac.id} | ${truncate(p.ac.text, 60)} | ${AC_EMOJI[p.verdict]} ${p.verdict} | ${proofCell} |`,
    );
  }
  L.push("");

  // Evidence detail
  L.push("## Evidence detail");
  L.push("");
  for (const p of acProofs) {
    L.push(`### ${AC_EMOJI[p.verdict]} AC#${p.ac.id} — ${p.verdict}`);
    L.push(`${p.ac.text}`);
    if (p.evidence.length) {
      for (const e of p.evidence) {
        const src = e.commentUrl ? ` ([comment ↗](${e.commentUrl}))` : "";
        L.push(`> **${e.kind}:** ${e.text}${src}`);
      }
    } else if (p.verdict === "ticked-no-evidence") {
      L.push(
        `> 🟡 Checkbox ticked but no \`Acceptance verified: AC#${p.ac.id}\` evidence comment found — proof is the author's assertion only.`,
      );
    } else {
      L.push(
        `> ❌ No evidence comment and checkbox unticked — this criterion is not proven.`,
      );
    }
    if (p.ac.coveredBy.length)
      L.push(`> covering child: ${p.ac.coveredBy.map((n) => `#${n}`).join(", ")}`);
    L.push("");
  }

  // Children
  if (story.children && story.children.length) {
    L.push("## Children");
    L.push("");
    L.push("| # | Covers | State |");
    L.push("|---|--------|-------|");
    for (const c of story.children) {
      L.push(
        `| #${c.number} | ${(c.coversAc || []).map((n) => `AC#${n}`).join(", ") || "—"} | ${c.state || "?"} |`,
      );
    }
    L.push("");
  }

  L.push("---");
  L.push(
    "_proof-report.ts · join: parent `## Acceptance` (§3.1) ↔ evidence comments (§3.3 / §3.5) ↔ checkbox tick · per `references/ac-coverage-spec.md`._",
  );
  return L.join("\n");
}

// ── adapters ────────────────────────────────────────────────────────────────

/** Per-child result the autodev Workflow's IMPLEMENT+EVALUATE phase produces. */
export interface BuildResult {
  issue: number;
  title?: string;
  coversAc: number[];
  status: "pass" | "escalated" | "pass(dry)";
  /** One-line test/eval summary, e.g. "bun test foo.test.ts: 12 pass, 0 fail". */
  testSummary?: string;
  commit?: string;
  url?: string;
}

/**
 * Build a StoryProof from the Workflow's in-process results (no GitHub round
 * trip). A passed child emits a §3.3-shaped verified line per AC it covers;
 * an escalated child emits no verified line, so those ACs stay unproven.
 */
export function buildResultsToStory(args: {
  goal?: string;
  parent: { number: number; title: string; url: string; body: string };
  results: BuildResult[];
  generatedAt: string;
  designRef?: string;
  dryRun?: boolean;
}): StoryProof {
  const acceptance = parseAcceptanceBullets(args.parent.body);
  const evidence: EvidenceLine[] = [];
  const children: ChildRef[] = [];
  for (const r of args.results) {
    children.push({
      number: r.issue,
      title: r.title,
      state: r.status === "escalated" ? "escalated" : "closed",
      coversAc: r.coversAc,
    });
    if (r.status === "escalated") continue;
    const summary = r.testSummary || "implemented + evaluated";
    for (const acId of r.coversAc) {
      evidence.push({
        acId,
        kind: "verified",
        text: `${summary}${r.commit ? `; commit ${r.commit}` : ""}`,
        commentUrl: r.url,
        sourceIssue: r.issue,
      });
    }
  }
  return {
    goal: args.goal,
    parent: {
      number: args.parent.number,
      title: args.parent.title,
      url: args.parent.url,
      acceptance,
    },
    evidence,
    children,
    generatedAt: args.generatedAt,
    designRef: args.designRef,
    dryRun: args.dryRun,
  };
}

// ── live front-end: replay a closed story from GitHub (read-only) ────────────

export interface GhReader {
  view(issue: number, repo: string, fields: string[]): Promise<any>;
}

/** Default reader — shells `gh issue view` (read-only, no mutations). */
export const shellGhReader: GhReader = {
  async view(issue, repo, fields) {
    const proc = Bun.spawn(
      ["gh", "issue", "view", String(issue), "-R", repo, "--json", fields.join(",")],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`gh issue view ${issue} failed (${code}): ${err.trim()}`);
    }
    return JSON.parse(out);
  },
};

/**
 * Build a StoryProof by reading a CLOSED parent story's evidence from GitHub.
 * Read-only: a single `gh issue view` on the parent. Evidence comes from the
 * parent's own comments (§3.3 parent-form is posted ON the parent by /impl).
 */
export async function fromClosedStory(
  parentN: number,
  repo: string,
  generatedAt: string,
  gh: GhReader = shellGhReader,
): Promise<StoryProof> {
  const j = await gh.view(parentN, repo, [
    "number",
    "title",
    "url",
    "body",
    "comments",
  ]);
  const acceptance = parseAcceptanceBullets(j.body || "");
  const evidence: EvidenceLine[] = [];
  for (const c of j.comments || []) {
    evidence.push(
      ...parseEvidenceFromComment(c.body || "", {
        commentUrl: c.url,
        sourceIssue: parentN,
      }),
    );
  }
  // Light children list from "covered by #N" refs in the AC bullets.
  const childNums = new Set<number>();
  for (const ac of acceptance) ac.coveredBy.forEach((n) => childNums.add(n));
  const children: ChildRef[] = [...childNums].sort((a, b) => a - b).map((n) => ({
    number: n,
    coversAc: acceptance.filter((ac) => ac.coveredBy.includes(n)).map((ac) => ac.id),
  }));
  return {
    parent: { number: j.number, title: j.title, url: j.url, acceptance },
    evidence,
    children,
    generatedAt,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const repo = arg(argv, "--repo") || "sonthanh/ai-brain";
  const outPath = arg(argv, "--out");
  const buildResultsFile = arg(argv, "--build-results");
  const generatedAt =
    new Date().toISOString().slice(0, 19).replace("T", " ") + " UTC";

  let story: StoryProof;
  if (buildResultsFile) {
    // Workflow path: render the autodev run's in-process results.
    // JSON shape: { goal, parent:{number,title,url,body}, results:BuildResult[], designRef, dryRun }
    const payload = await Bun.file(buildResultsFile).json();
    story = buildResultsToStory({ ...payload, generatedAt });
  } else {
    const parentArg = argv.find((a) => /^\d+$/.test(a));
    if (!parentArg) {
      console.error(
        "usage:\n" +
          "  bun run scripts/proof-report.ts <closed-parent-N> [--repo owner/name] [--out file]\n" +
          "  bun run scripts/proof-report.ts --build-results <json-file> [--out file]",
      );
      process.exit(2);
    }
    story = await fromClosedStory(Number(parentArg), repo, generatedAt);
  }

  const md = renderProofReport(story);
  const verdict = computeProof(story).overall;
  if (outPath) {
    await Bun.write(outPath, md);
    console.error(`proof report written → ${outPath}`);
  }
  console.log(md);
  // Non-zero exit on UNPROVEN so callers/CI can latch the verdict.
  process.exit(verdict === "UNPROVEN" ? 1 : 0);
}

if (import.meta.main) {
  await main();
}
