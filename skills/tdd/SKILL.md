---
name: tdd
description: "Test-driven development for brain-os artifacts via red-green-refactor. Use when building or fixing skills, scripts, hooks, plists, or vault tooling — mention 'red-green-refactor', 'TDD', 'test-first', 'tracer bullet', or invoke with /tdd."
---

# /tdd — Test-Driven Development for Brain-os

Adapted from [@mattpocockuk/skills/tdd](https://github.com/mattpocock/skills/tree/main/tdd). Discipline harness: write ONE test → make it pass → repeat. Replaces `/develop`'s 7-phase ceremony with vertical-slice loops sized to brain-os artifacts.

## Invocation

- `/tdd <artifact>` — start a TDD cycle on the artifact (skill name, file path, GitHub child issue number, etc.).
- `/tdd --prior-attempt-failed-because "<hint>" <artifact>` — same as above, but BEFORE writing the first test (during Planning), inject `Previous attempt failed because: <hint>. Try a different angle.` into the planning context. The hint is passed verbatim by `/impl`'s child-level ralph wrapper on retry iterations 2 + 3 (carrying forward the previous iteration's failure summary). `/tdd` itself does NOT decide when to use the arg — it is consumed only when present.

## Philosophy

**Core principle**: Tests should verify behavior through public interfaces, not implementation details. Code can change entirely; tests shouldn't.

**Good tests** are integration-style: they exercise real code paths through public APIs. They describe _what_ the system does, not _how_ it does it. A good test reads like a specification — "skill closes its GH issue when the artifact ships" tells you exactly what capability exists. These tests survive refactors because they don't care about internal structure.

**Bad tests** are coupled to implementation. They mock internal collaborators, test private helpers, or verify through external means (querying state directly instead of using the interface). Warning sign: your test breaks when you refactor but behavior hasn't changed. If you rename an internal function and tests fail, those tests were testing implementation, not behavior.

