import { test, expect, describe } from "bun:test";
import { tickFromComments } from "./tick-parent-ac-from-comments.ts";

describe("tickFromComments", () => {
  test("ticks every AC referenced by an evidence comment", () => {
    const body = [
      "## Acceptance",
      "",
      "- [ ] **AC#1** — first criterion text.",
      "- [ ] **AC#2** — second criterion text.",
      "- [ ] **AC#3** — third criterion text.",
    ].join("\n");
    const comments = [
      "Acceptance verified: AC#1 — replay 2026-05-08 commit a1b2c3d4",
      "Acceptance verified: AC#3 — bun test suite green; 47 pass, 0 fail",
    ];
    const result = tickFromComments(body, comments);
    expect(result.body).toContain("- [x] **AC#1** — first criterion text.");
    expect(result.body).toContain("- [ ] **AC#2** — second criterion text.");
    expect(result.body).toContain("- [x] **AC#3** — third criterion text.");
    expect(result.tickedAcs.sort((a, b) => a - b)).toEqual([1, 3]);
    expect(result.notFoundAcs).toEqual([]);
  });

  test("idempotent — already-ticked AC stays ticked, no false positive in tickedAcs", () => {
    const body = [
      "- [x] **AC#1** — already ticked.",
      "- [ ] **AC#2** — still open.",
    ].join("\n");
    const comments = [
      "Acceptance verified: AC#1 — first evidence",
      "Acceptance verified: AC#2 — second evidence",
    ];
    const result = tickFromComments(body, comments);
    expect(result.body).toContain("- [x] **AC#1** — already ticked.");
    expect(result.body).toContain("- [x] **AC#2** — still open.");
    expect(result.tickedAcs).toEqual([2]);
    expect(result.notFoundAcs).toEqual([]);
  });

  test("re-running on output of first run is a no-op (full idempotence)", () => {
    const body = [
      "- [ ] **AC#1** — first.",
      "- [ ] **AC#2** — second.",
    ].join("\n");
    const comments = [
      "Acceptance verified: AC#1 — e1",
      "Acceptance verified: AC#2 — e2",
    ];
    const r1 = tickFromComments(body, comments);
    const r2 = tickFromComments(r1.body, comments);
    expect(r2.body).toBe(r1.body);
    expect(r2.tickedAcs).toEqual([]);
    expect(r2.notFoundAcs).toEqual([]);
  });

  test("AC referenced in comments but absent from body → notFoundAcs (warn signal)", () => {
    const body = "- [ ] **AC#1** — only AC in body.";
    const comments = [
      "Acceptance verified: AC#1 — present",
      "Acceptance verified: AC#99 — never declared in body",
    ];
    const result = tickFromComments(body, comments);
    expect(result.body).toContain("- [x] **AC#1** — only AC in body.");
    expect(result.tickedAcs).toEqual([1]);
    expect(result.notFoundAcs).toEqual([99]);
  });

  test("dedupes AC IDs that appear in multiple comments", () => {
    const body = "- [ ] **AC#1** — only AC.";
    const comments = [
      "Acceptance verified: AC#1 — first attempt",
      "Acceptance verified: AC#1 — second attempt (operator re-posted)",
    ];
    const result = tickFromComments(body, comments);
    expect(result.body).toContain("- [x] **AC#1**");
    expect(result.tickedAcs).toEqual([1]);
  });

  test("ignores comments with no Acceptance verified line", () => {
    const body = "- [ ] **AC#1** — only AC.";
    const comments = [
      "Just a regular comment with no evidence pattern",
      "Acceptance verified: AC#1 — actual evidence",
    ];
    const result = tickFromComments(body, comments);
    expect(result.tickedAcs).toEqual([1]);
  });

  test("ignores hyphen variant in comment (regex demands em-dash)", () => {
    const body = "- [ ] **AC#1** — only AC.";
    const comments = ["Acceptance verified: AC#1 - hyphen not em-dash"];
    const result = tickFromComments(body, comments);
    expect(result.body).toBe(body);
    expect(result.tickedAcs).toEqual([]);
    expect(result.notFoundAcs).toEqual([]);
  });

  test("returns AC IDs sorted ascending in tickedAcs", () => {
    const body = [
      "- [ ] **AC#5** — five.",
      "- [ ] **AC#1** — one.",
      "- [ ] **AC#3** — three.",
    ].join("\n");
    const comments = [
      "Acceptance verified: AC#5 — e5",
      "Acceptance verified: AC#1 — e1",
      "Acceptance verified: AC#3 — e3",
    ];
    const result = tickFromComments(body, comments);
    expect(result.tickedAcs).toEqual([1, 3, 5]);
  });
});
