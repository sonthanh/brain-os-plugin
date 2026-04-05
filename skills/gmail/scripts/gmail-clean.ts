#!/usr/bin/env tsx
/**
 * Gmail Cleanup Script
 * Reads a triage report from vault, executes actions via Gmail API.
 * Checks message state before acting — safe to run even if you've already handled emails manually.
 *
 * Usage: tsx gmail-clean.ts <path-to-triage-report>
 */

import { google } from "googleapis";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CREDENTIALS_PATH = resolve(__dirname, "../.credentials.json");

interface Action {
  done: boolean;
  type: string;
  msgId: string;
  context: string;
  raw: string;
}

function loadCredentials() {
  if (!existsSync(CREDENTIALS_PATH)) {
    console.error(
      "No credentials found. Run: tsx skills/gmail/scripts/setup-oauth.ts"
    );
    process.exit(1);
  }
  return JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
}

function getGmailClient() {
  const creds = loadCredentials();
  const auth = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    "http://localhost:3000/callback"
  );
  auth.setCredentials({
    refresh_token: creds.refresh_token,
    access_token: creds.access_token,
  });
  return google.gmail({ version: "v1", auth });
}

function parseReport(filePath: string): Action[] {
  const content = readFileSync(filePath, "utf-8");
  const actions: Action[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const match = line.match(
      /^- \[([ x])\] ([\w:-]+) \| (\S+) \| (.+)$/
    );
    if (match) {
      actions.push({
        done: match[1] === "x",
        type: match[2],
        msgId: match[3],
        context: match[4],
        raw: line,
      });
    }
  }
  return actions;
}

async function messageExists(
  gmail: ReturnType<typeof google.gmail>,
  msgId: string
): Promise<boolean> {
  try {
    const msg = await gmail.users.messages.get({
      userId: "me",
      id: msgId,
      format: "metadata",
      metadataHeaders: ["Subject"],
    });
    return !!msg.data.id;
  } catch {
    return false;
  }
}

async function isInInbox(
  gmail: ReturnType<typeof google.gmail>,
  msgId: string
): Promise<boolean> {
  try {
    const msg = await gmail.users.messages.get({
      userId: "me",
      id: msgId,
      format: "metadata",
    });
    return msg.data.labelIds?.includes("INBOX") ?? false;
  } catch {
    return false;
  }
}

async function executeAction(
  gmail: ReturnType<typeof google.gmail>,
  action: Action
): Promise<{ success: boolean; skipped: boolean; reason?: string }> {
  // Check if message still exists
  if (!(await messageExists(gmail, action.msgId))) {
    return { success: false, skipped: true, reason: "message not found" };
  }

  const type = action.type;

  if (type === "archive") {
    if (!(await isInInbox(gmail, action.msgId))) {
      return { success: false, skipped: true, reason: "already archived" };
    }
    await gmail.users.messages.modify({
      userId: "me",
      id: action.msgId,
      requestBody: { removeLabelIds: ["INBOX"] },
    });
    return { success: true, skipped: false };
  }

  if (type === "delete") {
    await gmail.users.messages.trash({
      userId: "me",
      id: action.msgId,
    });
    return { success: true, skipped: false };
  }

  if (type.startsWith("label:")) {
    const labelName = type.slice(6);
    // Find or create label
    const labels = await gmail.users.labels.list({ userId: "me" });
    let label = labels.data.labels?.find((l) => l.name === labelName);
    if (!label) {
      const created = await gmail.users.labels.create({
        userId: "me",
        requestBody: { name: labelName },
      });
      label = created.data;
    }
    await gmail.users.messages.modify({
      userId: "me",
      id: action.msgId,
      requestBody: { addLabelIds: [label.id!] },
    });
    return { success: true, skipped: false };
  }

  if (type === "star") {
    await gmail.users.messages.modify({
      userId: "me",
      id: action.msgId,
      requestBody: { addLabelIds: ["STARRED"] },
    });
    return { success: true, skipped: false };
  }

  if (type === "mark-important") {
    await gmail.users.messages.modify({
      userId: "me",
      id: action.msgId,
      requestBody: { addLabelIds: ["IMPORTANT"] },
    });
    return { success: true, skipped: false };
  }

  if (type === "unsubscribe") {
    // Get sender address for filter
    const msg = await gmail.users.messages.get({
      userId: "me",
      id: action.msgId,
      format: "metadata",
      metadataHeaders: ["From"],
    });
    const fromHeader = msg.data.payload?.headers?.find(
      (h) => h.name === "From"
    );
    const senderMatch = fromHeader?.value?.match(/<([^>]+)>/) ||
      fromHeader?.value?.match(/(\S+@\S+)/);
    const sender = senderMatch?.[1];

    // Trash the message
    await gmail.users.messages.trash({
      userId: "me",
      id: action.msgId,
    });

    // Create filter to auto-delete future emails from this sender
    if (sender) {
      try {
        await gmail.users.settings.filters.create({
          userId: "me",
          requestBody: {
            criteria: { from: sender },
            action: { removeLabelIds: ["INBOX"], addLabelIds: ["TRASH"] },
          },
        });
      } catch {
        // Filter might already exist, that's fine
      }
    }
    return { success: true, skipped: false };
  }

  if (type === "needs-reply") {
    return { success: false, skipped: true, reason: "use /gmail draft" };
  }

  return { success: false, skipped: true, reason: `unknown action: ${type}` };
}

function updateReport(filePath: string, completedMsgIds: Set<string>) {
  let content = readFileSync(filePath, "utf-8");
  for (const msgId of completedMsgIds) {
    content = content.replace(
      new RegExp(`- \\[ \\] (.*\\| ${msgId} \\|)`),
      `- [x] $1`
    );
  }
  writeFileSync(filePath, content);
}

async function main() {
  const reportPath = process.argv[2];
  if (!reportPath) {
    console.error("Usage: tsx gmail-clean.ts <path-to-triage-report>");
    process.exit(1);
  }

  const fullPath = resolve(reportPath);
  if (!existsSync(fullPath)) {
    console.error(`Report not found: ${fullPath}`);
    process.exit(1);
  }

  const gmail = getGmailClient();
  const actions = parseReport(fullPath);
  const pending = actions.filter((a) => !a.done && a.type !== "needs-reply");

  if (pending.length === 0) {
    console.log("No pending actions to process.");
    return;
  }

  console.log(`Processing ${pending.length} actions...`);

  const stats: Record<string, number> = {};
  let skipped = 0;
  const completedIds = new Set<string>();

  for (const action of pending) {
    const result = await executeAction(gmail, action);
    if (result.success) {
      stats[action.type] = (stats[action.type] || 0) + 1;
      completedIds.add(action.msgId);
    } else if (result.skipped) {
      skipped++;
      console.log(`  Skipped: ${action.context} (${result.reason})`);
    }
  }

  // Update report with completed actions
  updateReport(fullPath, completedIds);

  // Print summary
  const parts = Object.entries(stats).map(([k, v]) => `${v} ${k}`);
  console.log(
    `\nDone: ${parts.join(", ")}. ${skipped} skipped (already handled).`
  );
}

main().catch(console.error);
