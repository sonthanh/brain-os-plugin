import { describe, expect, test } from "bun:test";
import { spawnSync } from "bun";
import { join } from "path";

const SCRIPT = join(import.meta.dir, "..", "create-task-issue.sh");

function run(args: string[]) {
  const proc = spawnSync(["bash", SCRIPT, ...args]);
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode ?? -1,
  };
}

const VALID = [
  "--title", "test issue",
  "--body", "body content",
  "--area", "plugin-brain-os",
  "--owner", "bot",
  "--priority", "p2",
  "--weight", "quick",
  "--status", "ready",
];

describe("create-task-issue.sh", () => {
  test("--help exits 0 and prints usage", () => {
    const r = run(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("create-task-issue.sh");
    expect(r.stdout).toMatch(/--title/);
  });

  test("--dry-run prints gh issue create with all canon labels", () => {
    const r = run([...VALID, "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("gh issue create");
    expect(r.stdout).toContain("-R sonthanh/ai-brain");
    expect(r.stdout).toContain("--title 'test issue'");
    expect(r.stdout).toContain("--body 'body content'");
    expect(r.stdout).toContain("area:plugin-brain-os");
    expect(r.stdout).toContain("owner:bot");
    expect(r.stdout).toContain("priority:p2");
    expect(r.stdout).toContain("weight:quick");
    expect(r.stdout).toContain("status:ready");
  });

  test("--dry-run with --type adds type label", () => {
    const r = run([...VALID, "--type", "handover", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("type:handover");
  });

  test("rejects unknown --area", () => {
    const args = [...VALID];
    const i = args.indexOf("plugin-brain-os");
    args[i] = "garbage";
    const r = run([...args, "--dry-run"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/area/i);
  });

  test("rejects unknown --owner", () => {
    const args = [...VALID];
    const i = args.indexOf("bot");
    args[i] = "robot";
    const r = run([...args, "--dry-run"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/owner/i);
  });

  test("rejects unknown --priority", () => {
    const args = [...VALID];
    const i = args.indexOf("p2");
    args[i] = "p9";
    const r = run([...args, "--dry-run"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/priority/i);
  });

  test("rejects unknown --weight", () => {
    const args = [...VALID];
    const i = args.indexOf("quick");
    args[i] = "medium";
    const r = run([...args, "--dry-run"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/weight/i);
  });

  test("rejects unknown --status", () => {
    const args = [...VALID];
    const i = args.indexOf("ready");
    args[i] = "in-progress";
    const r = run([...args, "--dry-run"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/status/i);
  });

  test("rejects unknown --type", () => {
    const r = run([...VALID, "--type", "weirdtype", "--dry-run"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/type/i);
  });

  test("rejects missing --title", () => {
    const args = [
      "--body", "x",
      "--area", "plugin-brain-os",
      "--owner", "bot",
      "--priority", "p2",
      "--weight", "quick",
      "--status", "ready",
      "--dry-run",
    ];
    const r = run(args);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/title/i);
  });

  test("rejects missing --area", () => {
    const args = [
      "--title", "x",
      "--body", "x",
      "--owner", "bot",
      "--priority", "p2",
      "--weight", "quick",
      "--status", "ready",
      "--dry-run",
    ];
    const r = run(args);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/area/i);
  });
});
