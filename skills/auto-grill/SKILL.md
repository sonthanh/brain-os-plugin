---
name: auto-grill
description: "Workflow-powered autonomous grill — fans out agents to self-answer a topic's decisions from vault/code/web, verifies grounding, and surfaces ONLY the genuine gaps. Use for '/auto-grill <topic>', 'auto-grill this', 'grill this unattended', or as a cron planning front-end. Interactive /grill and /grill-fast are for live human interviews; auto-grill answers itself first."
---

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md` (real config at `~/.brain-os/brain-os.config.md`; default vault `/Users/thanhdo/work/brain`).

## What it does

`/auto-grill` is `/grill` with the human taken out of the inner loop. It runs the [autogrill loop](https://github.com/sonthanh/ai-brain) as a **Workflow** so most questions are answered from evidence before anyone is asked:

1. **Detect** — decompose the topic into the decisions it implies (ARCH vs PARAM), same partition as `/grill-fast`.
2. **Auto-search** — one agent per decision searches vault → code → web and commits to the single best-practice answer **with citations**.
3. **Verify grounding** — a skeptic re-reads every citation. An answer is *resolved* only if a citation verifiably supports it; otherwise it becomes a **surfaced gap**.
4. **Surface only gaps** — the human (interactive) or an issue queue (unattended) sees ONLY what evidence could not settle.
5. **Write back** — the grill-session file is written to the vault so the resolved decisions never need re-asking.

The load-bearing piece is **step 3**. Auto-grill's whole value is "ask the human only what the vault genuinely doesn't know," and its only dangerous failure is a confidently fabricated answer that buries a real gap. The grounding verifier defaults to *not grounded* when uncertain, and the Workflow re-reads each cited file — a recommendation with no real citation is reclassified as a gap, never silently accepted.

## When to use which grill

| Skill | Who answers | Best for |
|-------|-------------|----------|
| `/grill` | human, every question | live design interview; taste/strategy where the human IS the evidence |
| `/grill-fast` | human, picks among pre-rendered trees | architecture topic where you want to decide in 2-3 turns |
| `/auto-grill` | **agents self-answer; human only on gaps** | topics with real vault/code coverage; unattended cron planning; draining "grill design first" issues |

If the topic is pure taste, strategy, or has no vault/code grounding, the auto-search resolves nothing — every decision becomes a gap and you are back to a normal `/grill`. That is the correct, honest outcome, not a failure. Auto-grill earns its keep on topics with **partial** coverage.

## Usage

```
/auto-grill <topic>                 # interactive: surfaces gaps to you via AskUserQuestion
/auto-grill <topic> --unattended    # cron mode: gaps become issues + a report, no human prompt
/auto-grill #287                     # an issue number: fetches the body as context first
```

## Flow

### 1. Gather context (deterministic, before the Workflow)
- Resolve `vault_path` and `gh_task_repo` from `brain-os.config.md`.
- Compute today's date (`date +%Y-%m-%d`) — pass it into the Workflow (`args.date`); Workflow scripts cannot call `new Date()`.
- If the topic is an issue reference (`#N` or a tracker URL), run `gh issue view N --repo <gh_task_repo>` FIRST and pass the body as `args.context`. The SessionStart cache is stale; never grill an already-closed issue.
- For a free-text topic, pass any user-provided detail as `args.context`.

### 2. Run the Workflow
Invoke the **Workflow tool** with `scriptPath` pointing at the canonical script (resolve `CLAUDE_PLUGIN_ROOT`):

```
scriptPath: ${CLAUDE_PLUGIN_ROOT}/skills/auto-grill/references/auto-grill.workflow.js
args: { topic, context, vaultPath, taskRepo, date, unattended }
```

The script runs four phases — Decompose → Auto-answer → Verify-grounding → Synthesize — and returns:
`{ metric:{total,resolved,gaps}, framing, sharedAxis, resolved[], gaps[], markdown, gapQuestions[], recommendation }`.

