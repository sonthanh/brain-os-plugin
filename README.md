# Brain OS

Your AI tools give generic answers because they don't know how you think.
Brain OS fixes that — it's a Claude Code plugin that turns your Obsidian vault into a second brain that learns, thinks, and acts with you.

## Quick Start

One line. Plugin + vault + everything ready in under 2 minutes:

```bash
curl -sSL https://raw.githubusercontent.com/sonthanh/brain-os-plugin/main/install.sh | bash
```

Already have an Obsidian vault? Point to it:
```bash
curl -sSL .../install.sh | bash -s -- --vault ~/my-vault
```

Just want the plugin (no vault setup):
```bash
curl -sSL .../install.sh | bash -s -- --plugin-only
```

After install, try your first command:

```
/think What should I focus on this week?
```

Brain OS reads your context, goals, and recent activity — then thinks with you.
Not generic advice. Your priorities, your situation.

> **Power feature:** `/study` reads an entire book, extracts atomic notes, validates each one against NotebookLM (159/159 checks, avg 97/100 accuracy), and connects insights to your vault — fully autonomous.

See [Getting Started](GETTING-STARTED.md) for the full setup walkthrough and first use cases.

## GitHub tasks setup

Tasks (`/pickup`, `/handover`, `/status`, `/impl`, `/slice`) live as GitHub issues in a repo you own — not in Markdown files. This solves multi-session concurrency (atomic state, stable IDs, no merge conflicts).

**One-time setup:**

1. Pick or create a GitHub repo you own (private or public) — e.g. `your-username/my-tasks`.
2. `gh auth login` if not already authenticated.
3. Set `gh_task_repo:` in `~/.brain-os/brain-os.config.md`:
   ```
   gh_task_repo: your-username/my-tasks
   ```
4. Bootstrap the 15 labels (status, priority, weight, owner, type):
   ```bash
   R=your-username/my-tasks
   gh label create status:ready        --color 0E8A16 -R $R
   gh label create status:in-progress  --color 1D76DB -R $R
   gh label create status:blocked      --color B60205 -R $R
   gh label create status:backlog      --color C5DEF5 -R $R
   gh label create priority:p1         --color D93F0B -R $R
   gh label create priority:p2         --color FBCA04 -R $R
   gh label create priority:p3         --color FEF2C0 -R $R
   gh label create priority:p4         --color E1E4E8 -R $R
   gh label create weight:heavy        --color 5319E7 -R $R
   gh label create weight:quick        --color 006B75 -R $R
   gh label create owner:human         --color F9D0C4 -R $R
   gh label create owner:bot           --color BFDADC -R $R
   gh label create type:handover       --color FF6B6B -R $R
   gh label create type:plan           --color 8A2BE2 -R $R
   ```

Without `gh_task_repo` configured, skills silently skip the task panel and work in read-only vault mode.

## Why Brain OS

Claude Code skills solve specific tasks. But context is scattered across projects, skills, and agents. Each one knows a piece — none sees the full picture. Decisions from fragmented context are generic: "correct but not yours."

Think of it like onboarding a team lead. You don't start by delegating decisions — you teach them how you think first. Give them the books you've read, the frameworks you use, the goals you're chasing. Then gradually let them act.

That's what Brain OS does with AI. One vault, one knowledge layer. Every skill reads from the same source of truth — your context, your knowledge, your decisions. The more you use it, the more it thinks like you.

Karpathy is building something similar with "LLM Knowledge Bases." Same direction, different purpose — he builds a wiki to read. Brain OS is an OS to act.

