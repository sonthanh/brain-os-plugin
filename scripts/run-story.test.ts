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
  type Issue,
  type SpawnClient,
  type Logger,
  type OrchestratorDeps,
  type GhClient,
  type State,
} from "./run-story.ts";

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
