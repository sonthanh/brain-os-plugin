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
  buildSelfImproveDecisionNeeded,
  parseSelfImproveDecisionFile,
  defaultExportAndExitPromptUser,
  correctionNeededPathFor,
  correctionDecidedPathFor,
  type RejectBatch,
  type RejectedSlice,
  type UserCorrection,
  type UserPromptFn,
  type ExampleTriple,
} from "../scripts/self-improve.mts";
import { HitlPendingError } from "../scripts/hitl.mts";

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

  // -------------------------------------------------------------------------
  // Export-and-exit HITL pattern (issue #232)
  // -------------------------------------------------------------------------

  test("default flow: no decision files → throws HitlPendingError listing all rejects' needed-paths; examples.jsonl untouched", async () => {
    const basePath = makeBaseDir("appA");
    const rejects = [makeReject("s1", { slug: "a" }), makeReject("s2", { slug: "b" })];

    let caught: HitlPendingError | null = null;
    try {
      await selfImprove(
        {
          batch: { base_id: "appA", rung: 0, rejects },
          basePath,
        },
        // no promptUser override → uses defaultExportAndExitPromptUser
        { now: fixedNow(["2026-04-29T00:00:00Z"]) },
      );
    } catch (err) {
      caught = err as HitlPendingError;
    }
    expect(caught).toBeInstanceOf(HitlPendingError);
    expect(caught!.neededPaths).toHaveLength(2);

    const correctionsDir = join(basePath, "corrections");
    expect(caught!.neededPaths[0]).toBe(
      join(correctionsDir, "correction-needed-s1.json"),
    );
    expect(caught!.neededPaths[1]).toBe(
      join(correctionsDir, "correction-needed-s2.json"),
    );

    for (const p of caught!.neededPaths) {
      expect(existsSync(p)).toBe(true);
      const obj = JSON.parse(readFileSync(p, "utf8"));
      expect(obj.phase).toBe("self-improve");
      expect(obj.base_id).toBe("appA");
      expect(typeof obj.wake_token).toBe("string");
      expect(obj.wake_token.length).toBeGreaterThan(0);
    }

    expect(existsSync(join(basePath, "examples.jsonl"))).toBe(false);
  });

  test("default flow: all decision files present → reads them, writes triples, deletes decision files", async () => {
    const basePath = makeBaseDir("appA");
    const correctionsDir = join(basePath, "corrections");
    mkdirSync(correctionsDir, { recursive: true });
    const rejects = [
      makeReject("s1", { slug: "a" }),
      makeReject("s2", { slug: "b" }),
    ];
    writeFileSync(
      correctionDecidedPathFor(basePath, "s1"),
      JSON.stringify({ corrected: { slug: "a-fixed" }, reason: "r1" }),
    );
    writeFileSync(
      correctionDecidedPathFor(basePath, "s2"),
      JSON.stringify({ corrected: { slug: "b-fixed" }, reason: "r2" }),
    );

    const result = await selfImprove(
      {
        batch: { base_id: "appA", rung: 0, rejects },
        basePath,
      },
      { now: fixedNow(["t1", "t2"]) },
    );

    expect(result.appended).toBe(2);
    expect(existsSync(correctionDecidedPathFor(basePath, "s1"))).toBe(false);
    expect(existsSync(correctionDecidedPathFor(basePath, "s2"))).toBe(false);
    const lines = readFileSync(result.examples_path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).slice_id).toBe("s1");
    expect(JSON.parse(lines[0]).corrected).toEqual({ slug: "a-fixed" });
    expect(JSON.parse(lines[1]).slice_id).toBe("s2");
  });

  test("default flow: partial decisions present → throws with paths for the MISSING ones only; existing decisions not consumed", async () => {
    const basePath = makeBaseDir("appA");
    const correctionsDir = join(basePath, "corrections");
    mkdirSync(correctionsDir, { recursive: true });
    const rejects = [
      makeReject("s1"),
      makeReject("s2"),
      makeReject("s3"),
    ];
    writeFileSync(
      correctionDecidedPathFor(basePath, "s2"),
      JSON.stringify({ corrected: { slug: "fixed" }, reason: "r" }),
    );

    let caught: HitlPendingError | null = null;
    try {
      await selfImprove(
        {
          batch: { base_id: "appA", rung: 0, rejects },
          basePath,
        },
        { now: fixedNow(["t1"]) },
      );
    } catch (err) {
      caught = err as HitlPendingError;
    }
    expect(caught).toBeInstanceOf(HitlPendingError);
    expect(caught!.neededPaths).toHaveLength(2);
    expect(caught!.neededPaths).toContain(
      correctionNeededPathFor(basePath, "s1"),
    );
    expect(caught!.neededPaths).toContain(
      correctionNeededPathFor(basePath, "s3"),
    );
    // Existing decision file for s2 is not consumed yet (atomic two-pass).
    expect(existsSync(correctionDecidedPathFor(basePath, "s2"))).toBe(true);
    expect(existsSync(join(basePath, "examples.jsonl"))).toBe(false);
  });

  test("default flow: malformed decision file → throws (not silently treated as missing)", async () => {
    const basePath = makeBaseDir("appA");
    const correctionsDir = join(basePath, "corrections");
    mkdirSync(correctionsDir, { recursive: true });
    writeFileSync(correctionDecidedPathFor(basePath, "s1"), "not-json");

    await expect(
      selfImprove(
        {
          batch: { base_id: "appA", rung: 0, rejects: [makeReject("s1")] },
          basePath,
        },
        { now: fixedNow(["t1"]) },
      ),
    ).rejects.toThrow(/parse|JSON/i);
  });

  test("default flow: decision missing reason → throws (validation)", async () => {
    const basePath = makeBaseDir("appA");
    const correctionsDir = join(basePath, "corrections");
    mkdirSync(correctionsDir, { recursive: true });
    writeFileSync(
      correctionDecidedPathFor(basePath, "s1"),
      JSON.stringify({ corrected: { slug: "x" } }),
    );

    await expect(
      selfImprove(
        {
          batch: { base_id: "appA", rung: 0, rejects: [makeReject("s1")] },
          basePath,
        },
        { now: fixedNow(["t1"]) },
      ),
    ).rejects.toThrow(/reason/);
  });

  test("buildSelfImproveDecisionNeeded shape includes phase, slice_id, raw, reasoning, fail_modes, decision_path, wake_token", () => {
    const reject = makeReject("s1", { slug: "x", entities: ["a", "b"] });
    const payload = buildSelfImproveDecisionNeeded({
      reject,
      baseId: "appA",
      rung: 1,
      decisionPath: "/tmp/c/correction-decided-s1.json",
      wakeToken: "wt-fixed-77",
    });
    expect(payload.phase).toBe("self-improve");
    expect(payload.base_id).toBe("appA");
    expect(payload.rung).toBe(1);
    expect(payload.slice_id).toBe("s1");
    expect(payload.raw).toEqual({ slug: "x", entities: ["a", "b"] });
    expect(payload.reasoning).toBe(reject.reasoning);
    expect(payload.fail_modes).toEqual(["link-mismatch"]);
    expect(payload.decision_path).toBe("/tmp/c/correction-decided-s1.json");
    expect(payload.wake_token).toBe("wt-fixed-77");
  });

  test("parseSelfImproveDecisionFile maps {corrected, reason} → UserCorrection", () => {
    const c = parseSelfImproveDecisionFile(
      JSON.stringify({ corrected: { slug: "x-fixed" }, reason: "slug-collision" }),
    );
    expect(c.corrected).toEqual({ slug: "x-fixed" });
    expect(c.reason).toBe("slug-collision");
  });

  test("parseSelfImproveDecisionFile rejects non-string reason", () => {
    expect(() =>
      parseSelfImproveDecisionFile(
        JSON.stringify({ corrected: {}, reason: 42 }),
      ),
    ).toThrow(/reason/);
  });

  test("parseSelfImproveDecisionFile rejects missing corrected key", () => {
    expect(() =>
      parseSelfImproveDecisionFile(JSON.stringify({ reason: "x" })),
    ).toThrow(/corrected/);
  });

  test("defaultExportAndExitPromptUser direct: writes needed file + throws", async () => {
    const basePath = makeBaseDir("appA");
    const correctionsDir = join(basePath, "corrections");
    const promptUser = defaultExportAndExitPromptUser({ uuid: () => "wt-1" });
    const reject = makeReject("s1", { slug: "x" });

    let caught: HitlPendingError | null = null;
    try {
      await promptUser(reject, {
        base_id: "appA",
        rung: 0,
        workspaceDir: correctionsDir,
      });
    } catch (err) {
      caught = err as HitlPendingError;
    }
    expect(caught).toBeInstanceOf(HitlPendingError);
    const neededPath = correctionNeededPathFor(basePath, "s1");
    expect(caught!.neededPaths).toEqual([neededPath]);
    expect(existsSync(neededPath)).toBe(true);
    const obj = JSON.parse(readFileSync(neededPath, "utf8"));
    expect(obj.wake_token).toBe("wt-1");
  });

  test("defaultExportAndExitPromptUser direct: decision file present → returns parsed correction; file deleted", async () => {
    const basePath = makeBaseDir("appA");
    const correctionsDir = join(basePath, "corrections");
    mkdirSync(correctionsDir, { recursive: true });
    const decisionPath = correctionDecidedPathFor(basePath, "s1");
    writeFileSync(
      decisionPath,
      JSON.stringify({ corrected: { slug: "fixed" }, reason: "r" }),
    );

    const promptUser = defaultExportAndExitPromptUser({});
    const c = await promptUser(makeReject("s1"), {
      base_id: "appA",
      rung: 0,
      workspaceDir: correctionsDir,
    });
    expect(c.corrected).toEqual({ slug: "fixed" });
    expect(c.reason).toBe("r");
    expect(existsSync(decisionPath)).toBe(false);
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
