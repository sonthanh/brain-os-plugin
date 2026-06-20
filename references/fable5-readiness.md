# Fable-5 Readiness — Deferred Tuning & Audit Record

Companion to the autonomous-run contract (`{vault}/working-rules.md §5`) and the guide synthesis (`{vault}/knowledge/research/reports/2026-06-20-prompting-claude-fable-5.md`). This file records what we audited, what we deferred, and the gate that releases each deferred item. We run Opus 4.8 (`claude-opus-4-8[1m]`); items here are Fable-5-specific tuning whose benefit is **unverifiable on Opus 4.8**, so they are documented, not applied.

## A. Reasoning-extraction audit — PASS (2026-06-20)

Fable 5 can return `stop_reason: "refusal"` (category `reasoning_extraction`) when a prompt tells the model to **echo, transcribe, or explain its internal reasoning as response text**, causing elevated fallbacks to Opus 4.8.

**Audit:** greps across all 29 skills, `agents/`, `references/`, the global `~/.claude/CLAUDE.md`, vault `CLAUDE.md`, and `working-rules.md`. **Zero** matching instructions. Only false positives ("show me what they actually said" = transcript, not reasoning).

**Standing rule for new skills:** never instruct the model to "show your reasoning / think out loud in the response / transcribe your thinking." If reasoning visibility is needed, read the structured `thinking` blocks from adaptive thinking instead, and surface progress via the `sp tab` notifier (CLAUDE.md "Long-running orchestrator alerts"), not by echoing chain-of-thought.

## B. Skill de-prescription — DEFERRED (eval-gated)

Fable-5 guide: "Skills developed for prior models are often too prescriptive for Fable 5 and can degrade output quality. Review and consider removing older instructions **if default performance is better**." Note the condition — *tested*, not assumed.

**Candidates (by SKILL.md line count):** `impl` (760), `slice` (436), `refactor` (354), `improve` (304), `pickup` (282).

**Why deferred:** de-prescribing helps Fable 5 but the gain is unverifiable on Opus 4.8, and the risk (degrading a working skill on the model we run today) is real. Blanket rewrite is reckless even on Fable 5.

**Release gate — do this per-skill only when actually on Fable 5:**
1. Snapshot OLD output on ≥2 real fixtures (per CLAUDE.md "Refactor: output-pipeline safety" — the snapshot is the contract, never the new code's output).
2. Produce a leaner candidate (strip enumerated micro-steps; keep load-bearing structural sentences and routing fields).
3. Run `/eval <skill>` + a before/after diff on the fixtures on Fable 5.
4. Adopt only if the leaner version is **measurably ≥** the verbose one. Otherwise keep verbose.

Do NOT batch this across skills. One skill, one eval, one decision.

## C. Refusal → Opus-4.8 fallback — DEFERRED (only matters on Fable 5)

Fable 5 runs safety classifiers (offensive-cyber, bio/life-sciences, reasoning-extraction) that can refuse benign work. Mitigation is server-/client-side fallback to Opus 4.8. **Not relevant while we run Opus 4.8.** When migrating: configure fallback before flipping the default model; the audit in §A already removed our one self-inflicted refusal trigger.

## D. Effort-level guidance — DOCUMENT-ONLY

Fable-5 effort policy: `high` default, `xhigh` for the most capability-sensitive work, `medium`/`low` for routine. Lower-effort Fable 5 still beats higher-effort prior models. Mapping for brain-os when on Fable 5:

| Skill tier | Effort |
|------------|--------|
| Design/judgment: `grill`, `grill-fast`, `audit`, `refactor`, `slice`, decision classifiers | `xhigh` / `high` |
| Build/execute: `impl`, `tdd`, `research`, `study` | `high` |
| Routine/mechanical: `vault-lint`, `status`, `journal`, `aha`, `pickup` dispatch | `medium` / `low` |

Effort is a harness setting, not skill content — this table informs per-invocation effort once on Fable 5. On Opus 4.8 the effort scale differs; do not port these literally.

## E. send_to_user tool — COVERED, no action

Fable-5 guide recommends a `send_to_user` client-side tool for verbatim mid-run delivery in long async agents. Our `sp tab` notifier (CLAUDE.md "Long-running orchestrator alerts: sp tab, not osascript") already delivers verbatim user-facing messages from detached orchestrators. No new machinery — building a parallel tool would duplicate it.
