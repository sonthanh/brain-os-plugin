---
name: impl
description: "Per-issue implementation executor for brain-os artifacts. Default mode grabs the next AFK GitHub issue and runs /tdd on it; --parallel N fans out via Agent-tool subagents with worktree isolation. Use when draining the AFK backlog, when the user says 'implement next issue', 'pick up the queue', or invokes /impl. Pairs with /ralph-loop for autonomous backlog drainage."
---

# /impl — Per-Issue Implementation Executor

Wraps "grab next AFK issue → run /tdd → commit + push + close." Designed in the Pocock skill-process grill (`{vault}/daily/grill-sessions/2026-04-25-skill-process-pocock-adoption.md`) as Phase C of the new pipeline. Replaces `/develop`'s role as the "build it" skill.

## Modes

| Mode | Invocation | Behavior |
|------|------------|----------|
| `once` (default) | `/impl` or `/impl --area <label>` | Grab one AFK issue, run /tdd, commit, push, close. Exit. |
| `parallel` | `/impl --parallel N` | Spawn N Agent-tool subagents with `isolation: "worktree"`, each running /tdd on a different AFK issue. Main session merges + pushes + closes. |
| `team` | DEFERRED — do not implement | Reserved for Phase G when first-party agent teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) prove necessary for cross-session coordination. Today: error and exit if user passes `--team`. |

## Defaults

- **Repo for issues:** the project tracker named in `working-rules.md` (single tracker for all areas)
- **Area filter:** `area:plugin-brain-os` (override with `--area <label>`)
- **Required labels for AFK pick:** `ready` AND `afk` (or `owner:bot` for legacy issues)
- **Empty backlog sentinel:** emit literally `<promise>NO_MORE_ISSUES</promise>` in your assistant text response so an outer `/ralph-loop --completion-promise "NO_MORE_ISSUES"` can latch and stop. Ralph reads transcript text blocks (`type: text`), not unix stdout — a `Bash(echo)` call will not satisfy the contract.
- **Test runner inside /tdd:** `bun test` for new code; per-artifact-type table in `/tdd` for hooks, plists, scripts, vault docs

## Recommended invocation patterns

### Manual

```
/impl                        # Pick one AFK issue, /tdd it, commit/push/close, exit
/impl --area plugin-vault    # Same, filtered to a different area label
/impl --parallel 3           # Three issues in worktree-isolated subagents
```

### Autonomous backlog drain (wrap in `/ralph-loop`)

For unattended, multi-iteration drainage, wrap `/impl` in the ralph-loop Stop hook:

```
/ralph-loop "/impl" --completion-promise "NO_MORE_ISSUES" --max-iterations 10
```

How it terminates: each iteration `/impl` picks the next AFK issue, `/tdd`s it, commits, pushes, closes. When the `gh issue list` query returns zero, `/impl` outputs `<promise>NO_MORE_ISSUES</promise>` in its assistant text response. The ralph Stop hook extracts the text inside the `<promise>` tags, exact-matches against `--completion-promise`, and exits cleanly.

Hybrid (each ralph iteration spawns N subagents):

```
/ralph-loop "/impl --parallel 3" --completion-promise "NO_MORE_ISSUES" --max-iterations 10
```

Tuning `--max-iterations` (safety cap, never omit):
- Daytime quick-drain: `1–3 ×` expected backlog depth
- Overnight drain: `30–50`

Caveats:
- The sentinel must be in the *text response*, not via `Bash(echo)`. Ralph reads transcript text blocks (`type: text`).
- Do NOT wrap ralph-loop around HITL skills (`/grill`, `/handover`, `/improve`) — they need human input ralph won't supply.
- `--completion-promise` is exact-string match on the *inner* tag text — no quotes, no extra whitespace, no paraphrasing.

## Workflow — `once` mode

### 1. Pick

```bash
gh issue list \
  -R <tracker-repo> \
  --label "area:plugin-brain-os,ready,afk" \
  --json number,title,body,labels \
  --limit 1
```

If empty → output `<promise>NO_MORE_ISSUES</promise>` in your text response and exit 0.

If one issue returned → continue with that issue's number, title, body.

### 2. Claim

```bash
gh issue edit <N> -R <tracker-repo> \
  --add-label "status:in-progress" \
  --remove-label "ready"
```

### 3. Read

Read the issue body in full. In particular:
- "Required reading" / "Pattern reference" sections — load every file mentioned BEFORE writing anything
- "Acceptance" checklist — this is the contract
- `Files:` declared list (if present from `/to-issues`) — confirm scope
- `Blocked by #M` — if M is still open, abort and re-label `ready`; the issue isn't actually AFK-ready

### 4. Implement via /tdd

Invoke the `/tdd` skill on the issue. /tdd handles:
- Picking the test command from its artifact-type table (skills, scripts, hooks, plists, vault docs)
- Tracer-bullet → red → green loop
- Refactor only when GREEN
- Its own outcome log

`/impl` does NOT duplicate any of /tdd's logic. `/impl` only owns issue plumbing.

### 5. Commit + push + close

```bash
git add <touched files>
git commit -m "$(cat <<'EOF'
<type>: <subject>

<body — 1–3 sentences on the why, not the what>

Closes <tracker-repo>#<N>

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
git pull --rebase
git push
gh issue close <N> -R <tracker-repo> --reason completed
```

`git pull --rebase` is mandatory before push because the CI auto-release pipeline runs on each push and may have bumped `plugin.json`.

### 6. Outcome log

Append one line to `{vault}/daily/skill-outcomes/impl.log` (see § Outcome log below).

## Workflow — `--parallel N` mode

The main session is the orchestrator. It does NOT touch artifact files itself in this mode.

### 1. Pick N

