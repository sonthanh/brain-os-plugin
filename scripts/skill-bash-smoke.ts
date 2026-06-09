#!/usr/bin/env -S bun run
/**
 * skill-bash-smoke.ts — treat skill prose as code (ai-brain#163).
 *
 * Extracts every fenced ```bash block from each skills/X/SKILL.md, normalizes
 * documentation placeholders (<N>, <tracker-repo>, ellipsis lines), then:
 *   1. `bash -n` parse check — a recipe Claude executes verbatim must at least
 *      parse. Catches broken quoting/heredocs/if-fi before they ship.
 *   2. CLAUDE_PLUGIN_ROOT fallback check — any block referencing the var must
 *      resolve it with a `:-` fallback or `:?` assertion IN THE SAME BLOCK.
 *      Root cause of the 2026-04-27 silent death: an empty $CLAUDE_PLUGIN_ROOT
 *      in a detached shell turned the script path into /scripts/run-story.ts.
 *
 * Usage:
 *   bun run scripts/skill-bash-smoke.ts            # all skills, exit 1 on findings
 *   bun run scripts/skill-bash-smoke.ts impl       # single skill
 *   bun run scripts/skill-bash-smoke.ts --report   # print findings, always exit 0
 *
 * Wired into /eval (skills/eval/SKILL.md § Implementation) so eval runs fail
 * when a SKILL.md ships a broken bash block — AC#1 + AC#4 of ai-brain#163.
 */

import { spawnSync } from "bun";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

export interface BashBlock {
  code: string;
  startLine: number; // 1-based line of the ```bash fence
}

export interface Finding {
  file: string;
  line: number;
  kind: "parse" | "plugin-root";
  detail: string;
}

export function extractBashBlocks(md: string): BashBlock[] {
  const lines = md.split("\n");
  const blocks: BashBlock[] = [];
  let current: string[] | null = null;
  let startLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (current === null) {
      if (/^```bash\s*$/.test(line)) {
        current = [];
        startLine = i + 1;
      }
    } else if (/^```\s*$/.test(line)) {
      blocks.push({ code: current.join("\n"), startLine });
      current = null;
    } else {
      current.push(line);
    }
  }
  if (current !== null) blocks.push({ code: current.join("\n"), startLine });
  return blocks;
}

// Replace documentation placeholders so bash -n sees parseable syntax:
// `<N>`, `<tracker-repo>`, `<touched files>` → PLACEHOLDER. Heredocs (`<<`),
// redirections (`< file`), and process substitution (`<(`) are untouched
// because the pattern requires a letter immediately after `<` and a closing
// `>` on the same line. Spaces are allowed inside (placeholders like
// `<touched files>`); a real `a <in >out` redirect pair would be collapsed
// too, but that only relaxes the check — it cannot create a false failure.
export function normalizePlaceholders(code: string): string {
  return code
    .split("\n")
    .filter((l) => !/^\s*(\.{3}|…)\s*$/.test(l))
    .map((l) => l.replace(/(?<!<)<[A-Za-z][^<>]*>/g, "PLACEHOLDER"))
    .join("\n");
}

export function bashParseError(code: string): string | null {
  const proc = spawnSync(["bash", "-n"], {
    stdin: Buffer.from(code),
    stderr: "pipe",
    stdout: "ignore",
  });
  if (proc.exitCode === 0) return null;
  const err = new TextDecoder().decode(proc.stderr).trim();
  return err || `bash -n exited ${proc.exitCode}`;
}

// A block referencing CLAUDE_PLUGIN_ROOT must make resolution explicit in the
// same block: either a `${CLAUDE_PLUGIN_ROOT:-...}` fallback or a
// `${CLAUDE_PLUGIN_ROOT:?}` fail-loud assertion.
export function pluginRootViolations(code: string): boolean {
  if (!code.includes("CLAUDE_PLUGIN_ROOT")) return false;
  return !/CLAUDE_PLUGIN_ROOT:[-?]/.test(code);
}

export interface SmokeOpts {
  checkPluginRoot: boolean;
}

export function smokeFile(
  file: string,
  md: string,
  opts: SmokeOpts,
): Finding[] {
  const findings: Finding[] = [];
  for (const block of extractBashBlocks(md)) {
    const normalized = normalizePlaceholders(block.code);
    const parseErr = bashParseError(normalized);
    if (parseErr !== null) {
      findings.push({
        file,
        line: block.startLine,
        kind: "parse",
        detail: parseErr.split("\n")[0],
      });
      continue; // a block that doesn't parse gets one finding, not two
    }
    if (opts.checkPluginRoot && pluginRootViolations(block.code)) {
      findings.push({
        file,
        line: block.startLine,
        kind: "plugin-root",
        detail:
          "uses $CLAUDE_PLUGIN_ROOT without `:-` fallback or `:?` assertion in the same block",
      });
    }
  }
  return findings;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const report = args.includes("--report");
  const skillFilter = args.find((a) => !a.startsWith("--"));

  const repoRoot = join(import.meta.dir, "..");
  const skillsDir = join(repoRoot, "skills");
  const skills = readdirSync(skillsDir).filter((s) =>
    existsSync(join(skillsDir, s, "SKILL.md")),
  );
  const targets = skillFilter ? skills.filter((s) => s === skillFilter) : skills;
  if (skillFilter && targets.length === 0) {
    console.error(`FATAL: no skill named '${skillFilter}' under ${skillsDir}`);
    process.exit(2);
  }

  const all: Finding[] = [];
  for (const s of targets) {
    const path = join(skillsDir, s, "SKILL.md");
    const md = readFileSync(path, "utf-8");
    all.push(...smokeFile(`skills/${s}/SKILL.md`, md, { checkPluginRoot: true }));
  }

  const parse = all.filter((f) => f.kind === "parse");
  const root = all.filter((f) => f.kind === "plugin-root");
  for (const f of all) {
    console.log(`${f.kind.toUpperCase()}  ${f.file}:${f.line}  ${f.detail}`);
  }
  console.log(
    `\nskill-bash-smoke: ${targets.length} skill(s), ${parse.length} parse failure(s), ${root.length} plugin-root violation(s)`,
  );
  process.exit(report || all.length === 0 ? 0 : 1);
}
