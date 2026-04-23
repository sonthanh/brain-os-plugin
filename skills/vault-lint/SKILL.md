---
name: vault-lint
description: >
  Nightly vault maintenance — fix broken wiki-links, detect orphan pages,
  enforce bidirectional linking, sync directory indexes, detect CLAUDE.md
  drift/SSOT violations, flag stale GH-issue tasks, flag dead entities.
  Use when: vault maintenance, broken links, orphan pages, nightly cron,
  wiki-links, vault health, lint vault, stale tasks.
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

Scan all `.md` files in the vault for `[[...]]` wiki-links. For each link:
1. Resolve the target path (Obsidian rules: shortest match, case-insensitive filename, `.md` extension optional)
2. Check if the target file exists
3. Collect broken links as: `{source_file}:{line} → [[{target}]]`

Do NOT auto-fix broken links. List them in the report under `## Broken Links`.

### A2. Orphan pages

Find `.md` files that are NOT referenced by any wiki-link from another file. Exclude:
- `README.md` files (index pages)
- `CLAUDE.md`, `RESOLVER.md`, `MEMORY.md` (system files)
- Files in `daily/` (dated artifacts, expected to be unlinked)
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
Scan `{vault}/daily/grill-sessions/` for files with no `## Decisions` section or where that section is empty. Flag as incomplete.

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

Result logic:
- `pass` — all phases completed cleanly. "Needs Review" items are informational output (they're what the skill is supposed to surface for a living vault), not a failure signal.
- `partial` — a phase was skipped by design (missing `gh` auth, missing `update-readmes.sh`, `gh_task_repo` unset) or recovered gracefully from an unexpected error inside a phase.
- `fail` — a phase errored and the skill aborted before writing its report.

### D3. Auto-improve on failure [deterministic]

If `result == fail`, auto-invoke `/brain-os:improve vault-lint`. Phase errors (not "Needs Review has items") are the real skill-improvement signal. `partial` means a phase was skipped by design — that's expected operational state, not a defect. The eval gate inside `/improve` still prevents regressions if invoked.

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
