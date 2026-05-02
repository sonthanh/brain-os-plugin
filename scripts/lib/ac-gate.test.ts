import { test, expect, describe, mock } from "bun:test";
import { runChildAdvisorGate, MAX_ITERATIONS } from "./ac-gate.ts";
import type {
  TddRunner,
  AdvisorClient,
  GhWriter,
  ResultRecorder,
  Logger,
} from "./ac-gate.ts";

// =========================================================================
// Test doubles
// =========================================================================

function makeTdd(outcomes: Array<{ status: "GREEN" | "RED"; reason?: string }>) {
  const calls: Array<{ issue: number; priorFailure?: string }> = [];
  const runner: TddRunner = {
    async run(issue, priorFailure) {
      calls.push({ issue, priorFailure });
      const idx = calls.length - 1;
      if (idx >= outcomes.length) {
        throw new Error(`unexpected /tdd call (call #${calls.length})`);
      }
      return outcomes[idx];
    },
  };
  return { runner, calls };
}

function makeAdvisor(verdicts: string[]) {
  const calls: Array<{ issue: number }> = [];
  const client: AdvisorClient = {
    async verify(issue) {
      calls.push({ issue });
      const idx = calls.length - 1;
      if (idx >= verdicts.length) {
        throw new Error(`unexpected advisor call (call #${calls.length})`);
      }
      return verdicts[idx];
    },
  };
  return { client, calls };
}

function makeGh() {
  const comments: Array<{ issue: number; body: string }> = [];
  const relabeled: number[] = [];
  const gh: GhWriter = {
    async comment(issue, body) {
      comments.push({ issue, body });
    },
    async relabelHuman(issue) {
      relabeled.push(issue);
    },
  };
  return { gh, comments, relabeled };
}

function makeRecorder() {
  const records: Array<{ issue: number; counters: unknown }> = [];
  const recorder: ResultRecorder = {
    async record(issue, counters) {
      records.push({ issue, counters });
    },
  };
  return { recorder, records };
}

const silentLogger: Logger = { log: () => {} };

const PARENT_BODY_LIVE_AC = [
  "## Acceptance",
  "- [ ] **AC#1** — Gate A. Verified by replay with live integration descriptor.",
  "- [ ] **AC#7** — Spec exists. Verified by inspection.",
].join("\n");

const PARENT_BODY_NO_LIVE_AC = [
  "## Acceptance",
  "- [ ] **AC#7** — Spec exists. Verified by inspection.",
].join("\n");

const CHILD_BODY_LIVE = `## Covers AC\n\n- AC#1\n\n## What to build\n`;
const CHILD_BODY_PURE = `## Covers AC\n\n## What to build\n`;
const CHILD_BODY_NON_LIVE = `## Covers AC\n\n- AC#7\n\n## What to build\n`;

// =========================================================================
// Pure-component path
// =========================================================================

describe("runChildAdvisorGate — pure-component child", () => {
  test("/tdd GREEN → no advisor call, verified, counters recorded", async () => {
    const tdd = makeTdd([{ status: "GREEN" }]);
    const advisor = makeAdvisor([]);
    const ghOut = makeGh();
    const rec = makeRecorder();

    const result = await runChildAdvisorGate(123, CHILD_BODY_PURE, PARENT_BODY_LIVE_AC, {
      tdd: tdd.runner,
      advisor: advisor.client,
      gh: ghOut.gh,
      recorder: rec.recorder,
      logger: silentLogger,
    });

    expect(result.verified).toBe(true);
    expect(result.advisorCalls).toBe(0);
    expect(result.advisorRejections).toBe(0);
    expect(advisor.calls.length).toBe(0);
    expect(ghOut.comments.length).toBe(0);
    expect(ghOut.relabeled.length).toBe(0);
    expect(rec.records.length).toBe(1);
    expect(rec.records[0].issue).toBe(123);
  });

  test("Covers AC pointing at non-live parent AC also bypasses advisor", async () => {
    const tdd = makeTdd([{ status: "GREEN" }]);
    const advisor = makeAdvisor([]);
    const ghOut = makeGh();
    const rec = makeRecorder();

    const result = await runChildAdvisorGate(124, CHILD_BODY_NON_LIVE, PARENT_BODY_LIVE_AC, {
      tdd: tdd.runner,
      advisor: advisor.client,
      gh: ghOut.gh,
      recorder: rec.recorder,
      logger: silentLogger,
    });

    expect(result.verified).toBe(true);
    expect(advisor.calls.length).toBe(0);
  });

  test("/tdd RED on iter 1 → retry up to MAX_ITERATIONS, then escalate", async () => {
    const tdd = makeTdd([
      { status: "RED", reason: "test red on assertion X" },
      { status: "RED", reason: "still red" },
      { status: "RED", reason: "still red again" },
    ]);
    const advisor = makeAdvisor([]);
    const ghOut = makeGh();
    const rec = makeRecorder();

    const result = await runChildAdvisorGate(125, CHILD_BODY_PURE, PARENT_BODY_LIVE_AC, {
      tdd: tdd.runner,
      advisor: advisor.client,
      gh: ghOut.gh,
      recorder: rec.recorder,
      logger: silentLogger,
    });

    expect(result.verified).toBe(false);
    expect(tdd.calls.length).toBe(MAX_ITERATIONS);
    expect(advisor.calls.length).toBe(0); // pure-component never calls advisor
    expect(ghOut.relabeled).toEqual([125]);
    expect(ghOut.comments.length).toBe(1);
    expect(ghOut.comments[0].body).toContain("AFK gave up");
    expect(ghOut.comments[0].body).toContain("still red again");
  });
});

