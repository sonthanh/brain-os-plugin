# Brain OS Configuration

## Vault Path
```
vault_path: /path/to/your/obsidian-vault
```

## GitHub Task Repo
```
gh_task_repo: your-username/your-task-repo
```

## Setup
1. Change `vault_path` above to your Obsidian vault location.
2. Change `gh_task_repo` to a GitHub repo you own (private or public). This is where `/pickup`, `/handover`, `/status`, and the auto-pickup cron store tasks as issues.
3. Run the label bootstrap script (one-time): `bash {vault_path}/scripts/gh-tasks/bootstrap-labels.sh --repo your-username/your-task-repo` (or copy the script from the brain-os-plugin examples).
4. Copy this file to `~/.brain-os/brain-os.config.md` to persist your personal config across plugin upgrades.

All skills read this file to find the vault and task repo.

## Expected Vault Structure
```
{vault_path}/
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
