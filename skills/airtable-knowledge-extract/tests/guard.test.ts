import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  classifyModel,
  eventTokens,
  parseCostMeterLine,
  parseCostMeter,
  computeCumulative,
  detectBreach,
  formatBreachMd,
  runGuard,
  DEFAULT_CAPS,
  HARD_MAX_OPUS_TOK,
  HARD_MAX_SONNET_TOK,
  HARD_MAX_QUOTA_PCT,
  HARD_MAX_RUN_DURATION_MS,
  type CostMeterEvent,
  type GuardDeps,
  type StateFile,
} from "../scripts/guard.mts";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("classifyModel", () => {
  test("opus matches", () => {
    expect(classifyModel("claude-opus-4-7")).toBe("opus");
    expect(classifyModel("claude-opus-4-6")).toBe("opus");
    expect(classifyModel("OPUS")).toBe("opus");
  });
  test("sonnet matches", () => {
    expect(classifyModel("claude-sonnet-4-6")).toBe("sonnet");
  });
  test("haiku and unknown bucket as 'other'", () => {
    expect(classifyModel("claude-haiku-4-5")).toBe("other");
    expect(classifyModel("gpt-4")).toBe("other");
    expect(classifyModel("")).toBe("other");
  });
});

describe("eventTokens", () => {
  test("sums all four token fields", () => {
    expect(
      eventTokens({
        ts: "2026-04-29T00:00:00Z",
        model: "claude-opus-4-7",
        input_tokens: 100,
        output_tokens: 200,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 25,
      }),
    ).toBe(375);
  });
  test("missing cache fields default to zero", () => {
    expect(
      eventTokens({
        ts: "2026-04-29T00:00:00Z",
        model: "claude-sonnet-4-6",
        input_tokens: 10,
        output_tokens: 20,
      }),
    ).toBe(30);
  });
});

describe("parseCostMeterLine", () => {
  test("parses valid JSON line", () => {
    const line = JSON.stringify({
      ts: "2026-04-29T00:00:00Z",
      model: "claude-sonnet-4-6",
      input_tokens: 10,
      output_tokens: 20,
    });
    expect(parseCostMeterLine(line)?.model).toBe("claude-sonnet-4-6");
  });
  test("returns null on empty/whitespace", () => {
    expect(parseCostMeterLine("")).toBeNull();
    expect(parseCostMeterLine("   ")).toBeNull();
  });
  test("returns null on malformed JSON", () => {
    expect(parseCostMeterLine("not json")).toBeNull();
    expect(parseCostMeterLine("{broken")).toBeNull();
  });
  test("returns null on missing required fields", () => {
    expect(parseCostMeterLine(JSON.stringify({ model: "x" }))).toBeNull();
    expect(
      parseCostMeterLine(JSON.stringify({ input_tokens: 1, output_tokens: 1 })),
    ).toBeNull();
  });
});

describe("parseCostMeter", () => {
  test("multi-line parse, skip blanks + garbage", () => {
    const content = [
      JSON.stringify({ ts: "x", model: "claude-opus-4-7", input_tokens: 1, output_tokens: 2 }),
      "",
      JSON.stringify({ ts: "y", model: "claude-sonnet-4-6", input_tokens: 3, output_tokens: 4 }),
      "garbage",
    ].join("\n");
    expect(parseCostMeter(content).length).toBe(2);
  });
  test("empty content → empty array", () => {
    expect(parseCostMeter("")).toEqual([]);
  });
});

describe("computeCumulative", () => {
  test("aggregates by tier (opus/sonnet/other)", () => {
    const events: CostMeterEvent[] = [
      { ts: "x", model: "claude-opus-4-7", input_tokens: 100, output_tokens: 200 },
      { ts: "y", model: "claude-opus-4-7", input_tokens: 50, output_tokens: 50 },
      { ts: "z", model: "claude-sonnet-4-6", input_tokens: 1000, output_tokens: 1000 },
      { ts: "w", model: "claude-haiku-4-5", input_tokens: 5, output_tokens: 5 },
    ];
    expect(computeCumulative(events)).toEqual({ opus: 400, sonnet: 2000, other: 10 });
  });
  test("empty list → zeros", () => {
    expect(computeCumulative([])).toEqual({ opus: 0, sonnet: 0, other: 0 });
  });
  test("includes cache fields in totals", () => {
    const events: CostMeterEvent[] = [
      {
        ts: "x",
        model: "claude-opus-4-7",
        input_tokens: 100,
        output_tokens: 200,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 5000,
      },
    ];
    expect(computeCumulative(events).opus).toBe(6300);
  });
});

