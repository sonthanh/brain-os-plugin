# AC coverage spec — parent acceptance gate SSOT

Single source of truth for the `## Covers AC` ↔ parent `## Acceptance` contract used by the three-gate pipeline that prevents `/impl story` from closing parents whose acceptance criteria never actually ran (origin bug: a prior story shipped "fake-done" — children all green, parent acceptance literally never executed).

**Consumed by 5 downstream artifacts — they MUST cite section numbers from this doc, never re-derive shape or regex:**

| Consumer | Section(s) cited | Purpose |
|----------|------------------|---------|
| `skills/slice/SKILL.md` Step 2.6 (Gate A — file-time) | § 1, § 2, § 3 | Refuse to file children if any parent AC bullet has zero coverage |
| `scripts/run-story.ts` `runPreCheck()` (Gate B — start-time) | § 1, § 3 | Refuse `/impl story` start if children lack `## Covers AC` mapping |
| `scripts/run-story.ts` close gate (Gate C — close-time) | § 2, § 3, § 4 | Refuse parent close until each AC#N has evidence form (i) or (ii) |
| `skills/tdd/SKILL.md` Q4 SKIPPED-rejection scope | § 1, § 6 | Refuse GREEN when child covers ≥1 live-AC bullet AND any test SKIPPED |
| `skills/impl/SKILL.md` advisor-gate scope + instrumentation row | § 1, § 5, § 6 | Advisor verdict only fires for live-AC children; one row per `/impl story` run |

If any downstream consumer disagrees with this doc, this doc wins — the consumer is the bug. Open an issue against `references/ac-coverage-spec.md` to settle the change here first, then propagate.

**Design context (private vault):** `{vault}/daily/grill-sessions/2026-04-30-impl-story-parent-acceptance-gate.md` (settled 2026-05-02, Q1–Q9 closed). Parent story tracked in the operator's task repo (see `brain-os.config.md` for `gh_task_repo`).

---

## 1. `## Covers AC` shape (child body)

Every child issue body filed under a parent story carries a `## Covers AC` H2 section. The section enumerates parent AC bullet IDs the child claims to satisfy with live evidence — each on its own bullet line, one ID per bullet, no free-form prose.

**Form:**

```markdown
## Covers AC

- AC#<N>
- AC#<M>
```

- `<N>`, `<M>` are positive integers matching IDs in the parent's `## Acceptance` section (see § 2).
- One ID per bullet. Multi-ID bullets (`- AC#1, AC#3`) are NOT supported — the parser does not split.
- Whitespace tolerated (trailing spaces, blank lines inside section). Section ends at the next `## ` H2 header or EOF.
- Order does not matter. The parser collects the ID set, not a sequence.

### 1.1. Empty section (pure-component child)

A pure-component child — scaffolding, build wiring, refactor — does NOT cover any parent AC bullet. Its `## Covers AC` section MUST exist but MUST be empty (no bullets between header and next H2):

```markdown
## Covers AC

## What to build
```

**Why required-but-empty over omitted:** Gate B (`runPreCheck()`) treats absence as a filing bug — it cannot distinguish "child is component" from "filer forgot to add the section". Empty section asserts intent.

### 1.2. Sample shapes (in-the-wild)

| Shape | Section content | ID set |
|-------|-----------------|--------|
| Single-AC child | `- AC#1` | `{1}` |
| Multi-AC child | `- AC#5`<br>`- AC#8` | `{5, 8}` |
| Adjacent-AC child | `- AC#3`<br>`- AC#4` | `{3, 4}` |
| Pure-component child | _(empty)_ | `{}` |

A child is a **live-AC child** iff its `## Covers AC` ID set intersects the parent's live-AC ID set (defined in § 6). Children with empty Covers AC, OR whose Covers AC IDs all map to non-live parent AC bullets (e.g. covers only AC#7 = "Verified by inspection"), are **pure-component children** (no advisor cost, standard /tdd green = green).

