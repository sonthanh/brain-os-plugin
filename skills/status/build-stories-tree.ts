#!/usr/bin/env bun
/**
 * build-stories-tree.ts — Render the Stories sub-block of /status as a
 * parent→child dependency tree. Pure deterministic transform of an
 * `gh issue list --state all --json number,state,labels,body` payload —
 * no GH API calls, no LLM.
 *
 * Stdin or argv[2]: path to JSON file containing the gh issue list payload.
 * Stdout: markdown lines for the Stories block (header + trees + queued
 * footer), already terminated by `\n`. Empty when there are no open plans.
 *
 * Algorithm: see references/stories-tree-spec.md (mirrored below).
 *
 *   1. Parse `## Parent` body refs from every issue (any state) → adjacency.
 *   2. Roots = open `type:plan` issues that satisfy the active filter
 *      (status != backlog OR has at least one open descendant) AND whose
 *      parent is not itself a rendered plan.
 *   3. For each root, walk children depth-first; group consecutive-by-sort
 *      closed siblings into one "[closed] — N done" line, recurse open
 *      siblings.
 *   4. Title-Phase pairing: roots whose titles match `— Phase N` share a
 *      project bucket; an active root with a backlog "next phase" peer
 *      gets a trailing `Next phase: #M …` leaf in its tree.
 *   5. After all roots, append `Next story queued: #N — title` for the
 *      top-priority unlinked bench plan (skip when none).
 *
 * Shipped as a TS helper (not bash) because the algorithm is non-trivial
 * (closed-collapse runs, phase-pairing, blocker annotations) and needs
 * fixture-driven unit tests — see build-stories-tree.test.ts.
 */
import { readFileSync } from "node:fs";

// ============================================================
// Constants
// ============================================================

const MS_PER_DAY = 86_400_000;

// Anti-drift threshold (ai-brain#178). A constant, not an env var, by design
// (KISS): an active story whose entire subtree has had no GitHub issue
// activity for longer than this many days is surfaced as STALE.
export const STALE_THRESHOLD_DAYS = 14;

// ============================================================
// Types
// ============================================================

export type IssueState = "OPEN" | "CLOSED";
export type Status =
  | "in-progress"
  | "ready"
  | "blocked"
  | "backlog"
  | null;
export type Priority = "p1" | "p2" | "p3" | null;

export interface RawLabel {
  name: string;
}
export interface RawIssue {
  number: number;
  state: string;
  labels: RawLabel[];
  body?: string;
  // gh occasionally returns issues with an undefined `title` field — defended
  // in `normalizeIssue` so downstream parsers can rely on a string.
  title?: string;
  // ISO-8601 last-activity timestamp from `gh ... --json updatedAt`. Bumped by
  // comments, edits, label changes, child closes, and cross-referenced commits.
  // Optional so existing fixtures without it still normalize (→ updatedAtMs 0,
  // which the stale check treats as "no signal" and skips).
  updatedAt?: string;
}

export interface Issue {
  number: number;
  state: IssueState;
  status: Status;
  priority: Priority;
  isPlan: boolean;
  parent: number | null;
  blockers: number[];
  title: string;
  // Epoch ms of last activity (0 when the source omitted `updatedAt`).
  updatedAtMs: number;
}

export interface PhaseInfo {
  project: string;
  phase: number;
}

// ============================================================
// Body parsers
// ============================================================

