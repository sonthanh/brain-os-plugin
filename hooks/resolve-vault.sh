#!/usr/bin/env bash
# Resolve vault path + GitHub task repo from brain-os.config.md
# Sources: ~/.brain-os/brain-os.config.md → ${CLAUDE_PLUGIN_ROOT}/brain-os.config.md
# Usage: source this file, then use $VAULT_PATH and $GH_TASK_REPO

for config in "$HOME/.brain-os/brain-os.config.md" "${CLAUDE_PLUGIN_ROOT:-}/brain-os.config.md"; do
  if [ -f "$config" ]; then
    [ -z "${VAULT_PATH:-}" ] && VAULT_PATH=$(grep 'vault_path:' "$config" | sed 's/vault_path: *//' | tr -d ' ')
    [ -z "${GH_TASK_REPO:-}" ] && GH_TASK_REPO=$(grep 'gh_task_repo:' "$config" | sed 's/gh_task_repo: *//' | tr -d ' ')
  fi
done

VAULT_PATH="${VAULT_PATH:-$HOME/brain}"
GH_TASK_REPO="${GH_TASK_REPO:-}"
