---
name: pickup
description: "Use when starting a new session and wanting to resume unfinished work from a previous handover"
---

# Pickup — Resume Work

## Config

**Vault path + GitHub task repo:** read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md` (or user-local `~/.brain-os/brain-os.config.md` which takes precedence). Keys: `vault_path:`, `gh_task_repo:`. In shell/hook contexts, `source hooks/resolve-vault.sh` and use `$VAULT_PATH` / `$GH_TASK_REPO`. In skill prose, substitute `$GH_TASK_REPO` below with the configured value.

## Invocation modes

- **`/pickup`** — no args: interactive flow over Ready list (handovers first, then top task)
- **`/pickup <N>`** — direct claim of issue #N, skipping Ready-list filtering entirely
- **`/pickup auto [--all] [--force]`** — background spawner (see dedicated section)

## `/pickup <N>` — Direct claim of a specific issue

When the user passes a bare integer (e.g. `/pickup 100`, `cyrc /pickup 100`), treat it as "claim this issue and start." Do NOT run the interactive Ready-list flow.

1. **Fetch the issue**:
   ```bash
   gh issue view N -R $GH_TASK_REPO --json number,title,state,labels,body
   ```
2. **Validate**:
   - Closed → abort with "Issue #N is already closed." Do not reopen.
   - No `status:*` label → treat as unclaimed; proceed.
3. **Claim** via the single protocol below (no-op if already `status:in-progress` — user explicitly requested this issue, so continue either way).
4. **Load context**:
   - Labels include `type:handover` → extract the relative `[handover](daily/handovers/…)` link from the body, read that file, follow the "Handover Task Behavior" section.
   - Otherwise → treat the issue body as the spec; read any linked grill / plan docs referenced in the body.
5. **Start executing immediately.** Never re-grill locked decisions.

## `/pickup` — Interactive flow (no args)

1. **Query open Ready tasks** from GitHub:
   ```bash
   gh issue list -R $GH_TASK_REPO --state open --label status:ready --json number,title,labels,body
   ```
   Labels carry all metadata (priority, weight, owner, type) — do not parse title for markers.

2. **Handovers first:** filter the Ready list to issues carrying `type:handover`. Do NOT infer handovers from title prefixes or body wiki-links — the label IS the signal.
   - Found → claim → load linked handover doc → start
   - Multiple → show list, ask user which one
   - None → continue to step 3

3. **Ready tasks remaining?**
   - **Yes** → skip to step 4 (no groom needed)
   - **No** → groom Backlog: query `gh issue list -R $GH_TASK_REPO --state open --label status:backlog --json number,title,body`, promote unblocked + clear items to Ready (`gh issue edit N -R $GH_TASK_REPO --remove-label status:backlog --add-label status:ready`); ask user about vague ones

4. **Autogrill Ready tasks** (see Autogrill section below) — skip `type:handover` issues (they already have a spec doc)

5. **Start top remaining task** — claim first Ready task → begin

## Claim protocol

The claim IS the `status:in-progress` label. No ephemeral `claim:session-*` labels — they were overengineering for a single-user repo and caused "label not found" errors because `gh issue edit --add-label` won't auto-create.

1. **Check current status** (skip if already in-progress and we've been asked explicitly for this issue):
   ```bash
   current=$(gh issue view N -R $GH_TASK_REPO --json labels --jq '[.labels[].name | select(startswith("status:"))] | .[0]')
   ```
   - `status:ready` → proceed to transition
   - `status:in-progress` → already claimed; in `/pickup <N>` continue anyway (user chose), in interactive `/pickup` skip to the next candidate
   - `status:blocked` or closed → abort, surface to user

2. **Atomic transition** (one `gh` call, both labels flipped in a single request):
   ```bash
   gh issue edit N -R $GH_TASK_REPO --remove-label status:ready --add-label status:in-progress
   ```

3. **On completion** — close the issue:
   ```bash
   gh issue close N -R $GH_TASK_REPO --reason completed
   ```

Race note: two sessions reading `status:ready` simultaneously and transitioning in the same second will both succeed (GitHub has no label CAS). In practice — solo user, a handful of sessions — this is rare and benign: duplicate work at worst, and the handover / issue body converges the outputs. Do not bring back `claim:session-*` labels as "safety"; they don't solve the race (still TOCTOU between create-label and add-label) and they pollute the label namespace.

## Step 2: Autogrill Ready Tasks

For each non-`type:handover` Ready task, run vault-first Q&A:

1. **Generate grill questions** — the same questions you'd ask a human:
   - What's the goal?
   - What context exists?
   - What are the constraints/requirements?
   - What's the expected output?
   - Task-specific questions based on the domain
   - Aim for 5-10 questions per task

2. **Search vault for each answer** — grep, read wiki-links, follow references

3. **Log the Q&A** to `{vault}/daily/grill-sessions/YYYY-MM-DD-autogrill.md`:
   ```markdown
   ## HH:MM — <task name> (#N)

   ### Q&A

   | # | Question | Answer | Source |
   |---|----------|--------|--------|
   | 1 | What is X? | Found: ... | [[path/to/source]] |
   | 2 | How does Y? | ❌ NOT FOUND | — |

   ### Gaps (needs human)
   - Q2: How does Y?

   ### Decision
   - N/M answered → auto-close / escalate

   ### Artifacts
   - Files created/modified
   ```

4. **Decide per task:**
   - **≥80% questions answered** → auto-close: produce the artifact, `gh issue close N --reason completed`, log process
   - **<80% answered** → escalate: surface specific unanswered questions for human grill

5. **Run tasks in parallel** — launch multiple agents for independent tasks

6. **Present results:**
   ```
   Autogrill complete:
   ✅ #12 [Task A] — auto-closed (7/8 questions answered)
   ❓ #15 [Task B] — needs you on 4 questions:
      - Q3: What pricing model?
      - Q5: What's the timeline?
      - Q7: Who is the target?
      - Q8: What channels?
   ```

### After human answers gaps:

When the user grills on the remaining questions:
1. **Write answers back to vault** — update the relevant context/strategy/goals files
2. **Re-run autogrill** on the task — should now auto-close with full answers
3. The vault gets smarter every cycle

## `/pickup auto` — Launch tasks in background

1. **Find eligible tasks** — query GH for Ready + bot-eligible issues:
   ```bash
   gh issue list -R $GH_TASK_REPO --state open \
     --label status:ready --label owner:bot \
     --json number,title,labels,body
   ```
   The `owner:bot` filter replaces the `👤` exclusion — `owner:human` tasks (which need a human grill) are not returned. Any issue already at `status:in-progress` is automatically excluded by the `status:ready` filter.

   Then apply time-aware weight filtering on the remaining list:
   - **Work hours (09:00–22:00)**: only pick issues with `weight:quick`. Skip `weight:heavy`.
   - **Off-hours (22:00–09:00) or weekends**: pick any task including `weight:heavy`.
   - **`--force` flag**: skip time-aware filtering entirely — pick any eligible Ready issue regardless of weight or hour. Used by the pickup-auto cron.
   - **Zero eligible tasks found** → log `pass | score=0/0` and exit. Do NOT continue to steps 2–5.

2. **Claim each eligible task** via the Claim protocol (atomic `status:ready → status:in-progress` flip). If the flip fails because the issue was already `status:in-progress` when re-checked, drop it from the batch and continue.

3. **Build dependency DAG** before launching anything:
   - **Step 1 — Scan issue bodies:** for each claimed issue, parse body for `depends on #N` (GH auto-links this) and free-text `depends on X`/`Depends on P1 Y` patterns
   - **Step 2 — Read plan docs:** for issues referencing plan docs (e.g., `vault-redesign-plan`), read the plan and extract Phase numbering (`Phase 1.1`, `1.2`, etc.) — sequential phases within the same plan = sequential tasks
   - **Step 3 — Build DAG:** nodes = issues, edges = dependency relationships from Steps 1-2
   - **Step 4 — Launch root nodes:** only issues with no incoming edges launch in parallel
   - **Step 5 — Queue dependents:** a dependent issue launches only after its prereq issue is closed on `origin/main`
   - **Default:** if dependency parsing is ambiguous, serialize (cheap insurance vs 90 min cleanup)

