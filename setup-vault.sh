#!/usr/bin/env bash
# Brain OS — Vault Setup Script
#
# Creates the Obsidian vault structure expected by Brain OS skills,
# populates starter template files, and configures brain-os.config.md.
#
# Usage:
#   ./setup-vault.sh                    # Interactive — prompts for vault path
#   ./setup-vault.sh /path/to/vault     # Non-interactive — uses provided path
#   ./setup-vault.sh --dry-run          # Show what would be created, no writes

set -euo pipefail

DRY_RUN=false
VAULT_PATH=""

# --- Helpers ---

log() { echo "  $*"; }
logdim() { echo "  $(tput dim 2>/dev/null || true)$*$(tput sgr0 2>/dev/null || true)"; }
logsection() { echo ""; echo "$*"; }
logok() { echo "  ✓ $*"; }
logskip() { echo "  ~ $*  (already exists)"; }

mkd() {
  local dir="$1"
  if [ -d "$dir" ]; then
    logskip "$dir"
  elif [ "$DRY_RUN" = true ]; then
    logdim "[dry-run] mkdir $dir"
  else
    mkdir -p "$dir"
    logok "Created $dir"
  fi
}

write_file() {
  local path="$1"
  local content="$2"
  if [ -f "$path" ]; then
    logskip "$path"
  elif [ "$DRY_RUN" = true ]; then
    logdim "[dry-run] write $path"
  else
    mkdir -p "$(dirname "$path")"
    printf '%s' "$content" > "$path"
    logok "Created $path"
  fi
}

# --- Parse args ---

for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=true ;;
    --help|-h)
      echo "Brain OS — Vault Setup"
      echo ""
      echo "Usage:"
      echo "  ./setup-vault.sh                   Interactive setup"
      echo "  ./setup-vault.sh /path/to/vault    Non-interactive"
      echo "  ./setup-vault.sh --dry-run         Preview only"
      exit 0
      ;;
    -*) echo "Unknown option: $arg"; exit 1 ;;
    *) VAULT_PATH="$arg" ;;
  esac
done

# --- Get vault path ---

if [ -z "$VAULT_PATH" ]; then
  echo ""
  echo "Brain OS — Vault Setup"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "This script creates the folder structure and starter files"
  echo "that Brain OS skills expect in your Obsidian vault."
  echo ""
  printf "Enter your vault path [default: ~/obsidian-vault]: "
  read -r input_path
  if [ -z "$input_path" ]; then
    VAULT_PATH="$HOME/obsidian-vault"
  else
    # Expand ~ manually
    VAULT_PATH="${input_path/#\~/$HOME}"
  fi
fi

echo ""
echo "Vault path: $VAULT_PATH"
if [ "$DRY_RUN" = true ]; then
  echo "(dry-run mode — no files will be written)"
fi
echo ""

# Confirm if vault doesn't exist yet
if [ ! -d "$VAULT_PATH" ] && [ "$DRY_RUN" = false ]; then
  printf "Vault directory does not exist. Create it? [Y/n] "
  read -r confirm
  if [[ "$confirm" =~ ^[Nn] ]]; then
    echo "Aborted."
    exit 0
  fi
fi

TODAY=$(date +%Y-%m-%d)

# ─── 1. Directories ───────────────────────────────────────────────────────────

logsection "Creating directories..."

mkd "$VAULT_PATH/context"
mkd "$VAULT_PATH/business/tasks/archive"
mkd "$VAULT_PATH/business/projects"
mkd "$VAULT_PATH/business/intelligence/meetings"
mkd "$VAULT_PATH/business/intelligence/decisions"
mkd "$VAULT_PATH/business/intelligence/research"
mkd "$VAULT_PATH/business/departments"
mkd "$VAULT_PATH/business/skills"
mkd "$VAULT_PATH/personal/inbox"
mkd "$VAULT_PATH/personal/people"
mkd "$VAULT_PATH/personal/projects"
mkd "$VAULT_PATH/personal/research"
mkd "$VAULT_PATH/personal/resources"
mkd "$VAULT_PATH/thinking/ideas"
mkd "$VAULT_PATH/thinking/patterns"
mkd "$VAULT_PATH/thinking/reflections"
mkd "$VAULT_PATH/thinking/connections"
mkd "$VAULT_PATH/thinking/traces"
mkd "$VAULT_PATH/thinking/agent-output"
mkd "$VAULT_PATH/knowledge/raw"
mkd "$VAULT_PATH/knowledge/books"
mkd "$VAULT_PATH/knowledge/articles"
mkd "$VAULT_PATH/knowledge/podcasts"
mkd "$VAULT_PATH/knowledge/courses"
mkd "$VAULT_PATH/knowledge/research/reports"
mkd "$VAULT_PATH/knowledge/research/findings"
mkd "$VAULT_PATH/daily"
mkd "$VAULT_PATH/private"
mkd "$VAULT_PATH/commands"