[Read the full story: Day 1 — I Taught an AI to Read a Book](https://thanhdo.substack.com/)

## Skills

### Learn — teach it what you know

| Skill | When to use |
|-------|-------------|
| `/study` | When you want to master a book end-to-end: extract, validate, absorb into your vault |
| `/self-learn` | When you want to extract and validate knowledge from a book (the core of `/study`) |
| `/research` | When you need to understand a topic — searches the web and synthesizes a cited report |

### Think — let it reason with you

| Skill | When to use |
|-------|-------------|
| `/think` | When you're stuck on a decision, exploring an idea, or want deep reflection on anything |
| `/grill` | When you need a plan stress-tested until it's bulletproof |
| `/audit` | One-shot principle check via advisor — non-interactive, returns findings |

### Act — let it work for you

| Skill | When to use |
|-------|-------------|
| `/status` | Morning briefing — what's open, what's urgent, what to focus on |
| `/aha` | When something clicks mid-session — captures the moment with full context |
| `/journal` | End of day — aggregates your journey into content material, surfaces what's missing |
| `/handover` | When you're stopping a session — creates a summary for next time |
| `/pickup` | When you're starting a new session — resumes where you left off (HITL: handover, owner:human, autogrill) |
| `/slice` | After a settled `/grill`, breaks the plan into a parent story issue (PRD body) + tracer-bullet child issues |
| `/impl` | AFK executor — picks one `owner:bot` issue, runs `/tdd`, commits, pushes, closes |
| `/impl auto` | Drains the `owner:bot` Ready queue serial (or with `-p N` for N worktrees in parallel) |
| `/impl story <N>` | DAG drains all children of a parent story issue. Bash-detached TS orchestrator (`scripts/run-story.ts`) — main session burns ~0 tokens during drain, macOS notification when parent closes |

<details>
<summary><strong>All skills</strong> — full reference</summary>

| Skill | Description |
|-------|-------------|
| `/ingest` | Process raw notes into structured vault notes |
| `/verify` | Verify extracted knowledge against NotebookLM with fresh questions |
| `/absorb` | Connect book insights to your vault zones (business, personal, thinking) |
| `/gmail` | Automated inbox triage — cleanup, draft replies, process reports |
| `/gmail-bootstrap` | One-time setup: scan 3 months of inbox to build email rules |
| `/tdd` | Red-green-refactor for skills, scripts, hooks, vault docs |
| `/debug` | Investigate a reported bug + file a /tdd RED-GREEN fix plan as a GH issue |
| `/improve` | Analyze skill outcomes + propose self-improvements (eval-gated) |
| `/reorg` | Weekly system-level architecture audit across plugin + vault |
| `/vault-lint` | Nightly mechanical hygiene — broken links, orphan pages, stale tasks |
| `/triggers` | Manage and debug scheduled remote agents |
| `/eval` | Run eval checks on skills to catch regressions |
| `/sync` | Git commit and push all vault changes |

</details>

## Dependencies

**Required for all skills:**
- [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview)
- An Obsidian vault (or any markdown-based vault)

**Required for self-learn and verify only:**
- Python 3.12+
- [notebooklm-py](https://github.com/nicholasgasior/notebooklm-py) — `pip install notebooklm-py`
- `pip install ebooklib beautifulsoup4`

## Eval System

Brain OS includes evals to catch regressions when editing skills.

**Auto (on every edit):** A PostToolUse hook diffs against git baseline and warns if critical content was removed.

**On-demand:** Pipeline skills have `evals/evals.json` following the [Agent Skills](https://agentskills.io/skill-creation/evaluating-skills) standard:

```
/eval self-learn
```

## Updating

```bash
curl -sSL https://raw.githubusercontent.com/sonthanh/brain-os-plugin/main/install.sh | bash
```

## Uninstall

```bash
curl -sSL https://raw.githubusercontent.com/sonthanh/brain-os-plugin/main/install.sh | bash -s -- --uninstall
```

## Links

- [Documentation](https://aileadersvietnam.mintlify.app/)
- [Subscribe on Substack](https://thanhdo.substack.com/) — build logs, self-learn pipeline walkthroughs, and how to build your own second brain
- [Agent Skills spec](https://agentskills.io/specification) — the open format standard

## License

MIT
