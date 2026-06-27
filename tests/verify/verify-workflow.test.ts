// Behavior contract for skills/verify/references/verify.workflow.js (issue #320).
// Runs the workflow through the runtime-faithful harness (validated in
// harness-fidelity.test.ts) with a mocked agent boundary, so the fan-out, the
// audited gate, the threshold parameter, and per-worker scope isolation are all
// exercised on the real file — no live agents, no NotebookLM.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runWorkflow } from "./_workflow-harness.ts";

const WORKFLOW = join(
  import.meta.dir,
  "..",
  "..",
  "skills",
  "verify",
  "references",
  "verify.workflow.js",
);
const BOOK = "/vault/knowledge/raw/the-road-less-stupid";

function makeItems(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    qid: `q${i + 1}`,
    question: `Question ${i + 1}?`,
    topic: `topic-${i % 3}`,
    oracleAnswer: `oracle answer ${i + 1}`,
    noteScope: [`note-${i + 1}`],
  }));
}

// Mock judge: scores per qid, and ALWAYS reports pass:true — proving the reduce
// derives the authoritative verdict from `score` vs threshold, not the worker's
// self-reported `pass`.
function judgeAgent(scoreFor: (qid: string) => number) {
  return (_prompt: string, opts: Record<string, unknown>) => {
    const qid = String(opts.label).split(":")[1];
    return { qid, score: scoreFor(qid), pass: true, gap: "" };
  };
}

test("fans out one judge per question and returns the documented shape (parallel(50))", async () => {
  const { result, callsFor } = await runWorkflow(WORKFLOW, {
    args: { items: makeItems(50), bookPath: BOOK, threshold: 95 },
    agent: judgeAgent(() => 97),
  });
  const r = result as Record<string, any>;
  expect(callsFor("judge:").length).toBe(50); // one agent per question
  expect(r).toHaveProperty("passRate");
  expect(r).toHaveProperty("audited");
  expect(Array.isArray(r.perQuestion)).toBe(true);
  expect(r.perQuestion.length).toBe(50);
  expect(Array.isArray(r.weakClusters)).toBe(true);
});

test("fan-out cardinality tracks input length (not a hardcoded 50)", async () => {
  const { callsFor } = await runWorkflow(WORKFLOW, {
    args: { items: makeItems(3), bookPath: BOOK, threshold: 95 },
    agent: judgeAgent(() => 99),
  });
  expect(callsFor("judge:").length).toBe(3);
});

test("audited=true ONLY when every score >= threshold; one miss flips it false", async () => {
  // all pass
  const allPass = await runWorkflow(WORKFLOW, {
    args: { items: makeItems(50), bookPath: BOOK, threshold: 95 },
    agent: judgeAgent(() => 96),
  });
  expect((allPass.result as any).audited).toBe(true);
  expect((allPass.result as any).passRate).toBe(1);

  // exactly one question scores 94 (< 95) — even though the worker said pass:true
  const oneFail = await runWorkflow(WORKFLOW, {
    args: { items: makeItems(50), bookPath: BOOK, threshold: 95 },
    agent: judgeAgent((qid) => (qid === "q7" ? 94 : 96)),
  });
  const r = oneFail.result as any;
  expect(r.audited).toBe(false);
  expect(r.passRate).toBeCloseTo(49 / 50, 5);
  const failed = r.perQuestion.find((p: any) => p.qid === "q7");
  expect(failed.pass).toBe(false); // reduce overrides the worker's pass:true
  // weak topic surfaced (q7 → index 6 → topic-0)
  expect(r.weakClusters.some((c: any) => c.qids.includes("q7"))).toBe(true);
});

test("threshold is an arg — the SAME runner gates at 95 (verify) and 90 (self-learn)", async () => {
  const items = makeItems(10);
  const score92 = judgeAgent(() => 92); // between 90 and 95

  const strict = await runWorkflow(WORKFLOW, { args: { items, bookPath: BOOK, threshold: 95 }, agent: score92 });
  expect((strict.result as any).audited).toBe(false); // 92 < 95

  const lenient = await runWorkflow(WORKFLOW, { args: { items, bookPath: BOOK, threshold: 90 }, agent: score92 });
  expect((lenient.result as any).audited).toBe(true); // 92 >= 90
});

test("each worker prompt is scoped to ONLY its own question + inline oracle answer", async () => {
  const { calls } = await runWorkflow(WORKFLOW, {
    args: { items: makeItems(2), bookPath: BOOK, threshold: 95 },
    agent: judgeAgent(() => 99),
  });
  const q1 = calls.find((c) => c.opts.label === "judge:q1")!;
  expect(q1.prompt).toContain("oracle answer 1"); // its own oracle
  expect(q1.prompt).not.toContain("oracle answer 2"); // no other question's oracle leaks
  expect(q1.prompt).toContain(BOOK); // book root passed
  expect(q1.prompt).toContain("note-1"); // its own note scope
  expect(q1.prompt).not.toContain("note-2");
});

test("a dead judge (null) cannot be counted as audited", async () => {
  const agent = (_p: string, opts: Record<string, unknown>) => {
    const qid = String(opts.label).split(":")[1];
    if (qid === "q3") throw new Error("worker died"); // parallel() → null
    return { qid, score: 99, pass: true, gap: "" };
  };
  const { result } = await runWorkflow(WORKFLOW, {
    args: { items: makeItems(5), bookPath: BOOK, threshold: 95 },
    agent,
  });
  // 4 of 5 judged, all ≥95, but the missing judgment forbids audited=true
  expect((result as any).audited).toBe(false);
});

test("structural: workflow exports meta, fans out via parallel(), judges qid/score/pass/gap", () => {
  const src = readFileSync(WORKFLOW, "utf8");
  expect(src).toMatch(/export const meta\b/);
  expect(src).toMatch(/parallel\(/);
  expect(src).toMatch(/\bthreshold\b/);
  for (const k of ["qid", "score", "pass", "gap"]) expect(src).toContain(k);
});
