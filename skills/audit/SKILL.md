---
name: audit
description: "One-shot principle check via advisor. Use when you want to stress-test a decision, plan, or code against your principles — non-interactive, returns findings. For interactive stress-testing, use /grill instead."
---

# Principle Audit

One-shot audit of current context through your curated principles, verified by a stronger model (advisor). Unlike `/grill` (interactive, asks questions), `/audit` is non-interactive — it loads principles, calls advisor, and returns findings.

## Usage

```
/audit           # p0: auto-pick top 3 most relevant principles
/audit p1        # audit through P1 (First Principles) only
/audit p0        # same as bare /audit
/audit p1 p5     # audit through P1 + P5
```

## How It Works

1. Read principles from `{vault}/thinking/principles/tracker.md`
2. Pick principles: p0 auto-selects top 3 most relevant to current context, or use specified IDs
3. Print selected principles into conversation (so advisor sees them)
4. State: "Audit this conversation context through these principles. For each principle: does the current approach pass or fail? What specifically needs to change?"
5. Call `advisor()` — stronger model applies principles independently
6. Format advisor findings for the user
7. Log principle usage to tracker (date, principles, context, outcome)

## Principle Selection (p0 logic)

When no specific principle is given, pick the **top 3 most relevant** to what's currently being discussed. Relevance = how directly the principle challenges or validates the current approach. Deep > wide.

Single principle audits produce the sharpest results. Default to p0 (3) but respect user's specific picks.

## Output

Present the advisor's findings directly. Then append a structured summary:

```
## Audit Summary
| Principle | Verdict | Key Finding |
|-----------|---------|-------------|
| P1 | PASS/FLAG/FAIL | one-line finding |

Logged to tracker.
```

## Tracker Integration

After each audit, append to the Log table in `{vault}/thinking/principles/tracker.md`:

```
| {date} | {principles} | {context} | {outcome} |
```

Also increment the Uses count for each principle applied.
