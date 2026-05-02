# Base selection rules — `/airtable-knowledge-extract`

Single source of truth for which Airtable bases the skill imports from. Consumed by `scripts/list-bases.mts` (now), `scripts/active-bases.mts` (planned), and `scripts/run.mts` per-base loop. Rules added 2026-05-02 per operator clarification.

## Inclusion rule

**Only bases in the operator's primary business workspace.** Other workspaces (free / personal / archived team) are out of scope for v1 import.

The Airtable v0 Meta API does NOT expose `workspaceId` per base for non-enterprise tokens — `GET /v0/meta/bases` returns only `{id, name, permissionLevel}`. Workspace membership is therefore enforced via:

1. **Operator-maintained allowlist** at `~/.brain-os/airtable-premium-bases.txt` (one base ID per line, or one regex-on-name per line prefixed `~`). Empty file or missing file → fall through to inclusion-by-default + rely on exclusion rules below to keep the set sane.
2. **Future:** if Airtable enterprise API access lands, replace the file with a workspace-name lookup. Track via separate issue.

## Exclusion rules (skip if ANY apply)

Applied AFTER the inclusion rule. A base is dropped if it matches any of:

### 1. Archived

Name matches case-insensitive regex `archive\b|^archive\s|\barchive$|archive[d]?\s+\d{4}|^.*Archive (\d{4})`.

### 2. Copy / Imported / Duplicate

Name matches case-insensitive regex `\b(copy|imported|duplicate|backup|clone)\b|^Imported Base$|^Grid view$`.

`Grid view` is the default Airtable copy-fixture name and almost always indicates an unconfigured duplicate.

### 3. Test / Practice / Question / Intern assignment

Name matches case-insensitive regex `\btest\b|\bquestion\s+\d|\bintern\b|\brequired\s+assignment\b|MCO\s+intern|HR\s+(admin|practice)`.

Catches: explicit "Test" bases, internship-application "Question N - <Name>" bases, MCO intern practice bases, HR-onboarding sandboxes.

### 4. Inactive (THE PRIMARY DISCRIMINATOR)

Per operator: *"the key judgement is if base has no activity since beginning of this year, then skip it. Activity is from all members, not only me."*

A base is **inactive** if NO record across ANY table in the base has `_createdTime >= 2026-01-01T00:00:00Z` AND no field-level `Last Modified Time` (when present) shows a value `>= 2026-01-01T00:00:00Z`. If ALL records pre-date 2026-01-01, the base is dormant — skip.

**Probe shape (cheap):** for each table in the base, fetch `?maxRecords=1&sort[0][field]=_createdTime&sort[0][direction]=desc` and inspect `record.createdTime`. If a table additionally exposes a `Last Modified Time` field (any name matching `/last.modified|modified.time|updated.at/i`), probe that too with `direction=desc`. Earliest hit ≥ 2026-01-01 → base active. Otherwise inactive.

**Cost ceiling:** ~100-200 bases × ~5 tables avg × 2 probes ≈ 1000-2000 read requests. Airtable free tier allows 5 req/s — total ~3-7 min. Cache the active/inactive verdict per `(base-id, run-id)` in `~/.claude/airtable-extract-cache/<run-id>/active-bases.json` to avoid re-probing within a run.

## Decision precedence

1. Inclusion (workspace via allowlist): if file exists and base ID not in it, drop. Skip step 2 if dropped.
2. Exclusion 1 (archived): drop on regex hit.
3. Exclusion 2 (copy): drop on regex hit.
4. Exclusion 3 (test): drop on regex hit.
5. Exclusion 4 (inactive): drop if probe says no current-year activity. **The discriminator** — even bases passing 1-4 are skipped here if dormant.

Result: the set of bases passed to `run.mts` is the intersection of (allowlist ∩ ¬archived ∩ ¬copy ∩ ¬test ∩ active-in-current-year).

## Operator override

Sometimes the operator wants to import a single base that fails one of the rules (e.g., re-importing an archived base for legal review). Add the base ID with prefix `!` to the allowlist file:

```
!appXXXXXXXXXXXXXX  # force-include even if exclusion rules match
```

Lines starting with `!` bypass exclusion rules but still respect inclusion (must be in operator's primary workspace conceptually — operator vouches by including the line).

## Outputs

`scripts/active-bases.mts <run-id>` writes:

- `~/.claude/airtable-extract-cache/<run-id>/active-bases.json` — full filter trace per base: `{id, name, included: bool, excluded_by: "archive"|"copy"|"test"|"inactive"|null, last_activity: ISO8601|null}`
- stdout: just the active base IDs as JSON array, suitable for shell substitution.

## Activity cutoff configuration

The "since beginning of this year" cutoff is computed at run time as `<current-year>-01-01T00:00:00Z`. Override via env var `AIRTABLE_ACTIVITY_CUTOFF` (ISO 8601 timestamp) for backfill scenarios.

## Cross-references

- Operator clarification (private vault): see operator's session log dated 2026-05-02 — "focus only base on primary business workspace, skip all other [...] the key judgement is if base is no activity since beginning of this year".
- Implementation issue (planned): tracked in operator's task tracker.
