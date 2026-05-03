---
name: slice
description: "Break grill-session/plan/PRD thành parent story issue + child issues theo tracer-bullet vertical slices. Children có `## Parent` + `## Blocked by`. Use khi convert grill outcome thành AFK tickets, file vào sonthanh/ai-brain. Triggers: 'slice this', '/slice', 'break into issues'."
---

# /slice — Grill → Parent PRD Issue + Tracer-Bullet Children

Adapted from [@mattpocockuk/skills/to-issues](https://github.com/mattpocock/skills/tree/main/to-issues) and Pocock's `/write-a-prd` step. Reads a settled grill-session file (or in-context plan), synthesizes a PRD, files it as a **parent story issue body** on `sonthanh/ai-brain` with a placeholder children checklist, awaits user approval, then emits independently-grabbable child issues with `## Parent` + `## Blocked by` references and edits the parent body to fill the checklist with the actual child numbers + titles.

## Philosophy

**Tracer bullets, not horizontal layers.** Each child issue is a thin vertical slice that cuts end-to-end through every layer it touches. A completed slice is demoable on its own — produces an observable surface (slash command, cron tick, journal line, status section, hook output, log line). Prefer many thin slices over few thick ones.

**Many small issues > one big one.** A 5-acceptance-criterion issue that takes 2 hours produces compound errors that survive review. Five 1-criterion issues each take 25 minutes and each is independently verifiable. The whole point of the Pocock pipeline is that small slices force the discipline that big specs can't.

**PRD lives in the parent issue body.** /grill produces alignment; /slice synthesizes the PRD and persists it as the parent story issue body — not a vault doc. GitHub issue bodies are mutable, indexed, closeable, and reachable by `gh issue view`; a separate PRD file in the vault rots in isolation (Pocock's doc-rot principle, grill 2026-04-25 cross-cutting principles #6). The parent's Sub-issues checklist becomes the single source of truth that `/impl story <parent-N>` walks to drive DAG drainage.

**HITL vs AFK marking is load-bearing.** AFK (`owner:bot`) child issues can be grabbed by `/impl` autonomously. HITL (`owner:human`) issues require a person — typically architectural decisions, design reviews, or anything where the cost of being wrong exceeds the cost of waiting. **Prefer AFK** — but mark HITL when the slice genuinely needs human judgment. Mis-marking AFK as HITL slows throughput; mis-marking HITL as AFK ships bad decisions overnight.

## Anti-Patterns

**DO NOT persist the PRD as a separate vault file.** The PRD belongs in the parent issue body, not in `daily/prds/<slug>.md`. A vault file triggers doc-rot — future sessions read the stale PRD as canon when the parent issue (which closes when the story finishes) is the source of truth. /grill output is the alignment artifact; the parent issue is the PRD container; the children are the work artifact. Nothing else needs persisting.

**DO NOT skip the parent-issue review gate.** Synthesizing the PRD silently and going straight to child slices removes the user's last chance to revise the PRD before downstream issues encode it. The flow MUST be: file parent with PRD body → surface URL + N to user → await `approve` / `edit <section>` → only then emit children. Bypassing this step (filing children before parent is approved) is the same anti-pattern as bypassing the slice user-quiz, just one layer up.

**DO NOT skip the child-quiz step.** Going straight from parent-approved → direct issue creation (any path — inline `issue create` shell, or shelling `scripts/gh-tasks/create-task-issue.sh` directly without the quiz) for each child produces issues sized to the LLM's intuition, not the user's. The quiz step (numbered breakdown → user iterates → approved → file) is where slice granularity gets calibrated. Direct invocation after PRD approval — even when all details are crystallized in conversation context — counts as bypass; the user-quiz step is not optional.

**DO NOT create issues out of dependency order.** If child B is blocked by child A, create A first so B can reference A's real issue number in `## Blocked by`. Otherwise the dependency graph encodes placeholders that nobody updates.

**DO NOT silently re-grill.** If decisions in the grill-session aren't settled (questions unanswered, RESET sections still active, status frontmatter missing or `status: working`), STOP and tell the user to finish /grill first. Inferring missing decisions is how reactive-patch loops start.

**DO NOT skip the P1/P2 audit gates (Steps 1.5 + 2.4).** The gates exist to stop premature-optimization theater — ideas that mass-touch workflow/vault without a real problem to solve. PASS-only continues; FLAG and FAIL both abort, no override flag, no `--force-no-audit` shortcut. Settled in `daily/grill-sessions/2026-04-27-slice-audit-gate-p1-p2.md`. Bypassing either gate (commenting out the Skill invocation, ignoring the verdict, advancing past abort) is the same failure mode that produced 14+ closed meta-refactor issues in 48h while real backlog sat untouched.

## Workflow

### 1. Gather context [deterministic]

Determine the input source:

- **Grill-session file path** (most common): `daily/grill-sessions/<date>-<slug>.md`. Read it. Check `status:` frontmatter — must be `pass` / `settled` / `shipped` (not `working` / `draft`). If unsettled, STOP and ask the user to finish /grill.
- **Existing parent story issue number**: `gh issue view <N> -R sonthanh/ai-brain --json title,body,labels,comments`. Treat issue body + comments as the PRD; **skip Step 2.5 + 2.7** (parent already exists and is approved) and go straight to drafting children with `Parent: ai-brain#<N>` set to this number. **Verify `type:plan` is in the returned labels list — if missing, auto-add it via `gh issue edit <N> -R sonthanh/ai-brain --add-label "type:plan"` and surface a one-line note to the user.** No prompt, no flag — auto-add is the default. Rationale: `/impl story` (orchestrator at `scripts/run-story.ts`) refuses to drain any parent that lacks `type:plan` (`ERROR: parent #N lacks type:plan label`). Slice's whole job on this branch is preparing the parent for `/impl story` consumption; the label is a hard downstream requirement and slice is the seam where it gets attached. Manually-filed parents (filed without `create-task-issue.sh --type plan`) routinely lack the label — the new-parent path in Step 2.5 already passes `--type plan` to the central filer, so this verification is needed only on the existing-parent branch.
- **In-context plan**: if the conversation already contains a settled plan from this session, work from context. Confirm with the user that nothing earlier needs re-reading.

If the user passes neither a file path nor an issue number, ask which one. Do NOT guess.

### 1.5. P2 audit gate — Start with Why [deterministic]

**Purpose.** Stop premature-optimization theater at the source: ideas filed because tooling could be tweaked, not because a real user-observable problem broke. P2 (Start with Why) requires a named past incident or explicit current pain — forward-looking "pattern will repeat" framing fails this gate.

**Mechanism.** Step 1 already loaded source content (grill-session body OR existing parent issue body OR in-context plan) into conversation. Invoke `/audit p2` via the Skill tool — `/audit` reads conversation context per its own SKILL.md, so it operates on what Step 1 loaded. Audits run unconditionally across all 3 input modes (no skip conditions — in-context-plan is not an escape valve).

```
Skill: audit
args: p2
```

**Verdict handling (deterministic, no LLM judgment).** `/audit` emits a markdown summary table:

```
## Audit Summary
| Principle | Verdict | Key Finding |
|-----------|---------|-------------|
| P2 | PASS|FLAG|FAIL | … |
```

Detection:

```bash
echo "$AUDIT_OUTPUT" | grep -E '^\| P[0-9]+ \| (FAIL|FLAG) \|' && AUDIT_BLOCK=1
```

If any P2 row matches FAIL or FLAG → ABORT. Surface the table verbatim to the user, list the finding, and STOP. User options:
1. Re-grill the source to add a named historical incident in `## Why`.
2. Amend the source to remove the forward-looking framing.
3. Add explicit `## P2 — pre-positioning` admission section to the source declaring "no incident, accepting risk" (legitimate pre-positioning work like geo-prep, capability gaps surfaced by audit). Then re-run /slice.

PASS only → continue to Step 2. No override flag.

**Why hard block on FLAG too.** FLAG is "non-fatal concern, take action if applicable" — under load, FLAGs get rationalized into PASSes silently. Ternary collapses to binary at this gate. Hard rule, no exceptions.

### 2. Synthesize PRD [latent]

In conversation context — extract from the source:

- **User Story** — who, what outcome, why now
- **Settled Decisions** — stack, file paths, integration points, modes, naming, anything the grill locked in
- **Sub-issues** — placeholder only at this stage (`- [ ] TBD — children filed in Step 7`)
- **Acceptance** — story-level done criteria (the parent closes when these are satisfied AND all children close)
- **Out of Scope** — explicit list of what the plan deliberately does NOT cover
- **Open questions** — must be empty for AFK children; HITL children can carry one if it's the question the human is being pulled in to answer

If you cannot extract User Story / Settled Decisions / Acceptance / Out of Scope, the source is not settled enough → STOP and ask user to finish /grill.

### 2.4. P1 audit gate — First Principles [deterministic]

**Purpose.** Stop overcomplicated PRDs at the synthesis seam. P1 (First Principles / Simple scales) asks: (1) Is this the real problem or a symptom? (2) Does a solution already exist? (3) What's the simplest version? PRDs that propose new mechanisms when existing ones cover the failure mode, or stack layers anticipating edge cases that haven't happened, fail this gate.

**Mechanism.** PRD draft already lives in conversation context from Step 2 synthesis. Invoke `/audit p1` via the Skill tool.

```
Skill: audit
args: p1
```

**Verdict handling.** Same ternary-to-binary contract as Step 1.5:

```bash
echo "$AUDIT_OUTPUT" | grep -E '^\| P[0-9]+ \| (FAIL|FLAG) \|' && AUDIT_BLOCK=1
```

FAIL or FLAG → ABORT. Surface the table verbatim, list the finding, STOP. User amends the draft (collapse touch points, drop premature layers, cite existing mechanism) and re-runs /slice. PASS → continue to Step 2.5.

**Common P1 failure modes (calibrated by tracker history):**
- New mechanism wrapping an existing skill (build `audit-gate.ts` when `/audit` already does the work — tracker line 65 / this very session)
- Anticipated edge cases without a current incident (3-layer hybrid trunk gate when 2 false-positives both resolvable by Layer 2 alone — Story #154)
- Refactor scope ballooning from a single root-cause fix (label taxonomy 6-children when fixing #137 alone sufficed — Story #153)
- Path-list / namespace expansion duplicating existing rubric (depth:leaf|trunk new label namespace when `owner:bot|human` already gates 80% — tracker line 64, killed by P1 mid-grill)

If the PRD draft fits any of these patterns, FLAG/FAIL is the expected verdict. Amend or split before proceeding.

### 2.5. File parent story issue [deterministic]

File the parent story issue on `sonthanh/ai-brain` with the synthesized PRD as the body via the central filer (`create-task-issue.sh`), then flip to `status:in-progress` via the central transitioner (`transition-status.sh`). Two calls because the helper rejects `in-progress` as a creation status (creation accepts `ready|blocked|backlog`); a fresh parent enters active state the moment it's filed because work begins immediately on PRD approval. Labels carried: `type:plan`, `owner:human`, `status:in-progress` (after flip), area inherited from the grill scope (e.g. `plugin-brain-os`), priority + weight inherited from the grill's overall framing.

```bash
PARENT_URL=$(bash "$CLAUDE_PLUGIN_ROOT/scripts/gh-tasks/create-task-issue.sh" \
  --title "Story: <imperative — what this story delivers>" \
  --body "$(cat <<'EOF'
## User Story

<who · what outcome · why now>

## Settled Decisions

- <stack / file path / integration point>
- <mode / naming / interface>
- <anything the grill locked in>

## Sub-issues

- [ ] TBD — children filed in Step 7

## Acceptance

- [ ] <story-level done criterion 1>
- [ ] <story-level done criterion 2>

## Out of Scope

- <explicit non-goal>

## Open questions

<empty for fully-settled stories; otherwise list the questions blocking child creation>
EOF
)" \
  --area "<area>" \
  --owner human \
  --priority "<p1|p2|p3>" \
  --weight "<quick|heavy>" \
  --status ready \
  --type plan)

PARENT_N="${PARENT_URL##*/}"
bash "$CLAUDE_PLUGIN_ROOT/scripts/gh-tasks/transition-status.sh" "$PARENT_N" --to in-progress
```

Capture the returned parent URL + issue number — needed for both Step 2.7 (surface to user) and Step 6 (child `## Parent` references).

### 2.6. AC coverage gate [deterministic]

**Purpose.** Prevent the parent story from shipping fake-done — children all CLOSED + tests green, but parent `## Acceptance` bullets literally never executed. The pre-rule failure mode (one prior story closed with all 13 children green but 6 parent AC bullets unverified — caches absent, integration tests SKIPPED) broke trust in the AFK pipeline. This gate is the design-time anchor of the three-gate doctrine (Gate A here; Gate B at `scripts/run-story.ts` `runPreCheck()`; Gate C at `scripts/run-story.ts` close-time).

**Required child shape.** Every child draft produced in Step 3 MUST carry a `## Covers AC` H2 section enumerating the parent AC bullet IDs it satisfies. Pure-component children (scaffolding, refactor, build wiring) carry the section with NO bullets — the empty form asserts intent per `references/ac-coverage-spec.md` § 1.1, distinguishing "this child is component" from "the filer forgot the section".

**When the gate fires.** At the Step 5 → Step 6 boundary — after the user has approved the slice breakdown via the quiz step and BEFORE any child issue is filed via `create-task-issue.sh`. Section is numbered 2.6 to group with the other deterministic gates (1.5, 2.4); the actual check requires drafts to exist, so it runs at the file-time boundary. Step 6 carries a forward reference back to this section.

**Mechanism.** Two regexes drive the check — both live in `references/ac-coverage-spec.md` § 3 and MUST NOT be duplicated here:

1. Parent body is already in conversation context from Step 2.5 / 2.7. Apply the **parent-AC regex** (`references/ac-coverage-spec.md` § 3.1) line-by-line to the parent body. Collect `parent_ac_set` = set of integer IDs and remember each ID's description (regex group 2) for the ABORT table.
2. For each approved child draft in conversation context, locate its `## Covers AC` section (header line `## Covers AC` until next `## ` H2 header or EOF). Apply the **child Covers-AC regex** (`references/ac-coverage-spec.md` § 3.2) line-by-line inside that section. Collect that child's `covers_set`. Empty section is legal and contributes the empty set.
3. Compute `covered = union(child.covers_set for child in drafts)`.
4. Compute `uncovered = parent_ac_set - covered`.
5. If `uncovered` is non-empty → ABORT. Emit the table below verbatim and STOP. Do NOT fall through to Step 6.

**ABORT output.** Print to the user with the exact shape:

```
ABORT: Step 2.6 AC coverage gate failed.

Uncovered parent ## Acceptance bullets:

| AC | Description |
|----|-------------|
| AC#<N> | <description from parent-AC regex group 2> |
| AC#<M> | <description> |

User options (re-run /slice after action):
  1. Add a covering child draft (carry `## Covers AC` with the missing AC#).
  2. Promote an existing component child draft to live-AC by adding the bullet to its `## Covers AC`.
  3. Amend parent body to drop the orphan AC bullet (re-grill if scope changes).
```

The three options come straight from the parent-story settled decisions (`references/ac-coverage-spec.md` cross-references). They are the only legitimate paths forward — there is no `--force-no-coverage` override flag, no advisory soft-fail, no "we'll cover it later" promise. The gate exists because trust was broken; an override re-creates the failure surface.

**Why mechanical, not advisory.** Asking the LLM "is each parent AC covered by some child?" papers over the check at slice-time when many drafts are in flight and easy to miscount. Two regexes plus a set difference are the deterministic pre-Step-6 contract — same pattern as the audit gates (§§ 1.5, 2.4). PASS only continues to Step 6.

### 2.7. Await PRD approval [latent]

Surface the parent issue URL + number to the user verbatim:

```
Filed parent story: ai-brain#<N> — <title>
URL: https://github.com/sonthanh/ai-brain/issues/<N>

Review the PRD body now. Reply:
  approve            — proceed to slice into child issues
  edit <section>     — revise that section before children are filed
```

Do NOT proceed until the user explicitly says `approve`. On `edit <section>`: revise the named section in conversation context, push the new body via `gh issue edit <N> -R sonthanh/ai-brain --body "<new body>"`, surface the updated URL again, and re-prompt. Iterate until approval.

This is the parent-issue review gate — the user's last chance to revise the PRD before downstream children encode it.

### 3. Draft vertical slices [latent]

**Slice budget — adjust for input type.** Tracer-bullet default (5-10 slices) assumes greenfield development with unknowns. For grilled config / maintenance / skill-modification work where unknowns are resolved by the grill, use **2-4 slices**. Group by area-label + dependency-cluster, not by single-layer concern.

- **Heuristic:** grill title contains `fix` / `modify` / `config` / `expand` / `refactor` / `cleanup` / `hygiene` / `audit` → maintenance budget. Contains `build` / `create` / `new` / `introduce` / `design` / `port` → greenfield budget. Ambiguous → ask user once, default to maintenance (coarser is safer; merging issues is harder than splitting them).
- **HITL/AFK default flip:** when grill is `status: pass` AND work is skill modification → default to **AFK** (the grill replaces pickup's `owner:human` "needs grill before exec" gate). Mark HITL only when the issue body carries an unresolved design question.

Break the PRD into tracer-bullet child issues. For each slice, decide:

| Field | What it captures |
|-------|------------------|
| Title | Short imperative — `Port /slice skill (Phase B of Pocock skill-process adoption)` |
| Type | HITL (`owner:human`) or AFK (`owner:bot`). Default AFK; promote to HITL only when human judgment is needed |
| Area label | `area:plugin-brain-os` / `area:vault` / `area:plugin-<name>` — which code repo this touches |
| Priority | `priority:p1` (urgent) / `priority:p2` (high) / `priority:p3` (medium) — `p4` retired; use `status:backlog` instead |
| Weight | `weight:quick` (≤30 min) / `weight:heavy` (1h+) |
| Status | `status:ready` (no blockers) / `status:blocked` (waiting on another slice) / `status:backlog` (later phase) |
| Files | List of relative paths the slice will touch (warn-soft validator — see § 4) |
| Observable | The user-visible surface this slice produces (HARD GATE — see § 4) |
| Blocked by | List of slice numbers (during quiz) → real issue numbers (after creation) |

### 4. Validate slices [deterministic]

Before showing the breakdown to the user, run two validators on each slice:

**Tracer-bullet (HARD GATE):** the slice MUST declare an `Observable:` — at least one of: a slash command output, a cron tick log line, a journal section, a /status display, a hook stdout/exit-code change, a vault file the user can read. If a slice cannot point to an observable surface, it's a horizontal slice (one layer) — split it differently or merge it with the slice that completes the path.

**Disjoint-files (WARN-SOFT):** if two slices declare overlapping `Files:`, flag it. They can still ship — `/impl -p N` (alias `--parallel N`) uses Agent-tool worktree isolation so file conflicts resolve at merge time. But surfacing the overlap helps the user decide if a merge would be cleaner than parallel work.

### 5. Quiz the user [latent]

Open with the detected budget: `I detected this as <maintenance|greenfield>; proposing N slices. Push back on the budget first if wrong, then on individual slice details.`

Present the proposed breakdown as a numbered list. For each slice show: Title / Type / Area / Priority / Weight / Files / Observable / Blocked by.

Then ask:

- Granularity: too coarse / too fine?
- Dependencies correct?
- HITL/AFK assignments correct?
- Any slices to merge or split?

Iterate until the user approves. Do NOT proceed to issue creation while the user is still iterating.

### 6. Create child issues in dependency order [deterministic]

**Pre-condition.** The Step 2.6 AC coverage gate MUST have passed against the approved drafts before this step runs. If the gate ABORT'd, you are not here — the user amended drafts (added covering child / promoted component to live-AC / amended parent body) and re-ran /slice. Filing without 2.6 PASS would re-create the fake-done failure mode.

For each approved child slice, in topological order (blockers first), run the central filer — every label axis is validated against canon (see `references/gh-task-labels.md` § 1):

```bash
CHILD_URL=$(bash "$CLAUDE_PLUGIN_ROOT/scripts/gh-tasks/create-task-issue.sh" \
  --title "<Title>" \
  --body "$(cat <<'EOF'
## Parent

- ai-brain#<parent-issue-number>

## What to build

<End-to-end behavior — not layer-by-layer implementation.>

## Acceptance

- [ ] <criterion 1 — must be testable / observable>
- [ ] <criterion 2>
- [ ] <criterion 3>

## Files

- <relative/path/to/touched/file>
- <relative/path/to/another>

## Observable

<The user-visible surface this slice produces — slash command, journal line, /status section, etc.>

## Blocked by

- ai-brain#<M>

(or `None — can start immediately`)
EOF
)" \
  --area "<area>" \
  --owner "<bot|human>" \
  --priority "<p1|p2|p3>" \
  --weight "<quick|heavy>" \
  --status "<ready|blocked|backlog>")
```

After each call, capture the returned child issue number from `CHILD_URL` (e.g. `CHILD_N="${CHILD_URL##*/}"`). Subsequent children that reference this one in `## Blocked by` get the real number substituted in. `priority:p4` was retired — drop low-urgency children to `status:backlog` instead of inventing a new priority axis.

The `## Parent` reference is what makes the child reachable from the parent's checklist (which `/impl story` reads to drive DAG drainage). The `## Blocked by` section encodes topological order so `/impl story` can identify which children are AFK-ready right now versus waiting for siblings.

### 7. Edit parent body — fill the children checklist [deterministic]

Once every child has been filed and you have the full ordered list of child numbers + titles, replace the placeholder Sub-issues section in the parent body:

```bash
gh issue view <parent-N> -R sonthanh/ai-brain --json body --jq .body > /tmp/parent-body.md
# Substitute the `## Sub-issues` section content with one line per child, topo order
# - [ ] ai-brain#<child-N> — <child title>
gh issue edit <parent-N> -R sonthanh/ai-brain --body "$(cat /tmp/parent-body.md)"
```

The substituted section MUST look like:

```
## Sub-issues

- [ ] ai-brain#<child-1-N> — <child-1 title>
- [ ] ai-brain#<child-2-N> — <child-2 title>
- [ ] ai-brain#<child-3-N> — <child-3 title>
```

This is load-bearing for `/impl story <parent-N>` — that skill parses exactly this checklist to discover children, builds the DAG from each child's `## Blocked by`, drains the story, and ticks each line `- [ ]` → `- [x]` on close. Without the auto-fill, /impl story has nothing to walk.

Do NOT close the parent — it stays `status:in-progress` until /impl story finishes.

### 8. Report back [deterministic]

After the parent body is updated, print a summary table:

```
Parent: ai-brain#<P> — <story title>

| # | Title | Type | Status | Blocked by |
|---|-------|------|--------|------------|
| 115 | Port /slice | AFK | ready | — |
| 116 | Port /impl (once) | AFK | blocked | #115 |
| ... |
```

Then append to the grill-session file (if input was a grill-session): `## Issues filed (YYYY-MM-DD)` listing the parent number + child numbers and their statuses. This is the only vault-side persistence — links from the grill to the resulting issues, no PRD copy.

## When NOT to use /slice

- **Single bug fix** → file directly with `bash "$CLAUDE_PLUGIN_ROOT/scripts/gh-tasks/create-task-issue.sh" ...`. /slice is overhead for a one-issue plan.
- **Exploratory grill where decisions aren't settled** → finish /grill first. /slice will (and should) refuse to slice an unsettled plan.
- **The plan IS one slice** → file it directly. Don't manufacture sub-issues to satisfy "many thin slices" — that's just paperwork.
- **Cosmetic / typo / config tweak** → direct edit + push. The Pocock pipeline is for behavior changes, not chore commits.

## Outcome log

Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/slice.log`:

```
{date} | slice | {action} | ~/work/brain-os-plugin | daily/grill-sessions/{date}-{slug}.md | commit:{hash} | {result}
```

- `action`: `slice` (normal grill → parent + child issues path) or `re-slice` (user requested merge / split of issues already filed today)
- `result`: `pass` if no slice gets re-split / re-merged via reactive `improve: encoded feedback —` or follow-up `gh issue edit` within 48h. `partial` if user merged or split 1–2 slices mid-quiz before approval. `fail` if breakdown was rejected entirely or user re-grilled.
- Optional: `args="<grill-session-slug>"`, `corrections=N`, `score=N` (children created), `parent=ai-brain#<P>`

The 48h-no-reactive-resplit criterion is the discipline test for /slice, mirroring /tdd's. If issues stay stable post-creation, the slice-quality assumption holds. If users keep splitting / merging issues after the fact, /slice's breakdown logic needs a `/improve` cycle.
