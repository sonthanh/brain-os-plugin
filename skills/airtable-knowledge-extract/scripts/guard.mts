/**
 * guard.mts — Phase-1 kill-switch for /airtable-knowledge-extract runs.
 *
 * Polls cost-meter.jsonl + state.json every 30s. On cumulative-token, wallclock,
 * or quota_pct breach against HARD_MAX_* caps: SIGTERMs every registered worker
 * PID, writes breach.md, emits an osascript notification (sp tab fallback).
 *
 * Defense-in-depth — Phase 1 has no Predictor; rung-aware adaptive caps land in
 * Phase 2. This script is the absolute ceiling regardless of prediction.
 *
 * File contracts (defined here; sibling Phase-1 slices consume these):
 *
 *   ~/.claude/airtable-extract-cache/<run-id>/cost-meter.jsonl
 *     One JSON object per worker LLM call:
 *       { ts: ISO8601, model: string,
 *         input_tokens: number, output_tokens: number,
 *         cache_creation_input_tokens?: number,
 *         cache_read_input_tokens?: number }
 *
 *   ~/.claude/airtable-extract-cache/<run-id>/state.json
 *     { start_ts: ISO8601, worker_pids: number[], quota_pct?: number | null }
 *
 *   ~/.claude/airtable-extract-cache/<run-id>/breach.md
 *     Written on first breach; format = formatBreachMd().
 *
 * CLI: `bun run guard.mts <run-id>`
 *   Reads the cache paths above, polls until breach, workers-done, or process
 *   killed. Prints a JSON status line per iteration to stderr; exits 0 on
 *   workers-done, 2 on breach.
 */

export const HARD_MAX_OPUS_TOK = 2_000_000;
export const HARD_MAX_SONNET_TOK = 8_000_000;
export const HARD_MAX_QUOTA_PCT = 40;
export const HARD_MAX_RUN_DURATION_MS = 4 * 60 * 60 * 1000;

export type CostMeterEvent = {
  ts: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

export type GuardCaps = {
  hardMaxOpusTok: number;
  hardMaxSonnetTok: number;
  hardMaxQuotaPct: number;
  hardMaxRunDurationMs: number;
};

export const DEFAULT_CAPS: GuardCaps = {
  hardMaxOpusTok: HARD_MAX_OPUS_TOK,
  hardMaxSonnetTok: HARD_MAX_SONNET_TOK,
  hardMaxQuotaPct: HARD_MAX_QUOTA_PCT,
  hardMaxRunDurationMs: HARD_MAX_RUN_DURATION_MS,
};

export type StateFile = {
  start_ts: string;
  worker_pids: number[];
  quota_pct?: number | null;
};

export type Tier = "opus" | "sonnet" | "other";

export type Cumulative = {
  opus: number;
  sonnet: number;
  other: number;
};

export type BreachReason =
  | "opus_tokens"
  | "sonnet_tokens"
  | "wallclock"
  | "quota_pct";

export type Breach = {
  reason: BreachReason;
  observed: number;
  cap: number;
};

export function classifyModel(model: string): Tier {
  const m = model.toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  return "other";
}

export function eventTokens(e: CostMeterEvent): number {
  return (
    (e.input_tokens ?? 0) +
    (e.output_tokens ?? 0) +
    (e.cache_creation_input_tokens ?? 0) +
    (e.cache_read_input_tokens ?? 0)
  );
}

export function parseCostMeterLine(line: string): CostMeterEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (typeof obj?.model !== "string") return null;
    if (typeof obj?.input_tokens !== "number") return null;
    if (typeof obj?.output_tokens !== "number") return null;
    return obj as CostMeterEvent;
  } catch {
    return null;
  }
}

export function parseCostMeter(content: string): CostMeterEvent[] {
  if (!content) return [];
  return content
    .split("\n")
    .map(parseCostMeterLine)
    .filter((e): e is CostMeterEvent => e !== null);
}

export function computeCumulative(events: CostMeterEvent[]): Cumulative {
  const acc: Cumulative = { opus: 0, sonnet: 0, other: 0 };
  for (const e of events) {
    acc[classifyModel(e.model)] += eventTokens(e);
  }
  return acc;
}

// Precedence: opus → sonnet → wallclock → quota_pct. First match wins;
// breach.md records exactly one reason for deterministic forensics.
export function detectBreach(
  cum: Cumulative,
  wallclockMs: number,
  quotaPct: number | null | undefined,
  caps: GuardCaps,
): Breach | null {
  if (cum.opus > caps.hardMaxOpusTok) {
    return { reason: "opus_tokens", observed: cum.opus, cap: caps.hardMaxOpusTok };
  }
  if (cum.sonnet > caps.hardMaxSonnetTok) {
    return {
      reason: "sonnet_tokens",
      observed: cum.sonnet,
      cap: caps.hardMaxSonnetTok,
    };
  }
  if (wallclockMs > caps.hardMaxRunDurationMs) {
    return {
      reason: "wallclock",
      observed: wallclockMs,
      cap: caps.hardMaxRunDurationMs,
    };
  }
  if (quotaPct != null && quotaPct > caps.hardMaxQuotaPct) {
    return { reason: "quota_pct", observed: quotaPct, cap: caps.hardMaxQuotaPct };
  }
  return null;
}

