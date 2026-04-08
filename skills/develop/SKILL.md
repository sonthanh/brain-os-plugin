---
name: develop
description: "Structured development process with mandatory testing. Use when building features, scripts, skills, or any code that will run unattended."
---

# /develop — Structured Development with Mandatory Testing

Enforces a spec-test-build-verify cycle. Inspired by Superpower framework's RED-GREEN-REFACTOR discipline — no code ships without passing tests.

## Usage
```
/develop <task description>
/develop --resume          Resume interrupted development
```

## Process

### Phase 1: SPEC (what are we building?)

1. **Read the task** — detail file, linked issues, conversation context
2. **Write a spec** in 5-10 bullet points:
   - What it does (behavior)
   - What it doesn't do (scope boundary)
   - Success criteria (how we know it works)
   - Edge cases to handle
3. **Show spec to user** — get approval before coding
4. If task is a skill: also define eval cases (input → expected output)

### Phase 2: TEST FIRST (how will we verify?)

Before writing any implementation code, define the verification plan:

#### For scripts (launchd, cron, shell):
- [ ] All binary paths resolved? (test with restricted PATH)
- [ ] Shell quoting safe? (no inline interpreters — use jq or separate files)
- [ ] What happens if machine is off at scheduled time?
- [ ] What prevents duplicate runs?
- [ ] Notification/alerting works?
- [ ] `bash -n script.sh` passes (syntax check)

#### For skills (SKILL.md):
- [ ] Eval spec exists in `evals/evals.json`
- [ ] `/eval` passes after changes

#### For code (TypeScript, Python, etc.):
- [ ] Type-check passes (`tsc --noEmit` / `mypy`)
- [ ] Lint passes
- [ ] Unit tests written for new logic
- [ ] Tests pass before moving on

#### For hooks/plist/config:
- [ ] Config syntax valid (`plutil -lint`, `jq .`, JSON parse)
- [ ] Dry-run in isolation before deploying
- [ ] Rollback plan identified

### Phase 3: BUILD (implement)

1. Write the implementation
2. Run tests defined in Phase 2 **after each significant change** — not just at the end
3. If a test fails: fix before continuing. Do not accumulate broken state.
4. Commit working increments (not one giant commit at the end)

### Phase 4: VERIFY (does it actually work?)

Run the full verification suite:

1. **Syntax check**: `bash -n` / `tsc --noEmit` / `plutil -lint` / `python3 -m py_compile`
2. **Dry-run**: execute the script/skill/code manually and check output
3. **Edge case test**: simulate at least one edge case from Phase 1 spec
4. **Integration test**: for launchd/cron — trigger with `launchctl start` and verify logs
5. **Eval test**: for skills — run `/eval` and confirm all pass
6. **CI check**: after push — `gh run list --limit 3` to verify pipeline is green

### Phase 5: SHIP

1. Commit + push
2. Verify CI passes (if applicable)
3. Report completion with test results summary

## Rules

### Never skip Phase 2
The test plan is not optional. Even for "simple" changes. The auto-journal bug (4 issues, all catchable) happened because Phase 2 was skipped.

### Test at boundaries, not internals
- Validate user input, external APIs, file I/O, env vars
- Don't over-test pure functions that the type system already guarantees

### One concern per commit
Don't mix refactoring with feature work. Don't mix test fixes with new logic.

### Fail fast, fail loud
Scripts must `set -euo pipefail`. Silent failures are worse than crashes. If something can fail, it should fail visibly with a clear error message.

### No inline interpreters in shell
Never embed `python3 -c "..."` or `ruby -e "..."` in shell scripts. Use `jq` for JSON, or write a separate script file. Shell quoting will break inline code.

## When NOT to use /develop

- Quick vault edits (just edit the file)
- Writing content (use `/writer`)
- Research tasks (use `/research`)
- One-line config changes (just do it)

Use `/develop` when the output is **code that runs** — scripts, skills, hooks, automations, features.
