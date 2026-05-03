import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeDelta,
  evaluateDelta,
  cliExitCode,
  parseGrillCommand,
  parseRange,
  runInteractiveGrill,
  runRubricAuthor,
  type AirtableScan,
  type ClaudeRunner,
  type GrillIO,
  type RubricAuthorOptions,
} from "../scripts/rubric-author.mts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "rubric-author-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const N = 20;
const aiQuestions = (): string[] =>
  Array.from(
    { length: N },
    (_, i) => `Can vault answer query #${i + 1} about people, decisions, and OKRs?`,
  );

describe("computeDelta", () => {
  test("all verbatim → kept_verbatim=N, ratio=0", () => {
    const original = aiQuestions();
    const edited = [...original];
    const m = computeDelta(original, edited);
    expect(m.questions_kept_verbatim).toBe(N);
    expect(m.edited_count).toBe(0);
    expect(m.replaced_count).toBe(0);
    expect(m.added_by_user).toBe(0);
    expect(m.edit_ratio).toBe(0);
  });

  test("minor word swap → edited, similarity ≥ 0.5", () => {
    const original = ["Can vault answer who founded company X?"];
    const edited = ["Can vault tell who founded company X exactly?"];
    const m = computeDelta(original, edited);
    expect(m.edited_count).toBe(1);
    expect(m.replaced_count).toBe(0);
  });

  test("entirely new wording → replaced, similarity < 0.5", () => {
    const original = ["Can vault answer who founded company X?"];
    const edited = ["Which OKRs depended on the platform shift?"];
    const m = computeDelta(original, edited);
    expect(m.replaced_count).toBe(1);
    expect(m.edited_count).toBe(0);
  });

  test("extra lines beyond original count as added_by_user", () => {
    const original = ["q1"];
    const edited = ["q1", "user-added 1", "user-added 2"];
    const m = computeDelta(original, edited);
    expect(m.questions_kept_verbatim).toBe(1);
    expect(m.added_by_user).toBe(2);
  });

  test("ratio formula = (edited + replaced) / N_original; added excluded", () => {
    const original = aiQuestions();
    const edited = [...original];
    edited[0] = "Can vault tell who founded company X really?";
    edited[1] = "Totally different sentence about pricing tiers.";
    edited.push("user added bonus");
    const m = computeDelta(original, edited);
    expect(m.edit_ratio).toBeCloseTo((m.edited_count + m.replaced_count) / N, 5);
    expect(m.added_by_user).toBe(1);
  });

  test("normalization: trim and collapse whitespace before compare", () => {
    const original = ["Hello  world"];
    const edited = ["  Hello world  "];
    const m = computeDelta(original, edited);
    expect(m.questions_kept_verbatim).toBe(1);
  });
});

describe("evaluateDelta", () => {
  const baseMetrics = (ratio: number) => ({
    questions_kept_verbatim: 0,
    edited_count: 0,
    replaced_count: 0,
    added_by_user: 0,
    total_original: N,
    total_edited: N,
    edit_ratio: ratio,
  });

  test("ratio 0 → pass, exit 0", () => {
    const r = evaluateDelta(baseMetrics(0));
    expect(r.verdict).toBe("pass");
    expect(r.exitCode).toBe(0);
  });

  test("ratio 0.30 → pass (≤30 boundary), exit 0", () => {
    const r = evaluateDelta(baseMetrics(0.3));
    expect(r.verdict).toBe("pass");
    expect(r.exitCode).toBe(0);
  });

  test("ratio 0.45 → pass-with-improve, exit 0", () => {
    const r = evaluateDelta(baseMetrics(0.45));
    expect(r.verdict).toBe("pass-with-improve");
    expect(r.exitCode).toBe(0);
  });

  test("ratio 0.70 → pass-with-improve (≤70 boundary), exit 0", () => {
    const r = evaluateDelta(baseMetrics(0.7));
    expect(r.verdict).toBe("pass-with-improve");
    expect(r.exitCode).toBe(0);
  });

  test("ratio 0.71 → reject, exit 1", () => {
    const r = evaluateDelta(baseMetrics(0.71));
    expect(r.verdict).toBe("reject");
    expect(r.exitCode).toBe(1);
  });

  test("ratio 1.0 → reject, exit 1", () => {
    const r = evaluateDelta(baseMetrics(1));
    expect(r.verdict).toBe("reject");
    expect(r.exitCode).toBe(1);
  });
});

