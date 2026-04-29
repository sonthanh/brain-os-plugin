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
  runReAnchor,
  detectBaseTransition,
  formatExampleEntry,
  formatEscalationMd,
  mergeStateApprove,
  mergeStateReject,
  type ReAnchorDeps,
  type ReAnchorState,
  type SeedForReAnchor,
  type ExtractResultLite,
  type HitlContext,
  type HitlDecision,
} from "../scripts/re-anchor.mts";
import type { BatchVerdict, SliceVerdict } from "../scripts/review-slice.mts";
import type { ExtractedEntity } from "../scripts/extract-slice.mts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "re-anchor-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

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

function extractResult(seedId: string, baseId: string): ExtractResultLite {
  return {
    sliceId: `${baseId}-${seedId}`,
    baseId,
    clusterId: `${baseId}-cluster-1`,
    clusterType: "crm",
    subgraph: `### Contacts (${baseId}-tA)\n- record ${seedId}\n  - Name: "x"`,
    entities: [entity(seedId)],
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
    score: 0.7,
    pass: false,
    reasoning: "too many link mismatches",
    fail_modes: ["link-mismatch"],
  };
}

function batchVerdict(opts: {
  baseId: string;
  slices: SliceVerdict[];
  threshold?: number;
  pass?: boolean;
}): BatchVerdict {
  const t = opts.threshold ?? 0.95;
  const passed = opts.slices.filter((s) => s.pass).length;
  const passRate = opts.slices.length === 0 ? 0 : passed / opts.slices.length;
  return {
    batch_id: `batch-${opts.baseId}`,
    base_id: opts.baseId,
    pass_rate: passRate,
    pass: opts.pass ?? passRate >= t,
    threshold: t,
    slices: opts.slices,
    usage: { input_tokens: 100, output_tokens: 50 },
    model: "claude-opus-4-6",
  };
}

function makeDeps(overrides: Partial<ReAnchorDeps> & {
  state: ReAnchorState;
  seedsByBase: Record<string, SeedForReAnchor[]>;
  decisions: HitlDecision[];
  verdictByBase: Record<string, BatchVerdict>;
  basesDir: string;
}): {
  deps: ReAnchorDeps;
  reads: { state: ReAnchorState[]; saved: ReAnchorState[] };
  signals: number[];
  notifies: { title: string; body: string }[];
  prompts: HitlContext[];
} {
  const reads: { state: ReAnchorState[]; saved: ReAnchorState[] } = {
    state: [],
    saved: [],
  };
  const signals: number[] = [];
  const notifies: { title: string; body: string }[] = [];
  const prompts: HitlContext[] = [];

  let cur: ReAnchorState = JSON.parse(JSON.stringify(overrides.state));
  const decisions = [...overrides.decisions];

  const deps: ReAnchorDeps = {
    loadState: () => {
      reads.state.push(JSON.parse(JSON.stringify(cur)));
      return JSON.parse(JSON.stringify(cur));
    },
    saveState: (s) => {
      reads.saved.push(JSON.parse(JSON.stringify(s)));
      cur = JSON.parse(JSON.stringify(s));
    },
    getSeeds: async (baseId) => {
      const list = overrides.seedsByBase[baseId];
      if (!list) throw new Error(`test fixture: no seeds for ${baseId}`);
      return list;
    },
    runExtract: async (input) =>
      extractResult(input.recordId, input.baseId),
    runReview: async (input) => {
      const v = overrides.verdictByBase[input.baseId];
      if (!v) throw new Error(`test fixture: no verdict for ${input.baseId}`);
      return v;
    },
    prompt: async (ctx) => {
      prompts.push(ctx);
      const d = decisions.shift();
      if (!d) throw new Error(`test fixture: no decision queued`);
      return d;
    },
    notify: (title, body) => notifies.push({ title, body }),
    signal: (pid) => signals.push(pid),
    writeExamples: (baseId, lines) => {
      const dir = join(overrides.basesDir, baseId);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "examples.jsonl");
      const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
      writeFileSync(
        path,
        existing + lines.map((l) => `${l}\n`).join(""),
      );
      return path;
    },
    writeEscalation: (baseId, content) => {
      const dir = join(overrides.basesDir, baseId);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "escalation.md");
      writeFileSync(path, content);
      return path;
    },
    now: () => "2026-04-29T00:00:00Z",
    log: () => {},
    ...overrides,
  };

  return { deps, reads, saved: reads.saved as never, signals, notifies, prompts } as {
    deps: ReAnchorDeps;
    reads: { state: ReAnchorState[]; saved: ReAnchorState[] };
    signals: number[];
    notifies: { title: string; body: string }[];
    prompts: HitlContext[];
  };
}

