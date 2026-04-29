import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveVaultPath,
  formatOutcomeLogLine,
  appendOutcomeLog,
  type OutcomeLogLine,
} from "../scripts/outcome-log.mts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "outcome-log-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(dir: string, vault: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "brain-os.config.md");
  writeFileSync(
    path,
    [
      "# Brain OS Configuration",
      "",
      "## Vault Path",
      "```",
      `vault_path: ${vault}`,
      "```",
      "",
      "## GitHub Task Repo",
      "```",
      "gh_task_repo: sonthanh/ai-brain",
      "```",
      "",
    ].join("\n"),
  );
  return path;
}

describe("resolveVaultPath", () => {
  test("reads vault_path from ~/.brain-os/brain-os.config.md when present", () => {
    const home = join(tmp, "home");
    const vault = join(tmp, "vault");
    writeConfig(join(home, ".brain-os"), vault);
    const got = resolveVaultPath({ home, env: {}, pluginRoot: "" });
    expect(got).toBe(vault);
  });

  test("user-local config takes precedence over plugin-root config", () => {
    const home = join(tmp, "home");
    const userVault = join(tmp, "user-vault");
    const pluginVault = join(tmp, "plugin-vault");
    writeConfig(join(home, ".brain-os"), userVault);
    const pluginRoot = join(tmp, "plugin");
    writeConfig(pluginRoot, pluginVault);
    const got = resolveVaultPath({ home, env: {}, pluginRoot });
    expect(got).toBe(userVault);
  });

  test("falls back to CLAUDE_PLUGIN_ROOT config when user-local missing", () => {
    const pluginRoot = join(tmp, "plugin");
    const vault = join(tmp, "vault");
    writeConfig(pluginRoot, vault);
    const got = resolveVaultPath({
      home: join(tmp, "home"),
      env: {},
      pluginRoot,
    });
    expect(got).toBe(vault);
  });

  test("returns null when no config file is reachable", () => {
    const got = resolveVaultPath({
      home: join(tmp, "home"),
      env: {},
      pluginRoot: join(tmp, "plugin"),
    });
    expect(got).toBeNull();
  });

  test("returns null when config has no vault_path key", () => {
    const home = join(tmp, "home");
    mkdirSync(join(home, ".brain-os"), { recursive: true });
    writeFileSync(
      join(home, ".brain-os", "brain-os.config.md"),
      "# config without vault_path\n",
    );
    const got = resolveVaultPath({ home, env: {}, pluginRoot: "" });
    expect(got).toBeNull();
  });
});

describe("formatOutcomeLogLine", () => {
  test("formats a minimal pass row matching skill-spec § 11", () => {
    const line: OutcomeLogLine = {
      date: "2026-04-29",
      skill: "airtable-knowledge-extract",
      action: "extract",
      source_repo: "~/work/brain-os-plugin",
      output_path: "/tmp/cache/run/metrics/base-X-rung-1.jsonl",
      commit_hash: "none",
      result: "pass",
    };
    expect(formatOutcomeLogLine(line)).toBe(
      "2026-04-29 | airtable-knowledge-extract | extract | ~/work/brain-os-plugin | /tmp/cache/run/metrics/base-X-rung-1.jsonl | commit:none | pass",
    );
  });

  test("appends optional k=v fields after result", () => {
    const line: OutcomeLogLine = {
      date: "2026-04-29",
      skill: "airtable-knowledge-extract",
      action: "extract",
      source_repo: "~/work/brain-os-plugin",
      output_path: "/tmp/x",
      commit_hash: "none",
      result: "partial",
      fields: { batches: 4, pass_rate: "0.97", base_id: "appXYZ" },
    };
    expect(formatOutcomeLogLine(line)).toBe(
      "2026-04-29 | airtable-knowledge-extract | extract | ~/work/brain-os-plugin | /tmp/x | commit:none | partial | batches=4 pass_rate=0.97 base_id=appXYZ",
    );
  });
});

describe("appendOutcomeLog", () => {
  test("creates daily/skill-outcomes/<skill>.log under vault_path and appends one line", () => {
    const vault = join(tmp, "vault");
    const result = appendOutcomeLog(
      {
        date: "2026-04-29",
        skill: "airtable-knowledge-extract",
        action: "extract",
        source_repo: "~/work/brain-os-plugin",
        output_path: "/tmp/cache/run-x/metrics.jsonl",
        commit_hash: "none",
        result: "pass",
      },
      { vaultPath: vault },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe(
      join(vault, "daily", "skill-outcomes", "airtable-knowledge-extract.log"),
    );
    expect(existsSync(result.path)).toBe(true);
    const body = readFileSync(result.path, "utf8");
    expect(body.endsWith("\n")).toBe(true);
    expect(body).toContain("airtable-knowledge-extract | extract");
    expect(body).toContain("commit:none | pass");
  });

  test("appends a second line without truncating the first", () => {
    const vault = join(tmp, "vault");
    const base: OutcomeLogLine = {
      date: "2026-04-29",
      skill: "airtable-knowledge-extract",
      action: "extract",
      source_repo: "~/work/brain-os-plugin",
      output_path: "/tmp/run/m.jsonl",
      commit_hash: "none",
      result: "pass",
    };
    appendOutcomeLog(base, { vaultPath: vault });
    appendOutcomeLog({ ...base, date: "2026-04-30", result: "partial" }, {
      vaultPath: vault,
    });
    const body = readFileSync(
      join(vault, "daily", "skill-outcomes", "airtable-knowledge-extract.log"),
      "utf8",
    );
    const lines = body.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("2026-04-29 | airtable-knowledge-extract");
    expect(lines[1]).toContain("2026-04-30 | airtable-knowledge-extract");
    expect(lines[1]).toContain("partial");
  });

  test("returns ok:false when vault_path cannot be resolved", () => {
    const result = appendOutcomeLog(
      {
        date: "2026-04-29",
        skill: "airtable-knowledge-extract",
        action: "extract",
        source_repo: "~/work/brain-os-plugin",
        output_path: "—",
        commit_hash: "none",
        result: "pass",
      },
      {
        home: join(tmp, "home"),
        env: {},
        pluginRoot: join(tmp, "plugin"),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("vault_path not resolvable");
    }
  });
});
