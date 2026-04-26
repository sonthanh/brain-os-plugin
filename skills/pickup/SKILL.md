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

When the user passes a bare integer (e.g. `/pickup 100`, `cr /pickup 100`), treat it as "claim this issue and start." Do NOT run the interactive Ready-list flow.

1. **Claim atomically** via the canonical helper (single source of truth):
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/pickup-claim.sh" N
   ```
   Exit-code semantics:
   - `0` → flip happened (status:ready → status:in-progress); proceed.
   - `3` → already status:in-progress (no-op); for `/pickup <N>` continue anyway since user explicitly chose this issue.
   - `1` → not claimable (closed, blocked, backlog); abort with the helper's stderr message.
   - `2` → gh API / config error; surface and abort.

2. **Fetch full body** for context (the helper only inspects labels):
   ```bash
   gh issue view N -R $GH_TASK_REPO --json title,body,labels
   ```

3. **Load context**:
   - Labels include `type:handover` → extract the relative `[handover](daily/handovers/…)` link from the body, read that file, follow the "Handover Task Behavior" section.
   - Otherwise → treat the issue body as the spec; read any linked grill / plan docs referenced in the body.

4. **Start executing immediately.** Never re-grill locked decisions.

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

5. **Claim and start top remaining task** — for the chosen issue N:
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/pickup-claim.sh" N
   ```
   On exit `0` → begin work. On exit `3` (already in-progress) → skip to next candidate. On exit `1` or `2` → surface error to user.

## Claim protocol

Single source of truth: **`${CLAUDE_PLUGIN_ROOT}/scripts/pickup-claim.sh <N>`**. All four entry points (`/pickup`, `/pickup <N>`, `/pickup auto`, plus the interactive Ready-list flow) call this helper for the atomic flip. Do NOT re-implement the flip in skill prose — the recurring bug is LLMs skipping the flip when described step-by-step (worker spawned, label still `status:ready`, /status mis-classifies). The script is deterministic and untouched by judgment.

What the script does:
1. Resolves `$GH_TASK_REPO` from `hooks/resolve-vault.sh`.
2. Fetches issue state + status label (one `gh issue view` call).
3. If `status:in-progress` → no-op (exit 3).
4. If `status:ready` (or no status:* label) → atomic flip to `status:in-progress` via one `gh issue edit --remove-label status:ready --add-label status:in-progress` call (exit 0).
5. If `status:blocked` / `status:backlog` / unknown → abort (exit 1).
6. On gh / config error → exit 2.

The flip is atomic by GH semantics — no ephemeral `claim:session-*` labels. They were overengineering for a single-user repo and caused "label not found" errors because `gh issue edit --add-label` won't auto-create.

Race note: two sessions reading `status:ready` simultaneously and transitioning in the same second will both succeed (GitHub has no label CAS). In practice — solo user, a handful of sessions — this is rare and benign: duplicate work at worst, and the handover / issue body converges the outputs. The TOCTOU window is the helper itself (1-3 ms between view + edit) — much smaller than orchestrator-prose timing.

**On completion** — close the issue:
```bash
gh issue close N -R $GH_TASK_REPO --reason completed
```

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

