import { test, expect, describe } from "bun:test";
import {
  parseChecklist,
  parseBlockers,
  parseOwner,
  tickChecklist,
  clampParallel,
  computeReady,
  promoteWaiters,
  decideWorkerAction,
  inferRepoFromIssueArea,
  defaultAreaMap,
  cleanupWorker,
  runStory,
  parseAcceptance,
  parseCoversAc,
  findUncoveredAc,
  formatUncoveredComment,
  PreCheckBlockedError,
  runPreCheck,
  writeImplStoryLogRow,
  parseParentCommentEvidence,
  findMissingEvidence,
  extractAreaName,
  formatEvidenceChildTitle,
  formatEvidenceChildBody,
  formatHitlComment,
  formatHitlNotification,
  runCloseGate,
  type Issue,
  type SpawnClient,
  type Logger,
  type OrchestratorDeps,
  type GhClient,
  type State,
  type ChildResultReader,
  type ImplStoryLogWriter,
  type CloseGateDeps,
  type CreateIssueOpts,
} from "./run-story.ts";
import type { ChildResultRecord } from "./lib/ac-coverage.ts";

describe("parseChecklist", () => {
  test("extracts unchecked + checked child issue numbers from parent body", () => {
    const body = [
      "## User Story",
      "intro text",
      "",
      "## Sub-issues",
      "- [ ] #146 — First child. Blocked by: —",
      "- [ ] #147 — Second",
      "- [x] #148 — Done child",
      "- [ ] #149 — Has deps. Blocked by: #147",
      "",
      "## Acceptance",
      "- [ ] All done",
    ].join("\n");

    expect(parseChecklist(body)).toEqual([146, 147, 148, 149]);
  });

  test("returns empty for body with no checklist child items", () => {
    expect(parseChecklist("just prose")).toEqual([]);
  });

  test("ignores acceptance section checkboxes (no # number)", () => {
    const body = "- [ ] All sub-issues closed\n- [ ] #146 — child";
    expect(parseChecklist(body)).toEqual([146]);
  });

  test("accepts repo-prefixed cross-repo checklist format (ai-brain#N)", () => {
    const body = [
      "## Sub-issues",
      "- [ ] ai-brain#155 — Label cleanup",
      "- [ ] ai-brain#156 — Rename skill",
      "- [x] ai-brain#157 — Already done",
      "- [ ] some-repo#9999 — Other repo",
    ].join("\n");
    expect(parseChecklist(body)).toEqual([155, 156, 157, 9999]);
  });

  test("mixed bare and prefixed forms in same body", () => {
    const body = [
      "- [ ] #100",
      "- [ ] ai-brain#200",
      "- [x] #300",
    ].join("\n");
    expect(parseChecklist(body)).toEqual([100, 200, 300]);
  });
});

describe("parseBlockers", () => {
  test("extracts blockers from Blocked by section", () => {
    const body = [
      "## What to build",
      "foo",
      "",
      "## Blocked by",
      "",
      "- ai-brain#147",
      "- ai-brain#148",
    ].join("\n");
    expect(parseBlockers(body)).toEqual([147, 148]);
  });

  test("returns empty when section says None", () => {
    const body = "## Blocked by\n\nNone — can start immediately.";
    expect(parseBlockers(body)).toEqual([]);
  });

  test("ignores ai-brain refs outside Blocked by section", () => {
    const body = [
      "## Parent",
      "- ai-brain#145",
      "",
      "## Blocked by",
      "- ai-brain#147",
    ].join("\n");
    expect(parseBlockers(body)).toEqual([147]);
  });

  test("section closes at next H2", () => {
    const body = [
      "## Blocked by",
      "- ai-brain#147",
      "## Other",
      "- ai-brain#999",
    ].join("\n");
    expect(parseBlockers(body)).toEqual([147]);
  });
});

describe("parseOwner", () => {
  test("detects owner:bot", () => {
    expect(parseOwner(["area:plugin-brain-os", "owner:bot", "status:ready"])).toBe("bot");
  });

  test("detects owner:human", () => {
    expect(parseOwner(["owner:human", "weight:quick"])).toBe("human");
  });

  test("defaults to bot when no owner label", () => {
    expect(parseOwner(["weight:quick"])).toBe("bot");
  });
});

describe("tickChecklist", () => {
  test("ticks the matching child checkbox", () => {
    const body = "- [ ] #146 — First\n- [ ] #147 — Second";
    const result = tickChecklist(body, 146);
    expect(result).toContain("- [x] #146 — First");
    expect(result).toContain("- [ ] #147 — Second");
  });

  test("idempotent on already-ticked", () => {
    const body = "- [x] #146 — Done";
    expect(tickChecklist(body, 146)).toBe(body);
  });

  test("does not affect other checkboxes that share text", () => {
    const body = "- [ ] All sub-issues closed\n- [ ] #146 — child";
    const result = tickChecklist(body, 146);
    expect(result).toContain("- [ ] All sub-issues closed");
    expect(result).toContain("- [x] #146 — child");
  });
});

describe("clampParallel", () => {
  test("returns input when within range", () => {
    expect(clampParallel(3, 5)).toBe(3);
  });

  test("clamps to hard cap", () => {
    expect(clampParallel(10, 5)).toBe(5);
  });

  test("floors at 1", () => {
    expect(clampParallel(0, 5)).toBe(1);
    expect(clampParallel(-2, 5)).toBe(1);
  });
});

describe("computeReady", () => {
  test("includes children with no deps and OPEN state", () => {
    const issues: Issue[] = [
      { number: 146, deps: [], owner: "bot", state: "OPEN", title: "first", cwd: "/repo" },
      { number: 147, deps: [], owner: "bot", state: "OPEN", title: "second", cwd: "/repo" },
    ];
    expect(computeReady(issues, new Set())).toEqual([146, 147]);
  });

  test("excludes children whose deps are still open", () => {
    const issues: Issue[] = [
      { number: 146, deps: [], owner: "bot", state: "OPEN", title: "first", cwd: "/repo" },
      { number: 149, deps: [147], owner: "bot", state: "OPEN", title: "blocked", cwd: "/repo" },
    ];
    expect(computeReady(issues, new Set())).toEqual([146]);
  });

  test("includes children whose deps are all closed", () => {
    const issues: Issue[] = [
      { number: 149, deps: [147, 148], owner: "bot", state: "OPEN", title: "needs deps", cwd: "/repo" },
    ];
    const closed = new Set([147, 148]);
    expect(computeReady(issues, closed)).toEqual([149]);
  });

  test("excludes children that are themselves CLOSED", () => {
    const issues: Issue[] = [
      { number: 146, deps: [], owner: "bot", state: "CLOSED", title: "done", cwd: "/repo" },
    ];
    expect(computeReady(issues, new Set([146]))).toEqual([]);
  });
});

describe("promoteWaiters", () => {
  test("promotes when all deps just became closed", () => {
    const issues: Issue[] = [
      { number: 149, deps: [147, 148], owner: "bot", state: "OPEN", title: "x", cwd: "/repo" },
    ];
    const closed = new Set([147, 148]);
    expect(promoteWaiters(issues, 148, closed, new Set([149]))).toEqual([149]);
  });

  test("does not promote if other deps still open", () => {
    const issues: Issue[] = [
      { number: 149, deps: [147, 148], owner: "bot", state: "OPEN", title: "x", cwd: "/repo" },
    ];
    const closed = new Set([147]);
    expect(promoteWaiters(issues, 147, closed, new Set([149]))).toEqual([]);
  });

  test("does not promote children not in pending set (already running/done)", () => {
    const issues: Issue[] = [
      { number: 149, deps: [147], owner: "bot", state: "OPEN", title: "x", cwd: "/repo" },
    ];
    const closed = new Set([147]);
    expect(promoteWaiters(issues, 147, closed, new Set())).toEqual([]);
  });

  test("promotes multiple waiters when shared dep closes", () => {
    const issues: Issue[] = [
      { number: 149, deps: [147], owner: "bot", state: "OPEN", title: "x", cwd: "/repo" },
      { number: 150, deps: [147], owner: "bot", state: "OPEN", title: "y", cwd: "/repo" },
    ];
    const closed = new Set([147]);
    expect(promoteWaiters(issues, 147, closed, new Set([149, 150])).sort()).toEqual([149, 150]);
  });
});

