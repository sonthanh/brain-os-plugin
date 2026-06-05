import { describe, expect, test } from "bun:test";
import { buildCloseRef, buildSquashSubject, parseLinkedIssues } from "./pr-close.ts";

describe("parseLinkedIssues", () => {
  test("bare #N (no repo prefix)", () => {
    expect(parseLinkedIssues("Closes #139")).toEqual([{ repo: null, num: 139 }]);
  });
  test("cross-repo owner/repo#N", () => {
    expect(parseLinkedIssues("Closes sonthanh/ai-brain#139")).toEqual([
      { repo: "sonthanh/ai-brain", num: 139 },
    ]);
  });
  test("Fixes / Resolves keywords, with and without a colon", () => {
    expect(parseLinkedIssues("Fixes #5\nResolves: #10")).toEqual([
      { repo: null, num: 5 },
      { repo: null, num: 10 },
    ]);
  });
  test("dedupes repeated references to the same issue", () => {
    expect(parseLinkedIssues("Closes #7 and also closes #7")).toEqual([{ repo: null, num: 7 }]);
  });
  test("ignores #N that isn't preceded by a close keyword", () => {
    expect(parseLinkedIssues("See #42 for context; closes the door near ticket #5")).toEqual([]);
  });
  test("empty body yields no references", () => {
    expect(parseLinkedIssues("")).toEqual([]);
  });
});

describe("buildCloseRef — the cross-repo prefix is load-bearing", () => {
  test("a bare issue gets the tracker prefix (never a bare #N that no-ops)", () => {
    expect(buildCloseRef("sonthanh/ai-brain", [{ repo: null, num: 139 }])).toBe(
      "Closes sonthanh/ai-brain#139",
    );
  });
  test("an explicit repo from the body wins over the tracker default", () => {
    expect(buildCloseRef("sonthanh/ai-brain", [{ repo: "owner/other", num: 3 }])).toBe(
      "Closes owner/other#3",
    );
  });
  test("multiple issues → one Closes line each", () => {
    expect(
      buildCloseRef("t/r", [
        { repo: null, num: 1 },
        { repo: null, num: 2 },
      ]),
    ).toBe("Closes t/r#1\nCloses t/r#2");
  });
  test("output never contains a bare #N (always carries a repo prefix)", () => {
    const out = buildCloseRef("t/r", [{ repo: null, num: 9 }]);
    expect(out).toContain("t/r#9");
    expect(out).not.toMatch(/(?:^|\s)#9\b/);
  });
});

describe("buildSquashSubject — PR title verbatim", () => {
  test("a plain title is unchanged", () => {
    expect(buildSquashSubject("feat(x): do the thing")).toBe("feat(x): do the thing");
  });
  test("strips a trailing (#N) that gh would otherwise duplicate", () => {
    expect(buildSquashSubject("feat(x): do the thing (#42)")).toBe("feat(x): do the thing");
  });
  test("trims surrounding whitespace", () => {
    expect(buildSquashSubject("  hello  ")).toBe("hello");
  });
});
