#!/usr/bin/env bun
/**
 * run-story.ts — Greedy DAG drainer for multi-issue stories.
 *
 * Usage: bun run scripts/run-story.ts <parent-N> [-p PARALLEL]
 *
 * Reads parent issue body checklist + each child's "Blocked by" section to
 * build the DAG. Spawns AFK workers (claude -w + /impl) for owner:bot children
 * up to parallel cap (default 3, hard max 5). Surfaces owner:human children via
 * a focused Supaterm tab carrying the alert banner (falls back to osascript
 * notification if Supaterm unreachable). Ticks parent body checklist on each
 * close, closes parent + final-notifies on completion.
 *
 * Before the main DAG-drainer loop runs, runPreCheck() (Gate B per
 * references/ac-coverage-spec.md) inspects the parent's ## Acceptance bullets
 * and each child's ## Covers AC mapping. If any parent AC has zero covering
 * child it posts a gh comment on the parent and exits with code 4.
 *
 * Tested via bun test scripts/run-story.test.ts.
 *
 * Self-detach is the caller's job — invoke with `nohup bun run ... &` (see
 * /impl story SKILL prose).
 *
 * Exit codes:
 *   0 — drain completed (parent CLOSED or left OPEN with failed children logged)
 *   1 — fatal orchestrator error (spawn failure, area resolution, gh fault)
 *   4 — Gate B pre-check blocked: parent has AC bullets but children lack
 *       `## Covers AC` coverage. Comment posted on parent. Distinct from 1 so
 *       callers (and the manual-replay CLI in `references/ac-coverage-spec.md`
 *       § 1) can latch on the AC-mapping failure without conflating it with
 *       generic crashes.
 */

import {
  aggregateChildCounters,
  formatImplStoryLogRow,
  summarizeRun,
  type ChildResultRecord,
} from "./lib/ac-coverage.ts";

export type Owner = "bot" | "human";
export type State = "OPEN" | "CLOSED";

export interface Issue {
  number: number;
  deps: number[];
  owner: Owner;
  state: State;
  title: string;
  cwd: string;
}

// =========================================================================
// Pure parsers / helpers (covered by run-story.test.ts)
// =========================================================================

const CHECKLIST_RE = /^- \[[ x]\] (?:[\w-]+)?#(\d+)\b/gm;

export function parseChecklist(body: string): number[] {
  const nums: number[] = [];
  for (const m of body.matchAll(CHECKLIST_RE)) {
    nums.push(Number(m[1]));
  }
  return nums;
}

// Parse the JSON envelope returned by `gh api graphql` for the
// repository.issue.subIssues query. Sorted ascending because GraphQL
// does not guarantee node order. Empty when subIssues is null OR nodes
// is empty (legacy parents without native links). Throws on malformed
// JSON — callers MUST propagate (silent fallback would mask real
// GraphQL errors and is a future debugging nightmare).
export function parseSubIssuesResponse(json: string): number[] {
  const data = JSON.parse(json);
  const nodes: Array<{ number: number }> | null | undefined =
    data?.data?.repository?.issue?.subIssues?.nodes;
  if (!nodes || nodes.length === 0) return [];
  return nodes.map((n) => n.number).sort((a, b) => a - b);
}

// Discover a parent's child issue numbers. Native GitHub sub-issues
// (Phase 2 #219 settled format) are authoritative when present; legacy
// parents that pre-date sub-issue links fall back to the body checklist.
// Both sites that need child enumeration (Gate B pre-check, Gate C
// recheck, main drain loop) already hold parentBody, so it is passed
// in to avoid a redundant fetch.
export async function getChildIssues(
  parent: number,
  gh: { viewSubIssues: (n: number) => Promise<number[]> },
  parentBody: string,
): Promise<number[]> {
  const native = await gh.viewSubIssues(parent);
  if (native.length > 0) return native;
  return parseChecklist(parentBody);
}

// Parent ## Acceptance bullet parser. Source of truth for the regex shape:
// references/ac-coverage-spec.md § 3.1. Em-dash literal is U+2014.
// Spec mandates global match (multiple bullets per body), so we matchAll
// directly without sectioning — bullets matching the pattern outside the
// ## Acceptance section are vanishingly rare and would themselves be a
// filer bug surfaced by the gate.
const ACCEPTANCE_AC_RE = /^- \[[ x]\] \*\*AC#(\d+)\*\* — (.+)$/gm;

export function parseAcceptance(body: string): Map<number, string> {
  const acs = new Map<number, string>();
  for (const m of body.matchAll(ACCEPTANCE_AC_RE)) {
    acs.set(Number(m[1]), m[2]);
  }
  return acs;
}

// Child `## Covers AC` parser. Per spec § 1 the section MUST exist on every
// child filed under a parent story (empty for pure-component children).
// Per spec § 3.2 the regex is line-anchored and applied INSIDE the section
// (locate header → walk lines until next H2). Non-matching lines (blanks,
// stray prose, multi-ID `- AC#1, AC#3` rejected) contribute zero IDs.
const COVERS_AC_LINE_RE = /^- AC#(\d+)\s*$/;

export function parseCoversAc(body: string): Set<number> {
  const lines = body.split("\n");
  let inSection = false;
  const ids = new Set<number>();
  for (const line of lines) {
    if (/^## Covers AC\b/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^## /.test(line)) break;
    if (!inSection) continue;
    const m = line.match(COVERS_AC_LINE_RE);
    if (m) ids.add(Number(m[1]));
  }
  return ids;
}

// Coverage-set differential. Returns parent AC IDs no child claims to cover,
// sorted ascending so the gh-comment id list reads stably across runs.
export function findUncoveredAc(
  parentAcIds: Iterable<number>,
  childCoverage: Map<number, Set<number>>,
): number[] {
  const covered = new Set<number>();
  for (const ids of childCoverage.values()) {
    for (const id of ids) covered.add(id);
  }
  const uncovered: number[] = [];
  for (const id of parentAcIds) {
    if (!covered.has(id)) uncovered.push(id);
  }
  return uncovered.sort((a, b) => a - b);
}

// Thrown by runPreCheck() when at least one parent AC has zero child coverage.
// main() catches this (and only this) to exit 4 instead of 1, so callers can
// distinguish AC-mapping failure from generic orchestrator crashes.
export class PreCheckBlockedError extends Error {
  uncovered: number[];
  constructor(uncovered: number[]) {
    super(
      `AC mapping missing — uncovered: ${uncovered.map((n) => `AC#${n}`).join(", ")}`,
    );
    this.name = "PreCheckBlockedError";
    this.uncovered = uncovered;
  }
}

export function formatUncoveredComment(uncovered: number[]): string {
  const ids = uncovered.map((n) => `AC#${n}`).join(", ");
  return `AC mapping missing — add \`## Covers AC\` to children before resuming. Uncovered: ${ids}`;
}

// =========================================================================
// Gate C helpers — references/ac-coverage-spec.md § 3.3, § 4, § 5
// =========================================================================

// Section heading the gate appends auto-filed evidence-gathering children
// under. Parent body must list these for spec § 4.1 form (i) evidence to fire
// — bare `gh issue create` doesn't link the new child into the parent's
// sub-issue checklist on its own.
export const GATE_C_AUTO_FILED_HEADING =
  "## Auto-filed evidence-gathering children (Gate C)";

// Append a `- [ ] #<child>` checkbox under the auto-filed-children section,
// creating the section if absent. Result is checklist-parser-readable, so
// recheck() finds the new child via parseChecklist on the next iter.
export function appendAutoFiledChild(body: string, child: number): string {
  const line = `- [ ] #${child}`;
  if (body.includes(GATE_C_AUTO_FILED_HEADING)) {
    // Insert at end of section: find heading line, walk forward to next H2 or
    // EOF, insert checkbox immediately before that boundary.
    const lines = body.split("\n");
    let inSection = false;
    let insertAt = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith(GATE_C_AUTO_FILED_HEADING)) {
        inSection = true;
        continue;
      }
      if (inSection && /^## /.test(lines[i])) {
        insertAt = i;
        break;
      }
    }
    // Trim trailing blanks before insertAt so we don't accumulate empty lines.
    let trimAt = insertAt;
    while (trimAt > 0 && lines[trimAt - 1].trim() === "") trimAt--;
    lines.splice(trimAt, insertAt - trimAt, line, "");
    return lines.join("\n");
  }
  // No section yet — append heading + checkbox at end.
  const sep = body.endsWith("\n") ? "" : "\n";
  return `${body}${sep}\n${GATE_C_AUTO_FILED_HEADING}\n\n${line}\n`;
}