describe("decideWorkerAction", () => {
  test("CLOSED issue → closed regardless of pid state", () => {
    expect(decideWorkerAction(true, "CLOSED")).toBe("closed");
    expect(decideWorkerAction(false, "CLOSED")).toBe("closed");
  });

  test("OPEN + pid alive → still running", () => {
    expect(decideWorkerAction(true, "OPEN")).toBe("running");
  });

  test("OPEN + pid dead → dead worker (failure mode)", () => {
    expect(decideWorkerAction(false, "OPEN")).toBe("dead");
  });
});

describe("inferRepoFromIssueArea", () => {
  const home = "/Users/test";
  const map = defaultAreaMap(home);

  test("area:plugin-brain-os → ~/work/brain-os-plugin", () => {
    expect(inferRepoFromIssueArea(["area:plugin-brain-os"], map)).toBe(
      `${home}/work/brain-os-plugin`,
    );
  });

  test("area:plugin-ai-leaders-vietnam → ~/work/ai-leaders-vietnam", () => {
    expect(inferRepoFromIssueArea(["area:plugin-ai-leaders-vietnam"], map)).toBe(
      `${home}/work/ai-leaders-vietnam`,
    );
  });

  test("area:vault → ~/work/brain", () => {
    expect(inferRepoFromIssueArea(["area:vault"], map)).toBe(`${home}/work/brain`);
  });

  test("area:claude-config → ~/.claude", () => {
    expect(inferRepoFromIssueArea(["area:claude-config"], map)).toBe(`${home}/.claude`);
  });

  test("first matching area wins when multiple labels present", () => {
    expect(
      inferRepoFromIssueArea(["status:ready", "owner:bot", "area:plugin-brain-os"], map),
    ).toBe(`${home}/work/brain-os-plugin`);
  });

  test("user-supplied map extends defaults — private deployments register areas via config", () => {
    const extended = { ...map, "plugin-private-x": "/private/x", "plugin-private-y": "/private/y" };
    expect(inferRepoFromIssueArea(["area:plugin-private-x"], extended)).toBe("/private/x");
    expect(inferRepoFromIssueArea(["area:plugin-private-y"], extended)).toBe("/private/y");
  });

  test("user-supplied map can override defaults", () => {
    const overridden = { ...map, vault: "/elsewhere/brain" };
    expect(inferRepoFromIssueArea(["area:vault"], overridden)).toBe("/elsewhere/brain");
  });

  test("throws on unknown area:* label", () => {
    expect(() => inferRepoFromIssueArea(["area:zzz-unknown"], map)).toThrow(/no known area/);
  });

  test("throws when no area:* label present", () => {
    expect(() => inferRepoFromIssueArea(["owner:bot", "status:ready"], map)).toThrow(
      /no known area/,
    );
  });
});

describe("cleanupWorker", () => {
  test("calls spawn.cleanupWorktree with name + cwd and logs success", async () => {
    const calls: Array<{ name: string; cwd: string }> = [];
    const logs: string[] = [];
    const spawn: SpawnClient = {
      spawnWorker: () => ({ pid: 0 }),
      cleanupWorktree: (name, cwd) => calls.push({ name, cwd }),
    };
    const logger: Logger = { log: (m) => logs.push(m) };

    await cleanupWorker(spawn, "story-145-issue-146", "/Users/test/work/brain-os-plugin", logger);

    expect(calls).toEqual([
      { name: "story-145-issue-146", cwd: "/Users/test/work/brain-os-plugin" },
    ]);
    expect(
      logs.some((l) => l.includes("cleaned worktree") && l.includes("story-145-issue-146")),
    ).toBe(true);
  });

  test("error in cleanupWorktree is logged and does not throw", async () => {
    const logs: string[] = [];
    const spawn: SpawnClient = {
      spawnWorker: () => ({ pid: 0 }),
      cleanupWorktree: () => {
        throw new Error("worktree locked by another process");
      },
    };
    const logger: Logger = { log: (m) => logs.push(m) };

    await expect(
      cleanupWorker(spawn, "story-1-issue-2", "/repo", logger),
    ).resolves.toBeUndefined();

    expect(
      logs.some(
        (l) =>
          l.includes("cleanup failed") &&
          l.includes("story-1-issue-2") &&
          l.includes("worktree locked"),
      ),
    ).toBe(true);
  });
});

describe("runStory — type:plan assertion", () => {
  test("parent without type:plan label → refuses to drain, returns empty, no spawn", async () => {
    let spawnCalls = 0;
    const notifications: string[] = [];
    const logs: string[] = [];

    const deps: OrchestratorDeps = {
      gh: {
        viewBody: async () => "- [ ] #200 — stray ref in acceptance criteria",
        viewFull: async () => ({
          title: "Some leaf issue",
          // No type:plan label — simulates a wrong-number /impl story call on
          // a leaf issue whose body happens to contain stray checkbox refs.
          labels: ["status:ready", "owner:bot", "area:plugin-brain-os", "weight:quick"],
          body: "- [ ] #200 — stray ref in acceptance criteria",
          state: "OPEN",
        }),
        viewState: async () => "OPEN",
        editBody: async () => {},
        closeIssue: async () => {},
        relabelHuman: async () => {},
        listIssues: async () => [],
        claim: async () => {},
        addComment: async () => {},
        viewComments: async () => [],
        createIssue: async () => {
          throw new Error("createIssue must not be called");
        },
      },
      spawn: {
        spawnWorker: () => {
          spawnCalls++;
          throw new Error("spawnWorker must not be invoked when parent lacks type:plan");
        },
        cleanupWorktree: () => {},
      },
      proc: { isAlive: () => true },
      notify: { notify: (m) => notifications.push(m) },
      logger: { log: (m) => logs.push(m) },
      status: { write: () => {} },
      pollIntervalMs: 1,
      workerLogDir: "/tmp/run-story-test",
      areaMap: defaultAreaMap("/Users/test"),
    };

    const result = await runStory(999, 3, deps);

    expect(result).toEqual({ closed: [], failed: [] });
    expect(spawnCalls).toBe(0);
    // The orchestrator emits a "started" notify before the guard runs; the
    // refusal must appear in *some* later notify, not necessarily the only one.
    expect(
      notifications.some((m) => m.includes("not type:plan") && m.includes("/impl")),
    ).toBe(true);
  });

  test("parent with type:plan label → guard passes, falls through to existing 'no checklist children' abort when body has no children", async () => {
    let spawnCalls = 0;
    const notifications: string[] = [];

    const deps: OrchestratorDeps = {
      gh: {
        viewBody: async () => "## PRD\n\nNo sub-issues defined yet.",
        viewFull: async () => ({
          title: "Story parent",
          labels: ["type:plan", "owner:human", "status:in-progress", "area:plugin-brain-os"],
          body: "## PRD\n\nNo sub-issues defined yet.",
          state: "OPEN",
        }),
        viewState: async () => "OPEN",
        editBody: async () => {},
        closeIssue: async () => {},
        relabelHuman: async () => {},
        listIssues: async () => [],
        claim: async () => {},
        addComment: async () => {},
        viewComments: async () => [],
        createIssue: async () => {
          throw new Error("createIssue must not be called");
        },
      },
      spawn: {
        spawnWorker: () => {
          spawnCalls++;
          throw new Error("spawnWorker must not be invoked when parent has no checklist children");
        },
        cleanupWorktree: () => {},
      },
      proc: { isAlive: () => true },
      notify: { notify: (m) => notifications.push(m) },
      logger: { log: () => {} },
      status: { write: () => {} },
      pollIntervalMs: 1,
      workerLogDir: "/tmp/run-story-test",
      areaMap: defaultAreaMap("/Users/test"),
    };

    const result = await runStory(123, 3, deps);

    expect(result).toEqual({ closed: [], failed: [] });
    expect(spawnCalls).toBe(0);
    // Confirms the type:plan guard did NOT fire for this case (no refusal
    // message); the empty-checklist abort path took over instead.
    expect(notifications.some((m) => m.includes("not type:plan"))).toBe(false);
    expect(notifications.some((m) => m.includes("no checklist children"))).toBe(true);
  });
});

