# Getting Started

From zero to working Brain OS in under 2 minutes.

## Prerequisites

| Requirement | Notes |
|------------|-------|
| [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview) | The Claude CLI — required for all skills |
| [Obsidian](https://obsidian.md/) | Your vault lives here (free) |

**Optional** (for the self-learn + verify pipeline only):
- Python 3.12+
- [notebooklm-py](https://github.com/nicholasgasior/notebooklm-py) — `pip install notebooklm-py`
- `pip install ebooklib beautifulsoup4`

## Step 1 — Install

One line installs the plugin and creates your vault:

```bash
curl -sSL https://raw.githubusercontent.com/sonthanh/brain-os-plugin/main/install.sh | bash
```

This will:
1. Download and install all Brain OS skills
2. Create a vault at `~/brain` with the full folder structure
3. Populate starter context files (ready to fill in)
4. Configure Brain OS to point to your vault

**Already have an Obsidian vault?**
```bash
curl -sSL .../install.sh | bash -s -- --vault ~/my-vault
```

**Just want the plugin (skip vault setup)?**
```bash
curl -sSL .../install.sh | bash -s -- --plugin-only
```

When it finishes, you'll see:
```
✓ Brain OS installed (16 skills)
✓ Vault created at ~/brain
✓ Context files ready
✓ Config set

Ready! Try: /think What should I focus on this week?
```

## Step 2 — Open in Obsidian

Open Obsidian → File → Open vault → select your vault folder (default: `~/brain`).

Optional but recommended: install the **Kanban plugin** for task management:
Settings → Community plugins → Browse → search "Kanban" → Install → Enable.

## Step 3 — Fill in your context

Context files are the foundation — every skill reads them to understand who you are.

Open these in Obsidian and fill in the `[brackets]`:

| File | What to add | Priority |
|------|------------|----------|
| `context/about-me.md` | Your name, role, timezone | Start here |
| `context/business.md` | What your business does | Start here |
| `context/goals.md` | Goals this year/quarter/month | When ready |
| `context/icp.md` | Your target customer | When ready |
| `context/brand.md` | Voice, tone, content pillars | When ready |
| `context/strategy.md` | Where you're going, what you're betting on | When ready |
| `context/preferences.md` | How you like to communicate | When ready |

> You don't need all of these on day 1. Start with `about-me.md` and `business.md`. Everything else grows over time.

## Step 4 — Try it

### Morning briefing

```
/status
```

Reads your tasks, daily notes, and recent activity → gives you a prioritized plan.

### Think through a problem

```
/think Should I focus on building a paid community or a free one first?
```

Reads your context, goals, and strategy → thinks alongside you. Output goes to `thinking/agent-output/`.

### Research a topic

```
/research best practices for building a paid newsletter community
```

Searches the web → synthesizes a cited report → saves to `knowledge/research/reports/`.

### Capture a key moment

When something clicks mid-session:

```
aha — plugins should never hardcode knowledge, only point to the vault
```

Captures it with full context: what you were doing, why it matters.

### Study a book

Have an epub or PDF? Run the full knowledge pipeline:

```
/study [book title]
```

3 phases, fully autonomous:
1. **self-learn** — extracts key ideas, validates against NotebookLM
2. **verify** — 50 fresh questions to verify accuracy
3. **absorb** — connects insights to your vault zones

### End-of-session handover

```
/handover
```

Creates a summary of what you did, what was decided, what's next. On your next session:

```
/pickup
```

Resumes right where you left off.

### Reflect on your day

```
/journal
```

Aggregates your daily journey across sessions into structured content — and surfaces gaps in your thinking.

## Vault Structure

```
your-vault/
├── context/          # Who you are — read by every skill
├── business/         # Projects, tasks, intelligence
├── personal/         # Research, people, inbox
├── thinking/         # Ideas, patterns, reflections
├── knowledge/        # Books, articles, research
├── daily/            # Daily notes, handovers, journals
└── private/          # Git-ignored — confidential data
```

## Tips

**Start small.** Fill in `about-me.md` and `business.md`, try `/status` and `/think`. The vault compounds — every session adds value.

**The vault is your memory.** Skills read from it at runtime, so keeping it updated means every skill gets smarter automatically.

**`private/` is sacred.** Add your vault to git for backup, but `private/` stays excluded via `.gitignore`.

**Obsidian + Claude Code.** Use Obsidian for reading and browsing. Use Claude Code for writing, thinking, and operating — the skills bridge them.

## Troubleshooting

**Skill can't find my vault** — Edit `~/.brain-os/brain-os.config.md` and verify `vault_path` points to the correct location.

**Kanban board shows raw markdown** — Install the Obsidian Kanban plugin: Settings → Community plugins → search "Kanban".

**`/self-learn` or `/verify` fails** — These require `notebooklm-py` and Python dependencies. See [Prerequisites](#prerequisites).

**A skill writes to the wrong place** — Check your `context/` files. Empty context = default behavior. Filling them in fixes most issues.