// Parent-comment evidence regex per spec § 3.3. Em-dash literal is U+2014.
// Applied per-line within a comment body — the regex is line-anchored so the
// caller MUST split on \n and match each line individually. matchAll-on-block
// won't work even with /m because `.+` would greedily eat across lines.
const PARENT_COMMENT_EVIDENCE_RE = /^Acceptance verified: AC#(\d+) — (.+)$/;

export function parseParentCommentEvidence(commentBody: string): number[] {
  const ids: number[] = [];
  for (const line of commentBody.split("\n")) {
    const m = line.match(PARENT_COMMENT_EVIDENCE_RE);
    if (m) ids.push(Number(m[1]));
  }
  return ids;
}

// Form (ii) evidence-only — returns AC IDs lacking a parent-comment evidence
// match, sorted ascending. Phase 2 (#221) deprecated form (i) closed-child
// implicit evidence; Gate C now ticks AC#N only when `PARENT_COMMENT_EVIDENCE_RE`
// matches in some parent comment. Migration of in-flight stories that relied on
// form-(i) is via /impl per-child (#220) backfilling explicit `Acceptance
// verified: AC#N — …` posts. Spec § 4 still lists both forms during the
// migration window; #223 reconciles the spec.
export function findMissingEvidence(
  parentAcIds: Iterable<number>,
  parentComments: string[],
): number[] {
  const evidence = new Set<number>();
  for (const c of parentComments) {
    for (const id of parseParentCommentEvidence(c)) evidence.add(id);
  }
  const missing: number[] = [];
  for (const id of parentAcIds) {
    if (!evidence.has(id)) missing.push(id);
  }
  return missing.sort((a, b) => a - b);
}

// First `area:*` label, with `area:` prefix stripped. Used to copy the parent's
// area onto evidence-gathering children filed during Phase 2 (so Bun.spawn lands
// the worker in the correct repo via inferRepoFromIssueArea).
export function extractAreaName(labels: string[]): string | null {
  for (const l of labels) {
    if (l.startsWith("area:")) return l.slice("area:".length);
  }
  return null;
}

export function formatEvidenceChildTitle(parent: number, ac: number): string {
  return `Evidence: AC#${ac} for parent #${parent}`;
}

export function formatEvidenceChildBody(
  parent: number,
  ac: number,
  acText: string,
): string {
  return [
    "## Parent",
    "",
    `- ai-brain#${parent}`,
    "",
    "## Covers AC",
    "",
    `- AC#${ac}`,
    "",
    "## What to build",
    "",
    acText,
    "",
    "## Acceptance",
    "",
    `- [ ] Live evidence captured (output pasted in this issue) for AC#${ac}`,
    "",
    "## Files",
    "",
    "(per AC text)",
    "",
    "## Observable",
    "",
    "(per AC text)",
    "",
    "## Blocked by",
    "",
    "None — can start immediately.",
    "",
  ].join("\n");
}

export function formatHitlComment(missing: number[]): string {
  const ids = missing.map((n) => `AC#${n}`).join(", ");
  return `Acceptance gate failed after 3 ralph iters. Missing evidence: ${ids}. Post 'Acceptance verified: AC#N — <evidence>' comments OR file new covering child to resolve.`;
}

export function formatHitlNotification(parent: number, missing: number[]): string {
  const ids = missing.map((n) => `AC#${n}`).join(", ");
  return `Parent #${parent} has unverified AC: ${ids} — see issue`;
}

// impl-story.log row write is owned by #203's writeImplStoryLogRow + the
// ImplStoryResult enum + formatImplStoryLogRow lives in lib/ac-coverage.ts.
// Gate C signals `gateBlocked` to that path so deriveResult maps a blocked
// parent to `hitl-fallback` per spec § 5; no row write happens inside Gate C.

