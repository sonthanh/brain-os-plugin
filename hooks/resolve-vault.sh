#!/usr/bin/env bash
# Resolve vault path from brain-os.config.md
# Sources: ~/.brain-os/brain-os.config.md → ${CLAUDE_PLUGIN_ROOT}/brain-os.config.md
# Usage: source this file, then use $VAULT_PATH

for config in "$HOME/.brain-os/brain-os.config.md" "${CLAUDE_PLUGIN_ROOT:-}/brain-os.config.md"; do
  if [ -f "$config" ]; then
    VAULT_PATH=$(grep 'vault_path:' "$config" | sed 's/vault_path: *//' | tr -d ' ')
    break
  fi
done

VAULT_PATH="${VAULT_PATH:-$HOME/brain}"
