import { describe, expect, test } from "bun:test";
import {
  blockerSuffix,
  buildAdjacency,
  buildPhaseLinks,
  cleanTitle,
  collapseClosedSiblings,
  findBenchPlans,
  findRoots,
  formatClosedGroup,
  hasOpenDescendant,
  isActivePlan,
  normalizeIssue,
  parseBlockers,
  parseParentRef,
  parsePhase,
  pickQueuedFooter,
  priorityRank,
  renderStoriesBlock,
  statusBadge,
  type Issue,
  type RawIssue,
} from "./build-stories-tree";

// ----- parseParentRef ------------------------------------------------------

describe("parseParentRef", () => {
  test("simple ai-brain#N form", () => {
    expect(parseParentRef("## Parent\n\n- ai-brain#179\n\n## Why\n")).toBe(179);
  });

  test("trailing parenthetical commentary", () => {
    expect(
      parseParentRef("## Parent\n\n- ai-brain#179 (Phase 1 MVP)\n\n## Why\n"),
    ).toBe(179);
  });

  test("bare #N form", () => {
    expect(parseParentRef("## Parent\n\n- #237\n\n## Why\n")).toBe(237);
  });

  test("multiple bullets — returns first ref only", () => {
    expect(
      parseParentRef("## Parent\n\n- ai-brain#179\n- ai-brain#999\n\n## Why\n"),
    ).toBe(179);
  });

  test("missing section", () => {
    expect(parseParentRef("## Why\n\n- ai-brain#179\n")).toBeNull();
  });

  test("section closes at next ## heading", () => {
    expect(
      parseParentRef("## Parent\n\n## Other\n\n- ai-brain#179\n"),
    ).toBeNull();
  });

  test("CRLF line endings", () => {
    expect(parseParentRef("## Parent\r\n\r\n- ai-brain#179\r\n")).toBe(179);
  });
});

// ----- parseBlockers -------------------------------------------------------

describe("parseBlockers", () => {
  test("single blocker", () => {
    expect(parseBlockers("## Blocked by\n\n- ai-brain#251")).toEqual([251]);
  });

  test("multiple blockers sorted ascending", () => {
    expect(
      parseBlockers("## Blocked by\n\n- ai-brain#199\n- ai-brain#198\n"),
    ).toEqual([198, 199]);
  });

  test("None sentinel", () => {
    expect(parseBlockers("## Blocked by\n\nNone — can start immediately.")).toEqual([]);
  });

  test("blocker with trailing prose", () => {
    expect(
      parseBlockers("## Blocked by\n\n- ai-brain#251 — text-field gap\n"),
    ).toEqual([251]);
  });

  test("section absent", () => {
    expect(parseBlockers("## Why\n\n- ai-brain#1\n")).toEqual([]);
  });
});

// ----- parsePhase ----------------------------------------------------------

describe("parsePhase", () => {
  test("Phase 1 MVP suffix", () => {
    expect(
      parsePhase(
        "Story: /airtable-knowledge-extract — Phase 1 MVP (per-base × vertical-slice)",
      ),
    ).toEqual({ project: "/airtable-knowledge-extract", phase: 1 });
  });

  test("Phase 2 suffix", () => {
    expect(
      parsePhase(
        "Story: /airtable-knowledge-extract — Phase 2 (Coordinator + Token Police)",
      ),
    ).toEqual({ project: "/airtable-knowledge-extract", phase: 2 });
  });

  test("rejects parenthetical Phase-N", () => {
    expect(
      parsePhase("Story: Schema-driven extraction dispatch (Phase-1 architecture correction)"),
    ).toBeNull();
  });

  test("rejects Phase B (non-numeric)", () => {
    expect(
      parsePhase("Story: Agent-teams audit consensus (Phase B — deferred)"),
    ).toBeNull();
  });

  test("rejects no Phase mention", () => {
    expect(parsePhase("Story: Vault entity graph (people / companies)")).toBeNull();
  });
});

// ----- normalizeIssue ------------------------------------------------------

