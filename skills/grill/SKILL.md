---
name: grill
description: "Interview the user relentlessly about a topic until reaching a bulletproof, actionable plan. Use when user says 'grill me', 'stress-test this plan', 'poke holes in this', or wants to be challenged on every aspect of a design, strategy, or decision."
---

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`

Interview me relentlessly about every aspect, starting from the user's actual problem and the atomic unit of meaning before any external solution. Walk each branch of the design tree resolving dependencies. If research (vault, web, code) can answer, do that instead of asking me. Provide your recommended best practice answer per question. Options get pros/cons then ONE pick — never per-option. For complex tasks, grill speed and token usage too. Grill until bulletproof. Render ASCII flowchart for ≥2 cross-dep components; gate before `status: pass`.

Save decisions to `{vault}/daily/grill-sessions/YYYY-MM-DD-<topic-slug>.md`. Tasks become GitHub issues in `gh_task_repo`, never `business/tasks/inbox.md` (archived 2026-04-18).

## Usage
```
/grill <topic>
```

## Acceptance criteria (story-tier grills)

A grill is **story-tier** when its locked decisions imply implementation work — code edits, new files, scripts, hooks, skills, infra changes — that `/slice` will fan out into child issues. A grill is **reflection-tier** when the output is purely analytical (strategic framing, market thinking, post-mortem reasoning, principle exploration) with no implementation surface.

### Story-tier requires ≥1 live-e2e AC

Every story-tier grill MUST produce at least one acceptance bullet of the form **"live e2e on smallest real test data — output empirically validated, not just spec-checked"** before locking. This single bullet is the empirical anchor that `/slice` (per ai-brain#258, D6) will emit as `rung:0` so the abstraction is validated against reality before sibling children fan out.

Mark the bullet so it is mechanically detectable: append the literal token `(LIVE E2E)` somewhere on the bullet line. Trailing-suffix placement is the canonical form because it leaves the parent-AC regex (`references/ac-coverage-spec.md` § 3.1) unchanged:

```markdown
## Acceptance criteria

- [ ] **AC#1** — <criterion> (LIVE E2E)
- [ ] **AC#2** — <next criterion>
```

Inside-bold placement (`**AC#1 (LIVE E2E)** — …`) is also accepted on read — `/slice`'s e2e-AC detection uses line-level substring search for `(LIVE E2E)`, not the AC# regex — but trailing-suffix is preferred for new grills because it keeps both detection mechanisms (the parent-AC regex and the substring search) happy in the same body. The `live-e2e:true` HTML-comment alternative (`<!-- live-e2e:true -->` on the bullet) is reserved for tooling-strict edge cases; default to the human-readable token.

### Refuse to lock without an e2e AC

If the grill's locked output is story-tier and no AC carries the `(LIVE E2E)` marker, do NOT apply `status: pass`. Surface the gap to the user verbatim:

```
Story-tier grill missing live-e2e AC.

Every story-tier grill must produce ≥1 acceptance bullet of form:
  "live e2e on smallest real test data — output empirically validated, not just spec-checked"

Mark it with the literal token `(LIVE E2E)` so /slice can detect it.

Options:
  1. Add a (LIVE E2E) AC describing the smallest end-to-end check that proves the abstraction.
  2. Lock as `status: reflection` instead — explicit declaration that this grill has no implementation surface (no /slice, no child issues, no end-step audit menu).
```

Then halt and wait for the user to add the AC or pick the escape hatch.

### `status: reflection` — non-architectural escape hatch

`status: reflection` is the lock label for grills that genuinely have no implementation surface (purely analytical reflections, principle thinking, market-frame work). When a grill locks as `status: reflection`:

