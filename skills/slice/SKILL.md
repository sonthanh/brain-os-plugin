---
name: slice
description: "Break a settled grill-session, plan, or PRD into a parent story issue (PRD body, awaits user approval) plus independently-grabbable child issues using tracer-bullet vertical slices. Children carry `## Parent` + `## Blocked by` references; parent body holds the auto-filled sub-issues checklist that /impl story walks for DAG drainage. Use when user wants to convert a grill outcome into AFK/HITL implementation tickets, file slices to sonthanh/ai-brain, or break a plan down for parallel execution. Triggers: 'slice this plan', 'break into issues', '/slice', 'file as issues', 'to issues' (legacy)."
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

## Workflow

### 1. Gather context [deterministic]

Determine the input source:

- **Grill-session file path** (most common): `daily/grill-sessions/<date>-<slug>.md`. Read it. Check `status:` frontmatter — must be `pass` / `settled` / `shipped` (not `working` / `draft`). If unsettled, STOP and ask the user to finish /grill.
- **Existing parent story issue number**: `gh issue view <N> -R sonthanh/ai-brain --json title,body,labels,comments`. Treat issue body + comments as the PRD; **skip Step 2.5 + 2.7** (parent already exists and is approved) and go straight to drafting children with `Parent: ai-brain#<N>` set to this number.
- **In-context plan**: if the conversation already contains a settled plan from this session, work from context. Confirm with the user that nothing earlier needs re-reading.

If the user passes neither a file path nor an issue number, ask which one. Do NOT guess.

### 2. Synthesize PRD [latent]

In conversation context — extract from the source:

- **User Story** — who, what outcome, why now
- **Settled Decisions** — stack, file paths, integration points, modes, naming, anything the grill locked in
- **Sub-issues** — placeholder only at this stage (`- [ ] TBD — children filed in Step 7`)
- **Acceptance** — story-level done criteria (the parent closes when these are satisfied AND all children close)
- **Out of Scope** — explicit list of what the plan deliberately does NOT cover
- **Open questions** — must be empty for AFK children; HITL children can carry one if it's the question the human is being pulled in to answer

If you cannot extract User Story / Settled Decisions / Acceptance / Out of Scope, the source is not settled enough → STOP and ask user to finish /grill.

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

Before showing the breakdown to the user, run three validators on each slice:

**Tracer-bullet (HARD GATE):** the slice MUST declare an `Observable:` — at least one of: a slash command output, a cron tick log line, a journal section, a /status display, a hook stdout/exit-code change, a vault file the user can read. If a slice cannot point to an observable surface, it's a horizontal slice (one layer) — split it differently or merge it with the slice that completes the path.

**Disjoint-files (WARN-SOFT):** if two slices declare overlapping `Files:`, flag it. They can still ship — `/impl -p N` (alias `--parallel N`) uses Agent-tool worktree isolation so file conflicts resolve at merge time. But surfacing the overlap helps the user decide if a merge would be cleaner than parallel work.

**Trunk-paths (HARD GATE on `owner:bot`):** for any slice tentatively marked `owner:bot`, run its declared `Files:` paths through the trunk-paths matcher:

```bash
printf '%s\n' <files...> | bash "$CLAUDE_PLUGIN_ROOT/scripts/check-trunk-paths.sh"
```

Exit code semantics: `0` = no matches → keep `owner:bot`; `1` = at least one match → BLOCK `owner:bot`; force `owner:human` and surface the matched paths to the user during quiz step. Stdout is tab-separated `<path>\t<matched-pattern>` per hit.

Why mechanical, not advisory: the rubric (`references/trunk-paths.txt`) covers Schluntz's trunk class — `CLAUDE.md`, hooks, MEMORY, RESOLVER, cross-skill primitives, public-plugin leak surface — and an LLM asking "does this touch trunk?" papers over it during quick slicing. Source: [grill 2026-04-26](daily/grill-sessions/2026-04-26-depth-leaf-trunk-design.md), audited via P1.

Override: if the user judges a flagged slice is genuinely leaf despite the path match (e.g. a CLAUDE.md typo fix), they remove the trunk-path file from `Files:` — that re-classification is itself a trunk decision and gets surfaced for confirmation rather than silently bypassed.

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
