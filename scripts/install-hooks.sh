#!/usr/bin/env bash
# install-hooks.sh — install brain-os-plugin git hooks for this checkout.
# Run once after cloning. Safe to re-run (uses symlinks).

set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

install_hook() {
  local hook_name="$1"
  local script_path="$2"
  local link="$REPO_ROOT/.git/hooks/$hook_name"
  ln -sf "../../$script_path" "$link"
  echo "  ✓ $hook_name → $script_path"
}

echo "Installing git hooks..."
install_hook "pre-commit" "hooks/pre-commit-eval-gap.sh"

echo ""
echo "Done. To bypass the pre-commit check (only for cosmetic changes):"
echo "  git commit --no-verify"