// =========================================================================
// Gate B (runPreCheck) — references/ac-coverage-spec.md § 1, § 3
// =========================================================================

describe("parseAcceptance", () => {
  test("returns empty map when body has no AC bullets", () => {
    expect(parseAcceptance("just prose, no AC bullets here").size).toBe(0);
  });

  test("matches single AC bullet anchored with em-dash", () => {
    const body = "- [ ] **AC#1** — Gate A: /slice refuses to file.";
    const acs = parseAcceptance(body);
    expect(acs.size).toBe(1);
    expect(acs.get(1)).toBe("Gate A: /slice refuses to file.");
  });

  test("matches multiple AC bullets including [x] checked state", () => {
    const body = [
      "## Acceptance",
      "",
      "- [ ] **AC#1** — first criterion. Verified by replay.",
      "- [x] **AC#2** — second criterion. Verified by inspection.",
      "- [ ] **AC#10** — tenth criterion.",
    ].join("\n");
    const acs = parseAcceptance(body);
    expect([...acs.keys()].sort((a, b) => a - b)).toEqual([1, 2, 10]);
    expect(acs.get(2)).toBe("second criterion. Verified by inspection.");
  });

  test("rejects ASCII hyphen separator (must be U+2014 em-dash)", () => {
    const body = "- [ ] **AC#1** - hyphen instead of em-dash";
    expect(parseAcceptance(body).size).toBe(0);
  });

  test("rejects bullets without bold AC markers", () => {
    const body = "- [ ] AC#1 — missing bold markers";
    expect(parseAcceptance(body).size).toBe(0);
  });
});

describe("parseCoversAc", () => {
  test("returns empty set when body has no Covers AC section", () => {
    const body = "## Parent\n\n- ai-brain#196\n\n## What to build\n\nfoo";
    expect(parseCoversAc(body).size).toBe(0);
  });

  test("returns empty set for empty section (pure-component child)", () => {
    const body = ["## Parent", "- ai-brain#196", "", "## Covers AC", "", "## What to build"].join(
      "\n",
    );
    expect(parseCoversAc(body).size).toBe(0);
  });

  test("matches single AC bullet", () => {
    const body = ["## Covers AC", "", "- AC#3", "", "## Acceptance"].join("\n");
    expect([...parseCoversAc(body)]).toEqual([3]);
  });

  test("matches multiple AC bullets", () => {
    const body = ["## Covers AC", "", "- AC#1", "- AC#5", "- AC#8", "", "## Files"].join("\n");
    expect([...parseCoversAc(body)].sort((a, b) => a - b)).toEqual([1, 5, 8]);
  });

  test("rejects multi-ID bullet (`- AC#1, AC#3`) — does not split on comma", () => {
    const body = ["## Covers AC", "", "- AC#1, AC#3", "", "## Acceptance"].join("\n");
    expect(parseCoversAc(body).size).toBe(0);
  });

  test("rejects lowercase AC# tag", () => {
    const body = ["## Covers AC", "", "- ac#2", "", "## Acceptance"].join("\n");
    expect(parseCoversAc(body).size).toBe(0);
  });

  test("section closes at next H2 — bullets after H2 are ignored", () => {
    const body = ["## Covers AC", "", "- AC#1", "", "## Acceptance", "- AC#999"].join("\n");
    expect([...parseCoversAc(body)]).toEqual([1]);
  });

  test("tolerates trailing whitespace on AC bullet", () => {
    const body = ["## Covers AC", "", "- AC#5  ", "", "## Other"].join("\n");
    expect([...parseCoversAc(body)]).toEqual([5]);
  });
});

describe("findUncoveredAc", () => {
  test("returns empty when all parent AC IDs are covered by some child", () => {
    const cov = new Map<number, Set<number>>([
      [101, new Set([1, 2])],
      [102, new Set([3])],
    ]);
    expect(findUncoveredAc([1, 2, 3], cov)).toEqual([]);
  });

  test("returns uncovered IDs sorted ascending", () => {
    const cov = new Map<number, Set<number>>([
      [101, new Set([1])],
      [102, new Set([3])],
    ]);
    expect(findUncoveredAc([1, 2, 3, 5, 4], cov)).toEqual([2, 4, 5]);
  });

  test("returns all parent IDs when child coverage map is empty", () => {
    expect(findUncoveredAc([1, 2, 3], new Map())).toEqual([1, 2, 3]);
  });

  test("returns all parent IDs when every child has empty coverage", () => {
    const cov = new Map<number, Set<number>>([
      [101, new Set()],
      [102, new Set()],
    ]);
    expect(findUncoveredAc([7, 8], cov)).toEqual([7, 8]);
  });

  test("returns empty when parent has no AC IDs (regardless of children)", () => {
    const cov = new Map<number, Set<number>>([[101, new Set([99])]]);
    expect(findUncoveredAc([], cov)).toEqual([]);
  });
});

describe("formatUncoveredComment", () => {
  test("formats single uncovered AC ID", () => {
    expect(formatUncoveredComment([3])).toBe(
      "AC mapping missing — add `## Covers AC` to children before resuming. Uncovered: AC#3",
    );
  });

  test("formats multiple uncovered AC IDs in given order", () => {
    expect(formatUncoveredComment([2, 5])).toBe(
      "AC mapping missing — add `## Covers AC` to children before resuming. Uncovered: AC#2, AC#5",
    );
  });
});

// runPreCheck integration — uses an in-memory GhClient that records each
// addComment call so tests can assert both the throw AND the comment content.
function makeGh(bodies: Record<number, { body: string; labels?: string[]; state?: State }>): {
  gh: GhClient;
  comments: Array<{ n: number; body: string }>;
} {
  const comments: Array<{ n: number; body: string }> = [];
  const gh: GhClient = {
    viewBody: async (n) => bodies[n]?.body ?? "",
    viewFull: async (n) => {
      const e = bodies[n];
      if (!e) throw new Error(`unmocked viewFull(${n})`);
      return {
        title: `mock #${n}`,
        body: e.body,
        labels: e.labels ?? [],
        state: e.state ?? "OPEN",
      };
    },
    viewState: async (n) => bodies[n]?.state ?? "OPEN",
    editBody: async () => {},
    closeIssue: async () => {},
    relabelHuman: async () => {},
    listIssues: async () => [],
    claim: async () => {},
    addComment: async (n, body) => {
      comments.push({ n, body });
    },
    viewComments: async () => [],
    createIssue: async () => {
      throw new Error("createIssue must not be called in this test");
    },
  };
  return { gh, comments };
}

