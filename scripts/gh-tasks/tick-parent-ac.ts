#!/usr/bin/env bun
/**
 * tick-parent-ac.ts — flip a single parent AC bullet `[ ] **AC#N**` → `[x]`.
 *
 * Wired into /impl per-child post-close (skills/impl/SKILL.md § 6.2): after
 * each `Acceptance verified: AC#M — <evidence>` comment is posted on the
 * parent, this CLI is invoked to tick the matching parent body bullet so
 * form-(ii) evidence and form-(ii) tick land in the same write path.
 *
 * Imports `tickAcceptance` from run-story.ts — single source of truth for
 * the U+2014 em-dash + bold AC bullet regex (references/ac-coverage-spec.md
 * § 3.1). Idempotent: already-ticked AC is a silent no-op; missing AC#N in
 * body emits a stderr WARN and exits 0 (the parent body may have been edited
 * after the child filed; not a fatal error).
 *
 * Usage: bun run tick-parent-ac.ts <parent-N> <ac-id>
 */

import { tickAcceptance } from "../run-story.ts";

async function ghViewBody(repo: string, n: number): Promise<string> {
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
  // --jq .body strips JSON quoting but appends a trailing newline; preserve
  // body content exactly so a subsequent edit is a true round-trip.
  return out.endsWith("\n") ? out.slice(0, -1) : out;
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
  if (args.length !== 2) {
    console.error("usage: tick-parent-ac <parent-N> <ac-id>");
    process.exit(2);
  }
  const parentN = Number(args[0]);
  const acId = Number(args[1]);
  if (!Number.isInteger(parentN) || parentN <= 0) {
    console.error(`invalid parent issue number: ${args[0]}`);
    process.exit(2);
  }
  if (!Number.isInteger(acId) || acId <= 0) {
    console.error(`invalid ac-id: ${args[1]}`);
    process.exit(2);
  }
  const repo = await resolveTrackerRepo();
  const body = await ghViewBody(repo, parentN);
  const newBody = tickAcceptance(body, acId);
  if (newBody === body) {
    // Disambiguate already-ticked vs missing-from-body for caller logging.
    const checkedRe = new RegExp(`^- \\[x\\] \\*\\*AC#${acId}\\*\\* — `, "m");
    if (checkedRe.test(body)) {
      console.log(`✓ #${parentN} AC#${acId} already ticked (no-op)`);
    } else {
      console.error(
        `WARN: #${parentN} has no \`- [ ] **AC#${acId}** —\` bullet in body; nothing to tick`,
      );
    }
    return;
  }
  await ghEditBody(repo, parentN, newBody);
  console.log(`✓ #${parentN}: ticked AC#${acId}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`FATAL: ${(err as Error).message}`);
    process.exit(1);
  });
}
