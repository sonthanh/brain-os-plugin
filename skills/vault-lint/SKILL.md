---
name: vault-lint
description: >
  Nightly vault maintenance — fix broken wiki-links, detect orphan pages,
  enforce bidirectional linking, sync directory indexes, detect CLAUDE.md
  drift/SSOT violations, dedupe tasks, archive stale entries, flag dead
  entities. Use when: vault maintenance, broken links, orphan pages, task
  cleanup, nightly cron, wiki-links, dedupe, stale tasks, vault health,
  inbox cleanup, lint vault.
---

# /vault-lint — Nightly Vault Maintenance

Pipeline skill. Runs nightly (2am CEST, sonnet) via `/brain-os:schedule`. Auto from day 1 per `working-rules.md § 2` — no review phase for cron/maintenance skills.

## Vault paths

- Vault root: read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`
- Reports: `{vault}/daily/organize-reports/YYYY-MM-DD.md`
- Outcome log: `{vault}/daily/skill-outcomes/vault-lint.log`
- Task inbox: `{vault}/business/tasks/inbox.md`
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

## Phase B — Task inbox [deterministic]

Read `{vault}/business/tasks/inbox.md`. Preserve kanban format (frontmatter + `%% kanban:settings %%` block).

### B1. Dedupe

Compare all task titles (text between `**...**`) across all sections. Match: case-insensitive, whitespace-normalized, strip emoji prefixes.

If exact title match found → keep the one in the higher-priority section (Ready > In Progress > Backlog > Done). Remove the duplicate. Add to report under `## Duplicates Removed`.

### B2. Superseded umbrellas

A task is a superseded umbrella when:
- It references a handover (`[[daily/handovers/...]]` or `[[handovers/...]]`)
- AND ≥3 other tasks in inbox.md reference the same handover link

The umbrella has been granularized — move it to Done with `✅ {today}` and note `(superseded — granularized into N tasks)`.

### B3. Stale entry flagging

| Condition | Action |
|-----------|--------|
| Task in Ready >14 days with no move | Flag in report (do not move) |
| Task in Backlog >30 days | Flag in report (do not move) |
| Task in Done >90 days | Compress: collapse description to title-only line |

Age is measured from the date in the task text (ISO date, `✅ YYYY-MM-DD`, or `[[daily/...YYYY-MM-DD...]]`). If no date found, use git blame for the line's last-modified date.

### B4. Apply changes

If `--dry-run`: skip. Otherwise write the cleaned inbox.md, preserving kanban format exactly.

---

## Phase C — Dead entity flagging [deterministic + latent for uncertain items]

Scan vault for references to external entities that may no longer exist:

### C1. Archived repo paths [deterministic]
Grep vault `.md` files for absolute paths matching `~/work/...` or `/Users/.../work/...`. For each unique path, check if the directory exists. Flag missing paths.

### C2. Stale handovers [deterministic]
Scan `{vault}/daily/handovers/` for files older than 30 days that are still referenced by unchecked tasks in inbox.md. Flag as potentially stale.

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
- Task duplicates removed: N
- Superseded umbrellas archived: N
- Stale tasks flagged: N
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

## Duplicates Removed
{list or "No duplicates."}

## Superseded Umbrellas
{list or "None."}

## Stale Tasks
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
- `pass` — zero items in Needs Review, all phases completed
- `partial` — items in Needs Review but all phases completed
- `fail` — a phase errored or was skipped

### D3. Auto-improve on failure [deterministic]

If `result != pass`, auto-invoke `/brain-os:improve vault-lint`. No user confirmation needed — eval gate inside `/improve` prevents regressions.

### D4. Commit and push [deterministic]

Skip if `--dry-run`.

```bash
cd {vault}
git add daily/organize-reports/ daily/skill-outcomes/ business/tasks/inbox.md
git commit -m "vault-lint: nightly run {date}"
git pull --rebase && git push
```

---

## Gotchas

- Kanban format in inbox.md is fragile — the `kanban-plugin: board` frontmatter and `%% kanban:settings %%` block must be preserved exactly. Test by checking the file still opens as a kanban board in Obsidian.
- Wiki-link resolution follows Obsidian's shortest-unique-path rule, not filesystem paths. `[[foo]]` matches `any/nested/foo.md` if there's only one `foo.md`.
- Never delete files. This skill flags, archives to Done, or compresses — but never `rm`. The git tag enables rollback if anything goes wrong.
- Entity pages are scoped: `people/`, `companies/`, `meetings/`, `business/decisions/`, `business/projects/`. Don't enforce bidirectional links on grill notes, aha moments, or research reports.
- The `scripts/update-readmes.sh` script must exist in the vault. If missing, skip A4 and note it in the report.