describe("runPreCheck — Gate B", () => {
  test("legacy parent without ## Acceptance bullets → skips entirely (no comment, no throw)", async () => {
    const logs: string[] = [];
    const { gh, comments } = makeGh({
      500: {
        body: [
          "## User Story",
          "Some prose.",
          "",
          "## Sub-issues",
          "- [ ] #501",
          "",
          // No ## Acceptance section at all — legacy story.
        ].join("\n"),
      },
      501: { body: "## Covers AC\n\n## What to build\n\nfoo" },
    });
    await expect(runPreCheck(500, { gh, logger: { log: (m) => logs.push(m) } })).resolves.toBeUndefined();
    expect(comments).toHaveLength(0);
    expect(logs.some((l) => l.includes("no ## Acceptance bullets") && l.includes("legacy"))).toBe(true);
  });

  test("all parent AC covered by at least one child → returns without comment", async () => {
    const logs: string[] = [];
    const { gh, comments } = makeGh({
      600: {
        body: [
          "## Sub-issues",
          "- [ ] #601",
          "- [ ] #602",
          "",
          "## Acceptance",
          "",
          "- [ ] **AC#1** — first.",
          "- [ ] **AC#2** — second.",
        ].join("\n"),
      },
      601: { body: "## Covers AC\n\n- AC#1\n\n## What to build" },
      602: { body: "## Covers AC\n\n- AC#2\n\n## What to build" },
    });
    await expect(runPreCheck(600, { gh, logger: { log: (m) => logs.push(m) } })).resolves.toBeUndefined();
    expect(comments).toHaveLength(0);
    expect(logs.some((l) => l.includes("all 2 AC covered"))).toBe(true);
  });

  test("partial coverage → throws PreCheckBlockedError + posts comment with concrete uncovered IDs", async () => {
    const { gh, comments } = makeGh({
      700: {
        body: [
          "## Sub-issues",
          "- [ ] #701",
          "- [ ] #702",
          "",
          "## Acceptance",
          "",
          "- [ ] **AC#1** — covered by 701.",
          "- [ ] **AC#2** — uncovered.",
          "- [ ] **AC#5** — uncovered.",
        ].join("\n"),
      },
      701: { body: "## Covers AC\n\n- AC#1\n\n## What to build" },
      702: { body: "## Covers AC\n\n## What to build" }, // pure-component, empty section
    });

    await expect(runPreCheck(700, { gh, logger: { log: () => {} } })).rejects.toBeInstanceOf(
      PreCheckBlockedError,
    );

    expect(comments).toHaveLength(1);
    expect(comments[0].n).toBe(700);
    expect(comments[0].body).toBe(
      "AC mapping missing — add `## Covers AC` to children before resuming. Uncovered: AC#2, AC#5",
    );
  });

  test("parent has AC but zero children with coverage → blocks listing every AC ID", async () => {
    const { gh, comments } = makeGh({
      800: {
        body: [
          "## Sub-issues",
          "- [ ] #801",
          "",
          "## Acceptance",
          "",
          "- [ ] **AC#1** — first.",
          "- [ ] **AC#2** — second.",
        ].join("\n"),
      },
      // Child 801 has no `## Covers AC` section at all (filer bug — empty
      // section is required even for pure-component children per spec § 1.1).
      801: { body: "## Parent\n\n- ai-brain#800\n\n## What to build\n\nfoo" },
    });

    let caught: PreCheckBlockedError | null = null;
    try {
      await runPreCheck(800, { gh, logger: { log: () => {} } });
    } catch (err) {
      if (err instanceof PreCheckBlockedError) caught = err;
      else throw err;
    }
    expect(caught).not.toBeNull();
    expect(caught!.uncovered).toEqual([1, 2]);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("Uncovered: AC#1, AC#2");
  });

  test("parent has AC but no sub-issue checklist → blocks listing every AC ID", async () => {
    const { gh, comments } = makeGh({
      900: {
        body: [
          "## User Story",
          "Just a parent shell with AC but no children filed yet.",
          "",
          "## Acceptance",
          "",
          "- [ ] **AC#1** — first.",
          "- [ ] **AC#3** — third.",
        ].join("\n"),
      },
    });

    await expect(runPreCheck(900, { gh, logger: { log: () => {} } })).rejects.toBeInstanceOf(
      PreCheckBlockedError,
    );
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("Uncovered: AC#1, AC#3");
  });
});

// =========================================================================
// AC#10 instrumentation — writeImplStoryLogRow
// =========================================================================

function makeChildResults(records: Record<number, ChildResultRecord | null>): {
  reader: ChildResultReader;
  reads: Array<{ parent: number; child: number }>;
} {
  const reads: Array<{ parent: number; child: number }> = [];
  return {
    reader: {
      async read(parent, child) {
        reads.push({ parent, child });
        return records[child] ?? null;
      },
    },
    reads,
  };
}

function makeStoryLogWriter() {
  const lines: string[] = [];
  const writer: ImplStoryLogWriter = {
    async append(line) {
      lines.push(line);
    },
  };
  return { writer, lines };
}

const PARENT_BODY_2_LIVE = [
  "## Acceptance",
  "- [ ] **AC#1** — Live one. Verified by replay with live integration.",
  "- [ ] **AC#7** — Spec. Verified by inspection.",
].join("\n");

describe("writeImplStoryLogRow", () => {
  test("happy path — counters aggregated, row written with correct TSV format", async () => {
    const { reader } = makeChildResults({
      10: {
        parent: 196,
        child: 10,
        verified: true,
        tddRunCount: 1,
        advisorCalls: 1,
        advisorRejections: 0,
        ts: "",
      },
      11: {
        parent: 196,
        child: 11,
        verified: true,
        tddRunCount: 2,
        advisorCalls: 2,
        advisorRejections: 1,
        ts: "",
      },
    });
    const { writer, lines } = makeStoryLogWriter();
    const logs: string[] = [];
    const logger: Logger = { log: (m) => logs.push(m) };

    await writeImplStoryLogRow({
      parent: 196,
      childBodies: new Map<number, string>([
        [10, `## Covers AC\n\n- AC#1\n\n## End\n`],
        [11, `## Covers AC\n\n- AC#7\n\n## End\n`],
      ]),
      parentBody: PARENT_BODY_2_LIVE,
      failed: [],
      parentClosed: true,
      wallTimeSec: 5430,
      childResults: reader,
      implStoryLog: writer,
      logger,
    });

    expect(lines).toHaveLength(1);
    const cols = lines[0].split("\t");
    expect(cols).toHaveLength(8);
    // date / parent / child_count / live_ac_child_count / advisor_calls / advisor_rejections / wall_time / result
    expect(cols[1]).toBe("196");
    expect(cols[2]).toBe("2");   // childCount
    expect(cols[3]).toBe("1");   // liveAcChildCount (only #10 covers live AC#1)
    expect(cols[4]).toBe("3");   // advisorCalls = 1+2
    expect(cols[5]).toBe("1");   // advisorRejections = 0+1
    expect(cols[6]).toBe("5430"); // wall_time
    expect(cols[7]).toBe("pass");
  });

  test("missing result file → warn + counters zero for that child, run still writes row", async () => {
    const { reader } = makeChildResults({
      10: {
        parent: 196,
        child: 10,
        verified: true,
        tddRunCount: 1,
        advisorCalls: 1,
        advisorRejections: 0,
        ts: "",
      },
      // 11 missing entirely
    });
    const { writer, lines } = makeStoryLogWriter();
    const logs: string[] = [];
    const logger: Logger = { log: (m) => logs.push(m) };

    await writeImplStoryLogRow({
      parent: 196,
      childBodies: new Map<number, string>([
        [10, `## Covers AC\n\n- AC#1\n\n## End\n`],
        [11, `## Covers AC\n\n- AC#1\n\n## End\n`],
      ]),
      parentBody: PARENT_BODY_2_LIVE,
      failed: [],
      parentClosed: true,
      wallTimeSec: 100,
      childResults: reader,
      implStoryLog: writer,
      logger,
    });

    expect(logs.some((l) => l.includes("no per-child result file") && l.includes("#11"))).toBe(true);
    expect(lines).toHaveLength(1);
    const cols = lines[0].split("\t");
    expect(cols[4]).toBe("1"); // advisorCalls = only #10
    expect(cols[5]).toBe("0");
  });

  test("failed children + parent open → result=hitl-fallback", async () => {
    const { reader } = makeChildResults({
      10: {
        parent: 196,
        child: 10,
        verified: false,
        tddRunCount: 3,
        advisorCalls: 3,
        advisorRejections: 3,
        ts: "",
      },
    });
    const { writer, lines } = makeStoryLogWriter();
    const logger: Logger = { log: () => {} };

    await writeImplStoryLogRow({
      parent: 196,
      childBodies: new Map<number, string>([
        [10, `## Covers AC\n\n- AC#1\n\n## End\n`],
      ]),
      parentBody: PARENT_BODY_2_LIVE,
      failed: [10],
      parentClosed: false,
      wallTimeSec: 200,
      childResults: reader,
      implStoryLog: writer,
      logger,
    });

    expect(lines).toHaveLength(1);
    const cols = lines[0].split("\t");
    expect(cols[7]).toBe("hitl-fallback");
  });

  test("implStoryLog absent → skip with warning, no row written", async () => {
    const logs: string[] = [];
    const logger: Logger = { log: (m) => logs.push(m) };

    await writeImplStoryLogRow({
      parent: 196,
      childBodies: new Map<number, string>([[10, ""]]),
      parentBody: "",
      failed: [],
      parentClosed: true,
      wallTimeSec: 1,
      childResults: undefined,
      implStoryLog: undefined,
      logger,
    });

    expect(logs.some((l) => l.includes("implStoryLog not configured"))).toBe(true);
  });

  test("io error reading result file is caught and warned (does not abort run)", async () => {
    const reader: ChildResultReader = {
      async read() {
        throw new Error("EACCES: permission denied");
      },
    };
    const { writer, lines } = makeStoryLogWriter();
    const logs: string[] = [];
    const logger: Logger = { log: (m) => logs.push(m) };

    await writeImplStoryLogRow({
      parent: 196,
      childBodies: new Map<number, string>([[10, ""]]),
      parentBody: "",
      failed: [],
      parentClosed: true,
      wallTimeSec: 0,
      childResults: reader,
      implStoryLog: writer,
      logger,
    });

    expect(logs.some((l) => l.includes("failed reading result file") && l.includes("EACCES"))).toBe(true);
    // Row still written
    expect(lines).toHaveLength(1);
  });
});

