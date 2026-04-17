import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, appendFileSync } from "fs";
import { resolve, dirname } from "path";
import { resolveVaultPath, runDir } from "./safety-net.js";

export type Phase = "running" | "paused-session-limit" | "paused-quota" | "paused-manual" | "completed" | "failed";

export interface FailedEntry {
  msg_id: string;
  error: string;
  attempts: number;
  last_attempt_at: string;
  detail?: string;
}

export interface State {
  version: 1;
  run_id: string;
  window: string;
  window_start: string;
  window_end: string;
  total_estimated: number;
  processed_count: number;
  skipped_count: number;
  extracted_count: number;
  extracted_empty_count: number;
  error_count: number;
  last_msg_id: string;
  last_internal_date: string;
  started_at: string;
  last_checkpoint_at: string;
  batches_completed: number;
  batches_this_session: number;
  phase: Phase;
  failed_ids: FailedEntry[];
}

function statePath(): string {
  return resolve(resolveVaultPath(), "daily/email-extraction-state.json");
}

export function loadState(): State | null {
  const p = statePath();
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as State;
}

export function saveState(state: State): void {
  const p = statePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, p);
}

export function initState(args: {
  run_id: string;
  window: string;
  window_start: string;
  window_end: string;
  total_estimated: number;
}): State {
  const now = new Date().toISOString();
  return {
    version: 1,
    run_id: args.run_id,
    window: args.window,
    window_start: args.window_start,
    window_end: args.window_end,
    total_estimated: args.total_estimated,
    processed_count: 0,
    skipped_count: 0,
    extracted_count: 0,
    extracted_empty_count: 0,
    error_count: 0,
    last_msg_id: "",
    last_internal_date: "",
    started_at: now,
    last_checkpoint_at: now,
    batches_completed: 0,
    batches_this_session: 0,
    phase: "running",
    failed_ids: [],
  };
}

function processedIdsPath(runId: string): string {
  return resolve(runDir(runId), "processed-ids.jsonl");
}

export type Outcome = "extracted" | "extracted_empty" | "skipped" | "force-extracted" | "failed";

export function appendProcessed(runId: string, entries: Array<{
  msg_id: string;
  outcome: Outcome;
  reason?: string;
}>): void {
  const p = processedIdsPath(runId);
  mkdirSync(dirname(p), { recursive: true });
  const lines = entries.map((e) => JSON.stringify({ ...e, at: new Date().toISOString() })).join("\n") + "\n";
  appendFileSync(p, lines);
}

export function loadProcessedIds(runId: string): Set<string> {
  const p = processedIdsPath(runId);
  if (!existsSync(p)) return new Set();
  const set = new Set<string>();
  for (const line of readFileSync(p, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { msg_id: string };
      set.add(obj.msg_id);
    } catch {
      // skip malformed line
    }
  }
  return set;
}
