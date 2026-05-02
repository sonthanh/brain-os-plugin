/**
 * ac-gate.ts — Child-level ralph + advisor verdict gate.
 *
 * Canonical loop contract for /impl child execution. The worker's prose
 * follows this shape; tests pin behavior with mockable deps. If prose-driven
 * worker drifts from this function, the function wins — open an issue against
 * the prose.
 *
 * SSOT: ../../references/ac-coverage-spec.md (live-AC rule § 6.1, evidence
 * forms § 4); parsers in ./ac-coverage.ts.
 */

import {
  parseCoversAC,
  liveACSet,
  classifyChild,
  parseAdvisorVerdict,
  formatHandoffComment,
} from "./ac-coverage.ts";

export const MAX_ITERATIONS = 3;

export interface TddRunner {
  run(
    issue: number,
    priorFailure?: string,
  ): Promise<{ status: "GREEN" | "RED"; reason?: string }>;
}

export interface AdvisorClient {
  /**
   * Returns the advisor's free-form verdict text. Caller parses it via
   * parseAdvisorVerdict(). The advisor is expected to be primed with the
   * child's diff + /tdd output + parent AC text via prose harness; this
   * function only sees the issue number it's verifying.
   */
  verify(issue: number): Promise<string>;
}

export interface GhWriter {
  comment(issue: number, body: string): Promise<void>;
  relabelHuman(issue: number): Promise<void>;
}

export interface ChildCounters {
  advisorCalls: number;
  advisorRejections: number;
  tddRunCount: number;
  verified: boolean;
  lastFailure?: string;
  lastVerdict?: string;
}

export interface ResultRecorder {
  record(issue: number, counters: ChildCounters): Promise<void>;
}

export interface Logger {
  log(msg: string): void;
}

export interface GateDeps {
  tdd: TddRunner;
  advisor: AdvisorClient;
  gh: GhWriter;
  recorder: ResultRecorder;
  logger: Logger;
}

export async function runChildAdvisorGate(
  issue: number,
  childBody: string,
  parentBody: string,
  deps: GateDeps,
): Promise<ChildCounters> {
  const coversAC = parseCoversAC(childBody);
  const parentLive = liveACSet(parentBody);
  const classification = classifyChild(coversAC, parentLive);

  const counters: ChildCounters = {
    advisorCalls: 0,
    advisorRejections: 0,
    tddRunCount: 0,
    verified: false,
  };

  let priorFailure: string | undefined;

  for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
    deps.logger.log(`#${issue} iter ${iter}: /tdd${priorFailure ? " (with hint)" : ""}`);
    const tddResult = await deps.tdd.run(issue, priorFailure);
    counters.tddRunCount++;

    if (tddResult.status === "RED") {
      const reason = tddResult.reason ?? "(no reason)";
      counters.lastFailure = `/tdd RED: ${reason}`;
      priorFailure = counters.lastFailure;
      deps.logger.log(`#${issue} iter ${iter}: RED — ${reason}`);
      continue;
    }

    if (classification === "pure-component") {
      counters.verified = true;
      deps.logger.log(`#${issue} iter ${iter}: GREEN, pure-component → AC_VERIFIED`);
      break;
    }

    counters.advisorCalls++;
    deps.logger.log(`#${issue} iter ${iter}: GREEN, calling advisor (call #${counters.advisorCalls})`);
    const verdictText = await deps.advisor.verify(issue);
    const verdict = parseAdvisorVerdict(verdictText);

    if (verdict.met) {
      counters.verified = true;
      counters.lastVerdict = "AC met";
      deps.logger.log(`#${issue} iter ${iter}: advisor → AC met → AC_VERIFIED`);
      break;
    }

    counters.advisorRejections++;
    counters.lastVerdict = `AC not met: ${verdict.reason ?? "(no reason)"}`;
    counters.lastFailure = `advisor: ${verdict.reason ?? "(no reason)"}`;
    priorFailure = counters.lastFailure;
    deps.logger.log(`#${issue} iter ${iter}: advisor → ${counters.lastVerdict}`);
  }

  if (!counters.verified) {
    deps.logger.log(`#${issue} 3 iters elapsed without AC_VERIFIED — escalating`);
    await deps.gh.relabelHuman(issue);
    const comment = formatHandoffComment(
      counters.lastFailure ?? "(no failure recorded)",
      counters.lastVerdict ?? "(no advisor verdict)",
    );
    await deps.gh.comment(issue, comment);
  }

  await deps.recorder.record(issue, counters);
  return counters;
}