// =========================================================================
// Gate C (runCloseGate) — references/ac-coverage-spec.md § 4
// =========================================================================

describe("parseParentCommentEvidence", () => {
  test("matches single-line evidence per spec § 3.4.3 S1", () => {
    const c =
      "Acceptance verified: AC#1 — replayed prior story grill-to-children, /slice ABORT'd at AC#1 zero-coverage; pasted output in commit abc1234";
    expect(parseParentCommentEvidence(c)).toEqual([1]);
  });

  test("matches multiple AC verifications in same comment body", () => {
    const c = [
      "Comment header — anything goes here.",
      "",
      "Acceptance verified: AC#1 — first evidence here",
      "Acceptance verified: AC#9 — live integration ran against `appXXXXXXXX`",
    ].join("\n");
    expect(parseParentCommentEvidence(c).sort((a, b) => a - b)).toEqual([1, 9]);
  });

  test("rejects malformed prefix per spec § 3.4.3 S3", () => {
    const c = "AC#1 verified — looks good to me";
    expect(parseParentCommentEvidence(c)).toEqual([]);
  });

  test("rejects ASCII hyphen in place of em-dash", () => {
    const c = "Acceptance verified: AC#1 - hyphen not em-dash";
    expect(parseParentCommentEvidence(c)).toEqual([]);
  });

  test("returns empty for unrelated comment text", () => {
    expect(parseParentCommentEvidence("LGTM, please merge")).toEqual([]);
  });
});

describe("findMissingEvidence", () => {
  test("returns empty when every AC is covered by closed-child evidence", () => {
    const closed = new Map<number, Set<number>>([
      [201, new Set([1])],
      [202, new Set([2, 3])],
    ]);
    expect(findMissingEvidence([1, 2, 3], closed, [])).toEqual([]);
  });

  test("returns empty when every AC is covered by parent-comment evidence", () => {
    expect(
      findMissingEvidence(
        [1, 2],
        new Map(),
        ["Acceptance verified: AC#1 — replay\nAcceptance verified: AC#2 — inspection"],
      ),
    ).toEqual([]);
  });

  test("mixes form (i) and form (ii) evidence", () => {
    const closed = new Map<number, Set<number>>([[201, new Set([1])]]);
    const comments = ["Acceptance verified: AC#2 — manual replay"];
    expect(findMissingEvidence([1, 2, 3], closed, comments)).toEqual([3]);
  });

  test("returns missing IDs sorted ascending", () => {
    expect(findMissingEvidence([5, 1, 3, 2], new Map(), [])).toEqual([1, 2, 3, 5]);
  });

  test("ignores closed-child entries that don't cover anything (pure-component)", () => {
    const closed = new Map<number, Set<number>>([
      [201, new Set()],
      [202, new Set([1])],
    ]);
    expect(findMissingEvidence([1, 2], closed, [])).toEqual([2]);
  });
});

describe("extractAreaName", () => {
  test("returns area suffix for first area:* label", () => {
    expect(extractAreaName(["status:ready", "area:plugin-brain-os", "owner:bot"])).toBe(
      "plugin-brain-os",
    );
  });

  test("returns null when no area:* label present", () => {
    expect(extractAreaName(["status:ready", "owner:bot"])).toBeNull();
  });

  test("returns first match when multiple area:* labels (filing bug)", () => {
    expect(extractAreaName(["area:vault", "area:plugin-brain-os"])).toBe("vault");
  });
});

describe("formatEvidenceChildTitle / Body", () => {
  test("title shape: 'Evidence: AC#N for parent #P'", () => {
    expect(formatEvidenceChildTitle(196, 10)).toBe("Evidence: AC#10 for parent #196");
  });

  test("body has Parent, Covers AC (single ID), AC quote, and Blocked-by None sections", () => {
    const body = formatEvidenceChildBody(196, 10, "Performance instrumentation: append a row.");
    expect(body).toContain("## Parent\n\n- ai-brain#196");
    expect(body).toContain("## Covers AC\n\n- AC#10");
    expect(body).toContain("Performance instrumentation: append a row.");
    expect(body).toContain("- [ ] Live evidence captured (output pasted in this issue) for AC#10");
    expect(body).toContain("## Blocked by\n\nNone — can start immediately.");
  });

  test("body's Covers AC section is parseable by the existing parseCoversAc parser", () => {
    const body = formatEvidenceChildBody(196, 4, "Some AC text.");
    expect([...parseCoversAc(body)]).toEqual([4]);
  });
});

describe("formatHitlComment / Notification", () => {
  test("HITL comment format includes ralph-iter count + missing AC IDs + remediation hint", () => {
    expect(formatHitlComment([10, 4])).toBe(
      "Acceptance gate failed after 3 ralph iters. Missing evidence: AC#10, AC#4. Post 'Acceptance verified: AC#N — <evidence>' comments OR file new covering child to resolve.",
    );
  });

  test("HITL notification mentions parent number + AC IDs", () => {
    expect(formatHitlNotification(196, [10])).toBe(
      "Parent #196 has unverified AC: AC#10 — see issue",
    );
  });
});

// formatImplStoryLogRow tests live in scripts/lib/ac-coverage.test.ts (the
// row format moved to lib/ac-coverage.ts in #203 — single home for the SSOT
// format coverage).

// runCloseGate integration mock — supports state mutation between polls so
// Phase 2 tests can simulate "spawned child closes; evidence comment lands".
function makeCloseGateGh(initial: Record<number, { body: string; labels?: string[]; state?: State; comments?: string[] }>) {
  const bodies = { ...initial };
  const events: string[] = [];
  const createdIssues: Array<{ n: number; opts: CreateIssueOpts }> = [];
  let nextIssueNum = 9000;
  const gh: GhClient = {
    viewBody: async (n) => bodies[n]?.body ?? "",
    viewFull: async (n) => {
      const e = bodies[n];
      if (!e) throw new Error(`unmocked viewFull(${n})`);
      return {
        title: `mock #${n}`,
        body: e.body,
        labels: e.labels ?? [],
        state: e.state ?? "OPEN",
      };
    },
    viewState: async (n) => bodies[n]?.state ?? "OPEN",
    editBody: async (n, body) => {
      if (bodies[n]) bodies[n].body = body;
    },
    closeIssue: async () => {},
    relabelHuman: async () => {},
    listIssues: async () => [],
    claim: async () => {},
    addComment: async (n, body) => {
      bodies[n] = bodies[n] ?? { body: "" };
      bodies[n].comments = [...(bodies[n].comments ?? []), body];
      events.push(`addComment(${n})`);
    },
    viewComments: async (n) => bodies[n]?.comments ?? [],
    createIssue: async (opts) => {
      const n = nextIssueNum++;
      bodies[n] = { body: opts.body, labels: [`area:${opts.area}`, `owner:${opts.owner}`], state: "OPEN" };
      createdIssues.push({ n, opts });
      events.push(`createIssue(${n})`);
      return n;
    },
  };
  return { gh, bodies, events, createdIssues };
}

