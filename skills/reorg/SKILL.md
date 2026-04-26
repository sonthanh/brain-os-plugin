---
name: reorg
description: |
  System-level reorganization scan across the brain-os plugin + vault scripts + vault organization (and any additional repos the user lists in their personal scope file). Detects shallow modules, cross-skill duplication, unused code, conflicting patterns, and vault organizational drift. Runs weekly via cron (Sunday 02:00 ICT) — produces a report with proposed refactor issues. Use when user wants a system-level refactor scan, architecture review, codebase audit, or says 'reorganize', 'refactor', 'shallow modules', 'is this codebase still in shape', 'improve architecture', 'audit our architecture', or invokes /reorg. Different from /improve (per-skill, eval-gated) and /vault-lint (mechanical hygiene) — this is structural critique across artifacts.
---

# /reorg — System-Level Refactor Scan

Adapted from [Matt Pocock's `/improve-codebase-architecture`](https://github.com/mattpocock/skills) — Pocock principle: "**codebase quality is the ceiling for AI quality**." Per-skill `/improve` patches individual SKILL.md files; this is the missing system-level layer that proposes "merge skills X+Y", "split skill Z", "deepen this scattered helper", "delete this dead pattern".

## What this is NOT

| Skill | Scope | Output | Cadence |
|-------|-------|--------|---------|
| `/improve` | Single skill — eval-gated SKILL.md edits via in-memory variants | Auto-applied edit + report | Per-run + weekly cron + manual |
| `/vault-lint` | Vault content hygiene — broken wiki-links, orphans, READMEs, stale GH issues | Mechanical fixes + report | Daily 03:00 |
| `/reorg` | Cross-artifact STRUCTURE — shallow modules, duplication, dead code, conflicting patterns, vault organization drift | Report-only + proposed issues | Weekly Sunday 02:00 |

If the finding can be auto-fixed by `/improve` (single-skill SKILL.md edit) or `/vault-lint` (broken link, orphan), it belongs in those skills — not here. `/reorg` proposes work that requires human judgment AND spans multiple files/skills.

## Config

**Vault path + GitHub task repo:** read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md` (or user-local `~/.brain-os/brain-os.config.md`). Keys: `vault_path:`, `gh_task_repo:`. Substitute `$GH_TASK_REPO` below with the configured value.

**Optional personal scope additions:** read line-delimited paths from `~/.brain-os/reorg.scope` if it exists. Each line is one absolute directory the user wants merged into the scan scope (e.g., a private team plugin). One path per line, `#` for comments, blank lines ignored. The file is user-local — never committed to the public plugin repo.

## Vault paths

- Reports: `{vault}/daily/reorg-reports/YYYY-MM-DD.md`
- Outcome log: `{vault}/daily/skill-outcomes/reorg.log`
- Checkpoint state: `{vault}/daily/reorg-reports/.checkpoint-YYYY-MM-DD.json`

## Modes

| Mode | Trigger | Behavior |
|------|---------|----------|
| `interactive` (default) | User invokes `/reorg` manually | Run scan → write report → log outcome → if findings present, **chain to `/to-issues`** with the report as input. |
| `--cron` | Invoked from `reorg-cron.sh` (Sunday 02:00 ICT) — passes `/reorg --cron` | Run scan → write report → log outcome → push. **Skip `/to-issues` chain** (no user present to quiz). |
| `--dry-run` | `/reorg --dry-run` | Run all detectors, print summary to stdout. Skip report write, skip outcome log, skip pipeline. |
| `--scope <target>` | `/reorg --scope brain-os-plugin` | Limit to one target (debug / focused review). Otherwise scan all targets per § Scan scope. Combinable with `--cron` / `--dry-run`. |

The cron-vs-interactive split exists because `/to-issues` Step 5 quizzes the user on slice granularity. Chaining at cron time would deadlock waiting for input. Cron writes the artifact; the user runs `/to-issues` against the report when they have time. `/status` surfaces unprocessed reports.

**Mode detection logic**: parse the invocation `args` string. Presence of `--cron` → cron mode. Presence of `--dry-run` → dry-run mode. `--scope <target>` extracts the target. Otherwise → interactive mode (default). The cron orchestrator (`reorg-cron.sh`) always passes `--cron`; never assume cron context from environment.

## Scan scope

System-level means **everything that affects the user's daily work**. The scope is the union of:

1. **Default targets** (always scanned):
   - `~/work/brain-os-plugin/` — `skills/`, `hooks/`, `scripts/`
   - `{vault}/scripts/` — vault tooling (invoked from skills + hooks)
   - `{vault}/` — vault organization (top-level zones, RESOLVER.md, README sync, depth)
2. **Personal additions** — paths listed in `~/.brain-os/reorg.scope` (one absolute path per line). Use this to add private plugins, secondary tooling repos, or personal scripts dirs.

Marketplaces (`brain-os-marketplace` and similar) are excluded — they're metadata containers, not code. Re-include via the personal scope file if a marketplace ever grows logic.

### Vault organization sub-scope

For the vault target, scan only **structural** properties:
- Top-level zones (business/, personal/, thinking/, knowledge/, daily/, …)
- `RESOLVER.md` coverage vs actual directories
- Directory README presence + sync
- Top-level `CLAUDE.md` SSOT pointers vs actual zone organization
- Zone depth + cross-zone references

Vault content (broken links, orphans, stale tasks) is `/vault-lint`'s job — `/reorg` only critiques **structural** decisions: "should `business/intelligence/` be split?", "is `daily/` accumulating types that need their own zone?", "does the RESOLVER still match where things actually live?"

## Detectors

Five categories — each runs a deterministic heuristic pass first, then opus judges the top candidates.

### D1 — Shallow modules

**Pocock signal**: small files with many tiny exports → high coupling, hard to test, agent context pollution. The opposite of a deep module (one entry point, lots of behavior hidden).

**Heuristic** (per file, in code targets only):
- File size < 200 lines (excluding blanks/comments) AND
- Number of top-level exports/functions > 5 AND
- Average function body < 10 lines AND
- Inbound imports/refs from > 3 sibling files

A file that meets all four is a shallow-module candidate. The signal compounds — each clause alone has too many false positives.

**Suggested fix template**: "merge into `<deep-module-target>` OR collapse to single entrypoint."

### D2 — Cross-skill duplication

**Signal**: same logic copy-pasted across skills/scripts that should share a reference or helper.

**Heuristic**:
- Tokenize each `.sh` / `.ts` / `.md` file (markdown for SKILL.md prose duplication).
- Compute Jaccard similarity over 5-line sliding windows.
- Threshold: ≥ 0.75 similarity over ≥ 30 contiguous lines between two files in different skills/scripts.
- Skip same-skill duplication (intentional repetition within one phase).

**Suggested fix template**: "extract to `references/<topic>.md` (markdown) OR `scripts/lib/<topic>.sh` (code)."

### D3 — Unused code

**Signal**: scripts/skills/helpers referenced by nothing — dead weight that drifts further from canon every month.

**Heuristic**:
- For each file in scope, grep its filename across:
  - All other files in scope (callers/imports)
  - `~/Library/LaunchAgents/*.plist` (cron entry points)
  - `~/work/brain-os-plugin/skills.sh` + `install.sh` ALL_SKILLS arrays
  - `~/work/brain-os-plugin/.claude-plugin/marketplace.json` (plugin manifest)
- Zero matches → unused candidate.
- Skip: README.md, CLAUDE.md, RESOLVER.md, MEMORY.md, frontmatter-only files, files marked `architecture-exempt: true`.

**False-positive guard**: a file referenced only by name in this SKILL.md or a grill-session note still counts as "alive" — the opus judge resolves ambiguity in Phase C.

**Suggested fix template**: "delete OR document the off-graph caller in CLAUDE.md."

### D4 — Conflicting patterns

**Signal**: same problem solved different ways across skills → cognitive load, drift, "which one is canonical?" paralysis.

**Heuristic** (per pattern dimension, count distinct approaches):
- **Shell options**: `set -euo pipefail` vs `set -uo pipefail` vs `set -e` vs none, in `*.sh` files
- **Vault-path resolution**: `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md` vs `~/.brain-os/brain-os.config.md` vs hardcoded `~/work/brain` vs `$VAULT_PATH`
- **Outcome-log append style**: direct `echo >> file` vs helper function vs Bun/TS function
- **Error reporting**: stderr + exit 1 vs Telegram + log + exit 0 vs silent fail
- **Skill frontmatter description style**: paragraph vs bullet-list-ish

For each dimension, if ≥ 2 distinct approaches with ≥ 2 files each → flag with the count breakdown.

**Suggested fix template**: "pick one canonical pattern → migrate the others. Reference target: `<file using majority pattern>`."

### D5 — Vault organization drift

**Signal**: vault structure no longer matches actual usage → RESOLVER misleads, zones overflow, new types get shoehorned into wrong directories.

**Heuristic** (vault-only):
- **Top-level fanout**: count immediate subdirs of `{vault}/`. Flag if > 12 (cognitive limit).
- **Directory depth outliers**: any path > 5 levels deep. Flag with count per leaf.
- **RESOLVER coverage gap**: zones (top-level + 2nd-level) that exist on disk but are NOT mentioned in `RESOLVER.md`.
- **README staleness**: any README.md older than its directory's most-recent `.md` file (mtime comparison) by > 14 days — directory grew without index sync.
- **Zone overflow**: any single directory containing > 200 files. Flag for split candidate.

**Suggested fix template**: "split `<zone>/` into `<zone>/<sub-A>/` + `<zone>/<sub-B>/`" OR "update RESOLVER" OR "regenerate README."

---

Each detector emits zero or more **candidate findings** — `{detector, target_path, signal_detail, heuristic_score}`. Phase B aggregates; Phase C judges; Phase D reports.

## Phase A — Collect targets [deterministic]

1. **Resolve scope** — read `--scope` arg if present; else use the static defaults in § Scan scope merged with `~/.brain-os/reorg.scope` lines if that file exists.
2. **Enumerate files per target**:
   - Code targets: `find <target> \( -name '*.sh' -o -name '*.ts' -o -name '*.py' -o -name 'SKILL.md' \) -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*'`
   - Vault target: `find {vault} -type d -not -path '*/.git/*' -not -path '*/.obsidian/*' -not -path '*/node_modules/*'`
3. **Honor `architecture-exempt: true` frontmatter** — for any `*.md` file with this frontmatter key, skip ALL detectors. Record the exemption in the report so it's auditable.
4. **Write checkpoint** — `{vault}/daily/reorg-reports/.checkpoint-{date}.json` with `{phase: "A", targets: [...], started_at: ISO}`. Phases B–E read this on resume.

## Phase B — Heuristic detection [deterministic]

For each detector D1–D5, run its heuristic across all in-scope files. Collect candidate findings into a list. Cap **per detector** at 25 candidates (sorted by heuristic score) — the opus judge in Phase C is quota-bounded; flooding with hundreds of low-signal candidates burns quota for no gain.

If a detector produces > 25 candidates: keep top 25, note in report `D{N}: {total} candidates → top 25 sent to judge`. The user sees the volume signal even when individual entries are dropped.

Write the candidate list to the checkpoint: `{phase: "B", candidates: [...]}`.

## Phase C — Opus judge [latent — opus]

For each candidate finding, spawn an Agent sub-agent with `subagent_type: general-purpose, model: opus`. Use opus, not sonnet — architectural judgments are load-bearing for the next 6+ months of work; sonnet under-weights subtle signals (intentional duplication, off-graph callers, semantic-not-syntactic conflicts). Cost is one weekly run; quality of findings >> token spend.

**Judge prompt template** (exactly this; do not reword without re-evaluating):

> You are reviewing one candidate architectural finding produced by a heuristic scan. Decide whether the finding is REAL (worth a refactor proposal) or a FALSE POSITIVE (intentional, off-graph caller, or otherwise OK as-is).
>
> Reply strictly on line 1: `KEEP` or `DROP`. Lines 2–4: a one-paragraph rationale. Then one line `EFFORT: low|medium|high`. Then one line `OBSERVABLE: <user-visible surface the refactor would produce>` (slash-command output, journal line, /status section, hook stdout, vault file). No other output.
>
> **Detector**: {detector_name}
> **Target**: {target_path}
> **Signal**: {signal_detail}
> **Heuristic score**: {score}
> **File excerpt** (first 40 lines, or relevant section):
> ```
> {file_excerpt}
> ```
> **Adjacent context** (for D2 duplication: the other file's matching window; for D5 vault: parent dir listing; otherwise empty):
> ```
> {adjacent_context}
> ```

**Output handling:**
- First line must be `KEEP` or `DROP`. Anything else → treat as DROP (conservative — false negatives are recoverable; false positives clutter the report).
- Capture: `{verdict, rationale, effort, observable}` per candidate.
- Failed Agent calls (timeout, malformed) → DROP, log `judge_error` in the report.

**Quota guard**: cap total Agent calls per run at 125 (5 detectors × 25 candidates). Hit cap → record `quota_capped: true` and stop calling judge; remaining candidates ship to report as `verdict: unjudged` so the user can review manually.

Write checkpoint: `{phase: "C", judged: [...], quota_capped: bool}`.

## Phase D — Report [deterministic]

Write to `{vault}/daily/reorg-reports/{date}.md`:

```markdown
---
date: YYYY-MM-DD
skill: reorg
mode: cron | interactive | dry-run
scope: all | <target>
quota_capped: true | false
---

# /reorg Report — YYYY-MM-DD

## Summary

- Targets scanned: N (M code repos + 1 vault)
- Files inspected: N
- Files exempted (`architecture-exempt: true`): N
- Detector candidates: D1=N, D2=N, D3=N, D4=N, D5=N (total: N)
- Judge verdicts: K kept / J dropped / U unjudged
- Estimated effort: low=N, medium=N, high=N

## Findings

### D1 — Shallow modules (K kept)

#### KEEP — `<target>/<file>` — <one-line signal>
- **Heuristic**: <metrics that triggered the detector>
- **Judge rationale**: <opus output, verbatim>
- **Effort**: <low|medium|high>
- **Observable**: <user-visible surface>
- **Suggested fix**: <template-derived action>

(Repeat per kept finding; subsections per detector.)

### D2 — Cross-skill duplication (K kept)
…

### D3 — Unused code (K kept)
…

### D4 — Conflicting patterns (K kept)
…

### D5 — Vault organization drift (K kept)
…

## Dropped findings (audit trail)

- `<target>/<file>` (D1) — DROP rationale: <one line>
…

## Unjudged (quota-capped)

- `<target>/<file>` (D{N}) — <signal>
…

## Exempted files

- `<path>` — `architecture-exempt: true`

## Proposed Issues (for /to-issues)

The following are pre-formed slice candidates ready for `/to-issues` to file as AFK GitHub issues. Each kept finding becomes one slice unless related findings can collapse into a single refactor.

| # | Title | Type | Area | Priority | Weight | Files | Observable |
|---|-------|------|------|----------|--------|-------|------------|
| 1 | <imperative title> | AFK | area:<plugin>/<vault> | p3 | quick\|heavy | <relative paths> | <surface> |

## Next steps

- Review findings above.
- Run `/to-issues daily/reorg-reports/{date}.md` to file proposed slices.
- Set `architecture-exempt: true` on any flagged file you want suppressed in future runs.
```

If no findings are kept, the report still ships with `## Findings\n\nNone — N files scanned across M targets.` plus an empty `## Proposed Issues` table. A clean report is signal that the cron ran and architecture is currently in shape.

## Phase E — Auto-pipeline [interactive only]

Skip this phase if `mode: cron` or `mode: dry-run`.

When `mode: interactive` AND the report has ≥ 1 kept finding:

1. Print to user: `Generated report at daily/reorg-reports/{date}.md with N kept findings. Chaining to /to-issues to file proposed slices…`
2. Invoke `/to-issues daily/reorg-reports/{date}.md` via the Skill tool.
3. `/to-issues` reads the report, treats the `## Proposed Issues` table as its slice breakdown, quizzes the user (Step 5 of /to-issues), and files issues to `$GH_TASK_REPO`.
4. After `/to-issues` returns, append `## Issues filed (YYYY-MM-DD)` to this report listing the issue numbers (mirrors /to-issues Step 7 behavior on grill-sessions).

If `/to-issues` skill is unavailable (plugin not installed, error), fall back to printing: "Run `/to-issues daily/reorg-reports/{date}.md` manually to file slices." Do NOT silently swallow the error.

## Phase F — Outcome log + commit [deterministic]

Append to `{vault}/daily/skill-outcomes/reorg.log` per `skill-spec.md § 11`:

```
{date} | reorg | scan | ~/work/brain-os-plugin | daily/reorg-reports/{date}.md | commit:{hash} | {result} | mode={mode} score={kept}/{candidates} effort_high={N} quota_capped={true|false}
```

Result logic:
- `pass` — scan completed, report written, all phases succeeded.
- `partial` — quota_capped=true (some candidates unjudged) OR Phase E pipeline failed but report shipped.
- `fail` — Phases A–D errored; no report written.

Optional trailing fields:
- `args="..."` — for `--scope` invocations
- `score=K/N` — kept findings / total candidates
- `effort_high=N` — count of `EFFORT: high` findings (signal for "this week's refactor budget")
- `quota_capped=true|false`
- `mode=cron|interactive|dry-run`

Then:

```bash
cd {vault}
git add daily/reorg-reports/ daily/skill-outcomes/reorg.log
git commit -m "reorg: weekly run {date}"
git pull --rebase && git push
```

## Auto-improve gate

`/reorg` does NOT auto-invoke `/improve` on `result != pass`. The skill is intentionally human-in-loop downstream — the report IS the deliverable, and `partial`/`fail` mostly indicate quota gates or transient errors. Re-running on next cron is the right recovery, not auto-rewriting this skill from one bad run.

This is an intentional divergence from the `skill-spec.md § 11 Auto-improve rule` — same shape as `/vault-lint`'s tightening (see vault-lint SKILL.md D3 note). If a real defect emerges (e.g., heuristic D2 keeps producing >50% false-positive judge drops), file an issue manually and run `/improve reorg` against the outcome log.

## Quota awareness + checkpointing

The skill writes `{vault}/daily/reorg-reports/.checkpoint-{date}.json` after every phase. If interrupted (quota gate, manual cancel, crash), the next invocation:

1. Reads the checkpoint.
2. Resumes from the last completed phase (`A` → start at B; `B` → start at C; `C` → start at D; `D` → start at E).
3. Deletes the checkpoint after Phase F succeeds.

Phase C is the expensive phase. If quota is tight, run `--dry-run` first to see candidate volume, then run for real. The cron orchestrator (`reorg-cron.sh`) gates on `weeklyUsage` per the existing pattern (vault-lint-cron.sh §weekly quota gate).

## Gotchas

- **Report-only by design.** Never auto-apply a refactor proposal. Architectural changes need user judgment + downstream /tdd cycle. The report → /to-issues → /impl pipeline is the auto-application path; this skill stops at the report.
- **Don't re-run `/vault-lint`'s job.** If a vault finding is "broken wiki-link" or "orphan page" or "README out of sync (mechanical)", that's `/vault-lint`. This skill's vault detector (D5) is structural — does the layout itself need rethinking?
- **Don't re-run `/improve`'s job.** A single skill needing a SKILL.md tweak is `/improve`'s loop. This skill's findings should always span ≥ 2 files OR propose a structural decision (split, merge, delete, deepen).
- **Opus, not sonnet.** Judge calls in Phase C MUST use `model: opus` per user feedback 2026-04-26. Sonnet has been observed to under-weight architectural nuance — false positives slip through, real issues get dropped. Cost is one weekly run; do not "optimize" by switching to sonnet.
- **Self-eat check.** `/reorg` is itself a brain-os artifact. The skill's own structure should NOT trigger D1 (shallow modules) — keep this SKILL.md as the single deep module, no scattered helper files. If the skill grows enough to need helpers, place them in `references/` (not split SKILL.md).
- **Static defaults + opt-in personal additions.** The default scope is intentionally narrow (brain-os-plugin + vault). Users add their own private plugins via `~/.brain-os/reorg.scope` — the public SKILL.md never names personal repos.

## Outcome log

Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/reorg.log`:

```
{date} | reorg | scan | ~/work/brain-os-plugin | daily/reorg-reports/{date}.md | commit:{hash} | {result}
```

- `action`: `scan` (full run), `dry-run` (no write), `resume` (resumed from checkpoint)
- `result`: per Phase F result logic above
- Optional: `args="..."`, `score=K/N`, `effort_high=N`, `quota_capped=true|false`, `mode=cron|interactive|dry-run`
