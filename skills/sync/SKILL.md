---
name: sync
description: "Use when vault changes need to be committed and pushed to git, or after completing a session's work"
---

# Sync — Vault Git Backup

Auto-commit and push all vault changes to git remote. Safe, fast, and descriptive.

## Configuration
```yaml
vault_path: "{vault}"  # Read {vault} from ${CLAUDE_PLUGIN_ROOT}/brain-os.config.md
remote: origin
branch: main
```

## Behavior

### `/sync` — Full sync
1. `cd {vault}`
2. Run `git status` to see what changed
3. If no changes: report "Nothing to sync" and exit
4. Stage all changes: `git add -A` (`.gitignore` protects `private/`)
5. Generate a descriptive commit message based on what changed:
   - Group changes by zone (knowledge/, business/, thinking/, context/, daily/, etc.)
   - Example: "sync: +12 knowledge notes (the-road-less-stupid), update daily 2026-04-04, add task to inbox"
   - Keep message under 72 chars for the title, details in body
6. Commit with the generated message
7. Push to origin/main
8. Report summary: files changed, commit hash, push status

### `/sync --status` — Check what's pending
1. Run `git status` and `git diff --stat`
2. Report what would be committed if you ran `/sync`
3. Do NOT commit or push

### `/sync --dry-run` — Preview commit message
1. Same as `/sync` but stop before committing
2. Show the generated commit message
3. Ask: "Commit and push? (yes / edit message / skip)"

## IMPORTANT: Always run these commands, never generate manually.

### For full sync:
```bash
cd {vault} && git add -A && git status
```
Then generate commit message based on output, then:
```bash
cd {vault} && git commit -m "$(cat <<'EOF'
<generated message>

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)" && git push origin main
```

### For status only:
```bash
cd {vault} && git status && git diff --stat
```

## Commit Message Format
```
sync: <short summary of what changed>

Zones changed:
- knowledge: <what>
- business: <what>
- daily: <what>
- thinking: <what>
- context: <what>

Co-Authored-By: Claude <noreply@anthropic.com>
```

## Safety Rules
- **Never force push** — always regular push
- **Never push to a branch other than main** unless explicitly asked
- **private/ is gitignored** — verify before pushing if concerned
- **If push fails** (remote has changes): pull first, then push. Report any merge conflicts.
- **Large binary files**: warn if any file > 5MB is staged

## Auto-Sync Integration
Other skills can call sync after making vault changes:
- `/self-learn` → after Phase 1-3 complete → `/sync`
- `/absorb` → after vault connections applied → `/sync`
- `/close` → end of day → `/sync`
- `/ingest` → after book note created → `/sync`