Why intersection, not just non-empty: a child covering only non-live parent ACs (e.g. inspection-only AC#7) doesn't need advisor verification — the parent AC itself is inspection-only. The intersection rule keeps advisor cost proportional to live-evidence demand. This SUPERSEDES the shorthand "non-empty Covers AC" used in the parent story's settled prose; the SSOT is this doc.

---

## 2. Parent `## Acceptance` shape

The parent story body carries a `## Acceptance` H2 section. Each AC bullet is a GitHub task-list checkbox item with a bolded ID and an em-dash description:

**Form:**

```markdown
## Acceptance

- [ ] **AC#<N>** — <description>
- [ ] **AC#<M>** — <description>
```

- `<N>`, `<M>` are monotonically increasing positive integers starting at 1. Holes (skipped numbers) are an editing bug, not a parser concern — Gate A surfaces holes by reporting "AC#X has zero coverage" against IDs that exist.
- `**AC#N**` is the bold ID (Markdown `**…**`). The parser anchors on this; other bold spans elsewhere in the bullet are tolerated.
- Em-dash separator is U+2014 `—` (NOT a hyphen `-` or en-dash `–`). The grill settled on em-dash for visual scanning + parser disambiguation.
- Description is free-form prose; it is the human-readable acceptance criterion, plus a "Verified by …" clause that drives the live-AC detection rule (§ 6).
- Checkbox state (`[ ]` vs `[x]`) is irrelevant to the gate — the parser strips it. Gate C uses evidence forms (§ 4), not checkbox state, to decide closure.

### 2.1. Live-AC bullet (sample)

```markdown
- [ ] **AC#1** — Gate A: /slice refuses to file children when any parent `## Acceptance` bullet has zero coverage. Verified by replaying the prior story's grill-to-children: /slice flags AC#1 (live integration AC) has zero coverage; refuses file.
```

Contains `Verified by` + the live marker `live` → classified live-AC (see § 6).

### 2.2. Non-live AC bullet (sample)

```markdown
- [ ] **AC#7** — `references/ac-coverage-spec.md` exists; documents `## Covers AC` shape, parser regex, evidence forms, instrumentation log layout. Verified by inspection.
```

Contains `Verified by` but no marker from the live-AC list → classified non-live (component / inspection-only AC).

---

## 3. Parser regex set

All three regexes use ECMA-flavor (PCRE-compatible enough for Bun, JavaScript, ripgrep, Python `re`). Each is anchored to line boundaries (`^…$`) and is intended to be applied per-line over the body text after splitting on `\n`. The parent-AC and parent-comment regexes are global (multiple matches per body); the child-Covers-AC regex is scoped — apply only inside the `## Covers AC` section (locate header + walk lines until next `## `).

### 3.1. Parent-AC regex

```regex
^- \[[ x]\] \*\*AC#(\d+)\*\* — (.+)$
```

- Group 1: AC bullet ID (integer).
- Group 2: description text.
- `[ x]` accepts both unchecked `[ ]` and checked `[x]`.
- Em-dash `—` (U+2014) is literal.

### 3.2. Child Covers-AC regex (per-line, inside section)

```regex
^- AC#(\d+)\s*$
```

- Group 1: AC bullet ID (integer).
- `\s*$` swallows trailing whitespace.
- Lines that don't match (blank lines, prose stray) are ignored — the parser does NOT error on them; non-matching lines simply contribute zero IDs.

### 3.3. Parent-comment evidence regex

```regex
^Acceptance verified: AC#(\d+) — (.+)$
```

- Group 1: AC bullet ID (integer).
- Group 2: free-form evidence text (commit SHAs, vault paths, observation summary).
- Anchor at line start (`^`) — comment may have other lines (e.g., emoji header, signoff). The parser scans the comment body line-by-line; first match wins per AC#N within a single comment.
- Em-dash `—` (U+2014) is literal.

### 3.4. Regex test table — samples + expected matches

Apply each regex to the sample line. `MATCH` rows show captured groups; `NO MATCH` rows show why the regex correctly rejects.

#### 3.4.1. Parent-AC regex tests

Samples (each line is the literal sample, fences strip rendering ambiguity):

```
S1: - [ ] **AC#1** — Gate A: /slice refuses to file children when any parent `## Acceptance` bullet has zero coverage. Verified by replaying prior story grill-to-children: /slice flags AC#1 (live integration AC) has zero coverage; refuses file.
S2: - [x] **AC#7** — `references/ac-coverage-spec.md` exists; documents `## Covers AC` shape, parser regex, evidence forms, instrumentation log layout. Verified by inspection.
S3: - [ ] **AC#10** — Performance instrumentation: each `/impl story <P>` run appends a row to `{vault}/daily/skill-outcomes/impl-story.log`.
S4: - [ ] AC#1 — missing bold markers
S5: - [ ] **AC#1** - hyphen instead of em-dash
```

Results:

| Sample | Result | Group 1 | Group 2 (description) |
|--------|--------|---------|------------------------|
| S1 | MATCH | `1` | the entire description after the em-dash, starting with `Gate A:` and ending with `refuses file.` |
| S2 | MATCH | `7` | the entire description starting with the literal backtick path and ending with `Verified by inspection.` |
| S3 | MATCH | `10` | the entire description starting with `Performance instrumentation:` |
| S4 | NO MATCH | — | rejected: `**AC#1**` bold required; bare `AC#1` does not match |
| S5 | NO MATCH | — | rejected: regex demands em-dash U+2014; ASCII hyphen found |

#### 3.4.2. Child Covers-AC regex tests

Inside a `## Covers AC` section delimited by H2 headers:

| # | Sample line | Result | Group 1 |
|---|-------------|--------|---------|
| 1 | `- AC#1` | MATCH | `1` |
| 2 | `- AC#5  ` (trailing whitespace) | MATCH | `5` |
| 3 | `- AC#8` | MATCH | `8` |
| 4 | `` (blank line) | NO MATCH | — (ignored) |
| 5 | `- AC#1, AC#3` (multi-ID) | NO MATCH | — (rejected: regex requires single integer + EOL; the parser does NOT split on commas — file as separate bullets) |
| 6 | `- ac#2` (lowercase) | NO MATCH | — (rejected: regex requires uppercase `AC#`; lowercase is a filing bug) |

#### 3.4.3. Parent-comment evidence regex tests

Applied per-line within a parent issue comment body. Samples:

```
S1: Acceptance verified: AC#1 — replayed prior story grill-to-children, /slice ABORT'd at AC#1 zero-coverage; pasted output in commit abc1234
S2: Acceptance verified: AC#9 — live integration ran against operator base `appXXXXXXXX`; pass-rate 96.3% logged at `{vault}/daily/skill-outcomes/<skill>.log`:42
S3: AC#1 verified — looks good to me
```

Results:

| Sample | Result | Group 1 | Group 2 (evidence text) |
|--------|--------|---------|--------------------------|
| S1 | MATCH | `1` | the entire text after the em-dash, starting with `replayed prior story` and ending with `commit abc1234` |
| S2 | MATCH | `9` | the entire text starting with `live integration ran against` and ending with `<skill>.log:42` (literal backticks preserved) |
| S3 | NO MATCH | — | rejected: missing `Acceptance verified: ` prefix |

### 3.5. Self-acceptance evidence regexes

Posted on the just-closed issue ITSELF (not the parent) by `/impl` § 6.5 to record that the issue's own `## Acceptance` bullets were self-assessed. Two regexes — one for met, one for out-of-scope. Both anchor at line start; comment may have other lines.

```regex
^Self acceptance verified: AC#(\d+) — (.+)$
^Self acceptance deferred: AC#(\d+) — (.+)$
```

- Group 1: AC bullet ID (integer).
- Group 2: free-form evidence text (test counts, commit SHA, grep counts) for `verified`; reason for `deferred`.
- Em-dash `—` (U+2014) is literal.
- The `Self acceptance` prefix is the discriminator from § 3.3's `Acceptance verified`. A backfill or audit script reading an issue's comments can tell self-evidence (this issue's own AC) from parent-evidence (a child issue verifying its parent's AC) by the prefix.

`verified` triggers a body tick on the same issue (`tickAcceptance(body, acId)` from `scripts/run-story.ts`); `deferred` leaves the checkbox `[ ]` because the AC was not actually satisfied — only acknowledged as out-of-scope for this code change.

#### 3.5.1. Self-acceptance regex tests

Samples (each is a single line in the issue's own comment body):

```
S1: Self acceptance verified: AC#1 — bun test scripts/run-story.test.ts: 47 pass; commit abc1234 — 1 file changed +120/-3
S2: Self acceptance deferred: AC#4 — replay v6 requires running on the active operator base; not a code change.
S3: Self acceptance verified: AC#10 — log file at {vault}/daily/skill-outcomes/impl.log appended on every /impl run (verified by inspection: 12 rows added since fix)
S4: self acceptance verified: AC#1 — lowercase prefix
S5: Self acceptance verified: AC#1 - hyphen instead of em-dash
```

| Sample | Result | Group 1 | Group 2 (text) |
|--------|--------|---------|-----------------|
| S1 | MATCH (verified) | `1` | `bun test scripts/run-story.test.ts: 47 pass; commit abc1234 — 1 file changed +120/-3` |
| S2 | MATCH (deferred) | `4` | `replay v6 requires running on the active operator base; not a code change.` |
| S3 | MATCH (verified) | `10` | `log file at {vault}/daily/skill-outcomes/impl.log appended on every /impl run (verified by inspection: 12 rows added since fix)` |
| S4 | NO MATCH | — | rejected: regex demands `Self acceptance` (capital S, capital A); lowercase is a filing bug |
| S5 | NO MATCH | — | rejected: regex demands em-dash U+2014; ASCII hyphen found |

---

## 4. Evidence forms (Gate C — parent close)

**Phase 2 update (post-#219):** Form (ii) — parent-comment evidence — is the canonical and only accepted form. Form (i) — closed-child implicit evidence — is **DEPRECATED**; Gate C no longer accepts it. See § 4.1 for the migration path that backfills explicit comments for in-flight stories that previously relied on form (i).

For each AC#N parsed from parent `## Acceptance`, Gate C accepts evidence only via form (ii). Both forms are documented below; form (i) is retained for historical context and to define the migration path, but the Gate C close path no longer ticks AC bullets on form-(i) match alone.

### 4.1. Form (i) — closed child evidence (DEPRECATED — Phase 2 #219 C3)

> **DEPRECATED 2026-05-03 (Phase 2 #219 C3).** Gate C no longer accepts this form. AC bullets tick `[x]` only when form (ii) (§ 4.2) matches. The deprecation is enforced in `scripts/run-story.ts` (covered by #221).
>
> **Why deprecated:** form (i) made AC verification opaque — "AC#N is satisfied because child #M is CLOSED and lists AC#N in its `## Covers AC`" required code archaeology to answer "what evidence proves AC#N actually ran live?". Stories like #207 + #196 closed children via per-child `/impl` without ever surfacing evidence on the parent, and the parent stayed OPEN because Gate C only fired through `/impl story` orchestrator. Phase 2 makes evidence explicit at the parent surface (form (ii) only) and triggers Gate C from per-child `/impl` close (#220).
>
> **Migration path for in-flight stories that relied on form (i):**
>
> - Stories drained via `/impl <child-N>` per-child after #220 ships: `/impl` posts `Acceptance verified: AC#N — <evidence>` comments on the parent automatically at child-close, satisfying form (ii). No operator action required.
> - Stories that already closed children before #220 shipped (e.g. #207, #196): operator (or `/impl story` ralph fallback) manually posts `Acceptance verified: AC#N — <evidence>` comments on the parent retroactively. Once posted, re-run `/impl story <P>` to re-trigger Gate C; AC ticks + parent closes.
> - Stories whose children are closed by `gh CLI` or the GitHub web UI (not via `/impl`): manual `Acceptance verified` posts are the only path — the per-child auto-emission path in #220 only runs through `/impl <N>`.

A child issue exists in the parent's sub-issue list, is in CLOSED state, and its body's `## Covers AC` ID set contains N.

**Algorithm (historical, no longer wired into Gate C):**

1. Parent body: parse sub-issue checklist (`- [x] #<id>` lines). Collect `child_id` set.
2. For each `child_id`: `gh issue view <child_id> --json state,body`. Filter to `state == "CLOSED"`.
3. Apply child Covers-AC regex (§ 3.2) inside `## Covers AC` section. Collect `covered_ac_set`.
4. AC#N has form (i) evidence iff `N ∈ covered_ac_set` of any closed child.

### 4.2. Form (ii) — parent-comment evidence (CANONICAL)

A comment on the parent issue contains a line matching the parent-comment evidence regex (§ 3.3) with capture group 1 = N.

**Algorithm:**

1. `gh issue view <parent_id> --comments --json comments`.
2. Per comment, split body on `\n`, apply regex per line, collect matched `(ac_id, evidence)` pairs.
3. AC#N has form (ii) evidence iff any comment yielded `ac_id == N`.

Form (ii) is the HITL ack path — the user (or `/impl` ralph fallback) posts a comment summarizing the evidence. No special "approval" mechanism beyond the regex match.

### 4.3. Form (i) example

A parent story with a sub-issue checklist containing `- [x] #199`:
- `#199` body has `## Covers AC` listing `- AC#1`.
- `#199` state = CLOSED.
- → AC#1 has form (i) evidence via #199.

### 4.4. Form (ii) example

Comment posted on parent issue:

```
Replayed prior story grill manually 2026-05-08 — /slice ABORT'd correctly at AC#1.

Acceptance verified: AC#1 — manual replay of grill-to-children flow; /slice ABORT'd at the "AC#1 zero-coverage" check (`{vault}/daily/replay-logs/2026-05-08-replay.log`).
```

→ AC#1 has form (ii) evidence via comment regex match.

### 4.5. Failure mode

If AC#N has no form (ii) evidence, Gate C refuses parent close. The orchestrator (`run-story.ts`) escalates per the parent story's settled Q9 (ralph 3 iters auto-filing evidence-gathering children, then HITL `osascript` notify).

**Phase 2 (#219 C3) note:** form (i) closed-child implicit evidence is no longer accepted (§ 4.1). A parent whose AC bullets only have closed-child coverage but no `Acceptance verified: AC#N — …` comment is treated as missing evidence and triggers the same Gate C escalation as a fully bare AC. Use the migration path in § 4.1 to backfill comments for in-flight stories.

### 4.6. Form (iii) — self-acceptance evidence (CANONICAL for leaf AC)

A comment on the just-closed issue ITSELF contains a line matching the self-acceptance regex (§ 3.5) with capture group 1 = N. Posted by `/impl` § 6.5 immediately after `close-issue.sh` succeeds and the leaf's `## Acceptance` is parsed. Two variants — `verified` triggers a body tick; `deferred` leaves the checkbox `[ ]` and records why.

**Why a separate form for self-AC:** form (ii) covers child→parent acceptance evidence — a child issue verifying its parent story's AC. Form (iii) covers an issue verifying its OWN AC. Until form (iii) shipped (`/impl` § 6.5), leaf issues' `## Acceptance` checkboxes had no actor: orphan leaves filed without `/slice` (raw `gh issue create` for ad-hoc bugs) closed with all AC unticked because §§ 6.1–6.4 short-circuit on missing native parent. Form (iii) is the per-leaf mirror of form (ii).

**Algorithm:**

1. `gh issue view <leaf_id> --json comments` (the leaf is the just-closed issue, NOT a parent).
2. Per comment, split body on `\n`, apply both § 3.5 regexes per line:
   - `^Self acceptance verified: AC#(\d+) — (.+)$` → `(ac_id, evidence)`, intent: tick body.
   - `^Self acceptance deferred: AC#(\d+) — (.+)$` → `(ac_id, reason)`, intent: leave checkbox unticked, record reason.
3. AC#N has form (iii) `verified` evidence iff any comment yielded a `verified` match for `ac_id == N`.
4. AC#N has form (iii) `deferred` evidence iff any comment yielded a `deferred` match for `ac_id == N` AND no `verified` match exists for the same ID. (`verified` wins over `deferred` when both are present — operator may post `deferred`, then later verify and tick.)

Form (iii) is unrelated to Gate C — Gate C only fires for parent stories at close-time, and parent close uses form (ii) on parent comments. Form (iii) is the per-leaf evidence trail and the body-tick driver, with no parent-close coupling.

### 4.7. Form (iii) example

Issue #234 (a leaf bug fix) closes with 4 AC bullets in its body. `/impl` § 6.5 self-assesses:

```
Self acceptance verified: AC#1 — extractSlice runs reverse-lookup unconditionally; commit 8b84577
Self acceptance verified: AC#2 — source_url built deterministically (extract-slice.mts:912-914)
Self acceptance verified: AC#3 — SliceRejectedError thrown on no-match; escalation.md written
Self acceptance deferred: AC#4 — replay v6 against operator's active base requires live ops, not a code change
```

After § 6.5 completes:
- `gh issue view 234` body shows AC#1, #2, #3 ticked `[x]`; AC#4 stays `[ ]`.
- Comment thread on #234 contains 4 form-(iii) lines (3 verified, 1 deferred).
- Audit: anyone reading #234 sees both the body state AND the comment trail explaining each verdict.

---

## 5. `impl-story.log` instrumentation row layout

Every `/impl story <P>` run appends exactly ONE row to `{vault}/daily/skill-outcomes/impl-story.log` on completion (success or failure). Append-only — never edit prior rows. The log is the SSOT for measuring advisor-gate cost over time and is referenced by the parent story's AC#10.

**Format:** TSV (tab-separated), no header row (the log is consumed by `awk` / `cut` — header lines would require everyone to skip line 1).

**Column order (8 columns):**

| # | Column | Type | Description |
|---|--------|------|-------------|
| 1 | `date` | `YYYY-MM-DD` | Date the `/impl story` run completed (operator's local TZ). |
| 2 | `parent_issue` | integer | Parent story issue number (operator's task repo). |
| 3 | `child_count` | integer | Total child issues drained in this run. |
| 4 | `live_ac_child_count` | integer | Subset of `child_count` that are **live-AC children** per § 1.2 (Covers AC ID set intersects parent live-AC ID set per § 6). |
| 5 | `advisor_calls` | integer | Total advisor invocations across all live-AC children (3 retries → up to 3 per child). |
| 6 | `advisor_rejections` | integer | Subset of `advisor_calls` that returned "AC NOT met" verdict. |
| 7 | `wall_time_sec` | integer | Elapsed seconds from `/impl story` start to terminal state. |
| 8 | `result` | enum | `pass` (parent closed), `partial` (some children green, parent OPEN — ralph escalated), `fail` (orchestrator error). |

### 5.1. Sample row

```
2026-05-08	196	7	5	11	2	5430	pass
```

Read: on 2026-05-08, `/impl story 196` drained 7 children, 5 of which were live-AC; advisor was called 11 times across those 5 children (some retried), rejected 2 verdicts (forcing extra ralph iters), wall-time 5430s (≈90 min), parent closed.

### 5.2. Append-only semantics

- One writer per `/impl story` run. The orchestrator (`scripts/run-story.ts`) writes the row in a single `>>` append at terminal state.
- Concurrent runs of different parents are safe — POSIX `O_APPEND` guarantees atomic line writes for lines under PIPE_BUF (4 KB); each row is well under that.
- The log file is created on first run if missing (`mkdir -p` + `touch` then append).
- Rotation / pruning is OUT OF SCOPE for the v1 instrumentation. If the log grows unbounded, file a follow-up issue.

### 5.3. Consumed by

- `/improve` weekly aggregation (advisor cost trend per week).
- Manual inspection (`tail -20 {vault}/daily/skill-outcomes/impl-story.log`) when investigating "did this story actually run advisor?".
- Future verdict-cache decision: parent story's settled decisions deferred verdict cache; if log shows >10 advisor calls/story average or recurring same-SHA repeats, file a verdict-cache issue.

---

## 6. Live-AC bullet detection rule

Used by Gate C (parent-close), `/tdd` Q4 (scoped SKIPPED rejection), and `/impl` advisor-gate scope to decide which AC bullets demand live evidence vs which are inspection-only.

### 6.1. Rule

A parent AC bullet is **live-AC** iff its description (Group 2 of § 3.1 regex) matches BOTH conditions:

1. Contains the substring `Verified by` (case-sensitive); AND
2. Contains at least ONE substring from the marker list:

```
runs against
pasted output
live
vault paths
pass-rate
gh comment posted
cache exists
log appended
osascript
```

Markers are matched as case-sensitive literal substrings — no word boundary check. Bullets failing condition 1 OR condition 2 are **non-live** (component / inspection-only).

### 6.2. Worked example — applied to a 10-AC parent story

Applying the rule to a representative 10-AC parent (the very story this spec was filed under):

| AC# | Description summary | "Verified by" | Marker hit | Class |
|-----|---------------------|---------------|------------|-------|
| 1 | Gate A refuses file on zero coverage; verified by replay with "live" descriptor | ✓ | `live` | **LIVE** |
| 2 | Gate B blocks /impl story start; verified by attempting `/impl story <P>` → BLOCK + comment | ✓ | none | non-live |
| 3 | Gate C deterministic check; verified by hand-constructed test parent | ✓ | none | non-live |
| 4 | Gate C ralph auto-fill; verified by injected gap → osascript notify HITL | ✓ | `osascript` | **LIVE** |
| 5 | /tdd scoped SKIPPED rejection; verified by injected SKIPPED test in live-AC child | ✓ | `live` | **LIVE** (false positive — see § 6.3) |
| 6 | /impl child-level ralph + advisor; verified by injected child whose code passes but advisor rejects | ✓ | none | non-live |
| 7 | This spec exists; verified by inspection | ✓ | none | non-live |
| 8 | /tdd `--prior-attempt-failed-because` arg; verified by /impl integration test | ✓ | none | non-live |
| 9 | Prior-story retro: live integration child runs; pass-rate logged in vault | ✓ | `live`, `runs against`, `pass-rate` | **LIVE** |
| 10 | Performance instrumentation: each run appends a row; verified by inspecting log after a real run | ✓ | none | non-live (false negative — see § 6.3) |

Net: 4 LIVE (AC#1, #4, #5, #9), 6 non-live. Advisor gate fires on children covering {1, 4, 5, 9}; Gate C demands evidence for the same set under stricter live-evidence interpretation.

### 6.3. Known imprecision (deferred)

The rule is conservative substring matching. Two failure modes are KNOWN and ACCEPTED for v1:

- **False positive (AC#5 above):** "live-AC child" is descriptive of the test fixture, not live evidence. Treating it as live-AC means advisor gates the SKIPPED-rejection test child unnecessarily — extra cost, no harm. Trade-off accepted; refining requires NLP.
- **False negative (AC#10 above):** AC says "inspecting log after a real run" — semantically a live verification, but lacks the literal marker `log appended`. AC#10 won't trip advisor / Gate C live-evidence path; it ships through standard form (i)/(ii) deterministic check only.

Refinement deferred until measured `impl-story.log` data shows the rule misclassifying enough bullets to matter. File a follow-up issue if false-positive cost or false-negative ship-fakes recur.

### 6.4. Used by

| Consumer | How |
|----------|-----|
| `/tdd` Q4 SKIPPED-rejection | A child's `## Covers AC` ID set ∩ live-AC ID set ≠ ∅ → `/tdd` refuses GREEN if any test SKIPPED |
| `/impl` advisor-gate scope | Same intersection — advisor only fires for children whose Covers AC overlaps the live-AC set |
| `/impl` instrumentation | Column 4 of § 5 row (`live_ac_child_count`) = count of children with non-empty intersection |

---

## 7. Parent body format (Phase 2 — post-#219)

This section defines the parent story body shape introduced by Phase 2 (#219). Three sections of the parent body are formalized here: the `## Sub-issues` list, the `## Acceptance` bullet evidence-link annotation, and the optional `## Verification (post-merge, manual)` section. The `/slice` skill emits this format when filing parent stories (covered by #222); `scripts/run-story.ts` reads this format at Gate C close-time (covered by #221).

### 7.1. Sub-issues section format (list-only, no checkbox)

```markdown
## Sub-issues

- #<child-N> — <title>
- #<child-M> — <title>
```

- Bare same-repo `#N` reference, no checkbox prefix.
- One child per bullet line; child title trails the em-dash for offline-readable index.
- Em-dash separator is U+2014 `—` (consistent with § 2's AC bullet format).
- Cross-repo references (`<repo>#N`) are NOT supported here — sub-issues live in the same repo as the parent (GitHub's native sub-issue mechanism is single-repo).

**Why no checkbox:** GitHub's native sub-issue panel renders a progress bar + status badges from the sub-issue link graph established via the `addSubIssue` GraphQL mutation. Parent body checkboxes for sub-issues would duplicate that signal and drift out of sync (closing a child via `gh CLI` does not auto-tick a body checkbox). Phase 2 shifts sub-issue status UX entirely to the native panel; the body section is a stable text anchor + offline-readable index only.

**Cross-reference:** `/slice` Step 6 calls the `addSubIssue` GraphQL mutation per child filed and Step 7 emits the Sub-issues section in this format — covered by #222.

### 7.2. Acceptance bullet evidence-link annotation

The Phase 2 form of an AC bullet appends a Markdown evidence-link annotation to the description:

```markdown
- [ ] **AC#<N>** — <requirement> — [evidence ↗](#issuecomment-<comment-id>)
```

- `<comment-id>` is the GitHub numeric ID of the parent comment matching the form (ii) regex (§ 3.3) for AC#N.
- `[evidence ↗](url)` Markdown reads as a clickable arrow that jumps the reader to the comment that proves the AC.
- The annotation is APPENDED to the description; it does NOT replace the `Verified by …` clause used by the live-AC detection rule (§ 6).
- The em-dash before `[evidence ↗]` is the same U+2014 separator pattern used elsewhere.

**Compatibility with the parent-AC regex (§ 3.1):** the existing regex `^- \[[ x]\] \*\*AC#(\d+)\*\* — (.+)$` continues to match — Group 2 captures the entire description including the trailing `— [evidence ↗](url)` annotation. No regex change required for Phase 2.

**Filing-time placeholder:** when `/slice` files the parent body, the comment ID does not yet exist (no comments posted until child-close runs `/impl` per #220). `/slice` emits the placeholder annotation `— [evidence ↗](#issuecomment-PLACEHOLDER)`; `scripts/run-story.ts` rewrites the placeholder to the real comment URL when ticking the AC at Gate C (covered by #221's `tickAcceptance(body, acId)` function).

**Multi-child AC coverage:** when more than one child covers the same AC#N, the annotation links to the FIRST evidence comment (lowest comment ID matching form (ii) for that AC) and notes additional coverers inline:

```markdown
- [ ] **AC#3** — <requirement> — [evidence ↗](#issuecomment-12345) (also covered by #M, #K)
```

**Cross-reference:** `/slice` Step 7 emits the bullet AC + evidence-link annotation; the placeholder is rewritten by `tickAcceptance(body, acId)` at Gate C close-time — covered by #222 and #221.

### 7.3. `## Verification (post-merge, manual)` section

Optional H2 section in the parent body that asserts a manual verification gate beyond Gate C's deterministic AC evidence check. Used for stories where child completion + AC tick do NOT constitute end-to-end story success (e.g. parent #207 needed Day-20 next-FB-post live validation before declaring the writing-style split actually shipped).

**Detection regex:**

```regex
^## Verification \(post-merge, manual\)$
```

- Anchored to a single line; matches the H2 header literally with escaped parens.
- Apply per-line over the parent body after splitting on `\n`; first match in the body suffices.
- Section content is free-form prose (the manual verification checklist or instructions); the parser only checks for the header presence.

**Gate C behavior when present:** instead of closing the parent on AC evidence pass, `scripts/run-story.ts` posts a parent comment with the literal text `Gate C passed; manual verification pending — parent left OPEN` and skips the `gh issue close` call. AC bullets are still ticked `[x]` per `tickAcceptance(body, acId)` so the evidence trail is preserved on the parent body. The parent issue remains OPEN until the operator manually closes it after performing the verification checklist.

**Gate C behavior when absent:** the existing Gate C close path runs unchanged — tick AC bullets, then `gh issue close`.

**Why per-parent opt-in vs global default:** most stories' AC bullets fully capture end-to-end success (Phase 1 #196's design assumption). Stories with manual post-merge gates are the exception; making it default-on would force every operator to add an explicit `Verification: NONE` line on the typical case. Opt-in via section presence keeps the typical case zero-config and surfaces the exception as visible body text.

**Cross-reference:** the section detection + Gate C behavior live in `scripts/run-story.ts` Gate C close path — covered by #221.

---

## Cross-references

### Phase lineage (decisions encoded in this spec)

| Phase | Parent issue | Settled | Decisions encoded here |
|-------|--------------|---------|------------------------|
| Phase 1 | **#196** — Story: Parent acceptance gate for /impl story (no fake-done) | 2026-05-02 | § 1 (`## Covers AC` shape), § 2 (parent `## Acceptance` shape), § 3 (parser regex set), § 4 originally (both forms accepted), § 5 (`impl-story.log` instrumentation), § 6 (live-AC detection rule). Source: three-gate doctrine A/B/C established. |
| Phase 2 | **#219** — Story: Story-parent state ownership — AC tick + native sub-issues + form-(ii) canonical | 2026-05-03 | § 4 update (form (i) DEPRECATED + migration note), § 7 (parent body format: Sub-issues list-only + AC evidence-link annotation + `## Verification (post-merge, manual)` section). Source: child-level `/impl` close-trigger + form-(ii) canonical decision. |
| Phase 2.1 | hot-fix (no story — direct fix per user) | 2026-05-03 | § 3.5 (self-acceptance regexes), § 4.6 (form (iii) self-acceptance evidence), § 4.7 (form (iii) example using #234). Source: orphan-leaf gap surfaced by ad-hoc-filed issues #234 + #235 closing with all AC unticked because §§ 6.1–6.4 short-circuit on missing native parent. |

Phase 2 supersedes Phase 1 § 4's two-form acceptance; otherwise Phase 1 sections (§ 1–§ 3, § 5, § 6) carry forward unchanged. Phase 2.1 adds form (iii) without superseding any prior form — leaf self-AC was previously unaddressed.

### Vault context

- **Phase 1 design context (private vault):** `{vault}/daily/grill-sessions/2026-04-30-impl-story-parent-acceptance-gate.md` (settled 2026-05-02)
- **Phase 2 design context (private vault):** `{vault}/daily/grill-sessions/2026-05-03-story-parent-state-ownership.md` (settled 2026-05-03)
- **Aha pattern reference:** `{vault}/thinking/aha/2026-04-17-phase-boundary-blind-spot.md` (handoff between /grill → /slice → /impl)
- **Prior gate doctrine:** `{vault}/daily/grill-sessions/2026-04-27-slice-audit-gate-p1-p2.md` (deterministic gate at file-time pattern)
- **Tracer-bullet doctrine:** `{vault}/daily/grill-sessions/2026-04-25-skill-process-pocock-adoption.md` (component vs vertical-slice children)

`{vault}` resolves via `hooks/resolve-vault.sh`.
