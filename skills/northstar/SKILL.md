---
name: northstar
description: "Define a company's North Star metric — the single leading metric that captures customer value and predicts revenue, plus its 3-5 input levers, guardrails, and a validation plan. Use this whenever the user wants to define, choose, fix, or stress-test their company's North Star / NSM / single most important metric / primary company KPI / 'one metric that matters' / 'the one number we steer by' — even when they don't say the words 'north star' (e.g. 'what should we run the company on?', 'is revenue the right top-level metric?', 'what's our one number?'). Emits context/<company>/northstar.md gated by the North Star framework's 7-point test. NOT for per-feature/per-task metrics, building dashboards, or drafting OKRs — the North Star sits ABOVE OKRs (OKRs move its inputs)."
---

# /northstar — define a company's North Star metric

Walk **any** company from "we don't have one shared metric" (or "we're wrongly steering by revenue") to a locked `northstar.md`: one leading star + 3–5 input levers + guardrails + revenue-as-lagging-output + a validation plan that proves the star actually steers.

This skill is **generic** — it fits a one-product SaaS and a multi-stream operator alike. It **forces no archetype on the company**: it renders the candidate shapes and the company picks the one that matches its strategy, and the framework audit keeps the pick honest. (Customer-value is the framework's #1 criterion, so it's the *ideal* candidate shapes are measured against — but the company can deliberately pick a different shape with a documented justification; the skill never imposes one.)

## Vault Location
**Vault path + company-context root:** read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md` (key `vault_path:`). Company context lives at `{vault}/context/<company>/`; output goes there too.

## Why this skill exists (the shape of the problem)

A North Star is easy to *state* and hard to *get right*. Two failure modes dominate, and the flow below is built to block both:

1. **Picking a lagging or vanity metric** — most teams reach for revenue/MRR/ARR (lagging: "the game is over before you've had a chance to play") or a vanity number (signups, pageviews). The framework audit (Step 4) catches this.
2. **Locking a beautiful metric nobody validated** — a star that *reports* but doesn't *steer*, because no one proved its inputs actually move it or that it tracks revenue. The mandatory validation plan (Step 5) catches this. This is the more common silent failure: the definition looks done, but every open question is really a validation gap.

Keep both in view: the deliverable is **a defensible star AND the experiment that will prove it**, not a pretty definition.

## Flow

The skill is an **orchestrator**: it reuses `/grill-fast` for the shape choice and owns the North-Star-specific judgment (the framework audit, the tier mapping, the validation plan). Lookup data (the 7-point test, the 7 rules, the failure modes) lives in `references/north-star-framework.md` — read it before Step 4.

### Step 1 — Detect the company + its context

Resolve `<company>` from the user's request (or ask). Then auto-detect what you already know:

- If `{vault}/context/<company>/` exists, read `strategy.md` and `goals.md` (and any `business.md`). Use them to seed candidate stars — the star must *express the strategy*, so start from the stated strategy, not a blank page.
- If there's no context dir (greenfield company), ask 2–3 framing questions only: *what core value do you deliver to customers? what's the strategy in one line? single product or multiple lines of business?* Don't run a full interview — the shape grill (Step 2) does the real work.

Detecting rather than assuming is what lets one skill serve both an instrumented company and a brand-new one.

### Step 2 — Grill the candidate shapes via `/grill-fast`

Hand the shape choice to `/grill-fast` (invoke it via the Skill tool — do **not** re-implement tree rendering here; reusing the proven engine avoids a second copy that drifts). Frame the topic as: *"North Star metric shape for `<company>`."* Seed it with the generic archetype menu (see `## The candidate shape menu`) so the trees span the real design space; the company picks the shape that fits its strategy.

The user picks a shape (or a hybrid). That pick is the *candidate* star — Step 4 still has to pass it through the framework audit before it locks.

**Don't assume `/grill-fast` always renders trees — expect either path.** It fires only when the shape choice has ≥3 architectural decisions. In practice that's **topology-driven**: a multi-line / multi-P&L operator has enough live forks (single-vs-layered topology + archetype + quantity-only-vs-quantity+quality apex) to render ≥4 trees, whereas a single-product company has topology foreclosed and usually lands at <3 ARCH — so `/grill-fast` will itself **abort to `/grill`**. That's correct, not a failure. **Fall back to `/grill`** (linear, not multi-tree) whenever the company has one obvious star and 4 candidate shapes would be artificial — don't force a 4-tree render onto a 1-dimensional choice.