- The end-step audit recommendation menu (next section) is skipped — no audit fires.
- `/slice` will refuse to operate on the file (the e2e-AC guardrail in ai-brain#258 D6 enforces this downstream); the reflection lives in the vault as a thinking artifact, not as a story input.
- Outcome log result remains `pass` — a complete reflection is a successful grill outcome, just one that does not fan out.

Use `status: reflection` honestly. Promoting a story-tier grill to reflection-tier just to bypass the e2e-AC requirement is a process bug — the next session will still need the implementation, the e2e AC, and the audit pass. The gate exists because [the 2026-05-05 Live Staronline replay (ai-brain#246)](https://github.com/sonthanh/ai-brain/issues/246) shipped 8 children of #237 on a P4-violating abstraction that 30 seconds of looking at concrete records would have caught — the e2e AC + status:reflection split makes that miss un-skippable for future architectural grills.

## End-step audit recommendation (post-lock, pre-/slice)

When the grill applies a lock label (`status: pass` / `status: settled` / `status: shipped`), append a final step BEFORE recommending `/slice`: surface a transparent audit-mode recommendation menu so the user sees the principle-coverage rationale and decides explicitly. The menu fires only on lock; it does NOT fire on `status: reflection`, `status: working`, or `status: draft`.

### What the menu does

1. Re-read the locked decisions section of the in-progress grill file.
2. Inspect each locked decision through the 5 principles (P1..P5) listed in `{vault}/thinking/principles/tracker.md`. For each principle, draft a one-line rationale describing what that principle would look at in this grill (e.g. "P1 — touch-point count is N across M files; validate the simplest version covers the actual incident", "P4 — abstraction X is locked before concrete record Y exists; verify or decompose"). Rationales are LLM-discretion at run time but must be specific to the grill, not generic boilerplate.
3. Render the menu with `/audit --all` as the default and 5 override options.
4. Halt; let the user pick.

### Menu shape

```
Audit recommendation: /audit --all (5 principles)
  P1 (First Principles)        — <auto-rationale referencing locked decisions>
  P2 (Start with Why)          — <auto-rationale: named incident? forward-looking?>
  P3 (Hormozi)                 — <auto-rationale: value-equation / audience fit / hook-retain-reward — applies if content/strategy decision>
  P4 (Concrete drives abstract) — <auto-rationale: any abstraction locked before its concrete artifact exists?>
  P5 (Manage causes)           — <auto-rationale: enforcement at the seam vs. review-only?>

Override:
  [1] Run all 5 (default — /audit --all)
  [2] Drop subset (provide reasons; e.g. /audit p1 p2 p4)
  [3] Single-principle (/audit p<N>)
  [4] Skip (acknowledge risk)
  [5] Run via agent-teams (/audit --team) — surfaced ONLY if Phase B (ai-brain#252) is shipped
```

### Option [5] file-existence gate (deterministic)

Option [5] is hidden until the agent-teams substrate (ai-brain#252, Phase B) is shipped. Detection is a deterministic file-existence check on the `principle-auditor-p1` subagent definition — present means Phase B has shipped:

```bash
test -f "${CLAUDE_PLUGIN_ROOT}/agents/principle-auditor-p1.md"
```

If the file does not exist, omit option [5] from the rendered menu entirely (do not list it as `[unavailable]` or similar — the goal is not to advertise an unshippable mode). If the file exists, include option [5] as shown above. Treat the file's presence as the contract; do not infer Phase-B completion from any other signal (commit messages, issue state, label colors).

### After the user picks

- `[1]` (default) → Skill: `audit` with `args: --all`. Audit findings become the gate before the user runs `/slice`.
- `[2]` / `[3]` → Skill: `audit` with the user-specified principles (e.g. `args: p1 p2 p4`). Same gate.
- `[4]` (skip) → Print a one-line risk-acknowledgement record into the grill file under a `## Audit skipped` section (date + reason), then proceed. Skipping is legitimate for hot-fix grills but must leave an audit trail for /improve to spot patterns.
- `[5]` (agent-teams) → Skill: `audit` with `args: --team`. Only available when the gate above passes.

After audit verdict (or skip), the canonical next step is `/slice <grill-file>`. If the audit returns FAIL or FLAG verdicts, surface them verbatim and let the user decide whether to amend the grill before slicing — do not auto-block (the audit gate's job is transparency; the user owns the call).

## Gotchas

- **NEVER use `AskUserQuestion` inside /grill flow.** AskUserQuestion is reserved for `/grill-fast` (Mode B, pre-rendered tree candidates). /grill is a relentless free-form interview — using AskUserQuestion forces the user to pick before discussion is done, breaking the grill discipline. Route through prose recommendations + open-ended turns only.

## Outcome log

Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/grill.log`:

```
{date} | grill | grill | ~/work/brain-os-plugin | daily/grill-sessions/{date}-{slug}.md | commit:{hash} | {result}
```

- `result`: `pass` if bulletproof plan reached (story-tier with ≥1 live-e2e AC + lock applied, OR reflection-tier locked as `status: reflection`), `partial` if gaps remain, `fail` if abandoned
- Optional: `args="{topic}"`
