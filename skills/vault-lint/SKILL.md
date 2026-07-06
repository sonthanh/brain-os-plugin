---
name: vault-lint
description: >
  Nightly vault maintenance — fix broken wiki-links, detect orphan pages,
  sync directory indexes, flag stale GH-issue tasks. Use cho: vault
  maintenance, broken links, orphan pages, nightly cron, lint vault.
---

# /vault-lint — Nightly Vault Maintenance

Pipeline skill. Runs nightly (2am CEST, sonnet) via `/brain-os:schedule`. Auto from day 1 per `working-rules.md § 2` — no review phase for cron/maintenance skills.

## Config
**Vault path + GitHub task repo:** read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md` (or user-local `~/.brain-os/brain-os.config.md`). Keys: `vault_path:`, `gh_task_repo:`. Substitute `$GH_TASK_REPO` below with the configured value.

## Vault paths

- Vault root: read from config (above)
- Reports: `{vault}/daily/organize-reports/YYYY-MM-DD.md`
- Outcome log: `{vault}/daily/skill-outcomes/vault-lint.log`
- Conventions: `{vault}/thinking/references/bidirectional-linking.md`, `{vault}/thinking/references/compiled-truth-template.md`

## Flags

| Flag | Effect |
|------|--------|
| `--dry-run` | Skip ALL mutations (no git tag, no file writes, no archiving). Produce report of what *would* change only. |
| (no flags) | Full run — tag, lint, fix, report. |

---

## Step 0 — Safety snapshot [deterministic]

Skip entirely if `--dry-run`.

```bash
cd {vault}
git tag pre-vault-lint-$(date +%Y-%m-%d) HEAD
```

If the tag already exists (re-run same day), append `-N` suffix: `pre-vault-lint-2026-04-13-2`.

---

## Phase A — Vault graph [deterministic]

### A1. Broken wiki-links

**Scan exclusions** — apply before link resolution. These four categories are structural noise, not graph damage; past runs re-classified them by hand every night:

- **Source files under `daily/organize-reports/` and `daily/skill-outcomes/`** — lint reports and outcome logs quote broken links verbatim, so scanning them is self-referential: each run re-finds its own prior findings (the recurring 7k+ raw-broken explosions).
- **Source files under `business/intelligence/emails/`** — auto-generated dated artifacts whose links point at rotated/compacted gmail-triage files; broken by design. Same rationale as the A2 orphan exclusion, applied here to files as link sources.
- **`[[https://...]]` URL pseudo-links** — URLs inside wiki-link syntax are not file references and can never resolve.
- **Links inside fenced code blocks** — code fences quote link syntax as examples/data, not graph edges. Strip fenced blocks before scanning.

Report excluded-category counts as a single footnote line in `## Broken Links` (`Excluded: N self-referential + N email-artifact + N URL + N code-fence`), not as findings.

Scan all remaining `.md` files in the vault for `[[...]]` wiki-links. For each link:
1. **Exclude `[[@...]]` Obsidian @-mention links** — links whose target starts with `@` are person-mention syntax, not file references; skip them.
2. Resolve the target path (Obsidian rules: shortest match, case-insensitive filename, `.md` extension optional)
3. Check if the target file exists
4. Collect broken links as: `{source_file}:{line} → [[{target}]]`

Do NOT auto-fix broken links. List them in the report under `## Broken Links`.

### A2. Orphan pages

Find `.md` files that are NOT referenced by any wiki-link from another file. Exclude:
- `README.md` files (index pages)
- `CLAUDE.md`, `RESOLVER.md`, `MEMORY.md` (system files)
- Files in `daily/` (dated artifacts, expected to be unlinked)
- Files in `business/intelligence/emails/` (auto-generated dated intelligence artifacts, same exclusion rationale as `daily/`)
- Files in `Clippings/` (Obsidian web clipper artifacts, standalone by design)
- Files in `people/`, `companies/`, `meetings/` (auto-generated email entity records — database-style, orphaned by design; bidirectional link gaps for entity pages are handled by Phase A3, not orphan detection)
- Files in `private/` (gitignored zone)
- Files in `thinking/aha/`, `thinking/originals/` (standalone artifacts)
- Root-level files (`working-rules.md`, `skill-spec.md`, etc.)

List orphans in the report under `## Orphan Pages`.

### A3. Bidirectional linking enforcement

Per `{vault}/thinking/references/bidirectional-linking.md`:

Scope: entity pages only — `people/`, `companies/`, `meetings/`, `business/decisions/`, `business/projects/`.

For each wiki-link from entity page A → entity page B, check that B also links back to A. Collect one-way links as: `{A} → [[{B}]] (no back-link)`.

List violations in the report under `## One-Way Entity Links`.

### A4. Directory index sync [deterministic]

Run `{vault}/scripts/update-readmes.sh` to regenerate directory README files. If the script produces any git diff, note which directories were out of sync in the report.

---

## Phase A2 — CLAUDE.md drift detection [deterministic]

Detect SSOT violations across all `CLAUDE.md` files in the ecosystem:

1. Collect all CLAUDE.md files:
   - `{vault}/CLAUDE.md`
   - `~/.claude/CLAUDE.md`
   - Any CLAUDE.md in repos under `~/work/`
2. Extract H2 section headings (`## ...`) from each file
3. Flag when the same H2 heading text appears in 2+ files — potential duplication
4. For flagged sections, compare content similarity (first 3 non-empty lines). If >80% overlap → SSOT violation

List violations in the report under `## CLAUDE.md Drift`. Include which file should be the SSOT owner (the one listed in `~/.claude/CLAUDE.md` as canonical).

---

## Phase B — Stale GH issue detection [deterministic]

Tasks live as GitHub issues at `$GH_TASK_REPO`. This phase flags open issues that have not been touched in >90 days — the `/status` panel hides them silently, so they accumulate as silent backlog rot.

### B1. Query open issues

```bash
gh issue list -R $GH_TASK_REPO --state open --limit 100 \
  --json number,title,updatedAt,labels,url
```

If `$GH_TASK_REPO` is unset, skip Phase B entirely and note in the report: `Phase B skipped — gh_task_repo not configured.`

### B2. Stale flag (>90 days)

For each issue where `updatedAt` is older than 90 days:
1. List in the report under `## Stale Issues` as `#N — [title] (updated YYYY-MM-DD, Nd ago) — url`.
2. If not `--dry-run`, post a comment:
   ```bash
   gh issue comment N -R $GH_TASK_REPO --body "vault-lint: no activity for Nd. Review and either close, re-label \`status:backlog\`, or update the body to keep it alive."
   ```
3. Do NOT auto-close — human judgment required.

Skip issues that already received a `vault-lint:` comment in the last 30 days (idempotency — query comments via `gh issue view N --json comments`).

---

## Phase C — Dead entity flagging [deterministic + latent for uncertain items]

Scan vault for references to external entities that may no longer exist:

### C1. Archived repo paths [deterministic]
Grep vault `.md` files for absolute paths matching `~/work/...` or `/Users/.../work/...`. For each unique path, check if the directory exists. Flag missing paths.

### C2. Stale handovers [deterministic]
Scan `{vault}/daily/handovers/` for files older than 30 days. For each, query `gh issue list -R $GH_TASK_REPO --state open --search "<handover-filename>"` — flag as potentially stale if any open issue still references it.

### C3. Empty grill sessions [deterministic]
Scan `{vault}/daily/grill-sessions/` for files with no section heading matching `## Decision` as a prefix (case-insensitive — matches `## Decisions`, `## Decisions Made`, `## Decisions (locked)`, `## Decision Summary`, `## Settled Decisions`, etc.) or `# Decision` as an H1 prefix (case-insensitive — matches `# Decisions`, `# Decision Summary`, etc.) or where the matching section is empty. Flag as incomplete.

Exclude files whose filename contains `autogrill` — these are auto-generated planning/design sessions where a formal `## Decisions` section is not required by design.

Exclude files with `status: shipped` frontmatter — shipped grill sessions are completed artifacts; their decisions are locked, not missing.

### C4. Needs review triage [latent]
Items where automated detection is uncertain go into `## Needs Review` in the report. Do not auto-fix these — human judgment required.

---

## Phase D — Report + outcome log

### D1. Write report [deterministic]

Write to `{vault}/daily/organize-reports/YYYY-MM-DD.md`:

```markdown
---
date: YYYY-MM-DD
skill: vault-lint
mode: {full | dry-run}
---

# Vault Lint Report — YYYY-MM-DD

## Summary
- Broken links: N
- Orphan pages: N
- One-way entity links: N
- Index out of sync: N directories
- CLAUDE.md drift: N violations
- Stale issues flagged: N
- Dead entities flagged: N
- Items needing review: N

## Broken Links
{list or "None found."}

## Orphan Pages
{list or "None found."}

## One-Way Entity Links
{list or "None found."}

## Index Sync
{list of out-of-sync directories or "All indexes up to date."}

## CLAUDE.md Drift
{list or "No drift detected."}

## Stale Issues
{list or "None."}

## Dead Entities
{list or "None."}

## Needs Review
{list or "Nothing uncertain."}
```

If `--dry-run`, prefix the title: `# Vault Lint Report — YYYY-MM-DD (DRY RUN)` and note that no changes were made.

### D2. Outcome log [deterministic]

Follow `{vault}/skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/vault-lint.log`:

```
{date} | vault-lint | lint | ~/work/brain-os-plugin | daily/organize-reports/{date}.md | commit:{hash} | {result}
```

**The `{result}` field is the bare result token — `pass`, `partial`, or `fail` — and nothing else.** Run detail (phase counts, skips, supersession notes) goes in an optional trailing `note="..."` field, ≤200 chars, per skill-spec § 11 optional key=value fields. The full narrative belongs in the report file, never in the log row — prose inside the result field breaks every field-7 parser (the /improve scanner buckets each unique annotation as a distinct result value).

```
2026-07-06 | vault-lint | lint | ~/work/brain-os-plugin | daily/organize-reports/2026-07-06.md | commit:abc1234 | pass | note="local full run; A1 89 actionable; supersedes same-day cloud run"
```

Result logic:
- `pass` — all runnable phases completed cleanly, OR all skips were context-constrained (Phase A4: `update-readmes.sh` absent; Phase B: `gh` unauthenticated or `gh_task_repo` unset). Context-constrained skips are expected in MCP-mode execution — the report is fully correct for the phases that ran. "Needs Review" items are informational output (they're what the skill is supposed to surface for a living vault), not a failure signal.
- `partial` — a phase encountered an unexpected error and recovered gracefully (not a context-constrained skip — those log `pass`).
- `fail` — a phase errored and the skill aborted before writing its report.

### D3. Auto-improve on failure [deterministic]

If `result == fail`, auto-invoke `/brain-os:improve vault-lint`. Phase errors are the real skill-improvement signal. Context-constrained skips (A4/Phase B unavailable) now log `pass` — they carry no actionable improvement signal. An unexpected recovered error (`partial`) is also low-signal by itself; only a hard abort (`fail`) reliably indicates a SKILL.md gap worth fixing. The eval gate inside `/improve` still prevents regressions if invoked.

> **Intentional divergence from `skill-spec.md § 11` auto-improve convention.** The cross-skill default is `if result != pass`. vault-lint tightens to `== fail` because context-constrained skips (Phase A4: no `update-readmes.sh`; Phase B: no `gh` auth / `gh_task_repo` unset) now log `pass`, and unexpected recovered errors (`partial`) are still not reliable improvement signals. If you're reviewing this and considering a "fix back to the convention," read `daily/improve-reports/2026-04-23-vault-lint.md` first — the tightening was the explicit fix for 100% partial rate + wasted auto-improve cycles across 4 consecutive nightly runs. The eval `auto-improve-on-fail-only` will fail if the tightening is reverted.

### D4. Commit and push [deterministic]

Skip if `--dry-run`.

```bash
cd {vault}
git add daily/organize-reports/ daily/skill-outcomes/
git commit -m "vault-lint: nightly run {date}"
git pull --rebase && git push
```

---

## Gotchas

- Wiki-link resolution follows Obsidian's shortest-unique-path rule, not filesystem paths. `[[foo]]` matches `any/nested/foo.md` if there's only one `foo.md`.
- Never delete files. This skill flags or compresses — but never `rm`. The git tag enables rollback if anything goes wrong.
- Entity pages are scoped: `people/`, `companies/`, `meetings/`, `business/decisions/`, `business/projects/`. Don't enforce bidirectional links on grill notes, aha moments, or research reports.
- The `scripts/update-readmes.sh` script must exist in the vault. If missing, skip A4 and note it in the report.
- Phase B requires `gh` CLI authenticated (`gh auth status`). If unauthenticated or `gh_task_repo:` unset, the phase skips silently with a report note — it does not fail the whole run.
- If `scripts/update-readmes.sh` exists but exits non-zero (e.g., macOS `stat -f "%m %N"` syntax on Linux), revert any uncommitted changes (`git checkout -- .`) and treat A4 as a context-constrained skip — log `pass`, not `partial`.