Run the canonical bash impl:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/pickup-auto.sh" [--force] [--dry-run]
```

The script handles the full flow end-to-end as a single deterministic process — query Ready+bot eligible issues → time-aware weight filter → atomic claim per issue (via `pickup-claim.sh`) → spawn `claude -w "auto-issue-N"` background workers with the issue body as prompt → log to `~/.local/state/pickup-auto/cron.log`.

Flags:
- `--force` — bypass time-aware weight filter (allow `weight:heavy` during work hours).
- `--dry-run` — query + filter only, no claim/spawn.

**Empty-eligibility behavior:** if zero eligible tasks remain after the time-aware filter (Ready column empty, only `owner:human` issues, or all already in-progress), the script must log `pass | score=0/0` and exit cleanly — no claim, no spawn, no error. After invocation, the LLM should report "no tasks to drain" to the user.

**Why a script, not skill prose:** the previous flow walked the LLM through query → claim → spawn as separate steps. The LLM was skipping the claim step and spawning workers on `status:ready` issues, leaving labels stale and breaking `/status`. The script eliminates skip-step risk by construction. Do NOT re-implement the flow as skill prose.

#### Time-aware weight filtering (handled by the script)
- **Work hours (09:00–22:00)** → only `weight:quick` (skip `weight:heavy`).
- **Off-hours (22:00–09:00)** → any weight.
- **`--force`** → bypass entirely.

#### Weight labels
- `weight:quick` (⚡) — quick task (< 30 min), safe to run anytime.
- `weight:heavy` (🏋️) — heavy task (1h+), only run off-hours unless `--force`.

#### Spawn protocol (already encoded in `pickup-auto.sh`)
Each spawned worker runs `claude -w "auto-issue-N" --model opus --dangerously-skip-permissions -p "<prompt>"` in the background. Prompt includes full issue body + Ralph Loop guidance. Exit protocol (non-negotiable): `commit → push → gh issue close N --reason completed → exit`. The prompt explicitly forbids invoking `/pickup`, `/status`, or any other skill after finishing — exit cleanly.

#### Dependency DAG (manual orchestration, rare)
The script does **not** build a dependency DAG — it spawns all eligible issues in parallel. For multi-issue launches with explicit dependencies (`depends on #N` in body, sequential `Phase X.Y` references in plan docs), the user must orchestrate manually:
1. Run `pickup-auto.sh --dry-run` to see eligible issues.
2. Build DAG by reading bodies + plan docs.
3. For each root-node issue: `bash pickup-claim.sh N` then spawn worker manually.
4. After root completes (closed on origin/main), repeat for next layer.

This is a latent step — keep it out of the auto path. Most launches don't need it.

#### Auto mode rules
- **Fire-and-forget** — script reports immediately, user continues working.
- **Worktree isolation** — each task runs via `claude -w` to avoid conflicts.
- **Self-completing** — worker executes → commits → pushes → closes issue.
- **Respect skill flows** — if a task maps to a skill, the worker invokes that skill.
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

### Owner label hygiene (what belongs on owner:bot vs owner:human)

`owner:bot` means `/pickup auto` will claim it. `owner:human` means a person must grill + design before execution. Getting this wrong creates false "work in progress" signals — `owner:bot` auto-promotes tasks that actually need judgment, they stagnate in In Progress with no work happening.

**Categories that ALWAYS need `owner:human` (👤):**
- Seed pages (people, companies, meetings) — needs judgment about who counts, role mapping, relationship type
- Context gap fills (`strategy.md`, `goals.md`, `business.md`) — needs strategic input from user
- Replicate spec across N skills (outcome log markers, trace patterns) — each skill needs per-skill review of where to insert
- Airtable / external sync design — needs decisions about schema mapping, conflict handling, sync direction
- Cron schedule design for new automations — needs safety review + frequency tradeoffs
- **Skill creation or modification** — skills are design-heavy (behavior, edge cases, integration). Always start with `/grill` to align on requirements before writing any code. After /grill aligns on requirements, route the actual creation/eval work through `/skill-creator` — the gold standard for skill creation AND behavioral-eval generation (variance analysis, triggering accuracy, with-skill-vs-baseline subagent runs). Don't hand-edit `evals.json` as a shortcut for behavioral-eval upgrade; coverage-parity additions matching the existing pattern (1-2 cases mirroring new SKILL.md content, e.g. when `/improve` auto-edits a skill) are fine. `/skill-creator` and `/improve` are complementary: `/improve` is the auto-tuning loop on outcome-log signal; `/skill-creator` is the manual, interactive flow for creation and behavioral-eval generation. Auto-executing a "build skill" task without grilling produces work that doesn't match the user's intent.

**Default:** When creating new tasks, default to `owner:human` unless the task is a pure mechanical transform (file rewrite per spec, code refactor with clear before/after, format conversion).

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
