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
  type Issue,
  type SpawnClient,
  type Logger,
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
      "- [ ] ai-brain#156 — Rename /reorg",
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
