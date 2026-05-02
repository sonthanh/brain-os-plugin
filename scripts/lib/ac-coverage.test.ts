import { test, expect, describe } from "bun:test";
import {
  parseCoversAC,
  parseAcceptance,
  parseParentRef,
  isLiveAC,
  liveACSet,
  classifyChild,
  parseAdvisorVerdict,
  formatHandoffComment,
  formatImplStoryLogRow,
  aggregateChildCounters,
  computeLiveAcChildCount,
  deriveResult,
  summarizeRun,
  type ChildResultRecord,
  type ImplStoryRow,
} from "./ac-coverage.ts";

describe("parseParentRef", () => {
  test("extracts ai-brain#N form (slice convention)", () => {
    const body = `## Parent\n\n- ai-brain#196\n\n## Covers AC\n`;
    expect(parseParentRef(body)).toBe(196);
  });

  test("extracts bare #N form", () => {
    const body = `## Parent\n\n- #196\n\n## Other\n`;
    expect(parseParentRef(body)).toBe(196);
  });

  test("returns null when no Parent section", () => {
    const body = `## Covers AC\n\n- AC#1\n`;
    expect(parseParentRef(body)).toBeNull();
  });

  test("returns null when Parent section empty", () => {
    const body = `## Parent\n\n## Covers AC\n`;
    expect(parseParentRef(body)).toBeNull();
  });

  test("first match wins when multiple parents listed", () => {
    const body = `## Parent\n\n- ai-brain#196\n- ai-brain#999\n\n## Other\n`;
    expect(parseParentRef(body)).toBe(196);
  });

  test("section closes at next H2 — refs after ignored", () => {
    const body = `## Parent\n\n## Other\n\n- ai-brain#999\n`;
    expect(parseParentRef(body)).toBeNull();
  });
});

describe("parseCoversAC — § 1 / § 3.2", () => {
  test("single-bullet section returns set with one ID", () => {
    const body = `## Covers AC\n\n- AC#1\n\n## What to build\n`;
    expect(parseCoversAC(body)).toEqual(new Set([1]));
  });

  test("multi-bullet section collects all IDs", () => {
    const body = `## Covers AC\n\n- AC#5\n- AC#8\n\n## What to build\n`;
    expect(parseCoversAC(body)).toEqual(new Set([5, 8]));
  });

  test("trailing whitespace tolerated", () => {
    const body = `## Covers AC\n- AC#5  \n\n## End\n`;
    expect(parseCoversAC(body)).toEqual(new Set([5]));
  });

  test("empty section returns empty set (pure-component child)", () => {
    const body = `## Covers AC\n\n## What to build\n`;
    expect(parseCoversAC(body)).toEqual(new Set());
  });

  test("missing section returns empty set", () => {
    const body = `## Parent\n\n- ai-brain#196\n\n## What to build\n`;
    expect(parseCoversAC(body)).toEqual(new Set());
  });

  test("section ends at next H2 — bullets after are ignored", () => {
    const body = `## Covers AC\n\n- AC#1\n\n## Other section\n\n- AC#99\n`;
    expect(parseCoversAC(body)).toEqual(new Set([1]));
  });

  test("multi-ID bullet is rejected (parser does NOT split on commas)", () => {
    const body = `## Covers AC\n\n- AC#1, AC#3\n\n## End\n`;
    expect(parseCoversAC(body)).toEqual(new Set());
  });

  test("lowercase ac# rejected", () => {
    const body = `## Covers AC\n\n- ac#2\n\n## End\n`;
    expect(parseCoversAC(body)).toEqual(new Set());
  });

  test("blank lines and stray prose ignored, no error", () => {
    const body = `## Covers AC\n\n- AC#1\n\nrandom prose\n- AC#2\n\n## End\n`;
    expect(parseCoversAC(body)).toEqual(new Set([1, 2]));
  });
});

