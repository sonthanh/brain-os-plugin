#!/usr/bin/env bash
# Watch a story drain — invoked periodically by launchd, persistent across all
# Claude session lifecycle. Reads status JSON, notifies via osascript on
# terminal phase, detects hang (hb not advancing), self-unloads launchd job
# on done/died.
#
# Usage: watch-story.sh <parent-N>
#
# Exit codes always 0 — launchd doesn't care, and we don't want exit-spam to
# be the failure signal. All signal is osascript + desktop file + watch log.

set -uo pipefail

PARENT="${1:?usage: watch-story.sh <parent-N>}"
STATE_DIR="$HOME/.local/state/impl-story"
STATUS="$STATE_DIR/$PARENT.status"
LAST_HB_FILE="$STATE_DIR/$PARENT.watch-lasthb"
WATCH_TRACE="$STATE_DIR/$PARENT.watch-trace.txt"
LABEL="com.brain-os.story-$PARENT-watch"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

notify() {
  osascript -e "display notification \"$1\" with title \"Story #$PARENT watcher\" sound name \"Glass\"" 2>/dev/null || true
}

append_desktop() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$WATCH_TRACE"
}

self_unload() {
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST" 2>/dev/null || true
  append_desktop "watcher self-unloaded"
}

if [ ! -f "$STATUS" ]; then
  notify "status file missing — orchestrator may be dead"
  append_desktop "STATUS_MISSING"
  exit 0
fi

PHASE=$(jq -r '.phase' "$STATUS" 2>/dev/null || echo "unparseable")
HB=$(jq -r '.hb' "$STATUS" 2>/dev/null || echo "0")
WATCHING=$(jq -r '.watching | length' "$STATUS" 2>/dev/null || echo "?")
CLOSED=$(jq -r '.closed | length' "$STATUS" 2>/dev/null || echo "?")
FAILED=$(jq -r '.failed | length' "$STATUS" 2>/dev/null || echo "?")
ERROR=$(jq -r '.error // ""' "$STATUS" 2>/dev/null || echo "")

append_desktop "phase=$PHASE hb=$HB watching=$WATCHING closed=$CLOSED failed=$FAILED"

LAST_HB=$(cat "$LAST_HB_FILE" 2>/dev/null || echo "")
echo "$HB" > "$LAST_HB_FILE"

case "$PHASE" in
  done)
    notify "COMPLETE — closed=$CLOSED failed=$FAILED"
    append_desktop "TERMINAL: done"
    self_unload
    ;;
  died)
    notify "CRASHED — ${ERROR:0:80}"
    append_desktop "TERMINAL: died — $ERROR"
    self_unload
    ;;
  polling)
    if [ -n "$LAST_HB" ] && [ "$LAST_HB" = "$HB" ]; then
      notify "HUNG? hb stuck at $HB — investigate"
      append_desktop "HANG_WARN: hb=$HB unchanged since last tick"
    fi
    ;;
  starting)
    if [ -n "$LAST_HB" ] && [ "$LAST_HB" = "$HB" ]; then
      notify "STUCK in starting phase — orchestrator may be wedged"
      append_desktop "STARTING_STUCK: hb=$HB unchanged"
    fi
    ;;
  unparseable)
    notify "status file unparseable — investigate"
    append_desktop "UNPARSEABLE"
    ;;
esac
