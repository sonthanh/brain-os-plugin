/**
 * smoke-audit-team-2026-05-04.test.ts — rung-0 smoke for parent story #252
 * (Agent-teams audit consensus, Phase B) AC#7.
 *
 * Runs `/audit --team` against the same Mode B grill at
 * `daily/grill-sessions/2026-05-04-airtable-mode-b-replay.md` that Phase A
 * smoke (`smoke-audit-all-2026-05-04.test.ts`) used, and asserts:
 *
 *   - 5 P1..P5 tracker rows tagged with the fixture (same contract as --all).
 *   - P4 row carries FLAG or FAIL with lock-before-validate / data-shape /
 *     concrete-validates-abstract semantics — same load-bearing finding the
 *     --all run reproducibly catches.
 *   - audit.log carries `args="--team"` row with a `variance=` field
 *     (REQUIRED per SKILL.md § Outcome log; check-all-flag.sh guards the
 *     prose contract, this test guards the runtime emission).
 *   - audit.log row's `findings=` totals 5 (2FLAG+3PASS, 1FAIL+4PASS, etc.) —
 *     same arithmetic as --all.
 *
 * Activation gate (default = SKIP):
 *   AUDIT_TEAM_SMOKE_RUN=1   spawn `claude -p --model opus` on /audit --team
 *
 * Why default-skip + artifact-read (history per Phase A and Phase B story
 * body — ai-brain#252 § "Why unblock now"):
 *   The original Phase A smoke run on 2026-05-07 surfaced two contract drifts
 *   that necessitated artifact-read assertions: (1) timing variance across
 *   the 5 sequential principle calls, (2) runner-side prose drift between
 *   `## Run summary` and `## Audit Summary`. The tracker rows + audit.log
 *   row are part of the SKILL.md outcome contract and survive any
 *   future runner-side prose reshuffle.
 *
 *   `--team` adds a third observability surface: per-teammate JSON files in
 *   `~/.claude/audit-runs/{run-id}/`. This test ALSO checks that the run
 *   directory exists post-run with at least 5 `agent-pN-*.json` files
 *   (proves TeamCreate + spawn fired and teammates wrote their state).
 *
 * Default behavior is SKIP-with-WARN so `bun test` runs cleanly without
 * burning Opus tokens on every invocation; the smoke is a story-end
 * deliverable, not a per-commit gate.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SMOKE_ENABLED = process.env.AUDIT_TEAM_SMOKE_RUN === "1";
// Team mode is more expensive: 10 teammates × 3 rounds. Bump timeout vs --all.
const SMOKE_TIMEOUT_MS = 45 * 60 * 1000;
const FIXTURE_REL = "daily/grill-sessions/2026-05-04-airtable-mode-b-replay.md";
const FIXTURE_TAG = "2026-05-04-airtable-mode-b-replay";
const TRACKER_REL = "thinking/principles/tracker.md";
const AUDIT_LOG_REL = "daily/skill-outcomes/audit.log";
const VAULT_KEY = /^vault_path:\s*(.+)\s*$/m;
const VAULT_PLACEHOLDER = "/path/to/your/obsidian-vault";
const DATA_SHAPE_REGEX =
  /data[- ]shape|record[- ]shape|concrete.*(?:abstract|validate)|lock[- ]before[- ]validate/i;
const RUN_DIR_BASE = join(homedir(), ".claude", "audit-runs");

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
  const cells = line.split("|").map((c) => c.trim());
  if (cells.length < 5) return null;
  const date = cells[1];
  const principle = cells[2];
  const context = cells[3];
  const outcome = cells[4];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (!/^P[1-5]$/.test(principle)) return null;
  return { date, principle, context, outcome, raw: line };
}

describe("audit --team smoke (2026-05-04 grill, Phase B AC#7)", () => {
  if (!SMOKE_ENABLED) {
    test.skip(
      "requires AUDIT_TEAM_SMOKE_RUN=1 to spawn `claude -p --model opus` on /audit --team",
      () => {},
    );
    // eslint-disable-next-line no-console -- intentional CI WARN per acceptance.
    console.warn(
      "[audit --team smoke] SKIPPED: set AUDIT_TEAM_SMOKE_RUN=1 to run live " +
        "`claude -p --model opus /audit --team` against the 2026-05-04 grill " +
        "fixture and capture parent #252 AC#7 evidence.",
    );
    return;
  }

  test(
    "P4 surfaces with FLAG/FAIL on data-shape semantics; audit.log carries variance= field; run dir contains per-teammate JSONs",
    async () => {
      const vault = resolveVaultPath();
      if (!vault) {
        throw new Error(
          "AUDIT_TEAM_SMOKE_RUN=1 set but vault_path is unresolved. " +
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

      // Snapshot tracker + audit.log + audit-runs/ BEFORE the run.
      const trackerBefore = readFileSync(trackerPath, "utf8");
      const auditLogBefore = existsSync(auditLogPath)
        ? readFileSync(auditLogPath, "utf8")
        : "";
      const runDirsBefore = existsSync(RUN_DIR_BASE)
        ? new Set(
            readdirSync(RUN_DIR_BASE).filter((d) => d.startsWith("audit-")),
          )
        : new Set<string>();

      // Load the plugin from source (this repo) via --plugin-dir so the
      // freshly-added principle-auditor-pN agents + audit-team-consensus.sh
      // hook are picked up regardless of plugin-cache drift state. Without
      // --plugin-dir the subprocess loads from ~/.claude/plugins/cache/, which
      // may lag behind source until the user runs `/plugins update`.
      const pluginDir =
        process.env.BRAIN_OS_PLUGIN_DIR ?? join(homedir(), "work", "brain-os-plugin");
      const prompt = `/audit --team ${fixturePath}`;
      const proc = Bun.spawn(
        [
          "claude",
          "-p",
          "--model",
          "opus",
          "--plugin-dir",
          pluginDir,
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

      // Find the new run dir created during the test.
      const runDirsAfter = existsSync(RUN_DIR_BASE)
        ? readdirSync(RUN_DIR_BASE).filter((d) => d.startsWith("audit-"))
        : [];
      const newRunDirs = runDirsAfter.filter((d) => !runDirsBefore.has(d));

      // eslint-disable-next-line no-console -- intentional dump for AC#7 evidence capture.
      console.log(
        "\n[audit --team smoke] new tracker rows tagged with " +
          `${FIXTURE_TAG}:\n${newRows.map((r) => r.raw).join("\n")}\n\n` +
          `new audit.log lines:\n${newAuditLogLines.join("\n")}\n\n` +
          `new run dirs:\n${newRunDirs.join("\n")}\n`,
      );

      // --- Tracker contract: 5 rows P1..P5 tagged with the fixture ---
      const principles = new Set(newRows.map((r) => r.principle));
      expect(newRows.length).toBe(5);
      for (const p of ["P1", "P2", "P3", "P4", "P5"]) {
        expect(principles.has(p)).toBe(true);
      }

      // --- P4 contract: FLAG or FAIL with data-shape semantics ---
      const p4 = newRows.find((r) => r.principle === "P4");
      expect(p4).toBeDefined();
      expect(p4!.outcome).toMatch(/^(FLAG|FAIL)\b/);
      expect(p4!.outcome).toMatch(DATA_SHAPE_REGEX);

      // --- audit.log contract: row tagged --team with variance= field ---
      const teamRows = newAuditLogLines.filter(
        (l) => l.includes('args="--team"') && l.includes("audit"),
      );
      expect(teamRows.length).toBeGreaterThanOrEqual(1);
      const teamRow = teamRows[0];
      expect(teamRow).toMatch(/variance=/);
      expect(teamRow).toMatch(
        /variance=(converged|split:P[1-5]|scope-flagged:P2-)/,
      );
      // `findings=` totals 5 across all 5 principles.
      const findingsMatch = teamRow.match(/findings=([^\s|]+)/);
      expect(findingsMatch).not.toBeNull();
      const counts = (findingsMatch![1].match(/(\d+)(PASS|FLAG|FAIL)/g) || [])
        .map((s) => parseInt(s.match(/^\d+/)![0], 10))
        .reduce((a, b) => a + b, 0);
      expect(counts).toBe(5);

      // --- Run dir contract: per-teammate JSONs exist ---
      expect(newRunDirs.length).toBeGreaterThanOrEqual(1);
      const newDir = join(RUN_DIR_BASE, newRunDirs[0]);
      const agentJsons = readdirSync(newDir).filter(
        (f) => f.startsWith("agent-p") && f.endsWith(".json"),
      );
      // At minimum: one agent per principle (5). With N=2 default: 10.
      expect(agentJsons.length).toBeGreaterThanOrEqual(5);
      const principlesInDir = new Set(
        agentJsons.map((f) => f.match(/^agent-(p[1-5])-/)?.[1]).filter(Boolean),
      );
      for (const p of ["p1", "p2", "p3", "p4", "p5"]) {
        expect(principlesInDir.has(p)).toBe(true);
      }
    },
    SMOKE_TIMEOUT_MS + 60_000,
  );
});
