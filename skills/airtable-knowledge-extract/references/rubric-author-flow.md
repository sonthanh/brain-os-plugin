# rubric-author flow — operator review of AI-drafted /think queries

`scripts/rubric-author.mts` produces a per-base `rubric-questions.md` draft (N
synthetic queries the vault should answer after import). Before scoring the
diff, the operator reviews and refines that draft.

## Two review modes

| Mode | When | How invoked |
|------|------|-------------|
| **Interactive grill** (default) | Operator is at a TTY; wants per-question grounding with concrete sample records | `bun run rubric-author.mts <base-id>` |
| **Editor escape hatch** | Batch / non-interactive contexts, or operator prefers vim-style editing | `bun run rubric-author.mts <base-id> --editor` |

Default switched from `$EDITOR` to interactive grill on 2026-05-03 (issue #228).
Rationale: vim showed 20 raw questions with no concrete grounding; operators
tuned to AI questions instead of expressing intent. Live grill with a sample
record per question lets operators react to a *concrete instance* — see the aha
note `2026-05-02-verify-cheap-is-key-with-ai.md`.

## Grill mechanics

For each AI-drafted question, the grill prints:

```
Question 3/20: Which OKRs depended on which company milestones?
  Sample (Companies):
  {
    "Name": "Acme",
    "Founder": "..."
  }
Action [k/d/rewrite/batch/+]:
```

The sample record cycles deterministically through the airtable scan's
non-empty samples (`samples[i % samples.length].records[0]`), so the operator
always has *some* concrete record to anchor against, even when the question
crosses multiple tables.

### Per-question shortcuts

| Input | Effect |
|-------|--------|
| (empty) | Keep this question verbatim (defaults to keep) |
| `k` | Keep this question verbatim |
| `d` | Drop this question |
| `<free text>` | Rewrite this question with the typed text |
| `+` | Jump to add-mode now; remaining questions auto-kept |

### Batch shortcuts

A single line can decide multiple slots at once. Each range needs an explicit
`k`/`d` prefix:

| Input | Effect |
|-------|--------|
| `k 1-5` | Keep questions 1..5 |
| `d 6,7` | Drop questions 6 and 7 |
| `k 1-5 d 6,7 d 9-12` | Keep 1..5, drop 6,7, drop 9..12 |

After a batch line, the loop's auto-skip moves the cursor past freshly-decided
slots and prompts the next undecided one. Slots outside the entered ranges
remain undecided and will be prompted individually.

Malformed batches (range without prefix, e.g. `k 1-5 7-9`) fall through to the
"rewrite" branch — the literal text becomes the question's rewrite, which is
visible in the next render and the operator can correct.

### Add-mode (always runs at the end)

After every AI question is decided (or after `+`), the grill invites:

```
Add new questions (empty line to finish):
Add: ▮
```

Each non-empty line becomes an additional question. Empty line ends add-mode.

## Final output

The operator's choices assemble into `rubric-questions.md`:

- Kept questions retain their original text + position.
- Rewritten questions replace the original at the same position.
- Dropped questions are omitted (downstream questions shift up).
- Added questions append at the end.

The same `computeDelta` classifier compares (AI draft, final list) slot-by-slot,
so dropping a question shifts subsequent slots and may register them as
"replaced" — that's intentional. `delta_metrics.json` carries the verdict
(`pass` / `pass-with-improve` / `reject`) plus the per-class counts.

## Editor escape hatch

`--editor` runs the original $EDITOR-based flow:

1. Default draft written to `rubric-questions.md`
2. `$EDITOR` opens the file; operator edits and saves
3. File re-read; `computeDelta` runs against the AI draft

Use this mode for:
- Non-TTY environments where readline can't prompt
- Operators who prefer free-form editing over Q&A
- Replaying a prior session's edits non-interactively

## Plumbing notes

- `defaultGrillIO()` writes prompts to **stderr**, not stdout — so the SKILL.md
  supaterm flow's `> /dev/null` redirect on stdout doesn't suppress the UI.
- `defaultGrillIO()` requires a TTY; throws loudly otherwise (mirrors
  `defaultOpenEditor`'s TTY check).
- `runInteractiveGrill` is exported and IO-injectable for tests — see
  `tests/rubric-author.test.ts` for mock IO patterns.
- `parseGrillCommand` and `parseRange` are pure, exported, and unit-tested.
