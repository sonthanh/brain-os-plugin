import { describe, expect, test } from "bun:test";
import {
  extractBashBlocks,
  normalizePlaceholders,
  bashParseError,
  pluginRootViolations,
  smokeFile,
} from "./skill-bash-smoke";

describe("extractBashBlocks", () => {
  test("extracts fenced bash blocks with start line numbers", () => {
    const md = [
      "# Title",
      "",
      "```bash",
      "echo hi",
      "```",
      "",
      "```json",
      "{}",
      "```",
      "",
      "```bash",
      "ls -la",
      "```",
    ].join("\n");
    const blocks = extractBashBlocks(md);
    expect(blocks.length).toBe(2);
    expect(blocks[0].code).toBe("echo hi");
    expect(blocks[0].startLine).toBe(3);
    expect(blocks[1].code).toBe("ls -la");
    expect(blocks[1].startLine).toBe(11);
  });

  test("ignores non-bash fences and unfenced prose", () => {
    const md = "```\nplain\n```\n```sh\necho sh-tagged\n```";
    // only `bash`-tagged fences are smoke targets (sh blocks are rare and legacy)
    expect(extractBashBlocks(md).length).toBe(0);
  });

  test("handles unterminated fence without crashing", () => {
    const md = "```bash\necho dangling";
    const blocks = extractBashBlocks(md);
    expect(blocks.length).toBe(1);
    expect(blocks[0].code).toBe("echo dangling");
  });
});

describe("normalizePlaceholders", () => {
  test("replaces angle-bracket placeholders with literal token", () => {
    expect(normalizePlaceholders("gh issue view <N> -R <tracker-repo>")).toBe(
      "gh issue view PLACEHOLDER -R PLACEHOLDER",
    );
  });

  test("replaces placeholders containing spaces", () => {
    expect(normalizePlaceholders("git add <touched files>")).toBe(
      "git add PLACEHOLDER",
    );
  });

  test("leaves heredocs, redirections and process substitution intact", () => {
    const code = [
      "cat <<'EOF'",
      "body",
      "EOF",
      "cmd >> log 2>&1",
      "while read -r L; do echo $L; done < <(echo hi)",
    ].join("\n");
    expect(normalizePlaceholders(code)).toBe(code);
  });

  test("strips pure-ellipsis lines", () => {
    expect(normalizePlaceholders("echo a\n...\necho b\n…")).toBe(
      "echo a\necho b",
    );
  });
});

describe("bashParseError", () => {
  test("returns null for valid bash", () => {
    expect(bashParseError("for i in 1 2; do echo $i; done")).toBeNull();
  });

  test("returns error message for broken bash", () => {
    const err = bashParseError("if [ -f x ]; then echo y");
    expect(err).not.toBeNull();
  });
});

describe("pluginRootViolations", () => {
  test("flags block using CLAUDE_PLUGIN_ROOT without fallback or assertion", () => {
    const code = 'bash "$CLAUDE_PLUGIN_ROOT/scripts/foo.sh"';
    expect(pluginRootViolations(code)).toBe(true);
  });

  test("accepts :- glob fallback resolution", () => {
    const code =
      'PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(ls -d ~/.claude/plugins/cache/x/*/ | tail -1)}"\nbash "$PLUGIN_ROOT/scripts/foo.sh"';
    expect(pluginRootViolations(code)).toBe(false);
  });

  test("accepts :? assertion", () => {
    const code = ': "${CLAUDE_PLUGIN_ROOT:?}"\nbash "$CLAUDE_PLUGIN_ROOT/scripts/foo.sh"';
    expect(pluginRootViolations(code)).toBe(false);
  });

  test("ignores blocks that never reference the var", () => {
    expect(pluginRootViolations("echo hi")).toBe(false);
  });
});

describe("smokeFile", () => {
  test("reports parse failures with file and line", () => {
    const md = "```bash\nif [ -f x ]; then echo y\n```";
    const findings = smokeFile("fake/SKILL.md", md, { checkPluginRoot: false });
    expect(findings.length).toBe(1);
    expect(findings[0].file).toBe("fake/SKILL.md");
    expect(findings[0].line).toBe(1);
    expect(findings[0].kind).toBe("parse");
  });

  test("clean file produces no findings", () => {
    const md = "```bash\necho ok\n```";
    expect(smokeFile("fake/SKILL.md", md, { checkPluginRoot: false }).length).toBe(0);
  });

  test("placeholder-heavy real-world recipe parses after normalization", () => {
    const md = [
      "```bash",
      "gh issue list -R <tracker-repo> --label \"status:ready\" --json number --limit 1",
      "bash \"$CLAUDE_PLUGIN_ROOT/scripts/gh-tasks/close-issue.sh\" <N>",
      "```",
    ].join("\n");
    const findings = smokeFile("fake/SKILL.md", md, { checkPluginRoot: true });
    expect(findings.filter((f) => f.kind === "parse").length).toBe(0);
    expect(findings.filter((f) => f.kind === "plugin-root").length).toBe(1);
  });
});
