---
name: impl
description: "Per-issue implementation executor — grab next AFK issue, run /tdd, commit + push + close. Modes: /impl N (specific issue), /impl story <N> (story DAG), /impl auto (drain queue), /impl -p N (parallel workers). Use khi drain AFK backlog hoặc execute approved story."
---

# /impl — Per-Issue Implementation Executor

Wraps "grab next AFK issue → run /tdd → commit + push + close." Designed in the Pocock skill-process grill (`{vault}/daily/grill-sessions/2026-04-25-skill-process-pocock-adoption.md`) as Phase C of the new pipeline. Replaces `/develop`'s role as the "build it" skill.

## Modes

| Mode | Invocation | Behavior |
|------|------------|----------|
| `once` (default) | `/impl` or `/impl --area <label>` | Grab one AFK issue (`status:ready` AND `owner:bot`), run /tdd, commit, push, close. Exit. |
| `issue` | `/impl <N>` or `/impl <N>,<M>,...` | Run /tdd on a specific issue number; comma-separated list runs sequentially in list order. Owner-label filter is bypassed (works for `owner:bot` AND `owner:human`). The trunk-block hook still gates AFK trunk-touches via `IMPL_AFK=1`. Use when you (or another skill) already picked the issue(s) and want /impl to handle plumbing. See § Workflow — `issue` mode. |
| `parallel` | `/impl -p K` (alias `--parallel K`) or `/impl -p <N>,<M>,...` | Dispatches `scripts/run-parallel.ts` (TS orchestrator, mirrors `/impl story` after #161 + #173). `-p K` (integer) picks K from queue head (`status:ready,owner:bot`); `-p <list>` (comma-separated) spawns one worker per listed issue (owner-bypass, same as issue-mode list). Workers are detached `claude -w` sessions spawned via `Bun.spawn` with explicit per-issue `cwd: inferRepoFromIssueArea(labels)`. `nohup`-detached, ~0 main-session token burn. Hard cap 5. |
| `story` | `/impl story <parent-N> [-p N]` (alias `/impl --story <parent-N>`) | Bash-orchestrated DAG drain of a multi-issue story. Reads parent issue body checklist + each child's `Blocked by` to build the DAG, spawns AFK workers (claude -w + /impl) up to parallel cap, surfaces HITL children via osascript notify, ticks parent body checklist on each close, closes parent + macOS-notifies on completion. Self-detached via `nohup` — main Claude session exits immediately, ~0 token burn during drain. Both invocation forms dispatch to the same `scripts/run-story.ts` orchestrator. |
| `auto` | `/impl auto [-p N]` | Autonomous AFK queue drain. One-shot dispatcher that bash-executes `scripts/run-ralph.sh "/impl[ -p N]" --completion-promise NO_MORE_ISSUES --max-iterations 50`, which sets up an in-session `/ralph-loop` whose body is `/impl` (or `/impl -p N`) per iteration. The Stop hook re-feeds the prompt until `/impl` emits `<promise>NO_MORE_ISSUES</promise>` (empty backlog) or 50 iterations elapse. NOT detached — the loop runs in the same Claude session and burns inference per iteration. See § Workflow — `auto` mode. |
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
/impl 147,148,149            # Sequential list — /tdd 147, then 148, then 149 (owner override per issue)
/impl --area plugin-vault    # Same as bare /impl, filtered to a different area label
/impl -p 3                   # Dispatch run-parallel.ts: three claude -w workers from queue head (alias: --parallel 3)
/impl -p 147,148             # Dispatch run-parallel.ts: parallel explicit list, one claude -w worker per listed issue
/impl story 145              # Drain the story rooted at parent issue #145 (alias: --story 145)
/impl story 145 -p 5         # Same, raise parallel cap to hard max
```

### Autonomous backlog drain

`/impl auto` is the canonical AFK drain entry point. Hardcoded args, no tuning:

```
/impl auto                   # Drain queue: in-session /ralph-loop wrapping /impl, max 50 iterations
/impl auto -p 3              # Same, each iteration dispatches run-parallel.ts to spawn 3 detached claude -w workers
```

Mechanism: `/impl auto` bash-executes `scripts/run-ralph.sh "/impl[ -p N]" --completion-promise NO_MORE_ISSUES --max-iterations 50`. The wrapper resolves the installed `ralph-loop` plugin path dynamically and forwards to `setup-ralph-loop.sh`, which writes `.claude/ralph-loop.local.md` and emits the initial `/impl` prompt for Claude to act on. Each loop iteration runs `/impl` (or `/impl -p N`), claims one AFK issue, ships it. When the `gh issue list` query returns zero, `/impl` emits `<promise>NO_MORE_ISSUES</promise>` in its assistant text response; the ralph Stop hook extracts the inner tag via Perl regex, exact-matches against `NO_MORE_ISSUES`, and exits cleanly. Hits `--max-iterations 50` if the sentinel never fires.

`/impl auto` is dispatch-only — it shells the wrapper and exits. The loop body is still `/impl` invoked BY the ralph-loop Stop hook on each iteration; outcome logs come from the inner `/impl` (`once` or `parallel` rows), not from `auto`. Do not add an `action=auto` log row.

### Custom-tuned drain (manual `/ralph-loop` wrap)

Use only when you need different `--max-iterations`, a different completion promise, or a non-`/impl` body. The full form:

```
/ralph-loop "/impl" --completion-promise "NO_MORE_ISSUES" --max-iterations 10
/ralph-loop "/impl -p 3" --completion-promise "NO_MORE_ISSUES" --max-iterations 30
```

Tuning `--max-iterations`:
- Daytime quick-drain: `1–3 ×` expected backlog depth
- Overnight drain: `30–50` (the `/impl auto` default is 50)

Caveats (apply to both `/impl auto` and the manual wrap):
- The sentinel MUST be in the *text response*, not via `Bash(echo)`. Ralph reads transcript text blocks (`type: text`), not unix stdout.
- Do NOT wrap ralph-loop around HITL skills (`/grill`, `/handover`, `/improve`) — they need human input ralph won't supply.
- `--completion-promise` is exact-string match on the *inner* tag text — no quotes, no extra whitespace, no paraphrasing.
- The loop is in-session — every iteration burns inference quota in the current Claude session. Distinct from `/impl story`, which detaches via `nohup` and burns ~0 main-session tokens.

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

Atomic flip via the canonical helper — single `gh issue edit` call removing `status:ready` and adding `status:in-progress` from one process invocation:

```bash
bash "$CLAUDE_PLUGIN_ROOT/scripts/gh-tasks/transition-status.sh" <N> --to in-progress
```

Do NOT inline `gh issue edit --remove-label status:ready --add-label status:in-progress` — `transition-status.sh` is the single source of truth so the wire-level remove+add stays atomic AND target-validated against the canon list (see `references/gh-task-labels.md` § 3).

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
bash "$CLAUDE_PLUGIN_ROOT/scripts/gh-tasks/close-issue.sh" <N>
```

`bash "$CLAUDE_PLUGIN_ROOT/scripts/gh-tasks/close-issue.sh"` is the single close site — it strips every `status:*` label before flipping state to closed, plugging the ghost-label leak that pre-dated #160. Do NOT inline `gh issue close` here or anywhere else; the helper is the lifecycle close-step.

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

### List form — sequential (`/impl <N>,<M>,...`)

When the arg contains one or more commas, parse as a comma-separated list of issue numbers and run them through `issue` mode sequentially in list order.

**Parser rule.** Split on `,`, trim whitespace, parse each token as integer. If any token fails to parse as a positive integer, abort with `FATAL: invalid issue number in list: <token>` and exit 1 — do not silently drop bad tokens.

**Dedupe.** Remove duplicate numbers preserving first occurrence; emit `WARN: dropped duplicate #<N> from list` to text response so the user sees the deviation.

**Same-area assertion (deterministic).** Before claiming any issue, run `gh issue view <N> -R <tracker-repo> --json labels` for every listed issue and extract the `area:*` label. If labels differ across the list, abort with `FATAL: list spans multiple areas (#<X> area:<a>, #<Y> area:<b>). Run separate /impl invocations per area.` and exit 1. The main session has ONE cwd, so commits would land in the wrong repo for the off-area issue. This pre-existed for single-issue `/impl <N>` (user picks the right repo) but list mode amplifies it — make the abort explicit.

**Loop.** For each issue in the deduped list:

1. Run the full `issue` mode workflow: claim → read → /tdd → `IMPL_AFK=1 git commit` → `git pull --rebase` → `git push` → `bash "$CLAUDE_PLUGIN_ROOT/scripts/gh-tasks/close-issue.sh" <N>`.
2. On any per-issue failure (test stays red, /tdd aborts, trunk-block hook fires, push rejected): re-label that issue back to `status:ready` (and `owner:human` if trunk-block fired, per existing rule), log the failure, and **continue with the next issue in the list**. Do not abort the rest of the list.
3. Append one outcome-log row per issue with `mode=list-sequential,n=<list-length>` in the optional fields.

**Final summary.** After the loop completes, emit a one-block summary in the assistant text response:

```
/impl list complete:
  closed: #<N>, #<M>, ...
  failed: #<X> (trunk-block re-labeled owner:human), #<Y> (test red)
  skipped: #<Z> (already CLOSED before claim)
```

**No `<promise>NO_MORE_ISSUES</promise>`.** List form runs only the issues you named — there is no "queue empty" condition. The sentinel is for `once`/`auto` modes; do not emit it here.

**Worktree isolation.** Sequential list does NOT spawn subagents and does NOT use worktree isolation — it runs each issue's edits in the main worktree, same as a single `/impl <N>`. If you need parallel + isolation, use `/impl -p <N>,<M>,...` instead.

## Workflow — `story` mode

`/impl story <parent-N> [-p N]` drains a multi-issue story in DAG order. The orchestration is a TypeScript script (`scripts/run-story.ts`, `bun` runtime, unit-tested via `scripts/run-story.test.ts`) — main Claude session exits after kicking it off, ~0 token burn for the duration of the drain.

### Invocation

When the user types `/impl story <parent-N>` (optionally `-p <N>`), execute:

```bash
# Resolve plugin root: env var → glob fallback → fail loud
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(ls -d ~/.claude/plugins/cache/brain-os-marketplace/brain-os/*/ 2>/dev/null | sort -V | tail -1)}"
PLUGIN_ROOT="${PLUGIN_ROOT%/}"
SCRIPT="$PLUGIN_ROOT/scripts/run-story.ts"
if [ ! -f "$SCRIPT" ]; then
  osascript -e 'display notification "FATAL: run-story.ts not found" with title "/impl story"'
  echo "FATAL: $SCRIPT not found (PLUGIN_ROOT=$PLUGIN_ROOT)"
  exit 1
fi

mkdir -p ~/.local/state/impl-story
nohup /opt/homebrew/bin/bun run "$SCRIPT" <parent-N> -p <N> \
  >> ~/.local/state/impl-story/<parent-N>.log 2>&1 &
PID=$!

# Verify launch — script writes <parent-N>.status within ~2s of starting
sleep 5
if ! ps -p $PID > /dev/null 2>&1; then
  osascript -e "display notification \"Orchestrator died within 5s — see log\" with title \"/impl story #<parent-N>\""
  echo "FATAL: orchestrator (PID $PID) died. Tail of log:"
  tail -20 ~/.local/state/impl-story/<parent-N>.log
  exit 1
fi
echo "Started orchestrator (PID $PID). Log: ~/.local/state/impl-story/<parent-N>.log | Status: ~/.local/state/impl-story/<parent-N>.status"
```

`nohup ... &` self-detaches the process. The verify block (sleep 5 + `ps`) catches launch-time crashes (module-not-found, bun missing, syntax error in script) — without it, a dead-on-arrival dispatch returns "Started" with no notify ever firing. After the verify block passes, your work is done — exit cleanly.

The orchestrator writes a heartbeat status JSON to `~/.local/state/impl-story/<parent-N>.status` on every poll cycle (`{"phase":"polling","watching":[...],"hb":N,...}`). External observers (main session pings via `ScheduleWakeup`, separate `cr` watcher sessions, manual `cat`) read that file — not the unstructured log — to know whether the drain is alive and progressing. On crash the script writes `phase:"died"` with the error.

### What the script does

1. Reads parent issue body, parses `- [ ] #M` / `- [x] #M` checklist → child issue numbers.
2. For each child: fetches body + labels, parses `## Blocked by\n- ai-brain#X` → adjacency map. Detects `owner:bot` vs `owner:human`.
3. Initial ready queue: children with all dependency issues already CLOSED.
4. **Greedy DAG drainer loop** (sleep 30s between polls):
   - Top up parallel pool: HITL children spawn anytime (notify-only, no worker), AFK children spawn within `-p` cap (default 3, hard max 5).
   - AFK spawn = `claude -w "story-<P>-issue-<M>" --dangerously-skip-permissions -p "/impl <M>"` in background.
   - HITL spawn = osascript notify `"HITL: #M needs human. Run: cr /pickup M"` — user resolves manually.
   - Poll each watched child via `gh issue view <M> --json state` — on CLOSED: tick parent body checklist (`sed - [ ] #M → - [x] #M`, `gh issue edit --body`), promote any newly-unblocked waiters to ready queue.
5. When ready queue + watching set both empty: close parent via `bash "$CLAUDE_PLUGIN_ROOT/scripts/gh-tasks/close-issue.sh" <P>` (strips status:* labels first).
6. Final macOS notification: `"Story #<P> complete. Log: ~/.local/state/impl-story/<P>.log"`.
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

`/impl -p N` and `/impl -p <N>,<M>,...` both dispatch to a TypeScript script orchestrator (`scripts/run-parallel.ts`, bun runtime, unit-tested via `scripts/run-parallel.test.ts`) — same architecture as `/impl story` (ai-brain#161 + #173). Main Claude session exits after kicking it off, ~0 token burn for the duration of the drain. Workers spawned via `claude -w` with explicit per-issue cwd from `area:*` labels — no Agent-tool path, no orchestrator-cwd dependency.

### Invocation

When the user types `/impl -p <K>` (integer K, queue-pick mode), execute:

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(ls -d ~/.claude/plugins/cache/brain-os-marketplace/brain-os/*/ 2>/dev/null | sort -V | tail -1)}"
PLUGIN_ROOT="${PLUGIN_ROOT%/}"
SCRIPT="$PLUGIN_ROOT/scripts/run-parallel.ts"
if [ ! -f "$SCRIPT" ]; then
  osascript -e 'display notification "FATAL: run-parallel.ts not found" with title "/impl -p"'
  echo "FATAL: $SCRIPT not found (PLUGIN_ROOT=$PLUGIN_ROOT)"
  exit 1
fi

mkdir -p ~/.local/state/impl-parallel
BATCH_ID="count-<K>-plugin-brain-os-$(date +%s)"
nohup /opt/homebrew/bin/bun run "$SCRIPT" --count <K> --area plugin-brain-os -p <K> \
  >> ~/.local/state/impl-parallel/${BATCH_ID}.log 2>&1 &
PID=$!

sleep 5
if ! ps -p $PID > /dev/null 2>&1; then
  osascript -e "display notification \"Orchestrator died within 5s — see log\" with title \"/impl -p\""
  echo "FATAL: orchestrator (PID $PID) died. Tail of log:"
  tail -20 ~/.local/state/impl-parallel/${BATCH_ID}.log
  exit 1
fi
echo "Started orchestrator (PID $PID). Log: ~/.local/state/impl-parallel/${BATCH_ID}.log"
```

When the user types `/impl -p <N>,<M>,...` (explicit list mode), execute:

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(ls -d ~/.claude/plugins/cache/brain-os-marketplace/brain-os/*/ 2>/dev/null | sort -V | tail -1)}"
PLUGIN_ROOT="${PLUGIN_ROOT%/}"
SCRIPT="$PLUGIN_ROOT/scripts/run-parallel.ts"
[ -f "$SCRIPT" ] || { echo "FATAL: run-parallel.ts not found"; exit 1; }

mkdir -p ~/.local/state/impl-parallel
ISSUES="<N>,<M>,..."  # raw user input, parser dedupes + clamps inside script
BATCH_ID="list-${ISSUES//,/-}"
nohup /opt/homebrew/bin/bun run "$SCRIPT" --issues "$ISSUES" -p <PARALLEL_CAP> \
  >> ~/.local/state/impl-parallel/${BATCH_ID}.log 2>&1 &
PID=$!

sleep 5
if ! ps -p $PID > /dev/null 2>&1; then
  osascript -e "display notification \"Orchestrator died within 5s — see log\" with title \"/impl -p\""
  tail -20 ~/.local/state/impl-parallel/${BATCH_ID}.log
  exit 1
fi
echo "Started orchestrator (PID $PID). Log: ~/.local/state/impl-parallel/${BATCH_ID}.log"
```

Both forms self-detach via `nohup ... &`. The verify block (sleep 5 + `ps`) catches launch-time crashes (module-not-found, bun missing, syntax error). After verify passes, your work is done — exit cleanly.

The orchestrator writes a heartbeat status JSON to `~/.local/state/impl-parallel/<batch-id>.status` on every poll cycle (`{"phase":"polling","watching":[...],"hb":N,...}`). External observers read that file — not the unstructured log — to track progress. On crash the script writes `phase:"died"` with the error.

### What the script does

1. Resolves issue list:
   - `--issues <N>,<M>,...` → calls `parseIssueList` (split `,` → trim → integer assert → dedupe with WARN → clamp at HARD_CAP=5 with WARN).
   - `--count K --area X` → calls `gh.listIssues(["area:X","status:ready","owner:bot"], K)` (queue-pick mode, owner:bot filter applied).
2. Calls `gh.viewFull(N)` for each issue. Asserts same `area:*` label across the list (`validateSameArea`); throws `FATAL: list spans multiple areas (...)` on mismatch BEFORE claiming any issue.
3. For each OPEN issue: calls `gh.claim(N)` (`status:ready` → `status:in-progress`); already-CLOSED issues are added to `closed` and skipped without spawn or claim. Per-issue cwd derived via `inferRepoFromIssueArea(labels, areaMap)`.
4. **Greedy parallel drainer loop**:
   - Top up parallel pool: spawns `claude -w "parallel-<batchId>-issue-<N>" --dangerously-skip-permissions -p "/impl <N>"` workers with explicit `cwd: <area-repo>` up to the parallel cap (clamped to HARD_CAP=5).
   - Heartbeat status write before sleep.
   - Poll each watched: `gh.viewState(N)` + `proc.isAlive(pid)` → `decideWorkerAction`. CLOSED → `cleanupWorker(name, cwd)` + add to closed. Dead → `gh.relabelHuman(N)` + add to failed; siblings continue.
5. Final notify on completion (success vs N failures).
6. Returns `{closed, failed}`. Inner `/impl <N>` workers handled their own commit + push + close-issue.sh; the orchestrator does NOT push or close from main repo.

### Parallel cap rationale

Default `-p 3`, hard-capped at 5 inside the script (`clampParallel(p, HARD_CAP)`). Each worker is its own `claude -w` session consuming subscription quota. User can raise to 5 with `-p 5`; values above 5 are silently clamped.

### Token cost

| Phase | Main Claude tokens |
|-------|---------------------|
| `/impl -p <K>` or `/impl -p <list>` invocation | ~1K (skill prose + bash command) |
| Detached drain (could be hours) | 0 |
| Per-worker session | Independent quota, isolated context |

Status check anytime via `tail -f ~/.local/state/impl-parallel/<batch-id>.log` from any terminal — no Claude session needed.

### Why not Agent-tool spawn?

Earlier `/impl -p` versions used `Agent({isolation: "worktree"})` from the main session. Two problems surfaced (smoke-tested 2026-04-27, ai-brain#173):

1. **Wrong-cwd worktree.** `Agent({isolation: "worktree"})` clones from the parent session's cwd — when main session is in the vault but listed issues are `area:plugin-brain-os`, the worktree was a vault clone and isolation broke (or had to be skipped entirely).
2. **No per-issue cwd param.** Agent tool has no `cwd` arg, so the workaround was "main session must `cd` into the area repo first" — but harness resets cwd between Bash calls, so the workaround couldn't be encoded in skill prose reliably.

The script orchestrator pattern (mirroring `/impl story` after #161's same fix) sidesteps both: `Bun.spawn(claude -w ..., { cwd })` takes explicit per-issue cwd derived from `inferRepoFromIssueArea(labels)`. Each worker lands in the correct repo regardless of where the orchestrator launched.

### List form — parallel (`/impl -p <N>,<M>,...`)

The `--issues <N>,<M>,...` form covered above is the list-mode entry. The script's `parseIssueList` enforces parser rules:

- **Parser rule.** Split on `,`, trim whitespace, parse each token as positive integer. Invalid token (`abc`, `-1`, `0`) → throws `FATAL: invalid issue number in list: <token>`.
- **Dedupe.** Removes duplicates preserving first occurrence; emits `WARN: dropped duplicate #<N> from list` per drop.
- **Clamp.** `list.length > HARD_CAP` (5) → keeps first 5 and emits `WARN: clamped parallel list to first 5 (got <length>): dropped #<a>, #<b>, ...`. Does NOT silently drop.
- **Same-area assertion.** Pre-check `area:*` labels via `validateSameArea`. Mismatch → throws `FATAL: list spans multiple areas (#<X> area:<a>, #<Y> area:<b>). Run separate /impl invocations per area.`. Critical because `Bun.spawn(claude -w ..., {cwd})` takes ONE cwd per worker — multiple areas would still need split invocations even though the script accepts per-issue cwd; the same-area assertion is documentation/safety, not a runtime constraint.
- **Owner filter bypass.** Listed issues do not need `owner:bot` (same as issue-mode list — the user named them explicitly). Only `--count` queue-pick mode applies the owner filter.

### Failure handling

Worker died (PID gone, issue still OPEN) → `gh.relabelHuman(N)` (remove `status:in-progress`+`owner:bot`, add `status:ready`+`owner:human`) + add to `failed`. Loop continues to siblings. Final notification surfaces failure list.

Worker closed cleanly → `cleanupWorker(name, cwd)` removes the worktree + branch left behind by the closed `claude -w` session.

## Workflow — `auto` mode

`/impl auto [-p N]` is a one-shot dispatcher to the ralph-loop wrapper. The skill prose owns nothing else — no pick, no claim, no commit, no log. All of that happens inside the inner `/impl` body each iteration.

### Invocation

When the user types `/impl auto` (no `-p`):

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(ls -d ~/.claude/plugins/cache/brain-os-marketplace/brain-os/*/ 2>/dev/null | sort -V | tail -1)}"
PLUGIN_ROOT="${PLUGIN_ROOT%/}"
[ -f "$PLUGIN_ROOT/scripts/run-ralph.sh" ] || { echo "FATAL: run-ralph.sh not found (PLUGIN_ROOT=$PLUGIN_ROOT)"; exit 1; }
bash "$PLUGIN_ROOT/scripts/run-ralph.sh" "/impl" \
  --completion-promise NO_MORE_ISSUES \
  --max-iterations 50
```

When the user types `/impl auto -p 3` (or any `-p N`, `1 ≤ N ≤ 5`):

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(ls -d ~/.claude/plugins/cache/brain-os-marketplace/brain-os/*/ 2>/dev/null | sort -V | tail -1)}"
PLUGIN_ROOT="${PLUGIN_ROOT%/}"
[ -f "$PLUGIN_ROOT/scripts/run-ralph.sh" ] || { echo "FATAL: run-ralph.sh not found (PLUGIN_ROOT=$PLUGIN_ROOT)"; exit 1; }
bash "$PLUGIN_ROOT/scripts/run-ralph.sh" "/impl -p 3" \
  --completion-promise NO_MORE_ISSUES \
  --max-iterations 50
