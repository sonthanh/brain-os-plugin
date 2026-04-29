import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reviewBatch,
  loadBaseContext,
  renderBatchSection,
  renderReviewerPrompt,
  parseStreamJsonLines,
  parseReviewerResponse,
  computeBatchPassRate,
  computeFidelityMetrics,
  DEFAULT_THRESHOLD,
  DEFAULT_REVIEWER_MODEL,
  SLICE_PASS_SCORE,
  FAIL_MODE_VOCABULARY,
  type SliceForReview,
  type SliceVerdict,
  type OpusRunner,
  type OpusResponse,
  type BaseContext,
} from "../scripts/review-slice.mts";

let tmp: string;
let promptsPath: string;

const PROMPT_FIXTURE = `# review prompt

Output JSON only.

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

const META_RUBRIC = `# Meta-Rubric — Vault Extraction Quality
1. Entity completeness.
2. Link fidelity.
3. Semantic preservation.
`;

const RUBRIC_QUESTIONS = `# Rubric questions
1. Can vault answer who founded Acme?
2. Can vault answer Q2 OKRs?
`;

const EXAMPLES_JSONL = `{"raw":{"slug":"x"},"corrected":{"slug":"x-corrected"},"reason":"slug-collision"}
{"raw":{"slug":"y"},"corrected":{"slug":"y-better"},"reason":"link-mismatch"}
`;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "review-slice-test-"));
  promptsPath = join(tmp, "review.md");
  writeFileSync(promptsPath, PROMPT_FIXTURE);
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeBaseDir(opts?: { withExamples?: boolean }): string {
  const dir = join(tmp, "base-context");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta-rubric.md"), META_RUBRIC);
  writeFileSync(join(dir, "rubric-questions.md"), RUBRIC_QUESTIONS);
  if (opts?.withExamples) {
    writeFileSync(join(dir, "examples.jsonl"), EXAMPLES_JSONL);
  }
  return dir;
}

function makeSlice(id: string): SliceForReview {
  return {
    slice_id: id,
    base_id: "appBase",
    cluster_id: "cluster-1",
    cluster_type: "crm",
    subgraph: `### Contacts (tA)\n- record ${id}\n  - Name: "Test"`,
    entities: [
      {
        type: "person",
        slug: id,
        body: `Test entity ${id}.`,
        source_record_ids: [id],
      },
    ],
  };
}

function mockOpus(
  responder: (prompt: string) => OpusResponse,
  callLog?: string[],
): OpusRunner {
  return async (prompt: string) => {
    callLog?.push(prompt);
    return responder(prompt);
  };
}

function staticOpus(
  verdicts: Array<Partial<SliceVerdict> & { slice_id: string }>,
  usage = { input_tokens: 1234, output_tokens: 567 },
): OpusResponse {
  const slices = verdicts.map((v) => ({
    slice_id: v.slice_id,
    score: v.score ?? (v.pass === false ? 0.3 : 0.95),
    pass: v.pass ?? (v.score == null ? true : v.score >= SLICE_PASS_SCORE),
    reasoning: v.reasoning ?? "looks fine",
    fail_modes: v.fail_modes ?? [],
  }));
  const passed = slices.filter((s) => s.pass).length;
  const passRate = slices.length === 0 ? 0 : passed / slices.length;
  return {
    rawText: JSON.stringify({
      slices,
      batch: { pass_rate: passRate, pass: passRate >= 0.95 },
    }),
    usage,
    model: "claude-opus-4-6",
  };
}

// ---------------------------------------------------------------------------
// Constants + vocabulary
// ---------------------------------------------------------------------------

describe("constants", () => {
  test("DEFAULT_THRESHOLD = 0.95 per acceptance", () => {
    expect(DEFAULT_THRESHOLD).toBe(0.95);
  });
  test("DEFAULT_REVIEWER_MODEL = claude-opus-4-6", () => {
    expect(DEFAULT_REVIEWER_MODEL).toBe("claude-opus-4-6");
  });
  test("SLICE_PASS_SCORE = 0.9", () => {
    expect(SLICE_PASS_SCORE).toBe(0.9);
  });
  test("FAIL_MODE_VOCABULARY enumerates the 6 closed tags", () => {
    expect([...FAIL_MODE_VOCABULARY].sort()).toEqual(
      [
        "fact-invented",
        "frontmatter-drift",
        "link-mismatch",
        "missing-entity",
        "schema-fail",
        "slug-collision",
      ],
    );
  });
});

