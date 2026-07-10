#!/usr/bin/env bash
# pre-push-ci-gate.sh — run the exact checks CI enforces before any push
# leaves this machine. Untested pushes to main were the root cause of every
# code-class CI failure on this repo (e.g. run 26893809218). Installed by
# scripts/install-hooks.sh. Bypass (emergencies only): git push --no-verify
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

echo "pre-push gate: shellcheck + tsc + bun test (same checks as CI)"
shellcheck install.sh
bunx tsc --noEmit
bun test

echo "pre-push gate: green — pushing"
