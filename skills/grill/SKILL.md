---
name: grill
description: "Interview the user relentlessly about a topic until reaching a bulletproof, actionable plan. Use when user says 'grill me', 'stress-test this plan', 'poke holes in this', or wants to be challenged on every aspect of a design, strategy, or decision."
---

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`

Interview me relentlessly about every aspect of this, starting from the user's actual problem before any external solution, until we reach a shared understanding. Walk down each branch of the design tree resolving dependencies between decisions one by one. If a question can be answered by research — vault, web, code — do that instead of asking me. Before fresh vault scans, check the SessionStart index + recent tool results for the topic; if matched, read that file directly. For each question, provide your recommended best practice answer. Options get pros/cons then ONE pick — never per-option. For complex tasks (development, skills), grill speed and token usage too. Grill until bulletproof.

Save decisions to `{vault}/daily/grill-sessions/YYYY-MM-DD-<topic-slug>.md`

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