describe("detectBreach", () => {
  test("opus over → opus_tokens breach", () => {
    expect(
      detectBreach({ opus: HARD_MAX_OPUS_TOK + 1, sonnet: 0, other: 0 }, 0, null, DEFAULT_CAPS),
    ).toEqual({
      reason: "opus_tokens",
      observed: HARD_MAX_OPUS_TOK + 1,
      cap: HARD_MAX_OPUS_TOK,
    });
  });
  test("sonnet over → sonnet_tokens breach", () => {
    expect(
      detectBreach({ opus: 0, sonnet: HARD_MAX_SONNET_TOK + 1, other: 0 }, 0, null, DEFAULT_CAPS),
    ).toEqual({
      reason: "sonnet_tokens",
      observed: HARD_MAX_SONNET_TOK + 1,
      cap: HARD_MAX_SONNET_TOK,
    });
  });
  test("wallclock over → wallclock breach", () => {
    expect(
      detectBreach(
        { opus: 0, sonnet: 0, other: 0 },
        HARD_MAX_RUN_DURATION_MS + 1,
        null,
        DEFAULT_CAPS,
      ),
    ).toEqual({
      reason: "wallclock",
      observed: HARD_MAX_RUN_DURATION_MS + 1,
      cap: HARD_MAX_RUN_DURATION_MS,
    });
  });
  test("quota over → quota_pct breach", () => {
    expect(
      detectBreach(
        { opus: 0, sonnet: 0, other: 0 },
        0,
        HARD_MAX_QUOTA_PCT + 1,
        DEFAULT_CAPS,
      ),
    ).toEqual({
      reason: "quota_pct",
      observed: HARD_MAX_QUOTA_PCT + 1,
      cap: HARD_MAX_QUOTA_PCT,
    });
  });
  test("quota null/undefined → no quota breach (Phase 1 ccusage manual)", () => {
    expect(detectBreach({ opus: 0, sonnet: 0, other: 0 }, 0, null, DEFAULT_CAPS)).toBeNull();
    expect(
      detectBreach({ opus: 0, sonnet: 0, other: 0 }, 0, undefined, DEFAULT_CAPS),
    ).toBeNull();
  });
  test("at cap exactly → no breach (strictly greater)", () => {
    expect(
      detectBreach(
        { opus: HARD_MAX_OPUS_TOK, sonnet: HARD_MAX_SONNET_TOK, other: 0 },
        HARD_MAX_RUN_DURATION_MS,
        HARD_MAX_QUOTA_PCT,
        DEFAULT_CAPS,
      ),
    ).toBeNull();
  });
  test("all under → null (no false positive)", () => {
    expect(
      detectBreach({ opus: 100, sonnet: 100, other: 100 }, 1000, 5, DEFAULT_CAPS),
    ).toBeNull();
  });
  test("precedence: opus → sonnet → wallclock → quota_pct", () => {
    // All four breach simultaneously; opus should win.
    expect(
      detectBreach(
        { opus: HARD_MAX_OPUS_TOK + 1, sonnet: HARD_MAX_SONNET_TOK + 1, other: 0 },
        HARD_MAX_RUN_DURATION_MS + 1,
        HARD_MAX_QUOTA_PCT + 1,
        DEFAULT_CAPS,
      )?.reason,
    ).toBe("opus_tokens");
    // Sonnet + wallclock + quota → sonnet wins.
    expect(
      detectBreach(
        { opus: 0, sonnet: HARD_MAX_SONNET_TOK + 1, other: 0 },
        HARD_MAX_RUN_DURATION_MS + 1,
        HARD_MAX_QUOTA_PCT + 1,
        DEFAULT_CAPS,
      )?.reason,
    ).toBe("sonnet_tokens");
    // Wallclock + quota → wallclock wins.
    expect(
      detectBreach(
        { opus: 0, sonnet: 0, other: 0 },
        HARD_MAX_RUN_DURATION_MS + 1,
        HARD_MAX_QUOTA_PCT + 1,
        DEFAULT_CAPS,
      )?.reason,
    ).toBe("wallclock");
  });
});

