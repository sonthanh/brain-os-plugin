---
name: impl
description: "Per-issue implementation executor for brain-os artifacts. Default mode grabs the next AFK GitHub issue and runs /tdd on it; -p N (alias --parallel N) fans out via Agent-tool subagents with worktree isolation; /impl N runs /tdd on a specific issue regardless of owner label; /impl story <N> drains a multi-issue story DAG. Use when draining the AFK backlog, picking up a specific issue, or running an approved story end-to-end. Pairs with /ralph-loop for autonomous backlog drainage."
---

# /impl — Per-Issue Implementation Executor

Wraps "grab next AFK issue → run /tdd → commit + push + close." Designed in the Pocock skill-process grill (`{vault}/daily/grill-sessions/2026-04-25-skill-process-pocock-adoption.md`) as Phase C of the new pipeline. Replaces `/develop`'s role as the "build it" skill.

## Modes

| Mode | Invocation | Behavior |
|------|------------|----------|
| `once` (default) | `/impl` or `/impl --area <label>` | Grab one AFK issue (`status:ready` AND `owner:bot`), run /tdd, commit, push, close. Exit. |
| `issue` | `/impl <N>` | Run /tdd on a SPECIFIC issue number — owner-label filter is bypassed (works for `owner:bot` AND `owner:human`). The trunk-block hook still gates AFK trunk-touches via `IMPL_AFK=1`. Use when you (or another skill) already picked the issue and want /impl to handle plumbing. See § Workflow — `issue` mode. |
| `parallel` | `/impl -p N` (alias `--parallel N`) | Spawn N Agent-tool subagents with `isolation: "worktree"`, each running /tdd on a different AFK issue. Main session merges + pushes + closes. |
| `story` | `/impl story <parent-N> [-p N]` (alias `/impl --story <parent-N>`) | Bash-orchestrated DAG drain of a multi-issue story. Reads parent issue body checklist + each child's `Blocked by` to build the DAG, spawns AFK workers (claude -w + /impl) up to parallel cap, surfaces HITL children via osascript notify, ticks parent body checklist on each close, closes parent + macOS-notifies on completion. Self-detached via `nohup` — main Claude session exits immediately, ~0 token burn during drain. Both invocation forms dispatch to the same `scripts/run-story.ts` orchestrator. |
| `team` | DEFERRED — do not implement | Reserved for Phase G when first-party agent teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) prove necessary for cross-session coordination. Today: error and exit if user passes `--team`. |

## Defaults

- **Repo for issues:** the project tracker named in `working-rules.md` (single tracker for all areas)
- **Area filter:** `area:plugin-brain-os` (override with `--area <label>`)
- **Required labels for AFK pick:** `status:ready` AND `owner:bot`
- **Empty backlog sentinel:** emit literally `<promise>NO_MORE_ISSUES</promise>` in your assistant text response so an outer `/ralph-loop --completion-promise "NO_MORE_ISSUES"` can latch and stop. Ralph reads transcript text blocks (`type: text`), not unix stdout — a `Bash(echo)` call will not satisfy the contract.
- **Test runner inside /tdd:** `bun test` for new code; per-artifact-type table in `/tdd` for hooks, plists, scripts, vault docs

## Recommended invocation patterns

### Manual

```
/impl                        # Pick one AFK issue, /tdd it, commit/push/close, exit
/impl 147                    # Run /tdd on issue #147 specifically (owner override)
/impl --area plugin-vault    # Same as bare /impl, filtered to a different area label
/impl -p 3                   # Three issues in worktree-isolated subagents (alias: --parallel 3)
/impl story 145              # Drain the story rooted at parent issue #145 (alias: --story 145)
/impl story 145 -p 5         # Same, raise parallel cap to hard max
```

### Autonomous backlog drain (wrap in `/ralph-loop`)

For unattended, multi-iteration drainage, wrap `/impl` in the ralph-loop Stop hook:

```
/ralph-loop "/impl" --completion-promise "NO_MORE_ISSUES" --max-iterations 10
```

How it terminates: each iteration `/impl` picks the next AFK issue, `/tdd`s it, commits, pushes, closes. When the `gh issue list` query returns zero, `/impl` outputs `<promise>NO_MORE_ISSUES</promise>` in its assistant text response. The ralph Stop hook extracts the text inside the `<promise>` tags, exact-matches against `--completion-promise`, and exits cleanly.

Hybrid (each ralph iteration spawns N subagents):

```
/ralph-loop "/impl -p 3" --completion-promise "NO_MORE_ISSUES" --max-iterations 10
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
  --label "area:plugin-brain-os,status:ready,owner:bot" \
  --json number,title,body,labels \
  --limit 1
```

