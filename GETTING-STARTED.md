# Getting Started with Brain OS

Brain OS turns your Obsidian vault into a second brain you can talk to. Claude Code reads your vault and uses 15+ skills to help you think, research, learn, and operate.

---

## Prerequisites

| Requirement | Notes |
|------------|-------|
| [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview) | The Claude CLI — required for all skills |
| [Obsidian](https://obsidian.md/) | Your vault lives here (free download) |
| [Obsidian Kanban plugin](https://github.com/mgmeyers/obsidian-kanban) | Required for task management board |

**Optional** (for the self-learn + audit pipeline only):
- Python 3.12+
- [notebooklm-py](https://github.com/nicholasgasior/notebooklm-py) — `pip install notebooklm-py`
- `pip install ebooklib beautifulsoup4`

---

## Step 1 — Install Brain OS

**Option A: One-line install (all skills)**
```bash
curl -sSL https://raw.githubusercontent.com/sonthanh/brain-os-plugin/main/skills.sh | bash
```

**Option B: Pick specific skills**
```bash
curl -sSL https://raw.githubusercontent.com/sonthanh/brain-os-plugin/main/skills.sh | bash -s status think research ingest
```

**Option C: Claude Code marketplace**
```
/plugin marketplace add sonthanh/brain-os-marketplace
/plugin install brain-os@brain-os-marketplace
```

---

## Step 2 — Set Up Your Vault

Run the setup script to create the vault structure and starter files:

```bash
# Interactive — prompts for vault path
./setup-vault.sh

# Or specify path directly
./setup-vault.sh ~/my-vault

# Preview without writing anything
./setup-vault.sh --dry-run
```

This creates all required directories, populates starter template files, and updates `brain-os.config.md` with your vault path.

**Then open the vault in Obsidian:**
- File → Open vault → select your vault folder
- Install the Kanban plugin: Settings → Community plugins → search "Kanban"

---

## Step 3 — Fill In Your Context

Context files are the foundation — every skill reads them to understand who you are.

Open these files in Obsidian and fill in the `[brackets]`:

| File | What to add |
|------|------------|
| `context/about-me.md` | Your name, role, timezone, location |
| `context/business.md` | What your business does and who it's for |
| `context/goals.md` | Your goals this year, quarter, month |
| `context/icp.md` | Your target customer (even if you're a solo creator) |
| `context/brand.md` | Your voice, tone, content pillars |
| `context/strategy.md` | Where you're going and what you're betting on |
| `context/preferences.md` | How you like to communicate and receive output |

> You don't need to fill all of these on day 1. Start with `about-me.md` and `business.md` — everything else can grow over time.

---

## First Use Cases

### 1. Morning check-in

Get a briefing on what's open, what's urgent, what to focus on.

```
/status
```

Brain OS reads your task inbox, daily notes, and recent activity and gives you a prioritized plan. Use this every morning to start with clarity.

---

### 2. Capture a quick thought

You have an idea mid-conversation or mid-work. Don't lose it.

```
Add this to my quick capture: [your thought]
```

Brain OS writes it to `personal/inbox/quick-capture.md`. Review weekly and move captures to their proper location.

---

### 3. Research a topic

Need to understand something — a concept, a competitor, a trend. Brain OS searches the web and synthesizes a cited report.

```
/research [topic]
```

Example:
```
/research best practices for building a paid newsletter community
```

Output goes to `knowledge/research/reports/`. You can optionally ingest the findings into your vault for later recall.

---

### 4. Think through a problem

Stuck on a decision or want to explore an idea deeply? Enter thinking mode.

```
/think [your question or situation]
```

Example:
```
/think Should I focus on building a paid community or a free one first?
```

Brain OS reads your context files, goals, and strategy — then thinks alongside you. Output goes to `thinking/agent-output/`.

---

### 5. Study a book

Have a book (epub or PDF)? Run the full knowledge pipeline:

```
/study [book title]
```

This runs 3 phases automatically:
1. **self-learn** — extracts key ideas, frameworks, and insights from the book
2. **audit** — validates the extraction against NotebookLM with 50 fresh questions
3. **absorb** — connects insights to your vault zones (business, personal, thinking)

Output lands in `knowledge/books/[book-name].md`.

---

### 6. Capture an insight mid-session

When something clicks — a decision, a pattern, a realization — mark it:

```
aha — [your insight]
```

Brain OS captures it with full context: what you were doing, why it matters, and saves it to the vault.

---

### 7. End-of-session handover

Working on something complex across multiple sessions? Create a handover:

```
/handover
```

Brain OS writes a summary of what you did, what decisions were made, what's next. On your next session:

```
/pickup
```

It reads the handover and resumes right where you left off.

---

### 8. Ingest raw notes

Have raw notes, highlights, or extracted text from a book? Drop them in `knowledge/raw/` then:

```
/ingest
```

Brain OS processes the raw file into a structured book note with frontmatter, key insights, and frameworks — ready for `/absorb`.

---

## Vault Structure Reference

```
your-vault/
├── context/                    # Who you are — read by every skill
│   ├── about-me.md
│   ├── business.md
│   ├── goals.md
│   ├── icp.md
│   ├── brand.md
│   ├── strategy.md
│   └── preferences.md
├── business/
│   ├── tasks/
│   │   ├── inbox.md            # Kanban board — your task list
│   │   └── archive/
│   ├── projects/               # Project notes
│   ├── intelligence/
│   │   ├── meetings/           # Meeting notes
│   │   ├── decisions/          # Key decisions log
│   │   └── research/           # Business research
│   └── departments/            # SOPs, team processes
├── personal/
│   ├── inbox/
│   │   └── quick-capture.md    # Fast idea drops
│   ├── people/                 # Notes on people
│   ├── research/               # Personal research
│   └── resources/              # Templates, prompts
├── thinking/
│   ├── agent-output/           # Claude's analysis outputs
│   ├── ideas/                  # Your ideas
│   ├── patterns/               # Patterns you notice
│   ├── reflections/            # Personal reflections
│   └── connections/            # Cross-domain connections
├── knowledge/
│   ├── raw/                    # Drop unprocessed content here
│   ├── books/                  # Structured book notes
│   │   └── _index.md           # Reading list
│   ├── research/
│   │   ├── reports/            # /research outputs
│   │   └── findings/           # Atomic insights
│   ├── articles/
│   └── podcasts/
├── daily/                      # Daily notes (YYYY-MM-DD.md)
├── private/                    # Git-ignored — confidential data
└── commands/                   # Vault-specific automation
```

---

## Tips

**Start small.** Fill in `about-me.md` and `business.md`, try `/status` and `/think`. The vault compounds — every session adds value.

**The vault is your memory.** Anything important should live there. Skills read from it at runtime, so keeping it updated means every skill gets smarter automatically.

**`private/` is sacred.** Add your Obsidian vault to git for backup, but `private/` stays excluded via `.gitignore`. Store confidential things there — API keys, sensitive notes, personal data.

**Obsidian + Claude Code.** Use Obsidian for reading and browsing your vault. Use Claude Code (in any session) to write, think, and operate — the skills bridge them.

---

## Skill Reference

| Skill | When to use |
|-------|------------|
| `/status` | Morning briefing — tasks, priorities |
| `/think` | Explore ideas, decisions, problems |
| `/research` | Web research → vault report |
| `/study` | Full book pipeline (extract → validate → absorb) |
| `/self-learn` | Extract knowledge from a book |
| `/ingest` | Process raw notes into structured vault notes |
| `/absorb` | Connect book insights to vault zones |
| `/audit` | Validate extracted book knowledge |
| `/handover` | End-of-session summary for next session |
| `/pickup` | Resume from a previous handover |
| `/aha` | Capture key insight mid-session |
| `/gmail` | Inbox triage and cleanup |
| `/gmail-bootstrap` | One-time: learn your inbox patterns |
| `/triggers` | Manage scheduled agents |

---

## Troubleshooting

**Skill can't find my vault**
Edit `~/.brain-os/brain-os.config.md` and verify `vault_path` points to the correct location.

**Kanban board shows raw markdown**
Install the Obsidian Kanban plugin: Settings → Community plugins → Browse → search "Kanban" → Install → Enable.

**`/self-learn` or `/audit` fails**
These require `notebooklm-py` and Python dependencies. See the [README](README.md) for setup instructions.

**A skill writes to the wrong place**
Check your `context/` files — if `about-me.md` or `preferences.md` are empty, the skill falls back to defaults. Filling in context fixes most behavior issues.