export function parseBlockers(body: string): number[] {
  // Find the "## Blocked by" section, capture lines until next H2.
  const lines = body.split("\n");
  let inSection = false;
  const blockers: number[] = [];
  for (const line of lines) {
    if (/^## Blocked by\b/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^## /.test(line)) {
      break;
    }
    if (inSection) {
      const m = line.match(/ai-brain#(\d+)/);
      if (m) blockers.push(Number(m[1]));
    }
  }
  return blockers;
}

export function parseOwner(labels: string[]): Owner {
  for (const l of labels) {
    if (l === "owner:human") return "human";
    if (l === "owner:bot") return "bot";
  }
  return "bot";
}

// Public default area → repo path mapping. Extended at runtime from
// ${home}/.brain-os/areas.json so private deployments register their own
// areas without committing identifiers into this public source file.
export function defaultAreaMap(home: string): Record<string, string> {
  return {
    "plugin-brain-os": `${home}/work/brain-os-plugin`,
    "plugin-ai-leaders-vietnam": `${home}/work/ai-leaders-vietnam`,
    "vault": `${home}/work/brain`,
    "claude-config": `${home}/.claude`,
  };
}

export function inferRepoFromIssueArea(
  labels: string[],
  areaMap: Record<string, string>,
): string {
  for (const l of labels) {
    if (!l.startsWith("area:")) continue;
    const area = l.slice("area:".length);
    if (area in areaMap) return areaMap[area];
  }
  throw new Error(`no known area:* label in [${labels.join(", ")}]`);
}

export function tickChecklist(body: string, child: number): string {
  const re = new RegExp(`^- \\[ \\] #${child}\\b`, "gm");
  return body.replace(re, (m) => m.replace("[ ]", "[x]"));
}

// Tick the parent `## Acceptance` bullet for AC#<acId>: `- [ ] **AC#N** — …` →
// `- [x] **AC#N** — …`. Mirrors tickChecklist shape but anchors on the bold
// AC tag from the SSOT regex (references/ac-coverage-spec.md § 3.1, U+2014
// em-dash literal). `\\*\\*` escapes the markdown bold markers; the trailing
// ` — ` (space + em-dash + space) prevents partial matches like `**AC#3**`
// matching `**AC#30**`. Idempotent — the regex only catches `[ ]`, not `[x]`,
// so re-applying on an already-ticked body returns it unchanged.
export function tickAcceptance(body: string, acId: number): string {
  const re = new RegExp(`^- \\[ \\] \\*\\*AC#${acId}\\*\\* — `, "gm");
  return body.replace(re, (m) => m.replace("[ ]", "[x]"));
}

// Detect the user-imposed manual gate that defers automated parent-close.
// Matches `## Verification (post-merge, manual)` as a standalone H2 line
// (line-anchored, trailing whitespace tolerated). Used by Gate C: when
// present, the gate posts a "manual verification pending" comment and
// leaves the parent OPEN instead of auto-closing.
export function hasManualVerificationSection(body: string): boolean {
  return /^## Verification \(post-merge, manual\)\s*$/m.test(body);
}

export function clampParallel(p: number, hardCap: number): number {
  if (p < 1) return 1;
  if (p > hardCap) return hardCap;
  return p;
}

export function computeReady(issues: Issue[], closed: Set<number>): number[] {
  const ready: number[] = [];
  for (const issue of issues) {
    if (issue.state === "CLOSED") continue;
    if (closed.has(issue.number)) continue;
    const allDepsClosed = issue.deps.every((d) => closed.has(d));
    if (allDepsClosed) ready.push(issue.number);
  }
  return ready;
}

export function promoteWaiters(
  issues: Issue[],
  justClosed: number,
  closed: Set<number>,
  pending: Set<number>,
): number[] {
  const promoted: number[] = [];
  for (const issue of issues) {
    if (!pending.has(issue.number)) continue;
    if (!issue.deps.includes(justClosed)) continue;
    const allDepsClosed = issue.deps.every((d) => closed.has(d));
    if (allDepsClosed) promoted.push(issue.number);
  }
  return promoted;
}

// =========================================================================
// IO interfaces (mockable for integration tests)
// =========================================================================

export interface GhClient {
  viewBody(n: number): Promise<string>;
  viewFull(n: number): Promise<{ title: string; body: string; labels: string[]; state: State }>;
  viewState(n: number): Promise<State>;
  editBody(n: number, body: string): Promise<void>;
  closeIssue(n: number): Promise<void>;
  relabelHuman(n: number): Promise<void>;
  /**
   * List issues by label filter. Used by run-parallel.ts queue-pick mode.
   * Filter labels are AND-joined into one --label arg per gh CLI semantics.
   */
  listIssues(
    labels: string[],
    limit: number,
  ): Promise<Array<{ number: number; title: string; labels: string[] }>>;
  /**
   * Atomic claim: status:ready → status:in-progress via the canonical helper.
   * Used by run-parallel.ts since each parallel batch claims N issues up front
   * (run-story.ts claims happen inside per-child workers).
   */
  claim(n: number): Promise<void>;
  /**
   * Post a comment on an issue. Used by runPreCheck() to surface AC-mapping
   * gaps on the parent before /impl story enters the main drainer loop.
   */
  addComment(n: number, body: string): Promise<void>;
  /**
   * Fetch all comment bodies on an issue. Used by Gate C form (ii) check
   * (`Acceptance verified: AC#N — <evidence>` regex per spec § 3.3 / § 4.2).
   */
  viewComments(n: number): Promise<string[]>;
  /**
   * File a new tracker issue via gh-tasks/create-task-issue.sh (canonical
   * label-set assembly). Returns the new issue number. Used by Gate C
   * Phase 2 to file evidence-gathering children.
   */
  createIssue(opts: CreateIssueOpts): Promise<number>;
  /**
   * List native GitHub sub-issues of a parent via `gh api graphql`. Used by
   * `getChildIssues` to prefer Phase 2 native links over legacy body
   * checklists. Returns sorted issue numbers; empty when the parent has no
   * sub-issue links (caller falls back to `parseChecklist`).
   */
  viewSubIssues(parent: number): Promise<number[]>;
}

export interface CreateIssueOpts {
  title: string;
  body: string;
  area: string;
  owner: "bot" | "human";
  priority: "p1" | "p2" | "p3";
  weight: "quick" | "heavy";
  status: "ready" | "blocked" | "backlog";
  type?: "handover" | "plan";
}

export interface SpawnClient {
  spawnWorker(name: string, prompt: string, logPath: string, cwd: string): { pid: number };
  cleanupWorktree(name: string, cwd: string): void;
}

export interface ProcessChecker {
  isAlive(pid: number): boolean;
}

export interface Notifier {
  notify(message: string): void;
}

export interface Logger {
  log(msg: string): void;
}

export interface StoryStatus {
  ts: string;
  parent: number;
  phase: "starting" | "polling" | "done" | "died";
  pid: number;
  cap: number;
  watching: number[];
  ready: number[];
  closed: number[];
  failed: number[];
  hb: number;
  error?: string;
}

export interface StatusWriter {
  write(status: StoryStatus): void;
}

// Per-child result files written by /impl workers (see SKILL.md § Workflow —
// `issue` mode → "Child-level ralph + advisor wrapper"). The orchestrator reads
// these at run-end to aggregate impl-story.log row counters.
export interface ChildResultReader {
  read(parent: number, child: number): Promise<ChildResultRecord | null>;
}

// One-shot append to {vault}/daily/skill-outcomes/impl-story.log. Spec § 5.
export interface ImplStoryLogWriter {
  append(line: string): Promise<void>;
}

// Decide what to do with a watched AFK child after a poll cycle.
// Pure function — testable without IO.
export type WorkerAction = "running" | "closed" | "dead";

export function decideWorkerAction(pidAlive: boolean, state: State): WorkerAction {
  if (state === "CLOSED") return "closed";
  if (!pidAlive) return "dead"; // process gone but issue still OPEN = failure
  return "running";
}

// Remove worktree + branch left behind by a closed worker. Failures (locked
// dirs, missing branches, no-upstream protection) are logged and swallowed —
// a stuck cleanup must not block sibling drains.
export async function cleanupWorker(
  spawn: SpawnClient,
  name: string,
  cwd: string,
  logger: Logger,
): Promise<void> {
  try {
    spawn.cleanupWorktree(name, cwd);
    logger.log(`cleaned worktree: ${name} in ${cwd}`);
  } catch (err) {
    logger.log(`cleanup failed for ${name} in ${cwd}: ${(err as Error).message}`);
  }
}

// =========================================================================
// Real implementations (Bun.spawn / gh CLI / osascript)
// =========================================================================

export class RealGh implements GhClient {
  constructor(private repo: string) {}

  private async run(args: string[]): Promise<string> {
    const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`gh ${args.join(" ")} exited ${code}: ${err}`);
    }
    return out.trim();
  }

  async viewBody(n: number): Promise<string> {
    return this.run(["issue", "view", String(n), "-R", this.repo, "--json", "body", "--jq", ".body"]);
  }

  async viewFull(n: number): Promise<{ title: string; body: string; labels: string[]; state: State }> {
    const json = await this.run(["issue", "view", String(n), "-R", this.repo, "--json", "title,body,labels,state"]);
    const data = JSON.parse(json);
    return {
      title: data.title,
      body: data.body,
      labels: data.labels.map((l: { name: string }) => l.name),
      state: data.state as State,
    };
  }

  async viewState(n: number): Promise<State> {
    const out = await this.run(["issue", "view", String(n), "-R", this.repo, "--json", "state", "--jq", ".state"]);
    return out as State;
  }

  async editBody(n: number, body: string): Promise<void> {
    const tmpFile = `/tmp/run-story-${n}-${Date.now()}.md`;
    await Bun.write(tmpFile, body);
    await this.run(["issue", "edit", String(n), "-R", this.repo, "--body-file", tmpFile]);
  }

  async closeIssue(n: number): Promise<void> {
    // Shell out to close-issue.sh — canonical close site (strips status:* labels
    // first, then closes). Bypassing it leaves ghost status:in-progress on the
    // parent (root cause of #179 ghost-label leak, 2026-04-29).
    const helper = `${import.meta.dir}/gh-tasks/close-issue.sh`;
    const proc = Bun.spawn(["bash", helper, String(n)], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`close-issue.sh ${n} exited ${code}: ${err}`);
    }
  }

  async relabelHuman(n: number): Promise<void> {
    // Best-effort: remove status:in-progress + owner:bot, add status:ready + owner:human.
    // Each label op may fail individually if label not present — we tolerate that.
    const ops: string[][] = [
      ["issue", "edit", String(n), "-R", this.repo, "--remove-label", "status:in-progress", "--add-label", "status:ready"],
      ["issue", "edit", String(n), "-R", this.repo, "--remove-label", "owner:bot", "--add-label", "owner:human"],
    ];
    for (const args of ops) {
      try { await this.run(args); } catch { /* tolerate */ }
    }
  }

  async listIssues(
    labels: string[],
    limit: number,
  ): Promise<Array<{ number: number; title: string; labels: string[] }>> {
    const labelFilter = labels.join(",");
    const json = await this.run([
      "issue",
      "list",
      "-R",
      this.repo,
      "--label",
      labelFilter,
      "--state",
      "open",
      "--json",
      "number,title,labels",
      "--limit",
      String(limit),
    ]);
    const data = JSON.parse(json) as Array<{
      number: number;
      title: string;
      labels: Array<{ name: string }>;
    }>;
    return data.map((r) => ({
      number: r.number,
      title: r.title,
      labels: r.labels.map((l) => l.name),
    }));
  }

  async claim(n: number): Promise<void> {
    // Shell out to transition-status.sh — canonical status-flip site (reads
    // current status:* label, removes it, adds target atomically + canon-
    // validates against references/gh-task-labels.md § 3). Bypassing it
    // double-adds when current ≠ status:ready (sibling to close-side ghost-
    // label leak fixed in 6b41e51 / ai-brain#179, ai-brain#195).
    const helper = `${import.meta.dir}/gh-tasks/transition-status.sh`;
    const proc = Bun.spawn(["bash", helper, String(n), "--to", "in-progress"], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`transition-status.sh ${n} --to in-progress exited ${code}: ${err}`);
    }
  }

  async addComment(n: number, body: string): Promise<void> {
    // gh's --body arg shells through argv → newlines and backticks survive,
    // but --body-file is the safer path for arbitrary text. Same pattern as
    // editBody above.
    const tmpFile = `/tmp/run-story-comment-${n}-${Date.now()}.md`;
    await Bun.write(tmpFile, body);
    await this.run(["issue", "comment", String(n), "-R", this.repo, "--body-file", tmpFile]);
  }

  async viewComments(n: number): Promise<string[]> {
    const json = await this.run([
      "issue",
      "view",
      String(n),
      "-R",
      this.repo,
      "--json",
      "comments",
    ]);
    const data = JSON.parse(json) as { comments: Array<{ body: string }> };
    return data.comments.map((c) => c.body);
  }

  async createIssue(opts: CreateIssueOpts): Promise<number> {
    // Shell out to create-task-issue.sh — canonical label-set assembly.
    // Body is written via --body-file (helper accepts --body string only,
    // so we pre-build a file and inline-read it; backticks/newlines survive
    // env passing more reliably than argv quoting on some shells).
    const helper = `${import.meta.dir}/gh-tasks/create-task-issue.sh`;
    const args = [
      "bash",
      helper,
      "--title",
      opts.title,
      "--body",
      opts.body,
      "--area",
      opts.area,
      "--owner",
      opts.owner,
      "--priority",
      opts.priority,
      "--weight",
      opts.weight,
      "--status",
      opts.status,
    ];
    if (opts.type) {
      args.push("--type", opts.type);
    }
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`create-task-issue.sh exited ${code}: ${err}`);
    }
    // Helper writes the new issue URL on stdout (last non-empty line). Extract
    // the trailing /<N>.
    const trimmed = out.trim().split("\n").filter((l) => l.length > 0).pop() ?? "";
    const m = trimmed.match(/\/(\d+)$/);
    if (!m) {
      throw new Error(`create-task-issue.sh stdout does not match URL pattern: ${trimmed}`);
    }
    return Number(m[1]);
  }

  async viewSubIssues(parent: number): Promise<number[]> {
    const [owner, name] = this.repo.split("/");
    if (!owner || !name) {
      throw new Error(`viewSubIssues: malformed repo "${this.repo}" — expected "owner/name"`);
    }
    const query =
      'query($owner:String!,$name:String!,$num:Int!){repository(owner:$owner,name:$name){issue(number:$num){subIssues(first:50){nodes{number}}}}}';
    const json = await this.run([
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `num=${parent}`,
    ]);
    return parseSubIssuesResponse(json);
  }
}

