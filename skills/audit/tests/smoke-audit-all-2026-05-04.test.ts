/**
 * smoke-audit-all-2026-05-04.test.ts — rung-0 smoke for parent story #253
 * (Pre-grill defensibility — Phase A) AC#7. See also #260, which fixed two
 * contract drifts this test originally embodied.
 *
 * Runs `/audit --all` against the known-broken Mode B grill at
 * `daily/grill-sessions/2026-05-04-airtable-mode-b-replay.md` and asserts the
 * P4 row in `{vault}/thinking/principles/tracker.md` (NOT stdout) flags the
 * lock-before-validate / data-shape / concrete-validates-abstract violation
 * with a FLAG or FAIL verdict.
 *
 * Activation gate (default = SKIP):
 *   AUDIT_SMOKE_RUN=1   spawn `claude -p --model opus` against the live grill
 *
 * Why read artifacts instead of stdout (history per #260):
 *   The first AC#7 run on 2026-05-07 surfaced two contract drifts. (1) The
 *   previous SMOKE_TIMEOUT_MS = 5 min wasn't enough for a real 5-principle
 *   sequential opus audit (real run = 13:52). (2) The runner emitted a `## Run
 *   summary` prose block instead of the `## Audit Summary` table the original
 *   regex (`^\| P[0-9]+ \| (PASS|FLAG|FAIL) \|`) was anchored on, so even with
 *   a longer timeout the assertion would have FAILed on format drift. The
 *   tracker rows + audit.log row, however, ARE part of the SKILL.md outcome
 *   contract (§ "Tracker Integration", § "Outcome log") — they survive any
 *   future runner-side prose reshuffle. Reading the artifact makes the
 *   assertion durable.
 *
 * Default behavior is SKIP-with-WARN so `bun test` runs cleanly without
 * burning Opus tokens on every invocation; the smoke is a story-end
 * deliverable, not a per-commit gate.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SMOKE_ENABLED = process.env.AUDIT_SMOKE_RUN === "1";
const SMOKE_TIMEOUT_MS = 25 * 60 * 1000;
const FIXTURE_REL = "daily/grill-sessions/2026-05-04-airtable-mode-b-replay.md";
const FIXTURE_TAG = "2026-05-04-airtable-mode-b-replay";
const TRACKER_REL = "thinking/principles/tracker.md";
const AUDIT_LOG_REL = "daily/skill-outcomes/audit.log";
const VAULT_KEY = /^vault_path:\s*(.+)\s*$/m;
const VAULT_PLACEHOLDER = "/path/to/your/obsidian-vault";
const DATA_SHAPE_REGEX =
  /data[- ]shape|record[- ]shape|concrete.*(?:abstract|validate)|lock[- ]before[- ]validate/i;

function resolveVaultPath(): string | null {
  const home = homedir();
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? "";
  const candidates = [
    join(home, ".brain-os", "brain-os.config.md"),
    pluginRoot ? join(pluginRoot, "brain-os.config.md") : "",
  ].filter((p) => p.length > 0);
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const match = VAULT_KEY.exec(readFileSync(path, "utf8"));
    if (!match) continue;
    const value = match[1].trim();
    if (value && value !== VAULT_PLACEHOLDER) return value;
  }
  return null;
}

interface TrackerRow {
  date: string;
  principle: string;
  context: string;
  outcome: string;
  raw: string;
}

function parseTrackerRow(line: string): TrackerRow | null {
  // Tracker rows: `| YYYY-MM-DD | P{N} | <context> | <outcome> |`
  const cells = line.split("|").map((c) => c.trim());
  // cells[0] is empty (leading `|`), cells[5] is empty (trailing `|`)
  if (cells.length < 5) return null;
  const date = cells[1];
  const principle = cells[2];
  const context = cells[3];
  const outcome = cells[4];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (!/^P[1-5]$/.test(principle)) return null;
  return { date, principle, context, outcome, raw: line };
}

describe("audit --all smoke (2026-05-04 grill, P4 trap detection)", () => {
  if (!SMOKE_ENABLED) {
    test.skip(
      "requires AUDIT_SMOKE_RUN=1 to spawn `claude -p --model opus` on /audit --all",
      () => {},
    );
    // eslint-disable-next-line no-console -- intentional CI WARN per acceptance.
    console.warn(
      "[audit --all smoke] SKIPPED: set AUDIT_SMOKE_RUN=1 to run live " +
        "`claude -p --model opus /audit --all` against the 2026-05-04 grill " +
        "fixture and capture parent #253 AC#7 evidence.",
    );
    return;
  }

  test(
    "P4 surfaces with FLAG or FAIL keyed on data-shape / record-shape / concrete-validates-abstract semantics (artifact read)",
    async () => {
      const vault = resolveVaultPath();
      if (!vault) {
        throw new Error(
          "AUDIT_SMOKE_RUN=1 set but vault_path is unresolved. " +
            "Configure ~/.brain-os/brain-os.config.md with a real vault_path " +
            "(or set CLAUDE_PLUGIN_ROOT to a brain-os install whose config " +
            "names a real vault), then re-run.",
        );
      }
      const fixturePath = join(vault, FIXTURE_REL);
      const trackerPath = join(vault, TRACKER_REL);
      const auditLogPath = join(vault, AUDIT_LOG_REL);
      for (const required of [fixturePath, trackerPath]) {
        if (!existsSync(required)) {
          throw new Error(
            `Required path missing: ${required}. The vault must contain the ` +
              `fixture grill + tracker.md for this smoke to run.`,
          );
        }
      }

      // Snapshot tracker BEFORE the run so we can detect new rows.
      const trackerBefore = readFileSync(trackerPath, "utf8");
      const auditLogBefore = existsSync(auditLogPath)
        ? readFileSync(auditLogPath, "utf8")
        : "";

      const prompt = `/audit --all ${fixturePath}`;
      const proc = Bun.spawn(
        [
          "claude",
          "-p",
          "--model",
          "opus",
          "--dangerously-skip-permissions",
          prompt,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const stdoutP = new Response(proc.stdout).text();
      const stderrP = new Response(proc.stderr).text();
      await proc.exited;
      const stdout = await stdoutP;
      const stderr = await stderrP;

      if (proc.exitCode !== 0) {
        throw new Error(
          `claude -p exited ${proc.exitCode}\n` +
            `stderr (head):\n${stderr.slice(0, 2000)}\n` +
            `stdout (head):\n${stdout.slice(0, 2000)}`,
        );
      }

      const trackerAfter = readFileSync(trackerPath, "utf8");
      const auditLogAfter = existsSync(auditLogPath)
        ? readFileSync(auditLogPath, "utf8")
        : "";
      const newTrackerLines = trackerAfter
        .slice(trackerBefore.length)
        .split("\n")
        .filter((l) => l.trim().length > 0);
      const newAuditLogLines = auditLogAfter
        .slice(auditLogBefore.length)
        .split("\n")
        .filter((l) => l.trim().length > 0);

      const newRows = newTrackerLines
        .map(parseTrackerRow)
        .filter((r): r is TrackerRow => r !== null)
        .filter((r) => r.context.includes(FIXTURE_TAG));

      // eslint-disable-next-line no-console -- intentional dump for AC#7 evidence capture.
      console.log(
        "\n[audit --all smoke] new tracker rows tagged with " +
          `${FIXTURE_TAG}:\n${newRows.map((r) => r.raw).join("\n")}\n\n` +
          `new audit.log lines:\n${newAuditLogLines.join("\n")}\n`,
      );

      // Contract: --all must append exactly 5 tracker rows (P1..P5) tagged
      // with the fixture. Anything other than 5 means the SKILL.md
      // tracker-integration contract regressed.
      const principles = new Set(newRows.map((r) => r.principle));
      expect(newRows.length).toBe(5);
      for (const p of ["P1", "P2", "P3", "P4", "P5"]) {
        expect(principles.has(p)).toBe(true);
      }

      // Locate the P4 row, assert FLAG or FAIL with data-shape semantics.
      const p4 = newRows.find((r) => r.principle === "P4");
      expect(p4).toBeDefined();
      expect(p4!.outcome).toMatch(/^(FLAG|FAIL)\b/);
      expect(p4!.outcome).toMatch(DATA_SHAPE_REGEX);

      // audit.log: at least one new row tagged with --all from this run.
      expect(
        newAuditLogLines.some(
          (l) => l.includes('args="--all"') && l.includes("audit"),
        ),
      ).toBe(true);
    },
    SMOKE_TIMEOUT_MS + 60_000,
  );
});
