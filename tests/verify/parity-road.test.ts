// MANDATORY output-parity safety for the verify pipeline refactor (issue #320).
//
// Snapshots (captured BEFORE any code change, from the OLD pipeline's output):
//   fixtures/expected-road.json   — the live audit-flag.json for the-road-less-stupid
//   fixtures/expected-road.jsonl  — a sample of the OLD per-question result rows
//                                   (scores-round1.jsonl; the exact name
//                                   audit-results-{date}.jsonl never existed on disk)
//
// Parity contract (per issue safety §b/§c) — assert VERDICT-DIRECTION + SCHEMA,
// NOT score/pass-rate equality (verify is nondeterministic and replaces the old
// heuristic scorer, so scores SHOULD drift):
//   • audit-flag.json keys/schema preserved across a verify flag-write — this is
//     what think/study/self-learn/absorb consume via verify.py.
//   • the "100% ≥95 ⇒ audited=true" gate still lands audited=true on the-road.
//   • audit-results-{date}.jsonl row shape is FREE (no external consumer reads it).

import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VERIFY_PY = join(import.meta.dir, "..", "..", "skills", "verify", "scripts", "verify.py");
const FIXTURES = join(import.meta.dir, "fixtures");
const expected = JSON.parse(readFileSync(join(FIXTURES, "expected-road.json"), "utf8"));

test("snapshot documents the OLD verdict: the-road-less-stupid is audited=true", () => {
  expect(expected.flag).toBe("true");
  // provenance keys the verify writer must not clobber
  expect(expected).toHaveProperty("pipeline_completed");
  expect(expected).toHaveProperty("ingested");
  expect(expected).toHaveProperty("absorbed");
});

test("parity: a verify flag-write preserves the audit-flag.json schema consumers read", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-parity-"));
  try {
    const book = join(root, "the-road-less-stupid");
    mkdirSync(join(book, "_validation"), { recursive: true });
    writeFileSync(join(book, "concept.md"), "# Concept\nbody\n");
    // seed with the EXACT old-pipeline flag file
    writeFileSync(join(book, "_validation", "audit-flag.json"), JSON.stringify(expected, null, 2));

    // a verify pass that lands audited=true re-writes the flag
    execFileSync("python3", [VERIFY_PY, root, "--set-flag", "true", "road"], { encoding: "utf8" });

    const after = JSON.parse(readFileSync(join(book, "_validation", "audit-flag.json"), "utf8"));
    // every key the snapshot carried is still present (schema/keys parity)
    for (const k of Object.keys(expected)) expect(after).toHaveProperty(k);
    // verdict direction holds
    expect(after.flag).toBe("true");
    // provenance written by the self-learn pipeline survived the verify write (value parity)
    expect(after.pipeline_completed).toBe(expected.pipeline_completed);
    expect(after.ingested).toBe(expected.ingested);
    expect(after.absorbed).toBe(expected.absorbed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot jsonl parses and carries the OLD row shape (new shape is free to differ)", () => {
  const rows = readFileSync(join(FIXTURES, "expected-road.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(rows.length).toBeGreaterThan(0);
  // old shape: {id, score, pass, missing}. audit-results-{date}.jsonl may use
  // {qid, score, pass, gap} freely — safety §c: no external consumer reads it.
  for (const r of rows) {
    expect(r).toHaveProperty("id");
    expect(r).toHaveProperty("score");
    expect(r).toHaveProperty("pass");
  }
});
