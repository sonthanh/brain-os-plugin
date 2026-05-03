/**
 * hitl.mts — Shared primitives for the export-decision-and-exit HITL pattern.
 *
 * Workers (re-anchor.mts, self-improve.mts) write decision-needed JSON files
 * containing review context, throw HitlPendingError, and exit 42. The agent
 * (Claude in chat) reads the context, drives the grill conversationally, and
 * writes a decision JSON. Operator re-runs the orchestrator; the worker
 * detects the decision file at the canonical path and consumes it.
 *
 * This module owns:
 *   - HitlPendingError (signal for runOrchestrator + CLI to map to exit 42)
 *   - HITL_PENDING_EXIT_CODE constant
 *   - makeWakeToken (uuid for needed-file payloads — lets future tooling
 *     correlate need ↔ decision pairs without parsing paths)
 */

export const HITL_PENDING_EXIT_CODE = 42;

export class HitlPendingError extends Error {
  readonly neededPaths: string[];
  constructor(neededPaths: string[]) {
    super(`HITL pending: ${neededPaths.join(", ")}`);
    this.name = "HitlPendingError";
    this.neededPaths = neededPaths;
  }
}

export function makeWakeToken(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `wt-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}
