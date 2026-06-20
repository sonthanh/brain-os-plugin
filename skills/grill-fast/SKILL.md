---
name: grill-fast
description: "Mode B grill: render ≥4 decision-tree architectures as ASCII (3 axis-aligned + 1 axis-challenger). Use for architecture / system-design topics where recommendations would just get 'ok' — locks in 2-3 turns vs /grill's question-by-question march. Single-decision or pure-exploration → /grill."
auto_improve: false  # adversarial skill (grill variant) — never auto-patch from corrections (thinking/aha/2026-04-12-thin-skills-must-not-auto-improve.md). Evolve by manual decision only.
---

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`

## What it does

Skip the linear Q1→Q2→...→Qn march. Pre-grill internally, partition decisions into ARCH (branches the architecture) vs PARAM (single value pick), render **≥4 candidate architectures** as side-by-side ASCII trees — at least 3 spanning the real design space plus a **mandatory 4th tree challenging the shared framing axis** — with key deltas highlighted, batch PARAM picks in one block, ask user to pick a tree (or hybrid). Locks in 2-3 user turns.

Use when topic is multi-component design with ≥3 ARCH decisions. Fall back to `/grill` when topic is a single decision, policy choice, or pure exploration with no candidate to draw — the ≥4-tree rule does NOT force four trees onto trivially small design spaces.

## Flow

1. **Vault research first** — check `RESOLVER.md` + relevant zone READMEs + prior grills/research. Same as `/grill`. If the topic references GitHub issues, run `gh issue view N` on each FIRST — confirm it is still open and read its latest comments for prior decisions. The SessionStart open-tasks cache is stale; grilling an already-closed issue contaminates every downstream pick.
2. **Decision partition** — list every decision the topic implies; tag each as ARCH (changes the diagram) or PARAM (single value). If <3 ARCH decisions, abort and recommend `/grill` instead.
3. **≥3 axis-aligned candidate architectures (typically A/B/C)** — span the real design space. Not 1 good + 2 strawmen. Each tree must be internally consistent and defensible. Common axes: strict-vs-permissive, narrow-vs-wide, ship-fast-vs-cover-everything.
4. **Mandatory axis-challenger tree (4th, typically D)** — identify the **shared framing axis**: the dimension trees A/B/C all silently agree on (e.g. "schema-driven dispatch", "entities live in tables", "pipeline as DAG"). Render an additional tree that **explicitly violates that axis**. The axis-challenger may be intentionally weak / impractical / strawman — its job is to surface the framing assumption, not to be a serious candidate. The strawman exception applies ONLY to the axis-challenger; A/B/C must remain defensible per Step 3. See § Challenge-the-axis tree below for full mechanics + canonical example.
5. **Render each tree as a self-contained block: header + ASCII + inline pros/cons.** Each tree gets a header strip naming the ARCH picks, the box-and-arrow diagram with `◄──` callouts where trees differ, then a `**Pros**` / `**Cons**` block immediately under the diagram (3-5 concrete bullets each side — build cost, what it actually proves, what it misses, key failure mode). The reader scans each tree top-down without cross-referencing tables. Stack trees vertically with `═══` separators (side-by-side horizontal layout doesn't fit ≥4 trees at terminal width). Inline pros/cons is REQUIRED, not optional — a tree without it forces the reader to scroll-and-cross-reference, which defeats the "decide on the spot" goal.
6. **Delta table** — one row per ARCH decision, one column per tree (A/B/C/D...) showing per-tree pick. Reader sees all differences in one glance, including how the axis-challenger differs from the axis-aligned set.
7. **Cross-tree comparison table** — dispatcher complexity, ship velocity, future-extension cost, failure mode, etc. Complements the inline pros/cons in step 5 by giving a side-by-side scan across all trees on the same axes. NOT a replacement — both are required.
8. **Parameter block** — bullet list of PARAM picks (one recommendation each, no tree branching).
9. **Recommendation** — one pick (typically A/B/C) with rationale. Not "you decide" — Decide-and-recommend rule applies. **If the user picks the axis-challenger 4th tree** (rare but possible), the grill MUST re-grill the framing before locking — the shared axis was just rejected, so A/B/C are no longer the right design space; drop back to `/grill` with a fresh question batch around the new framing.
10. **Failure-mode call-outs** — for each non-recommended tree, list what to flag if user picks it anyway.
11. **User pick via `AskUserQuestion` (default mode).** After the file is written, present the trees as side-by-side preview options via the `AskUserQuestion` tool — vertical option list on the left, monospace preview pane on the right showing the focused option's content. Each option has:
    - `label`: tree letter + ARCH summary, e.g. `"C: Live outcome shadow"` (the recommended tree gets `(Recommended)` suffix per tool convention; when the recommendation is a hybrid, mark the strongest single tree as `(Recommended — pair with X for hybrid)` and rely on the auto-`Other` field for hybrid input or custom direction like "park as backlog").
    - `description`: 1-line tradeoff summary.
    - `preview`: compact ASCII tree (≤20 lines: data flow + key cost/risk annotations). Compact ≠ different — same logical structure as the file's full diagram, just trimmed for the preview pane.
    Question header ≤12 chars derived from topic. Recommended tree is option 1. **Null-option rule:** whenever "don't do this / drop it" is a live outcome (topic could legitimately be dropped, deferred, or was previously deprioritized), include it as an explicit option — never offer only sub-variants. An option set of sub-variants presupposes the action is settled and makes the question leading; a user in flow clicks the sensible sub-variant, and that click cannot bear the weight of reversing a prior considered decision. Skip this step ONLY when user has pre-stated their pick before the skill ran, or when running in a non-interactive context (e.g. `/loop`). After user picks, update file frontmatter (`status: pass` for A/B/C; `status: working` for D triggering re-grill; `status: deferred` for none/Other-deferred) and append the outcome log row. If trees > 4, present the top 4 in `AskUserQuestion` (recommended + 3 highest-value alternatives); the file retains all.

## Output file

Save to `{vault}/daily/grill-sessions/YYYY-MM-DD-<topic-slug>.md`. Same path as `/grill`. Frontmatter `tags: [grill-fast, mode-b]` to distinguish.

Required sections: `# Frame`, `# The candidate architectures` (the ASCII — ≥4 trees including the axis-challenger; **each tree's diagram MUST be immediately followed by an inline `**Pros**` / `**Cons**` block per step 5**), `# Key deltas`, `# Cross-tree comparison`, `# Parameter picks`, `# Recommended pick`, `# Failure mode call-outs`, `# Status gate`. The shared framing axis the 4th tree challenges MUST be named explicitly in the `# Frame` or above the ASCII so the reader can audit the framing assumption.

