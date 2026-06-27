---
name: afk
description: "Turn a goal, task, or existing issue into autonomous work — grill when fuzzy, file/relabel AFK issues, health-check the loop spine, hand off to the schedulers. Add --auto to drive the whole goal→proof loop in one run and return a proof report (delegates to /autodev) instead of queuing-and-handing-off. Triggers: '/afk <goal|task|N>', '/afk --auto <goal>', 'make this AFK', 'finish this while I'm away'. Execute NOW instead → /impl N or cox N."
---

# /afk — Goal/task → autonomous-loop entry point

One command from "here's what I want" to "the machine finishes it while you're away." This skill is thin glue: it owns NO clarifying, slicing, or implementing logic — it routes between the skills that do, then verifies the autonomous spine is alive before promising autonomy.

The spine it hands off to (what runs after you walk away):

| Stage | Owner | Cadence |
|-------|-------|---------|
| Dispatch | `pickup-auto` launchd job → claims `status:ready` + `owner:bot` issues → spawns `/impl` workers | every 2h |
| Recovery | "Story doctor (loop closer)" Orca automation — finds `AFK gave up` dead-ends, runs `/debug`, files fix issues, re-queues | 3×/day |
| Learning | `/impl` auto-invokes `/improve` on `result != pass` + "Improve skills (daily)" Orca automation | per-failure + nightly |

The spine runs under the **autonomous-run contract** (`working-rules.md §5`): every worker grounds progress claims against real tool results, never stalls a turn on a promise/question (does the work now), and ignores context-budget anxiety. Promising autonomy means promising §5 behavior — if the spine can't carry it, don't promise the loop.

## Input triage

Classify the argument FIRST — the three modes share the spine check and report but differ in how work reaches the queue:

| Input shape | Mode | Path |
|-------------|------|------|
| Issue number (`/afk 123`, `/afk #123`) | **issue** | relabel for AFK → spine check → handoff |
| Clear task — single deliverable, no open design decisions, a verifiable done-check, known repo | **task** | file one issue → spine check → handoff |
| Fuzzy goal, multi-decision, architectural, or you're unsure | **goal** | `/grill` → `/slice` → spine check → handoff |

Default to **goal mode** whenever classification is uncertain. A wrongly-skipped grill ships the wrong thing autonomously; a wrongly-run grill costs a few questions. Never silently guess task-shaped.

**`--auto` flag — drive-to-proof instead of queue-and-handoff.** When the argument carries `--auto` (e.g. `/afk --auto <goal>`), do NOT run the interactive grill→slice→handoff path. Delegate the entire run to **`/autodev`** (the autonomous sibling): auto-grill the goal → escalate ungrounded gaps as HITL → slice → impl+evaluate → **proof report**. `/autodev` drives the work to completion in one detached Workflow run and ends with per-AC proof; `/afk` without `--auto` only queues and hands off to the schedulers. `--auto` is an explicit opt-in: the default goal mode below stays interactive. See § Goal mode `--auto`.

## Workflow

### Goal mode `--auto` (autonomous — delegates to /autodev)

This is the only afk path that drives work to completion and returns a proof report rather than queuing. It does NOT run here — it hands off wholesale:

1. Resolve `CLAUDE_PLUGIN_ROOT` and the goal text (strip the `--auto` token).
2. Invoke the **`autodev`** Skill with the goal as its argument (pass `--dry-run` through if the user added it). `/autodev` owns the whole loop: auto-grill (decompose → self-answer → verify-grounding) → escalate-not-break seam (ungrounded gaps → HITL issues, never guessed) → slice → impl+evaluate (TDD + evaluator regenerate, K=3) → proof report.
3. Do NOT also run the interactive grill, `/slice`, or the spine check — `/autodev` is a synchronous drive-to-done, not a queue handoff, so the scheduler-spine check (which exists because *queued* issues sit forever on a dead spine) does not apply.
4. Surface `/autodev`'s returned proof verdict (`PROVEN`/`PARTIAL`/`UNPROVEN`) + report path to the user. Honest partial-autonomy reporting still applies: escalated children and unverified ACs are stated, never hidden.

Why a separate flag instead of making goal mode auto by default: the default goal mode's interactive grill is the human-judgment head of the loop. Swapping it for auto-grill is an explicit, deliberate choice (the user trusts the vault has enough grounding) — not a silent shortcut. `--auto` makes that choice visible; the default below stays interactive.

### Goal mode

#### 1. Clarify (interactive — stays interactive)

Route by topic shape:

- Architecture / system design with ≥3 open decisions → `/grill-fast`
- Everything else → `/grill`

The grill is the human-judgment head of the loop — do not shortcut it. Proceed to step 2 only when the session is settled (`status: pass|settled`) and has ≥1 acceptance bullet with the `(LIVE E2E)` marker (that's `/slice`'s hard gate — failing it later just wastes a step). If the grill ends `reflection` or `working`, stop and report: no autonomy possible yet, the goal isn't clarified.

