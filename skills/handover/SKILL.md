---
name: handover
description: "Use when ending a session with unfinished work that needs to be continued in a future session"
---

# Handover — Session Continuity Skill

Creates a handover document in the vault and opens a GitHub issue that the next session picks up via `/pickup`.

## Config

**Vault path + GitHub task repo:** read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md` (or user-local `~/.brain-os/brain-os.config.md` which takes precedence). Keys: `vault_path:`, `gh_task_repo:`. In shell/hook contexts, `source hooks/resolve-vault.sh` and use `$VAULT_PATH` / `$GH_TASK_REPO`. In skill prose, substitute `$GH_TASK_REPO` below with the configured value.

## Behavior

### `/handover` — Save session state + open a backlog issue

1. **Scan the current session** — what was discussed, decided, built, still pending
2. **Create handover file** at `{vault}/daily/handovers/YYYY-MM-DD-topic.md` using the template below
3. **Open a GitHub issue via the script** — do NOT inline `gh issue create`. Prose-level commands get silently skipped (memory `feedback_md_instructions_untrustworthy`). The script is the only supported path, it fails loudly on error, and it writes the `issue={N}` marker to the outcome log atomically:
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/skills/handover/scripts/create-handover-issue.sh" \
     --handover-path "daily/handovers/YYYY-MM-DD-topic.md" \
     --title "Handover: <topic>" \
     --tldr "<one-line summary from the handover doc's TL;DR>" \
     --next-step "<first action from the handover's 'What's Next'>" \
     --priority p1 \
     --weight heavy \
     --owner human
   ```
   Flag rules:
   - `--priority pN` — the priority work resumes at (`p1` default for an active session handover; drop lower only if explicitly less urgent)
   - `--weight heavy|quick` — `heavy` if remaining work is 1h+; `quick` for small continuations
   - `--owner human|bot` — `human` default (handovers usually need a human-aware grill first). Only use `bot` if the remaining steps are fully self-executing
   - The script constructs the body with `[handover](<path>)` automatically — do NOT pre-format
   - If the script exits non-zero, the handover is NOT complete; fix the underlying issue (gh auth, missing repo, wrong vault path) and re-run — do not write a `pass` log entry manually

4. **Update MEMORY.md** with pointer to handover doc (vault-relative path)

GitHub Issues are the task queue — server-side atomic labels replace the MD kanban for state.

## Handover Document Template

```markdown
---
title: "Handover: [topic]"
created: YYYY-MM-DDTHH:MM:SS
status: in-progress | blocked | ready-to-continue
tags: [handover, topic]
---

# Handover: [Topic]

## TL;DR
[2-3 sentences: what was this session about, where did we stop, what's next]

## Session Summary
[What was accomplished — be specific with file paths and numbers]

## Decisions Made (SETTLED — do NOT re-ask)
| Decision | Answer | Why |
|----------|--------|-----|

## Current State
- Files created: [full paths]
- Files modified: [full paths]
- Tools installed: [with paths]
- Git status: [committed? pushed?]

## What's Next
1. [Step 1 — exactly what to do, which files to touch]
2. [Step 2]
3. [Step 3]

## Blockers / Open Questions
- [anything needing user input]

## Key File Locations
| What | Path |
|------|------|

## Commands to Verify State
```bash
# Run these first to confirm nothing changed since handover
[commands]
```

## Context the Next Session Needs
[User preferences, constraints, gotchas not captured elsewhere]
```

## Rules

### Be Specific, Not Vague
- **Wrong**: "Continue working on the plugin"
- **Right**: "Create plugin.json at ~/work/brain-os/plugin.json. Move 24 skill dirs from ~/.claude/skills/ into brain-os/skills/. Test with `cowork install .`"

### Full Paths Only
Every file reference = absolute path. Next session has no memory of "that file."

### Decisions = SETTLED
If grilled and confirmed, the next session MUST NOT re-ask.

### Always Open an Issue
The handover doc is useless if nobody picks it up. The GH issue with `type:handover` + `status:ready` is what `/pickup` finds.

### Issue body must link the handover doc
`/pickup` parses the issue body for `[handover](daily/handovers/YYYY-MM-DD-topic.md)`. Keep the exact `[handover](...)` anchor text so the parser can find it regardless of other links in the body.

### Closing a handover issue
When `/pickup` completes the handover's "What's Next", it runs `bash "$CLAUDE_PLUGIN_ROOT/scripts/gh-tasks/close-issue.sh" N` (the central close helper that strips `status:*` labels first, plugging the ghost-label leak). The closed issue + the handover doc together are the audit trail; no file marker needs to flip.

### Cross-session handover → pickup flow

When the user wraps up a session and wants to continue in a new Supaterm tab (cyolo), always use this canonical flow — never hand-craft a start prompt:

1. Run `/handover` in the current session — creates the GH issue (`type:handover` + `status:ready`) + handover doc
2. Launch a new Supaterm tab: `sp tab new --focus -- claude --effort=max --dangerously-skip-permissions`
3. First prompt in the new tab: `/pickup <N>` (issue number from step 1)

Do NOT hand-craft a start prompt and pipe it via `sp pane send`. `/pickup` reads the issue body + linked handover doc — that's the single source of truth for next-session context. Manual prompts drift and skip context the handover doc captured.

### Tasks by source, not by entity (for seeding / ingestion handovers)

When the handover covers a seeding or ingestion task that pulls from an external system, frame the task by **source** (e.g. "Seed from Airtable", "Seed from Gmail") rather than by **output entity** (e.g. "Seed people", "Seed companies", "Seed meetings").

A single pass through one source produces all entity types at once — splitting by entity forces redundant scans and hides that gmail / airtable / slack each need their own one-pass extractor. Entity types go in the task description as outputs, not as separate tasks. Downstream dependencies should reference the source task ("Depends on Seed from Airtable"), not an entity task.

## Outcome log

The `create-handover-issue.sh` script appends the log line automatically with the shape:

```
{date} | handover | handover | {vault} | daily/handovers/{date}-{topic}.md | commit:{hash} issue={N} | pass | args={topic}
```

Do NOT hand-write this line — let the script own it so the `issue={N}` marker is guaranteed accurate.

- `pass` only valid when the script exits 0 (doc + issue both created, log line written with `issue={N}`)
- `partial` — handover doc created but script failed; re-run script after fixing the error. Do not leave the skill in `partial` state
- `fail` — nothing to hand over (skill should not have been invoked)