### Step 3 — Map the tier hierarchy

A North Star is a **hierarchy, not a single number**. From the picked shape, build three tiers:

- **★ Tier 1 — the North Star** (leading; you move it *through* inputs, never directly). Test: if you can move it directly, it's an input, not the star — go up a level.
- **3–5 input metrics** — the leading levers teams act on directly that you believe drive the star. Fewer than 3 is usually too coarse; more than 5 dilutes focus.
- **Tier 2 — output guardrail: revenue, placed BELOW the star**, never as it. Revenue is the lagging result the star predicts; track it to confirm the star points the right way.
- **Tier 3 — quality guardrails** — counter-metrics (quality, error/SLA, churn, unit economics) so optimizing the star can't quietly break something else. Guardrails are mandatory: any single number gets gamed (Goodhart / Campbell).

If the company has **multiple lines of business**, see `## Multi-business` before finalizing — you measure per-stream and roll up value-weighted, not volume-weighted.

### Step 4 — Run the framework-compliance audit (the gate)

**Read `references/north-star-framework.md` now.** Walk the candidate star through, in order:

1. **The 7-point selection test** — customer value · actionable · leading · not-vanity · expresses-vision · understandable · quantifiable-high-frequency.
2. **The 7 decision rules** — one star not many; star-is-leading-revenue-is-lagging-below; input→output is a hierarchy not a pair; passes the 7-point test; validate the causal link empirically; guardrails mandatory; multi-business is the layered exception.
3. **The failure-mode table** — Goodhart, Campbell, surrogation, vanity, revenue-as-star, divided focus — and confirm a mitigation is in place for each live risk.

**This gate is SOFT, not a hard block.** When the candidate fails a criterion — most often #1 (customer value), because an efficiency/transformation or financial star does by design — do **not** reject it. Instead require the company to do one of:

- **Fix it** — go up a level to a star that does represent customer value, or
- **Justify it as a named, documented deviation** against the framework's own sanctioned exceptions:
  - an **efficiency / transformation** star for an operations-heavy firm (trades criterion #1 deliberately for an anti-drift property),
  - a **qualified financial** metric (e.g. net revenue retention from engaged accounts) for a **mature, post-PMF** business that accepts the lagging premise,
  - a **layered hierarchy** of stars for a genuine multi-P&L operator.

A documented deviation that maps to a framework exception **passes the gate**. An undocumented or unjustified failure does not — surface it and make the user choose fix-or-justify before locking. The point of the gate is an honest, on-the-record decision, not a perfect-score metric. Record which criteria passed, which were deviations, and the justification, in the output's "Framework compliance" section.

### Step 5 — Emit `northstar.md` with a mandatory validation plan

Write `{vault}/context/<company>/northstar.md` (structure in `## Output file`). The **validation plan is a required, first-class section** — definition is not "done" at lock; it's a hypothesis until the data backs it. The plan must name:

- **≥1 input→output causal experiment** — which input you'll move and how you'll confirm the star moved *because of it*. Prefer the strongest method the company can actually run: **A/B test > staggered rollout / synthetic control > before/after cohort**. An operations business that can't A/B uses staggered rollout across units + before/after cohorts.
- **The cheapest "one-slice" check runnable now** — the smallest real computation that confirms the star is even measurable (e.g. compute all the numbers on one recent period for one stream; confirm the denominator is enumerable). This is what turns the doc from aspiration into something that steers next week.

### Step 6 — (optional) recommend a principle cross-check

The framework audit (Step 4) is the real gate. As a cheap extra, you *may* suggest the user run `/audit p1 p4` (simplicity + concrete-drives-abstract — the two most relevant principles to a freshly-locked metric). Keep this **off by default**; do not auto-run `/audit --all` on every invocation — it's heavy and the framework audit already gates the substance.

## The candidate shape menu

Seed `/grill-fast` with these archetypes so the trees span the real design space. **No archetype is the default-for-everyone** — but customer-value is the framework's #1 criterion, so it's the *ideal* the others must justify deviating from:

| Archetype | The star captures… | Fits |
|---|---|---|
| **Customer-value** (ideal / default candidate) | customers getting the core value (e.g. weekly active teams reaching an "aha" outcome) | most product-led businesses |
| **Engagement-usage** | depth/breadth of meaningful usage | products where value compounds with use |
| **Output-leverage** | value delivered per unit of input (output the company produces) | leverage/scaling bets |
| **Efficiency-transformation** | share of work done the new/better way (e.g. % automated) | operations-heavy or transformation mandates — a *deliberate* deviation from customer-value |

Plus the **mandatory axis-challenger** tree `/grill-fast` always renders — here it typically negates "the metric is the deliverable" by asking whether the validation experiment is the real work (a useful provocation, since validation is the common silent gap).

## Output file

Save to `{vault}/context/<company>/northstar.md`. Mirror the structure of any prior locked `northstar.md` in the vault (there's one per company) so the vault stays consistent:

```markdown
---
title: <Company> North Star — <one-line theme>
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
tags: [context, <company>, northstar, kpi, strategy]
zone: context
---

# <Company> North Star — <theme>

The single aligning metric for <company>. Purpose: align decisions and prevent drift.
- Reusable framework: link to the framework reference / research report.
- Full decision + audit: link to the grill-session record. (only if one exists — see the "Only link artifacts that actually exist" note below)

Strategy (verbatim): "<the strategy the star expresses>"

## The metric — a tier hierarchy (not co-equal stars)
### ★ TIER 1 — North Star
- <the star, one sentence anyone can repeat> — how measured, how often.
- Anti-drift / "one level out of reach" note.
- Target + checkpoint.
### TIER 2 — Output guardrail
- Revenue (lagging) — must rise as the star rises; no absolute target.
### TIER 3 — Quality guardrails
- <quality / SLA / churn / unit-economics counter-metrics> — steady or better.

## Input metrics (the leading levers)
- 3–5 inputs the team moves directly that should drive the star.

## Framework compliance (vs NSM doctrine)
- Which of the 7 points pass; which are documented deviations + the named exception each maps to.

## Validation plan (REQUIRED — the star is a hypothesis until proven)
- ≥1 input→output causal experiment (method named: A/B > staggered > cohort).
- Cheapest one-slice check runnable now.

## ⚠️ Open before this steers decisions
- Numbers still unbaselined; causal links unproven; reconciliation with OKRs.

## Related
- links to strategy / goals / OKRs. (only those that exist — see the "Only link artifacts that actually exist" note below)

---
## Timeline
- <date> — defined via /northstar (grill + framework audit). Steering use gated on the validation above.
```

**Only link artifacts that actually exist.** Include the framework-reference link always, but a `[[grill-session]]` / `strategy.md` / `goals.md` link only when that file is real. On a greenfield company (no context dir, or a pre-stated pick that skipped the grill), omit the link or annotate the gap — never fabricate a path to a doc that doesn't exist.

## Multi-business / layered hierarchy

Most North Star doctrine assumes a single product. For a multi-line / multi-P&L operator, do **not** create co-equal stars (that re-creates the in-fighting a North Star exists to prevent). Instead:

- Keep **one enterprise North Star** for focus, measured **per stream/line**, then **rolled up VALUE-weighted** (e.g. by revenue contribution) — *never volume-weighted*, or a high-volume low-value line dominates the headline and hides where the value is.
- This is the framework's documented exception, not the norm — challenge the need first: only split when there are real boundaries in customers, their needs, and strategy.

## When to fall back to `/grill`

If the company has one genuinely obvious star and the shape choice is not a real multi-way decision, skip `/grill-fast` and use a short `/grill`-style linear confirmation instead. Forcing four candidate shapes onto a one-dimensional choice produces fake trees — the same reason `/grill-fast` aborts to `/grill` on thin design spaces.

## Usage

```
/northstar <company>      # define / fix the North Star for <company>
/northstar                # asks which company, then proceeds
```

## Outcome log

Follow `skill-spec.md § 11`. Append one line per run to `{vault}/daily/skill-outcomes/northstar.log`:

```
{date} | northstar | {action} | ~/work/brain-os-plugin | context/<company>/northstar.md | commit:{hash} | {result} | args="{company}" passed=N/7 deviations={list-or-none}
```

- `action`: `define` (first time), `revise` (re-derive / fix an existing star).
- `result`: `pass` if a star is locked (passes the 7-point test OR every failure is a documented, framework-mapped deviation) with inputs + guardrails + a named validation experiment; `partial` if locked but the validation plan is incomplete or some numbers can't be baselined yet; `fail` if no star is locked (user defers, or the framework audit can't be satisfied).
- `passed=N/7`: how many of the 7-point criteria the locked star passes outright.
- `deviations=`: named exceptions used (e.g. `efficiency-transformation`, `layered-hierarchy`), or `none`.