This is `ultracode` territory: the run spawns one agent per decision plus a verifier each, so only invoke the Workflow when the user opted into multi-agent orchestration (said `ultracode`, asked for a workflow, or invoked this skill). Use the strongest model for the first run on any topic — the grounding gate is only as good as the retriever; do not cost-optimize the auto-answer stage to Sonnet until the topic class is proven.

### 3. Write the grill-session file
Write the returned `markdown` to `{vault}/daily/grill-sessions/YYYY-MM-DD-<topic-slug>.md`, prepending frontmatter:

```yaml
---
title: "Auto-grill — <topic>"
created: YYYY-MM-DD
tags: [auto-grill, workflow, autogrill]
zone: daily
status: <pass|working|reflection>   # see status gate below
sparked_by:
  - "/auto-grill <topic>"
grounding: "resolved <R>/<T> from evidence; <G> gaps surfaced"
---
```

Then append the resolved-decision citations as wiki-links where they point at vault files, so the session participates in vault backlinking.

### 4. Surface the gaps
- **Interactive:** present `gapQuestions` to the user. If the file is story-tier with ≥3 ARCH decisions, the markdown already holds the ≥4-tree render — present the trees via `AskUserQuestion` (grill-fast convention). Otherwise ask the gap questions as prose, one batch, with your recommended answer per gap (decide-and-recommend). Write the user's answers back into the file under `# Open gaps — resolved by human` and flip those gaps to resolved.
- **Unattended (`--unattended`):** do NOT call `AskUserQuestion`. For each gap, file an issue on `gh_task_repo` titled `[auto-grill gap] <question>` with the body = the gap's `why` + `surfacedQuestion` + a backlink to the grill-session file. Write a one-line summary to `{vault}/daily/auto-grill-reports/YYYY-MM-DD-<slug>.md`. The loop owner triages the issues later.

### 5. Status gate (same contract as /grill)
- Story-tier (implies implementation) → it MUST carry ≥1 acceptance bullet marked `(LIVE E2E)` before `status: pass`. If the synthesized markdown lacks it, add the smallest end-to-end check that would prove the abstraction, or lock `status: working` and leave the build for a follow-up.
- Reflection-tier (no implementation surface) → `status: reflection`; no `/slice`, no audit menu.
- Any gaps still open and unanswered → `status: working`, not `pass`.

### 6. Next step
After a story-tier `status: pass` with all gaps resolved, the canonical next step is the `/grill` end-step audit menu (`/audit --all`) then `/slice <grill-file>`. Auto-grill does not re-implement the audit menu — defer to `/grill`'s for consistency.

## Gotchas

- **Grounding beats coverage.** A high resolved/total ratio is only good if each citation is real. Never tune the verifier toward "grounded" to make the metric look better — the metric exists to expose gaps, not to hide them. Trust the skeptic's default-to-gap bias.
- **Unattended mode never blocks.** No `AskUserQuestion`, no prose question that waits for a human. Gaps go to issues. This is what lets a self-improvement loop use auto-grill as its planning front-end on a cron.
- **Do not auto-grill taste.** Music/lyric taste, brand voice, and strategy calls have no vault citation that can settle them — every decision correctly becomes a gap. Running auto-grill there wastes a fan-out; route to `/grill` with the human.
- **Recommend one pick, don't enumerate.** Inherited from `/grill`: a resolved decision states the single best answer with its citation, not a menu.

## Outcome log

Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/auto-grill.log`:

```
{date} | auto-grill | grill | ~/work/brain-os-plugin | daily/grill-sessions/{date}-{slug}.md | commit:{hash} | {result} | args="{topic}" resolved=R total=T gaps=G mode={interactive|unattended}
```

- `result`: `pass` if the session locked (`status: pass` story-tier with live-e2e AC + all gaps resolved, OR `status: reflection`); `partial` if gaps remain open (`status: working`); `fail` if the Workflow errored or produced no decisions.
- `resolved=R total=T gaps=G` is the grounding metric — the primary success signal `/improve` mines for this skill (rising gaps on a covered topic = retriever or verifier regression).
