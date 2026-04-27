---
name: pickup
description: "Use when starting a new session and wanting to resume unfinished work from a previous handover"
---

# Pickup — Resume Work

## Config

**Vault path + GitHub task repo:** read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md` (or user-local `~/.brain-os/brain-os.config.md` which takes precedence). Keys: `vault_path:`, `gh_task_repo:`. In shell/hook contexts, `source hooks/resolve-vault.sh` and use `$VAULT_PATH` / `$GH_TASK_REPO`. In skill prose, substitute `$GH_TASK_REPO` below with the configured value.

## Invocation modes

- **`/pickup`** — no args: interactive HITL flow over `owner:human` Ready list (handovers first, then top task)
- **`/pickup <N>`** — direct claim of issue #N, any owner; skips Ready-list filtering entirely (explicit override)

`/pickup` is HITL-only. The previous `/pickup auto` background spawner has been removed; AFK queue drainage now lives in `/impl auto` (see `/impl` skill). See § Mid-flow rule below for which work belongs on `/pickup` vs `/impl`.

## Mid-flow rule

Some work is fundamentally human-in-the-loop and MUST stay on `/pickup`, never `/impl`. These are tasks where automation produces work the user will throw away:

- **Handovers** (`type:handover`) — resuming requires reading the doc, verifying state, possibly resuming an incomplete grill. AFK workers cannot resume an interrupted grill.
- **Incomplete grills** — a grill session marked `INCOMPLETE` / `NOT completed` needs the human's judgment on the open questions, not a bot guessing.
- **Mid-draft writing** — anything in a writing pipeline (brainstorm → fb-writer → substack-writer → checker → visual). Each stage takes human steering. Never AFK.

Rule: any of the above MUST carry `owner:human`. `/impl auto` skips them by label filter. `/pickup` no-args picks them up (it filters `owner:human`). `/pickup <N>` accepts any owner — use the bare-integer form when you (the human) explicitly want to resume a non-`owner:human` issue interactively.

## `/pickup <N>` — Direct claim of a specific issue

When the user passes a bare integer (e.g. `/pickup 100`, `cr /pickup 100`), treat it as "claim this issue and start." Do NOT run the interactive Ready-list flow. Owner label is not checked — this is the explicit override for any-owner direct claim.

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

1. **Query open Ready HITL tasks** from GitHub. `/pickup` is human-in-loop only: filter to `owner:human` so AFK-eligible work stays in `/impl`'s lane and doesn't show up here:
   ```bash
   gh issue list -R $GH_TASK_REPO --state open --label status:ready --label owner:human --json number,title,labels,body
   ```
   Labels carry all metadata (priority, weight, owner, type) — do not parse title for markers. To pick up a non-`owner:human` issue interactively, use the explicit `/pickup <N>` form.

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

Single source of truth: **`${CLAUDE_PLUGIN_ROOT}/scripts/pickup-claim.sh <N>`**. All `/pickup` entry points (`/pickup`, `/pickup <N>`, plus the interactive Ready-list flow) call this helper for the atomic flip. `/impl` and `/impl auto` also call it for AFK claims. Do NOT re-implement the flip in skill prose — the recurring bug is LLMs skipping the flip when described step-by-step (worker spawned, label still `status:ready`, /status mis-classifies). The script is deterministic and untouched by judgment.

What the script does:
1. Resolves `$GH_TASK_REPO` from `hooks/resolve-vault.sh`.
2. Fetches issue state + status label (one `gh issue view` call).
3. If `status:in-progress` → no-op (exit 3).
4. If `status:ready` (or no status:* label) → atomic flip to `status:in-progress` via one `gh issue edit --remove-label status:ready --add-label status:in-progress` call (exit 0).
5. If `status:blocked` / `status:backlog` / unknown → abort (exit 1).
6. On gh / config error → exit 2.

The flip is atomic by GH semantics — no ephemeral `claim:session-*` labels. They were overengineering for a single-user repo and caused "label not found" errors because `gh issue edit --add-label` won't auto-create.

Race note: two sessions reading `status:ready` simultaneously and transitioning in the same second will both succeed (GitHub has no label CAS). In practice — solo user, a handful of sessions — this is rare and benign: duplicate work at worst, and the handover / issue body converges the outputs. The TOCTOU window is the helper itself (1-3 ms between view + edit) — much smaller than orchestrator-prose timing.

**On completion** — close the issue via the central helper (strips `status:*` labels first):
```bash
bash "$CLAUDE_PLUGIN_ROOT/scripts/gh-tasks/close-issue.sh" N
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
   - **≥80% questions answered** → auto-close: produce the artifact, `bash "$CLAUDE_PLUGIN_ROOT/scripts/gh-tasks/close-issue.sh" N`, log process
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

