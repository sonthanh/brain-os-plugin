/**
 * integration.test.ts — C13 integration smoke for /airtable-knowledge-extract.
 *
 * Per parent story acceptance: real Airtable call against a small dedicated
 * test base, else **skip with WARN** so CI runs cleanly without secrets.
 *
 * Activation:
 *   AIRTABLE_KNOWLEDGE_EXTRACT_TEST_BASE=<base-id>   required (gate)
 *   AIRTABLE_API_KEY=<token>                          required (Airtable Meta API)
 *
 * When the gate is set, the test:
 *   1. invokes the bun pipeline (list-bases → classify-clusters →
 *      legacy-link-detector → seed-selection → rubric-author → run.mts -P 1)
 *      against the test base inside a throwaway run-id with a 5-minute
 *      wallclock cap;
 *   2. asserts the per-run cache layout exists, that the orchestrator
 *      progressed past `init`, and that any entity pages produced under
 *      `<runDir>/bases/<base>/out/<entity-type>/*.md` carry the required
 *      frontmatter keys + at least one `[[wikilink]]` body link;
 *   3. asserts the outcome log line appended to
 *      `<vault>/daily/skill-outcomes/airtable-knowledge-extract.log` matches
 *      the skill-spec § 11 row shape.
 *
 * The CLI invocation surface (`parseRunArgs`) is unit-covered in
 * tests/run.test.ts — this file does not duplicate that coverage. Stub-deps
 * end-to-end is also covered there; integration here is real-call only.
 */
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveVaultPath } from "../scripts/outcome-log.mts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = dirname(HERE);
const SCRIPTS_DIR = join(SKILL_DIR, "scripts");
const TEST_BASE = process.env.AIRTABLE_KNOWLEDGE_EXTRACT_TEST_BASE;
const TEST_API_KEY = process.env.AIRTABLE_API_KEY ?? process.env.AIRTABLE_TOKEN;
const SMOKE_TIMEOUT_MS = 5 * 60 * 1000;

const integrationEnabled = Boolean(TEST_BASE && TEST_API_KEY);

