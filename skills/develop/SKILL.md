---
name: develop
description: "Structured development process with mandatory testing. Use when building features, scripts, skills, or any code that will run unattended."
---

# /develop — Structured Development with Mandatory Testing

Enforces a spec-test-build-verify cycle for all code that runs. Synthesized from three coding agent frameworks:

- **Superpowers** (obra): Iron Law of TDD — no production code without failing test first
- **gstack** (garrytan): Hard review gate + 3-strike investigation rule
- **GSD** (gsd-build): State externalization + wave-based execution

## Usage
```
/develop <task description>
/develop --resume          Resume from state file
```

## Iron Laws

These are non-negotiable. Breaking them = deleting the violating code and restarting.

1. **First principles first.** Before building ANYTHING, answer these 3 questions:
   - "Does this already exist somewhere?" (grep codebase, read existing skills/code)
   - "What's the ONE thing that's actually missing?"
   - "Can I add it in < 10 lines instead of building a new system?"
   If the answer to #3 is yes → do that. Don't build a system. Delete your spec and just add the lines.
2. **No code before tests.** Write the test/verification first. Watch it fail. Then write the implementation. Code written before its test is deleted.
3. **No fix without investigation.** When something fails: read the error, check assumptions, trace the root cause. Never retry blindly. After 3 failed fix attempts on the same issue → STOP and report to user.
4. **No ship without verify.** Every change must pass its verification before commit. Silent failures are worse than crashes.

## Process

### Phase 0: FIRST PRINCIPLES CHECK

Before starting the spec, answer:
1. **Does this already exist?** Search codebase, skills, hooks for existing solution.
2. **What's the minimal change?** Identify the ONE thing missing. Not a system — the thing.
3. **Can existing code do this with a small addition?** If yes → make the addition, skip the rest of /develop.

If Phase 0 kills the task (it already exists or needs < 10 lines) → report what you found and make the small change. No spec, no test plan, no ceremony.

**Log it:** Update `{vault}/thinking/principles/tracker.md` — increment usage count in Active Principles table, add combination if multiple principles applied, append a row to the Log.

### Phase 1: SPEC (only if Phase 0 says "genuinely new")

1. Read the task — detail file, linked issues, conversation context
2. Write a spec (5-10 bullets):
   - **Does:** behavior description
   - **Doesn't:** scope boundary
   - **Success:** how we know it works (testable criteria)
   - **Edge cases:** at least 3 failure scenarios
3. Show spec to user — get approval before coding
4. Save spec to state file if multi-session work

### Phase 2: TEST FIRST (Red)

Before writing ANY implementation, define and write the verification:

#### Scripts (launchd, cron, shell):
- [ ] `bash -n script.sh` — syntax check
- [ ] All binary paths absolute or in PATH (`which <binary>`)
- [ ] No inline interpreters (`python3 -c`, `ruby -e`) — use `jq` or separate files
- [ ] Machine-off handling (StartAtLoad, backfill logic)
- [ ] Duplicate-run guard (marker file, lock file)
- [ ] Notification pathway works (test `send_telegram`, etc.)
- [ ] `set -euo pipefail` at top

#### Skills (SKILL.md):
- [ ] Eval spec written in `evals/evals.json` BEFORE implementation
- [ ] At least 2 test cases: happy path + edge case

#### Code (TypeScript, Python):
- [ ] Write failing test first
- [ ] Watch it fail (confirm test is valid)
- [ ] Type-check passes (`tsc --noEmit` / `mypy`)

#### Hooks/plist/config:
- [ ] Config syntax valid (`plutil -lint`, `jq .`)
- [ ] Dry-run in restricted environment
- [ ] Rollback plan identified

#### Semantic LLM pipelines (extraction, classification, judge, summarization):

TDD is not code-only. For any expensive semantic LLM pipeline, run a **small slice first** (5–10 batches), review output quality AND token cost, adjust prompt/schema/scope, THEN scale. One-shot on the full corpus is the semantic equivalent of shipping an untested refactor — rework cost becomes N× instead of 1×.