describe("detectBaseTransition", () => {
  test("first base (previous null, not confirmed) needs re-anchor", () => {
    const r = detectBaseTransition({
      start_ts: "2026-04-29T00:00:00Z",
      worker_pids: [],
      current_base: "appA",
      previous_base: null,
      confirmed_bases: [],
    });
    expect(r.needsReAnchor).toBe(true);
    expect(r.baseId).toBe("appA");
  });

  test("same base as previous → no re-anchor", () => {
    const r = detectBaseTransition({
      start_ts: "2026-04-29T00:00:00Z",
      worker_pids: [],
      current_base: "appA",
      previous_base: "appA",
      confirmed_bases: ["appA"],
    });
    expect(r.needsReAnchor).toBe(false);
  });

  test("transition to new base not in confirmed → re-anchor", () => {
    const r = detectBaseTransition({
      start_ts: "2026-04-29T00:00:00Z",
      worker_pids: [],
      current_base: "appB",
      previous_base: "appA",
      confirmed_bases: ["appA"],
    });
    expect(r.needsReAnchor).toBe(true);
    expect(r.baseId).toBe("appB");
  });

  test("current_base already in confirmed_bases → no re-anchor", () => {
    const r = detectBaseTransition({
      start_ts: "2026-04-29T00:00:00Z",
      worker_pids: [],
      current_base: "appA",
      previous_base: "appA",
      confirmed_bases: ["appA"],
    });
    expect(r.needsReAnchor).toBe(false);
  });

  test("missing current_base → no-op (orchestrator hasn't decided yet)", () => {
    const r = detectBaseTransition({
      start_ts: "2026-04-29T00:00:00Z",
      worker_pids: [],
    });
    expect(r.needsReAnchor).toBe(false);
    expect(r.baseId).toBe(null);
  });
});

describe("mergeStateApprove / mergeStateReject", () => {
  test("approve appends baseId to confirmed_bases + advances previous_base", () => {
    const next = mergeStateApprove(
      {
        start_ts: "2026-04-29T00:00:00Z",
        worker_pids: [],
        current_base: "appB",
        previous_base: "appA",
        confirmed_bases: ["appA"],
      },
      "appB",
    );
    expect(next.confirmed_bases).toEqual(["appA", "appB"]);
    expect(next.previous_base).toBe("appB");
  });

  test("approve is idempotent — same base only once in confirmed_bases", () => {
    const next = mergeStateApprove(
      {
        start_ts: "2026-04-29T00:00:00Z",
        worker_pids: [],
        current_base: "appA",
        previous_base: null,
        confirmed_bases: ["appA"],
      },
      "appA",
    );
    expect(next.confirmed_bases).toEqual(["appA"]);
  });

  test("reject sets phase = 'escalated' (does NOT advance previous_base)", () => {
    const next = mergeStateReject({
      start_ts: "2026-04-29T00:00:00Z",
      worker_pids: [],
      current_base: "appA",
      previous_base: null,
      confirmed_bases: [],
    });
    expect(next.phase).toBe("escalated");
    expect(next.previous_base).toBe(null);
    expect(next.confirmed_bases).toEqual([]);
  });
});

describe("formatExampleEntry", () => {
  test("emits valid JSON line with raw == corrected for rung-0 anchor", () => {
    const slice = {
      slice_id: "appA-rec01",
      base_id: "appA",
      cluster_id: "appA-cluster-1",
      cluster_type: "crm",
      subgraph: "### Contacts\n- record rec01\n  - Name: x",
      entities: [entity("rec01")],
    };
    const line = formatExampleEntry(slice, passingVerdict("appA-rec01", 0.97), "2026-04-29T00:00:00Z");
    const obj = JSON.parse(line);
    expect(obj.reason).toBe("rung-0-anchor");
    expect(obj.slice_id).toBe("appA-rec01");
    expect(obj.base_id).toBe("appA");
    expect(obj.verdict_score).toBe(0.97);
    expect(obj.raw).toEqual(obj.corrected);
    expect(obj.raw.entities).toEqual(slice.entities);
  });
});