## `/pickup auto` — Launch tasks in background (DEPRECATED — see `/impl auto`)

`/pickup auto` has been removed. AFK queue drainage now lives in `/impl auto` (which wraps `/ralph-loop` around `/impl`). The `pickup-auto.sh` script and its launchd cron have been deleted.

If a user types `/pickup auto`, do NOT spawn anything. Print verbatim and exit:

```
/pickup auto is deprecated. Use /impl auto for AFK backlog drainage.

Migration:
  - /pickup auto         → /impl auto              (wraps /ralph-loop around /impl)
  - /pickup auto --force → /impl auto              (no time-aware weight filter; /impl ignores weight:heavy distinction)
  - /pickup auto --dry-run → gh issue list -R $GH_TASK_REPO --state open --label "status:ready,owner:bot"

/pickup is now HITL-only — see § Mid-flow rule in this skill.
```

Background: see `daily/grill-sessions/2026-04-25-skill-process-pocock-adoption.md` and parent story `ai-brain#145`. Rationale — `/pickup` and `/pickup auto` overlapped on the Ready-claim+spawn surface, creating confusion about whether AFK work and HITL handovers could coexist on the same skill. The split: `/pickup` owns HITL (`owner:human` only), `/impl` owns AFK (`owner:bot`, /tdd-driven, trunk-gated).

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
1. **Close the issue** (central helper strips `status:*` labels then closes): `bash "$CLAUDE_PLUGIN_ROOT/scripts/gh-tasks/close-issue.sh" N`
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

`owner:bot` means `/impl auto` will claim it (AFK queue drainage via /tdd, trunk-gated). `owner:human` means a person must grill + design before execution; `/pickup` no-args picks these up. Getting this wrong creates false "work in progress" signals — `owner:bot` auto-promotes tasks that actually need judgment, they stagnate in In Progress with no work happening.

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
  /handover → creates handover doc + opens GH issue (status:ready, type:handover, owner:human)

Session B (new Claude):
  /pickup → queries GH for status:ready + owner:human → filters type:handover first
        → claims (status:ready → status:in-progress) → loads handover doc → starts working
  ... work done ...
  bash "$CLAUDE_PLUGIN_ROOT/scripts/gh-tasks/close-issue.sh" N

Session B with explicit issue (any owner):
  /pickup 100 → skip list, directly claim #100 → load body/handover → start

Background AFK drainage (was /pickup auto, now /impl auto):
  /impl auto → wraps /ralph-loop around /impl → queries GH for status:ready + owner:bot
            → /impl runs /tdd on each → commits + pushes + closes issue
```

## Outcome log

Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/pickup.log`:

```
{date} | pickup | {action} | ~/work/brain-os-plugin | N/A | commit:N/A | {result}
```

- `action`: `pickup` (interactive), `pickup:N` (direct claim of issue N), or `auto:deprecated` (user invoked `/pickup auto` — log the deprecation event, do not spawn)
- `result`: `pass` if issues started/completed, `partial` if some escalated to user, `fail` if unrecoverable error (e.g. `gh` auth failure or network)
- **No eligible tasks** (empty Ready column, no `owner:human` issues, or all already in-progress) → log `pass | score=0/0`, not `fail`
- Optional: `args="{issue-number}"`