describe("normalizeIssue", () => {
  test("open in-progress plan with parent + blockers", () => {
    const raw: RawIssue = {
      number: 246,
      state: "OPEN",
      labels: [
        { name: "type:plan" },
        { name: "status:blocked" },
        { name: "priority:p2" },
      ],
      body: "## Parent\n\n- ai-brain#237\n\n## Blocked by\n\n- ai-brain#251\n",
      title: "Live Staronline replay evidence",
    };
    expect(normalizeIssue(raw)).toEqual({
      number: 246,
      state: "OPEN",
      status: "blocked",
      priority: "p2",
      isPlan: true,
      parent: 237,
      blockers: [251],
      title: "Live Staronline replay evidence",
    });
  });

  test("closed issue with no body", () => {
    const raw: RawIssue = {
      number: 100,
      state: "CLOSED",
      labels: [{ name: "priority:p1" }],
      title: "Done thing",
    };
    expect(normalizeIssue(raw)).toEqual({
      number: 100,
      state: "CLOSED",
      status: null,
      priority: "p1",
      isPlan: false,
      parent: null,
      blockers: [],
      title: "Done thing",
    });
  });
});

// ----- statusBadge + cleanTitle -------------------------------------------

describe("statusBadge", () => {
  const make = (state: "OPEN" | "CLOSED", status: Issue["status"]): Issue => ({
    number: 1,
    state,
    status,
    priority: null,
    isPlan: false,
    parent: null,
    blockers: [],
    title: "x",
  });
  test("CLOSED → [closed]", () => {
    expect(statusBadge(make("CLOSED", null))).toBe("[closed]");
  });
  test("status:in-progress → [in-prog]", () => {
    expect(statusBadge(make("OPEN", "in-progress"))).toBe("[in-prog]");
  });
  test("status:ready → [READY]", () => {
    expect(statusBadge(make("OPEN", "ready"))).toBe("[READY]");
  });
  test("status:blocked → [BLOCKED]", () => {
    expect(statusBadge(make("OPEN", "blocked"))).toBe("[BLOCKED]");
  });
  test("status:backlog → [backlog]", () => {
    expect(statusBadge(make("OPEN", "backlog"))).toBe("[backlog]");
  });
  test("open + no status label → empty", () => {
    expect(statusBadge(make("OPEN", null))).toBe("");
  });
});

describe("cleanTitle", () => {
  test("strips Story: prefix", () => {
    expect(cleanTitle("Story: Schema-driven extraction dispatch")).toBe(
      "Schema-driven extraction dispatch",
    );
  });
  test("leaves Tool/agent: prefix alone", () => {
    expect(cleanTitle("Tool/agent: deep-chill mix")).toBe("Tool/agent: deep-chill mix");
  });
});

// ----- adjacency + reachability -------------------------------------------

const mkIssue = (
  number: number,
  state: "OPEN" | "CLOSED",
  parent: number | null,
  isPlan = false,
  status: Issue["status"] = null,
  priority: Issue["priority"] = null,
  blockers: number[] = [],
  title = `T${number}`,
): Issue => ({
  number,
  state,
  status,
  priority,
  isPlan,
  parent,
  blockers,
  title,
});

describe("buildAdjacency", () => {
  test("groups children under parent, sorted ascending", () => {
    const issues = [
      mkIssue(1, "OPEN", null, true),
      mkIssue(3, "OPEN", 1),
      mkIssue(2, "OPEN", 1),
      mkIssue(5, "CLOSED", 1),
    ];
    const adj = buildAdjacency(issues);
    expect(adj.get(1)).toEqual([2, 3, 5]);
  });

  test("issues without parent contribute nothing", () => {
    const adj = buildAdjacency([mkIssue(1, "OPEN", null)]);
    expect(adj.size).toBe(0);
  });
});

describe("hasOpenDescendant", () => {
  test("traverses transitive children", () => {
    const issues = [
      mkIssue(1, "OPEN", null, true),
      mkIssue(2, "CLOSED", 1),
      mkIssue(3, "CLOSED", 2),
      mkIssue(4, "OPEN", 3),
    ];
    const adj = buildAdjacency(issues);
    const byNumber = new Map(issues.map((i) => [i.number, i]));
    expect(hasOpenDescendant(1, adj, byNumber)).toBe(true);
  });

  test("all closed → false", () => {
    const issues = [
      mkIssue(1, "OPEN", null, true),
      mkIssue(2, "CLOSED", 1),
      mkIssue(3, "CLOSED", 1),
    ];
    const adj = buildAdjacency(issues);
    const byNumber = new Map(issues.map((i) => [i.number, i]));
    expect(hasOpenDescendant(1, adj, byNumber)).toBe(false);
  });

  test("no children at all → false", () => {
    const issues = [mkIssue(1, "OPEN", null, true)];
    const adj = buildAdjacency(issues);
    const byNumber = new Map(issues.map((i) => [i.number, i]));
    expect(hasOpenDescendant(1, adj, byNumber)).toBe(false);
  });
});