4. **Launch as background Claude process in worktree**:
   ```bash
   claude -w "auto-{slug}" \
     --model opus \
     --dangerously-skip-permissions \
     -p "<prompt>" \
     > /tmp/auto-task-{slug}.log 2>&1 &
   ```
   The prompt MUST include the full issue body + autogrill Q&A log instructions + Ralph Loop + issue number for close-on-done.
   The prompt MUST end with: "DO NOT invoke /pickup, /status, or any other skill after finishing — exit cleanly."
   Exit protocol (non-negotiable): `commit → push → gh issue close N --reason completed → exit`. Watcher treats missing remote ref or still-open issue as failure.

5. **Report immediately** (don't wait for completion)

#### `/pickup auto --all` — Launch ALL eligible tasks respecting the dependency DAG

Same as above but for every eligible issue. Each gets its own worktree. DAG constraints still apply — only independent issues launch in parallel; dependents queue behind their prereqs.

#### Weight labels
- `weight:quick` (⚡) — quick task (< 30 min), safe to run anytime
- `weight:heavy` (🏋️) — heavy task (1h+), only run off-hours

#### Auto mode rules
- **Fire-and-forget** — launch in background, report immediately, user continues working.
- **Worktree isolation** — each task runs via `claude -w` to avoid conflicts.
- **Self-completing** — execute → log autogrill Q&A → `gh issue close N` → commit + push.
- **Respect skill flows** — if a task maps to a skill, invoke that skill.
- **Dependency-aware** — build DAG before parallelizing; serialize sequential phases of same plan.
- **Time-aware** — never run `weight:heavy` tasks during work hours unless `--force` is passed.
- **`--force` override** — `/pickup auto --force` bypasses time-aware filtering entirely. Used by the pickup-auto cron (see `~/.local/bin/pickup-auto-cron.sh`) so scheduled runs can pick `weight:heavy` during daytime.
- **No budget cap** — tasks run until complete. Ralph Loop ensures completion.

## Handover Task Behavior

### For each handover issue (`type:handover`) found:
1. **Extract handover doc path** from the issue body — look for a relative markdown link like `[handover](daily/handovers/YYYY-MM-DD-topic.md)` and read that file from the vault completely (all sections)
2. **Run "Commands to Verify State"** from the handover to confirm nothing changed
3. **Check for incomplete grills** — scan handover for "INCOMPLETE", "NOT completed", "grill session started but". If found:
   - Do NOT start executing tasks
   - Present the incomplete grill status
   - Resume the grill FIRST using `/grill <topic>` before any implementation
4. **Present brief summary**:
   ```
   Picking up: [topic] (#N)
   Status: [status]
   TL;DR: [from handover]

   Next steps:
   1. [step 1]
   2. [step 2]

   Starting with step 1.
   ```
5. **Start executing step 1** immediately (don't wait for confirmation unless blocked)

### After completing all steps:
1. **Close the issue**: `gh issue close N -R $GH_TASK_REPO --reason completed`
2. **Update handover status** in the vault doc: `status: completed`
3. **If new unfinished work emerged**: run `/handover` to create a new handover (which opens a new issue)

## Rules

### Do NOT re-ask settled decisions
The handover's "Decisions Made" section = requirements. Never re-grill.

### Always verify state first
Run the "Commands to Verify State" before starting. Files may have changed.

### Stale handover warning
If handover is > 7 days old:
```
⚠️ This handover is [N] days old. Verifying current state first...
```

### GitHub Issues are the task queue
- `/handover` opens an issue in `$GH_TASK_REPO` with `type:handover` + `status:ready` + handover doc link in body
- `/pickup` queries `$GH_TASK_REPO` for Ready issues, filters `type:handover` first
- State lives on the GH server (atomic labels) — no file merge conflicts across sessions
- The user just types `/pickup` and work resumes

### Always re-query at render time
Labels change across sessions. Never cache the Ready list within a long interactive session — re-query before claiming.

## Flow
```
Session A:
  /handover → creates handover doc + opens GH issue (status:ready, type:handover)

Session B (new Claude):
  /pickup → queries GH → filters type:handover → claims (status:ready → status:in-progress)
        → loads handover doc → starts working
  ... work done ...
  gh issue close N --reason completed

Session B with explicit issue:
  /pickup 100 → skip list, directly claim #100 → load body/handover → start

Background:
  /pickup auto → queries GH for status:ready + owner:bot
              → launches eligible in background (worktrees)
              → each self-closes its issue on success
```

## Outcome log

Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/pickup.log`:

```
{date} | pickup | {action} | ~/work/brain-os-plugin | N/A | commit:N/A | {result}
```

- `action`: `pickup` (interactive), `pickup:N` (direct claim of issue N), or `auto` (background launch)
- `result`: `pass` if issues started/completed, `partial` if some escalated to user, `fail` if unrecoverable error (e.g. `gh` auth failure or network)
- **No eligible tasks** (empty Ready column, only `owner:human` issues, or all already in-progress) → log `pass | score=0/0`, not `fail`
- Optional: `args="{issue-number}"`, `score={completed}/{launched}` (for auto mode)
