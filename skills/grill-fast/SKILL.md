---
name: grill-fast
description: "Mode B grill: pre-grill internally, render 3 candidate decision-tree architectures side-by-side as ASCII, batch parameter picks. Use for architecture / system-design topics where most LLM recommendations would just get 'ok' — converges in 2-3 turns vs /grill's question-by-question march. Falls back to /grill for single-decision or pure-exploration topics where 3 trees would be artificial."
---

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`

## What it does

Skip the linear Q1→Q2→...→Qn march. Pre-grill internally, partition decisions into ARCH (branches the architecture) vs PARAM (single value pick), render 3 candidate architectures as side-by-side ASCII trees with key deltas highlighted, batch PARAM picks in one block, ask user to pick a tree (or hybrid). Locks in 2-3 user turns.

Use when topic is multi-component design with ≥3 ARCH decisions. Fall back to `/grill` when topic is a single decision, policy choice, or pure exploration with no candidate to draw.

## Flow

1. **Vault research first** — check `RESOLVER.md` + relevant zone READMEs + prior grills/research. Same as `/grill`.
2. **Decision partition** — list every decision the topic implies; tag each as ARCH (changes the diagram) or PARAM (single value). If <3 ARCH decisions, abort and recommend `/grill` instead.
3. **3 candidate architectures** — span the real design space. Not 1 good + 2 strawmen. Each tree must be internally consistent and defensible. Common axes: strict-vs-permissive, narrow-vs-wide, ship-fast-vs-cover-everything.
4. **Render side-by-side ASCII** — each tree gets a header strip naming the ARCH picks for that tree, then the box-and-arrow diagram. Use `◄──` arrows to call out where trees differ.
5. **Delta table** — one row per ARCH decision, three columns A/B/C showing per-tree pick. Reader sees all differences in one glance.
6. **Cost/risk table** — dispatcher complexity, ship velocity, future-extension cost, failure mode, etc.
7. **Parameter block** — bullet list of PARAM picks (one recommendation each, no tree branching).
8. **Recommendation** — one pick (A/B/C) with rationale. Not "you decide" — Decide-and-recommend rule applies.
9. **Failure-mode call-outs** — for each non-recommended tree, list what to flag if user picks it anyway.

## Output file

Save to `{vault}/daily/grill-sessions/YYYY-MM-DD-<topic-slug>.md`. Same path as `/grill`. Frontmatter `tags: [grill-fast, mode-b]` to distinguish.

Required sections: `# Frame`, `# The 3 candidate architectures` (the ASCII), `# Key deltas`, `# Cost / risk per tree`, `# Parameter picks`, `# Recommended pick`, `# Failure mode call-outs`, `# Status gate`.

## When to abort to /grill

- <3 ARCH decisions identified after Step 2 (single-decision topic).
- Vault context too thin to sketch any candidate (skip the pre-grill, ask 1-2 framing questions first).
- Decisions are PARAM-heavy with only 1-2 architectural branches (just batch the params + 1-2 questions).

Do not force a 3-tree render when the design space is genuinely 1-dimensional. The skill failure mode is "3 trees that look the same" — that means it shouldn't have been used.

## Usage

```
/grill-fast <topic>
```

## Outcome log

Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/grill-fast.log`:

```
{date} | grill-fast | grill-fast | ~/work/brain-os-plugin | daily/grill-sessions/{date}-{slug}.md | commit:{hash} | {result} | args="{topic}" turns_to_lock=N pick=A|B|C|hybrid
```

- `result`: `pass` if user picks a tree (or hybrid) and grill closes ≤3 user turns; `partial` if user requests Q-by-Q follow-up after seeing trees (Mode B incomplete, Mode A patched on top); `fail` if aborted to `/grill` or trees rejected wholesale
- `turns_to_lock`: count user turns from skill invocation to lock (success metric — target ≤3)
- `pick`: which tree user selected (or `hybrid` / `none`)