export class RealSpawn implements SpawnClient {
  spawnWorker(name: string, prompt: string, logPath: string, cwd: string): { pid: number } {
    const fs = require("fs");
    const fd = fs.openSync(logPath, "a");
    try {
      const proc = Bun.spawn(
        [
          "claude",
          "-w",
          name,
          "--dangerously-skip-permissions",
          "-p",
          prompt,
        ],
        {
          stdin: "ignore",
          stdout: fd,
          stderr: fd,
          cwd,
        },
      );
      return { pid: proc.pid };
    } finally {
      fs.closeSync(fd);
    }
  }

  cleanupWorktree(name: string, cwd: string): void {
    const { execSync } = require("child_process");
    // Run both commands; collect first error so a missing worktree does not
    // skip the branch delete (and vice versa). Throw at end if anything failed
    // — caller (cleanupWorker) catches and logs.
    let firstErr: Error | null = null;
    const cmds = [
      ["git", "-C", cwd, "worktree", "remove", `.claude/worktrees/${name}`, "--force"],
      ["git", "-C", cwd, "branch", "-D", `worktree-${name}`],
    ];
    for (const cmd of cmds) {
      try {
        execSync(cmd.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(" "), { stdio: "pipe" });
      } catch (err) {
        if (!firstErr) firstErr = err as Error;
      }
    }
    if (firstErr) throw firstErr;
  }
}

export class RealProcessChecker implements ProcessChecker {
  isAlive(pid: number): boolean {
    try {
      // Signal 0 doesn't actually send anything — just checks existence + permission.
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return false; // no such process
      if (code === "EPERM") return true; // exists but not ours; treat as alive
      return false;
    }
  }
}

