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

**DO NOT slice grills that haven't been audited at /grill end-step.** The story-tier defensibility model relies on /grill's end-step audit recommendation menu (D1 of grill `daily/grill-sessions/2026-05-06-pre-grill-defensibility.md`, child #3 of ai-brain#253) to catch principle violations BEFORE the source enters /slice. Slicing an unaudited grill — one whose lock did not display the `Audit recommendation: /audit --all` menu and require explicit acknowledgement — re-creates the failure mode that produced 14+ closed meta-refactor issues in 48h under the OLD P1+P2 hard-gate-here regime (retired 2026-05-06, see `## Changelog`). If the source grill predates the end-step audit menu, run `/audit --all` on it manually before invoking /slice; if /audit flags FAIL on any principle, re-grill or amend before slicing. Trust shifted upstream — /slice now consumes audited grills, it does not re-audit them.

## Workflow

### 1. Gather context [deterministic]

Determine the input source:

- **Grill-session file path** (most common): `daily/grill-sessions/<date>-<slug>.md`. Read it. Check `status:` frontmatter — must be `pass` / `settled` / `shipped` (not `working` / `draft`). If unsettled, STOP and ask the user to finish /grill.
- **Existing parent story issue number**: `gh issue view <N> -R sonthanh/ai-brain --json title,body,labels,comments`. Treat issue body + comments as the PRD; **skip Step 2.4 + 2.6** (parent already exists and is approved) and go straight to drafting children with `Parent: ai-brain#<N>` set to this number. **Verify `type:plan` is in the returned labels list — if missing, auto-add it via `gh issue edit <N> -R sonthanh/ai-brain --add-label "type:plan"` and surface a one-line note to the user.** No prompt, no flag — auto-add is the default. Rationale: `/impl story` (orchestrator at `scripts/run-story.ts`) refuses to drain any parent that lacks `type:plan` (`ERROR: parent #N lacks type:plan label`). Slice's whole job on this branch is preparing the parent for `/impl story` consumption; the label is a hard downstream requirement and slice is the seam where it gets attached. Manually-filed parents (filed without `create-task-issue.sh --type plan`) routinely lack the label — the new-parent path in Step 2.4 already passes `--type plan` to the central filer, so this verification is needed only on the existing-parent branch.
- **In-context plan**: if the conversation already contains a settled plan from this session, work from context. Confirm with the user that nothing earlier needs re-reading.

If the user passes neither a file path nor an issue number, ask which one. Do NOT guess.

### 1.6. E2E AC existence guardrail [deterministic]

**Purpose.** Story-tier grills must produce ≥1 live e2e acceptance criterion — a "runs against real test data, output empirically validated" bullet. Slicing a grill without any e2e AC is slicing alongside an unfalsifiable spec; downstream /impl story drains GREEN and the parent CLOSEs without ever executing the most architectural assumption. D7 (child #3 of ai-brain#253) puts this enforcement at /grill close-step; this guardrail is the slice-side belt-and-braces — catches grills that predate the /grill enforcement OR that bypass it via direct issue creation.

**Mechanism.** Step 1 already loaded source content (grill-session body OR existing parent issue body OR in-context plan) into conversation. Locate the source's `## Acceptance criteria` section (grill-session) or `## Acceptance` section (existing parent issue body). Count bullets carrying the `(LIVE E2E)` suffix or equivalent live-data marker. Canonical markers: `(LIVE E2E)`, `(integration)`, `(real data validation)`. Count detection is deterministic — match the markers literally; no LLM judgment.

```bash
e2e_count=$(echo "$ACCEPTANCE_SECTION" \
  | grep -cE '\(LIVE E2E\)|\(integration\)|\(real data validation\)')
```

**Verdict handling (deterministic).**

- **e2e_count ≥ 1** → continue to Step 2.
- **e2e_count == 0** AND source carries no bypass label → ABORT with the surfaced message:

```
ABORT: story-tier grill missing e2e AC — re-grill or label NOT-architectural to bypass.
```

**Bypass labels.** Two equivalent forms — either is sufficient:

1. `NOT-architectural` — grill-session frontmatter or label list explicitly declaring the grill has no architectural surface (pure reflection / strategic thinking / capability mapping).
2. `status:reflection` — grill frontmatter status per D7's enforcement format, equivalent to NOT-architectural for this gate's purposes.

Bypass detection:

```bash
echo "$SOURCE_FRONTMATTER_AND_LABELS" \
  | grep -qE 'NOT-architectural|status:\s*reflection'
```

User options on ABORT (re-run /slice after action):
1. Re-grill the source to add a `(LIVE E2E)` AC — smallest real test data, output empirically validated, not just spec-checked.
2. Add `NOT-architectural` to the grill frontmatter (legitimate for pure-reflection grills with no implementation surface) and re-run.
3. If the grill is post-D7 and is genuinely reflection-only, confirm `status:reflection` is in the frontmatter; the bypass should already be present.

PASS only continues. No `--force-no-e2e` override flag. The gate exists because story-tier work without empirical validation produced the 2026-05-04 Mode B replay miss (parent #237 / 8 children shipped on broken Stage-0 classifier assumption — caught only because the user manually replayed against live data).

### 2. Synthesize PRD [latent]

In conversation context — extract from the source:

- **User Story** — who, what outcome, why now
- **Settled Decisions** — stack, file paths, integration points, modes, naming, anything the grill locked in
- **Sub-issues** — placeholder only at this stage (`- [ ] TBD — children filed in Step 7`)
- **Acceptance** — story-level done criteria (the parent closes when these are satisfied AND all children close)
- **Out of Scope** — explicit list of what the plan deliberately does NOT cover
- **Open questions** — must be empty for AFK children; HITL children can carry one if it's the question the human is being pulled in to answer

If you cannot extract User Story / Settled Decisions / Acceptance / Out of Scope, the source is not settled enough → STOP and ask user to finish /grill.

### 2.4. File parent story issue [deterministic]

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

- [ ] **AC#1** — <story-level done criterion 1> — [evidence ↗](#issuecomment-PLACEHOLDER)
- [ ] **AC#2** — <story-level done criterion 2> — [evidence ↗](#issuecomment-PLACEHOLDER)

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

# Capture parent GraphQL node ID once — Step 6's addSubIssue mutation needs it
# as the issueId input for every child filed. One extra `gh issue view` here
# avoids re-fetching per child.
PARENT_NODE_ID=$(gh issue view "$PARENT_N" -R sonthanh/ai-brain --json id --jq .id)
```

Capture the returned parent URL + issue number AND `PARENT_NODE_ID` — needed for Step 2.6 (surface to user), Step 6 (child `## Parent` references AND `addSubIssue` mutation parent input), and Step 7 (parent body amend).

Acceptance bullets are emitted in the canonical bullet-AC + evidence-link format (`- [ ] **AC#N** — <criterion> — [evidence ↗](#issuecomment-PLACEHOLDER)`). The `#issuecomment-PLACEHOLDER` anchor stays in place until `/impl <N>` per-child posts the `Acceptance verified: AC#N — <evidence>` comment and Gate C in `scripts/run-story.ts` rewrites the URL. Format aligns with `references/ac-coverage-spec.md` § 3.1 — same regex (`ACCEPTANCE_AC_RE`) drives Step 2.5 coverage gate, Gate B/C parsing, and `tickAcceptance`.

### 2.5. AC coverage gate [deterministic]

**Purpose.** Prevent the parent story from shipping fake-done — children all CLOSED + tests green, but parent `## Acceptance` bullets literally never executed. The pre-rule failure mode (one prior story closed with all 13 children green but 6 parent AC bullets unverified — caches absent, integration tests SKIPPED) broke trust in the AFK pipeline. This gate is the design-time anchor of the three-gate doctrine (Gate A here; Gate B at `scripts/run-story.ts` `runPreCheck()`; Gate C at `scripts/run-story.ts` close-time).

**Required child shape.** Every child draft produced in Step 3 MUST carry a `## Covers AC` H2 section enumerating the parent AC bullet IDs it satisfies. Pure-component children (scaffolding, refactor, build wiring) carry the section with NO bullets — the empty form asserts intent per `references/ac-coverage-spec.md` § 1.1, distinguishing "this child is component" from "the filer forgot the section".

**When the gate fires.** At the Step 5 → Step 6 boundary — after the user has approved the slice breakdown via the quiz step and BEFORE any child issue is filed via `create-task-issue.sh`. The check requires drafts to exist, so it runs at the file-time boundary; Step 6 carries a forward reference back to this section.

**Mechanism.** Two regexes drive the check — both live in `references/ac-coverage-spec.md` § 3 and MUST NOT be duplicated here:

1. Parent body is already in conversation context from Step 2.4 / 2.6. Apply the **parent-AC regex** (`references/ac-coverage-spec.md` § 3.1) line-by-line to the parent body. Collect `parent_ac_set` = set of integer IDs and remember each ID's description (regex group 2) for the ABORT table.
2. For each approved child draft in conversation context, locate its `## Covers AC` section (header line `## Covers AC` until next `## ` H2 header or EOF). Apply the **child Covers-AC regex** (`references/ac-coverage-spec.md` § 3.2) line-by-line inside that section. Collect that child's `covers_set`. Empty section is legal and contributes the empty set.
3. Compute `covered = union(child.covers_set for child in drafts)`.
4. Compute `uncovered = parent_ac_set - covered`.
5. If `uncovered` is non-empty → ABORT. Emit the table below verbatim and STOP. Do NOT fall through to Step 6.

**ABORT output.** Print to the user with the exact shape:

```
ABORT: Step 2.5 AC coverage gate failed.

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

**Why mechanical, not advisory.** Asking the LLM "is each parent AC covered by some child?" papers over the check at slice-time when many drafts are in flight and easy to miscount. Two regexes plus a set difference are the deterministic pre-Step-6 contract — same deterministic-gate pattern as Step 1.6 (e2e AC existence guardrail) where counts/regexes drive the verdict and no LLM judgment intervenes. PASS only continues to Step 6.

### 2.6. Await PRD approval [latent]

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

### 4.5. Rung-0 e2e ordering [deterministic]

**Purpose.** Force the most architectural claim of the story to ship FIRST against minimal scaffolding so the abstract architecture is empirically validated before fan-out. If rung-0 ships GREEN, the rest of the children inherit a validated foundation; if rung-0 fails, downstream children are not yet committed and the architecture can be reframed cheaply. This complements Step 1.6 — Step 1.6 ensures an e2e AC EXISTS in the source; Step 4.5 ensures the child covering it ships FIRST.

**Mechanism.** After Step 4 validators pass and BEFORE the Step 5 quiz:

1. Re-parse the source's `## Acceptance criteria` (grill-session) or `## Acceptance` (existing parent issue body) — already loaded at Step 1 — for `(LIVE E2E)` markers (or equivalent live-data markers per Step 1.6's canonical list). Identify the AC IDs carrying the marker (the e2e AC set).
2. For each child draft (already in conversation context from Step 3), parse its `## Covers AC` section per `references/ac-coverage-spec.md` § 3.2. Build mapping `{ AC# → [covering child draft index, ...] }`.
3. Compute the rung-0 child:
   - **Single e2e AC** → rung-0 child is the unique child whose `## Covers AC` lists that AC#.
   - **Multiple e2e ACs all covered by the same child** → that child is rung-0.
   - **Multiple e2e ACs with different covering children** → rung-0 = the child covering the most-architectural e2e AC. LLM judgment at slice time; the choice MUST be surfaced in the Step 5 quiz so the user can override (`I picked #N as rung-0 because it covers AC#X — the load-bearing claim. Override?`).
4. Annotate the rung-0 child draft:
   - Set its `## Blocked by` section to `None — rung-0`.
   - Tag the breakdown table entry `rung:0` (visible in the Step 5 quiz output and the Step 8 final report table).
5. Annotate every OTHER child draft:
   - Override its `## Blocked by` to `ai-brain#<rung-0-child-N>` regardless of natural sibling dependencies. The rung-0 child is the architectural anchor; sibling-to-sibling deps only kick in AFTER rung-0 ships GREEN.
   - Placeholder `<rung-0-child-N>` resolves to the actual rung-0 issue number after Step 6 issue creation (rung-0 child is filed FIRST in the topological order so its real number is known when siblings are filed).

**Why all-children-blocked-by-rung-0 instead of natural deps.** The natural-dep DAG can have multiple sibling chains executing in parallel pre-rung-0. If rung-0 fails, those sibling chains have already burned work on a broken foundation. The all-blocked-by-rung-0 contract serializes the architecturally-load-bearing step first, paying the latency cost in exchange for cheap reframing if it falls. This is the slice-time mechanism behind the 2026-05-04 retrospective lesson: 8 children of #237 shipped before live-data validation caught the Stage-0 classifier was wrong.

**No-e2e bypass.** If Step 1.6 was bypassed via `NOT-architectural` / `status:reflection` (no e2e ACs exist), Step 4.5 also no-ops — there is no rung-0 to anchor the DAG. Children carry their natural dependency relations only. This keeps reflection-only grills (no implementation surface) from forcing artificial dep chains.

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

**Pre-condition.** The Step 2.5 AC coverage gate MUST have passed against the approved drafts before this step runs. If the gate ABORT'd, you are not here — the user amended drafts (added covering child / promoted component to live-AC / amended parent body) and re-ran /slice. Filing without 2.5 PASS would re-create the fake-done failure mode.

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

Then link the child to the parent via the `addSubIssue` GraphQL mutation. This populates GitHub's native sub-issues panel on the parent (progress bar + per-child status badges visible in the GitHub UI) AND provides the canonical discovery channel for `scripts/run-story.ts viewSubIssues()` (`gh api graphql` query, `subIssues(first:50){nodes{number}}`, run-story.ts:734). The parent node ID was captured once at Step 2.4; fetch each child's node ID inline:

```bash
CHILD_N="${CHILD_URL##*/}"
CHILD_NODE_ID=$(gh issue view "$CHILD_N" -R sonthanh/ai-brain --json id --jq .id)
gh api graphql \
  -f query='mutation($parent:ID!,$child:ID!){addSubIssue(input:{issueId:$parent,subIssueId:$child}){issue{number}}}' \
  -F parent="$PARENT_NODE_ID" \
  -F child="$CHILD_NODE_ID"
```

The `## Parent` body reference is the offline-readable text anchor that survives if the native sub-issue link is ever broken (manual edit, GraphQL deprecation). `## Blocked by` encodes topological order so `/impl story` knows which children are AFK-ready right now versus waiting for siblings.

### 7. Edit parent body — Sub-issues list + AC-to-child mapping [deterministic]

Once every child has been filed (with `addSubIssue` already called per Step 6), do TWO substitutions in the parent body via a single `gh issue edit --body` call:

```bash
gh issue view <parent-N> -R sonthanh/ai-brain --json body --jq .body > /tmp/parent-body.md
# 1. Substitute `## Sub-issues` placeholder with one bare line per child, topo order
# 2. Amend `## Acceptance` bullets with multi-cover `(also covered by ...)` notes
#    where ≥2 children declare the same AC# in their `## Covers AC` section
gh issue edit <parent-N> -R sonthanh/ai-brain --body "$(cat /tmp/parent-body.md)"
```

#### 7a. Sub-issues — list-only

Replace the `- [ ] TBD — children filed in Step 7` placeholder with one bare reference per child (no checkbox; native sub-issue panel drives status):

```
## Sub-issues

- #<child-1-N> — <child-1 title>
- #<child-2-N> — <child-2 title>
- #<child-3-N> — <child-3 title>
```

GitHub's native sub-issue panel (populated by Step 6's `addSubIssue` mutation) is the canonical source of child status — progress bar + per-child state badges visible in the parent's GitHub UI. The body Sub-issues section is the offline-readable text anchor: `scripts/run-story.ts viewSubIssues()` prefers the GraphQL `subIssues` query (`run-story.ts:734`, shipped in commit `9cf8ca4`), falling back to body-checklist parse (`parseChecklist`) only if the native list is empty. Removing the checkbox is consistent — there is nothing to tick on Sub-issues lines anymore (Acceptance ticks happen on bullet AC bullets via `tickAcceptance` from #221).

#### 7b. Acceptance — multi-cover annotation

For each filed child, parse its `## Covers AC` section per `references/ac-coverage-spec.md` § 1 to build an AC-to-child mapping (`{ AC#1: [#A], AC#2: [#B, #C], ... }`). Walk the parent's `## Acceptance` bullets and amend in place:

- **Single covering child** (mapping has one entry for AC#N): leave the bullet untouched. The `[evidence ↗](#issuecomment-PLACEHOLDER)` placeholder rewrites to the real evidence-comment URL when Gate C in `scripts/run-story.ts` runs.
- **Multi-cover** (mapping has ≥2 entries for AC#N): inject `(also covered by #M, #K)` between the requirement description and the evidence link. The placeholder still points to the *first* child's evidence comment. Example:

```
## Acceptance

- [ ] **AC#2** — Gate B blocks /impl story start (also covered by #B, #C) — [evidence ↗](#issuecomment-PLACEHOLDER)
```

- **Pure-component children** (`## Covers AC` H2 present but empty): contribute nothing to the mapping — they never name an AC# so they never appear in `(also covered by ...)`.

This mapping derivation MUST run after every child is filed (otherwise the `## Covers AC` data isn't available yet). It runs before any `/impl <N>` worker spawns, so multi-cover annotations are stable from the start of the drain.

Do NOT close the parent — it stays `status:in-progress` until /impl story finishes.

### 8. Report back [deterministic]

After the parent body is updated, print a summary table followed by the canonical next-step line:

```
Parent: ai-brain#<P> — <story title>

| # | Title | Type | Status | Blocked by |
|---|-------|------|--------|------------|
| 115 | Port /slice | AFK | ready | — |
| 116 | Port /impl (once) | AFK | blocked | #115 |
| ... |

Next: /impl story <parent-N>
```

The `Next: /impl story <parent-N>` line is canonical — it surfaces the orchestrator path that drives DAG drainage AND the parent-close trigger (Gate C in `scripts/run-story.ts`). Per-child invocations (`/impl <child-N>` or `/impl auto`) DO close their child but do NOT auto-close the parent unless the per-child parent-close trigger fires (`/impl <N>` queries `subIssuesSummary.completed == total` post-close — see `skills/impl/SKILL.md`). Recommending per-child as the default leaves stories stuck OPEN after all children close — the failure mode that motivated story #219.

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

## Changelog

### 2026-05-06 — D6 of ai-brain#253: P1+P2 hard gates retired, e2e-AC enforcement added

P1+P2 hard gates retired in favor of /grill end-step audit recommendation menu (D1, child #3 of ai-brain#253). Trust shifts upstream — /slice now consumes audited grills, doesn't re-audit them. Concretely:

- **Removed.** `### 1.5. P2 audit gate — Start with Why` and `### 2.4. P1 audit gate — First Principles`. Both gates greppped /audit's emitted summary table for FAIL/FLAG verdicts and ABORTed before continuing — the OLD ternary-collapses-to-binary contract. P1's calibrated failure modes referenced in the old prose (existing `owner:bot|human` gate covered 80% of the depth:leaf|trunk decision; 3-layer hybrid trunk gate when 2 false-positives both resolved by Layer 2 alone — Story #154; etc.) are preserved in `daily/grill-sessions/2026-04-27-slice-audit-gate-p1-p2.md` (the grill that ESTABLISHED the gates) and `daily/grill-sessions/2026-05-06-pre-grill-defensibility.md` (the grill that RETIRED them).
- **Added.** `### 1.6. E2E AC existence guardrail` (e2e AC must exist on the source, with `NOT-architectural` / `status:reflection` bypass) and `### 4.5. Rung-0 e2e ordering` (e2e AC's covering child ships first, all others blocked-by it). These complete D6's three-edit interlock.
- **Renumbered.** Steps 2.5/2.6/2.7 → 2.4/2.5/2.6 to fill the gap left by removed Step 2.4 (P1 audit gate). All cross-references in the SKILL.md prose updated to reflect the new numbering. The 1.x range keeps an intentional gap at 1.5 — the new e2e guardrail sits at 1.6 per the issue spec, since renumbering 1.x would have rippled into the test/eval shape regexes for no behavioral gain.
- **Anti-pattern reframed.** "DO NOT skip the P1/P2 audit gates (Steps 1.5 + 2.4)" replaced with "DO NOT slice grills that haven't been audited at /grill end-step." The failure mode the OLD anti-pattern guarded — 14+ closed meta-refactor issues in 48h while real backlog sat untouched — now belongs to /grill's end-step menu (D1). The empirical check that the new contract actually catches that failure mode is AC#7 of #253 (smoke against `daily/grill-sessions/2026-05-04-airtable-mode-b-replay.md`, child #254 — CLOSED 2026-05-06).
- **Bootstrap risk note.** The /slice run that produced the parent #253 + this child #258 still executed the OLD gates (Steps 1.5 + 2.4) because that's what the SKILL.md still said at the time — meta-step / eats own dogfood. Future /slice runs use this new contract.
