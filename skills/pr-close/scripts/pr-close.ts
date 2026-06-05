#!/usr/bin/env -S bun run
// pr-close.ts — deterministic prep for the pr-close skill.
//
// Pure, testable core (parseLinkedIssues / buildCloseRef / buildSquashSubject)
// plus a thin `prepare` command that fetches PR metadata via `gh` and emits the
// deterministic plan inputs as JSON for SKILL.md to consume. Execution
// (comment / merge / close) stays in the interactive skill — this script only
// builds the load-bearing strings the skill must not get wrong:
//   - the cross-repo close reference (a bare `Closes #N` resolves against the
//     CODE repo and silently no-ops; the tracker prefix is mandatory)
//   - the PR-title-verbatim squash subject (gh appends ` (#N)` without --subject)
//
// Lives in brain-os-plugin per the TS+bun script rule. The pure core is
// unit-tested in pr-close.test.ts — no destructive gh execution needed to
// validate the logic that #139 asked to have asserted.

import { spawnSync } from "node:child_process";

export interface LinkedIssue {
  repo: string | null; // explicit owner/repo prefix found in the PR body, else null
  num: number;
}

// Closes/Fixes/Resolves (+ their tenses) followed by an optional owner/repo
// prefix and `#N`. The keyword + reference must be contiguous so prose like
// "see #42 for context" or "closes the door, ticket #5" does NOT match.
const CLOSE_REF =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[:\s]+(?:([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)?#(\d+))/gi;

/** Extract close-references (with optional owner/repo) from a PR body, in order, deduped. */
export function parseLinkedIssues(body: string): LinkedIssue[] {
  const out: LinkedIssue[] = [];
  const seen = new Set<string>();
  if (!body) return out;
  for (const m of body.matchAll(CLOSE_REF)) {
    const repo = m[1] ?? null;
    const num = Number(m[2]);
    const key = `${repo ?? ""}#${num}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ repo, num });
  }
  return out;
}

/** Build the squash-body close block. The explicit tracker prefix is load-bearing:
 *  a bare `Closes #N` targets the code repo and no-ops. Each issue keeps its own
 *  repo if the body declared one, else falls back to the configured tracker. */
export function buildCloseRef(trackerRepo: string, issues: LinkedIssue[]): string {
  return issues.map((i) => `Closes ${i.repo ?? trackerRepo}#${i.num}`).join("\n");
}

/** PR title verbatim as the squash subject. Strips a trailing ` (#N)` that gh
 *  would otherwise duplicate, and trims — keeping the clean title as the subject. */
export function buildSquashSubject(prTitle: string): string {
  return prTitle.replace(/\s*\(#\d+\)\s*$/, "").trim();
}

// ---- thin CLI: `prepare` (I/O wrapper around the pure core) ------------------

interface PrMeta {
  number: number;
  title: string;
  body: string;
  headRefName: string;
  url: string;
  state: string;
}

function fetchPr(pr: string): PrMeta {
  const r = spawnSync(
    "gh",
    ["pr", "view", pr, "--json", "number,title,body,headRefName,url,state"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`gh pr view ${pr} failed: ${(r.stderr || "").trim()}`);
  return JSON.parse(r.stdout);
}

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

if (import.meta.main) {
  if (process.argv[2] !== "prepare") {
    console.error("usage: pr-close.ts prepare --pr <N> [--tracker <owner/repo>]");
    process.exit(2);
  }
  const pr = flag("--pr");
  if (!pr) {
    console.error("ERROR: --pr <N> required");
    process.exit(2);
  }
  const tracker = flag("--tracker", "sonthanh/ai-brain")!;
  const meta = fetchPr(pr);
  const linkedIssues = parseLinkedIssues(meta.body);
  const plan = {
    number: meta.number,
    title: meta.title,
    subject: buildSquashSubject(meta.title),
    headRef: meta.headRefName,
    url: meta.url,
    state: meta.state,
    tracker,
    linkedIssues,
    closesBlock: buildCloseRef(tracker, linkedIssues),
  };
  process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
}
