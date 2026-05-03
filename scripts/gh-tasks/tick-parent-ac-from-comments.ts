#!/usr/bin/env bun
/**
 * tick-parent-ac-from-comments.ts — backfill helper.
 *
 * Reads a parent issue's existing comments for `Acceptance verified: AC#N — …`
 * lines (form-(ii) evidence per references/ac-coverage-spec.md § 3.3) and
 * ticks each matched AC bullet `[ ] **AC#N**` → `[x] **AC#N**` in the parent
 * body. Idempotent — already-ticked bullets stay ticked; AC IDs in comments
 * but absent from body emit a stderr warn and exit 0.
 *
 * Recovery tool for stories where evidence comments exist but parent ticks
 * were missed (e.g. self-bootstrapping orchestrator runs that shipped a new
 * tickAcceptance mid-flight; see #219 / #227 origin).
 *
 * Usage: bun run tick-parent-ac-from-comments.ts <parent-N>
 */

import { tickAcceptance, parseParentCommentEvidence } from "../run-story.ts";

export interface TickFromCommentsResult {
  body: string;
  tickedAcs: number[];
  notFoundAcs: number[];
}

// Aggregate AC IDs from every evidence comment, then tick each one against the
// parent body. Returns the new body plus per-AC bookkeeping for caller logging.
//
// `tickedAcs` lists IDs whose checkbox flipped this run (sorted ascending).
// `notFoundAcs` lists IDs that appeared in a comment but have no `**AC#N**`
// bullet in the body (caller surfaces as a stderr WARN; not fatal — a comment
// can drift from the body if the parent was edited after evidence was posted).
export function tickFromComments(
  body: string,
  comments: string[],
): TickFromCommentsResult {
  const acIds = new Set<number>();
  for (const c of comments) {
    for (const id of parseParentCommentEvidence(c)) acIds.add(id);
  }
  const sortedIds = [...acIds].sort((a, b) => a - b);
  const tickedAcs: number[] = [];
  const notFoundAcs: number[] = [];
  let newBody = body;
  for (const id of sortedIds) {
    const after = tickAcceptance(newBody, id);
    if (after !== newBody) {
      tickedAcs.push(id);
      newBody = after;
      continue;
    }
    // Same string back: either AC#id is already `[x]` (no-op success) or AC#id
    // doesn't exist in body at all. Disambiguate against the original body.
    const checkedRe = new RegExp(`^- \\[x\\] \\*\\*AC#${id}\\*\\* — `, "m");
    const uncheckedRe = new RegExp(`^- \\[ \\] \\*\\*AC#${id}\\*\\* — `, "m");
    if (!checkedRe.test(body) && !uncheckedRe.test(body)) {
      notFoundAcs.push(id);
    }
  }
  return { body: newBody, tickedAcs, notFoundAcs };
}

async function ghViewBodyAndComments(
  repo: string,
  n: number,
): Promise<{ body: string; comments: string[] }> {
  const proc = Bun.spawn(
    [
      "gh",
      "issue",
      "view",
      String(n),
      "-R",
      repo,
      "--json",
      "body,comments",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`gh issue view ${n} (${repo}) exited ${code}: ${err}`);
  }
  const json = JSON.parse(out) as {
    body: string;
    comments: { body: string }[];
  };
  return { body: json.body, comments: json.comments.map((c) => c.body) };
}

async function ghEditBody(repo: string, n: number, body: string): Promise<void> {
  const proc = Bun.spawn(
    ["gh", "issue", "edit", String(n), "-R", repo, "--body-file", "-"],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  proc.stdin.write(body);
  proc.stdin.end();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`gh issue edit ${n} (${repo}) exited ${code}: ${err}`);
  }
}

async function resolveTrackerRepo(): Promise<string> {
  const home = process.env.HOME!;
  try {
    const fs = await import("fs");
    const conf = fs.readFileSync(`${home}/.brain-os/brain-os.config.md`, "utf-8");
    const m = conf.match(/^gh_task_repo:\s*(\S+)/m);
    if (m) return m[1];
  } catch {
    // fall through to default
  }
  return "sonthanh/ai-brain";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error("usage: tick-parent-ac-from-comments <parent-N>");
    process.exit(2);
  }
  const parentN = Number(args[0]);
  if (!Number.isInteger(parentN) || parentN <= 0) {
    console.error(`invalid parent issue number: ${args[0]}`);
    process.exit(2);
  }
  const repo = await resolveTrackerRepo();
  const { body, comments } = await ghViewBodyAndComments(repo, parentN);
  const result = tickFromComments(body, comments);
  if (result.tickedAcs.length === 0 && result.notFoundAcs.length === 0) {
    console.log(`✓ #${parentN}: no evidence comments to backfill (no-op)`);
    return;
  }
  if (result.tickedAcs.length > 0) {
    await ghEditBody(repo, parentN, result.body);
    console.log(
      `✓ #${parentN}: ticked AC bullets [${result.tickedAcs.join(",")}] from evidence comments`,
    );
  } else {
    console.log(`✓ #${parentN}: all referenced AC bullets already ticked (no-op)`);
  }
  if (result.notFoundAcs.length > 0) {
    console.error(
      `WARN: #${parentN}: AC IDs in comments but absent from body: [${result.notFoundAcs.join(",")}]`,
    );
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`FATAL: ${(err as Error).message}`);
    process.exit(1);
  });
}
