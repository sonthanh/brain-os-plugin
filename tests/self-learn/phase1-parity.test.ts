// MANDATORY output-parity safety for the self-learn Phase 1 refactor (#321).
//
// fixtures/expected.json was captured BEFORE any code change: the per-category
// concept-note counts of the already-extracted the-road-less-stupid notes,
// EXCLUDING Phase-3 zones (applied/, synthesis/) and _validation/. The new
// workflow's category SET must match this snapshot (strict — no fragmented or
// dropped categories, per safety §b); note COUNT lives in a ±20% soft band
// because an LLM extractor is nondeterministic.

import { test, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FIXTURE = join(
  import.meta.dir,
  "..",
  "..",
  "skills",
  "self-learn",
  "tests",
  "phase1-parity",
  "fixtures",
  "expected.json",
);
const expected = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, number>;

const ROAD = join(homedir(), "work", "brain", "knowledge", "raw", "the-road-less-stupid");
const EXCLUDED = new Set(["_validation", "applied", "synthesis"]);

test("parity fixture is a well-formed {category: positive-count} snapshot", () => {
  const keys = Object.keys(expected);
  expect(keys.length).toBeGreaterThan(0);
  for (const k of keys) {
    expect(typeof expected[k]).toBe("number");
    expect(expected[k]).toBeGreaterThan(0);
  }
});

// Grounds the snapshot against the live vault when present (the issue's Verify
// step, as a test). Skipped where the vault is absent (CI on another machine).
test.if(existsSync(ROAD))("snapshot category SET matches the live the-road Phase-1 dirs (strict)", () => {
  const liveCats = readdirSync(ROAD)
    .filter((d) => !EXCLUDED.has(d) && statSync(join(ROAD, d)).isDirectory())
    .sort();
  expect(Object.keys(expected).sort()).toEqual(liveCats);
});