// ----- findRoots + isActivePlan -------------------------------------------

describe("isActivePlan + findRoots", () => {
  test("backlog plan with open child counts as active", () => {
    const issues = [
      mkIssue(1, "OPEN", null, true, "backlog"),
      mkIssue(2, "OPEN", 1),
    ];
    const adj = buildAdjacency(issues);
    const byNumber = new Map(issues.map((i) => [i.number, i]));
    expect(isActivePlan(issues[0], adj, byNumber)).toBe(true);
  });

  test("backlog plan with no open children is bench, not active", () => {
    const issues = [mkIssue(1, "OPEN", null, true, "backlog")];
    const adj = buildAdjacency(issues);
    const byNumber = new Map(issues.map((i) => [i.number, i]));
    expect(isActivePlan(issues[0], adj, byNumber)).toBe(false);
  });

  test("nested plan (parent is also plan + active) does not appear as root", () => {
    const issues = [
      mkIssue(1, "OPEN", null, true, "in-progress"),
      mkIssue(2, "OPEN", 1, true, "in-progress"),
      mkIssue(3, "OPEN", 2),
    ];
    const adj = buildAdjacency(issues);
    const byNumber = new Map(issues.map((i) => [i.number, i]));
    const roots = findRoots(issues, adj, byNumber);
    expect(roots.map((r) => r.number)).toEqual([1]);
  });

  test("plan whose parent is closed becomes root (parent not in active set)", () => {
    const issues = [
      mkIssue(1, "CLOSED", null, true, null), // closed parent — not active
      mkIssue(2, "OPEN", 1, true, "in-progress"), // active plan child
    ];
    const adj = buildAdjacency(issues);
    const byNumber = new Map(issues.map((i) => [i.number, i]));
    const roots = findRoots(issues, adj, byNumber);
    expect(roots.map((r) => r.number)).toEqual([2]);
  });

  test("roots sorted descending by number", () => {
    const issues = [
      mkIssue(5, "OPEN", null, true, "in-progress"),
      mkIssue(10, "OPEN", null, true, "in-progress"),
      mkIssue(7, "OPEN", null, true, "in-progress"),
    ];
    const adj = buildAdjacency(issues);
    const byNumber = new Map(issues.map((i) => [i.number, i]));
    const roots = findRoots(issues, adj, byNumber);
    expect(roots.map((r) => r.number)).toEqual([10, 7, 5]);
  });
});

// ----- findBenchPlans ------------------------------------------------------

describe("findBenchPlans", () => {
  test("backlog plan with no open descendants is bench", () => {
    const issues = [
      mkIssue(1, "OPEN", null, true, "backlog"),
      mkIssue(2, "CLOSED", 1),
    ];
    const adj = buildAdjacency(issues);
    const byNumber = new Map(issues.map((i) => [i.number, i]));
    expect(findBenchPlans(issues, adj, byNumber).map((b) => b.number)).toEqual([1]);
  });

  test("non-backlog plan never bench", () => {
    const issues = [mkIssue(1, "OPEN", null, true, "ready")];
    const adj = buildAdjacency(issues);
    const byNumber = new Map(issues.map((i) => [i.number, i]));
    expect(findBenchPlans(issues, adj, byNumber)).toHaveLength(0);
  });
});

// ----- buildPhaseLinks -----------------------------------------------------