// Extracts the parent issue number from a `## Parent` section. Tolerates
// `- ai-brain#N`, `- #N`, and trailing parenthetical commentary
// (`- ai-brain#179 (Phase 1 MVP)`). Returns the FIRST `#N` token found
// inside the section — secondary refs are noise.
//
// Sibling parser to `scripts/lib/ac-coverage.ts > parseParentRef` — that
// one is intentionally strict (`#N\s*$` line end) for child-of-story AC
// gates; the tree renderer needs the lenient variant because manually
// filed parents carry annotations like `(Phase 1 MVP)` after the ref.
// Don't unify the two without auditing the AC-coverage callers.
export function parseParentRef(body: string): number | null {
  const lines = body.split("\n");
  let inSection = false;
  for (const line of lines) {
    if (/^## Parent\s*$/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^## /.test(line)) break;
    if (!inSection) continue;
    const m = line.match(/#(\d+)/);
    if (m) return Number(m[1]);
  }
  return null;
}

// Extracts blocker issue numbers from `## Blocked by`. Returns [] when the
// section is missing or contains "None — can start immediately." sentinel.
export function parseBlockers(body: string): number[] {
  const lines = body.split("\n");
  let inSection = false;
  const ids = new Set<number>();
  for (const line of lines) {
    if (/^## Blocked by\b/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^## /.test(line)) break;
    if (!inSection) continue;
    if (/^\s*-\s*None\b/i.test(line)) continue;
    const m = line.match(/#(\d+)/);
    if (m) ids.add(Number(m[1]));
  }
  return [...ids].sort((a, b) => a - b);
}

// Title regex for Phase pairing. Matches `<project> — Phase N <appendix>`.
// Em-dash literal U+2014. The discriminator is the SPACE-EM-DASH-SPACE
// boundary before "Phase" — embedded mentions like "(Phase-1 architecture
// correction)" intentionally don't match (different concept).
const PHASE_TITLE_RE = /^(.+?)\s*—\s*Phase\s+(\d+)\b/;

export function parsePhase(title: string): PhaseInfo | null {
  const m = title.match(PHASE_TITLE_RE);
  if (!m) return null;
  const project = m[1].replace(/^Story:\s*/, "").trim();
  return { project, phase: Number(m[2]) };
}

// ============================================================
// Issue normalization
// ============================================================

export function normalizeIssue(raw: RawIssue): Issue {
  const labelNames = (raw.labels ?? []).map((l) => l.name);
  const title = raw.title ?? "";
  let status: Status = null;
  if (labelNames.includes("status:in-progress")) status = "in-progress";
  else if (labelNames.includes("status:ready")) status = "ready";
  else if (labelNames.includes("status:blocked")) status = "blocked";
  else if (labelNames.includes("status:backlog")) status = "backlog";
  let priority: Priority = null;
  for (const n of labelNames) {
    if (n === "priority:p1") {
      priority = "p1";
      break;
    }
    if (n === "priority:p2") {
      priority = "p2";
      break;
    }
    if (n === "priority:p3") {
      priority = "p3";
      break;
    }
  }
  const body = raw.body ?? "";
  // `Date.parse` of a missing/garbage timestamp is NaN; `|| 0` floors it so
  // downstream math stays finite and the stale check skips it as "no signal".
  const updatedAtMs = (raw.updatedAt ? Date.parse(raw.updatedAt) : 0) || 0;
  return {
    number: raw.number,
    state: raw.state === "CLOSED" ? "CLOSED" : "OPEN",
    status,
    priority,
    isPlan: labelNames.includes("type:plan"),
    parent: parseParentRef(body),
    blockers: parseBlockers(body),
    title,
    updatedAtMs,
  };
}

// ============================================================
// Adjacency + reachability
// ============================================================

export function buildAdjacency(issues: Issue[]): Map<number, number[]> {
  const adj = new Map<number, number[]>();
  for (const i of issues) {
    if (i.parent === null) continue;
    const arr = adj.get(i.parent) ?? [];
    arr.push(i.number);
    adj.set(i.parent, arr);
  }
  for (const arr of adj.values()) arr.sort((a, b) => a - b);
  return adj;
}

// Walks the adjacency from `num` and returns true on the first OPEN
// descendant. Cycle-safe: a `visited` set guards against revisiting nodes
// when the parent graph is malformed (e.g. user authored circular
// `## Parent` refs). Without this guard an all-CLOSED cycle would push
// the same nodes onto the stack forever.
export function hasOpenDescendant(
  num: number,
  adj: Map<number, number[]>,
  byNumber: Map<number, Issue>,
): boolean {
  const visited = new Set<number>();
  const stack = [...(adj.get(num) ?? [])];
  while (stack.length) {
    const n = stack.pop()!;
    if (visited.has(n)) continue;
    visited.add(n);
    const c = byNumber.get(n);
    if (!c) continue;
    if (c.state === "OPEN") return true;
    for (const g of adj.get(n) ?? []) stack.push(g);
  }
  return false;
}

// ============================================================
// Root selection (active vs bench)
// ============================================================

export function isActivePlan(
  i: Issue,
  adj: Map<number, number[]>,
  byNumber: Map<number, Issue>,
): boolean {
  if (!i.isPlan || i.state !== "OPEN") return false;
  if (i.status !== "backlog") return true;
  return hasOpenDescendant(i.number, adj, byNumber);
}

// Roots = active plans whose parent is not also an active plan.
// Pre-condition: `byNumber` covers every open issue.
export function findRoots(
  issues: Issue[],
  adj: Map<number, number[]>,
  byNumber: Map<number, Issue>,
): Issue[] {
  const activeSet = new Set(
    issues.filter((i) => isActivePlan(i, adj, byNumber)).map((i) => i.number),
  );
  return issues
    .filter((i) => activeSet.has(i.number))
    .filter((i) => i.parent === null || !activeSet.has(i.parent))
    .sort((a, b) => b.number - a.number);
}

export function findBenchPlans(
  issues: Issue[],
  adj: Map<number, number[]>,
  byNumber: Map<number, Issue>,
): Issue[] {
  return issues.filter(
    (i) =>
      i.isPlan &&
      i.state === "OPEN" &&
      i.status === "backlog" &&
      !hasOpenDescendant(i.number, adj, byNumber),
  );
}

// ============================================================
// Phase pairing — find each active root's `next phase` peer
// ============================================================

// For each active root, find the bench plan whose title shares the same
// project + phase = root.phase + 1. Returns map activeRoot.number → benchPlan.
export function buildPhaseLinks(
  activeRoots: Issue[],
  benchPlans: Issue[],
): Map<number, Issue> {
  const links = new Map<number, Issue>();
  for (const root of activeRoots) {
    const rootPhase = parsePhase(root.title);
    if (!rootPhase) continue;
    const next = benchPlans.find((b) => {
      const p = parsePhase(b.title);
      return p && p.project === rootPhase.project && p.phase === rootPhase.phase + 1;
    });
    if (next) links.set(root.number, next);
  }
  return links;
}

// ============================================================
// Status badge + title cleanup
// ============================================================

export function statusBadge(issue: Issue): string {
  if (issue.state === "CLOSED") return "[closed]";
  switch (issue.status) {
    case "in-progress":
      return "[in-prog]";
    case "ready":
      return "[READY]";
    case "blocked":
      return "[BLOCKED]";
    case "backlog":
      return "[backlog]";
    default:
      return "";
  }
}

// Strips the `Story:` prefix and collapses any embedded newlines/CRs to
// spaces. The collapse step blocks markdown injection via title fields:
// a title containing `\n## ` would otherwise break the rendered structure
// of `~/.cache/brain-os/status.md`.
export function cleanTitle(title: string): string {
  return title.replace(/^Story:\s*/, "").replace(/[\r\n]+/g, " ").trim();
}

// ============================================================
// Closed-sibling collapse
// ============================================================

export type DisplayItem =
  | { kind: "open"; number: number }
  | { kind: "closed-group"; numbers: number[]; label: string };

export function collapseClosedSiblings(
  childNums: number[],
  byNumber: Map<number, Issue>,
): DisplayItem[] {
  const sorted = [...childNums].sort((a, b) => a - b);
  const out: DisplayItem[] = [];
  let closedRun: number[] = [];

  const flush = () => {
    if (closedRun.length === 0) return;
    out.push({
      kind: "closed-group",
      numbers: closedRun,
      label: formatClosedGroup(closedRun, byNumber),
    });
    closedRun = [];
  };

  for (const n of sorted) {
    const issue = byNumber.get(n);
    if (!issue) continue;
    if (issue.state === "CLOSED") closedRun.push(n);
    else {
      flush();
      out.push({ kind: "open", number: n });
    }
  }
  flush();
  return out;
}

export function formatClosedGroup(
  nums: number[],
  byNumber: Map<number, Issue>,
): string {
  if (nums.length === 1) {
    const issue = byNumber.get(nums[0]);
    const title = issue ? cleanTitle(issue.title) : "(unknown)";
    return `#${nums[0]} [closed] — ${title}`;
  }
  const sorted = [...nums].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let prev = start;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) {
      prev = sorted[i];
      continue;
    }
    ranges.push(start === prev ? `#${start}` : `#${start}–#${prev}`);
    start = sorted[i];
    prev = start;
  }
  ranges.push(start === prev ? `#${start}` : `#${start}–#${prev}`);
  return `${ranges.join(", ")} [closed] — ${sorted.length} done`;
}

// ============================================================
// Blocker annotation
// ============================================================

// Returns the blocker suffix `(blocked by #N, #M)` for an issue, only
// counting OPEN blockers in the same parent's child set (siblings) — closed
// blockers are silenced because they no longer block, and non-sibling
// blockers are out-of-tree noise that the tree shape can't show anyway.
export function blockerSuffix(
  issue: Issue,
  siblings: Set<number>,
  byNumber: Map<number, Issue>,
): string {
  const open = issue.blockers.filter((n) => {
    if (!siblings.has(n)) return false;
    const b = byNumber.get(n);
    return b?.state === "OPEN";
  });
  if (open.length === 0) return "";
  return ` (blocked by ${open.map((n) => `#${n}`).join(", ")})`;
}

// ============================================================
// Tree rendering
// ============================================================

const BRANCH_MID = "├── ";
const BRANCH_LAST = "└── ";
const VBAR = "│   ";
const SPACE = "    ";

interface RenderCtx {
  adj: Map<number, number[]>;
  byNumber: Map<number, Issue>;
  phaseLinks: Map<number, Issue>;
  visited: Set<number>;
}

export function renderTree(ctx: RenderCtx, root: Issue): string[] {
  const lines: string[] = [];
  renderRoot(ctx, root, lines);
  return lines;
}

function renderRoot(ctx: RenderCtx, root: Issue, out: string[]): void {
  ctx.visited.add(root.number);
  const planMarker = root.isPlan ? "Story " : "";
  const badge = statusBadge(root);
  const badgeStr = badge ? ` ${badge}` : "";
  out.push(`${planMarker}#${root.number}${badgeStr} — ${cleanTitle(root.title)}`);
  const childNums = (ctx.adj.get(root.number) ?? []).filter(
    (n) => !ctx.visited.has(n),
  );
  const items = collapseClosedSiblings(childNums, ctx.byNumber);
  const siblingSet = new Set(childNums);
  const phaseLink = ctx.phaseLinks.get(root.number);
  for (let i = 0; i < items.length; i++) {
    const isLast = i === items.length - 1 && !phaseLink;
    renderRow(ctx, items[i], "", isLast, siblingSet, out);
  }
  if (phaseLink) {
    out.push(
      `${BRANCH_LAST}Next story queued: #${phaseLink.number} — ${cleanTitle(phaseLink.title)}`,
    );
  }
}

function renderRow(
  ctx: RenderCtx,
  item: DisplayItem,
  prefix: string,
  isLast: boolean,
  siblingSet: Set<number>,
  out: string[],
): void {
  const conn = isLast ? BRANCH_LAST : BRANCH_MID;
  if (item.kind === "closed-group") {
    out.push(`${prefix}${conn}${item.label}`);
    return;
  }
  if (ctx.visited.has(item.number)) return;
  ctx.visited.add(item.number);
  const issue = ctx.byNumber.get(item.number);
  if (!issue) return;
  const planMarker = issue.isPlan ? "Story " : "";
  const badge = statusBadge(issue);
  const badgeStr = badge ? ` ${badge}` : "";
  const blockSuffix = blockerSuffix(issue, siblingSet, ctx.byNumber);
  out.push(
    `${prefix}${conn}${planMarker}#${issue.number}${badgeStr} — ${cleanTitle(issue.title)}${blockSuffix}`,
  );
  const childNums = (ctx.adj.get(issue.number) ?? []).filter(
    (n) => !ctx.visited.has(n),
  );
  if (childNums.length === 0) return;
  const subItems = collapseClosedSiblings(childNums, ctx.byNumber);
  const subSiblingSet = new Set(childNums);
  const childPrefix = prefix + (isLast ? SPACE : VBAR);
  for (let i = 0; i < subItems.length; i++) {
    const last = i === subItems.length - 1;
    renderRow(ctx, subItems[i], childPrefix, last, subSiblingSet, out);
  }
}

// ============================================================
// Top-level: assemble the Stories block
// ============================================================

export function priorityRank(p: Priority): number {
  if (p === "p1") return 1;
  if (p === "p2") return 2;
  if (p === "p3") return 3;
  return 4;
}

export function pickQueuedFooter(
  unlinkedBench: Issue[],
): Issue | null {
  if (unlinkedBench.length === 0) return null;
  const sorted = [...unlinkedBench].sort((a, b) => {
    const dp = priorityRank(a.priority) - priorityRank(b.priority);
    if (dp !== 0) return dp;
    return a.number - b.number;
  });
  return sorted[0];
}

export function renderStoriesBlock(rawIssues: RawIssue[]): string {
  const issues = rawIssues.map(normalizeIssue);
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  const adj = buildAdjacency(issues);

  const activeRoots = findRoots(issues, adj, byNumber);
  const benchPlans = findBenchPlans(issues, adj, byNumber);
  const phaseLinks = buildPhaseLinks(activeRoots, benchPlans);

  const linkedBenchSet = new Set(
    [...phaseLinks.values()].map((i) => i.number),
  );
  const unlinkedBench = benchPlans.filter((b) => !linkedBenchSet.has(b.number));
  const queued = pickQueuedFooter(unlinkedBench);

  const activeCount = activeRoots.length;
  const benchCount = benchPlans.length;
  if (activeCount === 0 && benchCount === 0) return "";

  // Single visited set shared across every root — guards against cycles
  // in user-authored `## Parent` refs AND prevents an issue from being
  // rendered twice if it's reachable from two roots (degenerate, but possible
  // when a root inherits a child via a deleted intermediary).
  const ctx: RenderCtx = { adj, byNumber, phaseLinks, visited: new Set() };
  const lines: string[] = [];
  const header =
    benchCount === 0
      ? `**Stories (${activeCount})**`
      : `**Stories (${activeCount} active + ${benchCount} on bench)**`;
  lines.push(header);
  for (const root of activeRoots) {
    lines.push(...renderTree(ctx, root));
  }
  if (queued) {
    const remainder = unlinkedBench.length - 1;
    const tail = remainder > 0 ? ` (${remainder} more on bench)` : "";
    lines.push(
      `Next story queued: #${queued.number} — ${cleanTitle(queued.title)}${tail}`,
    );
  }
  return lines.join("\n");
}

// ============================================================
// Stale-story detection (anti-drift, ai-brain#178)
// ============================================================

// All issue numbers in the subtree rooted at `rootNum`, INCLUDING the root.
// Cycle-safe via a `seen` set so malformed circular `## Parent` refs can't
// loop forever (same guard rationale as hasOpenDescendant).
export function collectSubtree(
  rootNum: number,
  adj: Map<number, number[]>,
): number[] {
  const seen = new Set<number>([rootNum]);
  const stack = [...(adj.get(rootNum) ?? [])];
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const c of adj.get(n) ?? []) stack.push(c);
  }
  return [...seen];
}

