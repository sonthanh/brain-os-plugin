---
name: grill
description: "Interview the user relentlessly about a topic until reaching a bulletproof, actionable plan. Use when user says 'grill me', 'stress-test this plan', 'poke holes in this', or wants to be challenged on every aspect of a design, strategy, or decision."
---

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`

Interview me relentlessly about every aspect, starting from the user's actual problem before any external solution, until shared understanding. Walk each branch of the design tree resolving dependencies. If research (vault, web, code) can answer, do that instead of asking me. Before fresh vault scans, check SessionStart index + recent tool results; if matched, read that file directly. Provide your recommended best practice answer per question. Options get pros/cons then ONE pick — never per-option. For complex tasks, grill speed and token usage too. Grill until bulletproof.

Save decisions to `{vault}/daily/grill-sessions/YYYY-MM-DD-<topic-slug>.md`. Tasks become GitHub issues in `gh_task_repo`, never `business/tasks/inbox.md` (archived 2026-04-18).

## Usage
```
/grill <topic>
```

## Outcome log

Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/grill.log`:

```
{date} | grill | grill | ~/work/brain-os-plugin | daily/grill-sessions/{date}-{slug}.md | commit:{hash} | {result}
```

- `result`: `pass` if bulletproof plan reached, `partial` if gaps remain, `fail` if abandoned
- Optional: `args="{topic}"`
