---
title: "How to Define a North Star Metric — A Practical Framework"
date: 2026-05-29
source:
  - https://amplitude.com/blog/good-bad-north-star-metric
  - https://info.amplitude.com/rs/138-CDN-550/images/Amplitude-The-North-Star-Playbook.pdf
  - https://www.reforge.com/blog/north-star-metric-growth
  - https://brianbalfour.com/essays/north-star-metric-growth
  - https://amplitude.com/books/north-star/about-north-star-framework
  - https://umbrex.com/resources/frameworks/strategy-frameworks/north-star-metric-framework/
  - https://www.nngroup.com/articles/campbells-law/
  - https://www.stage2.capital/blog/revenue-is-a-dangerous-north-star-metric-heres-why
tags: [northstar, kpi, metrics, strategy, reference, playbook, framework]
---

# How to Define a North Star Metric

A practical framework for choosing your company's single most important metric — what makes one good, how it should relate to revenue, and the failure modes to avoid. Synthesized from the canonical sources: Amplitude's *North Star Playbook*, Sean Ellis (who coined the term), Reforge / Brian Balfour, John Cutler, and the Nielsen Norman Group.

---

## TL;DR — 7 decision rules

1. **One North Star, not many co-equal ones.** Amplitude treats "needing more than one North Star Metric" as a trap: without a single shared star, teams fall back into the same in-fighting and resource battles they already have.
2. **The North Star is LEADING; revenue is a LAGGING result that sits BELOW it.** Don't make revenue, MRR, or ARR the star — *"with revenue, what's done is done—meaning, you can no longer impact the outcome"* (Amplitude). Rule: **relate your North Star to revenue; don't make revenue your North Star.**
3. **Input → Output is a HIERARCHY, not a pair.** 3–5 input metrics (the levers you act on directly) drive the North Star (the scoreboard you *cannot* move directly). John Cutler's test: *"If you can move your North Star directly, it's probably not a good North Star."* An input metric + an output metric is *not* "two co-equal stars" and does *not* cause drift — they're different tiers.
4. **A good North Star passes a 7-point test** (below): reflects customer value · actionable · leading · not a vanity metric · expresses vision/strategy · understandable to non-experts · quantifiable at high frequency. It sits at the **intersection of customer and business value**.
5. **Validate the causal link empirically — don't assume it.** An input qualifies only if moving it *measurably moves* the output. Discard inputs that don't. A/B testing is the gold standard for causality; correlation alone isn't proof. When you can't run clean experiments, use quasi-experimental methods (staggered rollout, before/after cohorts, maturity comparisons).
6. **Guardrails are mandatory** — any single number gets gamed. Goodhart's Law (*"when a measure becomes a target, it ceases to be a good measure"*), Campbell's Law, and surrogation all predict decay. Pair the star with counter-metrics (quality, error rate, unit economics, churn).
7. **Multi-business exception:** a company with distinct lines of business serving distinct customer bases MAY have more than one North Star — each with its own inputs — rolling up to ONE enterprise star (a *layered hierarchy of singles*, never two co-equal stars for the same unit). It's the **exception, not the norm** — challenge the need first, and look for real boundaries in customers, their needs, and your strategy before splitting.

---

## The 7-point selection test

A good North Star Metric must be **all** of these (Amplitude / Sean Ellis canon):

| # | Property | Why it matters |
|---|----------|----------------|
| 1 | **Represents customer value** | The single metric that best captures the core value your product/service delivers to customers. |
| 2 | **Actionable / within your sphere of influence** | Teams can affect it through their work. |
| 3 | **Leading indicator of revenue** | Predicts the future, doesn't just report the past. |
| 4 | **Not a vanity metric** | Moves with real value, not with numbers that only look good (raw signups, pageviews). |
| 5 | **Expresses vision & strategy** | Encodes *where you're going*, not just current health. |
| 6 | **Understandable to non-technical partners** | One sentence anyone in the company can repeat. |
| 7 | **Quantifiable, high-frequency** | Measurable often enough to steer by. |

**The "one level out of reach" principle (John Cutler):** *"The goal of the North Star is to be one level out of reach."* You move it *through* your inputs, never by touching it directly — that is the falsifiable test separating a North Star from an input metric.

---

## Why NOT revenue (the most common mistake)

Revenue, MRR, and ARR are classic **bad** North Star Metrics because they are **lagging**:

- *"With revenue, what's done is done—meaning, you can no longer impact the outcome."* (Amplitude)
- *"Revenue can hide what is going on under the hood with product usage, and shield you from signals."* And: *"the game is over before you've even had the chance to play."* (Reforge / Brian Balfour)
- Corroborated by Stage 2 Capital's "Revenue is a Dangerous North Star Metric."