Same `gh issue list` query as `once` mode but `--limit N`. If fewer than N return, run with what you got. If zero → output `<promise>NO_MORE_ISSUES</promise>` in your text response and exit 0.

### 2. Spawn N subagents in parallel

Use the `Agent` tool with `isolation: "worktree"` for every spawned subagent. Verbatim:

```
Agent({
  description: "impl issue #<N>",
  subagent_type: "general-purpose",
  isolation: "worktree",
  prompt: "<self-contained brief: issue number, full body, /tdd pattern, commit conventions, exit protocol>"
})
```

Send all N tool calls in a single assistant message so they run concurrently.

The `isolation: "worktree"` parameter is always-on for parallel mode — never conditional, never optional. It gives each subagent a temporary git worktree, auto-cleaned when the agent makes no changes, and prevents the "two teammates editing the same file" overwrite class identified in the grill.

Because each subagent has its own working tree, you do NOT need to pre-validate disjoint file ownership across the N issues. /to-issues warns on file overlap as a soft signal; worktree isolation is the hard guarantee.

### 3. Merge

When subagents return:

- Each subagent has produced a commit on a branch in its worktree
- Pull each branch into the main worktree:
  ```bash
  git fetch <branch-or-worktree-ref>
  git merge --ff-only <branch>  # or rebase if conflicts emerge
  ```
- If a subagent reports failure (test still red, or aborted): leave its issue back in `ready` (re-label), drop its worktree commits, and continue with the rest. Do not block successful siblings.

### 4. Push + close

After every successful merge:

```bash
git pull --rebase && git push
for N in <successful-issue-numbers>; do
  gh issue close $N -R <tracker-repo> --reason completed
done
```

### 5. Outcome log

One log line PER issue (not per parallel run). Each line carries `mode=parallel` in the optional fields so /improve can attribute outcomes back to mode.

## Required reading inside the spawned subagent

When `--parallel N` spawns a subagent, the prompt MUST embed:

1. The full issue body verbatim (do not summarize — the subagent has no shared context)
2. A pointer to `/tdd` SKILL.md (path: `~/work/brain-os-plugin/skills/tdd/SKILL.md`)
3. Commit-message convention (Conventional Commits + `Closes <tracker-repo>#N` + Co-Authored-By line)
4. Exit protocol: commit → push → output the issue number on a line by itself so the orchestrator can latch
5. Worktree note: "you are running with `isolation: 'worktree'`; commit in your worktree branch, do not push, the orchestrator will fast-forward into main"

## When NOT to use /impl

- Issue is HITL (human-in-loop) — needs interactive grilling or approval. Use the issue's normal flow; don't auto-pick.
- Issue is `Blocked by #M` and M is open — re-label `ready` and skip; the dependency must land first.
- One-off tweaks the user is making interactively — just edit the file, don't fabricate an issue to satisfy /impl.
- The issue isn't on the configured tracker repo — /impl only knows that tracker. Other repos use whatever flow is documented locally.
- The user has explicitly taken control of an issue (`status:in-progress` already set, owner is a human) — do not steal it.

## Gotchas

- **`Closes <tracker-repo>#N` not `Closes #N`.** Cross-repo close-on-merge requires the explicit repo prefix because the commit lands in the code repo (e.g. brain-os-plugin) but the issue lives in the tracker repo. `gh issue close` is still required as a belt-and-braces step because cross-repo `Closes` doesn't always auto-fire.
- **`git pull --rebase` is mandatory before push.** CI auto-release pipelines bump `plugin.json` on every push. Skipping the rebase guarantees a non-fast-forward push failure.
- **Empty backlog sentinel must be wrapped in `<promise>` tags** — emit exactly `<promise>NO_MORE_ISSUES</promise>` in the assistant text response. The ralph-loop Stop hook (`stop-hook.sh:130-141`) extracts the inner text via Perl regex and exact-matches against `--completion-promise "NO_MORE_ISSUES"`. Bare `NO_MORE_ISSUES` without tags only matches when the entire response is *literally that string and nothing else* — adding any surrounding prose (which Claude almost always does) breaks the match. Stdout / `Bash(echo)` is also wrong: ralph reads transcript text blocks (`type: text`), not stdout.
- **`--team` is DEFERRED.** If a user passes `--team`, print "team mode is deferred to Phase G — see grill 2026-04-25" and exit 1. Don't fall back to `--parallel` silently — the user explicitly asked for the unimplemented mode.
- **/tdd owns the test loop. /impl owns the issue plumbing.** Do not duplicate /tdd's red-green logic here. If /tdd's discipline isn't holding (reactive `improve: encoded feedback —` patches keep landing), fix /tdd, not /impl.

## Outcome log

Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/impl.log`:

```
{date} | impl | {action} | ~/work/brain-os-plugin | {issue-or-batch-ref} | commit:{hash} | {result}
```

- `action`: `once` (single issue), `parallel` (one of N issues from a parallel run), or `drain` (the orchestrator's wrap-up after a parallel batch — output_path = batch label, e.g. `parallel-N3`)
- `issue-or-batch-ref`: `<tracker-repo>#N` for `once`/`parallel`; the batch label for `drain`
- `result`: `pass` if the issue closed AND no reactive `improve: encoded feedback —` commit lands against the touched artifacts within 48h; `partial` if user manually corrected before close; `fail` if cycle aborted or reactive patch needed
- Optional: `mode=parallel`, `n=N` (parallel size), `area=<label>`, `tdd_cycles=K` (red-green count from /tdd)

If `result != pass`, auto-invoke `/brain-os:improve impl` per the skill-spec § 11 auto-improve rule. The eval gate inside /improve reverts any change that drops pass rate, so auto-apply is safe.