describe("buildPhaseLinks", () => {
  test("active Phase-1 root pairs with bench Phase-2 plan", () => {
    const root: Issue = mkIssue(
      179,
      "OPEN",
      null,
      true,
      "in-progress",
      "p2",
      [],
      "Story: /xtract — Phase 1 MVP",
    );
    const bench: Issue = mkIssue(
      193,
      "OPEN",
      null,
      true,
      "backlog",
      "p3",
      [],
      "Story: /xtract — Phase 2",
    );
    const links = buildPhaseLinks([root], [bench]);
    expect(links.get(179)?.number).toBe(193);
  });

  test("non-consecutive phases do NOT pair (Phase 1 + Phase 3)", () => {
    const root: Issue = mkIssue(
      1,
      "OPEN",
      null,
      true,
      "in-progress",
      "p2",
      [],
      "Story: /xtract — Phase 1",
    );
    const bench: Issue = mkIssue(
      2,
      "OPEN",
      null,
      true,
      "backlog",
      "p3",
      [],
      "Story: /xtract — Phase 3",
    );
    expect(buildPhaseLinks([root], [bench]).size).toBe(0);
  });

  test("different projects do NOT pair", () => {
    const root: Issue = mkIssue(
      1,
      "OPEN",
      null,
      true,
      "in-progress",
      "p2",
      [],
      "Story: /xtract — Phase 1",
    );
    const bench: Issue = mkIssue(
      2,
      "OPEN",
      null,
      true,
      "backlog",
      "p3",
      [],
      "Story: /other — Phase 2",
    );
    expect(buildPhaseLinks([root], [bench]).size).toBe(0);
  });
});

// ----- closed-sibling collapse --------------------------------------------

describe("collapseClosedSiblings", () => {
  test("contiguous closed run renders as range", () => {
    const issues = [238, 239, 240, 241, 242, 243, 244, 245].map((n) =>
      mkIssue(n, "CLOSED", 237),
    );
    const byNumber = new Map(issues.map((i) => [i.number, i]));
    const items = collapseClosedSiblings(issues.map((i) => i.number), byNumber);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("closed-group");
    if (items[0].kind === "closed-group") {
      expect(items[0].label).toBe("#238–#245 [closed] — 8 done");
    }
  });

  test("open sibling between closed runs splits the group", () => {
    const issues: Issue[] = [
      mkIssue(238, "CLOSED", 237),
      mkIssue(239, "CLOSED", 237),
      mkIssue(240, "OPEN", 237, false, "ready"),
      mkIssue(241, "CLOSED", 237),
      mkIssue(242, "CLOSED", 237),
    ];
    const byNumber = new Map(issues.map((i) => [i.number, i]));
    const items = collapseClosedSiblings(issues.map((i) => i.number), byNumber);
    expect(items).toHaveLength(3);
    expect(items[0].kind).toBe("closed-group");
    expect(items[1].kind).toBe("open");
    expect(items[2].kind).toBe("closed-group");
  });

  test("non-contiguous closed run with no open between joins via comma", () => {
    const issues: Issue[] = [
      mkIssue(208, "CLOSED", 179),
      mkIssue(215, "CLOSED", 179),
      mkIssue(228, "CLOSED", 179),
      mkIssue(229, "CLOSED", 179),
      mkIssue(230, "CLOSED", 179),
    ];
    const byNumber = new Map(issues.map((i) => [i.number, i]));
    const items = collapseClosedSiblings(issues.map((i) => i.number), byNumber);
    expect(items).toHaveLength(1);
    if (items[0].kind === "closed-group") {
      expect(items[0].label).toBe("#208, #215, #228–#230 [closed] — 5 done");
    }
  });

  test("size-1 closed group preserves title", () => {
    const issues: Issue[] = [
      mkIssue(167, "CLOSED", 162, false, null, null, [], "Story: foo"),
    ];
    const byNumber = new Map(issues.map((i) => [i.number, i]));
    const items = collapseClosedSiblings(issues.map((i) => i.number), byNumber);
    if (items[0].kind === "closed-group") {
      expect(items[0].label).toBe("#167 [closed] — foo");
    }
  });
});

describe("formatClosedGroup", () => {
  test("singleton with title", () => {
    const byNumber = new Map([
      [42, mkIssue(42, "CLOSED", null, false, null, null, [], "Done thing")],
    ]);
    expect(formatClosedGroup([42], byNumber)).toBe("#42 [closed] — Done thing");
  });

  test("two consecutive → range", () => {
    const byNumber = new Map([
      [10, mkIssue(10, "CLOSED", null)],
      [11, mkIssue(11, "CLOSED", null)],
    ]);
    expect(formatClosedGroup([10, 11], byNumber)).toBe("#10–#11 [closed] — 2 done");
  });
});

// ----- blockerSuffix -------------------------------------------------------

