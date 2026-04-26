#!/usr/bin/env bash
# Brain OS — One-line installer
#
# Install everything (plugin + vault):
#   curl -sSL https://raw.githubusercontent.com/sonthanh/brain-os-plugin/main/install.sh | bash
#
# Plugin only (skip vault setup):
#   curl -sSL .../install.sh | bash -s -- --plugin-only
#
# Use existing vault:
#   curl -sSL .../install.sh | bash -s -- --vault ~/my-vault
#
# Local install (from within the repo):
#   ./install.sh
#   ./install.sh --vault ~/my-vault
#   ./install.sh --plugin-only
#
# Uninstall:
#   ./install.sh --uninstall

set -euo pipefail

REPO="https://github.com/sonthanh/brain-os-plugin.git"
TARGET_DIR="$HOME/.claude/skills"
CLONE_DIR="$HOME/.brain-os"
DEFAULT_VAULT="$HOME/brain"

PLUGIN_ONLY=false
VAULT_PATH=""
UNINSTALL=false
FORCE=false

ALL_SKILLS=(
  absorb aha audit verify eval gmail gmail-bootstrap handover impl ingest
  journal pickup reorg research self-learn status study tdd think to-issues triggers
)

# --- Parse args ---

SELECTED_SKILLS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --plugin-only) PLUGIN_ONLY=true; shift ;;
    --vault) VAULT_PATH="${2:-}"; [ -n "$VAULT_PATH" ] && shift 2 || { echo "Error: --vault requires a path"; exit 1; } ;;
    --uninstall|-u) UNINSTALL=true; shift ;;
    --force|-f) FORCE=true; shift ;;
    --list|-l)
      echo "Available skills: ${ALL_SKILLS[*]}"
      exit 0
      ;;
    --help|-h)
      echo "Brain OS Installer"
      echo ""
      echo "Usage:"
      echo "  install.sh                        Install plugin + create vault at ~/brain"
      echo "  install.sh --vault PATH           Install plugin + use existing vault"
      echo "  install.sh --plugin-only          Install plugin only (skip vault)"
      echo "  install.sh --uninstall            Remove all Brain OS skills"
      echo "  install.sh --force                Replace real directories with symlinks"
      echo "  install.sh skill1 skill2          Install only selected skills"
      exit 0
      ;;
    -*) echo "Unknown option: $1"; exit 1 ;;
    *) SELECTED_SKILLS+=("$1"); shift ;;
  esac
done

# --- Determine source directory ---

# If running from within the repo (local), use the repo directory
# If running via curl (remote), clone/update to ~/.brain-os
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd 2>/dev/null || echo "")"

if [ -n "$SCRIPT_DIR" ] && [ -d "$SCRIPT_DIR/skills" ]; then
  SOURCE_DIR="$SCRIPT_DIR"
else
  # Remote install — clone or update
  if [ -d "$CLONE_DIR" ]; then
    echo "Updating brain-os..."
    cd "$CLONE_DIR" && git pull --quiet
    cd - > /dev/null
  else
    echo "Downloading brain-os..."
    git clone --quiet "$REPO" "$CLONE_DIR"
  fi
  SOURCE_DIR="$CLONE_DIR"
fi

SKILLS_DIR="$SOURCE_DIR/skills"

# --- Functions ---

install_skills() {
  local skills=("$@")
  mkdir -p "$TARGET_DIR"
  local installed=0

  for skill in "${skills[@]}"; do
    if [ ! -d "$SKILLS_DIR/$skill" ]; then
      echo "  ? $skill not found, skipping"
      continue
    fi

    if [ -L "$TARGET_DIR/$skill" ]; then
      rm "$TARGET_DIR/$skill"
    elif [ -d "$TARGET_DIR/$skill" ]; then
      if [ "$FORCE" = true ]; then
        rm -r "$TARGET_DIR/$skill"
      else
        echo "  ! $skill exists as directory, skipping (use --force to replace)"
        continue
      fi
    fi

    ln -s "$SKILLS_DIR/$skill" "$TARGET_DIR/$skill"
    installed=$((installed + 1))
  done

  echo "  $installed skill(s) installed"
}