```

The args are hardcoded by design — `/impl auto` is the no-knobs entry point. Use the manual `/ralph-loop "/impl" --completion-promise ... --max-iterations ...` form when you need different limits or a non-`/impl` body (see § Recommended invocation patterns → Custom-tuned drain).

**Comma-list args are rejected in auto mode.** `auto` semantically means "drain the queue until empty"; a fixed list has no queue and no `<promise>NO_MORE_ISSUES</promise>` condition. If the user types `/impl auto 164,165` or `/impl auto -p 164,165`, abort with `FATAL: /impl auto does not accept issue lists. Use /impl 164,165 (sequential) or /impl -p 164,165 (parallel) instead.` and exit 1.

### What the wrapper does

`scripts/run-ralph.sh` resolves the installed `ralph-loop` plugin path dynamically (no version pin) and execs `setup-ralph-loop.sh` with the forwarded args. `setup-ralph-loop.sh` writes the in-session state file `.claude/ralph-loop.local.md` (with frontmatter: `active: true`, `iteration: 1`, `max_iterations: 50`, `completion_promise: "NO_MORE_ISSUES"`) and echoes the initial `/impl` prompt. Claude reads the prompt and runs `/impl` once. When Claude tries to stop, the ralph Stop hook intercepts:

- If transcript contains `<promise>NO_MORE_ISSUES</promise>` (inner tag exact-match against `--completion-promise`) → let stop succeed, queue drained.
- Else if `iteration >= max_iterations` → let stop succeed, safety cap reached.
- Else → re-feed the prompt (`/impl` or `/impl -p N`) → next iteration.

### Composability with `-p N`

`/impl auto -p N` forwards `-p N` into the *inner* `/impl` invocation, NOT into the ralph-loop wrapper. Each iteration runs `/impl -p N`, which dispatches `scripts/run-parallel.ts` to spawn N detached `claude -w` workers via `Bun.spawn` with explicit per-issue cwd from `inferRepoFromIssueArea(labels, areaMap)` — NOT Agent-tool subagents (subject to the `1 ≤ N ≤ 5` parallel cap, `HARD_CAP=5` enforced by `clampParallel`). The ralph wrapper sees a single composite prompt — `"/impl -p 3"` is one prompt to ralph, even though it fans out N workers inside.

### Token cost

Per iteration burns inference in the current Claude session for the *outer* /impl invocation that calls run-parallel.ts (NOT detached at the auto-mode layer — the auto-mode loop runs in the same Claude session and re-feeds via the ralph Stop hook). The *inner* run-parallel.ts dispatch IS detached via `nohup`, so each iteration's worker burn happens off-session like `/impl story`. Budget accordingly: a 50-iteration drain with `-p 3` runs up to 50 outer iterations × 3 workers = 150 inner /impl invocations in the worst case before the safety cap triggers. The `<promise>NO_MORE_ISSUES</promise>` sentinel is what brings it home early.

### Outcome log

`auto` is dispatch-only — it does not write its own outcome log row. Each inner `/impl` iteration writes a `once` or `parallel` row as normal. Do NOT add an `action=auto` row to `{vault}/daily/skill-outcomes/impl.log`; that would double-count.

### Empty backlog handshake

The sentinel is `<promise>NO_MORE_ISSUES</promise>` in the assistant text response — see § Defaults → Empty backlog sentinel for the contract. `Bash(echo)` does NOT satisfy it; ralph reads transcript text blocks (`type: text`), not unix stdout. The auto mode inherits this contract from the inner `/impl` it loops.

## How spawned workers behave

Workers spawned by `/impl story` (`scripts/run-story.ts`) and `/impl -p` (`scripts/run-parallel.ts`) are full `claude -w "<name>" --dangerously-skip-permissions -p "/impl <N>"` sessions — not Agent-tool subagents. Each worker reads `skills/impl/SKILL.md` fresh on startup and runs the `issue` mode workflow end-to-end (claim → read → /tdd → commit → push → close), which already encodes:

- Full issue body fetched via `gh issue view <N>`.
- `/tdd` invocation per artifact-type table at `~/work/brain-os-plugin/skills/tdd/SKILL.md`.
- Conventional Commits subject + body + `Closes <tracker-repo>#<N>` + Co-Authored-By line.
- `IMPL_AFK=1` prefix on the commit invocation so the trunk-block hook gates AFK trunk-touches against `references/trunk-paths.txt`.
- Re-label-and-exit response on trunk-block hook fire (owner flip FIRST so a mid-sequence failure never leaves the issue `owner:bot + status:ready`):

  ```bash
  gh issue edit <N> -R <tracker-repo> --remove-label owner:bot --add-label owner:human
  bash "$CLAUDE_PLUGIN_ROOT/scripts/gh-tasks/transition-status.sh" <N> --to ready
  exit 0
  ```

