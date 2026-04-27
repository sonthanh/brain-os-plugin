# GH task labels — canonical reference

Single source of truth for the GitHub-issue label workflow used by every brain-os filer skill, every transition helper, and the close-step lifecycle. Replaces the tribal knowledge that previously lived scattered across 6+ SKILL.md files.

**Tracker repo:** `sonthanh/ai-brain` (single tracker for all areas — see `working-rules.md`).
**Bootstrap script:** `~/work/brain/scripts/gh-tasks/bootstrap-labels.sh` (idempotent, `--prune-dead` removes retired labels).
**Filer / transition / close helpers:** `~/work/brain-os-plugin/scripts/gh-tasks/{create-task-issue,transition-status,close-issue}.sh`.

If anything below disagrees with `bootstrap-labels.sh`, `bootstrap-labels.sh` wins — it is the schema, this doc is the consumer guide.

---

## 1. Canonical label set

Every label below exists in `bootstrap-labels.sh` (except `area:*` — see note in § 1.5). Anything not on this list is a phantom — see § 5 anti-patterns.

### 1.1 `status:*` — open lifecycle phase

Mutually exclusive. ≤1 per OPEN issue. 0 on CLOSED issues.

| Label | Color | Meaning |
|-------|-------|---------|
| `status:ready` | `0E8A16` | Pickable now. All blockers closed. Sits in the work queue. |
| `status:in-progress` | `1D76DB` | Claimed and actively being worked. Set by `transition-status.sh` or `pickup-claim.sh`, never by hand. |
| `status:blocked` | `B60205` | Waiting on another OPEN issue or external dependency. Body must name the blocker. |
| `status:backlog` | `C5DEF5` | Future work, not yet ready (under-specified, deferred, or below current priority cut). |

CLOSED issues carry NO `status:*` label — state IS the truth. `close-issue.sh` strips every `status:*` before closing; see § 4.

### 1.2 `priority:*` — urgency

Mutually exclusive. Exactly 1 per issue.

| Label | Color | Meaning |
|-------|-------|---------|
| `priority:p1` | `D93F0B` | Urgent / highest. Drop other work. |
| `priority:p2` | `FBCA04` | High. This week. |
| `priority:p3` | `FEF2C0` | Medium. Drain when queue allows. |