// ---------------------------------------------------------------------------
// loadBaseContext
// ---------------------------------------------------------------------------

describe("loadBaseContext", () => {
  test("loads meta-rubric + rubric-questions; examples optional and absent → empty", () => {
    const dir = makeBaseDir();
    const ctx = loadBaseContext(dir);
    expect(ctx.metaRubric).toContain("Entity completeness");
    expect(ctx.rubricQuestions).toContain("founded Acme");
    expect(ctx.examples).toBe("");
  });

  test("loads examples.jsonl when present", () => {
    const dir = makeBaseDir({ withExamples: true });
    const ctx = loadBaseContext(dir);
    expect(ctx.examples).toContain("slug-collision");
    expect(ctx.examples).toContain("link-mismatch");
  });

  test("throws when meta-rubric missing", () => {
    const dir = join(tmp, "broken");
    mkdirSync(dir);
    writeFileSync(join(dir, "rubric-questions.md"), RUBRIC_QUESTIONS);
    expect(() => loadBaseContext(dir)).toThrow(/meta-rubric/);
  });

  test("throws when rubric-questions missing", () => {
    const dir = join(tmp, "broken2");
    mkdirSync(dir);
    writeFileSync(join(dir, "meta-rubric.md"), META_RUBRIC);
    expect(() => loadBaseContext(dir)).toThrow(/rubric-questions/);
  });
});

// ---------------------------------------------------------------------------
// renderBatchSection + renderReviewerPrompt
// ---------------------------------------------------------------------------

describe("renderBatchSection", () => {
  test("renders each slice with subgraph and entities", () => {
    const out = renderBatchSection([makeSlice("recA"), makeSlice("recB")]);
    expect(out).toContain("## slice recA");
    expect(out).toContain("## slice recB");
    expect(out).toContain("### Source subgraph");
    expect(out).toContain("### Extracted entities");
    expect(out).toContain("Test entity recA");
    expect(out).toContain('"slug": "recA"');
  });

  test("handles empty subgraph defensively", () => {
    const slice = { ...makeSlice("recX"), subgraph: "" };
    const out = renderBatchSection([slice]);
    expect(out).toContain("(empty subgraph)");
  });
});

describe("renderReviewerPrompt", () => {
  test("substitutes all four placeholders + preserves prefix order", () => {
    const ctx: BaseContext = {
      metaRubric: "META",
      examples: "EXAMPLES",
      rubricQuestions: "QUESTIONS",
    };
    const out = renderReviewerPrompt(PROMPT_FIXTURE, ctx, "BATCH");
    expect(out).toContain("META");
    expect(out).toContain("EXAMPLES");
    expect(out).toContain("QUESTIONS");
    expect(out).toContain("BATCH");
    // Prefix order: meta-rubric, examples, rubric-questions BEFORE batch
    // (so Anthropic prompt cache hits on prefix across batches).
    const metaIdx = out.indexOf("META");
    const examplesIdx = out.indexOf("EXAMPLES");
    const questionsIdx = out.indexOf("QUESTIONS");
    const batchIdx = out.indexOf("BATCH");
    expect(metaIdx).toBeLessThan(examplesIdx);
    expect(examplesIdx).toBeLessThan(questionsIdx);
    expect(questionsIdx).toBeLessThan(batchIdx);
  });

  test("empty examples → human-readable placeholder", () => {
    const ctx: BaseContext = {
      metaRubric: "M",
      examples: "",
      rubricQuestions: "Q",
    };
    const out = renderReviewerPrompt(PROMPT_FIXTURE, ctx, "B");
    expect(out).toContain("(none yet — first batch on this base)");
  });
});

// ---------------------------------------------------------------------------
// parseStreamJsonLines
// ---------------------------------------------------------------------------

