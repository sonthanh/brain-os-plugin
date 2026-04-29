/**
 * judge-fidelity.test.ts — judge-the-judge gate.
 *
 * Validates that the Opus-4.6 reviewer (or whichever model is wired via
 * AIRTABLE_REVIEWER_MODEL) achieves precision ≥0.9 + recall ≥0.85 on a
 * hand-labeled 30-slice fixture (15 good / 15 bad).
 *
 * Two run modes:
 *
 *   - **Default (no env var):** uses a deterministic mock runner that
 *     simulates near-correct Opus output (≥0.9 / ≥0.85 by construction).
 *     Validates the precision/recall pipeline + parser, not real-model
 *     fidelity. This is the CI-safe path.
 *
 *   - **Live (AIRTABLE_REVIEWER_LIVE=1):** invokes real `claude -p
 *     --model $AIRTABLE_REVIEWER_MODEL` for every fixture slice and
 *     reports the actual precision/recall. Fails if the live model
 *     drops below the gate. This is what the user runs to validate
 *     model-swap candidates per the C7 acceptance ("Below → swap to
 *     alternative model loose-coupled via env, surface to user").
 *
 * The fixture is `tests/fixtures/judge-fidelity-set.jsonl` — one slice
 * per line with `expected_pass: bool` + `expected_fail_modes: string[]`
 * ground-truth labels. Treat the fixture as the source of truth; if a
 * slice's label is wrong, fix it there and re-run.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  reviewBatch,
  computeFidelityMetrics,
  type SliceForReview,
  type SliceVerdict,
  type FailMode,
  type OpusRunner,
  type OpusResponse,
} from "../scripts/review-slice.mts";

interface FidelityEntry extends SliceForReview {
  expected_pass: boolean;
  expected_fail_modes: FailMode[];
}

function loadFidelitySet(): FidelityEntry[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const fixturePath = join(here, "fixtures", "judge-fidelity-set.jsonl");
  const raw = readFileSync(fixturePath, "utf8");
  const out: FidelityEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    out.push(JSON.parse(line) as FidelityEntry);
  }
  return out;
}

const META_RUBRIC = `# Meta-Rubric
1. Entity completeness.
2. Link fidelity.
3. Semantic preservation.
4. No hallucinated context.
5. Time fidelity.
6. Cluster coherence.
7. Legacy-link transparency.
`;

const RUBRIC_QUESTIONS = `# Rubric questions
1. After import, can vault answer who works where?
2. After import, can vault answer Q2 OKRs?
3. After import, can vault answer ADR-style decisions and their rationale?
`;

function makeMockRunner(
  perSlice: (entry: FidelityEntry) => { pass: boolean; score: number; fail_modes: FailMode[] },
): OpusRunner {
  return async (prompt: string): Promise<OpusResponse> => {
    const set = loadFidelitySet();
    // The fidelity test sends ALL fixture entries in one batch, so any slice
    // referenced in `prompt` belongs to that batch. We respond for whichever
    // slice ids appear (by string match on slice_id markers in our prompt).
    const slices = set
      .filter((s) => prompt.includes(`## slice ${s.slice_id}`))
      .map((s) => {
        const v = perSlice(s);
        return {
          slice_id: s.slice_id,
          score: v.score,
          pass: v.pass,
          reasoning: v.pass
            ? "matches subgraph; entities + links consistent"
            : `failed — ${v.fail_modes.join(", ") || "rubric violation"}`,
          fail_modes: v.fail_modes,
        };
      });
    return {
      rawText: JSON.stringify({
        slices,
        batch: { pass_rate: 0, pass: false },
      }),
      usage: { input_tokens: 1000, output_tokens: 500 },
      model: "claude-opus-4-6",
    };
  };
}

function buildBatch(set: FidelityEntry[]): SliceForReview[] {
  return set.map((s) => ({
    slice_id: s.slice_id,
    base_id: s.base_id,
    cluster_id: s.cluster_id,
    cluster_type: s.cluster_type,
    subgraph: s.subgraph,
    entities: s.entities,
  }));
}

function buildGroundTruth(set: FidelityEntry[]): Map<string, boolean> {
  const m = new Map<string, boolean>();
  for (const s of set) m.set(s.slice_id, s.expected_pass);
  return m;
}

const PROMPT_TEMPLATE = `# review prompt

# Meta-rubric
{{meta_rubric}}

# Examples
{{examples}}

# Rubric questions
{{rubric_questions}}

# Batch
{{batch}}

Output strict JSON only.
`;

function tmpPromptsPath(): string {
  // Inline-write a minimal prompt template alongside the test fixture so the
  // reviewer doesn't need to read the real prompts/review.md (which would
  // couple the fidelity test to prompt copy edits).
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "fixtures", "judge-fidelity-prompt.md");
  // Idempotent rewrite — keeps the file deterministic across test runs.
  writeFileSync(path, PROMPT_TEMPLATE);
  return path;
}

// ---------------------------------------------------------------------------
// Fixture sanity
// ---------------------------------------------------------------------------

describe("judge-fidelity fixture sanity", () => {
  test("fixture has 30 entries: 15 good + 15 bad", () => {
    const set = loadFidelitySet();
    expect(set).toHaveLength(30);
    const good = set.filter((s) => s.expected_pass).length;
    const bad = set.filter((s) => !s.expected_pass).length;
    expect(good).toBe(15);
    expect(bad).toBe(15);
  });

  test("every bad slice has at least one expected fail_mode", () => {
    const set = loadFidelitySet();
    for (const s of set) {
      if (!s.expected_pass) {
        expect(s.expected_fail_modes.length).toBeGreaterThan(0);
      } else {
        expect(s.expected_fail_modes).toEqual([]);
      }
    }
  });

  test("slice ids are unique", () => {
    const set = loadFidelitySet();
    const ids = new Set(set.map((s) => s.slice_id));
    expect(ids.size).toBe(set.length);
  });
});

// ---------------------------------------------------------------------------
// Mock-Opus path — always runs
// ---------------------------------------------------------------------------

describe("judge-fidelity (deterministic mock — always runs)", () => {
  test("perfect-mock judge → precision = 1, recall = 1", async () => {
    const set = loadFidelitySet();
    const slices = buildBatch(set);
    const truth = buildGroundTruth(set);

    const runOpus = makeMockRunner((entry) => ({
      pass: entry.expected_pass,
      score: entry.expected_pass ? 0.95 : 0.3,
      fail_modes: entry.expected_pass ? [] : entry.expected_fail_modes,
    }));

    const verdict = await reviewBatch(
      { batchId: "fidelity-perfect", baseId: "appBase", slices },
      {
        runOpus,
        baseContext: {
          metaRubric: META_RUBRIC,
          examples: "",
          rubricQuestions: RUBRIC_QUESTIONS,
        },
        promptsPath: tmpPromptsPath(),
      },
    );

    const metrics = computeFidelityMetrics(verdict.slices, truth);
    expect(metrics.precision).toBe(1);
    expect(metrics.recall).toBe(1);
  });

  test("noisy-but-good mock (1 FP + 1 FN) → precision ≥0.9, recall ≥0.85", async () => {
    const set = loadFidelitySet();
    const slices = buildBatch(set);
    const truth = buildGroundTruth(set);

    // Simulate an Opus that misclassifies:
    //   - bad-12 (truth=false) → judge says pass (1 false positive)
    //   - good-15 (truth=true) → judge says fail (1 false negative)
    // Expected math: TP=14 (good), FP=1, FN=1, TN=14
    //   precision = 14/(14+1) = 0.933 ≥ 0.9 ✓
    //   recall    = 14/(14+1) = 0.933 ≥ 0.85 ✓
    const runOpus = makeMockRunner((entry) => {
      if (entry.slice_id === "bad-12") {
        return { pass: true, score: 0.92, fail_modes: [] };
      }
      if (entry.slice_id === "good-15") {
        return { pass: false, score: 0.4, fail_modes: ["frontmatter-drift"] };
      }
      return {
        pass: entry.expected_pass,
        score: entry.expected_pass ? 0.95 : 0.3,
        fail_modes: entry.expected_pass ? [] : entry.expected_fail_modes,
      };
    });

    const verdict = await reviewBatch(
      { batchId: "fidelity-noisy", baseId: "appBase", slices },
      {
        runOpus,
        baseContext: {
          metaRubric: META_RUBRIC,
          examples: "",
          rubricQuestions: RUBRIC_QUESTIONS,
        },
        promptsPath: tmpPromptsPath(),
      },
    );

    const metrics = computeFidelityMetrics(verdict.slices, truth);
    expect(metrics.precision).toBeGreaterThanOrEqual(0.9);
    expect(metrics.recall).toBeGreaterThanOrEqual(0.85);
  });

  test("under-spec mock (3 FP + 3 FN) → precision <0.9 (would force model swap)", async () => {
    const set = loadFidelitySet();
    const slices = buildBatch(set);
    const truth = buildGroundTruth(set);

    // 3 false positives (bad-01, bad-02, bad-03 → judge says pass)
    // 3 false negatives (good-01, good-02, good-03 → judge says fail)
    const FP = new Set(["bad-01", "bad-02", "bad-03"]);
    const FN = new Set(["good-01", "good-02", "good-03"]);
    const runOpus = makeMockRunner((entry) => {
      if (FP.has(entry.slice_id)) {
        return { pass: true, score: 0.92, fail_modes: [] };
      }
      if (FN.has(entry.slice_id)) {
        return { pass: false, score: 0.4, fail_modes: ["frontmatter-drift"] };
      }
      return {
        pass: entry.expected_pass,
        score: entry.expected_pass ? 0.95 : 0.3,
        fail_modes: entry.expected_pass ? [] : entry.expected_fail_modes,
      };
    });

    const verdict = await reviewBatch(
      { batchId: "fidelity-bad", baseId: "appBase", slices },
      {
        runOpus,
        baseContext: {
          metaRubric: META_RUBRIC,
          examples: "",
          rubricQuestions: RUBRIC_QUESTIONS,
        },
        promptsPath: tmpPromptsPath(),
      },
    );

    const metrics = computeFidelityMetrics(verdict.slices, truth);
    // TP=12, FP=3 → precision = 12/15 = 0.8 (below the 0.9 gate)
    // TP=12, FN=3 → recall    = 12/15 = 0.8 (below the 0.85 gate)
    expect(metrics.precision).toBeLessThan(0.9);
    expect(metrics.recall).toBeLessThan(0.85);
  });
});

// ---------------------------------------------------------------------------
// Live-Opus path — gated by AIRTABLE_REVIEWER_LIVE=1
// ---------------------------------------------------------------------------

describe("judge-fidelity (live Opus — AIRTABLE_REVIEWER_LIVE=1)", () => {
  const live = process.env.AIRTABLE_REVIEWER_LIVE === "1";

  test.skipIf(!live)(
    "real claude -p reviewer: precision ≥0.9, recall ≥0.85",
    async () => {
      const set = loadFidelitySet();
      const slices = buildBatch(set);
      const truth = buildGroundTruth(set);

      const verdict = await reviewBatch(
        { batchId: "fidelity-live", baseId: "appBase", slices },
        {
          baseContext: {
            metaRubric: META_RUBRIC,
            examples: "",
            rubricQuestions: RUBRIC_QUESTIONS,
          },
          promptsPath: tmpPromptsPath(),
        },
      );

      const metrics = computeFidelityMetrics(
        verdict.slices.map((v: SliceVerdict) => ({
          slice_id: v.slice_id,
          pass: v.pass,
        })),
        truth,
      );

      // eslint-disable-next-line no-console
      console.log(
        `[judge-fidelity live] model=${verdict.model} precision=${metrics.precision.toFixed(3)} recall=${metrics.recall.toFixed(3)} TP=${metrics.truePositives} FP=${metrics.falsePositives} FN=${metrics.falseNegatives} TN=${metrics.trueNegatives}`,
      );

      expect(metrics.precision).toBeGreaterThanOrEqual(0.9);
      expect(metrics.recall).toBeGreaterThanOrEqual(0.85);
    },
    600_000,
  );
});