`priority:p4` was retired 2026-04-27 (issue #155) — reclassify to `status:backlog` instead. `/slice` and `/debug` SKILL.md still mention `p4` in label templates — see § 5 tech debt.

### 1.3 `weight:*` — effort estimate

Mutually exclusive. Exactly 1 per issue.

| Label | Color | Meaning |
|-------|-------|---------|
| `weight:quick` | `006B75` | ⚡ <30 min — anytime, including in-meeting downtime. |
| `weight:heavy` | `5319E7` | 🏋️ 1h+ work — schedule a focused block / off-hours. |

### 1.4 `owner:*` — execution gate

Mutually exclusive. Exactly 1 per issue.

| Label | Color | Meaning |
|-------|-------|---------|
| `owner:bot` | `BFDADC` | 🤖 Auto-eligible. `/impl` (in `once`/`parallel`/`auto` modes) picks this up. |
| `owner:human` | `F9D0C4` | 👤 Needs grilling, drafting, or judgment that an autonomous worker can't supply. Routed through `/pickup`. |

Mid-flow artifacts (handover docs, unsettled grills, half-written essays) are ALWAYS `owner:human`. See `/impl` SKILL.md § Mid-flow rule and `/pickup` SKILL.md § Owner label hygiene.

### 1.5 `area:*` — code repo

Mutually exclusive. Exactly 1 per issue.

| Label | Color | Repo |
|-------|-------|------|
| `area:plugin-brain-os` | `C5DEF5` | `~/work/brain-os-plugin/` |
| `area:plugin-ai-leaders-vietnam` | `8B4513` | `~/work/ai-leaders-vietnam/` |
| `area:vault` | `FEF2C0` | `~/work/brain/` |
| `area:claude-config` | `BFE5BF` | `~/.claude*/` (CLAUDE.md, hooks, settings, memory) |

`area:*` labels are NOT created by `bootstrap-labels.sh` today — they were added ad-hoc as repos came online and live in GitHub without a schema source. The canon list of values lives in `create-task-issue.sh` (`VALID_AREA`); validation happens at filer time, not at bootstrap time. Tech debt: fold the `area:*` set into `bootstrap-labels.sh` so a fresh tracker boots with them.

Adding a new repo today means: add the value to `VALID_AREA` in `create-task-issue.sh`, then `gh label create area:<new>` manually on the tracker. Once the tech debt above lands, step 2 collapses into a `bootstrap-labels.sh` run.

`area:*` replaces the retired `kind:bug` pattern — issue type is implicit in the area + body, not a separate axis.

### 1.6 `type:*` — orthogonal classifier

NOT mutually exclusive (a plan-with-handover-doc could in principle carry both, though in practice each issue has at most one).

| Label | Color | Meaning |
|-------|-------|---------|
| `type:plan` | `8A2BE2` | Has a linked PRD / plan doc. Used by `/slice` parent-story issues. |
| `type:handover` | `FF6B6B` | 📋 Has a linked handover doc. Used by `/handover`. |

---

## 2. Filer matrix

Required label set when each skill **files** (creates) or **picks up** (claims) an issue. Filer skills SHOULD invoke `scripts/gh-tasks/create-task-issue.sh` so label assembly is centralized; today most skills still inline `gh issue create` — see § 5.

### Issue creators

| Skill | `area` | `status` | `owner` | `priority` | `weight` | `type` | Notes |
|-------|--------|----------|---------|------------|----------|--------|-------|
| `/slice` (parent) | required | `in-progress` | `human` | (inherited from grill) | (inherited) | `type:plan` | Parent stays `in-progress` until last child closes; awaits PRD approval before children spawn. |
| `/slice` (child) | required | `ready` (or `blocked` if has open `Blocked by`) | `bot` (default) or `human` per slice depth | required | required | (none, unless child also carries a handover) | Carries `## Parent` + `## Blocked by` body sections — DAG drainer reads these. Trunk-paths matcher forces `owner:human` if any declared `Files:` path matches `references/trunk-paths.txt`. |
| `/handover` | required | `ready` | `human` (default; override with `--owner bot` only for AFK-resumable continuations) | required | required | `type:handover` | Body links the handover doc via `[handover](<vault-relative-path>)`. |
| `/study` (review task) | required | `ready` | `human` | `priority:p3` | `weight:quick` | (none) | Filed by `/study` to schedule a review pass on absorbed knowledge. |
| `/debug` | required | `ready` | `bot` (default; `human` if reproduction needs interactive judgment) | required | required | (none — `kind:bug` is retired; `area` carries the repo, body carries the symptom) | RED-GREEN fix plan goes in body. |

### Issue consumers (pick / claim)

| Skill | Picks where | Claims with |
|-------|-------------|-------------|
| `/impl` (`once` / `parallel` / `auto`) | `area:<configured>` AND `status:ready` AND `owner:bot` | `transition-status.sh <N> --to in-progress` |
| `/impl <N>` (`issue` mode) | Specific `<N>` regardless of owner — explicit override | `transition-status.sh <N> --to in-progress` |
| `/pickup` (no args, HITL) | `status:ready` AND `owner:human` | `pickup-claim.sh <N>` (atomic flip, see § 3 note) |
| `/pickup <N>` (direct claim) | Caller-supplied `<N>`, any owner | `pickup-claim.sh <N>` |

A skill that violates its row above is a drift event — file it for `/improve`.

---

## 3. Transition rules

Status changes go through one of two helpers, both atomic from GitHub's side. Manual `--remove-label status:* --add-label status:*` is forbidden — it races with concurrent observers (a sub-millisecond window where the issue has both labels or neither).

```
transition-status.sh <issue-N> --to <ready|in-progress|blocked|backlog> [--dry-run]
```

| From | To | Trigger | Caller |
|------|-----|---------|--------|
| `ready` | `in-progress` | Skill claims an issue to start work | `/impl` (`transition-status.sh`), `/pickup` (`pickup-claim.sh`) |
| `in-progress` | `ready` | Skill defers work — HITL needed mid-flight, trunk-block fired, or test loop aborted | `/impl` (deferral path), manual on user interrupt |
| `backlog` | `ready` | `/pickup` promotes a backlog item during grooming | `/pickup` |
| any | `backlog` | `/pickup` defers an item the operator decides isn't ready | `/pickup` |
| any | `blocked` | A new dependency is discovered (skill or human) | manual or skill-driven |
| `blocked` | `ready` | Blocker closes; the unblocked issue is now pickable | manual today; future automation could run on `gh issue close` events |

`transition-status.sh` is idempotent — `--to in-progress` on an issue already `in-progress` is a 0-exit no-op. Closed issues error cleanly (`STATE != OPEN` → exit 1) instead of silently leaving stale labels.

**Note on `pickup-claim.sh`:** `/pickup` claims (`ready` → `in-progress`) currently call `pickup-claim.sh`, which inlines the same single-call atomic edit pattern rather than shelling out to `transition-status.sh`. The two helpers are equivalent on the wire (one `gh issue edit --remove-label … --add-label …` call); `pickup-claim.sh` adds richer exit-code semantics (`0` flipped, `3` no-op already in-progress, `1` not claimable, `2` gh error) tuned for the claim flow. Tech debt: collapse the duplication by having `pickup-claim.sh` source `transition-status.sh` for the actual flip (tracked under #153).

---

## 4. Close-step lifecycle

Closing an issue strips every `status:*` label first, then closes with `--reason completed`. The single supported entrypoint:

```
close-issue.sh <issue-N> [--comment <C>] [--dry-run]
```

What it does:

1. Fetches the issue's labels via `gh issue view`.
2. Collects every `status:*` label (defensive — drift may have left more than one).
3. Single `gh issue edit` call removes all of them.
4. Optional `gh issue comment` if `--comment` was passed.
5. `gh issue close --reason completed`.

Closed-issue label invariant:

- ✅ `area:*`, `priority:*`, `weight:*`, `owner:*`, `type:*` — RETAINED. They are historical metadata; `/status` and analytics aggregate on them post-close.
- ❌ `status:*` — STRIPPED. State (CLOSED) is the truth. Stale `status:in-progress` on closed issues was leaking into queue counts (#155 cleanup audit found 3 closed issues still carrying `status:in-progress`).

Manual `gh issue close <N>` calls are deprecated. Replace with `bash "$CLAUDE_PLUGIN_ROOT/scripts/gh-tasks/close-issue.sh" <N>` everywhere a skill closes an issue. Direct `gh issue close` leaves `status:*` labels behind, which is the bug `close-issue.sh` exists to prevent.

---

## 5. Anti-patterns

Things that look fine in isolation but break the system. Each one has a real failure mode behind it.

### Phantom labels

Hand-typing a label that doesn't exist in `bootstrap-labels.sh`. Examples seen in the wild before the #155 cleanup:

- `kind:bug` — retired; `area:*` carries the repo, body carries the symptom.
- `priority:p4` — retired 2026-04-27; reclassify to `status:backlog`.
- GitHub defaults (`bug`, `enhancement`, `documentation`, `wontfix`, etc.) — pruned by `bootstrap-labels.sh --prune-dead`.

GitHub silently creates labels on first use, so a typo (`status:in_progress` vs `status:in-progress`) becomes a permanent ghost until pruned. Always validate against canon BEFORE filing — `create-task-issue.sh` does this; ad-hoc `gh issue create` does not.

### Inline `gh issue create`

Skills that call `gh issue create -R sonthanh/ai-brain --label "..."` directly bypass label validation and tend to drift over time (a label gets added in one skill, missed in another). Replace with `create-task-issue.sh --area ... --owner ... --priority ... --weight ... --status ... [--type ...]`. The script validates every axis against canon and fails loudly on a typo.

Skills still inlining `gh issue create` (as of 2026-04-27, tracked under #153):

- `/slice` parent + child paths in `skills/slice/SKILL.md` — also still references retired `priority:p4` in label template (line 130, 211).
- `/handover` (`skills/handover/scripts/create-handover-issue.sh`) — also missing `--label area:*` (the script doesn't accept `--area` at all).
- `/study` (`skills/study/SKILL.md` line 65) — also missing `area:*` and `priority:*` axes; only sets `status`, `owner`, `weight`.
- `/debug` (`skills/debug/SKILL.md` line 103-112) — also references retired `priority:p4` in label template.

### Manual `--remove-label status:* --add-label status:*`

Two-call status change races with observers. A reader hitting the issue between the remove and the add sees a status-less OPEN issue. `transition-status.sh` (and `pickup-claim.sh`) does it in a single `gh issue edit` call — atomic from GitHub's side. No exceptions; if you need a status change in a one-off script, source `transition-status.sh`, don't reinvent it.

### Closing without strip

`gh issue close <N>` alone leaves `status:in-progress` on the closed issue. Aggregations like `/status` and pre-cleanup queue-depth heuristics counted those as live work — phantom WIP. Always use `close-issue.sh <N>`. The wrapper exists specifically because manual closes were leaking ghost labels.

### Adding a new label without bootstrap

If a skill needs a new label value (e.g. a new `area:*` for a new repo), the order is:

1. Add the value to `VALID_<axis>` in `create-task-issue.sh` (and `transition-status.sh` if it's a status).
2. Add the `create_label` call to `bootstrap-labels.sh` with color + description.
3. Run `bash bootstrap-labels.sh` (idempotent — safe).
4. Update this doc's § 1 table.
5. Only then start using the label in skills.

Skipping step 1 means the script will reject the label as invalid. Skipping step 2 means it'll exist in the canon list but won't actually be created on a fresh tracker.

---

## 6. Cross-references

### Helpers (centralize plumbing)

- `~/work/brain-os-plugin/scripts/gh-tasks/create-task-issue.sh` — central filer. Validates every axis against canon. Returns issue URL on stdout.
- `~/work/brain-os-plugin/scripts/gh-tasks/transition-status.sh` — atomic status flip. Single `gh issue edit` call. Idempotent.
- `~/work/brain-os-plugin/scripts/gh-tasks/close-issue.sh` — strips `status:*` then closes. Optional `--comment`.
- `~/work/brain-os-plugin/scripts/pickup-claim.sh` — atomic claim flip used by `/pickup` (richer exit codes than `transition-status.sh`; collapse-into-helper tracked as tech debt under #153).
- `~/work/brain/scripts/gh-tasks/bootstrap-labels.sh` — idempotent label create/update. `--prune-dead` removes retired labels (2026-04-27 cleanup).

### Tests

- `~/work/brain-os-plugin/scripts/gh-tasks/evals/{create-task-issue,transition-status,close-issue}.test.ts` — unit tests for the three helpers (Bun runtime).
- `~/work/brain/scripts/gh-tasks/bootstrap-labels.test.sh` — bootstrap script smoke test.

### Settled grills + cleanup history

- `~/work/brain/thinking/aha/2026-04-26-gh-issue-close-status-label-drift.md` — root-cause aha that motivated the close-step lifecycle (#155, #157, #158).
- `~/work/brain/daily/grill-sessions/2026-04-26-depth-leaf-trunk-design.md` — leaf-vs-trunk grill that produced `references/trunk-paths.txt` and the trunk-block hook (`/impl` AFK gate).
- ai-brain#155 — label cleanup issue (prune defaults, retire `priority:p4`, drop `kind:bug`).
- ai-brain#157 — filer + transitioner + closer helpers.
- ai-brain#153 — parent story for the full taxonomy refactor.

### Skill-side consumers

Each filer/picker skill MUST call the appropriate helper above. Skills that don't yet (tech debt as of 2026-04-27, all tracked under #153): `/slice` parent + child filing, `/handover` issue creation, `/study` review-task filing, `/debug` filing.
