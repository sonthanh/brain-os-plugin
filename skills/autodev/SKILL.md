---
name: autodev
description: "Ultimate autonomous goal→proof loop: auto-grill a fuzzy goal, slice the grounded decisions into a parent PRD + tracer-bullet children, implement each with a TDD evaluator-regenerate loop, then deliver a per-acceptance-criterion PROOF report. Triggers: '/autodev <goal>', 'build this with proof while I'm away', 'autonomously ship and prove this'. For queue-and-walk-away (no drive-to-done, no proof) use /afk; to clarify with a human in the loop use /grill."
auto_improve: false  # orchestrator over adversarial grill + impl; evolve by manual decision (re-sync grill prompts from auto-grill, not auto-patch).
---

# /autodev — goal → proof, fully autonomous

One invocation from "here's a fuzzy goal" to "here is proof each acceptance criterion is satisfied." `/autodev` is the autonomous sibling of `/afk`: where `/afk` *queues* work and hands it to the async scheduler spine, `/autodev` **drives the work to completion in one detached Workflow run and ends with a proof report**. It composes the existing skills — it does not re-implement them:

| Stage | Reuses | What it does |
|-------|--------|--------------|
| Grill | `/auto-grill` engine (inlined) | decompose the goal → self-answer each decision from vault/code/web → adversarially verify grounding |
| Slice | `/slice` contract | grounded decisions → parent PRD + tracer-bullet children (≥1 `(LIVE E2E)` AC, `## Covers AC`, rung-0 first) |
| Impl + Evaluate | `/impl` + `/tdd` + geo-dev evaluator loop | per child: TDD red-green → independent evaluator → regenerate on fail (K=3) → land or escalate |
| Proof | `scripts/proof-report.ts` (net-new) | render a per-AC PROOF report from the run's results: verdict + evidence + commit + test summary |

The Workflow IS the control loop (deterministic JS, runs detached) — the session kicks it once and reads the result, it never orchestrates by agent-turn (the expensive anti-pattern, `thinking/aha/2026-04-18-orchestration-on-script.md`). **All agents run Opus** (design judgment + codegen + adversarial verification); do not downgrade.

## Usage

```
/autodev <goal>          # full run: grill → slice → impl+evaluate → proof report
/autodev <goal> --dry-run   # grill + slice spec + would-impl, files/edits NOTHING; renders a DRY proof report
/autodev #N              # an issue number: fetch the body as the goal context first
```

## Autonomy model — escalate-not-break (the crux, READ FIRST)

A no-human loop collides with two facts: `/auto-grill --unattended` leaves ungrounded gaps OPEN (it never guesses), and `/slice` refuses to operate on an unsettled plan. The seam that reconciles them is **escalate-not-break**:

- **Grounded decisions** (a re-read citation verifiably supports the pick) flow into the slice. **Ungrounded gaps** are **filed as HITL issues** (`owner:human`, `[autodev gap]`) — the loop **never guesses-and-builds** on what evidence could not settle. A confidently fabricated answer that buries a real gap is the one failure this whole system exists to prevent.
- **Zero grounded decisions** → honest no-op: surface every gap, build nothing. That is the correct outcome on a pure-taste / pure-strategy goal, not a failure.
- **Reflection-tier goal** (no implementation surface) → stop after grill; no slice, no impl.
- **A child that fails its evaluator after K=3 iterations** is escalated (re-labelled `owner:human`, left OPEN, branch kept) — **never push broken work behind a green PR**.

The proof report tells the truth about all of this: escalated children and unverified ACs show as `UNVERIFIED` / `escalated`, never silently dropped.

## Config

