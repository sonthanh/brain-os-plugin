import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runOrchestrator,
  resolveLayout,
  chunk,
  initState,
  nextBaseToProcess,
  formatBaseSummaryJsonl,
  rejectsFromVerdict,
  parseReAnchorSubprocessOutcome,
  type RunState,
  type RunDeps,
  type RunArgs,
  type BaseProgress,
  type ReAnchorOutcome,
} from "../scripts/run.mts";
import { HitlPendingError } from "../scripts/hitl.mts";
import {
  readStatus,
  formatStatusLine,
  type StatusDeps,
} from "../scripts/status.mts";
import {
  reviewBatch,
  type BatchVerdict,
  type OpusRunner,
  type ReviewBatchInput,
  type SliceForReview,
  type SliceVerdict,
} from "../scripts/review-slice.mts";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtractedEntity,
} from "../scripts/extract-slice.mts";
import type {
  SeedForReAnchor,
  ExtractResultLite,
} from "../scripts/re-anchor.mts";
import type {
  RejectBatch,
  SelfImproveResult,
} from "../scripts/self-improve.mts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "run-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function entity(id: string): ExtractedEntity {
  return {
    type: "person",
    slug: id,
    body: `Body for ${id}.`,
    source_record_ids: [id],
  };
}

function seed(baseId: string, recId: string): SeedForReAnchor {
  return {
    recordId: recId,
    baseId,
    clusterId: `${baseId}-cluster-1`,
    clusterType: "crm",
    tableIds: [`${baseId}-tA`],
  };
}

function extractLite(s: SeedForReAnchor): ExtractResultLite {
  return {
    sliceId: `${s.baseId}-${s.recordId}`,
    baseId: s.baseId,
    clusterId: s.clusterId,
    clusterType: s.clusterType,
    subgraph: `### ${s.tableIds[0]}\n- record ${s.recordId}`,
    entities: [entity(s.recordId)],
  };
}

function passingVerdict(sliceId: string, score = 0.95): SliceVerdict {
  return {
    slice_id: sliceId,
    score,
    pass: true,
    reasoning: "ok",
    fail_modes: [],
  };
}

function failingVerdict(sliceId: string): SliceVerdict {
  return {
    slice_id: sliceId,
    score: 0.5,
    pass: false,
    reasoning: "links broken",
    fail_modes: ["link-mismatch"],
  };
}

function batchVerdict(
  baseId: string,
  slices: SliceVerdict[],
  threshold = 0.95,
): BatchVerdict {
  const passed = slices.filter((s) => s.pass).length;
  const passRate = slices.length === 0 ? 0 : passed / slices.length;
  return {
    batch_id: `bv-${baseId}`,
    base_id: baseId,
    pass_rate: passRate,
    pass: passRate >= threshold,
    threshold,
    slices,
    usage: { input_tokens: 200, output_tokens: 80 },
    model: "claude-opus-4-6",
  };
}

interface Harness {
  deps: RunDeps;
  loaded: () => RunState | null;
  metricsWritten: { baseId: string; rung: number; lines: string[] }[];
  notifies: { title: string; body: string }[];
  signals: number[];
  reAnchorCalls: { runId: string; baseId: string | null | undefined }[];
  selfImproveCalls: { baseId: string; rejects: number }[];
  reviewCalls: ReviewBatchInput[];
  extractCalls: SeedForReAnchor[];
  guardStarts: number;
}

interface HarnessOpts {
  initialState?: RunState | null;
  seedsByBase: Record<string, SeedForReAnchor[]>;
  reAnchorDecisions: Record<
    string,
    "approve" | "reject" | "no-op" | "hitl-pending"
  >;
  reAnchorNeededPaths?: Record<string, string[]>;
  selfImproveBehavior?: Record<string, "ok" | "hitl-pending">;
  selfImproveNeededPaths?: Record<string, string[]>;
  verdictsByBatch: BatchVerdict[];
  basesDir: string;
  metricsDir: string;
}

