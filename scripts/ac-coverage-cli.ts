#!/usr/bin/env bun
/**
 * ac-coverage-cli.ts — CLI wrapper exposing scripts/lib/ac-coverage.ts to
 * worker prose. Worker /impl prose shells out to this so it does NOT inline
 * its own regex (acceptance criterion: no duplication of parsers from
 * references/ac-coverage-spec.md § 1).
 *
 * Subcommands:
 *   classify <child-issue-N> [parent-issue-N]
 *     Prints "pure-component" or "live-ac" on stdout; exit 0. Parent omitted
 *     → resolved via child body's "## Parent" section.
 *
 *   parent <child-issue-N>
 *     Prints the parent issue number on stdout; exit 1 if no parent ref.
 *
 *   handoff-comment <last-failure> <last-verdict>
 *     Prints the handoff comment body on stdout; exit 0.
 *
 *   record-result <parent-N> <child-N> <verified> <tddRunCount>
 *     <advisorCalls> <advisorRejections> [last-failure] [last-verdict]
 *     Writes JSON to ~/.local/state/impl-story/<parent>-child-<child>.result.
 *     Orchestrator (run-story.ts) reads these at run-end to aggregate impl-
 *     story.log row counters.
 */

import {
  parseCoversAC,
  parseParentRef,
  liveACSet,
  classifyChild,
  formatHandoffComment,
} from "./lib/ac-coverage.ts";

async function ghIssueBody(repo: string, n: number): Promise<string> {
  const proc = Bun.spawn(
    ["gh", "issue", "view", String(n), "-R", repo, "--json", "body", "--jq", ".body"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`gh issue view ${n} (${repo}) exited ${code}: ${err}`);
  }
  return out;
}

async function resolveTrackerRepo(): Promise<string> {
  const home = process.env.HOME!;
  try {
    const fs = await import("fs");
    const conf = fs.readFileSync(`${home}/.brain-os/brain-os.config.md`, "utf-8");
    const m = conf.match(/^gh_task_repo:\s*(\S+)/m);
    if (m) return m[1];
  } catch {
    // fall through
  }
  return "sonthanh/ai-brain";
}

async function cmdClassify(args: string[]): Promise<void> {
  if (args.length < 1) {
    console.error("usage: ac-coverage-cli classify <child-issue-N> [parent-issue-N]");
    process.exit(2);
  }
  const childN = Number(args[0]);
  if (Number.isNaN(childN)) {
    console.error(`invalid child issue number: ${args[0]}`);
    process.exit(2);
  }
  const repo = await resolveTrackerRepo();
  const childBody = await ghIssueBody(repo, childN);
  let parentN: number;
  if (args.length >= 2) {
    parentN = Number(args[1]);
    if (Number.isNaN(parentN)) {
      console.error(`invalid parent issue number: ${args[1]}`);
      process.exit(2);
    }
  } else {
    const inferred = parseParentRef(childBody);
    if (inferred === null) {
      console.error(`#${childN} has no "## Parent" reference; pass parent-N explicitly`);
      process.exit(1);
    }
    parentN = inferred;
  }
  const parentBody = await ghIssueBody(repo, parentN);
  const coversAC = parseCoversAC(childBody);
  const parentLive = liveACSet(parentBody);
  const result = classifyChild(coversAC, parentLive);
  console.log(result);
}

async function cmdParent(args: string[]): Promise<void> {
  if (args.length < 1) {
    console.error("usage: ac-coverage-cli parent <child-issue-N>");
    process.exit(2);
  }
  const childN = Number(args[0]);
  if (Number.isNaN(childN)) {
    console.error(`invalid issue number: ${args[0]}`);
    process.exit(2);
  }
  const repo = await resolveTrackerRepo();
  const body = await ghIssueBody(repo, childN);
  const parent = parseParentRef(body);
  if (parent === null) {
    console.error(`#${childN} has no "## Parent" reference`);
    process.exit(1);
  }
  console.log(parent);
}

function cmdHandoffComment(args: string[]): void {
  if (args.length < 2) {
    console.error("usage: ac-coverage-cli handoff-comment <last-failure> <last-verdict>");
    process.exit(2);
  }
  console.log(formatHandoffComment(args[0], args[1]));
}

async function cmdRecordResult(args: string[]): Promise<void> {
  if (args.length < 6) {
    console.error(
      "usage: ac-coverage-cli record-result <parent-N> <child-N> <verified> <tddRunCount> <advisorCalls> <advisorRejections> [last-failure] [last-verdict]",
    );
    process.exit(2);
  }
  const parent = Number(args[0]);
  const child = Number(args[1]);
  const verified = args[2] === "true";
  const tddRunCount = Number(args[3]);
  const advisorCalls = Number(args[4]);
  const advisorRejections = Number(args[5]);
  const lastFailure = args[6] || undefined;
  const lastVerdict = args[7] || undefined;
  const home = process.env.HOME!;
  const dir = `${home}/.local/state/impl-story`;
  const fs = await import("fs");
  fs.mkdirSync(dir, { recursive: true });
  const path = `${dir}/${parent}-child-${child}.result`;
  const payload = {
    parent,
    child,
    verified,
    tddRunCount,
    advisorCalls,
    advisorRejections,
    lastFailure,
    lastVerdict,
    ts: new Date().toISOString(),
  };
  fs.writeFileSync(path, JSON.stringify(payload, null, 2));
  console.log(path);
}

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
    case "classify":
      await cmdClassify(rest);
      break;
    case "parent":
      await cmdParent(rest);
      break;
    case "handoff-comment":
      cmdHandoffComment(rest);
      break;
    case "record-result":
      await cmdRecordResult(rest);
      break;
    default:
      console.error(
        "usage: ac-coverage-cli <classify|parent|handoff-comment|record-result> [args...]",
      );
      process.exit(2);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`FATAL: ${(err as Error).message}`);
    process.exit(1);
  });
}