export interface StaleStory {
  number: number;
  title: string;
  daysStale: number;
}

// An ACTIVE story (same roots the Stories block renders) is stale when its
// entire subtree — the story plus every descendant — has had no GitHub issue
// activity for more than `thresholdDays`. "Activity" = max `updatedAt` over the
// subtree, which the brain-os workflow bumps on every /impl close, comment,
// label flip, and cross-referenced commit. AC#3 ("not stale if any child has a
// recent commit") holds because a worked child carries a recent `updatedAt`.
//
// Bench plans are deliberately excluded: a backlog plan with no open children
// isn't being worked, so "stale" is meaningless for it.
export function findStaleStories(
  issues: Issue[],
  adj: Map<number, number[]>,
  byNumber: Map<number, Issue>,
  nowMs: number,
  thresholdDays: number = STALE_THRESHOLD_DAYS,
): StaleStory[] {
  const roots = findRoots(issues, adj, byNumber);
  const out: StaleStory[] = [];
  for (const root of roots) {
    let maxUpdated = 0;
    for (const n of collectSubtree(root.number, adj)) {
      const issue = byNumber.get(n);
      if (issue && issue.updatedAtMs > maxUpdated) maxUpdated = issue.updatedAtMs;
    }
    if (maxUpdated === 0) continue; // no timestamp signal → can't judge
    const daysStale = Math.floor((nowMs - maxUpdated) / MS_PER_DAY);
    if (daysStale > thresholdDays) {
      out.push({ number: root.number, title: cleanTitle(root.title), daysStale });
    }
  }
  // Most-stale first; tie-break on number for deterministic output.
  return out.sort((a, b) => b.daysStale - a.daysStale || a.number - b.number);
}