describe("formatBreachMd", () => {
  test("contains reason, observed, cap, run-id, snapshot, pids", () => {
    const md = formatBreachMd(
      { reason: "opus_tokens", observed: 2_500_000, cap: 2_000_000 },
      {
        runId: "test-run",
        ts: "2026-04-29T00:00:00Z",
        cum: { opus: 2_500_000, sonnet: 0, other: 0 },
        wallclockMs: 60_000,
        workerPids: [1234, 5678],
      },
    );
    expect(md).toContain("opus_tokens");
    expect(md).toContain("2500000");
    expect(md).toContain("2000000");
    expect(md).toContain("test-run");
    expect(md).toContain("1234, 5678");
    expect(md).toContain("60000");
  });
  test("empty pids → '(none)' marker", () => {
    const md = formatBreachMd(
      { reason: "wallclock", observed: 1, cap: 0 },
      {
        runId: "r",
        ts: "t",
        cum: { opus: 0, sonnet: 0, other: 0 },
        wallclockMs: 1,
        workerPids: [],
      },
    );
    expect(md).toContain("(none)");
  });
});

// ---------------------------------------------------------------------------
// runGuard with injected deps
// ---------------------------------------------------------------------------

function makeMockDeps(opts: {
  costMeter: string;
  state: StateFile;
  alivePids?: Set<number>;
  nowMs: number;
}): {
  deps: GuardDeps;
  calls: {
    signals: Array<[number, string]>;
    breachMd: string | null;
    notifications: Array<[string, string]>;
    logs: string[];
  };
} {
  const calls = {
    signals: [] as Array<[number, string]>,
    breachMd: null as string | null,
    notifications: [] as Array<[string, string]>,
    logs: [] as string[],
  };
  const alive = opts.alivePids ?? new Set(opts.state.worker_pids);
  const deps: GuardDeps = {
    readCostMeter: () => opts.costMeter,
    readState: () => opts.state,
    signal: (pid, sig) => {
      calls.signals.push([pid, sig]);
      alive.delete(pid);
    },
    writeBreachMd: (_p, content) => {
      calls.breachMd = content;
    },
    notify: (title, body) => calls.notifications.push([title, body]),
    now: () => opts.nowMs,
    sleep: () => Promise.resolve(),
    log: (msg) => calls.logs.push(msg),
    isAlive: (pid) => alive.has(pid),
  };
  return { deps, calls };
}

