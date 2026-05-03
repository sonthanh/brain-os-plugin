import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const SKILL_MD = readFileSync(
  join(import.meta.dir, "..", "SKILL.md"),
  "utf-8",
);

function section(re: RegExp): string {
  return SKILL_MD.match(re)?.[0] ?? "";
}

const STEP_2_5 = section(/### 2\.5\. File parent story issue[\s\S]*?(?=### 2\.6\.)/);
const STEP_6 = section(/### 6\. Create child issues[\s\S]*?(?=### 7\.)/);
const STEP_7 = section(/### 7\. Edit parent body[\s\S]*?(?=### 8\.)/);
const STEP_8 = section(/### 8\. Report back[\s\S]*?(?=## When NOT)/);

describe("slice SKILL.md — covers AC#5 of story #219", () => {
  test("Step 2.5 captures PARENT_NODE_ID for use at Step 6", () => {
    expect(STEP_2_5).toMatch(/PARENT_NODE_ID=\$\(/);
    expect(STEP_2_5).toMatch(/--json id/);
  });

  test("Step 2.5 parent body Acceptance template uses bullet AC + evidence-link annotation", () => {
    expect(STEP_2_5).toContain("**AC#1**");
    expect(STEP_2_5).toMatch(
      /- \[ \] \*\*AC#1\*\* — .+ — \[evidence ↗\]\(#issuecomment-PLACEHOLDER\)/,
    );
  });

  test("Step 6 calls addSubIssue GraphQL mutation per child filed", () => {
    expect(STEP_6).toContain("addSubIssue");
    expect(STEP_6).toMatch(/gh api graphql/);
    expect(STEP_6).toContain("CHILD_NODE_ID");
  });

  test("Step 6 notes parent node ID was captured at Step 2.5", () => {
    expect(STEP_6).toMatch(/parent node ID.*Step 2\.5/);
  });

  test("Step 7 Sub-issues template is list-only (no checkbox)", () => {
    expect(STEP_7).toContain("- #<child-1-N>");
    expect(STEP_7).not.toMatch(/- \[ \] ai-brain#<child-\d-N>/);
  });

  test("Step 7 documents AC-to-child mapping derived from each child's `## Covers AC`", () => {
    expect(STEP_7).toContain("Covers AC");
    expect(STEP_7).toContain("(also covered by");
  });

  test("Step 7 rationale reflects GraphQL subIssues discovery, not body checklist parse", () => {
    expect(STEP_7).toMatch(/subIssues|viewSubIssues/);
    expect(STEP_7).not.toMatch(
      /parses exactly this checklist to discover children/,
    );
  });

  test("Step 8 report-back template appends `Next: /impl story <parent-N>`", () => {
    expect(STEP_8).toContain("Next: /impl story <parent-N>");
  });
});
