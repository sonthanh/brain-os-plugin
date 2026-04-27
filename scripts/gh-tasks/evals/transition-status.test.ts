import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "bun";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SCRIPT = join(import.meta.dir, "..", "transition-status.sh");

let shimDir: string;
let callsLog: string;

function writeShim(behavior: { state?: string; statusLabel?: string | null; viewExit?: number; editExit?: number } = {}) {
  const state = behavior.state ?? "OPEN";
  const statusLabel = behavior.statusLabel === null ? "" : behavior.statusLabel ?? "status:ready";
  const viewExit = behavior.viewExit ?? 0;
  const editExit = behavior.editExit ?? 0;

  const labelsJson = statusLabel ? `[{"name":"${statusLabel}"}]` : `[]`;
  const shim = `#!/bin/bash
echo "$@" >> ${callsLog}
if [[ "$1" == "issue" && "$2" == "view" ]]; then
  if [[ ${viewExit} -ne 0 ]]; then
    echo "gh: not found" >&2
    exit ${viewExit}
  fi
  echo '{"state":"${state}","labels":${labelsJson}}'
  exit 0
fi
if [[ "$1" == "issue" && "$2" == "edit" ]]; then
  exit ${editExit}
fi
exit 0
`;
  const ghPath = join(shimDir, "gh");
  writeFileSync(ghPath, shim);
  chmodSync(ghPath, 0o755);
}

function run(args: string[]) {
  const env = { ...process.env, PATH: `${shimDir}:${process.env.PATH}` };
  const proc = spawnSync(["bash", SCRIPT, ...args], { env });
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode ?? -1,
    calls: existsSync(callsLog) ? readFileSync(callsLog, "utf8") : "",
  };
}

beforeEach(() => {
  shimDir = mkdtempSync(join(tmpdir(), "transition-status-shim-"));
  callsLog = join(shimDir, "calls.log");
});

afterEach(() => {
  rmSync(shimDir, { recursive: true, force: true });
});

describe("transition-status.sh", () => {
  test("--help exits 0 and prints usage", () => {
    writeShim();
    const r = run(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/transition-status/);
    expect(r.stdout).toMatch(/--to/);
  });

  test("dry-run prints atomic gh edit command for ready→in-progress", () => {
    writeShim({ statusLabel: "status:ready" });
    const r = run(["157", "--to", "in-progress", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("gh issue edit 157");
    expect(r.stdout).toContain("--remove-label status:ready");
    expect(r.stdout).toContain("--add-label status:in-progress");
    expect(r.stdout).toContain("-R sonthanh/ai-brain");
  });

  test("real invocation issues a single atomic gh edit (no separate remove + add)", () => {
    writeShim({ statusLabel: "status:ready" });
    const r = run(["157", "--to", "in-progress"]);
    expect(r.exitCode).toBe(0);
    const editCalls = r.calls.split("\n").filter(l => l.startsWith("issue edit"));
    expect(editCalls.length).toBe(1);
    expect(editCalls[0]).toContain("--remove-label");
    expect(editCalls[0]).toContain("status:ready");
    expect(editCalls[0]).toContain("--add-label");
    expect(editCalls[0]).toContain("status:in-progress");
  });

  test("idempotent: current == target is a no-op (no edit call)", () => {
    writeShim({ statusLabel: "status:in-progress" });
    const r = run(["157", "--to", "in-progress"]);
    expect(r.exitCode).toBe(0);
    const editCalls = r.calls.split("\n").filter(l => l.startsWith("issue edit"));
    expect(editCalls.length).toBe(0);
  });

  test("issue with no status:* label still gets target added", () => {
    writeShim({ statusLabel: null });
    const r = run(["157", "--to", "ready"]);
    expect(r.exitCode).toBe(0);
    const editCalls = r.calls.split("\n").filter(l => l.startsWith("issue edit"));
    expect(editCalls.length).toBe(1);
    expect(editCalls[0]).toContain("--add-label");
    expect(editCalls[0]).toContain("status:ready");
    expect(editCalls[0]).not.toContain("--remove-label");
  });

  test("non-existent issue errors cleanly (gh view fails)", () => {
    writeShim({ viewExit: 1 });
    const r = run(["999999", "--to", "ready"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/cannot fetch|not found|view/i);
  });

  test("rejects unknown --to target", () => {
    writeShim();
    const r = run(["157", "--to", "garbage"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/--to|target|status/i);
  });

  test("rejects missing issue number", () => {
    writeShim();
    const r = run(["--to", "ready"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/issue|number/i);
  });

  test("rejects missing --to", () => {
    writeShim();
    const r = run(["157"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/--to/);
  });

  test("rejects closed issue", () => {
    writeShim({ state: "CLOSED" });
    const r = run(["157", "--to", "ready"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/closed|not open/i);
  });
});
