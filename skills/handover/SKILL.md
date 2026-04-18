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
3. **Open a GitHub issue** tagged for `/pickup`:
   ```bash
   gh issue create -R $GH_TASK_REPO \
     --title "Handover: <topic>" \
     --body "$(cat <<'EOF'
   Continue unfinished work from the prior session.

   - TL;DR: <one-liner from the handover doc>
   - Next step: <first action from the handover's "What's Next">
   - [handover](daily/handovers/YYYY-MM-DD-topic.md)
   EOF
   )" \
     --label status:ready \
     --label type:handover \
     --label owner:human \
     --label priority:p1 \
     --label weight:heavy
   ```
   Rules for the command:
   - `--label priority:pN` — carry over the priority the work will resume at (`p1` by default for an active session handover; drop lower if explicitly less urgent)
   - `--label weight:heavy` — include only if remaining work is 1h+; omit or use `weight:quick` for small continuations
   - Body MUST include a relative markdown link `[handover](daily/handovers/...)` — GH renders it on the web and `/pickup` parses it to locate the doc. Do NOT use `[[wiki-link]]` syntax; GH won't resolve it.
   - `owner:human` is the default for handovers (they need a human-aware grill before proceeding). Only switch to `owner:bot` if the remaining steps are fully self-executing.

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
When `/pickup` completes the handover's "What's Next", it runs `gh issue close N -R $GH_TASK_REPO --reason completed`. The closed issue + the handover doc together are the audit trail; no file marker needs to flip.

## Outcome log

Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/handover.log`:

```
{date} | handover | handover | ~/work/brain-os-plugin | daily/handovers/{date}-{topic}.md | commit:{hash} | {result}
```

- `result`: `pass` if handover doc + GH issue created, `partial` if doc created but `gh issue create` failed, `fail` if nothing to hand over
- Optional: `args="{topic}"`, append `issue={N}` to `commit:{hash}` column when the issue is created (e.g. `commit:abc123 issue=42`)
