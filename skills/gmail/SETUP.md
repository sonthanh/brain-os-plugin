# Gmail Automation — Setup Guide

## 1. Google OAuth (one-time)

```bash
# From brain-os-plugin root
npm install

# Create Google Cloud OAuth credentials:
# 1. Go to https://console.cloud.google.com/apis/credentials
# 2. Create OAuth 2.0 Client ID (type: Desktop App)
# 3. Enable Gmail API at https://console.cloud.google.com/apis/library/gmail.googleapis.com
# 4. Download JSON → save as skills/gmail/client_secret.json

# Run setup
npm run gmail:setup
# Opens browser for Google login → saves .credentials.json
```

## 2. Telegram Bot (one-time)

```bash
# If not already configured:
# 1. Message @BotFather on Telegram → /newbot → get token
# 2. Save token:
echo "YOUR_BOT_TOKEN" > skills/gmail/.telegram-token
```

## 3. Bootstrap Email Rules (one-time)

```bash
npm run gmail:bootstrap -- /Users/thanhdo/work/brain
# Scans 3 months of inbox → creates business/intelligence/gmail-rules.md
# Review and edit the generated rules
```

## 4. Scheduled Remote Tasks

Set up via `claude.ai/code/scheduled` or `/schedule` in Claude Code.
Repo: your brain vault repo. Timezone: Europe/Zurich.

### Gmail Triage (9 runs/day)

| Time | Cron | Query |
|---|---|---|
| 6:00 AM | `0 6 * * *` | `newer_than:8h` + all unread |
| 8:00–22:00 every 2h | `0 8-22/2 * * *` | `newer_than:2h` + all unread |

**Prompt:** See `remote-triage-prompt.md` — copy the prompt section.
**Connectors:** Gmail only.
**Environment secrets:** Add `TELEGRAM_BOT_TOKEN` to the remote task environment — Telegram is sent via direct `curl` to Bot API, no connector needed.

### /today (daily)

| Time | Cron |
|---|---|
| 7:00 AM | `0 7 * * *` |

**Prompt:** `Run the /today morning review skill. Read brain-os.config.md for vault path. Push daily note to main. Send Telegram summary (read chat ID from context/about-me.md).`

### /close (daily)

| Time | Cron |
|---|---|
| 10:30 PM | `30 22 * * *` |

**Prompt:** `Run the /close end-of-day skill. Read brain-os.config.md for vault path. Push updates to main. Send Telegram summary (read chat ID from context/about-me.md).`

## 5. Test the Setup

```bash
# Test cleanup script with a triage report
npm run gmail:clean -- /Users/thanhdo/work/brain/daily/gmail-triage/test-report.md

# Test Telegram notification
tsx skills/gmail/scripts/notify-telegram.ts "Test from brain-os"
```