describe("parseAcceptance — § 2 / § 3.1", () => {
  test("returns map of ID → description for each AC bullet", () => {
    const body = [
      "## Acceptance",
      "",
      "- [ ] **AC#1** — first criterion. Verified by live integration.",
      "- [x] **AC#2** — second criterion. Verified by inspection.",
    ].join("\n");
    const map = parseAcceptance(body);
    expect(map.size).toBe(2);
    expect(map.get(1)).toContain("first criterion");
    expect(map.get(2)).toContain("second criterion");
  });

  test("rejects bullets with hyphen instead of em-dash", () => {
    const body = `## Acceptance\n\n- [ ] **AC#1** - hyphen form\n`;
    expect(parseAcceptance(body)).toEqual(new Map());
  });

  test("rejects bullets without bold AC#N markers", () => {
    const body = `## Acceptance\n\n- [ ] AC#1 — missing bold\n`;
    expect(parseAcceptance(body)).toEqual(new Map());
  });

  test("accepts both [ ] and [x] checkbox states", () => {
    const body = [
      "## Acceptance",
      "- [ ] **AC#1** — unchecked",
      "- [x] **AC#2** — checked",
    ].join("\n");
    expect(parseAcceptance(body).size).toBe(2);
  });

  test("ignores non-Acceptance section content", () => {
    const body = [
      "## Other",
      "- [ ] **AC#99** — fake bullet outside Acceptance",
      "## Acceptance",
      "- [ ] **AC#1** — real bullet",
    ].join("\n");
    const map = parseAcceptance(body);
    expect(map.has(1)).toBe(true);
    // Per spec § 2: parser is global to body; if filter to section is wanted,
    // that is not part of this regex's job. Both should match.
    expect(map.has(99)).toBe(true);
  });
});

describe("isLiveAC — § 6.1", () => {
  test("requires both 'Verified by' AND a marker substring", () => {
    expect(isLiveAC("Foo bar. Verified by replay with live integration.")).toBe(true);
  });

  test("missing 'Verified by' → non-live regardless of marker", () => {
    expect(isLiveAC("live integration runs against the API")).toBe(false);
  });

  test("'Verified by' but no marker → non-live", () => {
    expect(isLiveAC("Verified by inspection.")).toBe(false);
  });

  test("each marker substring qualifies", () => {
    const markers = [
      "runs against",
      "pasted output",
      "live",
      "vault paths",
      "pass-rate",
      "gh comment posted",
      "cache exists",
      "log appended",
      "osascript",
    ];
    for (const m of markers) {
      expect(isLiveAC(`Description. Verified by something with ${m} in it.`)).toBe(true);
    }
  });

  test("case-sensitive: 'Live' (uppercase) does NOT match 'live'", () => {
    expect(isLiveAC("Verified by replay with Live capital.")).toBe(false);
  });

  test("AC#9 worked example from spec § 6.2", () => {
    const desc = "Prior-story retro: live integration child runs against operator base; pass-rate logged";
    expect(isLiveAC("Verified by " + desc)).toBe(true);
  });
});

describe("liveACSet", () => {
  test("returns set of live-AC IDs from parent body", () => {
    const body = [
      "## Acceptance",
      "- [ ] **AC#1** — Gate A. Verified by replay with live descriptor.",
      "- [ ] **AC#2** — Gate B blocks start. Verified by attempting BLOCK and inspecting comment.",
      "- [ ] **AC#7** — spec exists. Verified by inspection.",
      "- [ ] **AC#9** — live integration runs. Verified by pass-rate logged in vault paths.",
    ].join("\n");
    expect(liveACSet(body)).toEqual(new Set([1, 9]));
  });

  test("empty parent body returns empty set", () => {
    expect(liveACSet("")).toEqual(new Set());
  });
});

