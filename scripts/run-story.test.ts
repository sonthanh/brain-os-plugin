import { test, expect, describe } from "bun:test";
import {
  parseChecklist,
  parseBlockers,
  parseOwner,
  tickChecklist,
  clampParallel,
  computeReady,
  promoteWaiters,
  type Issue,
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
      { number: 146, deps: [], owner: "bot", state: "OPEN", title: "first" },
      { number: 147, deps: [], owner: "bot", state: "OPEN", title: "second" },
    ];
    expect(computeReady(issues, new Set())).toEqual([146, 147]);
  });

  test("excludes children whose deps are still open", () => {
    const issues: Issue[] = [
      { number: 146, deps: [], owner: "bot", state: "OPEN", title: "first" },
      { number: 149, deps: [147], owner: "bot", state: "OPEN", title: "blocked" },
    ];
    expect(computeReady(issues, new Set())).toEqual([146]);
  });

  test("includes children whose deps are all closed", () => {
    const issues: Issue[] = [
      { number: 149, deps: [147, 148], owner: "bot", state: "OPEN", title: "needs deps" },
    ];
    const closed = new Set([147, 148]);
    expect(computeReady(issues, closed)).toEqual([149]);
  });

  test("excludes children that are themselves CLOSED", () => {
    const issues: Issue[] = [
      { number: 146, deps: [], owner: "bot", state: "CLOSED", title: "done" },
    ];
    expect(computeReady(issues, new Set([146]))).toEqual([]);
  });
});

describe("promoteWaiters", () => {
  test("promotes when all deps just became closed", () => {
    const issues: Issue[] = [
      { number: 149, deps: [147, 148], owner: "bot", state: "OPEN", title: "x" },
    ];
    const closed = new Set([147, 148]);
    expect(promoteWaiters(issues, 148, closed, new Set([149]))).toEqual([149]);
  });

  test("does not promote if other deps still open", () => {
    const issues: Issue[] = [
      { number: 149, deps: [147, 148], owner: "bot", state: "OPEN", title: "x" },
    ];
    const closed = new Set([147]);
    expect(promoteWaiters(issues, 147, closed, new Set([149]))).toEqual([]);
  });

  test("does not promote children not in pending set (already running/done)", () => {
    const issues: Issue[] = [
      { number: 149, deps: [147], owner: "bot", state: "OPEN", title: "x" },
    ];
    const closed = new Set([147]);
    expect(promoteWaiters(issues, 147, closed, new Set())).toEqual([]);
  });

  test("promotes multiple waiters when shared dep closes", () => {
    const issues: Issue[] = [
      { number: 149, deps: [147], owner: "bot", state: "OPEN", title: "x" },
      { number: 150, deps: [147], owner: "bot", state: "OPEN", title: "y" },
    ];
    const closed = new Set([147]);
    expect(promoteWaiters(issues, 147, closed, new Set([149, 150])).sort()).toEqual([149, 150]);
  });
});