function makeCloseGateDeps(
  ghBundle: ReturnType<typeof makeCloseGateGh>,
  overrides: Partial<CloseGateDeps> = {},
): {
  deps: CloseGateDeps;
  spawnCalls: Array<{ name: string; prompt: string; cwd: string; pid: number }>;
  cleanupCalls: Array<{ name: string; cwd: string }>;
  notifications: string[];
  logs: string[];
  pidsAlive: Set<number>;
} {
  const spawnCalls: Array<{ name: string; prompt: string; cwd: string; pid: number }> = [];
  const cleanupCalls: Array<{ name: string; cwd: string }> = [];
  const notifications: string[] = [];
  const logs: string[] = [];
  const pidsAlive = new Set<number>();
  let nextPid = 30000;
  const deps: CloseGateDeps = {
    gh: ghBundle.gh,
    spawn: {
      spawnWorker: (name, prompt, _logPath, cwd) => {
        const pid = nextPid++;
        pidsAlive.add(pid);
        spawnCalls.push({ name, prompt, cwd, pid });
        return { pid };
      },
      cleanupWorktree: (name, cwd) => {
        cleanupCalls.push({ name, cwd });
      },
    },
    proc: { isAlive: (pid) => pidsAlive.has(pid) },
    notify: { notify: (m) => notifications.push(m) },
    logger: { log: (m) => logs.push(m) },
    pollIntervalMs: 1,
    workerLogDir: "/tmp/close-gate-test",
    areaMap: defaultAreaMap("/Users/test"),
    ...overrides,
  };
  return { deps, spawnCalls, cleanupCalls, notifications, logs, pidsAlive };
}

describe("runCloseGate — Phase 1 (deterministic check)", () => {
  test("legacy parent without ## Acceptance bullets → blocked: false (skip)", async () => {
    const ghBundle = makeCloseGateGh({
      500: {
        body: "## User Story\n\nLegacy parent — no AC section.",
        labels: ["type:plan", "area:plugin-brain-os"],
      },
    });
    const { deps, spawnCalls, notifications } = makeCloseGateDeps(ghBundle);
    const result = await runCloseGate(500, deps);
    expect(result.blocked).toBe(false);
    expect(result.iterations).toBe(0);
    expect(spawnCalls).toHaveLength(0);
    expect(notifications).toHaveLength(0);
  });

  test("all AC have form (i) closed-child evidence → blocked: false", async () => {
    const ghBundle = makeCloseGateGh({
      600: {
        body: [
          "## Sub-issues",
          "- [x] #601",
          "- [x] #602",
          "",
          "## Acceptance",
          "",
          "- [ ] **AC#1** — first.",
          "- [ ] **AC#2** — second.",
        ].join("\n"),
        labels: ["type:plan", "area:plugin-brain-os"],
      },
      601: {
        body: "## Covers AC\n\n- AC#1\n\n## What to build",
        state: "CLOSED",
      },
      602: {
        body: "## Covers AC\n\n- AC#2\n\n## What to build",
        state: "CLOSED",
      },
    });
    const { deps, spawnCalls, notifications } = makeCloseGateDeps(ghBundle);
    const result = await runCloseGate(600, deps);
    expect(result).toEqual({ blocked: false, missing: [], iterations: 0, spawnedChildren: [] });
    expect(spawnCalls).toHaveLength(0);
    expect(notifications).toHaveLength(0);
  });

  test("AC covered only by parent-comment evidence (form ii) → blocked: false", async () => {
    const ghBundle = makeCloseGateGh({
      650: {
        body: [
          "## Sub-issues",
          "- [x] #651",
          "",
          "## Acceptance",
          "",
          "- [ ] **AC#1** — first.",
          "- [ ] **AC#2** — by-comment only.",
        ].join("\n"),
        labels: ["type:plan", "area:plugin-brain-os"],
        comments: ["Acceptance verified: AC#2 — manual replay 2026-05-08, log at vault path"],
      },
      651: {
        body: "## Covers AC\n\n- AC#1\n\n## What to build",
        state: "CLOSED",
      },
    });
    const { deps } = makeCloseGateDeps(ghBundle);
    const result = await runCloseGate(650, deps);
    expect(result.blocked).toBe(false);
  });

  test("OPEN child with Covers AC does NOT count as form (i) evidence (Phase 1 sees AC missing)", async () => {
    // Child claims to cover AC#1 but is still OPEN — must NOT satisfy the gate.
    // Override spawn to no-op (PID stays "alive" forever) so Phase 2 starts
    // and we can assert Phase 1's missing list propagated into Phase 2 spawning.
    const ghBundle = makeCloseGateGh({
      660: {
        body: [
          "## Sub-issues",
          "- [ ] #661",
          "",
          "## Acceptance",
          "",
          "- [ ] **AC#1** — first.",
        ].join("\n"),
        labels: ["type:plan", "area:plugin-brain-os"],
      },
      661: {
        body: "## Covers AC\n\n- AC#1\n\n## What to build",
        state: "OPEN", // OPEN so form (i) must reject
      },
    });
    const bundle = makeCloseGateDeps(ghBundle);
    // Hook: every spawned worker auto-closes its own filed child WITHOUT
    // adding any Covers AC body content — so AC#1 stays missing, but at least
    // we don't hang on the poll. We assert Phase 1 saw AC#1 as missing by
    // observing that Phase 2 actually spawned a worker for AC#1.
    bundle.deps.spawn = {
      spawnWorker: (name, prompt, _logPath, cwd) => {
        const pid = 40000 + bundle.spawnCalls.length;
        bundle.pidsAlive.add(pid);
        bundle.spawnCalls.push({ name, prompt, cwd, pid });
        const m = prompt.match(/\/impl (\d+)/);
        if (m) {
          const child = Number(m[1]);
          ghBundle.bodies[child].state = "CLOSED";
          ghBundle.bodies[child].body = "## What to build\n\n(no Covers AC)";
          bundle.pidsAlive.delete(pid);
        }
        return { pid };
      },
      cleanupWorktree: () => {},
    };
    const result = await runCloseGate(660, bundle.deps);
    // AC#1 remained missing → Phase 2 fired → Phase 3 fallback (since spawned
    // children never produced evidence). Confirms OPEN child #661 was rejected.
    expect(result.blocked).toBe(true);
    expect(result.missing).toEqual([1]);
    expect(bundle.spawnCalls.length).toBeGreaterThanOrEqual(1);
    // Each spawn corresponds to AC#1 (only one missing AC).
    expect(bundle.spawnCalls[0].prompt).toMatch(/^\/impl \d+$/);
  });
});

