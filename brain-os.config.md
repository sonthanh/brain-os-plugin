# Brain OS Configuration

## Vault Path
```
vault_path: /Users/thanhdo/work/brain
```

## Setup
Change `vault_path` above to your Obsidian vault location. All skills read this file to find the vault.

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