If empty → output `<promise>NO_MORE_ISSUES</promise>` in your text response and exit 0.

If one issue returned → continue with that issue's number, title, body.

### 2. Claim

```bash
gh issue edit <N> -R <tracker-repo> \
  --remove-label "status:ready" \
  --add-label "status:in-progress"
```

### 3. Read

Read the issue body in full. In particular:
- "Required reading" / "Pattern reference" sections — load every file mentioned BEFORE writing anything
- "Acceptance" checklist — this is the contract
- `Files:` declared list (if present from `/slice`) — confirm scope
- `Blocked by #M` — if M is still open, abort and re-label `status:ready`; the issue isn't actually AFK-ready

### 4. Implement via /tdd

Invoke the `/tdd` skill on the issue. /tdd handles:
- Picking the test command from its artifact-type table (skills, scripts, hooks, plists, vault docs)
- Tracer-bullet → red → green loop
- Refactor only when GREEN
- Its own outcome log

`/impl` does NOT duplicate any of /tdd's logic. `/impl` only owns issue plumbing.

### 5. Commit + push + close

The commit invocation MUST be prefixed with `IMPL_AFK=1` so the trunk-block hook (PreToolUse Bash, registered in `hooks/hooks.json`) can recognize it as AFK and gate trunk-path changes (see Gotchas):

```bash
git add <touched files>
IMPL_AFK=1 git commit -m "$(cat <<'EOF'
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

If the trunk-block hook fires (exit 2): the commit is blocked because the staged diff touches a file on `references/trunk-paths.txt` (CLAUDE.md, hooks, references, cross-skill primitives, etc.). Do NOT retry with `--no-verify` or strip the prefix. Instead: re-label the issue `status:ready` + `owner:human`, leave the worktree as-is, exit. The user will pick the issue up interactively next session; the work isn't lost — the staged diff persists in the worktree until the user resolves it.

### 6. Outcome log

Append one line to `{vault}/daily/skill-outcomes/impl.log` (see § Outcome log below).

## Workflow — `issue` mode

`/impl <N>` runs /tdd on a specific issue regardless of its `owner:bot` / `owner:human` label. The owner-label filter that gates `once` mode is intentionally bypassed because the user (or a parent skill like `/impl story`) has already decided this issue is the next one to ship.

### Differences vs `once` mode

| Step | `once` | `issue <N>` |
|------|--------|-------------|
| Pick | `gh issue list` filtered by `status:ready,owner:bot` | Skip — issue number is given as arg |
| Owner check | Required (`owner:bot` only) | Bypassed — accepts any owner |
| Claim | `status:ready` → `status:in-progress` | Same |
| Read | Issue body, "Required reading", "Acceptance", `Blocked by` | Same |
| /tdd | Same | Same |
| Commit | `IMPL_AFK=1 git commit ...` | `IMPL_AFK=1 git commit ...` (still required) |
| Push + close | Same | Same |

### Why `IMPL_AFK=1` still applies

Even though `issue` mode accepts `owner:human`, the `IMPL_AFK=1` prefix is mandatory on the commit invocation. Reason: the prefix is what the trunk-block hook (`hooks/pre-commit-trunk-block.sh`) keys on to decide whether to scan staged paths against `references/trunk-paths.txt`. The owner label is *intent* metadata; the prefix is the *gate*. They are independent — owner controls the pick path, prefix controls the commit gate. Drop the prefix only when the user is hand-driving the commit interactively (and even then, the leaf-vs-trunk discipline still applies — the hook just isn't enforcing it).

If the trunk-block hook fires for an `owner:human` issue you picked up via `/impl <N>`: same response as `once` mode — re-label the issue `status:ready` + `owner:human`, leave the worktree as-is, exit. The user can resolve interactively next session.

### When to invoke `issue` mode

- User runs `/impl <N>` directly because they want THIS issue done now
- `/impl story <P>` orchestrator dispatches `claude -w ... -p "/impl <M>"` per child
- A handover doc instructs the next session to "pick up #<N>"

### When NOT to invoke `issue` mode

- The issue is mid-flow HITL (incomplete grill, half-written handover, mid-draft writing) — those stay `owner:human` and route through `/pickup`, not `/impl`. See § Mid-flow rule below.
- The issue is `Blocked by #M` and #M is still open — abort and re-label `status:ready`, same as `once` mode.

## Workflow — `story` mode

`/impl story <parent-N> [-p N]` drains a multi-issue story in DAG order. The orchestration is a TypeScript script (`scripts/run-story.ts`, `bun` runtime, unit-tested via `scripts/run-story.test.ts`) — main Claude session exits after kicking it off, ~0 token burn for the duration of the drain.

### Invocation