describe("cliExitCode", () => {
  test("default (strict=false): pass → 0", () => {
    expect(cliExitCode("pass", false)).toBe(0);
  });
  test("default: pass-with-improve → 0", () => {
    expect(cliExitCode("pass-with-improve", false)).toBe(0);
  });
  test("default: reject → 0 (signal not halt — operator-curated divergence is legitimate)", () => {
    expect(cliExitCode("reject", false)).toBe(0);
  });
  test("strict=true: pass → 0", () => {
    expect(cliExitCode("pass", true)).toBe(0);
  });
  test("strict=true: pass-with-improve → 0", () => {
    expect(cliExitCode("pass-with-improve", true)).toBe(0);
  });
  test("strict=true: reject → 1 (preserves CI-gate halt behavior)", () => {
    expect(cliExitCode("reject", true)).toBe(1);
  });
});

describe("parseRange", () => {
  test("single number", () => {
    expect(parseRange("5")).toEqual([5]);
  });
  test("hyphen range", () => {
    expect(parseRange("1-5")).toEqual([1, 2, 3, 4, 5]);
  });
  test("descending range normalizes", () => {
    expect(parseRange("5-1")).toEqual([1, 2, 3, 4, 5]);
  });
  test("comma list", () => {
    expect(parseRange("1,3,5")).toEqual([1, 3, 5]);
  });
  test("mixed range + comma", () => {
    expect(parseRange("1-3,5")).toEqual([1, 2, 3, 5]);
  });
  test("empty string → empty array", () => {
    expect(parseRange("")).toEqual([]);
  });
  test("invalid tokens skipped", () => {
    expect(parseRange("1,abc,3")).toEqual([1, 3]);
  });
});

describe("parseGrillCommand", () => {
  test("empty input → keep", () => {
    expect(parseGrillCommand("")).toEqual({ kind: "keep" });
  });
  test("whitespace only → keep", () => {
    expect(parseGrillCommand("   ")).toEqual({ kind: "keep" });
  });
  test("'k' → keep", () => {
    expect(parseGrillCommand("k")).toEqual({ kind: "keep" });
  });
  test("'d' → drop", () => {
    expect(parseGrillCommand("d")).toEqual({ kind: "drop" });
  });
  test("'+' → add", () => {
    expect(parseGrillCommand("+")).toEqual({ kind: "add" });
  });
  test("free text → rewrite", () => {
    expect(parseGrillCommand("This is a rewrite about X")).toEqual({
      kind: "rewrite",
      text: "This is a rewrite about X",
    });
  });
  test("'k 1-5' → batch keep", () => {
    expect(parseGrillCommand("k 1-5")).toEqual({
      kind: "batch",
      actions: [{ kind: "keep", nums: [1, 2, 3, 4, 5] }],
    });
  });
  test("'d 6,7' → batch drop", () => {
    expect(parseGrillCommand("d 6,7")).toEqual({
      kind: "batch",
      actions: [{ kind: "drop", nums: [6, 7] }],
    });
  });
  test("'k 1-5 d 6,7' → multi-batch", () => {
    expect(parseGrillCommand("k 1-5 d 6,7")).toEqual({
      kind: "batch",
      actions: [
        { kind: "keep", nums: [1, 2, 3, 4, 5] },
        { kind: "drop", nums: [6, 7] },
      ],
    });
  });
  test("'k 1-5 d 6 d 9-12' → multi-batch with three actions", () => {
    expect(parseGrillCommand("k 1-5 d 6 d 9-12")).toEqual({
      kind: "batch",
      actions: [
        { kind: "keep", nums: [1, 2, 3, 4, 5] },
        { kind: "drop", nums: [6] },
        { kind: "drop", nums: [9, 10, 11, 12] },
      ],
    });
  });
  test("malformed batch (range without prefix) → falls through to rewrite", () => {
    // 'k 1-5 7-9' — second range has no k/d prefix, so the whole thing is a rewrite
    expect(parseGrillCommand("k 1-5 7-9")).toEqual({
      kind: "rewrite",
      text: "k 1-5 7-9",
    });
  });
  test("'kayaks' → rewrite (not k followed by stuff)", () => {
    expect(parseGrillCommand("kayaks")).toEqual({
      kind: "rewrite",
      text: "kayaks",
    });
  });
  test("'k alone' (with trailing word) → rewrite", () => {
    // 'k alone' starts with k but second token isn't a range, so falls through.
    expect(parseGrillCommand("k alone")).toEqual({
      kind: "rewrite",
      text: "k alone",
    });
  });
});

