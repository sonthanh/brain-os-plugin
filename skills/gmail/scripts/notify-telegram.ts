#!/usr/bin/env tsx
/**
 * Telegram Notification Utility
 * Sends a message to a Telegram chat via Bot API.
 * Shared utility — can be used by any brain-os skill.
 *
 * Usage:
 *   tsx notify-telegram.ts <message>
 *   tsx notify-telegram.ts --file <path-to-message-file>
 *
 * Env: TELEGRAM_BOT_TOKEN must be set (or saved in ../.telegram-token)
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Chat ID is read from vault preferences or passed as CLI arg
function getChatId(): string {
  const arg = process.argv.find((a) => a.startsWith("--chat-id="));
  if (arg) return arg.split("=")[1];

  if (process.env.TELEGRAM_CHAT_ID) return process.env.TELEGRAM_CHAT_ID;

  console.error(
    "No chat ID. Pass --chat-id=<id> or set TELEGRAM_CHAT_ID env var.\n" +
    "Chat ID is stored in vault at context/about-me.md."
  );
  process.exit(1);
}

const CHAT_ID = getChatId();

function getToken(): string {
  if (process.env.TELEGRAM_BOT_TOKEN) {
    return process.env.TELEGRAM_BOT_TOKEN;
  }

  const tokenPath = resolve(__dirname, "../.telegram-token");
  if (existsSync(tokenPath)) {
    return readFileSync(tokenPath, "utf-8").trim();
  }

  // Check the shared claude channel config
  const channelPath = resolve(
    process.env.HOME || "~",
    ".claude/channels/telegram/.env"
  );
  if (existsSync(channelPath)) {
    const env = readFileSync(channelPath, "utf-8");
    const match = env.match(/TELEGRAM_BOT_TOKEN=(.+)/);
    if (match) return match[1].trim();
  }

  console.error(
    "No Telegram bot token found. Set TELEGRAM_BOT_TOKEN env var or save to .telegram-token"
  );
  process.exit(1);
}

async function sendMessage(text: string) {
  const token = getToken();
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`Telegram API error: ${res.status} ${err}`);
    process.exit(1);
  }

  console.log("Telegram notification sent.");
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === "--file" && args[1]) {
    const content = readFileSync(resolve(args[1]), "utf-8");
    await sendMessage(content);
  } else if (args.length > 0) {
    await sendMessage(args.join(" "));
  } else {
    console.error("Usage: tsx notify-telegram.ts <message>");
    console.error("       tsx notify-telegram.ts --file <path>");
    process.exit(1);
  }
}

main().catch(console.error);
