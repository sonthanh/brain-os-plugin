---
name: debug
description: "Investigate a reported bug, find the root cause across code + config + cloud + vault state, and file a brain-os GitHub issue with a /tdd RED-GREEN fix plan. Use when something silently fails, a skill output is wrong, a cron produces nothing, a hook misbehaves, or the user says 'why is X broken' / 'X is not working' / 'debug this' / invokes /debug."
---

# /debug — Triage Brain-os Bugs into /tdd-Ready Issues

Adapted from [@mattpocockuk/skills/triage-issue](https://github.com/mattpocock/skills/tree/main/triage-issue). Investigate a reported problem across the brain-os stack, find the root cause, and file a GH issue with a TDD-based fix plan. The fix itself happens later via `/impl` + `/tdd` — `/debug` only diagnoses and plans.

## Philosophy

**Diagnose in one context, fix in another.** Investigation burns the smart zone reading code, configs, and logs. The fix needs a fresh context to be sharp (Pocock's reviewer-in-fresh-context principle). `/debug` files the issue and stops; `/impl` later picks it up cleanly.

**Brain-os bugs span more than code.** A silently-failing skill could be wrong because of: SKILL.md spec gaps, missing hook registration, cloud `RemoteTrigger` config drift, launchd plist absence, vault state file corruption, MCP tool unavailability, or env-var misconfiguration. Investigation must cast a wide net or it misses the actual layer.

**Behavior, not implementation, in the issue body.** File paths and line numbers rot the moment someone refactors. Issues describe *what behavior is wrong* and *what behavior is expected* — the `/tdd` cycle later figures out where to make the change.

## Anti-Patterns

**DO NOT fix in-place during /debug.** Even one-line fixes go through the issue → /tdd loop. Skipping the issue means no test, no durable record, no audit trail when the same bug returns six months later. The cost of filing one extra issue is small; the cost of an undocumented silent fix compounds.

**DO NOT include file paths or line numbers in the issue body.** They couple the issue to current layout. Describe modules, behaviors, and contracts. Example: ✅ "the digest skill must write an outcome-log entry on early failure" / ❌ "edit `SKILL.md` line 207 to add a try/except around Phase 1".

**DO NOT skip the explore step even when the cause seems obvious.** Brain-os bugs are usually multi-layer (e.g. SKILL.md says X, trigger prompt says Y, hook never fires Z). The explore step catches the layer you didn't think to check. A 3-minute Agent(Explore) call beats two days of patching the wrong layer.

**DO NOT investigate without spawning a subagent.** The investigation will read 20+ files. If the parent context loads them all, you blow past the smart zone and the fix-plan synthesis degrades. Use `Agent` with `subagent_type=Explore`; let it return a tight summary.

**DO NOT proceed to issue creation if the user input is ambiguous.** Ask ONE clarifying question if needed (`"What's the observed symptom?"` or `"When did you last see it work?"`). Two questions is one too many — start investigating after the first answer.

## Vault paths

- Issue tracker: `sonthanh/ai-brain` (per skill-process-pocock-adoption decision)
- Outcome log: `{vault}/daily/skill-outcomes/debug.log`
- Recent commits scope: `git log` on the affected source repo

## Workflow

### 1. Capture [deterministic, ≤1 question]

Read the user's bug report. If it's missing the observable symptom (what they see vs what they expect), ask ONE question. Otherwise start investigating.

Record three things in working memory:
- **Symptom** — what the user observes (or doesn't observe, e.g. "no email arrives")
- **Expected** — what should happen
- **Affected artifact** — best guess at the skill / script / hook / cron / plist involved

If the affected artifact is unclear, the investigation is broader; don't narrow it prematurely.

### 2. Investigate via Agent(Explore) [latent, parallelizable]

Spawn a subagent with `subagent_type=Explore` and brief it on the brain-os investigation surface. The subagent must check **all** of the following layers, not just code:

| Layer | What to check |
|-------|---------------|
| **Source repo** | The skill's `SKILL.md`, related scripts, hooks, references. Look for: assumptions that don't hold in the actual run env, missing diagnostic logging, silent-failure paths, unresolved `{vault}` or `{plugin}` placeholders. |
| **Config** | `~/.claude/settings.json` (`enabledPlugins`, `permissions`, `hooks`), plugin's `hooks/hooks.json`, `.claude-plugin/plugin.json`. |
| **Cloud RemoteTrigger** | If the artifact is cron-driven, `RemoteTrigger list` + `get` on the relevant trigger. Check `enabled`, `cron_expression`, `allowed_tools`, `mcp_connections.permitted_tools`, `enabled_plugins`, `sources`, `allow_unrestricted_git_push`. |
| **Local launchd** | `~/Library/LaunchAgents/com.brain.*.plist` if a local cron is suspected. `launchctl list | grep brain`. |
| **Vault state** | State files (`state.json`, `*.cache`), recent outcome-log entries (`{vault}/daily/skill-outcomes/{skill}.log`), trace files (`{vault}/daily/skill-traces/{skill}.jsonl`), any "last run" markers the artifact maintains. |
| **Recent commits** | `git log --since="30 days ago"` on the source repo, restricted to the affected files. New commits = likely regression introduction point. |
| **MCP availability** | `ToolSearch` for any MCP tools the SKILL.md assumes exist (Gmail, Drive, etc.). If SKILL.md says "send via Gmail" but the run env has no Gmail tool, that's a layer gap. |

Brief the subagent like a smart colleague: include the symptom, the expected behavior, the affected-artifact best-guess, and the layers above. Ask for a tight summary that names:

- **Where** the bug manifests (which layer, which call, which path)
- **What** code/config path is involved (described as behavior, not file:line)
- **Why** it fails (root cause, not symptom)
- **What** related working patterns exist nearby (so the fix has a known-good shape to copy)

### 3. Identify root cause [latent]

Synthesize the explore output. The output must answer:

- Is this a **regression** (worked before, broken by recent change), a **missing capability** (never implemented), a **spec gap** (SKILL.md is silent about a path that the run actually traverses), or a **plumbing mismatch** (skill correct in isolation but cloud env / hook / launchd doesn't deliver the inputs it expects)?
- What is the **minimal observable** that would confirm the fix landed? This becomes the issue's `Observable:` field.

If the explore came back vague ("could be one of three things"), do NOT file the issue — re-spawn Explore with a tighter brief on the candidate layers, or ask the user one targeted question. Filing a vague issue means /tdd flails.

### 4. Design the /tdd RED-GREEN plan [latent]

Produce a numbered list of **vertical-slice tracer-bullet** RED-GREEN cycles. Each cycle:

```
N. RED: Write a test that <describes broken behavior in observable terms>
   GREEN: <Minimal change to make the test pass — described as behavior, not code>
```

Rules from Pocock + brain-os to-issues:

- **One test, one impl, one cycle.** Never bundle multiple behaviors into one cycle.
- **Tests verify behavior through public interfaces.** A skill's "interface" is the user-visible surface it produces (a vault file, a log line, a slash-command output, an email arrival).
- **Each cycle survives internal refactors.** "the skill writes brief.md to weekly/YYYY-WW/" survives; "the skill calls `write_brief()`" doesn't.
- **Add a final REFACTOR step** only when the green-path code will obviously want extraction once tests pass. If unsure, omit it — premature refactor steps clutter the plan.

For brain-os artifact types, the test-command shape comes from `/tdd` Test Commands by Artifact Type table:
- Skill spec change → `/eval <skill>` (static doc check) AND a behavioral test invoking the skill on a fixture
- Hook → `echo '{json}' | bash hook.sh; check exit code`
- Cron / launchd → `plutil -lint plist` + a synthetic invocation that proves the wiring
- Cloud RemoteTrigger → `RemoteTrigger run` + observable check (commit landed? log line written? email sent?)

### 5. File the GH issue [deterministic]

Run `gh issue create -R sonthanh/ai-brain` with:

**Title** — short imperative, ≤70 chars: `Fix silent geo-digest cron — outcome-log + path resolution`

**Labels** (apply all that fit):
- `area:plugin-<name>` (e.g. `area:plugin-brain-geo-analysis`, `area:plugin-brain-os`, `area:vault`)
- `priority:p1|p2|p3|p4` — match severity to user-observable cost
- `status:ready` — debug always files as ready (not blocked) since investigation is complete
- `owner:bot` (AFK, default) or `owner:human` (HITL, only when the fix needs human judgment — design choices, sensitive content)
- `weight:quick` (≤30 min /tdd cycle) or `weight:heavy` (1 h+)
- `kind:bug` (always for /debug output, distinguishing from feature work)

**Body** (template below) — describe behaviors only, no file paths or line numbers:

```markdown
## Problem

**Symptom:** <what the user observes>
**Expected:** <what should happen>
**Affected artifact:** <skill / script / hook / cron — by name, not path>

## Root Cause

<2–4 sentences. The layer (code / config / cloud / state / plumbing). The behavior that fails. The reason. Do NOT cite file paths or line numbers — describe the behavior gap.>

## /tdd Fix Plan

1. **RED:** <observable behavior the skill currently fails>
   **GREEN:** <minimal change in behavior to make the test pass>

2. **RED:** ...
   **GREEN:** ...

(Optional) **REFACTOR:** <cleanup needed once tests pass — only if obvious>

## Acceptance Criteria

- [ ] <Observable surface 1 (e.g. "outcome-log entry written for every run, even when Phase 1 fails")>
- [ ] <Observable surface 2>
- [ ] All new tests pass under the test command for this artifact type
- [ ] No regression on existing evals / tests

## Files (declared)

- <list relative paths the slice expects to touch — for /impl --parallel disjoint-files validator>

## Observable

<one line — the user-visible surface that, if it shows up, proves the fix landed. Required by tracer-bullet hard gate.>
```

After `gh issue create`, capture the issue number and URL. Print the URL on its own line so the user can click it.

### 6. Outcome log [deterministic]

Append per skill-spec.md § 11:

```
{date} | debug | triage | ~/work/brain-os-plugin | issue:{N} | commit:N/A | {result} | args="{symptom}" | issue=N
```

- `result`:
  - `pass` — issue filed with concrete root cause + RED-GREEN plan, AND no clarifying re-grill needed
  - `partial` — issue filed but the explore came back ambiguous; root cause stated as "most likely X, possibly Y" and plan is best-effort
  - `fail` — investigation could not converge on a root cause; user must provide more context before re-running

## When NOT to use /debug

- **One-line typos in vault docs** → just edit them directly. /debug is for behavior gaps, not typos.
- **Brand new skill with no prior version** → if there's no "expected" baseline, the work is `/grill` + `/to-issues`, not `/debug`.
- **The user already has a complete root-cause + fix plan** in their head → file the issue manually with `gh issue create` and skip /debug; the explore step would be wasted.
- **Regression in code you wrote in this session** → just re-read what you changed; /debug's cross-layer Explore is overkill for a 5-minute-old bug.

## Outcome log

Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/debug.log`:

```
{date} | debug | triage | ~/work/brain-os-plugin | issue:{N} | commit:N/A | {result} | args="{symptom-headline}" | issue=N
```