describe("classifyChild — § 1.2 intersection rule", () => {
  test("empty Covers AC → pure-component", () => {
    expect(classifyChild(new Set(), new Set([1, 2]))).toBe("pure-component");
  });

  test("Covers AC overlaps live-AC set → live-ac", () => {
    expect(classifyChild(new Set([1, 5]), new Set([1, 9]))).toBe("live-ac");
  });

  test("Covers AC entirely outside live-AC set → pure-component (intersection rule)", () => {
    // Per spec § 1.2: child covering only non-live parent ACs is pure-component.
    expect(classifyChild(new Set([7]), new Set([1, 9]))).toBe("pure-component");
  });

  test("non-empty Covers AC + empty parent live-AC set → pure-component", () => {
    expect(classifyChild(new Set([1, 2]), new Set())).toBe("pure-component");
  });
});

describe("parseAdvisorVerdict", () => {
  test("'AC met' verdict → met=true", () => {
    expect(parseAdvisorVerdict("After reviewing: AC met. The integration ran.")).toEqual({
      met: true,
    });
  });

  test("'AC not met: <reason>' → met=false with reason", () => {
    const out = parseAdvisorVerdict("AC not met: integration test mocks the live API.");
    expect(out.met).toBe(false);
    expect(out.reason).toContain("mocks the live API");
  });

  test("ambiguous verdict (neither phrase) → met=false with sentinel reason", () => {
    const out = parseAdvisorVerdict("I think it looks fine but I cannot confirm.");
    expect(out.met).toBe(false);
    expect(out.reason).toContain("no explicit verdict");
  });

  test("'AC not met' (no colon, no reason) → met=false with empty reason marker", () => {
    const out = parseAdvisorVerdict("AC not met");
    expect(out.met).toBe(false);
    expect(out.reason).toBeDefined();
  });

  test("'AC met' takes precedence over later 'AC not met' (first match wins)", () => {
    // Defensive — if advisor contradicts itself, accept the affirmative.
    // Rationale: false-negative escalation costs HITL time; advisor saying both
    // is itself a flag the prompt should be tightened, but the run shouldn't
    // re-loop on a self-contradiction.
    const out = parseAdvisorVerdict("Initial: AC met. Caveat: AC not met if you squint.");
    expect(out.met).toBe(true);
  });
});

describe("formatHandoffComment", () => {
  test("includes 'AFK gave up after 3 ralph iters' header", () => {
    const out = formatHandoffComment("test stayed red", "still mocking");
    expect(out).toContain("AFK gave up after 3 ralph iters");
  });

  test("includes last failure", () => {
    const out = formatHandoffComment("test red on assertion X", "advisor: still mocking");
    expect(out).toContain("test red on assertion X");
  });

  test("includes last advisor verdict", () => {
    const out = formatHandoffComment("/tdd RED", "AC not met: integration test mocks the live API");
    expect(out).toContain("AC not met: integration test mocks the live API");
  });

  test("includes /pickup pointer", () => {
    const out = formatHandoffComment("a", "b");
    expect(out).toContain("/pickup");
  });
});

describe("formatImplStoryLogRow — § 5", () => {
  test("8 TSV columns in the right order", () => {
    const row: ImplStoryRow = {
      date: "2026-05-08",
      parentIssue: 196,
      childCount: 7,
      liveAcChildCount: 5,
      advisorCalls: 11,
      advisorRejections: 2,
      wallTimeSec: 5430,
      result: "pass",
    };
    expect(formatImplStoryLogRow(row)).toBe(
      "2026-05-08\t196\t7\t5\t11\t2\t5430\tpass",
    );
  });

  test("all four result enums supported", () => {
    const base: ImplStoryRow = {
      date: "2026-05-08",
      parentIssue: 1,
      childCount: 0,
      liveAcChildCount: 0,
      advisorCalls: 0,
      advisorRejections: 0,
      wallTimeSec: 0,
      result: "pass",
    };
    for (const r of ["pass", "partial", "fail", "hitl-fallback"] as const) {
      const out = formatImplStoryLogRow({ ...base, result: r });
      expect(out.endsWith(`\t${r}`)).toBe(true);
    }
  });
});

