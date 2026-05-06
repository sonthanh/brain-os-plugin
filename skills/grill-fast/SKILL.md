---
name: grill-fast
description: "Mode B grill: pre-grill internally, render ≥4 candidate decision-tree architectures side-by-side as ASCII (3 axis-aligned + 1 mandatory axis-challenger), batch parameter picks. Use for architecture / system-design topics where most LLM recommendations would just get 'ok' — converges in 2-3 turns vs /grill's question-by-question march. Falls back to /grill for single-decision or pure-exploration topics where multiple trees would be artificial."
---

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`

## What it does

Skip the linear Q1→Q2→...→Qn march. Pre-grill internally, partition decisions into ARCH (branches the architecture) vs PARAM (single value pick), render **≥4 candidate architectures** as side-by-side ASCII trees — at least 3 spanning the real design space plus a **mandatory 4th tree challenging the shared framing axis** — with key deltas highlighted, batch PARAM picks in one block, ask user to pick a tree (or hybrid). Locks in 2-3 user turns.

Use when topic is multi-component design with ≥3 ARCH decisions. Fall back to `/grill` when topic is a single decision, policy choice, or pure exploration with no candidate to draw — the ≥4-tree rule does NOT force four trees onto trivially small design spaces.

## Flow

1. **Vault research first** — check `RESOLVER.md` + relevant zone READMEs + prior grills/research. Same as `/grill`.
2. **Decision partition** — list every decision the topic implies; tag each as ARCH (changes the diagram) or PARAM (single value). If <3 ARCH decisions, abort and recommend `/grill` instead.
3. **≥3 axis-aligned candidate architectures (typically A/B/C)** — span the real design space. Not 1 good + 2 strawmen. Each tree must be internally consistent and defensible. Common axes: strict-vs-permissive, narrow-vs-wide, ship-fast-vs-cover-everything.
4. **Mandatory axis-challenger tree (4th, typically D)** — identify the **shared framing axis**: the dimension trees A/B/C all silently agree on (e.g. "schema-driven dispatch", "entities live in tables", "pipeline as DAG"). Render an additional tree that **explicitly violates that axis**. The axis-challenger may be intentionally weak / impractical / strawman — its job is to surface the framing assumption, not to be a serious candidate. The strawman exception applies ONLY to the axis-challenger; A/B/C must remain defensible per Step 3. See § Challenge-the-axis tree below for full mechanics + canonical example.
5. **Render side-by-side ASCII** — each tree gets a header strip naming the ARCH picks for that tree, then the box-and-arrow diagram. Use `◄──` arrows to call out where trees differ.
6. **Delta table** — one row per ARCH decision, one column per tree (A/B/C/D...) showing per-tree pick. Reader sees all differences in one glance, including how the axis-challenger differs from the axis-aligned set.
7. **Cost/risk table** — dispatcher complexity, ship velocity, future-extension cost, failure mode, etc.
8. **Parameter block** — bullet list of PARAM picks (one recommendation each, no tree branching).
9. **Recommendation** — one pick (typically A/B/C) with rationale. Not "you decide" — Decide-and-recommend rule applies. **If the user picks the axis-challenger 4th tree** (rare but possible), the grill MUST re-grill the framing before locking — the shared axis was just rejected, so A/B/C are no longer the right design space; drop back to `/grill` with a fresh question batch around the new framing.
10. **Failure-mode call-outs** — for each non-recommended tree, list what to flag if user picks it anyway.

## Output file

Save to `{vault}/daily/grill-sessions/YYYY-MM-DD-<topic-slug>.md`. Same path as `/grill`. Frontmatter `tags: [grill-fast, mode-b]` to distinguish.

Required sections: `# Frame`, `# The candidate architectures` (the ASCII — ≥4 trees including the axis-challenger), `# Key deltas`, `# Cost / risk per tree`, `# Parameter picks`, `# Recommended pick`, `# Failure mode call-outs`, `# Status gate`. The shared framing axis the 4th tree challenges MUST be named explicitly in the `# Frame` or above the ASCII so the reader can audit the framing assumption.

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

- `result`: `pass` if user picks a tree (or hybrid) and grill closes ≤3 user turns; `partial` if user requests Q-by-Q follow-up after seeing trees (Mode B incomplete, Mode A patched on top), OR if user picks the axis-challenger 4th tree and re-grill of the framing is required before locking; `fail` if aborted to `/grill` or trees rejected wholesale
- `turns_to_lock`: count user turns from skill invocation to lock (success metric — target ≤3)
- `pick`: which tree user selected — `A`, `B`, `C`, `D` (axis-challenger), `hybrid`, or `none`