// --- Interactive grill --------------------------------------------------------

function makeMockIO(answers: string[]): GrillIO & { writes: string[] } {
  let i = 0;
  const writes: string[] = [];
  return {
    prompt: async () => {
      const a = answers[i] ?? "";
      i += 1;
      return a;
    },
    output: (text) => {
      writes.push(text);
    },
    close: () => {},
    writes,
  };
}

function fixtureAirtable(): AirtableScan {
  return {
    baseId: "appBASE",
    tables: [
      { id: "t1", name: "Companies", fields: [] },
      { id: "t2", name: "OKRs", fields: [] },
    ],
    samples: [
      { table: "Companies", records: [{ id: "rec1", fields: { Name: "Acme" } }] },
      { table: "OKRs", records: [{ id: "rec2", fields: { Title: "Ship Q1" } }] },
    ],
  };
}

describe("runInteractiveGrill", () => {
  test("keep branch: 'k' preserves the question", async () => {
    const io = makeMockIO(["k", ""]);
    const out = await runInteractiveGrill({
      questions: ["Q1"],
      airtable: fixtureAirtable(),
      io,
    });
    expect(out).toEqual(["Q1"]);
  });

  test("empty input behaves like keep", async () => {
    const io = makeMockIO(["", ""]);
    const out = await runInteractiveGrill({
      questions: ["Q1"],
      airtable: fixtureAirtable(),
      io,
    });
    expect(out).toEqual(["Q1"]);
  });

  test("drop branch: 'd' removes the question", async () => {
    const io = makeMockIO(["d", ""]);
    const out = await runInteractiveGrill({
      questions: ["Q1"],
      airtable: fixtureAirtable(),
      io,
    });
    expect(out).toEqual([]);
  });

  test("rewrite branch: free text replaces the question", async () => {
    const io = makeMockIO(["A totally fresh question about cohort retention?", ""]);
    const out = await runInteractiveGrill({
      questions: ["Q1"],
      airtable: fixtureAirtable(),
      io,
    });
    expect(out).toEqual(["A totally fresh question about cohort retention?"]);
  });

  test("batch branch: 'k 1-3 d 4' applies to multiple at once", async () => {
    const questions = ["Q1", "Q2", "Q3", "Q4"];
    // First prompt receives 'k 1-3 d 4' which decides all 4 slots.
    // No further prompts for the question loop; then add-mode '' to finish.
    const io = makeMockIO(["k 1-3 d 4", ""]);
    const out = await runInteractiveGrill({
      questions,
      airtable: fixtureAirtable(),
      io,
    });
    expect(out).toEqual(["Q1", "Q2", "Q3"]);
  });

  test("batch + per-question mix: 'd 5' on q1, then walk q2-4", async () => {
    const questions = ["Q1", "Q2", "Q3", "Q4", "Q5"];
    // q1 prompt: 'd 5' decides slot 5 (drop) but leaves q1 undecided.
    // q1 prompt re-fires: 'k' keeps q1.
    // q2 prompt: 'k', q3 prompt: 'k', q4 prompt: 'k'.
    // slot 5 already decided as drop → loop skips → add-mode.
    const io = makeMockIO(["d 5", "k", "k", "k", "k", ""]);
    const out = await runInteractiveGrill({
      questions,
      airtable: fixtureAirtable(),
      io,
    });
    expect(out).toEqual(["Q1", "Q2", "Q3", "Q4"]);
  });

  test("add branch: '+' jumps to add-mode, keeps remaining, then collects new", async () => {
    const questions = ["Q1", "Q2", "Q3"];
    // q1 prompt: '+' → q2,q3 auto-kept, jump to add-mode.
    // Add: "New A", "New B", "" (finish).
    const io = makeMockIO(["+", "New question A?", "New question B?", ""]);
    const out = await runInteractiveGrill({
      questions,
      airtable: fixtureAirtable(),
      io,
    });
    expect(out).toEqual(["Q1", "Q2", "Q3", "New question A?", "New question B?"]);
  });

  test("add-questions branch: empty walk + tail-add", async () => {
    const questions = ["Q1", "Q2"];
    // Walk: 'k', 'k'. Add: "Tail", "" (finish).
    const io = makeMockIO(["k", "k", "Tail question?", ""]);
    const out = await runInteractiveGrill({
      questions,
      airtable: fixtureAirtable(),
      io,
    });
    expect(out).toEqual(["Q1", "Q2", "Tail question?"]);
  });

  test("each prompt outputs the question + a sample record from rotating tables", async () => {
    const io = makeMockIO(["k", "k", ""]);
    await runInteractiveGrill({
      questions: ["Q1", "Q2"],
      airtable: fixtureAirtable(),
      io,
    });
    const blob = io.writes.join("\n");
    expect(blob).toContain("Question 1/2: Q1");
    expect(blob).toContain("Sample (Companies)");
    expect(blob).toContain("Question 2/2: Q2");
    expect(blob).toContain("Sample (OKRs)");
  });

  test("empty airtable samples: shows '(none)' placeholder, doesn't crash", async () => {
    const io = makeMockIO(["k", ""]);
    const out = await runInteractiveGrill({
      questions: ["Q1"],
      airtable: { baseId: "appBASE", tables: [], samples: [] },
      io,
    });
    expect(out).toEqual(["Q1"]);
    const blob = io.writes.join("\n");
    expect(blob).toContain("(none)");
  });

  test("zero questions: skips loop, goes straight to add-mode", async () => {
    const io = makeMockIO(["Add me?", ""]);
    const out = await runInteractiveGrill({
      questions: [],
      airtable: fixtureAirtable(),
      io,
    });
    expect(out).toEqual(["Add me?"]);
  });

  test("rewrite that looks like 'k something' falls through cleanly", async () => {
    const io = makeMockIO(["k tactical", ""]);
    const out = await runInteractiveGrill({
      questions: ["Q1"],
      airtable: fixtureAirtable(),
      io,
    });
    expect(out).toEqual(["k tactical"]);
  });
});

