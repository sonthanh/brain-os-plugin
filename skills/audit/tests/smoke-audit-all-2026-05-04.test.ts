/**
 * smoke-audit-all-2026-05-04.test.ts — rung-0 smoke for parent story #253
 * (Pre-grill defensibility — Phase A) AC#7.
 *
 * Runs `/audit --all` against the known-broken Mode B grill at
 * `daily/grill-sessions/2026-05-04-airtable-mode-b-replay.md` and asserts the
 * produced `## Audit Summary` table flags P4 (concrete-validates-abstract /
 * data-shape sanity) with severity ≥ FLAG.
 *
 * Activation gate (default = SKIP):
 *   AUDIT_SMOKE_RUN=1   spawn `claude -p --model opus` against the live grill
 *
 * Default behavior is SKIP-with-WARN so `bun test` runs cleanly without
 * burning Opus tokens on every invocation; the smoke is a story-end
 * deliverable, not a per-commit gate.
 *
 * The test lands RED-on-activation by design until story child #2 (extend
 * `/audit --all` to consolidate per-principle audits into a single Audit
 * Summary table) ships. Once #2 is GREEN, running this file with
 * AUDIT_SMOKE_RUN=1 is the operator's evidence-capture step for parent #253
 * AC#7 — paste the printed `## Audit Summary` block as
 *   `Acceptance verified: AC#7 — <evidence>`
 * on parent #253, per `references/ac-coverage-spec.md` § 3.3.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SMOKE_ENABLED = process.env.AUDIT_SMOKE_RUN === "1";
const SMOKE_TIMEOUT_MS = 5 * 60 * 1000;
const FIXTURE_REL = "daily/grill-sessions/2026-05-04-airtable-mode-b-replay.md";
const VAULT_KEY = /^vault_path:\s*(.+)\s*$/m;
const VAULT_PLACEHOLDER = "/path/to/your/obsidian-vault";

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

describe("audit --all smoke (2026-05-04 grill, P4 trap detection)", () => {
  if (!SMOKE_ENABLED) {
    test.skip(
      "requires AUDIT_SMOKE_RUN=1 to spawn `claude -p --model opus` on /audit --all",
      () => {
        // Surfaces in `bun test` output; no assertions run.
      },
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
    "P4 surfaces with FLAG or FAIL keyed on data-shape / record-shape / concrete-validates-abstract semantics",
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
      if (!existsSync(fixturePath)) {
        throw new Error(
          `Smoke fixture missing: ${fixturePath}. The 2026-05-04 grill ` +
            `must exist in the vault for this smoke to run; this is the ` +
            `known-broken Mode B grill the audit is supposed to flag.`,
        );
      }

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
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      if (proc.exitCode !== 0) {
        throw new Error(
          `claude -p exited ${proc.exitCode}\n` +
            `stderr:\n${stderr}\n` +
            `stdout:\n${stdout}`,
        );
      }

      // Surface the captured `## Audit Summary` for operator paste — the
      // evidence comment on parent #253 AC#7 takes this verbatim.
      const summaryStart = stdout.indexOf("## Audit Summary");
      if (summaryStart >= 0) {
        // eslint-disable-next-line no-console -- intentional dump for AC#7 evidence capture.
        console.log(
          "\n[audit --all smoke] captured ## Audit Summary:\n" +
            stdout.slice(summaryStart),
        );
      }

      // AC#4: assert one row of the Audit Summary table is `| P4 | FLAG |`
      // or `| P4 | FAIL |`. Multiline-anchored to the start of a line so
      // surrounding prose / other principle rows don't false-positive.
      const p4Row = stdout
        .split("\n")
        .find((line) => /^\| P4 \| (FLAG|FAIL) \|/.test(line));
      if (!p4Row) {
        // eslint-disable-next-line no-console -- diagnostic dump on RED.
        console.error(
          "[audit --all smoke] P4 row absent. Captured stdout:\n" + stdout,
        );
      }
      expect(p4Row).toBeDefined();
      expect(p4Row!).toMatch(/^\| P4 \| (FLAG|FAIL) \|/);
      // Key-finding cell must mention data-shape / record-shape semantics or
      // the concrete-validates-abstract framing — those are the hallmarks of
      // the Mode B grill's missed sanity check.
      expect(p4Row!).toMatch(
        /data[- ]shape|record[- ]shape|concrete.*(?:abstract|validate)/i,
      );
    },
    SMOKE_TIMEOUT_MS + 30_000,
  );
});