describe("runCloseGate — Phase 2 (ralph auto-fill)", () => {
  test("missing AC → file evidence-gathering child + spawn /impl with parent's area cwd; child closes with form-(i) covers-ac evidence → blocked: false on iter 1", async () => {
    const ghBundle = makeCloseGateGh({
      700: {
        body: [
          "## Sub-issues",
          "- [ ] #701",
          "",
          "## Acceptance",
          "",
          "- [ ] **AC#10** — Performance instrumentation: live row.",
        ].join("\n"),
        labels: ["type:plan", "area:plugin-brain-os"],
      },
      701: {
        body: "## Covers AC\n\n## What to build",
        state: "CLOSED", // pure-component, doesn't cover AC#10
      },
    });
    // Hook: when worker spawned, simulate the worker closing the spawned child
    // synchronously via the alive-set so the gate's poll loop sees CLOSED on
    // its first iteration. The newly-filed child (next issue #) flips CLOSED.
    const bundle = makeCloseGateDeps(ghBundle);
    // Override spawnWorker to also flip the just-filed child to CLOSED
    bundle.deps.spawn = {
      spawnWorker: (name, prompt, _logPath, cwd) => {
        const pid = 50000 + bundle.spawnCalls.length;
        bundle.pidsAlive.add(pid);
        bundle.spawnCalls.push({ name, prompt, cwd, pid });
        // Extract child number from prompt "/impl <N>"
        const m = prompt.match(/\/impl (\d+)/);
        if (m) {
          const child = Number(m[1]);
          // Mark CLOSED so first poll cycle sees CLOSED.
          ghBundle.bodies[child].state = "CLOSED";
          // PID dies as well (worker cleanly exits) — alive=false gives "closed"
          // anyway because viewState=CLOSED takes precedence per decideWorkerAction.
          bundle.pidsAlive.delete(pid);
        }
        return { pid };
      },
      cleanupWorktree: (name, cwd) => {
        bundle.cleanupCalls.push({ name, cwd });
      },
    };
    const result = await runCloseGate(700, bundle.deps);
    expect(result.blocked).toBe(false);
    expect(bundle.spawnCalls).toHaveLength(1);
    expect(bundle.spawnCalls[0].prompt).toMatch(/^\/impl \d+$/);
    expect(bundle.spawnCalls[0].cwd).toBe("/Users/test/work/brain-os-plugin");
    expect(bundle.spawnCalls[0].name).toMatch(/^story-700-evidence-/);
    expect(ghBundle.createdIssues).toHaveLength(1);
    expect(ghBundle.createdIssues[0].opts.title).toBe("Evidence: AC#10 for parent #700");
    expect(ghBundle.createdIssues[0].opts.area).toBe("plugin-brain-os");
    expect(ghBundle.createdIssues[0].opts.owner).toBe("human");
    expect(ghBundle.createdIssues[0].opts.priority).toBe("p1");
    expect(ghBundle.createdIssues[0].opts.weight).toBe("heavy");
    expect(ghBundle.createdIssues[0].opts.status).toBe("ready");
  });

  test("missing AC → spawned child closes WITHOUT evidence comment OR Covers AC ID → still missing → goes to Phase 3 after 3 iters", async () => {
    const ghBundle = makeCloseGateGh({
      710: {
        body: [
          "## Sub-issues",
          "",
          "## Acceptance",
          "",
          "- [ ] **AC#1** — never gets evidence.",
        ].join("\n"),
        labels: ["type:plan", "area:plugin-brain-os"],
      },
    });
    const bundle = makeCloseGateDeps(ghBundle);
    bundle.deps.spawn = {
      spawnWorker: (name, prompt, _logPath, cwd) => {
        const pid = 60000 + bundle.spawnCalls.length;
        bundle.pidsAlive.add(pid);
        bundle.spawnCalls.push({ name, prompt, cwd, pid });
        const m = prompt.match(/\/impl (\d+)/);
        if (m) {
          const child = Number(m[1]);
          // Mark CLOSED but DROP the Covers AC content so Phase 1 still sees missing.
          ghBundle.bodies[child].state = "CLOSED";
          ghBundle.bodies[child].body = "## What to build\n\n(no Covers AC)";
          bundle.pidsAlive.delete(pid);
        }
        return { pid };
      },
      cleanupWorktree: () => {},
    };
    const result = await runCloseGate(710, bundle.deps);
    expect(result.blocked).toBe(true);
    expect(result.missing).toEqual([1]);
    expect(result.iterations).toBe(3);
    // Three iters × one missing AC = 3 spawns
    expect(bundle.spawnCalls).toHaveLength(3);
    expect(bundle.notifications.some((m) => m.includes("Parent #710") && m.includes("AC#1"))).toBe(
      true,
    );
    // HITL comment posted to parent (the gate's terminal side effect — the
    // impl-story.log row is written by writeImplStoryLogRow at runStory level,
    // tested in the "runStory — Gate C wiring" suite).
    expect(ghBundle.bodies[710].comments?.some((c) => c.includes("Acceptance gate failed"))).toBe(
      true,
    );
  });
});

describe("runCloseGate — parent-area edge cases", () => {
  test("parent without area:* label → skip Phase 2, jump to Phase 3", async () => {
    const ghBundle = makeCloseGateGh({
      730: {
        body: ["## Sub-issues", "", "## Acceptance", "", "- [ ] **AC#1** — first."].join("\n"),
        labels: ["type:plan"], // no area
      },
    });
    const bundle = makeCloseGateDeps(ghBundle);
    const result = await runCloseGate(730, bundle.deps);
    expect(result.blocked).toBe(true);
    expect(bundle.spawnCalls).toHaveLength(0);
    expect(ghBundle.createdIssues).toHaveLength(0);
    // HITL still fires
    expect(bundle.notifications.some((m) => m.includes("Parent #730"))).toBe(true);
  });

  test("parent with unknown area:* → skip Phase 2, jump to Phase 3", async () => {
    const ghBundle = makeCloseGateGh({
      740: {
        body: ["## Sub-issues", "", "## Acceptance", "", "- [ ] **AC#1** — first."].join("\n"),
        labels: ["type:plan", "area:zzz-not-mapped"],
      },
    });
    const bundle = makeCloseGateDeps(ghBundle);
    const result = await runCloseGate(740, bundle.deps);
    expect(result.blocked).toBe(true);
    expect(bundle.spawnCalls).toHaveLength(0);
  });
});

describe("runCloseGate — partial recovery across iters", () => {
  test("iter 1 closes one of two missing ACs; iter 2 resolves the second → blocked: false", async () => {
    // Fixture: parent missing AC#1 + AC#2.
    // Spawn handler: closes filed children. First filed child gets a Covers AC
    // matching its target. Second filed child (created in same iter for AC#2)
    // intentionally omits Covers AC, so AC#2 is still missing after iter 1.
    // Iter 2's filed child for AC#2 includes Covers AC → both resolved.
    const ghBundle = makeCloseGateGh({
      800: {
        body: [
          "## Sub-issues",
          "",
          "## Acceptance",
          "",
          "- [ ] **AC#1** — first.",
          "- [ ] **AC#2** — second.",
        ].join("\n"),
        labels: ["type:plan", "area:plugin-brain-os"],
      },
    });
    const bundle = makeCloseGateDeps(ghBundle);
    let iterCount = 0;
    bundle.deps.spawn = {
      spawnWorker: (name, prompt, _logPath, cwd) => {
        const pid = 80000 + bundle.spawnCalls.length;
        bundle.pidsAlive.add(pid);
        bundle.spawnCalls.push({ name, prompt, cwd, pid });
        const m = prompt.match(/\/impl (\d+)/);
        if (m) {
          const child = Number(m[1]);
          // The body filed for this child is in ghBundle.bodies[child].body —
          // contains "## Covers AC\n\n- AC#N". When we close, *keep* the body
          // intact so form (i) evidence works for AC#N. For iter 1's AC#2
          // child only (second spawn this batch), strip the Covers AC.
          if (iterCount === 0 && bundle.spawnCalls.length === 2) {
            ghBundle.bodies[child].body = "## What to build\n\n(no Covers AC)";
          }
          ghBundle.bodies[child].state = "CLOSED";
          bundle.pidsAlive.delete(pid);
        }
        return { pid };
      },
      cleanupWorktree: () => {},
    };
    // Hook re-check: after iter 1's poll loop, bump iterCount so iter 2's
    // child for AC#2 keeps Covers AC intact.
    const origViewFull = bundle.deps.gh.viewFull.bind(bundle.deps.gh);
    let parentFetchCount = 0;
    bundle.deps.gh = {
      ...bundle.deps.gh,
      viewFull: async (n) => {
        if (n === 800) {
          parentFetchCount++;
          // recheck() is called once at start, then once after each iter's
          // poll loop. After recheck #2 (start of iter 2), advance iterCount.
          if (parentFetchCount === 2) iterCount = 1;
        }
        return origViewFull(n);
      },
    };
    const result = await runCloseGate(800, bundle.deps);
    expect(result.blocked).toBe(false);
    // 2 spawns iter 1 + 1 spawn iter 2 (only AC#2 still missing) = 3
    expect(bundle.spawnCalls).toHaveLength(3);
  });
});

// =========================================================================
// End-to-end replay — live-AC child whose worker exits with verified:false
// after 3 advisor rejections.  Demonstrates the full wiring: orchestrator
// flags worker DEAD, reads per-child result file, emits hitl-fallback row.
// Maps to acceptance criterion: "Replay test in commit message".
// =========================================================================

