// Validates _workflow-harness.ts against the SHIPPED, known-good
// auto-grill.workflow.js. If the harness's runtime model (meta-strip, ambient
// global injection by name, top-level await/return) diverges from the real
// Workflow runtime, this fails — which is the only way to know, this session,
// that the verify-workflow test below runs the workflow the way production will.

import { test, expect } from "bun:test";
import { join } from "node:path";
import { runWorkflow } from "./_workflow-harness.ts";

const AUTO_GRILL = join(
  import.meta.dir,
  "..",
  "..",
  "skills",
  "auto-grill",
  "references",
  "auto-grill.workflow.js",
);

// Label-aware stand-in returning each stage's documented shape so the workflow
// runs all four phases to completion.
function autoGrillAgent(_prompt: string, opts: Record<string, unknown>): unknown {
  const label = String(opts.label ?? "");
  if (label === "decompose") {
    return {
      framing: "f",
      sharedAxis: "",
      storyTier: false,
      decisions: [
        { id: "D1", question: "q1", type: "PARAM", why: "w1" },
        { id: "D2", question: "q2", type: "ARCH", why: "w2" },
      ],
    };
  }
  if (label.startsWith("answer:")) {
    return {
      decisionId: label.split(":")[1],
      recommendation: "r",
      rationale: "rat",
      citations: [],
      searchedButNotFound: true,
      confidence: 0.4,
    };
  }
  if (label.startsWith("verify:")) {
    return {
      decisionId: label.split(":")[1],
      grounded: true,
      verifiedCitations: [],
      reason: "ok",
      surfacedQuestion: "",
    };
  }
  if (label === "synthesize") {
    return { markdown: "# Frame\nbody", gapQuestions: [], recommendation: "do x" };
  }
  return {};
}

test("harness runs the shipped auto-grill.workflow.js end-to-end (runtime model is faithful)", async () => {
  const { result, calls, callsFor } = await runWorkflow(AUTO_GRILL, {
    args: { topic: "Test topic", vaultPath: "/tmp", date: "2026-06-27" },
    agent: autoGrillAgent,
  });

  const r = result as Record<string, any>;
  // top-level return reached and carries the real workflow's shape
  expect(r.topic).toBe("Test topic");
  expect(r.metric.total).toBe(2);
  expect(r.metric.resolved).toBe(2);
  expect(r.markdown).toContain("Frame");

  // fan-out actually happened: 1 decompose + 2 answer + 2 verify + 1 synthesize
  expect(calls.length).toBe(6);
  expect(callsFor("decompose").length).toBe(1);
  expect(callsFor("answer:").length).toBe(2);
  expect(callsFor("verify:").length).toBe(2);
  expect(callsFor("synthesize").length).toBe(1);
});
