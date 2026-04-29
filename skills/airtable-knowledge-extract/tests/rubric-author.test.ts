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
  runRubricAuthor,
  type ClaudeRunner,
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
    openEditor: async () => {},
    questionsTarget: N,
    ...overrides,
  };
}

describe("runRubricAuthor", () => {
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

  test("draft has N numbered questions", async () => {
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

  test("ratio ≤ 30%: pass, exit 0, mark ready", async () => {
    const opts = commonOpts({
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

  test("ratio > 70%: reject, exit 1, metrics still written", async () => {
    const opts = commonOpts({
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
