import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const SKILL_MD = readFileSync(join(import.meta.dir, "..", "SKILL.md"), "utf-8");
const WORKFLOW = readFileSync(
  join(import.meta.dir, "..", "references", "autodev.workflow.js"),
  "utf-8",
);
const EVALS = JSON.parse(
  readFileSync(join(import.meta.dir, "evals.json"), "utf-8"),
);

function section(re: RegExp): string {
  return SKILL_MD.match(re)?.[0] ?? "";
}

describe("autodev SKILL.md — shape + load-bearing behaviors", () => {
  test("frontmatter declares name + a proof/auto-grill/afk-differentiated description", () => {
    expect(SKILL_MD).toMatch(/^name: autodev$/m);
    const desc = section(/description:.*$/m);
    expect(desc).toMatch(/proof/i);
    expect(desc).toMatch(/auto-grill/i);
    expect(desc).toMatch(/\/afk/);
  });

  test("auto_improve is disabled (orchestrator over an adversarial grill)", () => {
    expect(SKILL_MD).toMatch(/^auto_improve: false/m);
  });

  test("has the composition table covering all four stages", () => {
    for (const stage of ["Grill", "Slice", "Impl", "Proof"]) {
      expect(SKILL_MD).toContain(`| ${stage}`);
    }
  });

  test("Autonomy model section documents escalate-not-break + the four seam cases", () => {
    const seam = section(/## Autonomy model[\s\S]*?(?=## Config)/);
    expect(seam).toMatch(/escalate-not-break/);
    expect(seam).toMatch(/Grounded decisions/);
    expect(seam).toMatch(/Zero grounded decisions/);
    expect(seam).toMatch(/Reflection-tier/);
    expect(seam).toMatch(/K=3/);
    expect(seam).toMatch(/never push broken work/);
  });

  test("Usage documents --dry-run and an issue-number form", () => {
    const usage = section(/## Usage[\s\S]*?(?=## Autonomy)/);
    expect(usage).toMatch(/--dry-run/);
    expect(usage).toMatch(/\/autodev #N/);
  });

  test("Phase 2 passes args as a real JSON object and lists the contract keys", () => {
    const p2 = section(/## Phase 2[\s\S]*?(?=## Phase 3)/);
    expect(p2).toMatch(/never a JSON string/);
    for (const k of ["goal", "dryRun", "pluginRoot", "designRef"]) {
      expect(p2).toContain(k);
    }
    expect(p2).toMatch(/scriptPath.*autodev\.workflow\.js/);
  });

  test("Outcome log row schema includes the verdict + grounding + escalation fields", () => {
    const log = section(/## Outcome log[\s\S]*$/);
    expect(log).toContain("daily/skill-outcomes/autodev.log");
    expect(log).toMatch(/verdict=\{PROVEN\|PARTIAL\|UNPROVEN\}/);
    expect(log).toMatch(/resolved=R gaps=G/);
  });

  test("every evals.json `expect` substring is actually present in SKILL.md", () => {
    for (const e of EVALS) {
      expect(SKILL_MD.includes(e.expect)).toBe(true);
    }
  });
});

describe("autodev.workflow.js — engine contract", () => {
  test("declares the five phases in meta", () => {
    for (const p of ["Grill", "Slice", "Implement", "Evaluate", "Report"]) {
      expect(WORKFLOW).toContain(`title: '${p}'`);
    }
  });

  test("implements the escalate-not-break seam (gaps → HITL, reflection stop, all-gaps no-op)", () => {
    expect(WORKFLOW).toMatch(/reflection-tier/);
    expect(WORKFLOW).toMatch(/all-gaps/);
    expect(WORKFLOW).toMatch(/gapIssuePrompt/);
    expect(WORKFLOW).toMatch(/storyTier/);
  });

  test("has a deterministic AC-coverage gate before implement", () => {
    expect(WORKFLOW).toMatch(/AC-coverage gate/);
    expect(WORKFLOW).toMatch(/uncovered/);
    expect(WORKFLOW).toMatch(/no-live-e2e-ac/);
  });

  test("evaluator regenerate loop caps at K=3 then escalates", () => {
    expect(WORKFLOW).toMatch(/const K = 3/);
    expect(WORKFLOW).toMatch(/escalatePrompt/);
    expect(WORKFLOW).toMatch(/implementWithEvaluator/);
  });

  test("Report phase shells proof-report.ts in --build-results mode (SSOT renderer)", () => {
    expect(WORKFLOW).toMatch(/proof-report\.ts/);
    expect(WORKFLOW).toMatch(/--build-results/);
  });

  test("DRY mode short-circuits filing and implementation", () => {
    expect(WORKFLOW).toMatch(/DRY-parent/);
    expect(WORKFLOW).toMatch(/pass\(dry\)/);
  });

  test("all agents pinned to Opus", () => {
    expect(WORKFLOW).toMatch(/const MODEL = 'opus'/);
    expect(WORKFLOW).not.toMatch(/model: 'sonnet'/);
  });
});