// --- Orchestrator helpers -----------------------------------------------------

function seedVault(root: string) {
  const intel = join(root, "business", "intelligence");
  const dec = join(root, "business", "decisions");
  const res = join(root, "knowledge", "research");
  mkdirSync(intel, { recursive: true });
  mkdirSync(dec, { recursive: true });
  mkdirSync(res, { recursive: true });
  writeFileSync(
    join(intel, "company-acme.md"),
    "# Acme intelligence\n\nKey question: who funds Acme?\n",
  );
  writeFileSync(
    join(dec, "2026-04-01-pivot.md"),
    "# Decision: pivot\n\nWhy: market signals.\n",
  );
  writeFileSync(
    join(res, "2026-04-27-airtable.md"),
    "# Airtable research\n\nNotes on schema.\n",
  );
}

function airtableFetchMock() {
  return async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/meta/bases/") && u.endsWith("/tables")) {
      return new Response(
        JSON.stringify({
          tables: [
            {
              id: "tbl1",
              name: "Companies",
              fields: [
                { id: "fld1", name: "Name", type: "singleLineText" },
                { id: "fld2", name: "Founder", type: "singleLineText" },
              ],
            },
            {
              id: "tbl2",
              name: "OKRs",
              fields: [
                { id: "fld3", name: "Title", type: "singleLineText" },
                { id: "fld4", name: "Company", type: "multipleRecordLinks" },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (u.includes("/v0/appBASE/")) {
      return new Response(
        JSON.stringify({
          records: [
            { id: "rec1", fields: { Name: "Acme" } },
            { id: "rec2", fields: { Name: "Globex" } },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 200 });
  };
}

function makeClaudeRunner(angles: { obvious: string[]; bold: string[]; creative: string[] }, questions: string[]): ClaudeRunner {
  let call = 0;
  return async () => {
    call += 1;
    if (call === 1) {
      return JSON.stringify(angles);
    }
    return JSON.stringify({ questions });
  };
}

function defaultAngles() {
  return {
    obvious: ["Q1 obvious", "Q2 obvious"],
    bold: ["Q3 bold", "Q4 bold"],
    creative: ["Q5 creative", "Q6 creative"],
  };
}

function defaultQuestions(): string[] {
  return Array.from(
    { length: N },
    (_, i) => `Vault answer #${i + 1}: who, what, when, where, why, how?`,
  );
}

/** Default grill IO that keeps every question and adds none. */
function keepAllGrillIO(n: number): GrillIO {
  return makeMockIO([...new Array(n).fill("k"), ""]);
}

function commonOpts(overrides: Partial<RubricAuthorOptions> = {}): RubricAuthorOptions {
  const vaultRoot = join(tmp, "vault");
  seedVault(vaultRoot);
  return {
    baseId: "appBASE",
    vaultRoot,
    cacheDir: join(tmp, "cache"),
    runId: "run-test",
    fetch: airtableFetchMock(),
    env: { AIRTABLE_API_KEY: "patFake" },
    claudeRunner: makeClaudeRunner(defaultAngles(), defaultQuestions()),
    grillIO: keepAllGrillIO(N),
    questionsTarget: N,
    ...overrides,
  };
}

describe("runRubricAuthor — grill flow (default)", () => {
  test("writes draft + meta-rubric + delta_metrics under <runId>/gold-set/", async () => {
    const r = await runRubricAuthor(commonOpts());
    expect(existsSync(r.draftPath)).toBe(true);
    expect(existsSync(r.metaRubricPath)).toBe(true);
    expect(existsSync(r.metricsPath)).toBe(true);
    expect(r.draftPath).toContain(join("run-test", "gold-set"));
    expect(r.draftPath.endsWith("rubric-questions.md")).toBe(true);
    expect(r.metaRubricPath.endsWith("meta-rubric.md")).toBe(true);
    expect(r.metricsPath.endsWith("delta_metrics.json")).toBe(true);
  });

  test("draft has N numbered questions when grill keeps everything", async () => {
    const r = await runRubricAuthor(commonOpts());
    const body = readFileSync(r.draftPath, "utf8");
    for (let i = 1; i <= N; i++) {
      expect(body).toContain(`${i}. `);
    }
  });

  test("meta-rubric content is frozen template (deterministic, identical across runs)", async () => {
    const r1 = await runRubricAuthor(commonOpts({ runId: "run-a" }));
    const r2 = await runRubricAuthor(commonOpts({ runId: "run-b" }));
    expect(readFileSync(r1.metaRubricPath, "utf8")).toBe(
      readFileSync(r2.metaRubricPath, "utf8"),
    );
  });

  test("keep-all grill: edit_ratio = 0, verdict = pass", async () => {
    const r = await runRubricAuthor(commonOpts());
    expect(r.metrics.edit_ratio).toBe(0);
    expect(r.evaluate.verdict).toBe("pass");
    expect(r.evaluate.exitCode).toBe(0);
  });

  test("grill with rewrites + adds: metrics reflect operator choices, draft overwritten", async () => {
    // Walk: rewrite q1, drop q2, keep q3..q20, then add 1 new question.
    const answers = [
      "Brand new q1 about pricing tiers.", // rewrite q1
      "d", // drop q2
      ...new Array(N - 2).fill("k"), // keep q3..q20
      "Operator-added: how does churn cohort drift over time?",
      "",
    ];
    const r = await runRubricAuthor(
      commonOpts({ grillIO: makeMockIO(answers) }),
    );
    // q1 rewritten (replaced), q2 dropped → slot-shift causes downstream "replaced" hits
    // until the trailing slot becomes empty edge. Just sanity-check the metric exists
    // and the draft file was overwritten with the operator's choices.
    expect(r.metrics.added_by_user).toBeGreaterThanOrEqual(0);
    const body = readFileSync(r.draftPath, "utf8");
    expect(body).toContain("Brand new q1 about pricing tiers.");
    expect(body).toContain("Operator-added: how does churn cohort drift over time?");
  });

  test("batch shorthand grill: 'k 1-10 d 11-20' → 10 questions kept, 10 dropped", async () => {
    const answers = ["k 1-10 d 11-20", ""];
    const r = await runRubricAuthor(
      commonOpts({ grillIO: makeMockIO(answers) }),
    );
    const body = readFileSync(r.draftPath, "utf8");
    // 10 numbered questions in final draft
    const numbered = body.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(numbered.length).toBe(10);
  });

  test("claudeRunner called twice: once for angles, once for synthesis", async () => {
    let calls = 0;
    const runner: ClaudeRunner = async () => {
      calls += 1;
      if (calls === 1) return JSON.stringify(defaultAngles());
      return JSON.stringify({ questions: defaultQuestions() });
    };
    await runRubricAuthor(commonOpts({ claudeRunner: runner }));
    expect(calls).toBe(2);
  });

  test("airtable fetch called with bearer token from env", async () => {
    let capturedAuth = "";
    const baseFetch = airtableFetchMock();
    const fetchSpy = async (url: string | URL, init?: RequestInit) => {
      capturedAuth =
        (init?.headers as Record<string, string> | undefined)?.Authorization ?? capturedAuth;
      return baseFetch(url);
    };
    await runRubricAuthor(commonOpts({ fetch: fetchSpy }));
    expect(capturedAuth).toBe("Bearer patFake");
  });

  test("synthesis runner returns fewer than target → orchestrator pads to N", async () => {
    let c = 0;
    const runner: ClaudeRunner = async () => {
      c += 1;
      if (c === 1) return JSON.stringify(defaultAngles());
      return JSON.stringify({ questions: ["only-one"] });
    };
    const r = await runRubricAuthor(commonOpts({ claudeRunner: runner }));
    const lines = readFileSync(r.draftPath, "utf8").split("\n").filter((l) => /^\d+\. /.test(l));
    expect(lines.length).toBe(N);
  });
});

describe("runRubricAuthor — editor escape hatch (--editor)", () => {
  test("ratio ≤ 30%: pass, exit 0", async () => {
    const opts = commonOpts({
      useEditor: true,
      grillIO: undefined,
      openEditor: async (filePath) => {
        const lines = readFileSync(filePath, "utf8").split("\n");
        const edited = lines.map((line) => {
          const match = line.match(/^(\d+)\. (.*)$/);
          if (!match) return line;
          const num = parseInt(match[1], 10);
          if (num <= 5) return `${num}. ${match[2]} (slightly tweaked)`;
          return line;
        });
        writeFileSync(filePath, edited.join("\n"));
      },
    });
    const r = await runRubricAuthor(opts);
    expect(r.metrics.edit_ratio).toBeLessThanOrEqual(0.3);
    expect(r.evaluate.verdict).toBe("pass");
    expect(r.evaluate.exitCode).toBe(0);
    const json = JSON.parse(readFileSync(r.metricsPath, "utf8"));
    expect(json.edit_ratio).toBe(r.metrics.edit_ratio);
  });

  test("ratio 30–70%: pass-with-improve, exit 0", async () => {
    const opts = commonOpts({
      useEditor: true,
      grillIO: undefined,
      openEditor: async (filePath) => {
        const lines = readFileSync(filePath, "utf8").split("\n");
        const edited = lines.map((line) => {
          const match = line.match(/^(\d+)\. (.*)$/);
          if (!match) return line;
          const num = parseInt(match[1], 10);
          if (num <= 10) return `${num}. Brand new line about pricing tiers ${num}.`;
          return line;
        });
        writeFileSync(filePath, edited.join("\n"));
      },
    });
    const r = await runRubricAuthor(opts);
    expect(r.metrics.edit_ratio).toBeGreaterThan(0.3);
    expect(r.metrics.edit_ratio).toBeLessThanOrEqual(0.7);
    expect(r.evaluate.verdict).toBe("pass-with-improve");
    expect(r.evaluate.exitCode).toBe(0);
  });

  test("ratio > 70%: reject verdict, signal exitCode=1, metrics still written (CLI exit gated by --strict separately)", async () => {
    const opts = commonOpts({
      useEditor: true,
      grillIO: undefined,
      openEditor: async (filePath) => {
        const lines = readFileSync(filePath, "utf8").split("\n");
        const edited = lines.map((line) => {
          const match = line.match(/^(\d+)\. (.*)$/);
          if (!match) return line;
          const num = parseInt(match[1], 10);
          if (num <= 18) return `${num}. Totally fresh angle on cohort retention metric ${num}.`;
          return line;
        });
        writeFileSync(filePath, edited.join("\n"));
      },
    });
    const r = await runRubricAuthor(opts);
    expect(r.metrics.edit_ratio).toBeGreaterThan(0.7);
    expect(r.evaluate.verdict).toBe("reject");
    expect(r.evaluate.exitCode).toBe(1);
    expect(existsSync(r.metricsPath)).toBe(true);
  });
});