describe("aggregateChildCounters", () => {
  test("sums advisorCalls + advisorRejections across records", () => {
    const records: ChildResultRecord[] = [
      { parent: 1, child: 10, verified: true, tddRunCount: 1, advisorCalls: 1, advisorRejections: 0, ts: "" },
      { parent: 1, child: 11, verified: false, tddRunCount: 3, advisorCalls: 3, advisorRejections: 3, ts: "" },
      { parent: 1, child: 12, verified: true, tddRunCount: 1, advisorCalls: 0, advisorRejections: 0, ts: "" },
    ];
    expect(aggregateChildCounters(records)).toEqual({ advisorCalls: 4, advisorRejections: 3 });
  });

  test("empty records → zero counters", () => {
    expect(aggregateChildCounters([])).toEqual({ advisorCalls: 0, advisorRejections: 0 });
  });
});

describe("computeLiveAcChildCount", () => {
  test("counts only children whose Covers AC overlaps parent live-AC set", () => {
    const parentBody = [
      "## Acceptance",
      "- [ ] **AC#1** — Live one. Verified by replay with live integration.",
      "- [ ] **AC#7** — Spec exists. Verified by inspection.",
    ].join("\n");
    const childBodies = new Map<number, string>([
      [10, `## Covers AC\n\n- AC#1\n\n## End\n`],   // live
      [11, `## Covers AC\n\n- AC#7\n\n## End\n`],   // pure (non-live AC)
      [12, `## Covers AC\n\n## End\n`],              // pure (empty)
      [13, `## Covers AC\n\n- AC#1\n- AC#7\n## End\n`], // live (overlap)
    ]);
    expect(computeLiveAcChildCount(parentBody, childBodies)).toBe(2);
  });
});

describe("deriveResult", () => {
  test("no failures + parent closed → pass", () => {
    expect(deriveResult([], true)).toBe("pass");
  });

  test("no failures + parent open → fail (orchestrator error path)", () => {
    expect(deriveResult([], false)).toBe("fail");
  });

  test("failures + parent open → hitl-fallback", () => {
    expect(deriveResult([5], false)).toBe("hitl-fallback");
  });

  test("failures + parent closed (manual override) → partial", () => {
    expect(deriveResult([5], true)).toBe("partial");
  });

  test("gateBlocked=true → hitl-fallback (overrides default !closed → fail path)", () => {
    expect(deriveResult([], false, true)).toBe("hitl-fallback");
  });

  test("gateBlocked=true takes precedence over child failures too", () => {
    expect(deriveResult([5], false, true)).toBe("hitl-fallback");
  });

  test("gateBlocked=false (default) preserves existing matrix", () => {
    expect(deriveResult([], true, false)).toBe("pass");
    expect(deriveResult([5], true, false)).toBe("partial");
  });
});

describe("summarizeRun", () => {
  test("composes all derived fields end-to-end", () => {
    const parentBody = [
      "## Acceptance",
      "- [ ] **AC#1** — Verified by replay with live test.",
      "- [ ] **AC#7** — Verified by inspection.",
    ].join("\n");
    const childBodies = new Map<number, string>([
      [10, `## Covers AC\n\n- AC#1\n\n`],
      [11, `## Covers AC\n\n- AC#7\n\n`],
    ]);
    const row = summarizeRun({
      parentIssue: 196,
      childBodies,
      parentBody,
      counters: { advisorCalls: 2, advisorRejections: 1 },
      wallTimeSec: 1234,
      failedChildren: [],
      date: "2026-05-08",
    }, true);
    expect(row).toEqual({
      date: "2026-05-08",
      parentIssue: 196,
      childCount: 2,
      liveAcChildCount: 1,
      advisorCalls: 2,
      advisorRejections: 1,
      wallTimeSec: 1234,
      result: "pass",
    });
  });

  test("failed children + parent open → hitl-fallback row", () => {
    const row = summarizeRun({
      parentIssue: 196,
      childBodies: new Map(),
      parentBody: "",
      counters: { advisorCalls: 0, advisorRejections: 0 },
      wallTimeSec: 0,
      failedChildren: [5, 7],
      date: "2026-05-08",
    }, false);
    expect(row.result).toBe("hitl-fallback");
  });
});