When the user types `/impl story <parent-N>` (optionally `-p <N>`), execute:

```bash
mkdir -p ~/.local/state/impl-story && \
  nohup /opt/homebrew/bin/bun run "$CLAUDE_PLUGIN_ROOT/scripts/run-story.ts" <parent-N> -p <N> \
  >> ~/.local/state/impl-story/<parent-N>.log 2>&1 &
echo "Started orchestrator (PID $!). Log: ~/.local/state/impl-story/<parent-N>.log"
```

`nohup ... &` self-detaches the process — the bash command returns immediately. After the bash invocation returns, your work is done — exit cleanly.

### What the script does

1. Reads parent issue body, parses `- [ ] #M` / `- [x] #M` checklist → child issue numbers.
2. For each child: fetches body + labels, parses `## Blocked by\n- ai-brain#X` → adjacency map. Detects `owner:bot` vs `owner:human`.
3. Initial ready queue: children with all dependency issues already CLOSED.
4. **Greedy DAG drainer loop** (sleep 30s between polls):
   - Top up parallel pool: HITL children spawn anytime (notify-only, no worker), AFK children spawn within `-p` cap (default 3, hard max 5).
   - AFK spawn = `claude -w "story-<P>-issue-<M>" --dangerously-skip-permissions -p "/impl <M>"` in background.
   - HITL spawn = osascript notify `"HITL: #M needs human. Run: cr /pickup M"` — user resolves manually.
   - Poll each watched child via `gh issue view <M> --json state` — on CLOSED: tick parent body checklist (`sed - [ ] #M → - [x] #M`, `gh issue edit --body`), promote any newly-unblocked waiters to ready queue.
5. When ready queue + watching set both empty: close parent (`gh issue close <P> --reason completed`).
6. Final macOS notification: `"Story #<P> complete. Run: cr /story-debrief <P> for review"`.
7. All steps logged to `~/.local/state/impl-story/<parent-N>.log`.

### Parallel cap rationale