describe("parseStreamJsonLines", () => {
  test("accumulates assistant text and final usage", () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-4-6" }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "{\"slices\":[]}" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        usage: {
          input_tokens: 200,
          output_tokens: 100,
          cache_read_input_tokens: 1500,
        },
        result: '{"slices":[]}',
      }),
    ];
    const r = parseStreamJsonLines(lines);
    expect(r.rawText).toBe('{"slices":[]}');
    expect(r.usage.input_tokens).toBe(200);
    expect(r.usage.output_tokens).toBe(100);
    expect(r.usage.cache_read_input_tokens).toBe(1500);
    expect(r.model).toContain("opus");
  });

  test("ignores blank and unparseable lines", () => {
    const lines = [
      "",
      "junk",
      JSON.stringify({
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
        result: "ok",
      }),
    ];
    const r = parseStreamJsonLines(lines);
    expect(r.rawText).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// parseReviewerResponse
// ---------------------------------------------------------------------------

describe("parseReviewerResponse", () => {
  test("parses well-formed verdict batch", () => {
    const text = JSON.stringify({
      slices: [
        {
          slice_id: "recA",
          score: 0.95,
          pass: true,
          reasoning: "good",
          fail_modes: [],
        },
        {
          slice_id: "recB",
          score: 0.4,
          pass: false,
          reasoning: "missing link",
          fail_modes: ["link-mismatch"],
        },
      ],
      batch: { pass_rate: 0.5, pass: false },
    });
    const verdicts = parseReviewerResponse(text, ["recA", "recB"]);
    expect(verdicts).toHaveLength(2);
    expect(verdicts[0].pass).toBe(true);
    expect(verdicts[1].pass).toBe(false);
    expect(verdicts[1].fail_modes).toEqual(["link-mismatch"]);
  });

  test("strips ```json fence", () => {
    const text =
      '```json\n{"slices":[{"slice_id":"recA","score":0.95,"pass":true,"reasoning":"ok","fail_modes":[]}],"batch":{"pass_rate":1,"pass":true}}\n```';
    const v = parseReviewerResponse(text, ["recA"]);
    expect(v).toHaveLength(1);
  });

  test("rejects unknown fail_mode tags (closed vocabulary)", () => {
    const text = JSON.stringify({
      slices: [
        {
          slice_id: "recA",
          score: 0.3,
          pass: false,
          reasoning: "bad",
          fail_modes: ["link-mismatch", "made-up-tag", "fact-invented"],
        },
      ],
      batch: { pass_rate: 0, pass: false },
    });
    const v = parseReviewerResponse(text, ["recA"]);
    expect(v[0].fail_modes).toEqual(["link-mismatch", "fact-invented"]);
  });

  test("clears fail_modes when slice passed", () => {
    const text = JSON.stringify({
      slices: [
        {
          slice_id: "recA",
          score: 0.95,
          pass: true,
          reasoning: "ok",
          fail_modes: ["link-mismatch"], // reviewer noise — should be dropped
        },
      ],
      batch: { pass_rate: 1, pass: true },
    });
    const v = parseReviewerResponse(text, ["recA"]);
    expect(v[0].fail_modes).toEqual([]);
  });

  test("throws when slice_id not in input batch", () => {
    const text = JSON.stringify({
      slices: [
        { slice_id: "recBOGUS", score: 0.9, pass: true, reasoning: "", fail_modes: [] },
      ],
    });
    expect(() => parseReviewerResponse(text, ["recA"])).toThrow(/unexpected/i);
  });

  test("throws when input slice missing from response", () => {
    const text = JSON.stringify({
      slices: [
        { slice_id: "recA", score: 0.9, pass: true, reasoning: "", fail_modes: [] },
      ],
    });
    expect(() => parseReviewerResponse(text, ["recA", "recB"])).toThrow(
      /missing verdict.*recB/i,
    );
  });

  test("throws on duplicate slice_id", () => {
    const text = JSON.stringify({
      slices: [
        { slice_id: "recA", score: 0.9, pass: true, reasoning: "", fail_modes: [] },
        { slice_id: "recA", score: 0.5, pass: false, reasoning: "", fail_modes: [] },
      ],
    });
    expect(() => parseReviewerResponse(text, ["recA"])).toThrow(/duplicate/i);
  });

  test("throws on score out of [0,1]", () => {
    const text = JSON.stringify({
      slices: [
        { slice_id: "recA", score: 1.5, pass: true, reasoning: "", fail_modes: [] },
      ],
    });
    expect(() => parseReviewerResponse(text, ["recA"])).toThrow(/score/i);
  });

  test("throws on no JSON in response", () => {
    expect(() => parseReviewerResponse("plain text", ["recA"])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// computeBatchPassRate
// ---------------------------------------------------------------------------

describe("computeBatchPassRate", () => {
  test("0 slices → 0", () => {
    expect(computeBatchPassRate([])).toBe(0);
  });

  test("all pass → 1", () => {
    const v: SliceVerdict[] = [
      { slice_id: "a", score: 1, pass: true, reasoning: "", fail_modes: [] },
      { slice_id: "b", score: 1, pass: true, reasoning: "", fail_modes: [] },
    ];
    expect(computeBatchPassRate(v)).toBe(1);
  });

  test("9 of 10 pass → 0.9", () => {
    const v: SliceVerdict[] = Array.from({ length: 10 }, (_, i) => ({
      slice_id: `r${i}`,
      score: i === 0 ? 0.3 : 1,
      pass: i !== 0,
      reasoning: "",
      fail_modes: [],
    }));
    expect(computeBatchPassRate(v)).toBeCloseTo(0.9);
  });
});

// ---------------------------------------------------------------------------
// computeFidelityMetrics
// ---------------------------------------------------------------------------

describe("computeFidelityMetrics", () => {
  test("perfect agreement → precision=1, recall=1", () => {
    const verdicts = [
      { slice_id: "a", pass: true },
      { slice_id: "b", pass: false },
    ];
    const truth = new Map([
      ["a", true],
      ["b", false],
    ]);
    const m = computeFidelityMetrics(verdicts, truth);
    expect(m.precision).toBe(1);
    expect(m.recall).toBe(1);
    expect(m.truePositives).toBe(1);
    expect(m.trueNegatives).toBe(1);
  });

  test("one false positive lowers precision", () => {
    // 9 TP, 1 FP, 0 FN, 0 TN → precision = 9/10 = 0.9, recall = 9/9 = 1
    const verdicts = Array.from({ length: 10 }, (_, i) => ({
      slice_id: `r${i}`,
      pass: true,
    }));
    const truth = new Map<string, boolean>();
    for (let i = 0; i < 10; i++) truth.set(`r${i}`, i !== 0);
    const m = computeFidelityMetrics(verdicts, truth);
    expect(m.precision).toBeCloseTo(0.9);
    expect(m.recall).toBeCloseTo(1);
  });

  test("one false negative lowers recall", () => {
    // 9 TP, 0 FP, 1 FN, 0 TN → precision = 1, recall = 9/10
    const verdicts: Array<{ slice_id: string; pass: boolean }> = [];
    const truth = new Map<string, boolean>();
    for (let i = 0; i < 10; i++) {
      verdicts.push({ slice_id: `r${i}`, pass: i !== 0 });
      truth.set(`r${i}`, true);
    }
    const m = computeFidelityMetrics(verdicts, truth);
    expect(m.precision).toBeCloseTo(1);
    expect(m.recall).toBeCloseTo(0.9);
  });

  test("throws when verdict slice missing from ground truth", () => {
    expect(() =>
      computeFidelityMetrics([{ slice_id: "ghost", pass: true }], new Map()),
    ).toThrow(/ground truth/);
  });

  test("zero predicted positives → precision = 0 (no division by zero)", () => {
    const verdicts = [{ slice_id: "a", pass: false }];
    const truth = new Map([["a", false]]);
    const m = computeFidelityMetrics(verdicts, truth);
    expect(m.precision).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// reviewBatch — end-to-end with mock Opus
// ---------------------------------------------------------------------------

describe("reviewBatch (end-to-end)", () => {
  test("≥95% pass-rate → batch.pass = true; cost-meter appended", async () => {
    const baseDir = makeBaseDir({ withExamples: true });
    const slices = Array.from({ length: 10 }, (_, i) => makeSlice(`rec${i}`));
    const opusCalls: string[] = [];
    const runOpus = mockOpus(
      () => staticOpus(slices.map((s) => ({ slice_id: s.slice_id, pass: true }))),
      opusCalls,
    );
    const costMeterPath = join(tmp, "run", "cost-meter.jsonl");

    const verdict = await reviewBatch(
      { batchId: "batch-1", baseId: "appBase", slices },
      { runOpus, basePath: baseDir, promptsPath, costMeterPath },
    );

    expect(verdict.pass).toBe(true);
    expect(verdict.pass_rate).toBe(1);
    expect(verdict.threshold).toBe(0.95);
    expect(verdict.slices).toHaveLength(10);
    expect(verdict.model).toBe("claude-opus-4-6");
    expect(verdict.usage.input_tokens).toBeGreaterThan(0);

    expect(opusCalls).toHaveLength(1);
    expect(opusCalls[0]).toContain("Entity completeness"); // meta-rubric in prompt
    expect(opusCalls[0]).toContain("founded Acme"); // rubric-questions in prompt
    expect(opusCalls[0]).toContain("rec0"); // batch slice in prompt

    expect(existsSync(costMeterPath)).toBe(true);
    const costLine = JSON.parse(readFileSync(costMeterPath, "utf8").trim());
    expect(costLine.role).toBe("reviewer");
    expect(costLine.model).toBe("claude-opus-4-6");
    expect(costLine.batch_id).toBe("batch-1");
    expect(costLine.input_tokens).toBe(1234);
    expect(costLine.output_tokens).toBe(567);
  });

  test("9 of 10 pass (90%) → batch.pass = false at default 95% threshold", async () => {
    const baseDir = makeBaseDir();
    const slices = Array.from({ length: 10 }, (_, i) => makeSlice(`rec${i}`));
    const runOpus = mockOpus(() =>
      staticOpus(
        slices.map((s, i) => ({
          slice_id: s.slice_id,
          pass: i !== 0,
          score: i === 0 ? 0.3 : 0.95,
          fail_modes: i === 0 ? ["link-mismatch", "fact-invented"] : [],
        })),
      ),
    );

    const verdict = await reviewBatch(
      { batchId: "batch-2", baseId: "appBase", slices },
      { runOpus, basePath: baseDir, promptsPath },
    );

    expect(verdict.pass_rate).toBeCloseTo(0.9);
    expect(verdict.pass).toBe(false);
    expect(verdict.slices[0].fail_modes).toEqual(["link-mismatch", "fact-invented"]);
  });

  test("configurable threshold passes lower bar", async () => {
    const baseDir = makeBaseDir();
    const slices = Array.from({ length: 10 }, (_, i) => makeSlice(`rec${i}`));
    const runOpus = mockOpus(() =>
      staticOpus(
        slices.map((s, i) => ({
          slice_id: s.slice_id,
          pass: i !== 0,
          score: i === 0 ? 0.3 : 0.95,
        })),
      ),
    );

    const verdict = await reviewBatch(
      { batchId: "batch-3", baseId: "appBase", slices },
      { runOpus, basePath: baseDir, promptsPath, threshold: 0.85 },
    );

    expect(verdict.pass_rate).toBeCloseTo(0.9);
    expect(verdict.pass).toBe(true);
    expect(verdict.threshold).toBe(0.85);
  });

  test("model is loose-coupled via env (AIRTABLE_REVIEWER_MODEL)", async () => {
    const baseDir = makeBaseDir();
    const slices = [makeSlice("recA")];
    let modelArg: string | null = null;
    const runOpus: OpusRunner = async (_p, model) => {
      modelArg = model;
      return staticOpus([{ slice_id: "recA", pass: true }]);
    };

    await reviewBatch(
      { batchId: "b", baseId: "appBase", slices },
      {
        runOpus,
        basePath: baseDir,
        promptsPath,
        env: { AIRTABLE_REVIEWER_MODEL: "claude-haiku-4-5-20251001" },
      },
    );

    expect(modelArg).toBe("claude-haiku-4-5-20251001");
  });

  test("explicit model arg beats env var", async () => {
    const baseDir = makeBaseDir();
    const slices = [makeSlice("recA")];
    let modelArg: string | null = null;
    const runOpus: OpusRunner = async (_p, model) => {
      modelArg = model;
      return staticOpus([{ slice_id: "recA", pass: true }]);
    };

    await reviewBatch(
      { batchId: "b", baseId: "appBase", slices },
      {
        runOpus,
        basePath: baseDir,
        promptsPath,
        model: "explicit-model-id",
        env: { AIRTABLE_REVIEWER_MODEL: "from-env" },
      },
    );

    expect(modelArg).toBe("explicit-model-id");
  });

  test("accepts inline baseContext (skip filesystem)", async () => {
    const slices = [makeSlice("recA")];
    const runOpus = mockOpus(() =>
      staticOpus([{ slice_id: "recA", pass: true }]),
    );

    const verdict = await reviewBatch(
      { batchId: "b", baseId: "appBase", slices },
      {
        runOpus,
        baseContext: {
          metaRubric: META_RUBRIC,
          examples: "",
          rubricQuestions: RUBRIC_QUESTIONS,
        },
        promptsPath,
      },
    );

    expect(verdict.pass).toBe(true);
  });

  test("throws on empty slice list", async () => {
    const baseDir = makeBaseDir();
    await expect(
      reviewBatch(
        { batchId: "b", baseId: "appBase", slices: [] },
        { runOpus: mockOpus(() => staticOpus([])), basePath: baseDir, promptsPath },
      ),
    ).rejects.toThrow(/empty/i);
  });

  test("throws when neither basePath nor baseContext provided", async () => {
    const slices = [makeSlice("recA")];
    await expect(
      reviewBatch(
        { batchId: "b", baseId: "appBase", slices },
        {
          runOpus: mockOpus(() => staticOpus([{ slice_id: "recA", pass: true }])),
          promptsPath,
        },
      ),
    ).rejects.toThrow(/baseContext.*basePath/);
  });

  test("missing meta-rubric in baseDir → throws (helpful error)", async () => {
    const dir = join(tmp, "broken-base");
    mkdirSync(dir);
    writeFileSync(join(dir, "rubric-questions.md"), RUBRIC_QUESTIONS);
    const slices = [makeSlice("recA")];
    await expect(
      reviewBatch(
        { batchId: "b", baseId: "appBase", slices },
        {
          runOpus: mockOpus(() => staticOpus([{ slice_id: "recA", pass: true }])),
          basePath: dir,
          promptsPath,
        },
      ),
    ).rejects.toThrow(/meta-rubric/);
  });

  test("does NOT write cost-meter when costMeterPath omitted", async () => {
    const baseDir = makeBaseDir();
    const slices = [makeSlice("recA")];
    const runOpus = mockOpus(() =>
      staticOpus([{ slice_id: "recA", pass: true }]),
    );

    await reviewBatch(
      { batchId: "b", baseId: "appBase", slices },
      { runOpus, basePath: baseDir, promptsPath },
    );

    expect(existsSync(join(tmp, "cost-meter.jsonl"))).toBe(false);
  });

  test("propagates cache-read tokens when present in usage", async () => {
    const baseDir = makeBaseDir();
    const slices = [makeSlice("recA")];
    const runOpus: OpusRunner = async () => ({
      rawText: JSON.stringify({
        slices: [
          { slice_id: "recA", score: 0.95, pass: true, reasoning: "", fail_modes: [] },
        ],
        batch: { pass_rate: 1, pass: true },
      }),
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 200,
      },
      model: "claude-opus-4-6",
    });
    const costMeterPath = join(tmp, "cost.jsonl");

    await reviewBatch(
      { batchId: "b", baseId: "appBase", slices },
      { runOpus, basePath: baseDir, promptsPath, costMeterPath },
    );

    const cost = JSON.parse(readFileSync(costMeterPath, "utf8").trim());
    expect(cost.cache_read_input_tokens).toBe(5000);
    expect(cost.cache_creation_input_tokens).toBe(200);
  });
});
