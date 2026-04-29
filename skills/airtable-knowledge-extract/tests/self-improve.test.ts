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
  selfImprove,
  parseRejectBatch,
  buildTriple,
  appendTriples,
  type RejectBatch,
  type RejectedSlice,
  type UserCorrection,
  type UserPromptFn,
  type ExampleTriple,
} from "../scripts/self-improve.mts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "self-improve-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeBaseDir(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeReject(id: string, raw: unknown = { slug: id }): RejectedSlice {
  return {
    slice_id: id,
    raw,
    reasoning: `Reviewer rejected ${id}: link-mismatch on field X.`,
    fail_modes: ["link-mismatch"],
  };
}

function fixedNow(seq: string[]): () => string {
  let i = 0;
  return () => seq[Math.min(i++, seq.length - 1)];
}

function mockPrompt(
  responses: Record<string, UserCorrection>,
  callLog?: RejectedSlice[],
): UserPromptFn {
  return async (reject) => {
    callLog?.push(reject);
    const r = responses[reject.slice_id];
    if (!r) throw new Error(`mockPrompt: no response for ${reject.slice_id}`);
    return r;
  };
}

// ---------------------------------------------------------------------------
// parseRejectBatch
// ---------------------------------------------------------------------------

describe("parseRejectBatch", () => {
  test("valid input parses with defaults", () => {
    const batch = parseRejectBatch({
      base_id: "appBase",
      rejects: [{ slice_id: "s1", raw: {}, reasoning: "r" }],
    });
    expect(batch.base_id).toBe("appBase");
    expect(batch.rung).toBe(0);
    expect(batch.rejects).toHaveLength(1);
  });

  test("rung defaults to 0 when omitted", () => {
    const batch = parseRejectBatch({
      base_id: "appBase",
      rejects: [],
    });
    expect(batch.rung).toBe(0);
  });

  test("rung honored when provided", () => {
    const batch = parseRejectBatch({
      base_id: "appBase",
      rung: 1,
      rejects: [],
    });
    expect(batch.rung).toBe(1);
  });

  test("missing base_id throws", () => {
    expect(() =>
      parseRejectBatch({ rejects: [] } as unknown as RejectBatch),
    ).toThrow(/base_id/);
  });

  test("missing rejects throws", () => {
    expect(() =>
      parseRejectBatch({ base_id: "x" } as unknown as RejectBatch),
    ).toThrow(/rejects/);
  });

  test("rejects must be array", () => {
    expect(() =>
      parseRejectBatch({
        base_id: "x",
        rejects: "nope" as unknown as RejectedSlice[],
      }),
    ).toThrow(/rejects/);
  });

  test("each reject must have slice_id, raw, reasoning", () => {
    expect(() =>
      parseRejectBatch({
        base_id: "x",
        rejects: [{ slice_id: "s1" } as unknown as RejectedSlice],
      }),
    ).toThrow(/raw|reasoning/);
  });

  test("rung outside {0,1} rejected", () => {
    expect(() =>
      parseRejectBatch({
        base_id: "x",
        rung: 2 as 0 | 1,
        rejects: [],
      }),
    ).toThrow(/rung/);
  });
});

// ---------------------------------------------------------------------------
// buildTriple
// ---------------------------------------------------------------------------

describe("buildTriple", () => {
  test("captures slice_id, raw, corrected, reason, ts", () => {
    const reject = makeReject("s1", { slug: "x" });
    const correction: UserCorrection = {
      corrected: { slug: "x-fixed" },
      reason: "slug-collision; fixed by appending -fixed",
    };
    const triple = buildTriple(reject, correction, "2026-04-29T00:00:00Z");
    expect(triple).toEqual({
      ts: "2026-04-29T00:00:00Z",
      slice_id: "s1",
      raw: { slug: "x" },
      corrected: { slug: "x-fixed" },
      reason: "slug-collision; fixed by appending -fixed",
    });
  });

  test("preserves complex nested raw shapes", () => {
    const raw = {
      entities: [{ slug: "a", links: ["b", "c"] }],
      meta: { cluster: "crm" },
    };
    const reject = makeReject("s2", raw);
    const triple = buildTriple(
      reject,
      { corrected: raw, reason: "no-op" },
      "2026-04-29T00:00:00Z",
    );
    expect(triple.raw).toEqual(raw);
    expect(triple.corrected).toEqual(raw);
  });
});

// ---------------------------------------------------------------------------
// appendTriples — file shape + atomicity
// ---------------------------------------------------------------------------

describe("appendTriples", () => {
  test("creates examples.jsonl when absent and appends one triple per line", () => {
    const basePath = makeBaseDir("appA");
    const triples: ExampleTriple[] = [
      {
        ts: "2026-04-29T00:00:00Z",
        slice_id: "s1",
        raw: { slug: "x" },
        corrected: { slug: "x-fixed" },
        reason: "slug-collision",
      },
      {
        ts: "2026-04-29T00:00:01Z",
        slice_id: "s2",
        raw: { slug: "y" },
        corrected: { slug: "y-fixed" },
        reason: "link-mismatch",
      },
    ];
    appendTriples(basePath, triples);
    const path = join(basePath, "examples.jsonl");
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(triples[0]);
    expect(JSON.parse(lines[1])).toEqual(triples[1]);
  });

  test("appends to existing file without overwriting prior entries", () => {
    const basePath = makeBaseDir("appA");
    const path = join(basePath, "examples.jsonl");
    const prior = {
      ts: "2026-04-28T00:00:00Z",
      slice_id: "s0",
      raw: { slug: "old" },
      corrected: { slug: "old-fixed" },
      reason: "fact-invented",
    };
    writeFileSync(path, `${JSON.stringify(prior)}\n`);

    appendTriples(basePath, [
      {
        ts: "2026-04-29T00:00:00Z",
        slice_id: "s1",
        raw: { slug: "x" },
        corrected: { slug: "x-fixed" },
        reason: "slug-collision",
      },
    ]);

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(prior);
    expect(JSON.parse(lines[1]).slice_id).toBe("s1");
  });

  test("empty triples list is no-op and does not touch file", () => {
    const basePath = makeBaseDir("appA");
    appendTriples(basePath, []);
    expect(existsSync(join(basePath, "examples.jsonl"))).toBe(false);
  });

  test("each line is parseable JSON terminated by newline", () => {
    const basePath = makeBaseDir("appA");
    const triples: ExampleTriple[] = [
      {
        ts: "2026-04-29T00:00:00Z",
        slice_id: "s1",
        raw: {},
        corrected: {},
        reason: "r",
      },
    ];
    appendTriples(basePath, triples);
    const content = readFileSync(join(basePath, "examples.jsonl"), "utf8");
    expect(content.endsWith("\n")).toBe(true);
    for (const ln of content.trim().split("\n")) {
      expect(() => JSON.parse(ln)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// selfImprove — full flow with mocked user input
// ---------------------------------------------------------------------------

describe("selfImprove", () => {
  test("empty rejects → 0 appended, examples.jsonl not touched, prompt never called", async () => {
    const basePath = makeBaseDir("appA");
    const callLog: RejectedSlice[] = [];
    const result = await selfImprove(
      {
        batch: { base_id: "appA", rung: 0, rejects: [] },
        basePath,
      },
      {
        promptUser: mockPrompt({}, callLog),
        now: fixedNow(["2026-04-29T00:00:00Z"]),
      },
    );
    expect(result.appended).toBe(0);
    expect(result.triples).toHaveLength(0);
    expect(callLog).toHaveLength(0);
    expect(existsSync(join(basePath, "examples.jsonl"))).toBe(false);
  });

  test("single reject → mock fires, triple appended with full shape", async () => {
    const basePath = makeBaseDir("appA");
    const callLog: RejectedSlice[] = [];
    const reject = makeReject("s1", { slug: "x" });
    const result = await selfImprove(
      {
        batch: { base_id: "appA", rung: 0, rejects: [reject] },
        basePath,
      },
      {
        promptUser: mockPrompt(
          {
            s1: {
              corrected: { slug: "x-fixed" },
              reason: "slug-collision",
            },
          },
          callLog,
        ),
        now: fixedNow(["2026-04-29T00:00:00Z"]),
      },
    );
    expect(callLog).toHaveLength(1);
    expect(callLog[0].slice_id).toBe("s1");
    expect(result.appended).toBe(1);
    expect(result.examples_path).toBe(join(basePath, "examples.jsonl"));

    const line = readFileSync(result.examples_path, "utf8").trim();
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      ts: "2026-04-29T00:00:00Z",
      slice_id: "s1",
      raw: { slug: "x" },
      corrected: { slug: "x-fixed" },
      reason: "slug-collision",
    });
  });

  test("multiple rejects → all triples appended in input order", async () => {
    const basePath = makeBaseDir("appA");
    const rejects = [
      makeReject("s1", { slug: "a" }),
      makeReject("s2", { slug: "b" }),
      makeReject("s3", { slug: "c" }),
    ];
    const result = await selfImprove(
      {
        batch: { base_id: "appA", rung: 0, rejects },
        basePath,
      },
      {
        promptUser: mockPrompt({
          s1: { corrected: { slug: "a-fixed" }, reason: "r1" },
          s2: { corrected: { slug: "b-fixed" }, reason: "r2" },
          s3: { corrected: { slug: "c-fixed" }, reason: "r3" },
        }),
        now: fixedNow([
          "2026-04-29T00:00:00Z",
          "2026-04-29T00:00:01Z",
          "2026-04-29T00:00:02Z",
        ]),
      },
    );
    expect(result.appended).toBe(3);
    const lines = readFileSync(result.examples_path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.map((ln) => JSON.parse(ln).slice_id)).toEqual([
      "s1",
      "s2",
      "s3",
    ]);
  });

  test("cross-base isolation: writing to baseA leaves baseB untouched", async () => {
    const baseA = makeBaseDir("appA");
    const baseB = makeBaseDir("appB");
    const baseBExamples = join(baseB, "examples.jsonl");
    const priorB = {
      ts: "2026-04-28T00:00:00Z",
      slice_id: "old",
      raw: {},
      corrected: {},
      reason: "preexisting baseB entry",
    };
    writeFileSync(baseBExamples, `${JSON.stringify(priorB)}\n`);

    await selfImprove(
      {
        batch: {
          base_id: "appA",
          rung: 0,
          rejects: [makeReject("s1")],
        },
        basePath: baseA,
      },
      {
        promptUser: mockPrompt({
          s1: { corrected: { slug: "s1-fixed" }, reason: "fixed" },
        }),
        now: fixedNow(["2026-04-29T00:00:00Z"]),
      },
    );

    expect(existsSync(join(baseA, "examples.jsonl"))).toBe(true);
    const baseBContent = readFileSync(baseBExamples, "utf8");
    expect(baseBContent).toBe(`${JSON.stringify(priorB)}\n`);
  });

  test("appends to pre-existing baseA examples.jsonl without overwriting", async () => {
    const basePath = makeBaseDir("appA");
    const path = join(basePath, "examples.jsonl");
    const prior = {
      ts: "2026-04-28T00:00:00Z",
      slice_id: "s0",
      raw: {},
      corrected: {},
      reason: "earlier rejection",
    };
    writeFileSync(path, `${JSON.stringify(prior)}\n`);

    await selfImprove(
      {
        batch: { base_id: "appA", rung: 0, rejects: [makeReject("s1")] },
        basePath,
      },
      {
        promptUser: mockPrompt({
          s1: { corrected: { slug: "s1-fixed" }, reason: "fixed" },
        }),
        now: fixedNow(["2026-04-29T00:00:00Z"]),
      },
    );

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(prior);
    expect(JSON.parse(lines[1]).slice_id).toBe("s1");
  });

  test("notify is called once per reject (rung-0 HITL surface)", async () => {
    const basePath = makeBaseDir("appA");
    const notifyLog: { title: string; body: string }[] = [];
    const rejects = [makeReject("s1"), makeReject("s2")];
    await selfImprove(
      {
        batch: { base_id: "appA", rung: 0, rejects },
        basePath,
      },
      {
        promptUser: mockPrompt({
          s1: { corrected: {}, reason: "r1" },
          s2: { corrected: {}, reason: "r2" },
        }),
        notify: (title, body) => notifyLog.push({ title, body }),
        now: fixedNow(["t1", "t2"]),
      },
    );
    expect(notifyLog).toHaveLength(2);
    expect(notifyLog[0].title).toMatch(/airtable-knowledge-extract/);
    expect(notifyLog[0].body).toMatch(/s1/);
    expect(notifyLog[1].body).toMatch(/s2/);
  });

  test("missing basePath throws before any prompt fires", async () => {
    const callLog: RejectedSlice[] = [];
    await expect(
      selfImprove(
        {
          batch: { base_id: "appA", rung: 0, rejects: [makeReject("s1")] },
          basePath: "",
        },
        { promptUser: mockPrompt({}, callLog) },
      ),
    ).rejects.toThrow(/basePath/);
    expect(callLog).toHaveLength(0);
  });

  test("promptUser returning invalid correction (missing reason) rejects", async () => {
    const basePath = makeBaseDir("appA");
    await expect(
      selfImprove(
        {
          batch: { base_id: "appA", rung: 0, rejects: [makeReject("s1")] },
          basePath,
        },
        {
          promptUser: async () =>
            ({ corrected: {} } as unknown as UserCorrection),
          now: fixedNow(["t1"]),
        },
      ),
    ).rejects.toThrow(/reason/);
    expect(existsSync(join(basePath, "examples.jsonl"))).toBe(false);
  });
});