function makeHarness(opts: HarnessOpts): Harness {
  let state: RunState | null = opts.initialState
    ? JSON.parse(JSON.stringify(opts.initialState))
    : null;
  const verdictQueue = [...opts.verdictsByBatch];
  const reAnchorCalls: Harness["reAnchorCalls"] = [];
  const selfImproveCalls: Harness["selfImproveCalls"] = [];
  const reviewCalls: ReviewBatchInput[] = [];
  const extractCalls: SeedForReAnchor[] = [];
  const metricsWritten: Harness["metricsWritten"] = [];
  const notifies: Harness["notifies"] = [];
  const signals: number[] = [];
  let guardStarts = 0;

  const deps: RunDeps = {
    loadState: () => (state ? JSON.parse(JSON.stringify(state)) : null),
    saveState: (s) => {
      state = JSON.parse(JSON.stringify(s));
    },
    startGuard: () => {
      guardStarts++;
      return 99000 + guardStarts;
    },
    runReAnchor: async (runId) => {
      const cur = state;
      const baseId = cur?.current_base ?? null;
      reAnchorCalls.push({ runId, baseId });
      if (!baseId) return { kind: "no-op" };
      const decision = opts.reAnchorDecisions[baseId] ?? "approve";
      if (decision === "no-op") return { kind: "no-op", baseId };
      if (decision === "approve") {
        const confirmed = cur?.confirmed_bases ?? [];
        const next = confirmed.includes(baseId) ? confirmed : [...confirmed, baseId];
        state = {
          ...(cur as RunState),
          confirmed_bases: next,
          previous_base: baseId,
        };
        return { kind: "approved", baseId };
      }
      if (decision === "hitl-pending") {
        const neededPaths =
          opts.reAnchorNeededPaths?.[baseId] ?? [
            join(opts.basesDir, baseId, "hitl", "re-anchor-decision-needed.json"),
          ];
        return { kind: "hitl-pending", baseId, neededPaths };
      }
      state = { ...(cur as RunState), phase: "escalated" };
      return { kind: "rejected", baseId };
    },
    getSeedsForBase: async (baseId) => {
      const list = opts.seedsByBase[baseId];
      if (!list) throw new Error(`fixture: no seeds for ${baseId}`);
      return list;
    },
    runExtract: async (s) => {
      extractCalls.push(s);
      return extractLite(s);
    },
    runReview: async (input) => {
      reviewCalls.push(input);
      const v = verdictQueue.shift();
      if (!v) throw new Error(`fixture: review queue empty for ${input.batchId}`);
      return { ...v, batch_id: input.batchId, base_id: input.baseId };
    },
    runSelfImprove: async ({ batch }) => {
      selfImproveCalls.push({
        baseId: batch.base_id,
        rejects: batch.rejects.length,
      });
      const behavior = opts.selfImproveBehavior?.[batch.base_id];
      if (behavior === "hitl-pending") {
        const neededPaths =
          opts.selfImproveNeededPaths?.[batch.base_id] ??
          batch.rejects.map((r) =>
            join(
              opts.basesDir,
              batch.base_id,
              "corrections",
              `correction-needed-${r.slice_id}.json`,
            ),
          );
        throw new HitlPendingError(neededPaths);
      }
      const result: SelfImproveResult = {
        base_id: batch.base_id,
        rung: batch.rung ?? 0,
        examples_path: join(opts.basesDir, batch.base_id, "examples.jsonl"),
        appended: batch.rejects.length,
        triples: [],
      };
      return result;
    },
    basePathFor: (baseId) => join(opts.basesDir, baseId),
    writeMetrics: (baseId, rung, lines) => {
      metricsWritten.push({ baseId, rung, lines });
      const dir = join(opts.metricsDir);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `base-${baseId}-rung-${rung}.jsonl`);
      writeFileSync(path, lines.map((l) => `${l}\n`).join(""));
      return path;
    },
    notify: (title, body) => notifies.push({ title, body }),
    signal: (pid) => signals.push(pid),
    now: () => "2026-04-29T00:00:00Z",
    log: () => {},
    uuid: () => "fixed-uuid",
  };

  return {
    deps,
    loaded: () => (state ? JSON.parse(JSON.stringify(state)) : null),
    metricsWritten,
    notifies,
    signals,
    reAnchorCalls,
    selfImproveCalls,
    reviewCalls,
    extractCalls,
    guardStarts,
  };
}