describe("blockerSuffix", () => {
  test("annotates open sibling blocker", () => {
    const issue = mkIssue(246, "OPEN", 237, false, "blocked", null, [251]);
    const blocker = mkIssue(251, "OPEN", 237);
    const byNumber = new Map([
      [246, issue],
      [251, blocker],
    ]);
    const siblings = new Set([246, 251]);
    expect(blockerSuffix(issue, siblings, byNumber)).toBe(" (blocked by #251)");
  });

  test("closed blocker is silenced", () => {
    const issue = mkIssue(204, "OPEN", 179, false, null, null, [198, 199]);
    const b1 = mkIssue(198, "CLOSED", 179);
    const b2 = mkIssue(199, "CLOSED", 179);
    const byNumber = new Map([
      [204, issue],
      [198, b1],
      [199, b2],
    ]);
    const siblings = new Set([204, 198, 199]);
    expect(blockerSuffix(issue, siblings, byNumber)).toBe("");
  });

  test("non-sibling blocker is dropped", () => {
    const issue = mkIssue(246, "OPEN", 237, false, "blocked", null, [99]);
    const blocker = mkIssue(99, "OPEN", 100);
    const byNumber = new Map([
      [246, issue],
      [99, blocker],
    ]);
    const siblings = new Set([246]);
    expect(blockerSuffix(issue, siblings, byNumber)).toBe("");
  });
});

// ----- pickQueuedFooter ----------------------------------------------------

describe("pickQueuedFooter + priorityRank", () => {
  test("p1 beats p2 beats p3", () => {
    expect(priorityRank("p1")).toBeLessThan(priorityRank("p2"));
    expect(priorityRank("p2")).toBeLessThan(priorityRank("p3"));
  });

  test("returns highest-pri then lowest number", () => {
    const a = mkIssue(252, "OPEN", null, true, "backlog", "p3", [], "T252");
    const b = mkIssue(193, "OPEN", null, true, "backlog", "p3", [], "T193");
    const c = mkIssue(194, "OPEN", null, true, "backlog", "p3", [], "T194");
    expect(pickQueuedFooter([a, b, c])?.number).toBe(193);
  });

  test("empty bench → null", () => {
    expect(pickQueuedFooter([])).toBeNull();
  });
});

// ----- end-to-end rendering -----------------------------------------------

