#!/usr/bin/env bash
# SessionStart entry point — show open tasks (GH issues) + vault index.
# Thin caller: orchestration only. Render logic lives in leaf scripts so
# render-only tweaks ship as leaf changes, not trunk-gate hits.
#
# Path-narrowed via issue #174 — extracted render code into
# scripts/render-tasks-panel.sh + scripts/render-vault-index.sh.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/resolve-vault.sh"

# Invalidate /status cache so the next /status briefing reflects any GH
# mutations from cron / external sessions that the touch-status-dirty hook
# couldn't catch (e.g. GH eventual-consistency window where the dirty marker
# was cleared by a regen running while the close hadn't propagated yet).
touch "${HOME}/.cache/brain-os/status.dirty" 2>/dev/null || true

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

bash "$PLUGIN_ROOT/scripts/render-tasks-panel.sh"
bash "$PLUGIN_ROOT/scripts/render-vault-index.sh"