## When to abort to /grill

- <3 ARCH decisions identified after Step 2 (single-decision topic). The ≥4-tree rule does NOT apply here — fall back to `/grill` rather than fabricating axis-aligned trees just to satisfy the count.
- Vault context too thin to sketch any candidate (skip the pre-grill, ask 1-2 framing questions first).
- Decisions are PARAM-heavy with only 1-2 architectural branches (just batch the params + 1-2 questions).

Do not force a multi-tree render when the design space is genuinely 1-dimensional. The skill failure mode is "all the trees look the same" — when that happens with the axis-aligned set, the apparent sameness IS the shared framing axis: lean into the 4th tree to expose it. When it happens because the topic itself has no real design space, abort to `/grill`.

## Challenge-the-axis tree (mandatory 4th)

The first 3 trees converge fast precisely because they share framing — that speed is exactly what makes Mode B 2-3 turns instead of 17. But shared framing becomes the weakness when the framing itself is wrong: Mode B will lock 2-3 turns deep on an axis nobody questioned. The mandatory 4th tree is the antidote.

**How to identify the shared framing axis.** After drafting trees A/B/C, ask: *what assumption do all three silently agree on?* The axis is the dimension trees A/B/C don't disagree on, even though they vary on others (NK threshold, strategy count, etc.). Common axes: schema shape ("schema-driven dispatch"), where entities live ("entities live in tables"), pipeline topology ("pipeline is a DAG"), control-flow direction ("top-down classification"), who decides X ("deterministic dispatch, never LLM judgment"). If you can't name the shared axis after 30 seconds, render A/B/C side-by-side and look for the row that's *missing* from the delta table — the dimension nobody varied on.

**How to render the 4th tree.** Negate the axis. Examples:

- A/B/C all assume "entities live in tables" → 4th tree assumes "entities live as denormalized strings inside other records."
- A/B/C all assume "pipeline is a DAG" → 4th tree assumes "pipeline is a feedback loop with mid-stage human intervention."
- A/B/C all assume "deterministic record identity" → 4th tree assumes "LLM judgment for record identity."

The axis-challenger may be intentionally weak / impractical / strawman — that's the point. The strawman exception applies ONLY to the 4th tree; trees A/B/C must remain defensible per Step 3.

**Canonical example — the 2026-05-04 airtable replay.** Trees A/B/C in `daily/grill-sessions/2026-05-04-airtable-mode-b-replay.md` (strict / permissive / wide) all silently shared the assumption *entities live in tables*. Had the ≥4-tree rule been in force, the mandatory 4th would have asked **"what if entities don't live in tables?"** — a text-extraction architecture that scans `singleLineText` fields inside records for entity references regardless of schema shape. That 4th tree would have surfaced the framing assumption explicitly. The assumption broke when 8 children of #237 had already shipped on a denormalized Payments base where `Payer Name` / `Payee Name` were `singleLineText` strings — exactly the case the 4th tree would have flagged before any code shipped.

**Fallback when the user picks the axis-challenger.** Rare but real. The shared axis just got rejected, so the original A/B/C design space is moot. Re-grill the framing before locking: drop back to `/grill` with a fresh question batch around the new framing, then re-enter `/grill-fast` with the new axis to render a fresh A/B/C/D set. Do NOT lock on the axis-challenger as-is — it was scored against the old framing and may have been deliberately weak.

## Usage

```
/grill-fast <topic>
```

## Outcome log

Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/grill-fast.log`:

```
{date} | grill-fast | grill-fast | ~/work/brain-os-plugin | daily/grill-sessions/{date}-{slug}.md | commit:{hash} | {result} | args="{topic}" turns_to_lock=N pick=A|B|C|D|hybrid|none
```

- `result`: `pass` if user picks a tree (or hybrid) and grill closes ≤3 user turns; `partial` if: user requests Q-by-Q follow-up after seeing trees (Mode B incomplete, Mode A patched on top), OR user picks the axis-challenger 4th tree and re-grill of the framing is required before locking, OR user explicitly defers the session to backlog (`pick=none`, `status: deferred` in file frontmatter); `fail` if aborted to `/grill` or trees rejected wholesale
- `turns_to_lock`: count user turns from skill invocation to lock (success metric — target ≤3)
- `pick`: which tree user selected — `A`, `B`, `C`, `D` (axis-challenger), `hybrid`, or `none`
- `deferred_to`: optional — issue URL when `pick=none` and user defers to a backlog issue (e.g. `deferred_to=https://github.com/.../issues/267`)
- **Log exactly once per session** — after the final outcome is known (user pick, explicit deferral, or session abort). Do NOT append an intermediate row while AskUserQuestion is pending. If a session ends mid-flow before a pick, resolve and log in the session where the pick or deferral is confirmed.