Default `-p 3`, hard-capped at 5 inside the script. Each AFK worker is its own `claude -w` session consuming subscription quota; concurrent sessions add up. HITL children do NOT count toward the cap (they're notify-only). User can raise to 5 with `-p 5`; values above 5 are silently clamped.

### Token cost

| Phase | Main Claude tokens |
|-------|---------------------|
| `/impl story <P>` invocation | ~1K (skill prose + bash command) |
| Detached drain (could be hours) | 0 |
| Per-worker session | Independent quota, isolated context |

Status check anytime via `tail -f ~/.local/state/impl-story/<P>.log` from any terminal — no Claude session needed.

### When NOT to use story mode

- Parent issue body has no `- [ ] #M` checklist (script aborts with notify).
- All children already CLOSED (parent should be closed manually, story is done).
- User wants to drain whole queue regardless of story membership (use `/impl auto -p N` instead).

## Workflow — `-p N` mode (alias `--parallel N`)

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

Because each subagent has its own working tree, you do NOT need to pre-validate disjoint file ownership across the N issues. /slice warns on file overlap as a soft signal; worktree isolation is the hard guarantee.

### 3. Merge

When subagents return:

- Each subagent has produced a commit on a branch in its worktree
- Pull each branch into the main worktree:
  ```bash
  git fetch <branch-or-worktree-ref>
  git merge --ff-only <branch>  # or rebase if conflicts emerge
  ```
- If a subagent reports failure (test still red, or aborted): leave its issue back in `status:ready` (re-label), drop its worktree commits, and continue with the rest. Do not block successful siblings.

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

When `-p N` (alias `--parallel N`) spawns a subagent, the prompt MUST embed:

1. The full issue body verbatim (do not summarize — the subagent has no shared context)
2. A pointer to `/tdd` SKILL.md (path: `~/work/brain-os-plugin/skills/tdd/SKILL.md`)
3. Commit-message convention (Conventional Commits + `Closes <tracker-repo>#N` + Co-Authored-By line) — and the `IMPL_AFK=1` prefix on the `git commit` invocation (the trunk-block hook gates AFK commits against `references/trunk-paths.txt`; see Gotchas)
4. **Subagent-side trunk-paths self-check (belt-and-braces).** The PreToolUse(Bash) hook may not fire from a subagent's worktree because the hook process can inherit the orchestrator's cwd, in which case `git diff --cached` reads the wrong index and the gate silently passes. To close that gap, the subagent MUST run this check itself before invoking `git commit`:
   ```bash
   git diff --cached --name-only | bash "$CLAUDE_PLUGIN_ROOT/scripts/check-trunk-paths.sh"
   if [ $? -eq 1 ]; then
     # Trunk match — re-label and exit (do NOT commit, do NOT push)
     gh issue edit <N> -R <tracker-repo> \
       --remove-label status:in-progress --add-label status:ready \
       --remove-label owner:bot --add-label owner:human
     exit 0
   fi
   ```
   If the script exits 1 (matches), abort the subagent gracefully. If exit 0, proceed to commit.
5. Exit protocol: self-check → commit → push → output the issue number on a line by itself so the orchestrator can latch. If the orchestrator's PreToolUse hook ALSO fires and exits 2 (defense in depth), follow the same re-label-and-exit path.
6. Worktree note: "you are running with `isolation: 'worktree'`; commit in your worktree branch, do not push, the orchestrator will fast-forward into main"

## Mid-flow rule

Handovers, incomplete grills, mid-draft writing stay `owner:human`. `/impl` (in `once` and `parallel` modes) filters on `owner:bot` — handovers are excluded by construction. Codified to prevent label drift where someone tags a half-finished grill `owner:bot` and an autonomous worker picks it up mid-thought.

The rule, stated mechanically:

| Artifact state | Owner label | Pickup path |
|----------------|-------------|-------------|
| Skill / script / hook / plist with closed acceptance criteria | `owner:bot` | `/impl` (any mode) |
| Handover doc (continuation contract for a future session) | `owner:human` | `/pickup` (HITL) |
| Grill session not yet settled | `owner:human` | `/pickup` (HITL) |
| Mid-draft Substack / vault essay | `owner:human` | `/pickup` (HITL) |
| Anything that needs human judgment to close | `owner:human` | `/pickup` (HITL) |

If `/impl <N>` is invoked on an `owner:human` issue (legal — owner filter bypassed in `issue` mode), the operator is making an explicit override decision. Honor it: run /tdd, commit, push, close. The mid-flow rule still applies as guidance, but the explicit override carries the day. Do NOT prompt the user to confirm; do NOT silently fall back to `/pickup`.

## When NOT to use /impl

- Issue is HITL (human-in-loop) — needs interactive grilling or approval. Use the issue's normal flow; don't auto-pick.
- Issue is `Blocked by #M` and M is open — re-label `status:ready` and skip; the dependency must land first.
- One-off tweaks the user is making interactively — just edit the file, don't fabricate an issue to satisfy /impl.
- The issue isn't on the configured tracker repo — /impl only knows that tracker. Other repos use whatever flow is documented locally.
- The user has explicitly taken control of an issue (`status:in-progress` already set, owner is a human) — do not steal it.

## Gotchas

- **`Closes <tracker-repo>#N` not `Closes #N`.** Cross-repo close-on-merge requires the explicit repo prefix because the commit lands in the code repo (e.g. brain-os-plugin) but the issue lives in the tracker repo. `gh issue close` is still required as a belt-and-braces step because cross-repo `Closes` doesn't always auto-fire.
- **`git pull --rebase` is mandatory before push.** CI auto-release pipelines bump `plugin.json` on every push. Skipping the rebase guarantees a non-fast-forward push failure.
- **`IMPL_AFK=1` on the commit invocation is required.** It signals to the trunk-block hook (`hooks/pre-commit-trunk-block.sh`) that this is autonomous AFK work. The hook reads the trunk-paths list (`references/trunk-paths.txt`) and exits 2 if any staged file matches — blocks the commit. Without the prefix, the hook is a no-op (interactive direct-push-to-main is unchanged). Source: [grill 2026-04-26](https://github.com/sonthanh/ai-brain/blob/main/daily/grill-sessions/2026-04-26-depth-leaf-trunk-design.md). DO NOT bypass with `--no-verify` or strip the prefix to "make it work" — the right response to a block is `gh issue edit <N> -R <tracker-repo> --remove-label status:in-progress --add-label status:ready --remove-label owner:bot --add-label owner:human` and exit; the user resolves interactively.
- **Empty backlog sentinel must be wrapped in `<promise>` tags** — emit exactly `<promise>NO_MORE_ISSUES</promise>` in the assistant text response. The ralph-loop Stop hook (`stop-hook.sh:130-141`) extracts the inner text via Perl regex and exact-matches against `--completion-promise "NO_MORE_ISSUES"`. Bare `NO_MORE_ISSUES` without tags only matches when the entire response is *literally that string and nothing else* — adding any surrounding prose (which Claude almost always does) breaks the match. Stdout / `Bash(echo)` is also wrong: ralph reads transcript text blocks (`type: text`), not stdout.
- **`--team` is DEFERRED.** If a user passes `--team`, print "team mode is deferred to Phase G — see grill 2026-04-25" and exit 1. Don't fall back to `-p` silently — the user explicitly asked for the unimplemented mode.
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