# ─── 2. Context files ─────────────────────────────────────────────────────────

logsection "Creating context files..."

write_file "$VAULT_PATH/context/about-me.md" "---
title: About Me
created: $TODAY
updated: $TODAY
tags: [context, core]
zone: context
---

# About Me

## As a Person
- **Name**: [Your name]
- **Location**: [Your city / country]
- **Timezone**: [e.g. America/New_York]
- **Languages**: [Your languages]
- **Telegram chat ID**: [Your Telegram chat ID — find it via @userinfobot]

## As a Professional
- **Role**: [Your title / role]
- **Focus**: [What you work on]
- **Company / Project**: [Name of your company or main project]

## As a Thinker
- **Interests**: [Topics you care about]
- **Thinking style**: [How you process ideas — visual, structured, free-form...]
- **Values**: [Core values that drive your decisions]

## Current State
- [What you're building or working on right now]
- [A goal you're pursuing]

## Tools I Use
- Claude Code
- Obsidian (this vault)
- [Other tools]
"

write_file "$VAULT_PATH/context/business.md" "---
title: Business
created: $TODAY
updated: $TODAY
tags: [context, business]
zone: context
---

# Business

## What We Do
[One sentence: what your business does and who it's for]

## Mission
[Why this business exists]

## Products / Services
- [Product or service 1]
- [Product or service 2]

## Business Model
[How you make money]

## Stage
[e.g. Pre-revenue, Early traction, Growing, Scaling]

## Key Metrics
- [Metric 1]
- [Metric 2]
"

write_file "$VAULT_PATH/context/goals.md" "---
title: Goals
created: $TODAY
updated: $TODAY
tags: [context, goals]
zone: context
---

# Goals

## This Year
- [ ] [Goal 1]
- [ ] [Goal 2]
- [ ] [Goal 3]

## This Quarter
- [ ] [Goal 1]
- [ ] [Goal 2]

## This Month
- [ ] [Goal 1]

## Personal Goals
- [ ] [Goal 1]
"

write_file "$VAULT_PATH/context/icp.md" "---
title: Ideal Customer Profile
created: $TODAY
updated: $TODAY
tags: [context, icp]
zone: context
---

# Ideal Customer Profile

## Who They Are
- **Demographics**: [Age, role, location, etc.]
- **Industry**: [What industry they're in]
- **Company size**: [Solo, startup, SMB, enterprise]

## Their Pain Points
1. [Pain point 1]
2. [Pain point 2]
3. [Pain point 3]

## What They Want
- [Desired outcome 1]
- [Desired outcome 2]

## How They Find Us
- [Channel 1]
- [Channel 2]

## What Makes Them Buy
- [Trigger 1]
- [Trigger 2]
"

write_file "$VAULT_PATH/context/brand.md" "---
title: Brand Voice
created: $TODAY
updated: $TODAY
tags: [context, brand]
zone: context
---

# Brand Voice

## Positioning
[One line: what you stand for and how you're different]

## Tone
- [Adjective 1 — e.g. Direct]
- [Adjective 2 — e.g. Practical]
- [Adjective 3 — e.g. Honest]

## We Sound Like...
[2-3 sentences describing the voice. E.g. 'A smart friend who has done it before. No jargon, no fluff. We tell people what to do, not just what to think.']

## We Do NOT Sound Like...
- [Thing to avoid — e.g. Corporate speak]
- [Thing to avoid — e.g. Overly formal]

## Content Pillars
1. [Pillar 1]
2. [Pillar 2]
3. [Pillar 3]
"

write_file "$VAULT_PATH/context/strategy.md" "---
title: Strategy
created: $TODAY
updated: $TODAY
tags: [context, strategy]
zone: context
---

# Strategy

## Where We're Going
[1-year vision — what does success look like?]

## The Bet
[The core strategic bet — what do you believe that others don't?]

## Priorities This Quarter
1. [Priority 1]
2. [Priority 2]
3. [Priority 3]

## What We're NOT Doing
- [Thing we're saying no to]
- [Distraction we're avoiding]

## Key Decisions Made
- [$TODAY] [Decision and why]
"

write_file "$VAULT_PATH/context/preferences.md" "---
title: Preferences
created: $TODAY
updated: $TODAY
tags: [context, preferences]
zone: context
---

# Preferences

## Communication Style
- **Language**: [Preferred language for content output]
- **Tone**: [Casual / Professional / Direct / etc.]
- **Length**: [Short and punchy / Detailed / depends on context]

## Writing Rules
- [Rule 1 — e.g. No bullet points for social posts, use short paragraphs]
- [Rule 2 — e.g. Always give concrete examples, not abstract advice]
- [Rule 3 — e.g. End with a clear takeaway or call to action]

## How I Like to Work
- [Preference 1 — e.g. Give me options, don't pick for me]
- [Preference 2 — e.g. Show your reasoning briefly]

## Response Format
- [Format preference — e.g. Be concise, I'll ask follow-up questions]
"

write_file "$VAULT_PATH/context/team-overview.md" "---
title: Team Overview
created: $TODAY
updated: $TODAY
tags: [context, team]
zone: context
---

# Team Overview

## Team Members
| Name | Role | Responsibilities |
|------|------|-----------------|
| [Name] | [Role] | [What they own] |

## How We Work
- [Working agreement 1]
- [Working agreement 2]

## Communication
- [Primary channel — e.g. Slack]
- [Meeting cadence — e.g. Weekly sync on Mondays]
"

# ─── 3. Business files ────────────────────────────────────────────────────────

logsection "Creating business files..."

# Tasks now live as GitHub issues — no inbox.md scaffolding needed.
# See README "GitHub tasks setup" for the gh_task_repo config + label bootstrap.

# ─── 4. Personal files ────────────────────────────────────────────────────────

logsection "Creating personal files..."

write_file "$VAULT_PATH/personal/inbox/quick-capture.md" "---
title: Quick Capture
created: $TODAY
updated: $TODAY
tags: [inbox, capture]
zone: personal
---

# Quick Capture

> Drop quick thoughts, links, and ideas here. Review weekly and move to proper locations.

## Captures
- [Add quick thoughts here]
"

# ─── 5. Knowledge files ───────────────────────────────────────────────────────

logsection "Creating knowledge files..."

write_file "$VAULT_PATH/knowledge/books/_index.md" "---
title: Books Index
created: $TODAY
updated: $TODAY
tags: [knowledge, books]
---

# Books

## Reading Now
- [Book title] — [Author]

## To Read
- [Book title] — [Author]

## Completed
| Book | Author | Ingested | Absorbed |
|------|--------|----------|----------|
| [Title] | [Author] | [ ] | [ ] |
"

# ─── 6. Daily note for today ─────────────────────────────────────────────────

logsection "Creating today's daily note..."

write_file "$VAULT_PATH/daily/${TODAY}.md" "---
date: $TODAY
tags: [daily]
---

# $TODAY

## Focus
- [ ] Priority 1
- [ ] Priority 2
- [ ] Priority 3

## Log
> What happened today across sessions and activities

## Decisions
> Key decisions made today

## Reflections
> Personal thoughts and observations

## Remember
> Things to save to the vault (rules, corrections, insights)
"

# ─── 7. Git configuration ────────────────────────────────────────────────────

logsection "Creating git config files..."

write_file "$VAULT_PATH/.gitignore" "# Private zone — NEVER commit
private/

# OS files
.DS_Store
Thumbs.db

# Obsidian workspace (optional — remove this line to track workspace state)
.obsidian/workspace.json
.obsidian/workspace-mobile.json
"

# ─── 8. Vault CLAUDE.md ──────────────────────────────────────────────────────

logsection "Creating vault CLAUDE.md..."

write_file "$VAULT_PATH/CLAUDE.md" "# Brain — Second Brain Operating System

You are an AI agent with access to my second brain — a unified Obsidian vault that contains everything about me, my business, my thinking, and my life.

## Vault Overview

| Zone | Path | Purpose |
|------|------|---------|
| **Context** | \`context/\` | Shared knowledge — who I am, my business, ICP, brand, goals |
| **Business OS** | \`business/\` | Business operations — departments, projects, tasks, intelligence |
| **Personal OS** | \`personal/\` | Personal productivity — research, people, resources, inbox |
| **Thinking Lab** | \`thinking/\` | Deep reflection — ideas, patterns, connections, traces |
| **Knowledge** | \`knowledge/\` | Ingested knowledge — books, articles, podcasts, courses |
| **Daily** | \`daily/\` | Daily notes — logs, reflections, decisions |
| **Private** | \`private/\` | Private, confidential, sensitive information (NEVER pushed to git) |

## Where to Find What

| I ask about... | Look in... |
|----------------|-----------|
| Who I am, my background, values | \`context/about-me.md\` |
| My business, what we do | \`context/business.md\` |
| Strategy, priorities | \`context/strategy.md\` |
| Target customer | \`context/icp.md\` |
| Brand voice, positioning | \`context/brand.md\` |
| Writing style, communication | \`context/preferences.md\` |
| Goals (personal + business) | \`context/goals.md\` |
| What happened today/recently | \`daily/\` (latest files) |
| Business projects | \`business/projects/\` |
| Tasks and to-dos | GitHub issues at your \`gh_task_repo\` (see brain-os.config.md) |
| Book notes | \`knowledge/books/\` |
| Raw knowledge input | \`knowledge/raw/\` |
| Ideas | \`thinking/ideas/\` |
| Personal research | \`personal/research/\` |
| Quick captures | \`personal/inbox/quick-capture.md\` |
| Private, confidential info | \`private/\` |

## Writing Rules

- All files use **Obsidian-compatible Markdown** with YAML frontmatter
- Use \`[[wiki-links]]\` to connect related files
- Use tags: \`#idea\`, \`#decision\`, \`#pattern\`, \`#action\`, \`#reflection\`
- Date format: \`YYYY-MM-DD\`

## Task Management

Tasks live as **GitHub issues** in a repo you own (configure \`gh_task_repo\` in \`brain-os.config.md\`).

**Status labels:** \`status:ready\`, \`status:in-progress\`, \`status:blocked\`, \`status:backlog\` (closed issue = done)
**Other labels:** \`priority:p1..p4\`, \`weight:heavy|quick\`, \`owner:human|bot\`, \`type:handover|plan\`
**Session-claim (multi-session concurrency):** dynamic \`claim:session-*\` label
**Commands:** \`/status\` (briefing) · \`/pickup\` (resume) · \`/handover\` (end session)

## Zone Rules

- **context/** — Update when information changes. Preserve existing content; append or update, never overwrite.
- **thinking/agent-output/** — Claude writes analysis and generated insights here. Prefix filename with date: \`YYYY-MM-DD-topic.md\`
- **private/** — CONFIDENTIAL. Always ask for explicit permission before reading or writing. Never pushed to git.

## Core Principle: Vault as Single Source of Truth

Skills, agents, and commands reference files in this vault — they never embed or copy the knowledge directly.
"

# ─── 9. Update brain-os.config.md ────────────────────────────────────────────

CONFIG_FILE="$HOME/.brain-os/brain-os.config.md"
if [ ! -f "$CONFIG_FILE" ]; then
  CONFIG_FILE="$(dirname "$0")/brain-os.config.md"
fi

logsection "Configuring Brain OS..."

if [ "$DRY_RUN" = false ] && [ -f "$CONFIG_FILE" ]; then
  # Replace the vault_path line
  sed -i.bak "s|vault_path:.*|vault_path: $VAULT_PATH|" "$CONFIG_FILE"
  rm -f "${CONFIG_FILE}.bak"
  logok "Updated vault_path in $CONFIG_FILE"
else
  logdim "[dry-run] Would update vault_path in $CONFIG_FILE → $VAULT_PATH"
fi

# GH task repo — prompt user to set it and bootstrap labels
GH_REPO=$(grep 'gh_task_repo:' "$CONFIG_FILE" 2>/dev/null | sed 's/gh_task_repo: *//' | tr -d ' ')
if [ -z "$GH_REPO" ] || [ "$GH_REPO" = "your-username/your-task-repo" ]; then
  echo ""
  echo "📝 GitHub tasks setup (optional but recommended):"
  echo "   Tasks live as GitHub issues. Edit $CONFIG_FILE:"
  echo "     gh_task_repo: your-username/your-repo"
  echo "   Then bootstrap labels:"
  echo "     gh label create status:ready --color 0E8A16 -R your-username/your-repo"
  echo "     (plus status:{in-progress,blocked,backlog}, priority:p{1-4},"
  echo "      weight:{heavy,quick}, owner:{human,bot}, type:{handover,plan})"
  echo "   See README.md 'GitHub tasks setup' for the full list."
fi

# ─── Done ────────────────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Vault setup complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo " Next steps:"
echo ""
echo " 1. Open the vault in Obsidian:"
echo "    File → Open vault → $VAULT_PATH"
echo ""
echo " 2. Install the Obsidian Kanban plugin:"
echo "    Settings → Community plugins → search 'Kanban'"
echo ""
echo " 3. Fill in your context files:"
echo "    context/about-me.md  — who you are"
echo "    context/business.md  — your business"
echo "    context/goals.md     — your goals"
echo ""
echo " 4. Try your first Brain OS skill:"
echo "    /status  — morning briefing"
echo "    /think   — explore an idea"
echo "    /research <topic>  — research anything"
echo ""
echo " 5. Read GETTING-STARTED.md for use cases and tips."
echo ""
