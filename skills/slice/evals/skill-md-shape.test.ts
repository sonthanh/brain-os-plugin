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

const STEP_2_4 = section(/### 2\.4\. File parent story issue[\s\S]*?(?=### 2\.5\.)/);
const STEP_2_5 = section(/### 2\.5\. AC coverage gate[\s\S]*?(?=### 2\.6\.)/);
const STEP_6 = section(/### 6\. Create child issues[\s\S]*?(?=### 7\.)/);
const STEP_7 = section(/### 7\. Edit parent body[\s\S]*?(?=### 8\.)/);
const STEP_8 = section(/### 8\. Report back[\s\S]*?(?=## When NOT)/);

const STEP_1_6 = section(/### 1\.6\. E2E AC existence guardrail[\s\S]*?(?=### 2\.)/);
const STEP_4_5 = section(/### 4\.5\. Rung-0 e2e ordering[\s\S]*?(?=### 5\.)/);
const ANTI_PATTERNS = section(/## Anti-Patterns[\s\S]*?(?=## Workflow)/);
const CHANGELOG = section(/## Changelog[\s\S]*$/);

describe("slice SKILL.md — covers AC#5 of story #219", () => {
  test("Step 2.4 captures PARENT_NODE_ID for use at Step 6", () => {
    expect(STEP_2_4).toMatch(/PARENT_NODE_ID=\$\(/);
    expect(STEP_2_4).toMatch(/--json id/);
  });

  test("Step 2.4 parent body Acceptance template uses bullet AC + evidence-link annotation", () => {
    expect(STEP_2_4).toContain("**AC#1**");
    expect(STEP_2_4).toMatch(
      /- \[ \] \*\*AC#1\*\* — .+ — \[evidence ↗\]\(#issuecomment-PLACEHOLDER\)/,
    );
  });

  test("Step 6 calls addSubIssue GraphQL mutation per child filed", () => {
    expect(STEP_6).toContain("addSubIssue");
    expect(STEP_6).toMatch(/gh api graphql/);
    expect(STEP_6).toContain("CHILD_NODE_ID");
  });

  test("Step 6 notes parent node ID was captured at Step 2.4", () => {
    expect(STEP_6).toMatch(/parent node ID.*Step 2\.4/);
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

describe("slice SKILL.md — covers AC#4 + AC#5 of story #253 (issue #258)", () => {
  test("Edit 1: P2 audit gate (Step 1.5) removed", () => {
    expect(SKILL_MD).not.toMatch(/^### 1\.5\. P2 audit gate/m);
    expect(SKILL_MD).not.toMatch(/Skill: audit\s*\nargs: p2/);
  });

  test("Edit 1: P1 audit gate (old Step 2.4) removed", () => {
    expect(SKILL_MD).not.toMatch(/^### 2\.4\. P1 audit gate/m);
    expect(SKILL_MD).not.toMatch(/Skill: audit\s*\nargs: p1/);
  });

  test("Edit 1: anti-pattern reframed from 'skip the P1/P2 gates' to 'slice unaudited grills'", () => {
    expect(ANTI_PATTERNS).not.toMatch(/DO NOT skip the P1\/P2 audit gates/);
    expect(ANTI_PATTERNS).toMatch(
      /DO NOT slice grills that haven't been audited at \/grill end-step/,
    );
    expect(ANTI_PATTERNS).toMatch(/2026-05-06/);
  });

  test("Edit 1: workflow body has no orphan refs to deleted gates outside changelog", () => {
    const WORKFLOW = section(/## Workflow[\s\S]*?(?=## When NOT)/);
    expect(WORKFLOW).not.toMatch(/Same ternary-to-binary contract as Step 1\.5/);
    expect(WORKFLOW).not.toMatch(/audit gates \(§§ 1\.5, 2\.4\)/);
    expect(WORKFLOW).not.toMatch(/Steps 1\.5 \+ 2\.4/);
  });

  test("Edit 1: changelog documents P1+P2 retirement and points at /grill end-step audit", () => {
    expect(CHANGELOG).toMatch(/2026-05-06/);
    expect(CHANGELOG).toMatch(/P1\+P2 hard gates retired/);
    expect(CHANGELOG).toMatch(/\/grill end-step audit/);
    expect(CHANGELOG).toMatch(/ai-brain#253/);
  });

  test("Edit 1: 2.x renumber documented in changelog", () => {
    expect(CHANGELOG).toMatch(/Renumbered/);
    expect(CHANGELOG).toMatch(/2\.5\/2\.6\/2\.7 → 2\.4\/2\.5\/2\.6/);
  });

  test("Edit 3: Step 1.6 E2E AC existence guardrail exists with required behaviors", () => {
    expect(STEP_1_6).toMatch(/### 1\.6\. E2E AC existence guardrail/);
    expect(STEP_1_6).toMatch(/\(LIVE E2E\)/);
    expect(STEP_1_6).toMatch(/NOT-architectural/);
    expect(STEP_1_6).toMatch(/status:reflection/);
    expect(STEP_1_6).toMatch(/story-tier grill missing e2e AC/);
    expect(STEP_1_6).toMatch(/ABORT/);
    expect(STEP_1_6).toMatch(/deterministic/);
  });

  test("Edit 2: Step 4.5 Rung-0 e2e ordering exists with required behaviors", () => {
    expect(STEP_4_5).toMatch(/### 4\.5\. Rung-0 e2e ordering/);
    expect(STEP_4_5).toMatch(/\(LIVE E2E\)/);
    expect(STEP_4_5).toMatch(/Covers AC/);
    expect(STEP_4_5).toMatch(/rung:0/);
    expect(STEP_4_5).toMatch(/None — rung-0/);
    expect(STEP_4_5).toMatch(/blocked by/i);
    expect(STEP_4_5).toMatch(/most-architectural|most architectural/);
    expect(STEP_4_5).toMatch(/deterministic/);
  });

  test("Edit 2: Step 4.5 references Step 1.6 / no-e2e bypass interlock", () => {
    expect(STEP_4_5).toMatch(/Step 1\.6|NOT-architectural/);
  });
});
