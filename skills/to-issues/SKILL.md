---
name: to-issues
description: "Break a settled grill-session, plan, or PRD into independently-grabbable GitHub issues using tracer-bullet vertical slices. Use when user wants to convert a grill outcome into AFK/HITL implementation tickets, file slices to sonthanh/ai-brain, or break a plan down for parallel execution. Triggers: 'to issues', 'slice this plan', 'break into issues', '/to-issues', 'file as issues'."
---

# /to-issues — Grill → Tracer-Bullet GitHub Issues

Adapted from [@mattpocockuk/skills/to-issues](https://github.com/mattpocock/skills/tree/main/to-issues). Reads a settled grill-session file (or in-context plan), synthesizes a PRD **internally** (never persisted — doc-rot risk), and emits independently-grabbable issues to `sonthanh/ai-brain` with proper labels and dependency notation.

## Philosophy

**Tracer bullets, not horizontal layers.** Each issue is a thin vertical slice that cuts end-to-end through every layer it touches. A completed slice is demoable on its own — produces an observable surface (slash command, cron tick, journal line, status section, hook output, log line). Prefer many thin slices over few thick ones.

**Many small issues > one big one.** A 5-acceptance-criterion issue that takes 2 hours produces compound errors that survive review. Five 1-criterion issues each take 25 minutes and each is independently verifiable. The whole point of the Pocock pipeline is that small slices force the discipline that big specs can't.

**PRD stays in your head.** /grill produces alignment, not a written plan asset. /to-issues synthesizes the PRD in conversation context to drive the breakdown, then throws it away. Persisting the PRD as a separate file creates "sediment" — future sessions read stale plans as canon (Pocock's doc-rot principle, grill 2026-04-25 cross-cutting principles #6).

**HITL vs AFK marking is load-bearing.** AFK (`owner:bot`) issues can be grabbed by `/impl` autonomously. HITL (`owner:human`) issues require a person — typically architectural decisions, design reviews, or anything where the cost of being wrong exceeds the cost of waiting. **Prefer AFK** — but mark HITL when the slice genuinely needs human judgment. Mis-marking AFK as HITL slows throughput; mis-marking HITL as AFK ships bad decisions overnight.

## Anti-Patterns

**DO NOT persist the PRD as a separate file.** The PRD is a synthesis tool, not a deliverable. Persisting it triggers doc-rot — future sessions treat the stale PRD as canon when the issues themselves should be the source of truth. /grill output is the alignment artifact; the issues are the work artifact; nothing in between needs a file.

**DO NOT skip the user-quiz step.** Going straight from grill-session → `gh issue create` produces issues sized to the LLM's intuition, not the user's. The quiz step (numbered breakdown → user iterates → approved → file) is where slice granularity gets calibrated. Direct invocation via `gh issue create` after a grill closes — even when all details are crystallized in conversation context — counts as bypass; the user-quiz step is not optional.

**DO NOT create issues out of dependency order.** If issue B is blocked by A, create A first so B can reference A's real issue number in `Blocked by #N`. Otherwise the dependency graph encodes placeholders that nobody updates.

**DO NOT silently re-grill.** If decisions in the grill-session aren't settled (questions unanswered, RESET sections still active, status frontmatter missing or `status: working`), STOP and tell the user to finish /grill first. Inferring missing decisions is how reactive-patch loops start.

## Workflow

### 1. Gather context [deterministic]

Determine the input source:

- **Grill-session file path** (most common): `daily/grill-sessions/<date>-<slug>.md`. Read it. Check `status:` frontmatter — must be `pass` / `settled` / `shipped` (not `working` / `draft`). If unsettled, STOP and ask the user to finish /grill.
- **GitHub issue number** (PRD already filed): `gh issue view <N> -R sonthanh/ai-brain --json title,body,labels,comments`. Treat issue body + comments as the plan.
- **In-context plan**: if the conversation already contains a settled plan from this session, work from context. Confirm with the user that nothing earlier needs re-reading.

If the user passes neither a file path nor an issue number, ask which one. Do NOT guess.

### 2. Synthesize PRD internally [latent]

In conversation context only — do NOT write a file. Extract from the source:

- **User stories** (or use cases / scenarios)
- **Implementation decisions** that are settled (stack, file paths, integration points)
- **Out-of-scope** explicit list — what the plan deliberately does NOT cover
- **Open questions** — must be empty for AFK issues; HITL issues can carry one if it's the question the human is being pulled in to answer

If you cannot extract these four sections, the source is not settled enough → STOP and ask user to finish /grill.

### 3. Draft vertical slices [latent]

**Slice budget — adjust for input type.** Tracer-bullet default (5-10 slices) assumes greenfield development with unknowns. For grilled config / maintenance / skill-modification work where unknowns are resolved by the grill, use **2-4 slices**. Group by area-label + dependency-cluster, not by single-layer concern.

- **Heuristic:** grill title contains `fix` / `modify` / `config` / `expand` / `refactor` / `cleanup` / `hygiene` / `audit` → maintenance budget. Contains `build` / `create` / `new` / `introduce` / `design` / `port` → greenfield budget. Ambiguous → ask user once, default to maintenance (coarser is safer; merging issues is harder than splitting them).
- **HITL/AFK default flip:** when grill is `status: pass` AND work is skill modification → default to **AFK** (the grill replaces pickup's `owner:human` "needs grill before exec" gate). Mark HITL only when the issue body carries an unresolved design question.

Break the PRD into tracer-bullet issues. For each slice, decide:

| Field | What it captures |
|-------|------------------|
| Title | Short imperative — `Port /to-issues skill (Phase B of Pocock skill-process adoption)` |
| Type | HITL (`owner:human`) or AFK (`owner:bot`). Default AFK; promote to HITL only when human judgment is needed |
| Area label | `area:plugin-brain-os` / `area:vault` / `area:plugin-<name>` — which code repo this touches |
| Priority | `priority:p1` (urgent) / `priority:p2` (high) / `priority:p3` (medium) / `priority:p4` (backlog) |
| Weight | `weight:quick` (≤30 min) / `weight:heavy` (1h+) |
| Status | `status:ready` (no blockers) / `status:blocked` (waiting on another slice) / `status:backlog` (later phase) |
| Files | List of relative paths the slice will touch (warn-soft validator — see § 4) |
| Observable | The user-visible surface this slice produces (HARD GATE — see § 4) |
| Blocked by | List of slice numbers (during quiz) → real issue numbers (after creation) |

### 4. Validate slices [deterministic]

Before showing the breakdown to the user, run two validators on each slice:

**Tracer-bullet (HARD GATE):** the slice MUST declare an `Observable:` — at least one of: a slash command output, a cron tick log line, a journal section, a /status display, a hook stdout/exit-code change, a vault file the user can read. If a slice cannot point to an observable surface, it's a horizontal slice (one layer) — split it differently or merge it with the slice that completes the path.

**Disjoint-files (WARN-SOFT):** if two slices declare overlapping `Files:`, flag it. They can still ship — `/impl --parallel` uses Agent-tool worktree isolation so file conflicts resolve at merge time. But surfacing the overlap helps the user decide if a merge would be cleaner than parallel work.

### 5. Quiz the user [latent]

Open with the detected budget: `I detected this as <maintenance|greenfield>; proposing N slices. Push back on the budget first if wrong, then on individual slice details.`

Present the proposed breakdown as a numbered list. For each slice show: Title / Type / Area / Priority / Weight / Files / Observable / Blocked by.

Then ask:

- Granularity: too coarse / too fine?
- Dependencies correct?
- HITL/AFK assignments correct?
- Any slices to merge or split?

Iterate until the user approves. Do NOT proceed to issue creation while the user is still iterating.

### 6. Create issues in dependency order [deterministic]

For each approved slice, in topological order (blockers first), run:

```bash
gh issue create \
  -R sonthanh/ai-brain \
  --title "<Title>" \
  --body "$(cat <<'EOF'
## Parent

#<parent-issue-number>  (omit if no parent)

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

- ai-brain#<N>

(or `None — can start immediately`)
EOF
)" \
  --label "area:<area>,owner:<bot|human>,priority:<p1-p4>,weight:<quick|heavy>,status:<ready|blocked|backlog>"
```

After each `gh issue create` call, capture the returned issue number. Subsequent slices that reference this one in `Blocked by` get the real number substituted in.

Do NOT close or modify any parent issue. The parent stays open as the umbrella.

### 7. Report back [deterministic]

After all issues are created, print a summary table:

```
| # | Title | Type | Status | Blocked by |
|---|-------|------|--------|------------|
| 115 | Port /to-issues | AFK | ready | — |
| 116 | Port /impl (once) | AFK | blocked | #115 |
| ... |
```

Then append to the grill-session file (if input was a grill-session): `## Issues filed (YYYY-MM-DD)` listing the issue numbers and their statuses. This is the only persistence — links from the grill to the resulting issues, no PRD copy.

## When NOT to use /to-issues

- **Single bug fix** → `gh issue create` directly. /to-issues is overhead for a one-issue plan.
- **Exploratory grill where decisions aren't settled** → finish /grill first. /to-issues will (and should) refuse to slice an unsettled plan.
- **The plan IS one slice** → file it directly. Don't manufacture sub-issues to satisfy "many thin slices" — that's just paperwork.
- **Cosmetic / typo / config tweak** → direct edit + push. The Pocock pipeline is for behavior changes, not chore commits.

## Outcome log

Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/to-issues.log`:

```
{date} | to-issues | {action} | ~/work/brain-os-plugin | daily/grill-sessions/{date}-{slug}.md | commit:{hash} | {result}
```

- `action`: `slice` (normal grill → issues path) or `re-slice` (user requested merge / split of issues already filed today)
- `result`: `pass` if no slice gets re-split / re-merged via reactive `improve: encoded feedback —` or follow-up `gh issue edit` within 48h. `partial` if user merged or split 1–2 slices mid-quiz before approval. `fail` if breakdown was rejected entirely or user re-grilled.
- Optional: `args="<grill-session-slug>"`, `corrections=N`, `score=N` (issues created)

The 48h-no-reactive-resplit criterion is the discipline test for /to-issues, mirroring /tdd's. If issues stay stable post-creation, the slice-quality assumption holds. If users keep splitting / merging issues after the fact, /to-issues' breakdown logic needs a `/improve` cycle.