export class RealNotifier implements Notifier {
  private static readonly SP = "/Applications/supaterm.app/Contents/Resources/bin/sp";
  constructor(private title: string) {}
  notify(message: string): void {
    const title = this.title;
    const escapedShell = (s: string) => s.replace(/'/g, "'\\''");
    const banner = [
      `clear`,
      `printf '\\033[1;33m=== %s ===\\033[0m\\n\\n' '${escapedShell(title)}'`,
      `printf '%s\\n\\n' '${escapedShell(message)}'`,
      `afplay /System/Library/Sounds/Glass.aiff &`,
      `printf 'Press Enter to dismiss '; read -r`,
    ].join("; ");
    try {
      const sp = Bun.spawnSync({
        cmd: [RealNotifier.SP, "tab", "new", "--focus", "--quiet", "--script", banner],
        stdout: "ignore",
        stderr: "pipe",
      });
      if (sp.exitCode === 0) return;
    } catch {
      // sp binary missing or threw — fall through to osascript
    }
    const osaEscaped = message.replace(/"/g, '\\"');
    Bun.spawn([
      "osascript",
      "-e",
      `display notification "${osaEscaped}" with title "${title}" sound name "Glass"`,
    ]);
  }
}

export class FileLogger implements Logger {
  constructor(private path: string) {}
  log(msg: string): void {
    const line = `${new Date().toISOString()} | ${msg}\n`;
    const fs = require("fs");
    fs.appendFileSync(this.path, line);
  }
}

export class FileStatusWriter implements StatusWriter {
  constructor(private path: string) {}
  write(status: StoryStatus): void {
    const fs = require("fs");
    fs.writeFileSync(this.path, JSON.stringify(status));
  }
}

export class FileChildResultReader implements ChildResultReader {
  constructor(private dir: string) {}
  async read(parent: number, child: number): Promise<ChildResultRecord | null> {
    const path = `${this.dir}/${parent}-child-${child}.result`;
    try {
      const fs = require("fs");
      const raw = fs.readFileSync(path, "utf-8");
      return JSON.parse(raw) as ChildResultRecord;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw err;
    }
  }
}

export class FileImplStoryLogWriter implements ImplStoryLogWriter {
  constructor(private path: string) {}
  async append(line: string): Promise<void> {
    const fs = require("fs");
    const path = require("path");
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.appendFileSync(this.path, line + "\n");
  }
}

// =========================================================================
// AC#10 instrumentation — per-run impl-story.log row
// =========================================================================

export interface WriteImplStoryLogArgs {
  parent: number;
  childBodies: Map<number, string>;
  parentBody: string;
  failed: number[];
  parentClosed: boolean;
  // Gate C blocked the close per references/ac-coverage-spec.md § 4. Defaults
  // to false so existing callers don't need to thread it.
  gateBlocked?: boolean;
  wallTimeSec: number;
  childResults?: ChildResultReader;
  implStoryLog?: ImplStoryLogWriter;
  logger: Logger;
}

export async function writeImplStoryLogRow(args: WriteImplStoryLogArgs): Promise<void> {
  if (!args.implStoryLog) {
    args.logger.log("WARN: implStoryLog not configured — skipping impl-story.log row");
    return;
  }

  const records: ChildResultRecord[] = [];
  for (const child of args.childBodies.keys()) {
    if (!args.childResults) continue;
    try {
      const rec = await args.childResults.read(args.parent, child);
      if (rec) {
        records.push(rec);
      } else {
        args.logger.log(
          `WARN: no per-child result file for #${child} (worker may have crashed mid-flight) — counters=0 for this child`,
        );
      }
    } catch (err) {
      args.logger.log(
        `WARN: failed reading result file for #${child}: ${(err as Error).message} — counters=0 for this child`,
      );
    }
  }

  const counters = aggregateChildCounters(records);
  const row = summarizeRun(
    {
      parentIssue: args.parent,
      childBodies: args.childBodies,
      parentBody: args.parentBody,
      counters,
      wallTimeSec: args.wallTimeSec,
      failedChildren: args.failed,
    },
    args.parentClosed,
    args.gateBlocked ?? false,
  );
  await args.implStoryLog.append(formatImplStoryLogRow(row));
  args.logger.log(
    `impl-story.log row appended (${row.result}, advisor_calls=${row.advisorCalls}, advisor_rejections=${row.advisorRejections}, wall=${row.wallTimeSec}s)`,
  );
}

// =========================================================================
// Pre-check (Gate B per references/ac-coverage-spec.md)
// =========================================================================

export interface PreCheckDeps {
  gh: GhClient;
  logger: Logger;
}

/**
 * Gate B — refuse to start /impl story if parent has `## Acceptance` bullets
 * but children lack `## Covers AC` coverage. Posts a gh comment listing
 * uncovered AC IDs before throwing PreCheckBlockedError. Skips entirely on
 * legacy parents with no AC bullets (grandfathered).
 *
 * Cross-references: references/ac-coverage-spec.md § 1, § 3 (regex SSOT).
 * Throws on block; main() maps the error to exit code 4.
 */
export async function runPreCheck(
  parent: number,
  deps: PreCheckDeps,
): Promise<void> {
  const { gh, logger } = deps;
  const parentFull = await gh.viewFull(parent);
  const parentAc = parseAcceptance(parentFull.body);
  if (parentAc.size === 0) {
    logger.log(
      `pre-check: parent #${parent} has no ## Acceptance bullets — skipping (legacy)`,
    );
    return;
  }
  const parentAcIds = [...parentAc.keys()].sort((a, b) => a - b);
  logger.log(
    `pre-check: parent #${parent} has ${parentAcIds.length} AC bullets: [${parentAcIds.join(",")}]`,
  );

  const childNums = await getChildIssues(parent, gh, parentFull.body);
  const childCoverage = new Map<number, Set<number>>();
  for (const n of childNums) {
    const child = await gh.viewFull(n);
    const ids = parseCoversAc(child.body);
    childCoverage.set(n, ids);
    logger.log(
      `pre-check: child #${n} covers [${[...ids].sort((a, b) => a - b).join(",")}]`,
    );
  }

  const uncovered = findUncoveredAc(parentAcIds, childCoverage);
  if (uncovered.length === 0) {
    logger.log(`pre-check: all ${parentAcIds.length} AC covered — proceed`);
    return;
  }

  const comment = formatUncoveredComment(uncovered);
  logger.log(
    `pre-check: BLOCK — uncovered ${uncovered.map((n) => `AC#${n}`).join(", ")}; posting comment on #${parent}`,
  );
  await gh.addComment(parent, comment);
  throw new PreCheckBlockedError(uncovered);
}

// =========================================================================
// Close gate (Gate C per references/ac-coverage-spec.md § 4)
// =========================================================================

export interface CloseGateDeps {
  gh: GhClient;
  spawn: SpawnClient;
  proc: ProcessChecker;
  notify: Notifier;
  logger: Logger;
  pollIntervalMs: number;
  workerLogDir: string;
  areaMap: Record<string, string>;
}

export interface CloseGateResult {
  blocked: boolean;
  missing: number[];
  iterations: number;
  spawnedChildren: number[];
}

const CLOSE_GATE_MAX_ITERS = 3;

/**
 * Gate C — refuses to close parent if any AC#N lacks evidence form (i) or (ii)
 * per references/ac-coverage-spec.md § 4. Three phases:
 *
 * 1. Deterministic check: parse parent body's `## Acceptance` bullets; for each
 *    AC#N look for either (i) a CLOSED child whose `## Covers AC` includes N,
 *    or (ii) a parent comment line matching `Acceptance verified: AC#N — …`.
 *    No gaps → return `{ blocked: false }` and let main loop close parent.
 * 2. Ralph auto-fill: up to 3 iters, each iter files one evidence-gathering
 *    child per still-missing AC + spawns `/impl <child-N>` (worker session
 *    handles its own /tdd + commit + close). Polls children, recompiles
 *    evidence on each cycle. NOT child-level ralph — that's #203's scope.
 * 3. HITL fallback: if 3 iters don't resolve, osascript-notify the operator,
 *    post a follow-up comment on the parent, append a `partial`-result row
 *    to impl-story.log, return `{ blocked: true }`. Main loop must NOT close
 *    parent.
 *
 * Spec § 5 col 8 enum is `pass | partial | fail`. The issue body's literal
 * `result=hitl-fallback` was reconciled to `partial` per the spec's "this doc
 * wins" clause.
 */
export async function runCloseGate(
  parent: number,
  deps: CloseGateDeps,
): Promise<CloseGateResult> {
  const { gh, logger, pollIntervalMs, areaMap } = deps;

  // Phase 1 — form-(ii) parent-comment evidence only (#221 dropped form-(i)
  // closed-child implicit evidence). childCount is still tracked for logging
  // even though it no longer drives the missing computation.
  const recheck = async () => {
    const parentFull = await gh.viewFull(parent);
    const parentAc = parseAcceptance(parentFull.body);
    if (parentAc.size === 0) return { missing: [], childCount: 0, parentFull, parentAc };
    const parentAcIds = [...parentAc.keys()].sort((a, b) => a - b);
    const childNums = await getChildIssues(parent, gh, parentFull.body);
    const comments = await gh.viewComments(parent);
    return {
      missing: findMissingEvidence(parentAcIds, comments),
      childCount: childNums.length,
      parentFull,
      parentAc,
    };
  };

  let { missing, childCount, parentFull, parentAc } = await recheck();
  logger.log(
    `close-gate: parent #${parent} childCount=${childCount} initial missing=[${missing.join(",")}]`,
  );

  // No AC bullets at all → grandfathered legacy parent; let close proceed.
  if (parentAc.size === 0) {
    logger.log(`close-gate: parent #${parent} has no ## Acceptance bullets — skipping (legacy)`);
    return { blocked: false, missing: [], iterations: 0, spawnedChildren: [] };
  }
  if (missing.length === 0) {
    logger.log(`close-gate: all ${parentAc.size} AC have evidence — proceed to close`);
    return { blocked: false, missing: [], iterations: 0, spawnedChildren: [] };
  }

  // Phase 2 prep — derive parent's area + cwd. Without these the orchestrator
  // can't file/spawn evidence-gathering children, so jump straight to Phase 3.
  const parentArea = extractAreaName(parentFull.labels);
  let parentCwd: string | null = null;
  if (parentArea) {
    try {
      parentCwd = inferRepoFromIssueArea(parentFull.labels, areaMap);
    } catch (err) {
      logger.log(
        `close-gate: cannot resolve cwd for parent #${parent}: ${(err as Error).message} — skipping Phase 2`,
      );
    }
  } else {
    logger.log(
      `close-gate: parent #${parent} has no area:* label — skipping Phase 2`,
    );
  }

  const allSpawned: number[] = [];

  if (parentArea && parentCwd) {
    for (let iter = 1; iter <= CLOSE_GATE_MAX_ITERS; iter++) {
      if (missing.length === 0) break;
      logger.log(`close-gate: iter ${iter}/${CLOSE_GATE_MAX_ITERS} — missing=[${missing.join(",")}]`);

      const spawnedThisIter: { child: number; ac: number; pid: number }[] = [];
      for (const ac of missing) {
        const acText = parentAc.get(ac) ?? "(AC text unavailable in parent body)";
        const title = formatEvidenceChildTitle(parent, ac);
        const body = formatEvidenceChildBody(parent, ac, acText);
        let newChild: number;
        try {
          newChild = await gh.createIssue({
            title,
            body,
            area: parentArea,
            owner: "human",
            priority: "p1",
            weight: "heavy",
            status: "ready",
          });
        } catch (err) {
          logger.log(
            `close-gate: iter ${iter}: failed to file evidence child for AC#${ac}: ${(err as Error).message}`,
          );
          continue;
        }
        logger.log(`close-gate: iter ${iter}: filed evidence child #${newChild} for AC#${ac}`);
        allSpawned.push(newChild);

        // Link the new child into parent body's sub-issue checklist (spec
        // § 4.1 requires the child to be "in the parent's sub-issue list" for
        // form (i) evidence). Without this, recheck() won't see the closed
        // child even though it carries the right Covers AC.
        try {
          const currentParentBody = await gh.viewBody(parent);
          const updatedBody = appendAutoFiledChild(currentParentBody, newChild);
          if (updatedBody !== currentParentBody) {
            await gh.editBody(parent, updatedBody);
          }
        } catch (err) {
          logger.log(
            `close-gate: iter ${iter}: failed to link #${newChild} into parent #${parent} body: ${(err as Error).message}`,
          );
        }

        const workerLog = `${deps.workerLogDir}/${parent}-evidence-${newChild}.log`;
        let pid: number;
        try {
          ({ pid } = deps.spawn.spawnWorker(
            `story-${parent}-evidence-${newChild}`,
            `/impl ${newChild}`,
            workerLog,
            parentCwd,
          ));
        } catch (err) {
          logger.log(
            `close-gate: iter ${iter}: spawn failed for #${newChild}: ${(err as Error).message}`,
          );
          continue;
        }
        logger.log(`close-gate: iter ${iter}: spawned /impl ${newChild} (pid=${pid})`);
        spawnedThisIter.push({ child: newChild, ac, pid });
      }

      if (spawnedThisIter.length === 0) {
        logger.log(`close-gate: iter ${iter}: no children spawned — bailing to Phase 3`);
        break;
      }

      const watching = new Map(spawnedThisIter.map((s) => [s.child, s] as const));
      while (watching.size > 0) {
        await Bun.sleep(pollIntervalMs);
        for (const [child, s] of [...watching.entries()]) {
          let state: State;
          try {
            state = await gh.viewState(child);
          } catch (err) {
            logger.log(
              `close-gate: viewState(#${child}) errored: ${(err as Error).message} — retry next cycle`,
            );
            continue;
          }
          const action = decideWorkerAction(deps.proc.isAlive(s.pid), state);
          if (action === "running") continue;
          if (action === "closed") {
            logger.log(`close-gate: iter ${iter}: child #${child} closed`);
          } else {
            logger.log(
              `close-gate: iter ${iter}: child #${child} worker died (PID gone, issue OPEN) — abandoning`,
            );
          }
          watching.delete(child);
        }
      }

      const before = new Set(missing);
      const next = await recheck();
      missing = next.missing;
      parentAc = next.parentAc;
      parentFull = next.parentFull;
      // AC#4 mentions <promise>AC_EVIDENCE_FOUND</promise> — there's no outer
      // ralph wrapping the gate, so we just log the resolution to keep the
      // audit trail aligned with the AC text.
      for (const ac of before) {
        if (!missing.includes(ac)) {
          logger.log(
            `close-gate: AC#${ac} evidence found — promise AC_EVIDENCE_FOUND`,
          );
        }
      }
      logger.log(`close-gate: iter ${iter}: post-recheck missing=[${missing.join(",")}]`);
    }
  }

  if (missing.length === 0) {
    logger.log(`close-gate: all AC verified after Phase 2 — proceed to close`);
    return {
      blocked: false,
      missing: [],
      iterations: CLOSE_GATE_MAX_ITERS,
      spawnedChildren: allSpawned,
    };
  }

  // Phase 3 — HITL fallback. Log row is written by writeImplStoryLogRow at
  // the end of runStory (using gateBlocked → deriveResult = "hitl-fallback");
  // the gate just notifies + comments on the parent and returns blocked.
  logger.log(
    `close-gate: HITL fallback — missing=[${missing.join(",")}] after ${CLOSE_GATE_MAX_ITERS} iters`,
  );
  deps.notify.notify(formatHitlNotification(parent, missing));
  try {
    await gh.addComment(parent, formatHitlComment(missing));
  } catch (err) {
    logger.log(`close-gate: failed to post HITL comment: ${(err as Error).message}`);
  }
  return {
    blocked: true,
    missing,
    iterations: CLOSE_GATE_MAX_ITERS,
    spawnedChildren: allSpawned,
  };
}

// =========================================================================
// Orchestrator
// =========================================================================

export interface OrchestratorDeps {
  gh: GhClient;
  spawn: SpawnClient;
  proc: ProcessChecker;
  notify: Notifier;
  logger: Logger;
  status: StatusWriter;
  pollIntervalMs: number;
  workerLogDir: string;
  areaMap: Record<string, string>;
  // AC#10 instrumentation — optional so existing callers (and tests) work
  // unchanged. When absent, the run skips the impl-story.log row write but
  // logs a one-line warning.
  childResults?: ChildResultReader;
  implStoryLog?: ImplStoryLogWriter;
  // Injectable clock for deterministic wall-time test assertions.
  now?: () => number;
}

export async function runStory(
  parent: number,
  parallel: number,
  deps: OrchestratorDeps,
): Promise<{ closed: number[]; failed: number[] }> {
  const HARD_CAP = 5;
  const cap = clampParallel(parallel, HARD_CAP);
  const { gh, spawn, proc, notify, logger, status, pollIntervalMs, workerLogDir, areaMap } = deps;
  const failed: number[] = [];
  let hb = 0;
  const now = deps.now ?? (() => Date.now());
  const startMs = now();

  logger.log(`=== run-story start | parent=#${parent} parallel=${cap} ===`);
  status.write({
    ts: new Date().toISOString(),
    parent,
    phase: "starting",
    pid: process.pid,
    cap,
    watching: [],
    ready: [],
    closed: [],
    failed: [],
    hb,
  });
  notify.notify(`Orchestrator started for #${parent} (PID ${process.pid}, cap ${cap})`);

  const parentFull = await gh.viewFull(parent);
  if (!parentFull.labels.includes("type:plan")) {
    logger.log(`ERROR: parent #${parent} lacks type:plan label (labels=[${parentFull.labels.join(",")}]) — refusing to drain`);
    notify.notify(`#${parent} not type:plan, refuse to drain. Use /impl ${parent} for single-issue tdd.`);
    return { closed: [], failed: [] };
  }
  const childNums = await getChildIssues(parent, gh, parentFull.body);
  if (childNums.length === 0) {
    logger.log(`ERROR: no children found in parent #${parent} (neither native sub-issues nor body checklist)`);
    notify.notify(`Story #${parent} — no children found, aborting`);
    return { closed: [], failed: [] };
  }
  logger.log(`children: ${childNums.join(", ")}`);

  // Build issue index — also stash bodies for impl-story.log live_ac_child_count.
  const issues: Issue[] = [];
  const childBodies = new Map<number, string>();
  for (const n of childNums) {
    const full = await gh.viewFull(n);
    childBodies.set(n, full.body);
    const blockers = parseBlockers(full.body).filter((b) => b !== parent);
    const owner = parseOwner(full.labels);
    let cwd: string;
    try {
      cwd = inferRepoFromIssueArea(full.labels, areaMap);
    } catch (err) {
      logger.log(`ERROR: cannot resolve cwd for #${n}: ${(err as Error).message}`);
      notify.notify(`Story #${parent} — #${n} has no recognized area:* label, aborting`);
      throw err;
    }
    issues.push({ number: n, deps: blockers, owner, state: full.state, title: full.title, cwd });
    logger.log(`  #${n} owner=${owner} state=${full.state} cwd=${cwd} deps=[${blockers.join(",")}] "${full.title}"`);
  }

  // Initial closed set (children that came in already CLOSED)
  const closed = new Set<number>(issues.filter((i) => i.state === "CLOSED").map((i) => i.number));
  // Pending = open children not yet running
  const pending = new Set<number>(issues.filter((i) => i.state === "OPEN").map((i) => i.number));

  // Initial ready queue
  let ready: number[] = computeReady(issues, closed);
  logger.log(`initial ready: [${ready.join(",")}]`);

  // Watching: child → "afk:PID" or "hitl"
  const watching = new Map<number, string>();

  const afkRunning = (): number => {
    let n = 0;
    for (const v of watching.values()) if (v.startsWith("afk:")) n++;
    return n;
  };

  const issueByNum = new Map<number, Issue>();
  for (const i of issues) issueByNum.set(i.number, i);

  // Drain loop
  while (ready.length > 0 || watching.size > 0) {
    // Top up: HITL anytime, AFK within cap
    const stillReady: number[] = [];
    for (const n of ready) {
      const issue = issueByNum.get(n)!;
      if (issue.owner === "human") {
        notify.notify(`HITL: #${n} needs human. Run: cr /pickup ${n}`);
        logger.log(`HITL surfaced: #${n} — ${issue.title}`);
        watching.set(n, "hitl");
        pending.delete(n);
      } else if (afkRunning() < cap) {
        const workerLog = `${workerLogDir}/${parent}-worker-${n}.log`;
        const { pid } = spawn.spawnWorker(
          `story-${parent}-issue-${n}`,
          `/impl ${n}`,
          workerLog,
          issue.cwd,
        );
        logger.log(`spawned AFK worker for #${n} (pid=${pid}, cwd=${issue.cwd}, log=${workerLog})`);
        watching.set(n, `afk:${pid}`);
        pending.delete(n);
      } else {
        stillReady.push(n);
      }
    }
    ready = stillReady;

    // Heartbeat status BEFORE sleep — captures current state for external pings
    hb++;
    status.write({
      ts: new Date().toISOString(),
      parent,
      phase: "polling",
      pid: process.pid,
      cap,
      watching: [...watching.keys()],
      ready: [...ready],
      closed: [...closed],
      failed: [...failed],
      hb,
    });

    // Sleep then poll
    await Bun.sleep(pollIntervalMs);

    for (const [n] of [...watching.entries()]) {
      let state: State;
      try {
        state = await gh.viewState(n);
      } catch (err) {
        logger.log(`gh viewState(#${n}) errored, retrying next cycle: ${(err as Error).message}`);
        continue;
      }

      const watchKind = watching.get(n)!;
      const isAfk = watchKind.startsWith("afk:");
      const pid = isAfk ? Number(watchKind.slice(4)) : null;
      const pidAlive = pid !== null ? proc.isAlive(pid) : true; // HITL has no PID, treat as "alive" (waiting on human)
      const action = decideWorkerAction(pidAlive, state);

      if (action === "running") {
        continue;
      }

      if (action === "dead") {
        // Worker process gone but issue still OPEN — failure mode
        logger.log(`WORKER DEAD: #${n} (pid=${pid}) exited without closing issue — re-labeling owner:human`);
        try {
          await gh.relabelHuman(n);
        } catch (err) {
          logger.log(`relabelHuman(#${n}) errored: ${(err as Error).message}`);
        }
        notify.notify(`Worker died on #${n}. Re-labeled owner:human. Run: cr /pickup ${n}`);
        watching.delete(n);
        failed.push(n);
        // Do NOT promote waiters — failed child blocks them. Surface to user.
        continue;
      }

      if (action === "closed") {
        logger.log(`child #${n} closed (${watchKind})`);
        watching.delete(n);
        closed.add(n);

        // Cleanup worktree + branch left by closed AFK worker. HITL children
        // never spawned a worktree (notify-only) so skip cleanup for them.
        if (isAfk) {
          const issue = issueByNum.get(n)!;
          await cleanupWorker(spawn, `story-${parent}-issue-${n}`, issue.cwd, logger);
        }

        // Tick parent checklist
        const currBody = await gh.viewBody(parent);
        const newBody = tickChecklist(currBody, n);
        if (newBody !== currBody) {
          await gh.editBody(parent, newBody);
          logger.log(`ticked #${n} in parent #${parent}`);
        }

        // Promote waiters
        const promoted = promoteWaiters(issues, n, closed, pending);
        for (const p of promoted) {
          if (!ready.includes(p)) {
            ready.push(p);
            logger.log(`promoted #${p} (deps cleared)`);
          }
        }
      }
    }
  }

  // Close parent only if no failures
  const parentState = await gh.viewState(parent);
  let parentClosed = parentState === "CLOSED";
  let gateBlocked = false;
  if (failed.length > 0) {
    logger.log(`drain finished with ${failed.length} failures: [${failed.join(",")}] — leaving parent #${parent} OPEN`);
    notify.notify(`Story #${parent} drained with ${failed.length} failed children. Run: cr /pickup <N> to resolve.`);
  } else {
    // Gate C — refuse close if any AC#N lacks evidence (form (i) closed-child or
    // form (ii) parent-comment per references/ac-coverage-spec.md § 4).
    const gateResult = await runCloseGate(parent, {
      gh,
      spawn,
      proc,
      notify,
      logger,
      pollIntervalMs,
      workerLogDir,
      areaMap,
    });
    if (gateResult.blocked) {
      gateBlocked = true;
      logger.log(
        `parent #${parent} left OPEN — close gate BLOCKED (missing AC=[${gateResult.missing.join(",")}] after ${gateResult.iterations} iters)`,
      );
    } else {
      // Gate C passed → tick parent AC bullets to [x] before close (#221 AC#3).
      // Gate guarantees every parent AC has form-(ii) evidence; we tick all of
      // them in one editBody pass.
      const currentBody = await gh.viewBody(parent);
      const parentAcIds = [...parseAcceptance(currentBody).keys()];
      let updatedBody = currentBody;
      for (const acId of parentAcIds) {
        updatedBody = tickAcceptance(updatedBody, acId);
      }
      if (updatedBody !== currentBody) {
        await gh.editBody(parent, updatedBody);
        logger.log(`ticked AC bullets in parent #${parent}: [${parentAcIds.join(",")}]`);
      }

      // #221 AC#4 — operator-imposed manual gate: if parent body declares a
      // `## Verification (post-merge, manual)` section, defer the close.
      if (hasManualVerificationSection(updatedBody)) {
        try {
          await gh.addComment(
            parent,
            "Gate C passed; manual verification pending — parent left OPEN",
          );
        } catch (err) {
          logger.log(
            `failed to post manual-verification-pending comment on #${parent}: ${(err as Error).message}`,
          );
        }
        logger.log(
          `parent #${parent} has ## Verification (post-merge, manual) — leaving OPEN, manual replay required`,
        );
        notify.notify(
          `Story #${parent} ready: AC ticked, manual verification pending. See issue.`,
        );
      } else {
        if (!parentClosed) {
          await gh.closeIssue(parent);
          parentClosed = true;
          logger.log(`closed parent #${parent}`);
        }
        notify.notify(`Story #${parent} complete. Log: ~/.local/state/impl-story/${parent}.log`);
      }
    }
  }

  // AC#10 instrumentation: read per-child counters, summarize, append impl-story.log row.
  // gateBlocked threads through deriveResult so Gate-C-blocked runs map to
  // `hitl-fallback` (parent OPEN despite no failed children).
  await writeImplStoryLogRow(
    {
      parent,
      childBodies,
      parentBody: parentFull.body,
      failed,
      parentClosed,
      gateBlocked,
      wallTimeSec: Math.max(0, Math.round((now() - startMs) / 1000)),
      childResults: deps.childResults,
      implStoryLog: deps.implStoryLog,
      logger,
    },
  );

  logger.log(`=== run-story DONE ===`);
  status.write({
    ts: new Date().toISOString(),
    parent,
    phase: "done",
    pid: process.pid,
    cap,
    watching: [],
    ready: [],
    closed: Array.from(closed),
    failed,
    hb,
  });

  return {
    closed: Array.from(closed),
    failed,
  };
}

// =========================================================================
// Entry point
// =========================================================================

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("usage: bun run scripts/run-story.ts <parent-N> [-p PARALLEL]");
    process.exit(1);
  }

