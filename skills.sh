#!/usr/bin/env bash
# Brain OS — One-line skill installer
#
# Install all skills:
#   curl -sSL https://raw.githubusercontent.com/sonthanh/brain-os-plugin/main/skills.sh | bash
#
# Install specific skills:
#   curl -sSL https://raw.githubusercontent.com/sonthanh/brain-os-plugin/main/skills.sh | bash -s self-learn verify today
#
# Uninstall:
#   curl -sSL https://raw.githubusercontent.com/sonthanh/brain-os-plugin/main/skills.sh | bash -s --uninstall

set -euo pipefail

REPO="https://github.com/sonthanh/brain-os-plugin.git"
INSTALL_DIR="$HOME/.claude/skills"
CLONE_DIR="$HOME/.brain-os"

ALL_SKILLS=(
  absorb aha audit verify eval gmail gmail-bootstrap grill handover impl improve ingest
  journal pickup reorg research self-learn status study tdd think to-issues triggers
)

clone_or_update() {
  if [ -d "$CLONE_DIR" ]; then
    echo "Updating brain-os..."
    cd "$CLONE_DIR" && git pull --quiet
  else
    echo "Downloading brain-os..."
    git clone --quiet "$REPO" "$CLONE_DIR"
  fi
}

install_skills() {
  local skills=("$@")
  mkdir -p "$INSTALL_DIR"
  local installed=0

  for skill in "${skills[@]}"; do
    if [ ! -d "$CLONE_DIR/skills/$skill" ]; then
      echo "  ? $skill not found, skipping"
      continue
    fi

    if [ -L "$INSTALL_DIR/$skill" ]; then
      rm "$INSTALL_DIR/$skill"
    elif [ -d "$INSTALL_DIR/$skill" ]; then
      echo "  ! $skill exists as directory, skipping (remove manually: rm -r $INSTALL_DIR/$skill)"
      continue
    fi

    ln -s "$CLONE_DIR/skills/$skill" "$INSTALL_DIR/$skill"
    echo "  + $skill"
    installed=$((installed + 1))
  done

  echo ""
  echo "Installed $installed skill(s) to $INSTALL_DIR/"
}

uninstall_skills() {
  local removed=0
  for skill in "${ALL_SKILLS[@]}"; do
    if [ -L "$INSTALL_DIR/$skill" ] && readlink "$INSTALL_DIR/$skill" | grep -q ".brain-os"; then
      rm "$INSTALL_DIR/$skill"
      echo "  - $skill"
      removed=$((removed + 1))
    fi
  done
  echo ""
  echo "Removed $removed skill(s)."
}

# --- Main ---

if [ "${1:-}" = "--uninstall" ] || [ "${1:-}" = "-u" ]; then
  echo "Uninstalling brain-os skills..."
  uninstall_skills
  exit 0
fi

if [ "${1:-}" = "--list" ] || [ "${1:-}" = "-l" ]; then
  echo "Available skills: ${ALL_SKILLS[*]}"
  exit 0
fi

clone_or_update

if [ $# -eq 0 ]; then
  echo "Installing all ${#ALL_SKILLS[@]} skills..."
  install_skills "${ALL_SKILLS[@]}"
else
  echo "Installing selected skills..."
  install_skills "$@"
fi

echo ""
echo "Edit $CLONE_DIR/brain-os.config.md to set your vault path."
echo "Update anytime: cd $CLONE_DIR && git pull"
