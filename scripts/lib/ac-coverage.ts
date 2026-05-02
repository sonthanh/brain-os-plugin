/**
 * ac-coverage.ts — Parsers + classification for parent-AC ↔ child-Covers-AC.
 *
 * SSOT: ../../references/ac-coverage-spec.md (regexes from § 3, live-AC rule
 * from § 6.1). Consumed by /impl child-level advisor gate (§ Workflow — `issue`
 * mode → "Child-level ralph + advisor wrapper") and /impl story instrumentation
 * (impl-story.log row, spec § 5).
 */

const COVERS_AC_LINE_RE = /^- AC#(\d+)\s*$/;
const ACCEPTANCE_BULLET_RE = /^- \[[ x]\] \*\*AC#(\d+)\*\* — (.+)$/;
const PARENT_REF_RE = /^- (?:[\w-]+)?#(\d+)\s*$/;

const LIVE_AC_MARKERS = [
  "runs against",
  "pasted output",
  "live",
  "vault paths",
  "pass-rate",
  "gh comment posted",
  "cache exists",
  "log appended",
  "osascript",
] as const;

/**
 * Extract parent issue number from child body's "## Parent" section.
 * Tolerates `- #N`, `- ai-brain#N`, `- repo-name#N` per /slice convention.
 * Returns null if section absent or empty (orphan child / non-story issue).
 */
export function parseParentRef(body: string): number | null {
  const lines = body.split("\n");
  let inSection = false;
  for (const line of lines) {
    if (/^## Parent\b/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^## /.test(line)) break;
    if (!inSection) continue;
    const m = line.match(PARENT_REF_RE);
    if (m) return Number(m[1]);
  }
  return null;
}

export function parseCoversAC(body: string): Set<number> {
  const ids = new Set<number>();
  const lines = body.split("\n");
  let inSection = false;
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

export function parseAcceptance(body: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of body.split("\n")) {
    const m = line.match(ACCEPTANCE_BULLET_RE);
    if (m) map.set(Number(m[1]), m[2]);
  }
  return map;
}

export function isLiveAC(description: string): boolean {
  if (!description.includes("Verified by")) return false;
  return LIVE_AC_MARKERS.some((marker) => description.includes(marker));
}

export function liveACSet(parentBody: string): Set<number> {
  const acs = parseAcceptance(parentBody);
  const out = new Set<number>();
  for (const [id, desc] of acs) {
    if (isLiveAC(desc)) out.add(id);
  }
  return out;
}

export type ChildClassification = "pure-component" | "live-ac";

export function classifyChild(
  coversAC: Set<number>,
  parentLiveAC: Set<number>,
): ChildClassification {
  for (const id of coversAC) {
    if (parentLiveAC.has(id)) return "live-ac";
  }
  return "pure-component";
}

export interface AdvisorVerdict {
  met: boolean;
  reason?: string;
}

export function parseAdvisorVerdict(text: string): AdvisorVerdict {
  // First-match wins. "AC met" takes precedence over "AC not met" so a
  // self-contradicting advisor reply doesn't loop forever.
  const metIdx = text.indexOf("AC met");
  const notMetIdx = text.indexOf("AC not met");
  if (metIdx !== -1 && (notMetIdx === -1 || metIdx < notMetIdx)) {
    return { met: true };
  }
  if (notMetIdx !== -1) {
    const after = text.slice(notMetIdx + "AC not met".length);
    const reasonMatch = after.match(/^[:\s]+([^\n]+)/);
    const reason = reasonMatch ? reasonMatch[1].trim() : "(no reason given)";
    return { met: false, reason };
  }
  return { met: false, reason: "advisor returned no explicit verdict" };
}

export function formatHandoffComment(
  lastFailure: string,
  lastAdvisorVerdict: string,
): string {
  return [
    "AFK gave up after 3 ralph iters.",
    "",
    `Last failure: ${lastFailure}`,
    `Last advisor verdict: ${lastAdvisorVerdict}`,
    "",
    "Pick up via /pickup <N> for HITL judgment.",
  ].join("\n");
}

export type ImplStoryResult = "pass" | "partial" | "fail" | "hitl-fallback";

export interface ImplStoryRow {
  date: string;
  parentIssue: number;
  childCount: number;
  liveAcChildCount: number;
  advisorCalls: number;
  advisorRejections: number;
  wallTimeSec: number;
  result: ImplStoryResult;
}

export function formatImplStoryLogRow(row: ImplStoryRow): string {
  return [
    row.date,
    row.parentIssue,
    row.childCount,
    row.liveAcChildCount,
    row.advisorCalls,
    row.advisorRejections,
    row.wallTimeSec,
    row.result,
  ].join("\t");
}

export interface ChildResultRecord {
  parent: number;
  child: number;
  verified: boolean;
  tddRunCount: number;
  advisorCalls: number;
  advisorRejections: number;
  lastFailure?: string;
  lastVerdict?: string;
  ts: string;
}

export interface AggregatedCounters {
  advisorCalls: number;
  advisorRejections: number;
}

export function aggregateChildCounters(
  records: ChildResultRecord[],
): AggregatedCounters {
  let advisorCalls = 0;
  let advisorRejections = 0;
  for (const r of records) {
    advisorCalls += r.advisorCalls;
    advisorRejections += r.advisorRejections;
  }
  return { advisorCalls, advisorRejections };
}

export interface SummarizeArgs {
  parentIssue: number;
  childBodies: Map<number, string>;
  parentBody: string;
  counters: AggregatedCounters;
  wallTimeSec: number;
  failedChildren: number[];
  date?: string;
}

export function computeLiveAcChildCount(
  parentBody: string,
  childBodies: Map<number, string>,
): number {
  const parentLive = liveACSet(parentBody);
  let n = 0;
  for (const [, body] of childBodies) {
    const covers = parseCoversAC(body);
    if (classifyChild(covers, parentLive) === "live-ac") n++;
  }
  return n;
}

export function deriveResult(
  failedChildren: number[],
  parentClosed: boolean,
): ImplStoryResult {
  if (failedChildren.length > 0 && parentClosed) return "partial";
  if (failedChildren.length > 0) return "hitl-fallback";
  if (parentClosed) return "pass";
  return "fail";
}

export function summarizeRun(
  args: SummarizeArgs,
  parentClosed: boolean,
): ImplStoryRow {
  const date = args.date ?? new Date().toISOString().slice(0, 10);
  return {
    date,
    parentIssue: args.parentIssue,
    childCount: args.childBodies.size,
    liveAcChildCount: computeLiveAcChildCount(args.parentBody, args.childBodies),
    advisorCalls: args.counters.advisorCalls,
    advisorRejections: args.counters.advisorRejections,
    wallTimeSec: args.wallTimeSec,
    result: deriveResult(args.failedChildren, parentClosed),
  };
}
