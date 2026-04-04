#!/usr/bin/env bash
# Brain OS — Individual Skill Installer
#
# Usage:
#   ./install.sh                    # Install ALL skills (symlinks to ~/.claude/skills/)
#   ./install.sh self-learn audit   # Install only selected skills
#   ./install.sh --list             # List available skills
#   ./install.sh --uninstall        # Remove all brain-os symlinks from ~/.claude/skills/
#   ./install.sh --force             # Replace real directories with symlinks
#
# Full plugin mode (alternative):
#   cc --plugin-dir ~/work/brain-os-plugin

set -euo pipefail

FORCE=false

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS_DIR="$PLUGIN_DIR/skills"
TARGET_DIR="$HOME/.claude/skills"

# All available skills
ALL_SKILLS=(
  absorb audit book chain challenge close connect context
  drift emerge ghost graduate handover ideas-gen ingest
  personal pickup self-learn sync think today trace work
  writing-skills
)

list_skills() {
  echo "Available Brain OS skills (${#ALL_SKILLS[@]}):"
  echo ""
  for skill in "${ALL_SKILLS[@]}"; do
    local desc
    desc=$(grep '^description:' "$SKILLS_DIR/$skill/SKILL.md" 2>/dev/null | head -1 | sed 's/description: *"\{0,1\}//' | sed 's/"\{0,1\}$//')
    local status="  "
    if [ -L "$TARGET_DIR/$skill" ] && [ "$(readlink "$TARGET_DIR/$skill")" = "$SKILLS_DIR/$skill" ]; then
      status="*"
    fi
    printf "  %s %-20s %s\n" "$status" "$skill" "$desc"
  done
  echo ""
  echo "  * = installed via brain-os"
}

install_skills() {
  local skills=("$@")
  mkdir -p "$TARGET_DIR"

  for skill in "${skills[@]}"; do
    if [ ! -d "$SKILLS_DIR/$skill" ]; then
      echo "WARNING: Skill '$skill' not found in brain-os, skipping"
      continue
    fi

    # Remove existing symlink, or warn about real directories
    if [ -L "$TARGET_DIR/$skill" ]; then
      echo "  Replacing existing symlink: $skill"
      rm "$TARGET_DIR/$skill"
    elif [ -d "$TARGET_DIR/$skill" ]; then
      if [ "$FORCE" = true ]; then
        echo "  Replacing real directory: $skill"
        rm -r "$TARGET_DIR/$skill"
      else
        echo "  WARNING: $TARGET_DIR/$skill is a real directory, not a symlink. Skipping."
        echo "  Use --force to replace, or remove manually: rm -r $TARGET_DIR/$skill"
        continue
      fi
    fi

    ln -s "$SKILLS_DIR/$skill" "$TARGET_DIR/$skill"
    echo "  Installed: $skill -> $SKILLS_DIR/$skill"
  done
}

uninstall_skills() {
  local count=0
  for skill in "${ALL_SKILLS[@]}"; do
    if [ -L "$TARGET_DIR/$skill" ] && [ "$(readlink "$TARGET_DIR/$skill")" = "$SKILLS_DIR/$skill" ]; then
      rm "$TARGET_DIR/$skill"
      echo "  Removed: $skill"
      ((count++))
    fi
  done
  echo ""
  echo "Uninstalled $count brain-os skill(s)."
}

# --- Main ---

# Parse --force flag from anywhere in args
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=true ;;
    *) ARGS+=("$arg") ;;
  esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

if [ $# -eq 0 ]; then
  echo "Installing ALL ${#ALL_SKILLS[@]} Brain OS skills..."
  echo ""
  install_skills "${ALL_SKILLS[@]}"
  echo ""
  echo "Done. All skills symlinked to $TARGET_DIR/"
  echo "To use full plugin mode instead: cc --plugin-dir $PLUGIN_DIR"
  exit 0
fi

case "$1" in
  --list|-l)
    list_skills
    ;;
  --uninstall|-u)
    echo "Uninstalling Brain OS skills..."
    uninstall_skills
    ;;
  --help|-h)
    echo "Brain OS — Individual Skill Installer"
    echo ""
    echo "Usage:"
    echo "  ./install.sh                    Install ALL skills"
    echo "  ./install.sh self-learn audit   Install selected skills"
    echo "  ./install.sh --list             List available skills"
    echo "  ./install.sh --uninstall        Remove all brain-os symlinks"
    echo "  ./install.sh --force            Replace real directories with symlinks"
    echo ""
    echo "Full plugin mode: cc --plugin-dir $PLUGIN_DIR"
    ;;
  *)
    echo "Installing selected Brain OS skills: $*"
    echo ""
    install_skills "$@"
    echo ""
    echo "Done."
    ;;
esac