describe("runStory — replay: live-AC child + advisor 3x reject → hitl-fallback row", () => {
  test("end-to-end: dead worker + result file w/ 3 rejections → row=hitl-fallback, counters aggregated", async () => {
    const PARENT = 196;
    const CHILD = 210;
    const PARENT_BODY = [
      "## Acceptance",
      "- [ ] **AC#1** — Live one. Verified by replay with live integration.",
    ].join("\n");
    const CHILD_BODY = `## Parent\n\n- ai-brain#${PARENT}\n\n## Covers AC\n\n- AC#1\n\n## What to build\n`;

    let pollCount = 0;
    const aliveStates = [true, false]; // worker dies after first poll
    const deps: OrchestratorDeps = {
      gh: {
        viewBody: async (n) => (n === PARENT ? `- [ ] #${CHILD}` : ""),
        viewFull: async (n) => {
          if (n === PARENT) {
            return {
              title: "Story parent",
              labels: ["type:plan", "owner:human", "status:in-progress", "area:plugin-brain-os"],
              body: `${PARENT_BODY}\n\n- [ ] #${CHILD}`,
              state: "OPEN",
            };
          }
          return {
            title: "Live-AC child",
            labels: ["status:ready", "owner:bot", "area:plugin-brain-os"],
            body: CHILD_BODY,
            state: "OPEN",
          };
        },
        viewState: async () => "OPEN",  // child never closes — worker died after recording its rejection
        editBody: async () => {},
        closeIssue: async () => {},
        relabelHuman: async () => {},
      },
      spawn: {
        spawnWorker: () => ({ pid: 12345 }),
        cleanupWorktree: () => {},
      },
      proc: {
        isAlive: () => {
          pollCount++;
          return aliveStates[Math.min(pollCount - 1, aliveStates.length - 1)];
        },
      },
      notify: { notify: () => {} },
      logger: { log: () => {} },
      status: { write: () => {} },
      pollIntervalMs: 1,
      workerLogDir: "/tmp/run-story-replay",
      areaMap: defaultAreaMap("/Users/test"),
      childResults: {
        async read(parent, child) {
          if (parent === PARENT && child === CHILD) {
            return {
              parent,
              child,
              verified: false,
              tddRunCount: 3,
              advisorCalls: 3,
              advisorRejections: 3,
              lastFailure: "advisor: integration test mocks live API",
              lastVerdict: "AC not met: integration test mocks live API",
              ts: "2026-05-08T00:00:00Z",
            };
          }
          return null;
        },
      },
      implStoryLog: {
        append: async (line) => {
          replayRows.push(line);
        },
      },
      now: () => Date.now(),  // real clock; wall-time content not asserted exactly
    };

    const replayRows: string[] = [];
    // Replace the implStoryLog stub with one capturing into replayRows. Since
    // bun test doesn't allow forward-reference of replayRows in the literal
    // above without hoisting, inject via Object.assign.
    Object.assign(deps.implStoryLog as object, {
      append: async (line: string) => {
        replayRows.push(line);
      },
    });

    const result = await runStory(PARENT, 1, deps);

    // 1. Worker process flagged DEAD → child added to failed, NOT closed.
    expect(result.failed).toEqual([CHILD]);
    expect(result.closed).toEqual([]);

    // 2. Exactly one impl-story.log row written.
    expect(replayRows).toHaveLength(1);

    // 3. Row schema: 8 TSV columns.
    const cols = replayRows[0].split("\t");
    expect(cols).toHaveLength(8);

    // 4. Counters aggregated from result file (3 advisor calls, 3 rejections).
    expect(cols[1]).toBe(String(PARENT));
    expect(cols[2]).toBe("1");                  // child_count
    expect(cols[3]).toBe("1");                  // live_ac_child_count
    expect(cols[4]).toBe("3");                  // advisor_calls
    expect(cols[5]).toBe("3");                  // advisor_rejections
    expect(cols[7]).toBe("hitl-fallback");      // result enum
  });
});

// =========================================================================
// runStory + Gate C wiring — issue #202 AC#3
// =========================================================================

describe("runStory — Gate C wiring", () => {
  test("close-gate blocked → closeIssue NOT called, parent left OPEN, log row=hitl-fallback", async () => {
    let closeIssueCalls = 0;
    const notifications: string[] = [];
    const logs: string[] = [];
    const lines: string[] = [];

    // Parent has one already-CLOSED child (so drainer immediately reaches
    // close-decision branch with no failures), but no AC evidence at all
    // for the lone AC#1 — Gate C must block.
    const parentBody = [
      "## Sub-issues",
      "- [x] #1100",
      "",
      "## Acceptance",
      "",
      "- [ ] **AC#1** — never satisfied.",
    ].join("\n");

    const deps: OrchestratorDeps = {
      gh: {
        viewBody: async () => parentBody,
        viewFull: async (n) => {
          if (n === 1099) {
            return {
              title: "Story parent",
              labels: ["type:plan", "owner:bot", "area:plugin-brain-os"],
              body: parentBody,
              state: "OPEN",
            };
          }
          if (n === 1100) {
            return {
              title: "child",
              labels: ["area:plugin-brain-os", "owner:bot"],
              body: "## Covers AC\n\n## What to build",
              state: "CLOSED",
            };
          }
          throw new Error(`unmocked viewFull(${n})`);
        },
        viewState: async () => "OPEN",
        editBody: async () => {},
        closeIssue: async () => {
          closeIssueCalls++;
        },
        relabelHuman: async () => {},
        listIssues: async () => [],
        claim: async () => {},
        addComment: async () => {},
        viewComments: async () => [],
        // Phase 2 spawn fails to file → gate jumps straight to Phase 3.
        createIssue: async () => {
          throw new Error("createIssue intentionally throws so Phase 2 short-circuits to Phase 3");
        },
      },
      spawn: {
        spawnWorker: () => ({ pid: 1 }),
        cleanupWorktree: () => {},
      },
      proc: { isAlive: () => true },
      notify: { notify: (m) => notifications.push(m) },
      logger: { log: (m) => logs.push(m) },
      status: { write: () => {} },
      pollIntervalMs: 1,
      workerLogDir: "/tmp/run-story-test",
      areaMap: defaultAreaMap("/Users/test"),
      childResults: { read: async () => null },
      implStoryLog: { append: async (line) => { lines.push(line); } },
    };

    const result = await runStory(1099, 3, deps);

    expect(closeIssueCalls).toBe(0);
    expect(result.failed).toEqual([]);
    expect(notifications.some((m) => m.includes("Parent #1099") && m.includes("AC#1"))).toBe(true);
    expect(logs.some((l) => l.includes("close gate BLOCKED"))).toBe(true);
    // impl-story.log row written via deriveResult → hitl-fallback (gateBlocked path)
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("hitl-fallback");
  });

  test("close-gate satisfied → closeIssue called, success notify fired, log row=pass", async () => {
    let closeIssueCalls = 0;
    const notifications: string[] = [];
    const lines: string[] = [];

    const parentBody = [
      "## Sub-issues",
      "- [x] #1200",
      "",
      "## Acceptance",
      "",
      "- [ ] **AC#1** — covered by #1200.",
    ].join("\n");

    const deps: OrchestratorDeps = {
      gh: {
        viewBody: async () => parentBody,
        viewFull: async (n) => {
          if (n === 1199) {
            return {
              title: "Story parent",
              labels: ["type:plan", "owner:bot", "area:plugin-brain-os"],
              body: parentBody,
              state: "OPEN",
            };
          }
          if (n === 1200) {
            return {
              title: "covering child",
              labels: ["area:plugin-brain-os", "owner:bot"],
              body: "## Covers AC\n\n- AC#1\n\n## What to build",
              state: "CLOSED",
            };
          }
          throw new Error(`unmocked viewFull(${n})`);
        },
        viewState: async (n) => (n === 1199 ? "OPEN" : "CLOSED"),
        editBody: async () => {},
        closeIssue: async () => {
          closeIssueCalls++;
        },
        relabelHuman: async () => {},
        listIssues: async () => [],
        claim: async () => {},
        addComment: async () => {},
        viewComments: async () => [],
        createIssue: async () => {
          throw new Error("createIssue must not be called when gate passes");
        },
      },
      spawn: {
        spawnWorker: () => ({ pid: 1 }),
        cleanupWorktree: () => {},
      },
      proc: { isAlive: () => true },
      notify: { notify: (m) => notifications.push(m) },
      logger: { log: () => {} },
      status: { write: () => {} },
      pollIntervalMs: 1,
      workerLogDir: "/tmp/run-story-test",
      areaMap: defaultAreaMap("/Users/test"),
      childResults: { read: async () => null },
      implStoryLog: { append: async (line) => { lines.push(line); } },
    };

    await runStory(1199, 3, deps);

    expect(closeIssueCalls).toBe(1);
    expect(notifications.some((m) => m.includes("Story #1199 complete"))).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("pass");
  });
});