// =========================================================================
// Live-AC path — happy
// =========================================================================

describe("runChildAdvisorGate — live-AC happy path", () => {
  test("/tdd GREEN iter 1 + advisor accepts → 1 advisor call, verified", async () => {
    const tdd = makeTdd([{ status: "GREEN" }]);
    const advisor = makeAdvisor(["After review: AC met. Live integration ran."]);
    const ghOut = makeGh();
    const rec = makeRecorder();

    const result = await runChildAdvisorGate(126, CHILD_BODY_LIVE, PARENT_BODY_LIVE_AC, {
      tdd: tdd.runner,
      advisor: advisor.client,
      gh: ghOut.gh,
      recorder: rec.recorder,
      logger: silentLogger,
    });

    expect(result.verified).toBe(true);
    expect(result.advisorCalls).toBe(1);
    expect(result.advisorRejections).toBe(0);
    expect(advisor.calls).toEqual([{ issue: 126 }]);
    expect(ghOut.relabeled.length).toBe(0);
    expect(ghOut.comments.length).toBe(0);
  });

  test("/tdd RED iter 1 + GREEN iter 2 + advisor accepts → /tdd called twice with hint, advisor once", async () => {
    const tdd = makeTdd([
      { status: "RED", reason: "test red on assertion X" },
      { status: "GREEN" },
    ]);
    const advisor = makeAdvisor(["AC met."]);
    const ghOut = makeGh();
    const rec = makeRecorder();

    const result = await runChildAdvisorGate(127, CHILD_BODY_LIVE, PARENT_BODY_LIVE_AC, {
      tdd: tdd.runner,
      advisor: advisor.client,
      gh: ghOut.gh,
      recorder: rec.recorder,
      logger: silentLogger,
    });

    expect(result.verified).toBe(true);
    expect(tdd.calls.length).toBe(2);
    expect(tdd.calls[0].priorFailure).toBeUndefined();
    expect(tdd.calls[1].priorFailure).toContain("test red on assertion X");
    expect(result.advisorCalls).toBe(1);
  });
});

// =========================================================================
// Live-AC path — advisor rejection escalation
// =========================================================================