#### 2. Slice

Invoke `/slice` on the settled grill session → parent story + tracer-bullet child issues on the tracker. Do not duplicate or pre-check `/slice`'s gates (e2e AC existence, AC coverage, rung-0) — it enforces them itself and aborts loudly when they fail.

### Task mode (clear task, no issue yet)

Skip grill and slice — but NOT issue hygiene. Draft the issue, show it, file it:

1. Draft: title, Problem (1-2 sentences), `## Acceptance` (verifiable observables — if you can't write a concrete done-check, the task wasn't task-shaped; fall back to goal mode), `## Files`, `Observable:` line.
2. **Depth gate:** if any declared file matches a trunk path (CLAUDE.md, RESOLVER.md, working-rules.md, hooks/, references/, skill-spec.md, plugin.json) → the issue is `owner:human`; tell the user the machine won't take it and it routes through `/pickup`.
3. Show the draft once for confirmation (one turn — this replaces the grill, don't skip it), then file via the central filer (it owns label assembly — never inline `gh issue create`):

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/gh-tasks/create-task-issue.sh" \
  --title "..." --body "..." --area <area> --owner bot \
  --priority p2 --weight <quick|heavy> --status ready
```

### Issue mode (existing issue number)

The differentiator vs `/impl <N>`: `/impl N` executes the issue NOW in this session; `/afk N` queues it for the schedulers and walks away.

1. `gh issue view <N>` — read body + labels fresh.
2. Mid-flow HITL content (handover, unsettled grill, mid-draft writing) stays `owner:human` — refuse to relabel, point at `/pickup <N>`.
3. Otherwise confirm with the user, then flip to `owner:bot` + `status:ready` (apply the same trunk-path depth gate as task mode before flipping).
4. If the body lacks `## Acceptance`, add one (confirmed with the user) — an AFK worker without a done-check just guesses.

### All modes converge here

#### 3. Spine health-check (deterministic, read-only)

The whole point of `/afk` over a bare `/slice` is this check — filed issues sit forever if the schedulers are dead:

```bash
launchctl list | grep -q pickup-auto          # dispatcher loaded?
orca status >/dev/null 2>&1                   # Orca runtime reachable?
orca automations list                         # "Story doctor" + "Improve skills" present + enabled?
```

All green → proceed to step 4. Any check red → still keep the filed issues (they wait safely in the queue), but report exactly which spine component is down and how to revive it:

- dispatcher down → `launchctl load ~/Library/LaunchAgents/<pickup-auto plist>`
- Orca runtime down → `orca open` (automations don't fire without it)
- automation disabled → `orca automations edit <id> --enabled`

Log `partial` in that case — never claim autonomy on a dead spine.

#### 4. Report: autonomy engaged

End with a compact handoff report:

- Goal mode: N children filed, X AFK (`owner:bot`) / Y HITL (`owner:human`) — list the HITL ones explicitly; the machine will NOT touch them, they wait for `/pickup`. Include the rung-0 child number.
- Task/issue mode: the one issue number queued, its labels.
- First expected dispatch tick (≤2h from now)
- Where to watch: the parent/queued issue, `~/.local/state/impl-story/<parent>.status`, or `/status`

Be honest about partial autonomy: if most children are HITL, say so — "autonomy engaged" on a 90%-human story is a lie.

## Rules

- **Never spawn workers yourself.** `pickup-auto` is the single dispatcher; a second dispatch path causes claim/label races. If the user wants one issue done NOW and visibly, point them at `cox <N>` or `/impl <N>` instead.
- **Delegate, don't reimplement.** Grill owns clarification, slice owns issue hygiene, the schedulers own execution. This skill adds routing + the spine check + the report, nothing else.
- **HITL stays HITL.** Don't relabel `owner:human` children to inflate the autonomy number.
- **Triage errs toward grill.** Task mode is an earned shortcut, not the default — a task without a writable done-check goes back through goal mode.
- **One filer.** Task mode files through `create-task-issue.sh` only — it validates the label canon; inline `gh issue create` re-introduces label drift.

## Outcome log

Append one line to `{vault}/daily/skill-outcomes/afk.log` (per `skill-spec.md § 11`):

```
{date} | afk | {action} | ~/work/brain-os-plugin | {output} | commit:N/A | {result} | parent=ai-brain#{P} children={N} args="{input}"
```

- `action`: `engage` (goal mode), `task` (task mode), `issue` (issue mode)
- `output`: goal mode → `daily/grill-sessions/{session-file}`; task/issue mode → `ai-brain#{N}`
- `pass` — work queued (settled+sliced / filed / relabeled) and all three spine checks green
- `partial` — work queued but spine degraded, or majority-HITL children, or trunk-gated to `owner:human`
- `fail` — grill didn't settle, `/slice` aborted on its gates, or task draft rejected
