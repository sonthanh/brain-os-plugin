import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "bun";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SCRIPT = join(import.meta.dir, "..", "close-issue.sh");

let shimDir: string;
let callsLog: string;

function writeShim(behavior: { state?: string; statusLabels?: string[]; viewExit?: number; editExit?: number; closeExit?: number; commentExit?: number } = {}) {
  const state = behavior.state ?? "OPEN";
  const statusLabels = behavior.statusLabels ?? ["status:in-progress"];
  const viewExit = behavior.viewExit ?? 0;
  const editExit = behavior.editExit ?? 0;
  const closeExit = behavior.closeExit ?? 0;
  const commentExit = behavior.commentExit ?? 0;

  const labelsJson = `[${statusLabels.map(l => `{"name":"${l}"}`).join(",")}]`;
  const shim = `#!/bin/bash
echo "$@" >> ${callsLog}
if [[ "$1" == "issue" && "$2" == "view" ]]; then
  if [[ ${viewExit} -ne 0 ]]; then
    echo "gh: view failed" >&2
    exit ${viewExit}
  fi
  echo '{"state":"${state}","labels":${labelsJson}}'
  exit 0
fi
if [[ "$1" == "issue" && "$2" == "edit" ]]; then exit ${editExit}; fi
if [[ "$1" == "issue" && "$2" == "close" ]]; then exit ${closeExit}; fi
if [[ "$1" == "issue" && "$2" == "comment" ]]; then exit ${commentExit}; fi
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
  shimDir = mkdtempSync(join(tmpdir(), "close-issue-shim-"));
  callsLog = join(shimDir, "calls.log");
});

afterEach(() => {
  rmSync(shimDir, { recursive: true, force: true });
});

describe("close-issue.sh", () => {
  test("--help exits 0 and prints usage", () => {
    writeShim();
    const r = run(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/close-issue/);
    expect(r.stdout).toMatch(/--comment/);
  });

  test("dry-run prints planned gh commands without executing", () => {
    writeShim({ statusLabels: ["status:in-progress"] });
    const r = run(["157", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("gh issue edit 157");
    expect(r.stdout).toContain("--remove-label status:in-progress");
    expect(r.stdout).toContain("gh issue close 157");
    // Dry-run must NOT call gh edit/close (only the view, which is a read).
    const sideEffectCalls = r.calls.split("\n").filter(l => l.startsWith("issue edit") || l.startsWith("issue close") || l.startsWith("issue comment"));
    expect(sideEffectCalls.length).toBe(0);
  });

  test("strips all status:* labels in a single gh edit before close", () => {
    writeShim({ statusLabels: ["status:in-progress", "status:ready"] });
    const r = run(["157"]);
    expect(r.exitCode).toBe(0);
    const editCalls = r.calls.split("\n").filter(l => l.startsWith("issue edit"));
    expect(editCalls.length).toBe(1);
    expect(editCalls[0]).toContain("--remove-label status:in-progress");
    expect(editCalls[0]).toContain("--remove-label status:ready");
    const closeCalls = r.calls.split("\n").filter(l => l.startsWith("issue close"));
    expect(closeCalls.length).toBe(1);
  });

  test("--comment posts a comment before close", () => {
    writeShim();
    const r = run(["157", "--comment", "shipped via /impl"]);
    expect(r.exitCode).toBe(0);
    const lines = r.calls.split("\n").filter(l => l.length > 0);
    const commentIdx = lines.findIndex(l => l.startsWith("issue comment"));
    const closeIdx = lines.findIndex(l => l.startsWith("issue close"));
    expect(commentIdx).toBeGreaterThanOrEqual(0);
    expect(closeIdx).toBeGreaterThan(commentIdx);
    expect(lines[commentIdx]).toContain("shipped via /impl");
  });

  test("issue with no status:* labels: skips edit, still closes", () => {
    writeShim({ statusLabels: [] });
    const r = run(["157"]);
    expect(r.exitCode).toBe(0);
    const editCalls = r.calls.split("\n").filter(l => l.startsWith("issue edit"));
    expect(editCalls.length).toBe(0);
    const closeCalls = r.calls.split("\n").filter(l => l.startsWith("issue close"));
    expect(closeCalls.length).toBe(1);
  });

  test("already-closed issue errors cleanly", () => {
    writeShim({ state: "CLOSED" });
    const r = run(["157"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/already closed|closed/i);
    const closeCalls = r.calls.split("\n").filter(l => l.startsWith("issue close"));
    expect(closeCalls.length).toBe(0);
  });

  test("close uses --reason completed", () => {
    writeShim();
    const r = run(["157"]);
    expect(r.exitCode).toBe(0);
    const closeLine = r.calls.split("\n").find(l => l.startsWith("issue close")) ?? "";
    expect(closeLine).toContain("--reason completed");
  });

  test("rejects missing issue number", () => {
    writeShim();
    const r = run([]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/issue|usage/i);
  });

  test("rejects non-numeric issue", () => {
    writeShim();
    const r = run(["abc"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/number|invalid/i);
  });
});
