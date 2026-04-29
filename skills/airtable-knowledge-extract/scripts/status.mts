#!/usr/bin/env bun
/**
 * status.mts — C12 Phase-1 read-only status reporter.
 *
 * Reads `state.json` + `cost-meter.jsonl` for a run-id and prints the
 * current rung, batch progress, pass-rate, cumulative tokens, and ETA.
 *
 * Strict read-only: never opens any file in write mode. The
 * `writeProbe` dep exists only so tests can assert no writes happen
 * via dependency injection.
 *
 * CLI: `bun run status.mts <run-id>`
 *   Exits 0 always (read-only). Output is human-formatted text on
 *   stdout; pass `--json` for the machine-readable snapshot.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  computeCumulative,
  parseCostMeter,
  type Cumulative,
} from "./guard.mts";
import type { BaseProgress, RunPhase, RunState } from "./run.mts";

export interface BaseSummary {
  base_id: string;
  rung: number;
  batches_done: number;
  total_batches: number;
  pass_rate: number;
  consec_fails: number;
  phase: RunPhase;
}

export interface StatusSnapshot {
  run_id: string;
  phase: RunPhase;
  current_base: string | null;
  start_ts: string;
  last_updated_ts: string;
  elapsed_ms: number;
  cumulative_tokens: Cumulative;
  base_summaries: BaseSummary[];
  eta_ms: number | null;
}

export interface StatusDeps {
  readState: () => RunState;
  readCostMeter: () => string;
  now: () => number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function summarizeBaseProgress(p: BaseProgress): BaseSummary {
  const passed = p.batch_results.filter((r) => r.outcome === "pass").length;
  const total = p.batch_results.length;
  return {
    base_id: p.base_id,
    rung: p.rung,
    batches_done: p.batches_done,
    total_batches: p.total_batches,
    pass_rate: total === 0 ? 0 : passed / total,
    consec_fails: p.consec_fails,
    phase: p.phase,
  };
}

export function computeEta(
  state: RunState,
  nowMs: number,
): number | null {
  const startMs = Date.parse(state.start_ts);
  if (!Number.isFinite(startMs)) return null;
  const elapsed = nowMs - startMs;

  let totalDone = 0;
  let totalRemaining = 0;
  for (const baseId of state.processing_order) {
    const p = state.base_progress[baseId];
    if (!p) {
      // unknown total; can't ETA
      return null;
    }
    totalDone += p.batches_done;
    totalRemaining += Math.max(0, p.total_batches - p.batches_done);
  }
  if (totalDone === 0 || totalRemaining === 0) return null;
  const msPerBatch = elapsed / totalDone;
  return Math.round(msPerBatch * totalRemaining);
}

export function formatStatusLine(snap: StatusSnapshot): string {
  const lines: string[] = [];
  lines.push(`run: ${snap.run_id}  phase: ${snap.phase}`);
  lines.push(
    `current_base: ${snap.current_base ?? "(none)"}  elapsed: ${snap.elapsed_ms} ms`,
  );
  lines.push(
    `cumulative_tokens: opus=${snap.cumulative_tokens.opus} sonnet=${snap.cumulative_tokens.sonnet} other=${snap.cumulative_tokens.other}`,
  );
  if (snap.base_summaries.length === 0) {
    lines.push("(no bases tracked yet)");
  } else {
    for (const b of snap.base_summaries) {
      lines.push(
        `  - ${b.base_id} rung-${b.rung} ${b.batches_done}/${b.total_batches} pass_rate=${b.pass_rate.toFixed(2)} consec_fails=${b.consec_fails} phase=${b.phase}`,
      );
    }
  }
  lines.push(`eta_ms: ${snap.eta_ms ?? "unknown"}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function readStatus(runId: string, deps: StatusDeps): StatusSnapshot {
  const state = deps.readState();
  const events = parseCostMeter(deps.readCostMeter());
  const cumulative = computeCumulative(events);
  const nowMs = deps.now();
  const startMs = Date.parse(state.start_ts);
  const elapsed = Number.isFinite(startMs) ? nowMs - startMs : 0;
  const summaries: BaseSummary[] = [];
  for (const baseId of state.processing_order) {
    const p = state.base_progress[baseId];
    if (p) summaries.push(summarizeBaseProgress(p));
  }
  return {
    run_id: state.run_id ?? runId,
    phase: state.phase,
    current_base: state.current_base ?? null,
    start_ts: state.start_ts,
    last_updated_ts: state.last_updated_ts,
    elapsed_ms: elapsed,
    cumulative_tokens: cumulative,
    base_summaries: summaries,
    eta_ms: computeEta(state, nowMs),
  };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function resolveLayout(runId: string): {
  statePath: string;
  costMeterPath: string;
} {
  const runDir = join(homedir(), ".claude", "airtable-extract-cache", runId);
  return {
    statePath: join(runDir, "state.json"),
    costMeterPath: join(runDir, "cost-meter.jsonl"),
  };
}

function defaultDeps(runId: string): StatusDeps {
  const layout = resolveLayout(runId);
  return {
    readState: () => {
      if (!existsSync(layout.statePath)) {
        throw new Error(`state.json not found at ${layout.statePath}`);
      }
      return JSON.parse(readFileSync(layout.statePath, "utf8")) as RunState;
    },
    readCostMeter: () =>
      existsSync(layout.costMeterPath)
        ? readFileSync(layout.costMeterPath, "utf8")
        : "",
    now: () => Date.now(),
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const runId = args.find((a) => !a.startsWith("--"));
  const wantJson = args.includes("--json");
  if (!runId) {
    process.stderr.write("usage: status.mts <run-id> [--json]\n");
    process.exit(2);
  }
  try {
    const snap = readStatus(runId, defaultDeps(runId));
    if (wantJson) {
      process.stdout.write(`${JSON.stringify(snap, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatStatusLine(snap)}\n`);
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(`status: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
