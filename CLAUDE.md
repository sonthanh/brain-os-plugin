# Brain OS Plugin

Claude Code plugin for managing a second brain powered by Obsidian. 16 skills across Learn, Think, and Act.

## Repo Structure

```
brain-os-plugin/
├── skills/               # Each skill = one directory with SKILL.md + optional scripts/
│   ├── self-learn/       # Knowledge extraction pipeline (Python scripts)
│   ├── audit/            # NotebookLM validation pipeline (Python scripts)
│   ├── study/            # Orchestrator: self-learn → ingest → audit → absorb
│   ├── think/            # Deep thinking mode (includes emerge, challenge, drift, connect, trace, ghost)
│   ├── gmail/            # Gmail automation (TypeScript, OAuth, runs on cron)
│   └── ...               # 16 skills total
├── hooks/                # Plugin hooks (auto-registered on install)
│   └── hooks.json        # Hook definitions (SessionStart, SessionEnd, PostToolUse)
├── evals/                # Eval system
│   └── smart-diff-check.sh  # PostToolUse hook: validates SKILL.md changes
├── .claude-plugin/
│   └── plugin.json       # Plugin metadata
├── install.sh            # Unified installer (curl or local)
├── setup-vault.sh        # Vault structure creator (called by install.sh)
├── skills.sh             # Legacy remote installer (kept for backwards compat)
├── brain-os.config.md    # User config — vault_path lives here
├── .github/workflows/    # CI: release tagging, gitleaks
└── package.json          # Node deps for gmail skills (tsx, googleapis)
```

## Key Conventions

- **Skills are pointers, not containers.** Skills read from the vault at runtime via `brain-os.config.md` → `vault_path`. Never hardcode knowledge in skills.
- **SKILL.md is the skill.** Each skill's logic lives in `skills/<name>/SKILL.md`. Complex skills also have `scripts/` and `references/`.
- **Vault structure matters.** All skills expect the vault layout defined in `setup-vault.sh`. Zones: context/, business/, personal/, thinking/, knowledge/, daily/, private/.
- **Config path:** `~/.brain-os/brain-os.config.md` (remote install) or `./brain-os.config.md` (local).

## Development

```bash
# Local install (symlinks skills to ~/.claude/skills/)
./install.sh

# Install with force (replace existing symlinks)
./install.sh --force

# Test a specific skill's evals
/eval self-learn

# Run gmail scripts
npm run gmail:clean
npm run gmail:bootstrap
```

## Skill Categories

| Category | Skills | Notes |
|----------|--------|-------|
| **Learn** | study, self-learn, audit, ingest, absorb, research | self-learn/audit need Python 3.12+ and notebooklm-py |
| **Think** | think, grill (via separate plugin) | /think subsumes old emerge/challenge/drift/connect/trace/ghost |
| **Act** | status, aha, journal, handover, pickup, gmail, gmail-bootstrap, triggers, eval | gmail needs Node deps + OAuth setup |

## Hooks

Plugin hooks live in `hooks/hooks.json` and are auto-registered on install:
- **SessionStart**: shows open tasks from vault kanban
- **PostToolUse** (Edit|Write): validates SKILL.md changes via smart-diff-check
- **SessionEnd**: auto-commits vault changes, captures session summary, archives done tasks

## Editing Rules

- Edit skill source here, NEVER in `~/.claude/plugins/cache/` (installed copies are symlinks)
- When editing SKILL.md: the PostToolUse hook will validate. If it blocks, review what was removed.
- ALL_SKILLS arrays in `install.sh` and `skills.sh` must stay in sync
- After changes: commit and push (auto-deploy via symlinks)