**Mocking rule**: only mock at system boundaries — Gmail / Anthropic / NotebookLM APIs, external HTTP, time, randomness, file-system state outside the working tree. Never mock your own modules, scripts, hooks, or vault contents. When a system boundary is unavoidable, design the interface for mockability: pass dependencies in (don't construct them inside), prefer SDK-style methods (`api.getUser(id)`) over generic fetchers (`api.fetch(endpoint)`).

## Anti-Pattern: Horizontal Slices

**DO NOT write all tests first, then all implementation.** This is "horizontal slicing" — treating RED as "write all tests" and GREEN as "write all code."

This produces **crap tests**:

- Tests written in bulk test _imagined_ behavior, not _actual_ behavior
- You end up testing the _shape_ of things (data structures, function signatures) rather than user-facing behavior
- Tests become insensitive to real changes — they pass when behavior breaks, fail when behavior is fine
- You outrun your headlights, committing to test structure before understanding the implementation

**Correct approach**: Vertical slices via tracer bullets. One test → one implementation → repeat. Each test responds to what you learned from the previous cycle. Because you just wrote the code, you know exactly what behavior matters and how to verify it.

```
WRONG (horizontal):
  RED:   test1, test2, test3, test4, test5
  GREEN: impl1, impl2, impl3, impl4, impl5

RIGHT (vertical):
  RED→GREEN: test1→impl1
  RED→GREEN: test2→impl2
  RED→GREEN: test3→impl3
  ...
```

## Test Commands by Artifact Type

Pick the row matching what you're changing. The test command runs in every RED and every GREEN — that's how you observe the transition.

| Artifact | Test command | Notes |
|----------|--------------|-------|
| Bun / TypeScript code | `bun test path/to/file.test.ts` | Default for new code |
| Bash script | `bash -n script.sh && bash script.sh --dry-run` | Syntax check + dry-run code path |
| Hook (PreToolUse / SessionStart / etc.) | `echo '{json-payload}' \| bash hook.sh; echo "exit=$?"` | Exit code is the contract; capture stdout/stderr |
| Plist (LaunchAgent) | `plutil -lint file.plist` | Schema validity only — runtime behavior needs a separate launchd test |
| Python (legacy or migration target) | `python3 -m py_compile file.py && pytest path/to/test_file.py` | Compile gate + pytest |
| Skill with `evals/` | `/eval <skill-name>` | Invokes the skill's own eval suite |
| Skill without evals | Manual: invoke the skill on a real input, observe output vs expected | Add `evals/` if the change is non-trivial |
| Vault doc / markdown | grep for required sections, lint structure | E.g., a handover must have "What's Next" + "Commands to Verify State" |

If your artifact isn't listed, name the verifier explicitly in the Planning phase before writing the first test.

## Live-AC SKIPPED rejection

Default behavior across artifact types: a runner report containing SKIPPED cases counts as GREEN provided no test failed. The exception below tightens that contract; it applies ONLY when `/tdd` is invoked on a GitHub child issue whose body carries `## Parent` and a `## Covers AC` H2 section (the structured shape filed by `/slice`). Generic-artifact invocations — direct `/tdd` on a bash script, plist, vault doc, or skill with no enclosing GitHub issue — are unaffected.

Detection (single source of truth — do NOT re-derive parser shape, regex, or the live-AC marker list here; cite by section number):

1. Parse the working child issue body for `## Covers AC` per `references/ac-coverage-spec.md` § 1 (Covers AC parser regex). Collect the integer ID set. Empty set → pure-component child → standard GREEN, rule does not fire.
2. Read the parent issue (named in the child's `## Parent` section) and parse `## Acceptance` per spec § 2.
3. Apply the live-AC detection rule from `references/ac-coverage-spec.md` § 6 to each parent AC bullet — yields the parent's live-AC ID set.
4. The child is a **live-AC child** iff its Covers-AC ID set intersects the parent's live-AC ID set (per spec § 1.2 intersection rule).

Rule: when the child is a live-AC child AND the test runner output reports any SKIPPED test case, `/tdd` refuses GREEN and emits RED with the exact message:

```
Live-AC child has SKIPPED tests — make them run or remove their skip gate.
```

The child must either remove the skip gate (env-var, `.skip()` modifier, conditional `describe.skip`) or actually run the previously-skipped path. Pure-component children (empty `## Covers AC` ID set, or a set whose every ID maps to a non-live parent AC) keep the previous behavior — SKIPPED cases pass through GREEN unchanged.

## Workflow

### 1. Planning

Before writing any code:

- [ ] If invoked with `--prior-attempt-failed-because "<hint>"`: inject `Previous attempt failed because: <hint>. Try a different angle.` into the planning context as the FIRST line, before any other planning step. This anchors the rest of the plan against the prior failure.
- [ ] Confirm with the user what **behavior** changes (not just "what code")
- [ ] Pick the artifact type from the table above — record the test command in the plan
- [ ] List 3–7 behaviors to test (not implementation steps)
- [ ] Prioritize: which 1–2 are critical-path? Test those first
- [ ] Identify [deep modules](https://web.stanford.edu/~ouster/cgi-bin/aposd.php) (small interface, deep implementation) — hides complexity behind one entry point
- [ ] Design interfaces for testability: accept dependencies, return results (don't mutate via side effect), keep surface area small
- [ ] Get user approval on the plan

Ask: "What should the public interface look like? Which behaviors matter most?"

**You can't test everything.** Confirm with the user exactly which behaviors matter. Focus testing effort on critical paths and complex logic, not every possible edge case.

### 2. Tracer Bullet

Write ONE test that confirms ONE thing about the system end-to-end:

```
RED:   Write test for first behavior → run test command → test fails
GREEN: Write minimal code to pass → run test command → test passes
```

This is your tracer bullet — proves the path works end-to-end. Skip stubs, mocks of internal pieces, and scaffolding. Just the smallest real thing.

### 3. Incremental Loop

For each remaining behavior:

```
RED:   Write next test → fails
GREEN: Minimal code to pass → passes
```

Rules:

- One test at a time
- Only enough code to pass the current test
- Don't anticipate future tests — let the next test reveal what's needed
- Keep tests focused on observable behavior

### 4. Refactor

After all tests pass, look for:

- **Duplication** → Extract function or module
- **Long functions** → Break into private helpers (keep tests on the public interface)
- **Shallow modules** → Combine or deepen (small interface, more implementation hidden)
- **Feature envy** → Move logic to where the data lives
- **Existing code** the new code reveals as problematic
- Run the test command after **each** refactor step

**Never refactor while RED.** Get to GREEN first.

## Checklist Per Cycle

```
[ ] Test describes behavior, not implementation
[ ] Test uses public interface only
[ ] Test would survive an internal refactor
[ ] Code is minimal for this test (no speculative features)
[ ] Test command was actually run (not just "looks right")
```

## When NOT to use /tdd

- One-line config tweaks, typos, README / CLAUDE.md edits → direct fix
- Skill prose (SKILL.md wording) where the only "test" is "Claude interprets it correctly" → use `/improve` or `/audit` instead
- Pure deletion of dead code (no behavior change) → run the existing test suite, don't add a new test
- Truly exploratory spikes where you don't yet know what behavior you want → explore first, come back to `/tdd` once the target is clear

## Outcome log

Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/tdd.log`:

```
{date} | tdd | {action} | ~/work/brain-os-plugin | {artifact-relative-path} | commit:{hash} | {result}
```

- `action`: `feature` (new behavior), `bugfix` (fix broken behavior), `refactor` (no behavior change, covered by tests), or `port` (adapt from external source)
- `result`: `pass` if all tests green AND no reactive `improve: encoded feedback —` commit lands against this artifact within 48h; `partial` if user manually corrected mid-cycle but tests still passed; `fail` if cycle abandoned or reactive patch needed
- Optional: `args="{artifact-name}"`, `cycles=N` (red-green count), `corrections=N`

The 48h-no-reactive-patch criterion is the discipline test from the Phase A handover (`daily/handovers/2026-04-25-skill-process-phase-a-tdd.md`). If pass-rate stays high, /tdd's smaller slices are doing what `/develop`'s checklist couldn't. If reactive patches keep landing, the deferred reviewer hook (Q6 in the grill) comes back.