- Worker exit protocol: print `#<N> done` (or `#<N> FAILED: <reason>`) on a line by itself so external watchers can latch.

The worker's cwd is set explicitly by the parent orchestrator via `Bun.spawn(claude -w ..., { cwd })`, derived from the issue's `area:*` label (`inferRepoFromIssueArea(labels, areaMap)`). Workers do NOT need their own trunk-paths self-check — the parent script already places them in the correct repo, the PreToolUse(Bash) trunk-block hook fires from the correct cwd, and the canonical `IMPL_AFK=1` prefix gate in `issue` mode handles trunk-block reactions.

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

- **`Closes <tracker-repo>#N` not `Closes #N`.** Cross-repo close-on-merge requires the explicit repo prefix because the commit lands in the code repo (e.g. brain-os-plugin) but the issue lives in the tracker repo. `bash "$CLAUDE_PLUGIN_ROOT/scripts/gh-tasks/close-issue.sh" <N>` is still required as a belt-and-braces step because cross-repo `Closes` doesn't always auto-fire — and the helper additionally strips ghost `status:*` labels that bare `gh issue close` leaves behind.
- **`git pull --rebase` is mandatory before push.** CI auto-release pipelines bump `plugin.json` on every push. Skipping the rebase guarantees a non-fast-forward push failure.
- **`IMPL_AFK=1` on the commit invocation is required.** It signals to the trunk-block hook (`hooks/pre-commit-trunk-block.sh`) that this is autonomous AFK work. The hook reads the trunk-paths list (`references/trunk-paths.txt`) and exits 2 if any staged file matches — blocks the commit. Without the prefix, the hook is a no-op (interactive direct-push-to-main is unchanged). Source: [grill 2026-04-26](https://github.com/sonthanh/ai-brain/blob/main/daily/grill-sessions/2026-04-26-depth-leaf-trunk-design.md). DO NOT bypass with `--no-verify` or strip the prefix to "make it work" — the right response to a block is to flip owner first (`gh issue edit <N> -R <tracker-repo> --remove-label owner:bot --add-label owner:human`) then status (`bash "$CLAUDE_PLUGIN_ROOT/scripts/gh-tasks/transition-status.sh" <N> --to ready`), then exit. Owner-first ordering matters: a mid-sequence failure leaves the issue `owner:human + status:in-progress` (visible to the user, ignored by `/impl auto`'s `owner:bot + status:ready` pick filter) instead of `owner:bot + status:ready` (which `/impl auto` would re-pick and loop on the same trunk-block). The user resolves interactively.
- **Empty backlog sentinel must be wrapped in `<promise>` tags** — emit exactly `<promise>NO_MORE_ISSUES</promise>` in the assistant text response. The ralph-loop Stop hook (`stop-hook.sh:130-141`) extracts the inner text via Perl regex and exact-matches against `--completion-promise "NO_MORE_ISSUES"`. Bare `NO_MORE_ISSUES` without tags only matches when the entire response is *literally that string and nothing else* — adding any surrounding prose (which Claude almost always does) breaks the match. Stdout / `Bash(echo)` is also wrong: ralph reads transcript text blocks (`type: text`), not stdout.
- **`--team` is DEFERRED.** If a user passes `--team`, print "team mode is deferred to Phase G — see grill 2026-04-25" and exit 1. Don't fall back to `-p` silently — the user explicitly asked for the unimplemented mode.
- **/tdd owns the test loop. /impl owns the issue plumbing.** Do not duplicate /tdd's red-green logic here. If /tdd's discipline isn't holding (reactive `improve: encoded feedback —` patches keep landing), fix /tdd, not /impl.

## Outcome log

Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/impl.log`:

```
{date} | impl | {action} | ~/work/brain-os-plugin | {issue-or-batch-ref} | commit:{hash} | {result}
```

- `action`: `once` (single issue), `parallel` (one of N issues from a parallel run, including parallel list `-p <list>`), or `drain` (the orchestrator's wrap-up after a parallel batch — output_path = batch label, e.g. `parallel-N3`). Sequential list (`/impl <N>,<M>,...`) writes one `once` row per issue with `mode=list-sequential` in the optional fields. NOTE: `auto` is NOT a valid action — `/impl auto` is dispatch-only; its inner iterations write `once` or `parallel` rows as normal.
- `issue-or-batch-ref`: `<tracker-repo>#N` for `once`/`parallel`; the batch label for `drain`
- `result`: `pass` if the issue closed AND no reactive `improve: encoded feedback —` commit lands against the touched artifacts within 48h; `partial` if user manually corrected before close; `fail` if cycle aborted or reactive patch needed
- Optional: `mode=parallel` (or `mode=list-sequential` for the sequential list form), `n=N` (parallel size, or list-length post-dedupe-and-clamp), `area=<label>`, `tdd_cycles=K` (red-green count from /tdd)

### Sample rows

```
2026-04-27 | impl | once | ~/work/brain-os-plugin | ai-brain#147 | commit:abc1234 | pass
2026-04-27 | impl | parallel | ~/work/brain-os-plugin | ai-brain#148 | commit:def5678 | pass | mode=parallel,n=3
2026-04-27 | impl | once | ~/work/brain-os-plugin | ai-brain#164 | commit:9abcdef | pass | mode=list-sequential,n=2
2026-04-27 | impl | once | ~/work/brain-os-plugin | ai-brain#165 | commit:1234abc | pass | mode=list-sequential,n=2
2026-04-27 | impl | parallel | ~/work/brain-os-plugin | ai-brain#164 | commit:9abcdef | pass | mode=parallel,n=2
2026-04-27 | impl | parallel | ~/work/brain-os-plugin | ai-brain#165 | commit:1234abc | pass | mode=parallel,n=2
```

If `result != pass`, auto-invoke `/brain-os:improve impl` per the skill-spec § 11 auto-improve rule. The eval gate inside /improve reverts any change that drops pass rate, so auto-apply is safe.