describe("runChildAdvisorGate — live-AC advisor rejects 3x", () => {
  test("3 rejections → re-label + comment + counters reflect 3 rejections", async () => {
    const tdd = makeTdd([
      { status: "GREEN" },
      { status: "GREEN" },
      { status: "GREEN" },
    ]);
    const advisor = makeAdvisor([
      "AC not met: integration test mocks the live API.",
      "AC not met: still mocking the integration.",
      "AC not met: STILL mocking, please pick up.",
    ]);
    const ghOut = makeGh();
    const rec = makeRecorder();

    const result = await runChildAdvisorGate(210, CHILD_BODY_LIVE, PARENT_BODY_LIVE_AC, {
      tdd: tdd.runner,
      advisor: advisor.client,
      gh: ghOut.gh,
      recorder: rec.recorder,
      logger: silentLogger,
    });

    expect(result.verified).toBe(false);
    expect(tdd.calls.length).toBe(3);
    expect(advisor.calls.length).toBe(3);
    expect(result.advisorCalls).toBe(3);
    expect(result.advisorRejections).toBe(3);
    expect(ghOut.relabeled).toEqual([210]);
    expect(ghOut.comments.length).toBe(1);
    expect(ghOut.comments[0].body).toContain("AFK gave up after 3 ralph iters");
    expect(ghOut.comments[0].body).toContain("STILL mocking");
    expect(rec.records[0].issue).toBe(210);
  });

  test("iter 2 + 3 receive --prior-attempt-failed-because with last failure reason", async () => {
    const tdd = makeTdd([
      { status: "GREEN" },
      { status: "GREEN" },
      { status: "GREEN" },
    ]);
    const advisor = makeAdvisor([
      "AC not met: first reason",
      "AC not met: second reason",
      "AC not met: third reason",
    ]);
    const ghOut = makeGh();
    const rec = makeRecorder();

    await runChildAdvisorGate(211, CHILD_BODY_LIVE, PARENT_BODY_LIVE_AC, {
      tdd: tdd.runner,
      advisor: advisor.client,
      gh: ghOut.gh,
      recorder: rec.recorder,
      logger: silentLogger,
    });

    expect(tdd.calls[0].priorFailure).toBeUndefined();
    expect(tdd.calls[1].priorFailure).toContain("first reason");
    expect(tdd.calls[2].priorFailure).toContain("second reason");
  });

  test("mixed RED + advisor-rejection iters still cap at MAX_ITERATIONS", async () => {
    const tdd = makeTdd([
      { status: "RED", reason: "test red iter 1" },
      { status: "GREEN" },
      { status: "GREEN" },
    ]);
    const advisor = makeAdvisor([
      "AC not met: advisor rejects iter 2",
      "AC not met: advisor rejects iter 3",
    ]);
    const ghOut = makeGh();
    const rec = makeRecorder();

    const result = await runChildAdvisorGate(212, CHILD_BODY_LIVE, PARENT_BODY_LIVE_AC, {
      tdd: tdd.runner,
      advisor: advisor.client,
      gh: ghOut.gh,
      recorder: rec.recorder,
      logger: silentLogger,
    });

    expect(result.verified).toBe(false);
    expect(tdd.calls.length).toBe(3);
    expect(advisor.calls.length).toBe(2);
    expect(result.advisorCalls).toBe(2);
    expect(result.advisorRejections).toBe(2);
    expect(ghOut.relabeled).toEqual([212]);
  });
});

// =========================================================================
// Mid-cycle counters
// =========================================================================

describe("runChildAdvisorGate — counters always recorded", () => {
  test("recorder called even on success", async () => {
    const tdd = makeTdd([{ status: "GREEN" }]);
    const advisor = makeAdvisor(["AC met."]);
    const ghOut = makeGh();
    const rec = makeRecorder();

    await runChildAdvisorGate(300, CHILD_BODY_LIVE, PARENT_BODY_LIVE_AC, {
      tdd: tdd.runner,
      advisor: advisor.client,
      gh: ghOut.gh,
      recorder: rec.recorder,
      logger: silentLogger,
    });

    expect(rec.records.length).toBe(1);
    const counters = rec.records[0].counters as { verified: boolean; advisorCalls: number };
    expect(counters.verified).toBe(true);
    expect(counters.advisorCalls).toBe(1);
  });

  test("recorder called even on failure", async () => {
    const tdd = makeTdd([
      { status: "GREEN" },
      { status: "GREEN" },
      { status: "GREEN" },
    ]);
    const advisor = makeAdvisor([
      "AC not met: r1",
      "AC not met: r2",
      "AC not met: r3",
    ]);
    const ghOut = makeGh();
    const rec = makeRecorder();

    await runChildAdvisorGate(301, CHILD_BODY_LIVE, PARENT_BODY_LIVE_AC, {
      tdd: tdd.runner,
      advisor: advisor.client,
      gh: ghOut.gh,
      recorder: rec.recorder,
      logger: silentLogger,
    });

    expect(rec.records.length).toBe(1);
    const counters = rec.records[0].counters as { verified: boolean; advisorRejections: number };
    expect(counters.verified).toBe(false);
    expect(counters.advisorRejections).toBe(3);
  });
});

// =========================================================================
// Integration: parent has no live-AC at all → child treated pure-component
// =========================================================================

describe("runChildAdvisorGate — parent with no live-AC bullets", () => {
  test("child Covers AC#1 but parent has no live-AC → pure-component, no advisor", async () => {
    const tdd = makeTdd([{ status: "GREEN" }]);
    const advisor = makeAdvisor([]);
    const ghOut = makeGh();
    const rec = makeRecorder();

    const result = await runChildAdvisorGate(400, CHILD_BODY_LIVE, PARENT_BODY_NO_LIVE_AC, {
      tdd: tdd.runner,
      advisor: advisor.client,
      gh: ghOut.gh,
      recorder: rec.recorder,
      logger: silentLogger,
    });

    expect(result.verified).toBe(true);
    expect(advisor.calls.length).toBe(0);
  });
});