**Documented exception (doesn't overturn the rule):** mature / plateaued *post-PMF* businesses sometimes adopt a *qualified* financial metric (e.g. net revenue retention from engaged accounts) — but they accept the lagging premise and scope it to scale. Not for growth-stage scaling bets.

**Revenue's correct home:** the lagging **output / business-result tier**, one level below the North Star, used to *validate* that the star is pointing the right way.

---

## Single North Star vs a system of metrics

- **Amplitude / Sean Ellis camp:** ONE North Star Metric + 3–5 input metrics + guardrails. Single-metric model by design.
- **Reforge / Brian Balfour view:** rejects "One Metric That Matters" as *"a fatal oversimplification"* and argues for a *"constellation of metrics"* across several growth dimensions (e.g. breadth of retention, depth of engagement, monetization) rather than one.

**The reconciliation:** this debate is about **how many co-equal OUTPUTS** you track — it is *orthogonal* to the input-vs-output question. **Both camps structure the input→output relationship identically** (inputs are the leading levers; the North Star/output is the lagging scoreboard). So "one compass + one output guardrail" is endorsed by everyone; the only debate is whether you have one output star or a few.

---

## Leading vs lagging — and validating the causal link

- **Leading (input):** behavior-based, actionable, predicts the future. Pro: you can act on it now. Con: may not actually drive the output.
- **Lagging (output):** revenue, retention, the result. Pro: it's what you ultimately want. Con: too late to influence, confounded.
- **The validation discipline (Reforge / Balfour):** *"You need to be willing to discard them quickly if after some experimentation you find moving them doesn't improve the output metric."* Only inputs that *provably move the output* are true leading indicators.
- **Causality methods, strongest first:** A/B experimentation → quasi-experimental (synthetic control, staggered rollout) → observational correlation (weakest). Operations / services businesses that can't A/B should use **staggered rollout across units + before/after cohorts**.

---

## Failure modes (what to guard against)

| Law / pattern | Statement | Mitigation |
|---|---|---|
| **Goodhart's Law** | *"When a measure becomes a target, it ceases to be a good measure."* | Don't tie everything to one gameable number; add counter-metrics. |
| **Campbell's Law** | The more important a metric is in decision-making, the more it gets gamed/distorted. | Keep the star paired with quality/integrity checks. |
| **Surrogation / metric fixation** | *"People manage the metric, rather than using the metric to help manage the underlying issue of interest."* | Re-anchor on the real goal; rotate what you inspect. |
| **Vanity metrics** | Numbers that look good but don't track value. | The 7-point test (criterion 4) screens these out. |
| **Revenue-as-star** | Lagging; hides decay until churn. | Demote to the output tier. |
| **Divided focus** | Multiple *co-equal* stars → in-fighting, no tiebreaker. | One primary star; everything else is input or guardrail. |

NN/g's warning: a single-metric North Star *"can be dangerous, because it amplifies the inherent limitations of that individual metric."* → guardrails are not optional.

---

## Multi-business / multi-P&L operators

Most North Star literature is consumer SaaS (daily active users, time-spent). For an **operations-heavy or multi-business operator**, the doctrine prescribes a **layered hierarchy**: one enterprise North Star (to preserve focus) + 2–4 domain/sub-metrics that **roll up coherently** to it — *not* co-equal stars. Amplitude names this as the explicit exception for companies with distinct lines of business serving different customer bases, each with their own inputs — but frames it as the exception, not the norm, and says to challenge the need first.

> Note: most *documented* examples are product-led (marketplace liquidity, developer engagement). The pattern is sound for services and operations too — you'll be adapting it rather than copying a worked example. When you aggregate sub-metrics into the enterprise number, weight them by value (e.g. revenue contribution), not by raw volume — otherwise a high-volume, low-value line can dominate the headline.

---

## How to choose yours — the process

1. **Name the customer value.** What core value does your product or service deliver? The metric that best captures *customers getting that value* is your North Star candidate.
2. **Run the 7-point test.** If the candidate fails "represents customer value," or you can move it *directly*, it's an input metric — not the star. Go up a level.
3. **Map 3–5 input metrics** — the levers your teams act on directly that you believe drive the star.
4. **Choose guardrails** — quality, churn, unit economics — so optimizing the star can't quietly break something else.
5. **Place revenue below, not at, the top.** Revenue is the lagging result the star predicts — track it to confirm the star points the right way, never as the star itself.
6. **Validate empirically.** Move an input; if the star doesn't move, discard that input. Confirm the star tracks revenue over time. Until the data backs it, your framework is a set of hypotheses, not a truth.

---

## Sources

**Primary:** Amplitude — [Good vs Bad North Star Metric](https://amplitude.com/blog/good-bad-north-star-metric) (also the source of the John Cutler quotes), [North Star Playbook (PDF)](https://info.amplitude.com/rs/138-CDN-550/images/Amplitude-The-North-Star-Playbook.pdf), [About the North Star Framework](https://amplitude.com/books/north-star/about-north-star-framework); Reforge / Brian Balfour — [North Star Metric & Growth (essay)](https://brianbalfour.com/essays/north-star-metric-growth).
**Secondary:** [Reforge — North Star Metric Growth](https://www.reforge.com/blog/north-star-metric-growth); [Umbrex — NSM Framework](https://umbrex.com/resources/frameworks/strategy-frameworks/north-star-metric-framework/); [NN/g — Campbell's Law](https://www.nngroup.com/articles/campbells-law/); [Stage 2 Capital — Revenue is a Dangerous North Star Metric](https://www.stage2.capital/blog/revenue-is-a-dangerous-north-star-metric-heres-why).