function defaultArgs(overrides: Partial<RunArgs> = {}): RunArgs {
  return {
    runId: "run-x",
    parallelism: 2,
    threshold: 0.95,
    maxConsecFails: 2,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("chunk", () => {
  test("splits into size-N groups", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  test("size larger than input → single group", () => {
    expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
  });

  test("empty input → empty output", () => {
    expect(chunk([], 3)).toEqual([]);
  });

  test("size=0 throws", () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});

describe("nextBaseToProcess", () => {
  test("returns first non-done base in processing_order", () => {
    const s = initState("run-x", "2026-04-29T00:00:00Z");
    s.processing_order = ["appA", "appB", "appC"];
    s.base_progress.appA = mockProgress("appA", "done");
    s.base_progress.appB = mockProgress("appB", "rung-1");
    expect(nextBaseToProcess(s)).toBe("appB");
  });

  test("returns null when all done", () => {
    const s = initState("run-x", "2026-04-29T00:00:00Z");
    s.processing_order = ["appA"];
    s.base_progress.appA = mockProgress("appA", "done");
    expect(nextBaseToProcess(s)).toBe(null);
  });

  test("returns first base when none started", () => {
    const s = initState("run-x", "2026-04-29T00:00:00Z");
    s.processing_order = ["appA", "appB"];
    expect(nextBaseToProcess(s)).toBe("appA");
  });
});

function mockProgress(baseId: string, phase: BaseProgress["phase"]): BaseProgress {
  return {
    base_id: baseId,
    rung: 1,
    total_batches: 1,
    batches_done: 1,
    consec_fails: 0,
    phase,
    batch_results: [],
    started_ts: "2026-04-29T00:00:00Z",
    finished_ts: phase === "done" ? "2026-04-29T01:00:00Z" : null,
  };
}

describe("formatBaseSummaryJsonl", () => {
  test("emits parseable JSON with batch + summary fields", () => {
    const progress: BaseProgress = {
      base_id: "appA",
      rung: 1,
      total_batches: 2,
      batches_done: 2,
      consec_fails: 0,
      phase: "done",
      started_ts: "2026-04-29T00:00:00Z",
      finished_ts: "2026-04-29T01:00:00Z",
      batch_results: [
        {
          batch_id: "b1",
          attempt: 1,
          parallelism: 2,
          pass_rate: 1.0,
          threshold: 0.95,
          outcome: "pass",
          ts: "2026-04-29T00:30:00Z",
        },
        {
          batch_id: "b2",
          attempt: 1,
          parallelism: 2,
          pass_rate: 1.0,
          threshold: 0.95,
          outcome: "pass",
          ts: "2026-04-29T00:45:00Z",
        },
      ],
    };
    const obj = JSON.parse(formatBaseSummaryJsonl(progress));
    expect(obj.base_id).toBe("appA");
    expect(obj.rung).toBe(1);
    expect(obj.batches_done).toBe(2);
    expect(obj.pass_rate).toBeCloseTo(1, 5);
    expect(obj.batches.length).toBe(2);
    expect(obj.phase).toBe("done");
  });
});

describe("rejectsFromVerdict", () => {
  test("returns one reject per failing slice with raw payload", () => {
    const slices: SliceForReview[] = [
      {
        slice_id: "appA-r1",
        base_id: "appA",
        cluster_id: "appA-c1",
        cluster_type: "crm",
        subgraph: "x",
        entities: [entity("r1")],
      },
      {
        slice_id: "appA-r2",
        base_id: "appA",
        cluster_id: "appA-c1",
        cluster_type: "crm",
        subgraph: "y",
        entities: [entity("r2")],
      },
    ];
    const v = batchVerdict(
      "appA",
      [passingVerdict("appA-r1"), failingVerdict("appA-r2")],
      0.5,
    );
    const rejects = rejectsFromVerdict(slices, v);
    expect(rejects).toHaveLength(1);
    expect(rejects[0].slice_id).toBe("appA-r2");
    expect(rejects[0].fail_modes).toEqual(["link-mismatch"]);
  });
});

// ---------------------------------------------------------------------------
// runOrchestrator — happy path
// ---------------------------------------------------------------------------

describe("runOrchestrator — happy path", () => {
  test("re-anchor approve → 2 batches all pass → metrics written, kind=paused", async () => {
    const seedsA = [
      seed("appA", "r1"),
      seed("appA", "r2"),
      seed("appA", "r3"),
      seed("appA", "r4"),
    ];
    const v1 = batchVerdict("appA", [passingVerdict("appA-r1"), passingVerdict("appA-r2")]);
    const v2 = batchVerdict("appA", [passingVerdict("appA-r3"), passingVerdict("appA-r4")]);

    const harness = makeHarness({
      initialState: null,
      seedsByBase: { appA: seedsA },
      reAnchorDecisions: { appA: "approve" },
      verdictsByBatch: [v1, v2],
      basesDir: join(tmp, "bases"),
      metricsDir: join(tmp, "metrics"),
    });

    const result = await runOrchestrator(
      defaultArgs({ baseId: "appA" }),
      harness.deps,
    );

    expect(result.kind).toBe("paused");
    expect(result.baseId).toBe("appA");

    expect(harness.reAnchorCalls).toHaveLength(1);
    expect(harness.reAnchorCalls[0].baseId).toBe("appA");
    expect(harness.extractCalls).toHaveLength(4);
    expect(harness.reviewCalls).toHaveLength(2);
    expect(harness.selfImproveCalls).toHaveLength(0);

    expect(harness.metricsWritten).toHaveLength(1);
    expect(harness.metricsWritten[0].baseId).toBe("appA");
    expect(harness.metricsWritten[0].rung).toBe(1);

    const finalState = harness.loaded()!;
    expect(finalState.phase).toBe("paused");
    expect(finalState.base_progress.appA.phase).toBe("done");
    expect(finalState.base_progress.appA.batches_done).toBe(2);
    expect(finalState.base_progress.appA.consec_fails).toBe(0);
    expect(finalState.confirmed_bases).toContain("appA");
  });
});

// ---------------------------------------------------------------------------
// runOrchestrator — reviewer fail + retry path
// ---------------------------------------------------------------------------

describe("runOrchestrator — retry path", () => {
  test("batch fails attempt 1 → self-improve → retry passes → kind=paused", async () => {
    const seedsA = [seed("appA", "r1"), seed("appA", "r2")];
    const failV = batchVerdict("appA", [
      failingVerdict("appA-r1"),
      failingVerdict("appA-r2"),
    ]);
    const passV = batchVerdict("appA", [
      passingVerdict("appA-r1"),
      passingVerdict("appA-r2"),
    ]);

    const harness = makeHarness({
      initialState: null,
      seedsByBase: { appA: seedsA },
      reAnchorDecisions: { appA: "approve" },
      verdictsByBatch: [failV, passV],
      basesDir: join(tmp, "bases"),
      metricsDir: join(tmp, "metrics"),
    });

    const result = await runOrchestrator(
      defaultArgs({ baseId: "appA", parallelism: 2 }),
      harness.deps,
    );

    expect(result.kind).toBe("paused");
    expect(harness.selfImproveCalls).toHaveLength(1);
    expect(harness.selfImproveCalls[0].rejects).toBe(2);
    expect(harness.reviewCalls).toHaveLength(2);
    expect(harness.extractCalls).toHaveLength(4);

    const finalState = harness.loaded()!;
    const progress = finalState.base_progress.appA;
    expect(progress.batch_results[0].attempt).toBe(2);
    expect(progress.batch_results[0].outcome).toBe("pass");
    expect(progress.consec_fails).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runOrchestrator — escalate path
// ---------------------------------------------------------------------------

describe("runOrchestrator — escalate path", () => {
  test("2 consec fail-after-retry → kind=escalated-batch, workers signaled", async () => {
    const seedsA = [
      seed("appA", "r1"),
      seed("appA", "r2"),
      seed("appA", "r3"),
      seed("appA", "r4"),
    ];
    const failV1 = batchVerdict("appA", [
      failingVerdict("appA-r1"),
      failingVerdict("appA-r2"),
    ]);
    const stillFailV1 = batchVerdict("appA", [
      failingVerdict("appA-r1"),
      failingVerdict("appA-r2"),
    ]);
    const failV2 = batchVerdict("appA", [
      failingVerdict("appA-r3"),
      failingVerdict("appA-r4"),
    ]);
    const stillFailV2 = batchVerdict("appA", [
      failingVerdict("appA-r3"),
      failingVerdict("appA-r4"),
    ]);

    const harness = makeHarness({
      initialState: null,
      seedsByBase: { appA: seedsA },
      reAnchorDecisions: { appA: "approve" },
      verdictsByBatch: [failV1, stillFailV1, failV2, stillFailV2],
      basesDir: join(tmp, "bases"),
      metricsDir: join(tmp, "metrics"),
    });

    const result = await runOrchestrator(
      defaultArgs({ baseId: "appA" }),
      harness.deps,
    );

    expect(result.kind).toBe("escalated-batch");
    expect(harness.notifies.length).toBeGreaterThan(0);
    expect(harness.signals.length).toBeGreaterThan(0);

    const finalState = harness.loaded()!;
    expect(finalState.phase).toBe("escalated");
    expect(finalState.base_progress.appA.phase).toBe("escalated");
    expect(finalState.base_progress.appA.consec_fails).toBe(2);
    expect(harness.metricsWritten).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// runOrchestrator — re-anchor reject
// ---------------------------------------------------------------------------

describe("runOrchestrator — re-anchor reject", () => {
  test("re-anchor rejected → kind=escalated-re-anchor; no batches processed", async () => {
    const harness = makeHarness({
      initialState: null,
      seedsByBase: { appA: [seed("appA", "r1")] },
      reAnchorDecisions: { appA: "reject" },
      verdictsByBatch: [],
      basesDir: join(tmp, "bases"),
      metricsDir: join(tmp, "metrics"),
    });

    const result = await runOrchestrator(
      defaultArgs({ baseId: "appA" }),
      harness.deps,
    );

    expect(result.kind).toBe("escalated-re-anchor");
    expect(harness.extractCalls).toHaveLength(0);
    expect(harness.reviewCalls).toHaveLength(0);
    expect(harness.metricsWritten).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runOrchestrator — resume from state.json
// ---------------------------------------------------------------------------

describe("runOrchestrator — resume", () => {
  test("state with batches_done=1 → processes only batch 2", async () => {
    const seedsA = [
      seed("appA", "r1"),
      seed("appA", "r2"),
      seed("appA", "r3"),
      seed("appA", "r4"),
    ];
    const v2 = batchVerdict("appA", [
      passingVerdict("appA-r3"),
      passingVerdict("appA-r4"),
    ]);

    const initial: RunState = {
      run_id: "run-x",
      start_ts: "2026-04-29T00:00:00Z",
      last_updated_ts: "2026-04-29T00:30:00Z",
      worker_pids: [],
      guard_pid: 42,
      confirmed_bases: ["appA"],
      previous_base: "appA",
      current_base: "appA",
      phase: "rung-1",
      processing_order: ["appA"],
      base_progress: {
        appA: {
          base_id: "appA",
          rung: 1,
          total_batches: 2,
          batches_done: 1,
          consec_fails: 0,
          phase: "rung-1",
          batch_results: [
            {
              batch_id: "b1",
              attempt: 1,
              parallelism: 2,
              pass_rate: 1,
              threshold: 0.95,
              outcome: "pass",
              ts: "2026-04-29T00:30:00Z",
            },
          ],
          started_ts: "2026-04-29T00:00:00Z",
        },
      },
    };

    const harness = makeHarness({
      initialState: initial,
      seedsByBase: { appA: seedsA },
      reAnchorDecisions: { appA: "no-op" },
      verdictsByBatch: [v2],
      basesDir: join(tmp, "bases"),
      metricsDir: join(tmp, "metrics"),
    });

    const result = await runOrchestrator(
      defaultArgs({ baseId: "appA" }),
      harness.deps,
    );

    expect(result.kind).toBe("paused");
    expect(harness.extractCalls).toHaveLength(2);
    expect(harness.reviewCalls).toHaveLength(1);
    expect(harness.guardStarts).toBe(0);

    const finalState = harness.loaded()!;
    expect(finalState.base_progress.appA.batches_done).toBe(2);
    expect(finalState.base_progress.appA.batch_results).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// runOrchestrator — 2-base sequential
// ---------------------------------------------------------------------------

describe("runOrchestrator — 2-base sequential", () => {
  test("invocation 1 (appA) then invocation 2 (appB) → re-anchor fires for appB", async () => {
    const seedsA = [seed("appA", "rA1"), seed("appA", "rA2")];
    const seedsB = [seed("appB", "rB1"), seed("appB", "rB2")];
    const vA = batchVerdict("appA", [
      passingVerdict("appA-rA1"),
      passingVerdict("appA-rA2"),
    ]);
    const vB = batchVerdict("appB", [
      passingVerdict("appB-rB1"),
      passingVerdict("appB-rB2"),
    ]);

    const harness = makeHarness({
      initialState: null,
      seedsByBase: { appA: seedsA, appB: seedsB },
      reAnchorDecisions: { appA: "approve", appB: "approve" },
      verdictsByBatch: [vA, vB],
      basesDir: join(tmp, "bases"),
      metricsDir: join(tmp, "metrics"),
    });

    const r1 = await runOrchestrator(
      defaultArgs({ baseId: "appA", parallelism: 2 }),
      harness.deps,
    );
    expect(r1.kind).toBe("paused");

    const r2 = await runOrchestrator(
      defaultArgs({ baseId: "appB", parallelism: 2 }),
      harness.deps,
    );
    expect(r2.kind).toBe("paused");

    expect(harness.reAnchorCalls).toHaveLength(2);
    expect(harness.reAnchorCalls[0].baseId).toBe("appA");
    expect(harness.reAnchorCalls[1].baseId).toBe("appB");

    const finalState = harness.loaded()!;
    expect(finalState.confirmed_bases).toEqual(["appA", "appB"]);
    expect(finalState.base_progress.appA.phase).toBe("done");
    expect(finalState.base_progress.appB.phase).toBe("done");
    expect(harness.metricsWritten).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// runOrchestrator — HITL pending (issue #232)
// ---------------------------------------------------------------------------

describe("runOrchestrator — re-anchor hitl-pending", () => {
  test("re-anchor returns hitl-pending → kind=hitl-pending, state.phase='hitl-pending', neededPaths surfaced; no batches processed", async () => {
    const harness = makeHarness({
      initialState: null,
      seedsByBase: { appA: [seed("appA", "r1")] },
      reAnchorDecisions: { appA: "hitl-pending" },
      reAnchorNeededPaths: {
        appA: ["/tmp/run-x/hitl/re-anchor-decision-needed.json"],
      },
      verdictsByBatch: [],
      basesDir: join(tmp, "bases"),
      metricsDir: join(tmp, "metrics"),
    });

    const result = await runOrchestrator(
      defaultArgs({ baseId: "appA" }),
      harness.deps,
    );

    expect(result.kind).toBe("hitl-pending");
    expect(result.baseId).toBe("appA");
    expect(result.neededPaths).toEqual([
      "/tmp/run-x/hitl/re-anchor-decision-needed.json",
    ]);
    expect(harness.extractCalls).toHaveLength(0);
    expect(harness.reviewCalls).toHaveLength(0);
    expect(harness.selfImproveCalls).toHaveLength(0);
    expect(harness.metricsWritten).toHaveLength(0);

    const finalState = harness.loaded()!;
    expect(finalState.phase).toBe("hitl-pending");
  });
});

describe("runOrchestrator — resume from hitl-pending", () => {
  test("re-anchor returns approved on resume (decision file consumed) → orchestrator advances to rung-1", async () => {
    const seedsA = [seed("appA", "r1"), seed("appA", "r2")];
    const v = batchVerdict("appA", [
      passingVerdict("appA-r1"),
      passingVerdict("appA-r2"),
    ]);

    const initial: RunState = {
      run_id: "run-x",
      start_ts: "2026-04-29T00:00:00Z",
      last_updated_ts: "2026-04-29T00:30:00Z",
      worker_pids: [],
      guard_pid: 42,
      confirmed_bases: [],
      previous_base: null,
      current_base: "appA",
      phase: "hitl-pending",
      processing_order: ["appA"],
      base_progress: {},
    };

    const harness = makeHarness({
      initialState: initial,
      seedsByBase: { appA: seedsA },
      reAnchorDecisions: { appA: "approve" },
      verdictsByBatch: [v],
      basesDir: join(tmp, "bases"),
      metricsDir: join(tmp, "metrics"),
    });

    const result = await runOrchestrator(
      defaultArgs({ baseId: "appA", parallelism: 2 }),
      harness.deps,
    );

    expect(result.kind).toBe("paused");
    expect(harness.reAnchorCalls).toHaveLength(1);
    expect(harness.extractCalls).toHaveLength(2);

    const finalState = harness.loaded()!;
    expect(finalState.phase).toBe("paused");
    expect(finalState.confirmed_bases).toEqual(["appA"]);
    expect(finalState.base_progress.appA.phase).toBe("done");
  });
});

describe("runOrchestrator — self-improve hitl-pending", () => {
  test("self-improve throws HitlPendingError → kind=hitl-pending, state.phase='hitl-pending', neededPaths surfaced; no further batches", async () => {
    const seedsA = [seed("appA", "r1"), seed("appA", "r2")];
    const failV = batchVerdict("appA", [
      failingVerdict("appA-r1"),
      failingVerdict("appA-r2"),
    ]);

    const harness = makeHarness({
      initialState: null,
      seedsByBase: { appA: seedsA },
      reAnchorDecisions: { appA: "approve" },
      selfImproveBehavior: { appA: "hitl-pending" },
      selfImproveNeededPaths: {
        appA: [
          "/tmp/appA/corrections/correction-needed-appA-r1.json",
          "/tmp/appA/corrections/correction-needed-appA-r2.json",
        ],
      },
      verdictsByBatch: [failV],
      basesDir: join(tmp, "bases"),
      metricsDir: join(tmp, "metrics"),
    });

    const result = await runOrchestrator(
      defaultArgs({ baseId: "appA", parallelism: 2 }),
      harness.deps,
    );

    expect(result.kind).toBe("hitl-pending");
    expect(result.baseId).toBe("appA");
    expect(result.neededPaths).toEqual([
      "/tmp/appA/corrections/correction-needed-appA-r1.json",
      "/tmp/appA/corrections/correction-needed-appA-r2.json",
    ]);
    expect(harness.selfImproveCalls).toHaveLength(1);
    expect(harness.metricsWritten).toHaveLength(0);

    const finalState = harness.loaded()!;
    expect(finalState.phase).toBe("hitl-pending");
  });
});

// ---------------------------------------------------------------------------
// parseReAnchorSubprocessOutcome — re-anchor.mts subprocess exit-code mapping
// ---------------------------------------------------------------------------

describe("parseReAnchorSubprocessOutcome", () => {
  test("exit 0 + approved JSON → kind='approved'", () => {
    const out: ReAnchorOutcome = parseReAnchorSubprocessOutcome({
      code: 0,
      stdout: JSON.stringify({ kind: "approved", baseId: "appA" }),
      stderr: "",
    });
    expect(out.kind).toBe("approved");
    expect(out.baseId).toBe("appA");
  });

  test("exit 0 + no-op JSON → kind='no-op'", () => {
    const out = parseReAnchorSubprocessOutcome({
      code: 0,
      stdout: JSON.stringify({ kind: "no-op" }),
      stderr: "",
    });
    expect(out.kind).toBe("no-op");
  });

  test("exit 1 + rejected JSON → kind='rejected'", () => {
    const out = parseReAnchorSubprocessOutcome({
      code: 1,
      stdout: JSON.stringify({ kind: "rejected", baseId: "appA" }),
      stderr: "",
    });
    expect(out.kind).toBe("rejected");
    expect(out.baseId).toBe("appA");
  });

  test("exit 42 + hitl-pending JSON → kind='hitl-pending' with neededPaths", () => {
    const out = parseReAnchorSubprocessOutcome({
      code: 42,
      stdout: JSON.stringify({
        kind: "hitl-pending",
        baseId: "appA",
        neededPaths: ["/tmp/run-x/hitl/re-anchor-decision-needed.json"],
      }),
      stderr: "",
    });
    expect(out.kind).toBe("hitl-pending");
    expect(out.baseId).toBe("appA");
    expect(out.neededPaths).toEqual([
      "/tmp/run-x/hitl/re-anchor-decision-needed.json",
    ]);
  });

  test("empty stdout (any code) → throws with stderr surfaced", () => {
    expect(() =>
      parseReAnchorSubprocessOutcome({
        code: 2,
        stdout: "",
        stderr: "fatal: state.json not found",
      }),
    ).toThrow(/state\.json not found/);
  });

  test("malformed JSON stdout → throws with raw snippet", () => {
    expect(() =>
      parseReAnchorSubprocessOutcome({
        code: 0,
        stdout: "{not-json",
        stderr: "",
      }),
    ).toThrow(/parse|JSON/i);
  });
});

// ---------------------------------------------------------------------------
// status.mts — read-only
// ---------------------------------------------------------------------------

describe("status.mts — read-only snapshot", () => {
  test("reads state + cost-meter, computes cumulative tokens + pass-rate, no writes", () => {
    const state: RunState = {
      run_id: "run-x",
      start_ts: "2026-04-29T00:00:00Z",
      last_updated_ts: "2026-04-29T00:30:00Z",
      worker_pids: [42],
      confirmed_bases: ["appA"],
      previous_base: "appA",
      current_base: "appA",
      phase: "rung-1",
      processing_order: ["appA"],
      base_progress: {
        appA: {
          base_id: "appA",
          rung: 1,
          total_batches: 4,
          batches_done: 2,
          consec_fails: 0,
          phase: "rung-1",
          batch_results: [
            {
              batch_id: "b1",
              attempt: 1,
              parallelism: 2,
              pass_rate: 1,
              threshold: 0.95,
              outcome: "pass",
              ts: "2026-04-29T00:15:00Z",
            },
            {
              batch_id: "b2",
              attempt: 1,
              parallelism: 2,
              pass_rate: 1,
              threshold: 0.95,
              outcome: "pass",
              ts: "2026-04-29T00:30:00Z",
            },
          ],
          started_ts: "2026-04-29T00:00:00Z",
        },
      },
    };

    const costMeter =
      [
        JSON.stringify({
          ts: "2026-04-29T00:10:00Z",
          model: "claude-sonnet-4-6",
          input_tokens: 1000,
          output_tokens: 200,
        }),
        JSON.stringify({
          ts: "2026-04-29T00:20:00Z",
          model: "claude-opus-4-6",
          input_tokens: 500,
          output_tokens: 100,
        }),
      ].join("\n") + "\n";

    const deps: StatusDeps = {
      readState: () => state,
      readCostMeter: () => costMeter,
      now: () => 1745886600_000 + 30 * 60 * 1000,
    };

    const snap = readStatus("run-x", deps);
    expect(snap.run_id).toBe("run-x");
    expect(snap.phase).toBe("rung-1");
    expect(snap.cumulative_tokens.opus).toBe(600);
    expect(snap.cumulative_tokens.sonnet).toBe(1200);
    expect(snap.base_summaries).toHaveLength(1);
    expect(snap.base_summaries[0].batches_done).toBe(2);
    expect(snap.base_summaries[0].pass_rate).toBeCloseTo(1, 5);

    const formatted = formatStatusLine(snap);
    expect(formatted).toContain("run-x");
    expect(formatted).toContain("appA");
    expect(formatted).toContain("rung-1");
  });

  test("snapshot when no batches done → pass_rate = 0, eta = null", () => {
    const state: RunState = {
      run_id: "run-y",
      start_ts: "2026-04-29T00:00:00Z",
      last_updated_ts: "2026-04-29T00:00:00Z",
      worker_pids: [],
      confirmed_bases: [],
      phase: "init",
      processing_order: [],
      base_progress: {},
    };
    const deps: StatusDeps = {
      readState: () => state,
      readCostMeter: () => "",
      now: () => Date.parse("2026-04-29T00:00:00Z"),
    };
    const snap = readStatus("run-y", deps);
    expect(snap.base_summaries).toHaveLength(0);
    expect(snap.eta_ms).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// AC#235 — review-invocation paths: rubric in gold-set/, examples in bases/
// ---------------------------------------------------------------------------

describe("acceptance #235 — review-invocation path layout", () => {
  test("resolveLayout exposes goldSetDir at <runDir>/gold-set/", () => {
    const layout = resolveLayout("run-235");
    expect(layout.goldSetDir).toMatch(/airtable-extract-cache\/run-235\/gold-set$/);
    expect(layout.basesDir).toMatch(/airtable-extract-cache\/run-235\/bases$/);
    expect(layout.goldSetDir.startsWith(layout.runDir)).toBe(true);
    expect(layout.goldSetDir).not.toBe(layout.basesDir);
  });

  test("rubric in gold-set/ + no rubric in bases/<baseId>/ → reviewer invokes without FS error", async () => {
    // Set up a synthetic run dir matching the layout shape but rooted in tmp
    // so we don't pollute ~/.claude/airtable-extract-cache.
    const runDir = join(tmp, "run-235");
    const goldSetDir = join(runDir, "gold-set");
    const baseId = "appUV3hAWcRzrGjqK";
    const baseDir = join(runDir, "bases", baseId);
    mkdirSync(goldSetDir, { recursive: true });
    mkdirSync(baseDir, { recursive: true });

    // Rubric files written to gold-set/ ONLY — exactly as rubric-author.mts does.
    writeFileSync(
      join(goldSetDir, "meta-rubric.md"),
      "# Meta-Rubric\n1. Entity completeness.\n",
    );
    writeFileSync(
      join(goldSetDir, "rubric-questions.md"),
      "# Rubric questions\n1. Can vault answer Q1?\n",
    );
    // bases/<baseId>/ deliberately has NO rubric files — the prior bug.
    expect(existsSync(join(baseDir, "meta-rubric.md"))).toBe(false);
    expect(existsSync(join(baseDir, "rubric-questions.md"))).toBe(false);

    const promptsPath = join(tmp, "review.md");
    writeFileSync(
      promptsPath,
      "{{meta_rubric}}\n{{examples}}\n{{rubric_questions}}\n{{batch}}\n",
    );

    const slice: SliceForReview = {
      slice_id: "recA",
      base_id: baseId,
      cluster_id: "cluster-1",
      cluster_type: "crm",
      subgraph: "### tA\n- recA\n",
      entities: [
        {
          type: "person",
          slug: "recA",
          body: "test",
          source_record_ids: ["recA"],
        },
      ],
    };

    const runOpus: OpusRunner = async () => ({
      rawText: JSON.stringify({
        slices: [
          {
            slice_id: "recA",
            score: 0.95,
            pass: true,
            reasoning: "ok",
            fail_modes: [],
          },
        ],
        batch: { pass_rate: 1, pass: true },
      }),
      usage: { input_tokens: 100, output_tokens: 50 },
      model: "claude-opus-4-6",
    });

    const verdict = await reviewBatch(
      { batchId: "b1", baseId, slices: [slice] },
      {
        runOpus,
        goldSetPath: goldSetDir,
        basePath: baseDir,
        promptsPath,
      },
    );

    expect(verdict.pass).toBe(true);
    expect(verdict.pass_rate).toBe(1);
    expect(verdict.base_id).toBe(baseId);
  });

  test("AC#2 grep — no script constructs bases/<baseId>/{meta-rubric,rubric-questions}.md", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const scriptsDir = join(here, "..", "scripts");
    const files = [
      "review-slice.mts",
      "re-anchor.mts",
      "run.mts",
      "self-improve.mts",
      "rubric-author.mts",
    ];
    for (const f of files) {
      const src = readFileSync(join(scriptsDir, f), "utf8");
      // Match `basePath`, `opts.basePath`, `deps.basePath`, `input.basePath`
      // joined with the rubric filenames — any per-base path construction.
      expect(src).not.toMatch(
        /join\([^,]*basePath[^,]*,\s*["']meta-rubric\.md["']/,
      );
      expect(src).not.toMatch(
        /join\([^,]*basePath[^,]*,\s*["']rubric-questions\.md["']/,
      );
      // basesDir + baseId + rubric file pattern (the original mismatch).
      expect(src).not.toMatch(
        /join\([^,]*basesDir[^,]*,\s*[^,]*,\s*["']meta-rubric\.md["']/,
      );
      expect(src).not.toMatch(
        /join\([^,]*basesDir[^,]*,\s*[^,]*,\s*["']rubric-questions\.md["']/,
      );
    }
  });
});
