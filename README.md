# Brain OS

A Claude Code plugin for managing a second brain powered by Obsidian. 25 skills for knowledge management, deep thinking, and vault operations.

## Quick Start

### 1. Clone

```bash
git clone https://github.com/sonthanh/brain-os-plugin.git ~/work/brain-os-plugin
```

### 2. Configure vault path

Edit `brain-os.config.md` and set your Obsidian vault location:

```
vault_path: /path/to/your/obsidian/vault
```

### 3. Install

**Option A: Full plugin** (all 25 skills, auto-discovered by Claude Code)

```bash
# Create local marketplace and symlink
mkdir -p ~/.claude/plugins/marketplaces/local/plugins
ln -s ~/work/brain-os-plugin ~/.claude/plugins/marketplaces/local/plugins/brain-os
```

Then add `local` to `~/.claude/plugins/known_marketplaces.json`:

```json
{
  "local": {
    "source": { "source": "local", "repo": "local" },
    "installLocation": "~/.claude/plugins/marketplaces/local"
  }
}
```

Restart Claude Code. All skills are available.

**Option B: Individual skills** (symlink only what you need)

```bash
cd ~/work/brain-os-plugin
./install.sh self-learn audit today    # install selected skills
./install.sh                           # install all
./install.sh --list                    # see available skills
./install.sh --uninstall               # remove all symlinks
```

### 4. Set up eval hook (recommended)

Add to `~/.claude/settings.json` under `hooks`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "bash /path/to/brain-os-plugin/evals/smart-diff-check.sh"
          }
        ]
      }
    ]
  }
}
```

This auto-checks for regressions whenever a SKILL.md is edited.

## Vault Structure

Brain OS expects an Obsidian vault with this structure:

```
your-vault/
├── context/          # Who you are, business, goals, ICP, brand
├── business/         # Projects, tasks, intelligence, departments
├── personal/         # Research, people, resources, inbox
├── thinking/         # Ideas, patterns, reflections, connections
├── knowledge/        # Books, articles, raw input
│   ├── raw/          # Unprocessed book extractions
│   └── books/        # Structured book notes
├── daily/            # Daily notes, handovers
└── private/          # Git-ignored confidential data
```

## Skills

### Knowledge Pipeline
| Skill | Description |
|-------|-------------|
| **self-learn** | Master a book through 3-phase autoresearch: extract, validate against NotebookLM, extend |
| **audit** | Verify ingested knowledge with 50 fresh questions against NotebookLM |
| **chain** | Orchestrate full pipeline: self-learn → ingest → audit → absorb → sync |
| **ingest** | Process raw knowledge into structured vault notes |
| **absorb** | Extract deep insights from books, connect to vault zones |
| **book** | Interactive book knowledge capture through conversation |

### Daily Operations
| Skill | Description |
|-------|-------------|
| **today** | Morning review: calendar + tasks + recent notes → prioritized plan |
| **close** | End of day: extract action items, surface connections |
| **handover** | Create handover doc for next session with decisions and next steps |
| **pickup** | Resume unfinished work from a previous handover |
| **sync** | Git commit and push all vault changes |

### Thinking
| Skill | Description |
|-------|-------------|
| **think** | Deep thinking mode — ideas, patterns, reflections |
| **emerge** | Surface ideas the vault implies but you never stated |
| **challenge** | Pressure test beliefs against vault history |
| **drift** | Compare stated intentions vs actual behavior |
| **connect** | Find connections between two domains |
| **trace** | Track how an idea evolved over time |
| **ghost** | Answer a question in your voice based on vault history |
| **ideas-gen** | Generate ideas by scanning across all vault domains |
| **graduate** | Promote ideas from daily notes to standalone files |

### Mode Switching
| Skill | Description |
|-------|-------------|
| **work** | Business operations mode |
| **personal** | Personal assistant mode |
| **context** | Load full context about you |

### Meta
| Skill | Description |
|-------|-------------|
| **eval** | Run eval checks on skills to catch regressions |
| **writing-skills** | Guide for creating and testing new skills (from [superpowers](https://github.com/obra/superpowers)) |

## Dependencies

**Required for all skills:**
- [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview)
- An Obsidian vault (or any markdown-based vault with the expected structure)

**Required for self-learn and audit skills:**
- Python 3.12+
- [notebooklm-py](https://github.com/nicholasgasior/notebooklm-py) CLI at `~/.local/bin/notebooklm`
- Python packages: `pip install ebooklib beautifulsoup4`

To set up the Python environment for self-learn:

```bash
cd brain-os-plugin/skills/self-learn/scripts
python3 -m venv .venv
source .venv/bin/activate
pip install ebooklib beautifulsoup4
```

## Eval System

Brain OS includes a two-layer eval system to catch regressions when editing skills.

### Layer 1: Smart Diff Check (automatic)

A PostToolUse hook that runs on every SKILL.md edit. It diffs against the git baseline and warns if critical content was removed:

```
⚠️ SKILL.md changed: self-learn
  ✗ Removed key term: "information barriers"
  ✓ All script references preserved
1 issue(s) detected. Edit blocked.
```

### Layer 2: Eval checks (on-demand)

Pipeline skills (self-learn, audit, chain, ingest) have `eval.md` files with grep-based assertions:

```
/eval self-learn

Self-Learn Eval (7 checks)
  ✓ Q1: Autoresearch Architecture
  ✓ Q2: NotebookLM Setup
  ✓ Q3: Question Distribution
  ✓ Q4: Script References
  ✓ Q5: Stopping Condition
  ✓ Q6: Phase Structure
  ✓ Q7: Note Template
7/7 passed ✓
```

### Adding evals to your skill

Create `eval.md` in your skill directory:

```markdown
## Q1: Descriptive Name
type: grep
patterns:
  - "pattern to find"
  - "another pattern"
pass: all patterns found
why: Explain why this matters
```

## Learn More

For detailed walkthroughs on building this plugin, the self-learn pipeline, and how to build your own second brain with Claude Code:

**[Subscribe on Substack](https://thanhdo.substack.com/)**

## License

MIT
