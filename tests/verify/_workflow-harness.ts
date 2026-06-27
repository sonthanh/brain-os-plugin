// Faithful-enough mirror of the Workflow runtime, for unit-testing *.workflow.js
// orchestration without live agents.
//
// The runtime extracts `export const meta = {...}` and wraps the remaining body
// in an async function with agent/parallel/pipeline/phase/log/args injected as
// ambient names; the body uses top-level `await` and top-level `return`. A plain
// ES `import()` cannot model that (top-level return is illegal in a module), so
// we strip the `export` keyword and execute the body via AsyncFunction with the
// same six names bound as parameters.
//
// Fidelity is asserted empirically in harness-fidelity.test.ts by running the
// shipped, known-good auto-grill.workflow.js through this harness end-to-end. If
// the runtime model here drifts from reality, that test fails — so a green
// verify-workflow test means something.
//
// Not named *.test.ts on purpose: bun test must not execute it directly.

import { readFileSync } from "node:fs";

// eslint-disable-next-line @typescript-eslint/no-empty-function
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as
  (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

export type AgentCall = { prompt: string; opts: Record<string, unknown> };

export interface HarnessOptions {
  args: unknown;
  /** Responder standing in for the LLM agent boundary. Receives (prompt, opts). */
  agent: (prompt: string, opts: Record<string, unknown>) => unknown;
}

export interface HarnessRun {
  result: unknown;
  calls: AgentCall[];
  /** agent() calls whose opts.phase / label start with the given prefix. */
  callsFor: (prefix: string) => AgentCall[];
}

export async function runWorkflow(path: string, opts: HarnessOptions): Promise<HarnessRun> {
  let body = readFileSync(path, "utf8");
  body = body.replace(/^export\s+const\s+meta\b/m, "const meta");

  const calls: AgentCall[] = [];

  const agent = async (prompt: string, o: Record<string, unknown> = {}) => {
    calls.push({ prompt, opts: o });
    return opts.agent(prompt, o);
  };

  // parallel(): barrier; a throwing thunk resolves to null (documented contract).
  const parallel = async (thunks: Array<() => unknown>) =>
    Promise.all(
      thunks.map(async (t) => {
        try {
          return await t();
        } catch {
          return null;
        }
      }),
    );

  // pipeline(): each item flows through every stage independently; a throwing
  // stage drops that item to null. Stage callbacks receive (prev, item, index).
  const pipeline = async (items: unknown[], ...stages: Array<(prev: unknown, item: unknown, i: number) => unknown>) =>
    Promise.all(
      items.map(async (item, i) => {
        try {
          let acc: unknown = item;
          for (const stage of stages) acc = await stage(acc, item, i);
          return acc;
        } catch {
          return null;
        }
      }),
    );

  const phase = (_title: string) => {};
  const log = (_msg: string) => {};

  const fn = AsyncFunction("agent", "parallel", "pipeline", "phase", "log", "args", body);
  const result = await fn(agent, parallel, pipeline, phase, log, opts.args);

  const callsFor = (prefix: string) =>
    calls.filter((c) => {
      const label = String(c.opts.label ?? "");
      const ph = String(c.opts.phase ?? "");
      return label.startsWith(prefix) || ph.startsWith(prefix);
    });

  return { result, calls, callsFor };
}