export function formatBreachMd(
  breach: Breach,
  ctx: {
    runId: string;
    ts: string;
    cum: Cumulative;
    wallclockMs: number;
    workerPids: number[];
  },
): string {
  return [
    `# Breach — ${breach.reason}`,
    "",
    `- run-id: \`${ctx.runId}\``,
    `- detected: ${ctx.ts}`,
    `- reason: \`${breach.reason}\``,
    `- observed: \`${breach.observed}\``,
    `- cap: \`${breach.cap}\``,
    "",
    "## Snapshot",
    "",
    `- opus_tokens: \`${ctx.cum.opus}\``,
    `- sonnet_tokens: \`${ctx.cum.sonnet}\``,
    `- other_tokens: \`${ctx.cum.other}\``,
    `- wallclock_ms: \`${ctx.wallclockMs}\``,
    `- worker_pids: \`${ctx.workerPids.length ? ctx.workerPids.join(", ") : "(none)"}\``,
    "",
    "## Action taken",
    "",
    "All registered worker PIDs were SIGTERMed. osascript notification dispatched.",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// I/O wrapper
// ---------------------------------------------------------------------------

export type GuardDeps = {
  readCostMeter: (path: string) => string;
  readState: (path: string) => StateFile;
  signal: (pid: number, sig: NodeJS.Signals) => void;
  writeBreachMd: (path: string, content: string) => void;
  notify: (title: string, body: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
  isAlive: (pid: number) => boolean;
};

export type RunOpts = {
  pollIntervalMs?: number;
  maxIterations?: number;
  caps?: GuardCaps;
};

export type RunResult =
  | { kind: "breach"; breach: Breach; iterations: number }
  | { kind: "workers-done"; iterations: number }
  | { kind: "max-iterations"; iterations: number };

export async function runGuard(
  deps: GuardDeps,
  paths: { costMeter: string; state: string; breachMd: string },
  runId: string,
  opts: RunOpts = {},
): Promise<RunResult> {
  const caps = opts.caps ?? DEFAULT_CAPS;
  const pollMs = opts.pollIntervalMs ?? 30_000;
  const maxIter = opts.maxIterations ?? Number.POSITIVE_INFINITY;

  let i = 0;
  while (i < maxIter) {
    i++;

    const state = deps.readState(paths.state);
    const startMs = Date.parse(state.start_ts);
    const wallclock = deps.now() - startMs;
    const events = parseCostMeter(deps.readCostMeter(paths.costMeter));
    const cum = computeCumulative(events);
    const breach = detectBreach(cum, wallclock, state.quota_pct ?? null, caps);

    deps.log(
      JSON.stringify({
        iter: i,
        wallclock_ms: wallclock,
        opus: cum.opus,
        sonnet: cum.sonnet,
        other: cum.other,
        quota_pct: state.quota_pct ?? null,
        worker_pids: state.worker_pids,
        breach: breach?.reason ?? null,
      }),
    );

    if (breach) {
      const ts = new Date(deps.now()).toISOString();
      for (const pid of state.worker_pids) {
        try {
          deps.signal(pid, "SIGTERM");
        } catch (err) {
          deps.log(`signal failed for pid ${pid}: ${(err as Error).message ?? err}`);
        }
      }
      const md = formatBreachMd(breach, {
        runId,
        ts,
        cum,
        wallclockMs: wallclock,
        workerPids: state.worker_pids,
      });
      deps.writeBreachMd(paths.breachMd, md);
      deps.notify(
        `airtable-knowledge-extract breach: ${breach.reason}`,
        `run ${runId}: observed=${breach.observed} cap=${breach.cap}. workers SIGTERMed.`,
      );
      return { kind: "breach", breach, iterations: i };
    }

    if (
      state.worker_pids.length > 0 &&
      state.worker_pids.every((p) => !deps.isAlive(p))
    ) {
      return { kind: "workers-done", iterations: i };
    }

    if (i >= maxIter) break;
    await deps.sleep(pollMs);
  }

  return { kind: "max-iterations", iterations: i };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main(runId: string): Promise<void> {
  const fs = await import("node:fs");
  const { execFileSync } = await import("node:child_process");

  const home = process.env.HOME;
  if (!home) {
    console.error("FATAL: HOME unset");
    process.exit(2);
  }
  const cacheRoot = `${home}/.claude/airtable-extract-cache/${runId}`;
  const paths = {
    costMeter: `${cacheRoot}/cost-meter.jsonl`,
    state: `${cacheRoot}/state.json`,
    breachMd: `${cacheRoot}/breach.md`,
  };

  const deps: GuardDeps = {
    readCostMeter: (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""),
    readState: (p) => {
      if (!fs.existsSync(p)) {
        throw new Error(
          `state.json not found at ${p} — orchestrator must create it before guard starts`,
        );
      }
      return JSON.parse(fs.readFileSync(p, "utf8")) as StateFile;
    },
    signal: (pid, sig) => process.kill(pid, sig),
    writeBreachMd: (p, content) => fs.writeFileSync(p, content, "utf8"),
    notify: (title, body) => {
      try {
        execFileSync(
          "osascript",
          ["-e", `display notification "${body.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`],
          { stdio: "ignore" },
        );
      } catch {
        // Notification failure is non-fatal; breach.md is the durable record.
      }
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (msg) => console.error(`[guard ${runId}] ${msg}`),
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
  };

  const result = await runGuard(deps, paths, runId);
  console.log(JSON.stringify(result));
  if (result.kind === "breach") process.exit(2);
}

if (import.meta.main) {
  const runId = process.argv[2];
  if (!runId) {
    console.error("usage: bun run guard.mts <run-id>");
    process.exit(2);
  }
  await main(runId);
}