uninstall_skills() {
  local removed=0
  for skill in "${ALL_SKILLS[@]}"; do
    if [ -L "$TARGET_DIR/$skill" ]; then
      local target
      target=$(readlink "$TARGET_DIR/$skill")
      if echo "$target" | grep -q "brain-os"; then
        rm "$TARGET_DIR/$skill"
        removed=$((removed + 1))
      fi
    fi
  done
  echo "Removed $removed skill(s)."
}

setup_vault() {
  local vault="$1"

  if [ -f "$SOURCE_DIR/setup-vault.sh" ]; then
    bash "$SOURCE_DIR/setup-vault.sh" "$vault"
  else
    echo "  ! setup-vault.sh not found, creating minimal structure"
    mkdir -p "$vault"/{context,business/tasks,personal/inbox,thinking,knowledge/{raw,books,research/reports,research/findings},daily,private}
  fi
}

update_config() {
  local vault="$1"

  # Try ~/.brain-os config first, then source dir
  local config=""
  for candidate in "$CLONE_DIR/brain-os.config.md" "$SOURCE_DIR/brain-os.config.md"; do
    if [ -f "$candidate" ]; then
      config="$candidate"
      break
    fi
  done

  if [ -n "$config" ]; then
    sed -i.bak "s|vault_path:.*|vault_path: $vault|" "$config"
    rm -f "${config}.bak"
  fi
}

# --- Main ---

if [ "$UNINSTALL" = true ]; then
  echo "Uninstalling brain-os..."
  uninstall_skills
  exit 0
fi

echo ""
echo "Brain OS — Installing..."
echo ""

# Step 1: Install skills
if [ ${#SELECTED_SKILLS[@]} -gt 0 ]; then
  echo "Installing selected skills..."
  install_skills "${SELECTED_SKILLS[@]}"
else
  echo "Installing all ${#ALL_SKILLS[@]} skills..."
  install_skills "${ALL_SKILLS[@]}"
fi

# Step 2: Setup vault (unless --plugin-only)
if [ "$PLUGIN_ONLY" = false ]; then
  if [ -z "$VAULT_PATH" ]; then
    VAULT_PATH="$DEFAULT_VAULT"
  fi
  # Expand ~
  VAULT_PATH="${VAULT_PATH/#\~/$HOME}"

  echo ""
  setup_vault "$VAULT_PATH"
  update_config "$VAULT_PATH"
fi

# --- Verification ---

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check plugin
skill_count=0
for skill in "${ALL_SKILLS[@]}"; do
  if [ -L "$TARGET_DIR/$skill" ]; then
    skill_count=$((skill_count + 1))
  fi
done

if [ "$skill_count" -gt 0 ]; then
  echo "  ✓ Brain OS installed ($skill_count skills)"
else
  echo "  ✗ Plugin installation failed"
fi

# Check vault
if [ "$PLUGIN_ONLY" = false ]; then
  if [ -d "$VAULT_PATH/context" ]; then
    echo "  ✓ Vault created at $VAULT_PATH"
  else
    echo "  ✗ Vault setup failed"
  fi

  if [ -f "$VAULT_PATH/context/about-me.md" ]; then
    echo "  ✓ Context files ready"
  else
    echo "  ✗ Context files missing"
  fi

  local_config=""
  for candidate in "$CLONE_DIR/brain-os.config.md" "$SOURCE_DIR/brain-os.config.md"; do
    if [ -f "$candidate" ] && grep -q "$VAULT_PATH" "$candidate" 2>/dev/null; then
      local_config="found"
      break
    fi
  done

  if [ -n "$local_config" ]; then
    echo "  ✓ Config set"
  else
    echo "  ~ Config: update vault_path in brain-os.config.md"
  fi
fi

echo ""
echo "Ready! Try your first command:"
echo ""
echo "  /think What should I focus on this week?"
echo ""

if [ "$PLUGIN_ONLY" = false ]; then
  echo "Next: open $VAULT_PATH in Obsidian and fill in context/about-me.md"
  echo "Full guide: https://github.com/sonthanh/brain-os-plugin/blob/main/GETTING-STARTED.md"
  echo ""
fi