// Markdown for the "⚠️ Stale stories" section. Empty string when nothing is
// stale (the caller then omits the section entirely).
export function renderStaleBlock(rawIssues: RawIssue[], nowMs: number): string {
  const issues = rawIssues.map(normalizeIssue);
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  const adj = buildAdjacency(issues);
  const stale = findStaleStories(issues, adj, byNumber, nowMs);
  if (stale.length === 0) return "";
  const lines = [`### ⚠️ Stale stories (${stale.length})`];
  for (const s of stale) {
    lines.push(`- ⚠️ STALE: #${s.number} — ${s.title} — ${s.daysStale}d no activity`);
  }
  return lines.join("\n");
}

// ============================================================
// CLI
// ============================================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  // `--stale <json>` emits the anti-drift block; bare `<json>` emits the
  // Stories tree. Both consume the same all-states gh payload.
  if (args[0] === "--stale") {
    const path = args[1];
    if (!path) {
      console.error("usage: build-stories-tree.ts --stale <all-states-body.json>");
      process.exit(2);
    }
    const raw: RawIssue[] = JSON.parse(readFileSync(path, "utf8"));
    const out = renderStaleBlock(raw, Date.now());
    if (out) process.stdout.write(out + "\n");
  } else {
    const path = args[0];
    if (!path) {
      console.error("usage: build-stories-tree.ts <all-states-body.json>");
      process.exit(2);
    }
    const raw: RawIssue[] = JSON.parse(readFileSync(path, "utf8"));
    const out = renderStoriesBlock(raw);
    if (out) process.stdout.write(out + "\n");
  }
}