- [ ] Pipeline supports `--batches N` or `--review-stop-after N` flag
- [ ] First run stops after 5–10 batches with output + per-item token cost visible for review
- [ ] Review gate decision: proceed / tweak prompt / rethink scope — before committing to the full run
- [ ] Incident (pipeline-v2, 2026-04-18): extracted ~15k email threads one-shot with Sonnet; Phase 1.5 Opus validation re-judged 949 pages to find fabricated emails, wrong first-observed dates, source-id confusion — patterns a 50-page slice would have surfaced in minutes. Applies to extraction, classification, summarization, entity-linking, any LLM-as-judge gate.

### Phase 3: BUILD (Green)

1. Write minimal code to make the test pass — nothing more
2. Run verification after EACH significant change, not just at the end
3. If a test fails: fix immediately. Do not accumulate broken state.
4. Commit working increments (one concern per commit)

### Phase 4: REVIEW (Two-Stage Gate)

Inspired by Superpowers' two-stage review:

**Stage 1 — Spec compliance:**
- Does the implementation match the spec from Phase 1?
- Are all edge cases from the spec handled?
- Are all success criteria met?

**Stage 2 — Code quality:**
- No duplicated logic (check existing codebase first)
- No silent failures (errors must be visible)
- No over-engineering (solve the stated problem, nothing more)
- Shell quoting safe? PATH correct? Env vars validated?

If critical issues found → fix before proceeding. Do NOT ship with known issues.

### Phase 5: VERIFY (Integration)

Full end-to-end verification in the real environment:

1. **Syntax**: `bash -n` / `tsc --noEmit` / `plutil -lint` / `python3 -m py_compile`
2. **Dry-run**: execute manually, check output matches spec
3. **Edge case**: simulate at least one failure scenario from Phase 1
4. **Integration**: for launchd → `launchctl start` + check logs. For hooks → trigger the event.
5. **Eval**: for skills → run `/eval` and confirm pass
6. **CI**: after push → verify pipeline green

#### Long-run quota gate (multi-batch / multi-hour pipelines)

Before launching any multi-batch validation, bulk extraction, judge, or multi-hour pipeline:

1. Ask the user to paste `/usage` output (source of truth — queries live Anthropic API). Do NOT trust `~/.cache/ccstatusline/usage.json` — the statusline cache can be hours stale (incident 2026-04-21: file claimed 69% session when the true mtime was 5h30m before a session reset).
2. Thresholds:
   - **Session ≥95%** → stop, wait for 5h reset
   - **Weekly ≥80%** → stop, wait for weekly reset (defer to next week)
3. Stop mechanism for in-flight runs: `sp tab close <space/tab>` or kill the xargs PID. Flag files remain; re-run resumes from the last completed batch (idempotent contract).
4. Weekly threshold is stricter because the reset is a full 7-day wait — defer conservatively.

### Phase 6: SHIP

1. Commit + push
2. Verify CI passes
3. Report: what was built, what tests pass, what edge cases were verified

## Bug Fix Protocol (from gstack)

When fixing bugs, follow this exact sequence:

1. **Investigate** — read the error, trace the root cause. No guessing.
2. **Write regression test** — a test that reproduces the bug. Watch it fail.
3. **Fix** — minimal change to make the test pass.
4. **Verify** — all existing tests still pass + new regression test passes.
5. **3-strike rule** — if the same fix fails 3 times, STOP. Report to user with:
   - What was tried
   - What failed
   - Root cause hypothesis

## State File (for multi-session work)

For complex tasks, persist state to `{vault}/daily/sessions/develop-{slug}.md`:

```markdown
---
task: "{description}"
phase: "spec|test|build|review|verify|ship"
started: YYYY-MM-DD
---
## Spec
{approved spec}

## Test Plan
{verification checklist with pass/fail status}

## Progress
{what's done, what's next}
```

Resume with `/develop --resume` — reads state file, continues from last phase.

## When NOT to use /develop

- Quick vault edits, content writing, research — just do it
- One-line config changes — just do it

Use `/develop` when the output is **code that runs unattended** — scripts, skills, hooks, automations, pipelines.

## Outcome log

Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/develop.log`:

```
{date} | develop | {phase} | {source_repo} | {output_path} | commit:{hash} | {result}
```

- `phase`: last completed phase (`spec`, `test`, `build`, `review`, `verify`, `ship`)
- `source_repo`: repo where code was built
- `output_path`: main artifact path (script, skill, hook)
- `result`: `pass` if shipped, `partial` if stopped early (Phase 0 kill or user halt), `fail` if 3-strike rule triggered
- Optional: `args="{task description}"`