describe("formatEscalationMd", () => {
  test("includes baseId, verdict pass-rate, slice failures, user note", () => {
    const md = formatEscalationMd({
      runId: "run-x",
      baseId: "appA",
      ts: "2026-04-29T00:00:00Z",
      verdict: batchVerdict({
        baseId: "appA",
        slices: [passingVerdict("a"), failingVerdict("b")],
      }),
      userNote: "Names look invented",
      workerPids: [42, 99],
    });
    expect(md).toContain("# Escalation — appA");
    expect(md).toContain("run-x");
    expect(md).toContain("pass_rate");
    expect(md).toContain("link-mismatch");
    expect(md).toContain("Names look invented");
    expect(md).toContain("42");
    expect(md).toContain("99");
  });
});

describe("runReAnchor — no-op", () => {
  test("returns no-op + does not prompt when base already confirmed", async () => {
    const seedsA = [seed("appA", "rec01")];
    const { deps, prompts, reads } = makeDeps({
      state: {
        start_ts: "2026-04-29T00:00:00Z",
        worker_pids: [],
        current_base: "appA",
        previous_base: "appA",
        confirmed_bases: ["appA"],
      },
      seedsByBase: { appA: seedsA },
      decisions: [],
      verdictByBase: {},
      basesDir: tmp,
    });

    const result = await runReAnchor("run-x", deps);
    expect(result.kind).toBe("no-op");
    expect(prompts).toHaveLength(0);
    expect(reads.saved).toHaveLength(0);
  });

  test("returns no-op when current_base unset", async () => {
    const { deps, prompts } = makeDeps({
      state: {
        start_ts: "2026-04-29T00:00:00Z",
        worker_pids: [],
      },
      seedsByBase: {},
      decisions: [],
      verdictByBase: {},
      basesDir: tmp,
    });

    const result = await runReAnchor("run-x", deps);
    expect(result.kind).toBe("no-op");
    expect(prompts).toHaveLength(0);
  });
});

describe("runReAnchor — approve path (single base)", () => {
  test("HITL fires, examples.jsonl written, state advances", async () => {
    const seedsA = [seed("appA", "rec01"), seed("appA", "rec02")];
    const verdict = batchVerdict({
      baseId: "appA",
      slices: [passingVerdict("appA-rec01"), passingVerdict("appA-rec02")],
    });

    const { deps, prompts, reads } = makeDeps({
      state: {
        start_ts: "2026-04-29T00:00:00Z",
        worker_pids: [],
        current_base: "appA",
        previous_base: null,
        confirmed_bases: [],
      },
      seedsByBase: { appA: seedsA },
      decisions: [{ decision: "approve" }],
      verdictByBase: { appA: verdict },
      basesDir: tmp,
    });

    const result = await runReAnchor("run-x", deps);

    expect(result.kind).toBe("approved");
    expect(result.baseId).toBe("appA");
    expect(prompts).toHaveLength(1);
    expect(prompts[0].baseId).toBe("appA");
    expect(prompts[0].verdict.pass_rate).toBeCloseTo(1, 5);

    const examplesPath = result.examplesPath!;
    expect(examplesPath).toBeTruthy();
    const lines = readFileSync(examplesPath, "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      const obj = JSON.parse(l);
      expect(obj.base_id).toBe("appA");
      expect(obj.reason).toBe("rung-0-anchor");
    }

    const finalState = reads.saved[reads.saved.length - 1];
    expect(finalState.confirmed_bases).toEqual(["appA"]);
    expect(finalState.previous_base).toBe("appA");
  });

  test("only passing slices become examples (failing ones skipped)", async () => {
    const seedsA = [seed("appA", "rec01"), seed("appA", "rec02")];
    const verdict = batchVerdict({
      baseId: "appA",
      slices: [passingVerdict("appA-rec01"), failingVerdict("appA-rec02")],
      pass: true,
      threshold: 0.5,
    });

    const { deps } = makeDeps({
      state: {
        start_ts: "2026-04-29T00:00:00Z",
        worker_pids: [],
        current_base: "appA",
        previous_base: null,
        confirmed_bases: [],
      },
      seedsByBase: { appA: seedsA },
      decisions: [{ decision: "approve" }],
      verdictByBase: { appA: verdict },
      basesDir: tmp,
    });

    const result = await runReAnchor("run-x", deps);
    expect(result.kind).toBe("approved");
    const lines = readFileSync(result.examplesPath!, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).slice_id).toBe("appA-rec01");
  });
});

