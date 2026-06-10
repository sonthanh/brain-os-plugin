---
name: afk
description: "Turn a goal into autonomous work — clarify via /grill, /slice into AFK issues, health-check the loop spine, hand off to the schedulers. Triggers: '/afk <goal>', 'make this AFK', 'finish this while I'm away', 'run this autonomously'. Single issue → /impl N; queue drain → /impl auto."
---

# /afk — Goal → autonomous-loop entry point

One command from fuzzy goal to "the machine finishes it while you're away." This skill is thin glue: it owns NO clarifying, slicing, or implementing logic — it routes between the skills that do, then verifies the autonomous spine is alive before promising autonomy.

The spine it hands off to (what runs after you walk away):

| Stage | Owner | Cadence |
|-------|-------|---------|
| Dispatch | `pickup-auto` launchd job → claims `status:ready` + `owner:bot` issues → spawns `/impl` workers | every 2h |
| Recovery | "Story doctor (loop closer)" Orca automation — finds `AFK gave up` dead-ends, runs `/debug`, files fix issues, re-queues | 3×/day |
| Learning | `/impl` auto-invokes `/improve` on `result != pass` + "Improve skills (daily)" Orca automation | per-failure + nightly |

## Workflow

### 1. Clarify (interactive — stays interactive)

Route by topic shape:

- Architecture / system design with ≥3 open decisions → `/grill-fast`
- Everything else → `/grill`

The grill is the human-judgment head of the loop — do not shortcut it. Proceed to step 2 only when the session is settled (`status: pass|settled`) and has ≥1 acceptance bullet with the `(LIVE E2E)` marker (that's `/slice`'s hard gate — failing it later just wastes a step). If the grill ends `reflection` or `working`, stop and report: no autonomy possible yet, the goal isn't clarified.

### 2. Slice

Invoke `/slice` on the settled grill session → parent story + tracer-bullet child issues on the tracker. Do not duplicate or pre-check `/slice`'s gates (e2e AC existence, AC coverage, rung-0) — it enforces them itself and aborts loudly when they fail.

### 3. Spine health-check (deterministic, read-only)

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

### 4. Report: autonomy engaged

End with a compact handoff report:

- N children filed: X AFK (`owner:bot`) / Y HITL (`owner:human`) — list the HITL ones explicitly; the machine will NOT touch them, they wait for `/pickup`
- Rung-0 child number + first expected dispatch tick (≤2h from now)
- Where to watch: the parent issue, `~/.local/state/impl-story/<parent>.status`, or `/status`

Be honest about partial autonomy: if most children are HITL, say so — "autonomy engaged" on a 90%-human story is a lie.

## Rules

- **Never spawn workers yourself.** `pickup-auto` is the single dispatcher; a second dispatch path causes claim/label races. If the user wants one issue done NOW and visibly, point them at `cox <N>` or `/impl <N>` instead.
- **Delegate, don't reimplement.** Grill owns clarification, slice owns issue hygiene, the schedulers own execution. This skill adds routing + the spine check + the report, nothing else.
- **HITL stays HITL.** Don't relabel `owner:human` children to inflate the autonomy number.

## Outcome log

Append one line to `{vault}/daily/skill-outcomes/afk.log` (per `skill-spec.md § 11`):

```
{date} | afk | engage | ~/work/brain-os-plugin | daily/grill-sessions/{session-file} | commit:N/A | {result} | parent=ai-brain#{P} children={N} args="{goal}"
```

- `pass` — grill settled, sliced, all three spine checks green
- `partial` — sliced but spine degraded, or majority-HITL children
- `fail` — grill didn't settle or `/slice` aborted on its gates