**Vault path:** read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md` (user-local `~/.brain-os/brain-os.config.md` takes precedence). Key `vault_path:`. Substitute the resolved value for every `{vault}/...`. If unresolvable → abort with a `fail` outcome line. Do NOT guess from cwd.

**Plugin root:** resolve `CLAUDE_PLUGIN_ROOT` (env var → glob fallback `~/.claude/plugins/cache/brain-os-marketplace/brain-os/*/`). Pass the absolute path into the Workflow as `args.pluginRoot` — the Workflow agents shell `proof-report.ts` and `create-task-issue.sh` by absolute path.

## Source repo paths

- Workflow: `${CLAUDE_PLUGIN_ROOT}/skills/autodev/references/autodev.workflow.js`
- Proof renderer (SSOT): `${CLAUDE_PLUGIN_ROOT}/scripts/proof-report.ts`
- Grill engine reused from: `${CLAUDE_PLUGIN_ROOT}/skills/auto-grill/references/auto-grill.workflow.js`
- Issues filed to: `sonthanh/ai-brain` (hook-enforced; never the plugin repo)

## Phase 1 — Gather context (deterministic, before the Workflow)

1. Resolve `vault_path`, `gh_task_repo`, and `CLAUDE_PLUGIN_ROOT`.
2. Compute today's date (`date +%Y-%m-%d`) — pass as `args.date`; Workflow scripts cannot call `new Date()`.
3. If the goal is an issue reference (`#N`), run `gh issue view N --repo <gh_task_repo>` FIRST and pass the body as `args.context`. Never autodev an already-closed issue.
4. If this run was preceded by a `/grill` or `/grill-fast` design artifact, pass its vault-relative path as `args.designRef` so the proof report and gap issues backlink to it.

## Phase 2 — Kick the Workflow (one call; it does the rest)

This is **ultracode territory** — the run spawns one agent per decision plus verifiers, a slice synthesizer, and an impl+evaluator chain per child. Only invoke the Workflow when the user opted into multi-agent orchestration (said `ultracode`, asked for a workflow, or invoked this skill).

Invoke the **Workflow** tool with `scriptPath: ${CLAUDE_PLUGIN_ROOT}/skills/autodev/references/autodev.workflow.js` and `args` as an actual JSON object (never a JSON string — a stringified object reaches the script as one string and every `args.x` reads undefined):

```
args: {
  goal, context, vaultPath, taskRepo, date,
  dryRun,            // true for --dry-run: files/edits NOTHING
  pluginRoot,        // absolute CLAUDE_PLUGIN_ROOT
  area,              // default "plugin-brain-os"
  areaRepoPath,      // cwd for implementation edits, default "~/work/brain-os-plugin"
  designRef,         // optional grill-session path
  maxChildren        // default 5
}
```

The Workflow runs detached and does, in order (all agents Opus, own contexts):

1. **Grill** — decompose → pipeline(auto-answer → verify-grounding). Splits decisions into grounded vs gaps.
2. **Seam** — escalate-not-break (above). Files gaps as HITL; stops on reflection-tier / all-gaps.
3. **Slice** — synthesize parent PRD + tracer-bullet children; deterministic AC-coverage gate + `(LIVE E2E)` gate + rung-0 ordering. Files them unless `--dry-run`.
4. **Implement → Evaluate** — per child (rung-0 first): TDD red-green → independent adversarial evaluator runs the real acceptance commands → regenerate on fail up to K=3 → land (PR + `Acceptance verified: AC#N — …` evidence comment) or escalate.
5. **Report** — shells `proof-report.ts --build-results` to render the per-AC proof, writes `{vault}/daily/autodev-reports/{date}-{slug}.md`, appends the outcome row, runs a completeness critic.

Do NOT poll the Workflow with Bash/Monitor loops — that re-introduces orchestrate-by-agent. The harness re-invokes you when it finishes; then read its returned summary.

## Phase 3 — Finalize (after the Workflow returns)

1. Read the Workflow's returned summary (`resolved / gaps / children / implemented / escalated / reportPath / verdict`).
2. Surface the proof verdict to the user in plain English — lead with `PROVEN` / `PARTIAL` / `UNPROVEN`, the report path, and any escalated children or filed gaps. Be honest: a PARTIAL with 2 escalated children is not "done."
3. If the Workflow crashed before its Report phase, write the `fail` outcome line yourself (`reason=workflow-crash`).
4. Notify the user (long-running orchestrator alert): `sp tab` banner, falling back to `osascript display notification`, with the verdict + report path.

## Gotchas

- **Escalate-not-break is non-negotiable.** Never let the slice consume an ungrounded decision. A fabricated answer that buries a real gap is the worst failure mode; the grounding verifier defaults to NOT grounded when uncertain, and gaps become HITL issues, not guesses.
- **Proof is the deliverable, not a handoff.** `/autodev` ends with `proof-report.ts` output — per-AC evidence (test summary + commit SHA + evidence-comment link), not "queued, watch here." That is the whole difference from `/afk`.
- **proof-report.ts is the SSOT renderer.** The Workflow shells it; do not hand-write a proof report in an agent prompt — that re-introduces the drift the renderer exists to kill.
- **Opus everywhere.** The grounding gate and the evaluator are only as good as the model; do not cost-optimize the grill or evaluator to Sonnet.
- **Never edit the installed plugin copy.** Workflow agents edit source repos only.
- **Issues go to `sonthanh/ai-brain`** via `create-task-issue.sh` — never inline `gh issue create`, never the plugin repo (hook-enforced).
- **--dry-run files and edits nothing.** It proves the chain wiring and renders a DRY proof report; use it to validate a new goal class before a real run.
- **/afk --auto delegates here.** `/afk --auto <goal>` is the documented entry point that routes into `/autodev`; `/afk` goal mode without `--auto` stays interactive (grill → slice → handoff).

## Outcome log

Follow `skill-spec.md § 11`. The Workflow's Report phase appends one row to `{vault}/daily/skill-outcomes/autodev.log`:

```
{date} | autodev | {run|dry} | ~/work/brain-os-plugin | daily/autodev-reports/{date}-{slug}.md | commit:{hash|N/A} | {result} | goal="{goal}" resolved=R gaps=G children=C implemented=I escalated=E verdict={PROVEN|PARTIAL|UNPROVEN}
```

- `result`: `pass` if verdict `PROVEN`; `partial` if `PARTIAL` or any child escalated / gap filed; `fail` if `UNPROVEN` or the Workflow errored.
- `resolved=R gaps=G` is the grounding metric (rising gaps on a covered goal = retriever/verifier regression — the signal `/improve` mines); `escalated=E` is the impl-quality signal.
