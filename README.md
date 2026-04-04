# Brain OS

A Claude Code plugin for managing a second brain powered by Obsidian. 25 skills for knowledge management, deep thinking, and vault operations.

**[Subscribe on Substack](https://thanhdo.substack.com/)** for detailed walkthroughs on building this plugin, the self-learn pipeline, and how to build your own second brain with Claude Code.

## Installation

### All skills (one line)

```bash
curl -sSL https://raw.githubusercontent.com/sonthanh/brain-os-plugin/main/skills.sh | bash
```

### Pick specific skills

```bash
curl -sSL https://raw.githubusercontent.com/sonthanh/brain-os-plugin/main/skills.sh | bash -s self-learn audit today
```

### Via Claude Code Marketplace

```bash
/plugin marketplace add sonthanh/brain-os-marketplace
/plugin install brain-os@brain-os-marketplace
```

### Uninstall

```bash
curl -sSL https://raw.githubusercontent.com/sonthanh/brain-os-plugin/main/skills.sh | bash -s -- --uninstall
```

### After Install

Edit `~/.brain-os/brain-os.config.md` and set your vault path:

```
vault_path: /path/to/your/obsidian/vault
```

## Vault Structure

Brain OS expects an Obsidian vault with this layout:

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

**Required for self-learn and audit skills only:**
- Python 3.12+
- [notebooklm-py](https://github.com/nicholasgasior/notebooklm-py) CLI at `~/.local/bin/notebooklm`
- Python packages: `pip install ebooklib beautifulsoup4`

```bash
cd brain-os-plugin/skills/self-learn/scripts
python3 -m venv .venv
source .venv/bin/activate
pip install ebooklib beautifulsoup4
```

## Eval System

Brain OS includes a two-layer eval system to catch regressions when editing skills.

### Layer 1: Smart Diff Check (automatic)

A PostToolUse hook that runs on every SKILL.md edit. Diffs against git baseline and warns if critical content was removed.

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{
          "type": "command",
          "command": "bash ~/brain-os-plugin/evals/smart-diff-check.sh"
        }]
      }
    ]
  }
}
```

### Layer 2: Eval checks (on-demand)

Pipeline skills have `eval.md` files with grep-based assertions:

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
7/7 passed
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

## Updating

```bash
/plugin update brain-os
```

## License

MIT