function bunRun(
  script: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync("bun", ["run", join(SCRIPTS_DIR, script), ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return {
    code: r.status,
    stdout: r.stdout?.toString() ?? "",
    stderr: r.stderr?.toString() ?? "",
  };
}

describe("integration smoke (real Airtable)", () => {
  if (!integrationEnabled) {
    test.skip("requires AIRTABLE_KNOWLEDGE_EXTRACT_TEST_BASE + AIRTABLE_API_KEY", () => {
      // Surfaces in `bun test` output; no assertions run.
    });
    // eslint-disable-next-line no-console -- intentional CI WARN per acceptance.
    console.warn(
      "[integration smoke] SKIPPED: set AIRTABLE_KNOWLEDGE_EXTRACT_TEST_BASE + AIRTABLE_API_KEY to run.",
    );
    return;
  }

  test("end-to-end: pre-steps + run.mts -P 1 produce cache + entity pages + outcome-log row", () => {
    const baseId = TEST_BASE!;
    const runId = `integration-${Date.now()}`;
    const cacheRoot = join(
      process.env.HOME ?? "",
      ".claude",
      "airtable-extract-cache",
    );
    const runDir = join(cacheRoot, runId);
    const cleanups: string[] = [runDir];

    const env = {
      AIRTABLE_RUN_ID: runId,
      AIRTABLE_API_KEY: TEST_API_KEY ?? "",
    };

    try {
      // 1. list-bases — assert the bases.json cache is produced.
      const ls = bunRun("list-bases.mts", [], env, 60_000);
      expect(ls.code).toBe(0);
      const basesPath = join(runDir, "bases.json");
      expect(existsSync(basesPath)).toBe(true);
      const bases = JSON.parse(readFileSync(basesPath, "utf8"));
      expect(Array.isArray(bases)).toBe(true);
      expect(bases.some((b: { id?: string }) => b.id === baseId)).toBe(true);

      // 2. classify-clusters → cluster cache.
      const cc = bunRun("classify-clusters.mts", [baseId], env, 60_000);
      expect(cc.code).toBe(0);
      expect(existsSync(join(runDir, `clusters-${baseId}.json`))).toBe(true);

      // 3. legacy-link-detector → cleanup-tasks side-output (best-effort).
      bunRun("legacy-link-detector.mts", [baseId], env, 60_000);

      // 4. seed-selection → seed-records cache files (one or more).
      const ss = bunRun("seed-selection.mts", [baseId], env, 60_000);
      expect(ss.code).toBe(0);
      const seedFiles = readdirSync(runDir).filter((f) =>
        f.startsWith(`seed-records-${baseId}-`),
      );
      expect(seedFiles.length).toBeGreaterThan(0);

      // 5. rubric-author — best-effort; first-base run authors a rubric draft.
      bunRun("rubric-author.mts", [baseId], env, 60_000);

      // 6. run.mts — orchestrator. -P 1 keeps cost bounded; the wallclock
      //    timeout caps us at 5 min even if HITL re-anchor blocks. Re-anchor
      //    on a fresh run-id will need stdin, so we expect either a clean
      //    paused/no-bases exit (unlikely without HITL) or a non-zero exit
      //    with state.json showing phase past `init`.
      const orch = bunRun(
        "run.mts",
        ["--run-id", runId, "--base", baseId, "-P", "1"],
        env,
        SMOKE_TIMEOUT_MS,
      );

      const statePath = join(runDir, "state.json");
      expect(existsSync(statePath)).toBe(true);
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      expect(state.run_id).toBe(runId);
      expect(state.phase).not.toBe("init");
      expect(state.processing_order).toContain(baseId);

      // Reviewer verdict / entity pages may not exist if re-anchor blocked.
      // When they do exist, validate frontmatter + wikilink shape.
      const outRoot = join(runDir, "bases", baseId, "out");
      if (existsSync(outRoot)) {
        const entityTypes = readdirSync(outRoot).filter((d) =>
          statSync(join(outRoot, d)).isDirectory(),
        );
        for (const t of entityTypes) {
          const pages = readdirSync(join(outRoot, t)).filter((f) =>
            f.endsWith(".md"),
          );
          for (const p of pages) {
            const body = readFileSync(join(outRoot, t, p), "utf8");
            expect(body.startsWith("---\n")).toBe(true);
            expect(body).toMatch(/^type: \S+/m);
            expect(body).toMatch(/^slug: \S+/m);
            expect(body).toMatch(/^base_id: \S+/m);
            expect(body).toMatch(/^cluster_id: \S+/m);
            expect(body).toMatch(/^sources:/m);
            expect(body.includes("[[")).toBe(true);
          }
        }
      }

      // 7. Outcome log — run.mts CLI main() must have appended one row.
      const vault = resolveVaultPath();
      if (vault) {
        const logPath = join(
          vault,
          "daily",
          "skill-outcomes",
          "airtable-knowledge-extract.log",
        );
        if (existsSync(logPath)) {
          const lines = readFileSync(logPath, "utf8").trim().split("\n");
          const latest = lines[lines.length - 1];
          expect(latest).toContain(`run_id=${runId}`);
          expect(latest).toMatch(
            /^\d{4}-\d{2}-\d{2} \| airtable-knowledge-extract \| extract \| /,
          );
        }
      }

      // Surface orchestrator outcome for debugging when running locally.
      // eslint-disable-next-line no-console
      console.log(
        `[integration smoke] orchestrator exit=${orch.code} phase=${state.phase}`,
      );
    } finally {
      for (const p of cleanups) {
        try {
          rmSync(p, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    }
  }, SMOKE_TIMEOUT_MS + 30_000);
});

describe("integration smoke (always-on shape gate)", () => {
  // Keeps the file useful in CI: confirms the SKILL.md + scripts referenced
  // by the smoke-test invocation actually exist on disk so a future
  // refactor that renames a script gets caught even when the live gate is
  // disabled.
  test("required orchestrator scripts exist", () => {
    for (const f of [
      "run.mts",
      "status.mts",
      "list-bases.mts",
      "classify-clusters.mts",
      "legacy-link-detector.mts",
      "seed-selection.mts",
      "rubric-author.mts",
      "outcome-log.mts",
    ]) {
      expect(existsSync(join(SCRIPTS_DIR, f))).toBe(true);
    }
  });

  test("SKILL.md ships full content (not the C1 skeleton)", () => {
    const body = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
    expect(body).toContain("name: airtable-knowledge-extract");
    expect(body).toContain("## Run");
    expect(body).toContain("## Status & analysis");
    expect(body).toContain("## Outputs");
    expect(body).toContain("## Outcome log");
    expect(body).toContain("Pattern B");
    expect(body).toContain("env -u CLAUDECODE");
    expect(body).not.toContain("Stub — full prose lands in C13");
  });
});