describe("runGuard", () => {
  test("on opus-tokens breach: SIGTERMs all worker pids, writes breach.md, notifies, exits", async () => {
    const startTs = "2026-04-29T00:00:00Z";
    const overOpus = JSON.stringify({
      ts: startTs,
      model: "claude-opus-4-7",
      input_tokens: HARD_MAX_OPUS_TOK + 100,
      output_tokens: 0,
    });
    const { deps, calls } = makeMockDeps({
      costMeter: overOpus,
      state: { start_ts: startTs, worker_pids: [11, 22, 33] },
      nowMs: Date.parse(startTs) + 60_000,
    });
    const result = await runGuard(
      deps,
      { costMeter: "x", state: "y", breachMd: "z" },
      "rid",
      { maxIterations: 1 },
    );
    expect(result.kind).toBe("breach");
    expect(calls.signals).toEqual([
      [11, "SIGTERM"],
      [22, "SIGTERM"],
      [33, "SIGTERM"],
    ]);
    expect(calls.breachMd).toContain("opus_tokens");
    expect(calls.notifications.length).toBe(1);
  });

  test("healthy under-cap run: no signals, no breach.md, no notify (loops to maxIter)", async () => {
    const startTs = "2026-04-29T00:00:00Z";
    const safe = JSON.stringify({
      ts: startTs,
      model: "claude-sonnet-4-6",
      input_tokens: 100,
      output_tokens: 100,
    });
    const { deps, calls } = makeMockDeps({
      costMeter: safe,
      state: { start_ts: startTs, worker_pids: [11] },
      alivePids: new Set([11]),
      nowMs: Date.parse(startTs) + 1000,
    });
    const result = await runGuard(
      deps,
      { costMeter: "x", state: "y", breachMd: "z" },
      "rid",
      { maxIterations: 3 },
    );
    expect(result.kind).toBe("max-iterations");
    expect(calls.signals).toEqual([]);
    expect(calls.breachMd).toBeNull();
    expect(calls.notifications).toEqual([]);
  });

  test("workers all dead → exits 'workers-done' clean (no breach)", async () => {
    const startTs = "2026-04-29T00:00:00Z";
    const { deps, calls } = makeMockDeps({
      costMeter: "",
      state: { start_ts: startTs, worker_pids: [11, 22] },
      alivePids: new Set(),
      nowMs: Date.parse(startTs) + 1000,
    });
    const result = await runGuard(
      deps,
      { costMeter: "x", state: "y", breachMd: "z" },
      "rid",
      { maxIterations: 5 },
    );
    expect(result.kind).toBe("workers-done");
    expect(calls.signals).toEqual([]);
    expect(calls.breachMd).toBeNull();
  });

  test("empty worker_pids → loops without exit (orchestrator may register later)", async () => {
    const startTs = "2026-04-29T00:00:00Z";
    const { deps, calls } = makeMockDeps({
      costMeter: "",
      state: { start_ts: startTs, worker_pids: [] },
      nowMs: Date.parse(startTs) + 100,
    });
    const result = await runGuard(
      deps,
      { costMeter: "x", state: "y", breachMd: "z" },
      "rid",
      { maxIterations: 2 },
    );
    expect(result.kind).toBe("max-iterations");
    expect(calls.signals).toEqual([]);
  });

  test("missing/empty cost-meter → no breach (treats as zero tokens)", async () => {
    const startTs = "2026-04-29T00:00:00Z";
    const { deps, calls } = makeMockDeps({
      costMeter: "",
      state: { start_ts: startTs, worker_pids: [11] },
      alivePids: new Set([11]),
      nowMs: Date.parse(startTs) + 1000,
    });
    const result = await runGuard(
      deps,
      { costMeter: "x", state: "y", breachMd: "z" },
      "rid",
      { maxIterations: 2 },
    );
    expect(result.kind).toBe("max-iterations");
    expect(calls.breachMd).toBeNull();
  });

  test("wallclock over cap → wallclock breach, all pids signaled", async () => {
    const startTs = "2026-04-29T00:00:00Z";
    const { deps, calls } = makeMockDeps({
      costMeter: "",
      state: { start_ts: startTs, worker_pids: [99] },
      alivePids: new Set([99]),
      nowMs: Date.parse(startTs) + HARD_MAX_RUN_DURATION_MS + 1000,
    });
    const result = await runGuard(
      deps,
      { costMeter: "x", state: "y", breachMd: "z" },
      "rid",
      { maxIterations: 1 },
    );
    expect(result.kind).toBe("breach");
    expect(calls.signals).toEqual([[99, "SIGTERM"]]);
    expect(calls.breachMd).toContain("wallclock");
  });

  test("quota_pct over cap → quota_pct breach when state has quota_pct", async () => {
    const startTs = "2026-04-29T00:00:00Z";
    const { deps, calls } = makeMockDeps({
      costMeter: "",
      state: {
        start_ts: startTs,
        worker_pids: [7],
        quota_pct: HARD_MAX_QUOTA_PCT + 5,
      },
      alivePids: new Set([7]),
      nowMs: Date.parse(startTs) + 1000,
    });
    const result = await runGuard(
      deps,
      { costMeter: "x", state: "y", breachMd: "z" },
      "rid",
      { maxIterations: 1 },
    );
    expect(result.kind).toBe("breach");
    expect(calls.breachMd).toContain("quota_pct");
  });

  test("signal failure does not abort the rest of the kill list", async () => {
    const startTs = "2026-04-29T00:00:00Z";
    const overOpus = JSON.stringify({
      ts: startTs,
      model: "claude-opus-4-7",
      input_tokens: HARD_MAX_OPUS_TOK + 100,
      output_tokens: 0,
    });
    let calls = 0;
    const signalCalls: number[] = [];
    const deps: GuardDeps = {
      readCostMeter: () => overOpus,
      readState: () => ({ start_ts: startTs, worker_pids: [1, 2, 3] }),
      signal: (pid) => {
        calls++;
        signalCalls.push(pid);
        if (pid === 2) throw new Error("ESRCH");
      },
      writeBreachMd: () => {},
      notify: () => {},
      now: () => Date.parse(startTs) + 1000,
      sleep: () => Promise.resolve(),
      log: () => {},
      isAlive: () => true,
    };
    const result = await runGuard(
      deps,
      { costMeter: "x", state: "y", breachMd: "z" },
      "rid",
      { maxIterations: 1 },
    );
    expect(result.kind).toBe("breach");
    expect(signalCalls).toEqual([1, 2, 3]);
    expect(calls).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Integration: real spawn → SIGTERM on synthetic breach
// ---------------------------------------------------------------------------

describe("integration: real spawn SIGTERM on synthetic breach", () => {
  test("breach kills real spawned child + writes breach.md to disk", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guard-test-"));
    try {
      const startTs = new Date(Date.now() - 1000).toISOString();
      const cmPath = path.join(tmp, "cost-meter.jsonl");
      const statePath = path.join(tmp, "state.json");
      const breachPath = path.join(tmp, "breach.md");

      // Spawn a real child sleeping ~30s.
      const child = Bun.spawn(["sleep", "30"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      const childPid = child.pid;
      expect(typeof childPid).toBe("number");

      try {
        // Synthetic breach: cost-meter shows opus tokens above hard max.
        fs.writeFileSync(
          cmPath,
          JSON.stringify({
            ts: startTs,
            model: "claude-opus-4-7",
            input_tokens: HARD_MAX_OPUS_TOK + 1000,
            output_tokens: 0,
          }) + "\n",
        );
        fs.writeFileSync(
          statePath,
          JSON.stringify({ start_ts: startTs, worker_pids: [childPid] }),
        );

        const deps: GuardDeps = {
          readCostMeter: (p) => fs.readFileSync(p, "utf8"),
          readState: (p) => JSON.parse(fs.readFileSync(p, "utf8")),
          signal: (pid, sig) => process.kill(pid, sig),
          writeBreachMd: (p, content) => fs.writeFileSync(p, content),
          notify: () => {},
          now: () => Date.now(),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          log: () => {},
          isAlive: (pid) => {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              return false;
            }
          },
        };

        const result = await runGuard(
          deps,
          { costMeter: cmPath, state: statePath, breachMd: breachPath },
          "integration-test",
          { maxIterations: 1 },
        );

        expect(result.kind).toBe("breach");

        // Wait briefly for SIGTERM to take effect on darwin.
        await new Promise((r) => setTimeout(r, 300));

        // Child must be dead.
        let alive = false;
        try {
          process.kill(childPid, 0);
          alive = true;
        } catch {
          alive = false;
        }
        expect(alive).toBe(false);

        // breach.md exists with reason + observed.
        expect(fs.existsSync(breachPath)).toBe(true);
        const md = fs.readFileSync(breachPath, "utf8");
        expect(md).toContain("opus_tokens");
        expect(md).toContain(String(childPid));
      } finally {
        // Belt-and-braces cleanup: ensure child is reaped even on assertion failure.
        try {
          process.kill(childPid, "SIGKILL");
        } catch {}
        await child.exited.catch(() => {});
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 10_000);
});
