#!/usr/bin/env tsx
/**
 * save-state — flip the run's `phase` field (e.g., on quota exhaustion or session cap).
 *
 * Usage:
 *   tsx save-state.ts --phase paused-quota
 *   tsx save-state.ts --phase paused-session-limit
 *   tsx save-state.ts --phase completed
 *   tsx save-state.ts --reset-session   # resets batches_this_session=0 at session start
 */
import { loadState, saveState, type Phase } from "./lib/checkpoint.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const phase = arg("phase") as Phase | undefined;
const resetSession = flag("reset-session");

const state = loadState();
if (!state) {
  console.error("save-state: no state.json found");
  process.exit(1);
}

if (phase) {
  state.phase = phase;
  if (phase === "completed") state.last_checkpoint_at = new Date().toISOString();
}
if (resetSession) {
  state.batches_this_session = 0;
}
state.last_checkpoint_at = new Date().toISOString();
saveState(state);
console.log(JSON.stringify({ ok: true, phase: state.phase, batches_this_session: state.batches_this_session }));