describe("runReAnchor — reject path", () => {
  test("escalation.md written, workers signaled, phase = escalated", async () => {
    const seedsA = [seed("appA", "rec01")];
    const verdict = batchVerdict({
      baseId: "appA",
      slices: [failingVerdict("appA-rec01")],
      pass: false,
    });

    const { deps, signals, notifies, reads } = makeDeps({
      state: {
        start_ts: "2026-04-29T00:00:00Z",
        worker_pids: [4242, 9999],
        current_base: "appA",
        previous_base: null,
        confirmed_bases: [],
      },
      seedsByBase: { appA: seedsA },
      decisions: [{ decision: "reject", note: "Invented entities" }],
      verdictByBase: { appA: verdict },
      basesDir: tmp,
    });

    const result = await runReAnchor("run-x", deps);

    expect(result.kind).toBe("rejected");
    expect(result.escalationPath).toBeTruthy();
    expect(existsSync(result.escalationPath!)).toBe(true);
    const md = readFileSync(result.escalationPath!, "utf8");
    expect(md).toContain("Invented entities");
    expect(md).toContain("appA");

    expect(signals.sort()).toEqual([4242, 9999]);
    expect(notifies.length).toBeGreaterThan(0);

    const finalState = reads.saved[reads.saved.length - 1];
    expect(finalState.phase).toBe("escalated");
    expect(finalState.confirmed_bases ?? []).toEqual([]);
  });
});

describe("runReAnchor — 2-base transition (acceptance path)", () => {
  test("base A approve → base B approve → state tracks both", async () => {
    const seedsA = [seed("appA", "recA01")];
    const seedsB = [seed("appB", "recB01")];
    const vA = batchVerdict({
      baseId: "appA",
      slices: [passingVerdict("appA-recA01")],
    });
    const vB = batchVerdict({
      baseId: "appB",
      slices: [passingVerdict("appB-recB01")],
    });

    const harness = makeDeps({
      state: {
        start_ts: "2026-04-29T00:00:00Z",
        worker_pids: [],
        current_base: "appA",
        previous_base: null,
        confirmed_bases: [],
      },
      seedsByBase: { appA: seedsA, appB: seedsB },
      decisions: [{ decision: "approve" }, { decision: "approve" }],
      verdictByBase: { appA: vA, appB: vB },
      basesDir: tmp,
    });

    const r1 = await runReAnchor("run-x", harness.deps);
    expect(r1.kind).toBe("approved");

    // Orchestrator advances current_base to appB (simulated via direct save).
    const afterA = harness.reads.saved[harness.reads.saved.length - 1];
    harness.deps.saveState({ ...afterA, current_base: "appB" });

    const r2 = await runReAnchor("run-x", harness.deps);
    expect(r2.kind).toBe("approved");
    expect(r2.baseId).toBe("appB");

    const finalState = harness.reads.saved[harness.reads.saved.length - 1];
    expect(finalState.confirmed_bases).toEqual(["appA", "appB"]);
    expect(finalState.previous_base).toBe("appB");

    expect(harness.prompts).toHaveLength(2);
    expect(harness.prompts.map((p) => p.baseId)).toEqual(["appA", "appB"]);

    const examplesA = readFileSync(join(tmp, "appA", "examples.jsonl"), "utf8");
    const examplesB = readFileSync(join(tmp, "appB", "examples.jsonl"), "utf8");
    expect(examplesA).toContain("appA-recA01");
    expect(examplesA).not.toContain("appB-recB01");
    expect(examplesB).toContain("appB-recB01");
    expect(examplesB).not.toContain("appA-recA01");
  });
});

describe("runReAnchor — extract failures", () => {
  test("aborts as rejected when getSeeds returns empty", async () => {
    const { deps, prompts } = makeDeps({
      state: {
        start_ts: "2026-04-29T00:00:00Z",
        worker_pids: [4242],
        current_base: "appA",
        previous_base: null,
        confirmed_bases: [],
      },
      seedsByBase: { appA: [] },
      decisions: [],
      verdictByBase: {},
      basesDir: tmp,
    });

    const result = await runReAnchor("run-x", deps);
    expect(result.kind).toBe("rejected");
    expect(prompts).toHaveLength(0);
    expect(existsSync(result.escalationPath!)).toBe(true);
    const md = readFileSync(result.escalationPath!, "utf8");
    expect(md).toContain("no seeds");
  });
});