describe("renderStoriesBlock — end to end", () => {
  test("matches AC#6 expected structural facts on 2026-05-07 fixture", () => {
    // Fixture replicates real GH state: 5 active roots, 3 bench (one pairs
    // by Phase title with #179), within-story blocker on #246, contiguous
    // + non-contiguous closed runs under #179.
    const raw: RawIssue[] = [
      // === Story #179 — Phase 1 MVP (active root) ===
      {
        number: 179,
        state: "OPEN",
        labels: [
          { name: "type:plan" },
          { name: "status:in-progress" },
          { name: "priority:p2" },
        ],
        body: "## Why\n\nStuff.",
        title: "Story: /airtable-knowledge-extract — Phase 1 MVP",
      },
      // 13 contiguous closed under 179
      ...Array.from({ length: 13 }, (_, i) => ({
        number: 180 + i,
        state: "CLOSED",
        labels: [{ name: "priority:p2" }],
        body: `## Parent\n\n- ai-brain#179\n`,
        title: `C${180 + i}`,
      })),
      {
        number: 204,
        state: "OPEN",
        labels: [{ name: "status:in-progress" }, { name: "priority:p1" }],
        body: "## Parent\n\n- ai-brain#179\n",
        title: "#179 retro",
      },
      {
        number: 208,
        state: "CLOSED",
        labels: [{ name: "priority:p1" }],
        body: "## Parent\n\n- ai-brain#179\n",
        title: "Live rung-0 dry-run",
      },
      // === Story #237 nested under #179 (active plan child) ===
      {
        number: 237,
        state: "OPEN",
        labels: [
          { name: "type:plan" },
          { name: "status:in-progress" },
          { name: "priority:p2" },
        ],
        body: "## Parent\n\n- ai-brain#179 (Phase 1 MVP)\n",
        title: "Story: Schema-driven extraction dispatch (Phase-1 architecture correction)",
      },
      // 8 closed children under 237
      ...Array.from({ length: 8 }, (_, i) => ({
        number: 238 + i,
        state: "CLOSED",
        labels: [{ name: "priority:p2" }],
        body: `## Parent\n\n- ai-brain#237\n`,
        title: `Build C${238 + i}`,
      })),
      {
        number: 246,
        state: "OPEN",
        labels: [{ name: "status:blocked" }, { name: "priority:p2" }],
        body: "## Parent\n\n- ai-brain#237\n\n## Blocked by\n\n- ai-brain#251 — text-field gap\n",
        title: "Live Staronline replay evidence",
      },
      {
        number: 251,
        state: "OPEN",
        labels: [{ name: "status:in-progress" }, { name: "priority:p2" }],
        body: "## Parent\n\n- ai-brain#237\n",
        title: "Text-field entity extractor",
      },
      // === Bench plan that pairs with #179 by phase title ===
      {
        number: 193,
        state: "OPEN",
        labels: [
          { name: "type:plan" },
          { name: "status:backlog" },
          { name: "priority:p3" },
        ],
        body: "## User Story\n\nAfter Phase 1 ships.",
        title: "Story: /airtable-knowledge-extract — Phase 2 (Coordinator)",
      },
      // === Bench plan, no phase pairing (footer queued) ===
      {
        number: 194,
        state: "OPEN",
        labels: [
          { name: "type:plan" },
          { name: "status:backlog" },
          { name: "priority:p3" },
        ],
        body: "## User Story\n\nResearch.",
        title: "Research: Hermes vs claude-code subagents vs MCP",
      },
      // === Bench plan, no phase pairing ===
      {
        number: 252,
        state: "OPEN",
        labels: [
          { name: "type:plan" },
          { name: "status:backlog" },
          { name: "priority:p3" },
        ],
        body: "## User Story\n\nAudit.",
        title: "Story: Agent-teams audit consensus (Phase B — deferred)",
      },
    ];

    const out = renderStoriesBlock(raw);

    // Header
    expect(out).toContain("**Stories (1 active + 3 on bench)**");

    // Root #179
    expect(out).toContain("Story #179 [in-prog] — /airtable-knowledge-extract — Phase 1 MVP");
    // Contiguous closed run #180–#192
    expect(out).toContain("├── #180–#192 [closed] — 13 done");
    // Open in-prog child
    expect(out).toContain("├── #204 [in-prog] — #179 retro");
    // #208 alone (in its own closed group, after open #204 broke the run)
    expect(out).toContain("├── #208 [closed] — Live rung-0 dry-run");
    // Nested Story #237 (with type-marker "Story " because isPlan)
    expect(out).toMatch(
      /(├──|└──) Story #237 \[in-prog\] — Schema-driven extraction dispatch/,
    );
    // 237's contiguous closed children
    expect(out).toContain("#238–#245 [closed] — 8 done");
    // 246 carries the (blocked by #251) suffix
    expect(out).toContain("#246 [BLOCKED] — Live Staronline replay evidence (blocked by #251)");
    // 251 is a leaf
    expect(out).toContain("#251 [in-prog] — Text-field entity extractor");

    // Phase pairing trailer under #179 — points at #193
    expect(out).toContain(
      "└── Next story queued: #193 — /airtable-knowledge-extract — Phase 2 (Coordinator)",
    );

    // Footer queued = next bench, p3 → lowest number = #194 (since #193 is linked)
    expect(out).toContain("Next story queued: #194");
    expect(out).toContain("(1 more on bench)");
  });

  test("empty payload → empty output", () => {
    expect(renderStoriesBlock([])).toBe("");
  });

  test("only bench plans → no roots, only queued footer", () => {
    const raw: RawIssue[] = [
      {
        number: 193,
        state: "OPEN",
        labels: [
          { name: "type:plan" },
          { name: "status:backlog" },
          { name: "priority:p3" },
        ],
        body: "",
        title: "Story: Phase 2",
      },
    ];
    const out = renderStoriesBlock(raw);
    expect(out).toContain("**Stories (0 active + 1 on bench)**");
    expect(out).toContain("Next story queued: #193 — Phase 2");
  });

  test("no bench plans → header omits 'on bench' suffix", () => {
    const raw: RawIssue[] = [
      {
        number: 100,
        state: "OPEN",
        labels: [
          { name: "type:plan" },
          { name: "status:in-progress" },
          { name: "priority:p2" },
        ],
        body: "",
        title: "Story: Active",
      },
    ];
    const out = renderStoriesBlock(raw);
    expect(out).toContain("**Stories (1)**");
    expect(out).not.toContain("on bench");
    expect(out).not.toContain("Next story queued");
  });
});