  const parent = Number(args[0]);
  if (Number.isNaN(parent)) {
    console.error(`invalid parent number: ${args[0]}`);
    process.exit(1);
  }

  let parallel = 3;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "-p" && i + 1 < args.length) {
      parallel = Number(args[++i]);
    }
  }

  // Resolve config
  const home = process.env.HOME!;
  const configPath = `${home}/.brain-os/brain-os.config.md`;
  let repo = "sonthanh/ai-brain";
  let vaultPath = `${home}/work/brain`;
  try {
    const fs = await import("fs");
    const conf = fs.readFileSync(configPath, "utf-8");
    const repoMatch = conf.match(/^gh_task_repo:\s*(\S+)/m);
    if (repoMatch) repo = repoMatch[1];
    const vaultMatch = conf.match(/^vault_path:\s*(.+?)\s*$/m);
    if (vaultMatch) vaultPath = vaultMatch[1].replace(/^~(?=$|\/)/, home);
  } catch {
    // fall through to defaults
  }
  const implStoryLogPath = `${vaultPath}/daily/skill-outcomes/impl-story.log`;

  // Build areaMap: defaults + optional augmentation from ${home}/.brain-os/areas.json.
  // Private deployments register their own area:* labels there without touching
  // this public source file.
  const areaMap = defaultAreaMap(home);
  try {
    const fs = await import("fs");
    const raw = fs.readFileSync(`${home}/.brain-os/areas.json`, "utf-8");
    const parsed = JSON.parse(raw);
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") areaMap[k] = v;
    }
  } catch {
    // optional file
  }

  const logDir = `${home}/.local/state/impl-story`;
  const fs = await import("fs");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = `${logDir}/${parent}.log`;
  const statusPath = `${logDir}/${parent}.status`;

  const logger = new FileLogger(logPath);
  const status = new FileStatusWriter(statusPath);
  const deps: OrchestratorDeps = {
    gh: new RealGh(repo),
    spawn: new RealSpawn(),
    proc: new RealProcessChecker(),
    notify: new RealNotifier(`Brain OS — Story #${parent}`),
    logger,
    status,
    pollIntervalMs: 30_000,
    workerLogDir: logDir,
    areaMap,
    childResults: new FileChildResultReader(logDir),
    implStoryLog: new FileImplStoryLogWriter(implStoryLogPath),
  };

  try {
    await runPreCheck(parent, { gh: deps.gh, logger });
  } catch (err) {
    if (err instanceof PreCheckBlockedError) {
      const msg = err.message;
      logger.log(`pre-check BLOCKED, exit 4: ${msg}`);
      status.write({
        ts: new Date().toISOString(),
        parent,
        phase: "died",
        pid: process.pid,
        cap: clampParallel(parallel, 5),
        watching: [],
        ready: [],
        closed: [],
        failed: [],
        hb: -1,
        error: msg,
      });
      new RealNotifier(`Brain OS — Story #${parent}`).notify(
        `Story #${parent} pre-check blocked: ${msg.slice(0, 80)}`,
      );
      process.exit(4);
    }
    throw err;
  }

  try {
    await runStory(parent, parallel, deps);
  } catch (err) {
    const msg = (err as Error).message;
    logger.log(`FATAL: ${msg}`);
    status.write({
      ts: new Date().toISOString(),
      parent,
      phase: "died",
      pid: process.pid,
      cap: clampParallel(parallel, 5),
      watching: [],
      ready: [],
      closed: [],
      failed: [],
      hb: -1,
      error: msg,
    });
    new RealNotifier(`Brain OS — Story #${parent}`).notify(`Story #${parent} crashed: ${msg.slice(0, 80)}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
