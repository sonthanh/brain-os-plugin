import { test, expect, describe } from "bun:test";
import {
  parseIssueList,
  validateSameArea,
  runParallel,
  type ParallelDeps,
  type ParallelStatus,
} from "./run-parallel.ts";
import {
  defaultAreaMap,
  type GhClient,
  type SpawnClient,
  type ProcessChecker,
  type Notifier,
  type Logger,
} from "./run-story.ts";

// ---------------------------------------------------------------------------
// Pure helpers — parseIssueList + validateSameArea
// ---------------------------------------------------------------------------

describe("parseIssueList", () => {
  test("parses comma-separated integers", () => {
    expect(parseIssueList("164,165,166")).toEqual({ issues: [164, 165, 166], warnings: [] });
  });

  test("trims whitespace around tokens", () => {
    expect(parseIssueList(" 164 , 165 , 166 ")).toEqual({
      issues: [164, 165, 166],
      warnings: [],
    });
  });

  test("dedupes preserving first occurrence + warns", () => {
    const result = parseIssueList("164,165,164");
    expect(result.issues).toEqual([164, 165]);
    expect(result.warnings.some((w) => w.includes("duplicate") && w.includes("#164"))).toBe(
      true,
    );
  });

  test("throws on invalid token (non-numeric)", () => {
    expect(() => parseIssueList("164,abc,166")).toThrow(/invalid issue number/);
  });

  test("throws on negative or zero", () => {
    expect(() => parseIssueList("164,-1,166")).toThrow(/invalid issue number/);
    expect(() => parseIssueList("164,0,166")).toThrow(/invalid issue number/);
  });

  test("clamps list > HARD_CAP=5 with warning", () => {
    const result = parseIssueList("1,2,3,4,5,6,7", 5);
    expect(result.issues).toEqual([1, 2, 3, 4, 5]);
    expect(result.warnings.some((w) => w.includes("clamped") && w.includes("first 5"))).toBe(
      true,
    );
  });

  test("dedupes BEFORE clamp — list of 6 with one dupe yields 5 unique unclamped", () => {
    const result = parseIssueList("1,2,3,4,5,1", 5);
    expect(result.issues).toEqual([1, 2, 3, 4, 5]);
    expect(result.warnings.some((w) => w.includes("duplicate"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("clamped"))).toBe(false);
  });

  test("rejects empty string", () => {
    expect(() => parseIssueList("")).toThrow(/empty/);
    expect(() => parseIssueList("   ")).toThrow(/empty/);
  });
});

describe("validateSameArea", () => {
  test("all same area → returns the area", () => {
    expect(
      validateSameArea([
        { number: 164, labels: ["area:plugin-brain-os", "owner:bot"] },
        { number: 165, labels: ["area:plugin-brain-os", "owner:bot"] },
      ]),
    ).toBe("plugin-brain-os");
  });

  test("mixed areas → throws with both numbers + areas in message", () => {
    expect(() =>
      validateSameArea([
        { number: 164, labels: ["area:plugin-brain-os"] },
        { number: 200, labels: ["area:vault"] },
      ]),
    ).toThrow(/spans multiple areas.*#164.*plugin-brain-os.*#200.*vault/);
  });

  test("issue without area:* label → throws", () => {
    expect(() =>
      validateSameArea([
        { number: 164, labels: ["owner:bot"] },
      ]),
    ).toThrow(/no area.*#164/);
  });

  test("single-issue list always passes", () => {
    expect(
      validateSameArea([{ number: 164, labels: ["area:plugin-brain-os"] }]),
    ).toBe("plugin-brain-os");
  });
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

interface SpawnCall {
  name: string;
  prompt: string;
  cwd: string;
  pid: number;
}

interface MockState {
  spawnCalls: SpawnCall[];
  cleanupCalls: Array<{ name: string; cwd: string }>;
  notifications: string[];
  logs: string[];
  statusWrites: ParallelStatus[];
  claimed: number[];
  relabeledHuman: number[];
}

function makeMocks(opts: {
  issues: Map<number, { state: "OPEN" | "CLOSED"; labels: string[]; title: string; body?: string }>;
  pidStateBy: (pid: number, n: number, hb: number) => "alive" | "dead";
  closeAfterHb?: Map<number, number>;
  listResult?: Array<{ number: number; title: string; labels: string[] }>;
  pollIntervalMs?: number;
  pid0?: number;
}): { deps: ParallelDeps; state: MockState; cap: 5 } {
  const state: MockState = {
    spawnCalls: [],
    cleanupCalls: [],
    notifications: [],
    logs: [],
    statusWrites: [],
    claimed: [],
    relabeledHuman: [],
  };
  let nextPid = opts.pid0 ?? 1000;
  let hb = 0;

  const gh: GhClient = {
    viewBody: async (n) => opts.issues.get(n)?.body ?? "",
    viewFull: async (n) => {
      const issue = opts.issues.get(n);
      if (!issue) throw new Error(`viewFull called on unknown #${n}`);
      return {
        title: issue.title,
        body: issue.body ?? "",
        labels: issue.labels,
        state: issue.state,
      };
    },
    viewState: async (n) => {
      const closeAt = opts.closeAfterHb?.get(n);
      if (closeAt !== undefined && hb >= closeAt) {
        const issue = opts.issues.get(n)!;
        issue.state = "CLOSED";
      }
      return opts.issues.get(n)!.state;
    },
    editBody: async () => {},
    closeIssue: async () => {},
    relabelHuman: async (n) => {
      state.relabeledHuman.push(n);
    },
    listIssues: async () => opts.listResult ?? [],
    claim: async (n) => {
      state.claimed.push(n);
    },
  };

  const spawn: SpawnClient = {
    spawnWorker: (name, prompt, _logPath, cwd) => {
      const pid = nextPid++;
      state.spawnCalls.push({ name, prompt, cwd, pid });
      return { pid };
    },
    cleanupWorktree: (name, cwd) => {
      state.cleanupCalls.push({ name, cwd });
    },
  };

  const proc: ProcessChecker = {
    isAlive: (pid) => {
      // Find which spawn this corresponds to by pid
      const sc = state.spawnCalls.find((s) => s.pid === pid);
      if (!sc) return false;
      const n = Number(sc.name.split("issue-")[1]);
      const verdict = opts.pidStateBy(pid, n, hb);
      return verdict === "alive";
    },
  };

  const notify: Notifier = {
    notify: (msg) => {
      state.notifications.push(msg);
    },
    notifyInfo: (msg) => {
      state.notifications.push(msg);
    },
  };

  const logger: Logger = {
    log: (msg) => {
      state.logs.push(msg);
    },
  };

  const status = {
    write: (s: ParallelStatus) => {
      hb = s.hb;
      state.statusWrites.push(s);
    },
  };

  const deps: ParallelDeps = {
    gh,
    spawn,
    proc,
    notify,
    logger,
    status,
    pollIntervalMs: opts.pollIntervalMs ?? 1,
    workerLogDir: "/tmp/test-parallel",
    areaMap: defaultAreaMap("/Users/test"),
    batchId: "test-batch",
  };

  return { deps, state, cap: 5 };
}

// ---------------------------------------------------------------------------
// runParallel — integration tests
// ---------------------------------------------------------------------------

describe("runParallel — explicit list mode", () => {
  test("happy path — 2 issues, both close cleanly", async () => {
    const issues = new Map([
      [164, { state: "OPEN" as const, labels: ["area:plugin-brain-os", "owner:bot"], title: "Issue 164" }],
      [165, { state: "OPEN" as const, labels: ["area:plugin-brain-os", "owner:bot"], title: "Issue 165" }],
    ]);
    const closeAfterHb = new Map([[164, 1], [165, 1]]);

    const { deps, state } = makeMocks({
      issues,
      pidStateBy: () => "alive",
      closeAfterHb,
    });

    const result = await runParallel(
      { issues: [164, 165], parallel: 3 },
      deps,
    );

    expect(result.closed.sort()).toEqual([164, 165]);
    expect(result.failed).toEqual([]);
    expect(state.spawnCalls.length).toBe(2);
    expect(state.cleanupCalls.length).toBe(2);
    expect(state.relabeledHuman).toEqual([]);
  });

  test("per-issue cwd inferred from area:* label", async () => {
    const issues = new Map([
      [164, { state: "OPEN" as const, labels: ["area:plugin-brain-os", "owner:bot"], title: "x" }],
      [200, { state: "OPEN" as const, labels: ["area:plugin-brain-os", "owner:bot"], title: "y" }],
    ]);
    const closeAfterHb = new Map([[164, 1], [200, 1]]);

    const { deps, state } = makeMocks({ issues, pidStateBy: () => "alive", closeAfterHb });

    await runParallel({ issues: [164, 200], parallel: 3 }, deps);

    for (const sc of state.spawnCalls) {
      expect(sc.cwd).toBe("/Users/test/work/brain-os-plugin");
    }
  });

  test("issue spans multiple areas → throws before claiming any", async () => {
    const issues = new Map([
      [164, { state: "OPEN" as const, labels: ["area:plugin-brain-os", "owner:bot"], title: "x" }],
      [200, { state: "OPEN" as const, labels: ["area:vault", "owner:bot"], title: "y" }],
    ]);

    const { deps, state } = makeMocks({ issues, pidStateBy: () => "alive" });

    await expect(runParallel({ issues: [164, 200], parallel: 3 }, deps)).rejects.toThrow(
      /spans multiple areas/,
    );
    expect(state.claimed).toEqual([]);
    expect(state.spawnCalls).toEqual([]);
  });

  test("worker dies → relabeled human + continues siblings", async () => {
    const issues = new Map([
      [164, { state: "OPEN" as const, labels: ["area:plugin-brain-os", "owner:bot"], title: "x" }],
      [165, { state: "OPEN" as const, labels: ["area:plugin-brain-os", "owner:bot"], title: "y" }],
    ]);
    const closeAfterHb = new Map([[165, 1]]); // 165 closes; 164 stays OPEN forever

    const { deps, state } = makeMocks({
      issues,
      pidStateBy: (_pid, n, hb) => {
        // 164 dies after first poll cycle; 165 closes legitimately
        if (n === 164 && hb >= 1) return "dead";
        return "alive";
      },
      closeAfterHb,
    });

    const result = await runParallel({ issues: [164, 165], parallel: 3 }, deps);

    expect(result.closed).toEqual([165]);
    expect(result.failed).toEqual([164]);
    expect(state.relabeledHuman).toEqual([164]);
  });

  test("already-CLOSED issue in list → skipped without spawn or claim", async () => {
    const issues = new Map([
      [164, { state: "OPEN" as const, labels: ["area:plugin-brain-os", "owner:bot"], title: "x" }],
      [165, { state: "CLOSED" as const, labels: ["area:plugin-brain-os", "owner:bot"], title: "done" }],
    ]);
    const closeAfterHb = new Map([[164, 1]]);

    const { deps, state } = makeMocks({ issues, pidStateBy: () => "alive", closeAfterHb });

    const result = await runParallel({ issues: [164, 165], parallel: 3 }, deps);

    expect(result.closed.sort()).toEqual([164, 165]);
    expect(result.failed).toEqual([]);
    expect(state.spawnCalls.length).toBe(1);
    expect(state.spawnCalls[0].name).toContain("164");
    expect(state.claimed).toEqual([164]); // 165 was already CLOSED, no claim
  });

  test("respects parallel cap — 5 issues, cap=2 → max 2 concurrent spawns", async () => {
    const numbers = [101, 102, 103, 104, 105];
    const issues = new Map(
      numbers.map(
        (n) =>
          [
            n,
            { state: "OPEN" as const, labels: ["area:plugin-brain-os", "owner:bot"], title: `T${n}` },
          ] as const,
      ),
    );
    // All close 1 hb after spawn (since hb starts at 0, write hb=1, sleep, poll → close).
    // We track concurrency by inspecting watching size at peak.
    const closeAfterHb = new Map(numbers.map((n) => [n, 100])); // never close until very late

    const { deps, state } = makeMocks({
      issues,
      pidStateBy: (_pid, _n, hb) => (hb > 5 ? "dead" : "alive"), // all eventually fail to bound runtime
      closeAfterHb,
      pollIntervalMs: 1,
    });

    await runParallel({ issues: numbers, parallel: 2 }, deps);

    // Peak concurrency from status writes' watching field
    const peakWatching = Math.max(...state.statusWrites.map((s) => s.watching.length));
    expect(peakWatching).toBeLessThanOrEqual(2);
  });
});

describe("runParallel — count mode", () => {
  test("count form picks top N from listIssues result + claims them", async () => {
    const listResult = [
      { number: 200, title: "A", labels: ["area:plugin-brain-os", "owner:bot", "status:ready"] },
      { number: 201, title: "B", labels: ["area:plugin-brain-os", "owner:bot", "status:ready"] },
    ];
    const issues = new Map([
      [200, { state: "OPEN" as const, labels: listResult[0].labels, title: "A" }],
      [201, { state: "OPEN" as const, labels: listResult[1].labels, title: "B" }],
    ]);
    const closeAfterHb = new Map([[200, 1], [201, 1]]);

    const { deps, state } = makeMocks({
      issues,
      pidStateBy: () => "alive",
      closeAfterHb,
      listResult,
    });

    const result = await runParallel(
      { count: 2, parallel: 3, area: "plugin-brain-os" },
      deps,
    );

    expect(result.closed.sort()).toEqual([200, 201]);
    expect(state.claimed.sort()).toEqual([200, 201]);
  });

  test("empty queue in count mode → returns empty without spawn", async () => {
    const { deps, state } = makeMocks({
      issues: new Map(),
      pidStateBy: () => "alive",
      listResult: [],
    });

    const result = await runParallel(
      { count: 3, parallel: 3, area: "plugin-brain-os" },
      deps,
    );

    expect(result.closed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(state.spawnCalls).toEqual([]);
  });
});
