#!/usr/bin/env tsx
import { gmail_v1, auth } from "@googleapis/gmail";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

const CREDENTIALS_PATH = process.env.GMAIL_CREDENTIALS_PATH || resolve(process.cwd(), ".credentials.json");

interface Action {
  done: boolean;
  type: string;
  msgId: string;
  context: string;
}

function getGmailClient(): gmail_v1.Gmail {
  const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
  const oauth2 = new auth.OAuth2(creds.client_id, creds.client_secret, "http://localhost:3000/callback");
  oauth2.setCredentials({ refresh_token: creds.refresh_token, access_token: creds.access_token });
  return new gmail_v1.Gmail({ auth: oauth2 });
}

function parseReport(filePath: string): Action[] {
  const content = readFileSync(filePath, "utf-8");
  const actions: Action[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(/^- \[([ x])\] ([\w:-]+) \| (\S+) \| (.+)$/);
    if (match) actions.push({ done: match[1] === "x", type: match[2], msgId: match[3], context: match[4] });
  }
  return actions;
}

async function msgExists(gmail: gmail_v1.Gmail, id: string): Promise<boolean> {
  try { await gmail.users.messages.get({ userId: "me", id, format: "minimal" }); return true; } catch { return false; }
}

async function execute(gmail: gmail_v1.Gmail, a: Action): Promise<{ ok: boolean; skip: boolean; reason?: string }> {
  if (!(await msgExists(gmail, a.msgId))) return { ok: false, skip: true, reason: "not found" };

  if (a.type === "archive") {
    await gmail.users.messages.modify({ userId: "me", id: a.msgId, requestBody: { removeLabelIds: ["INBOX"] } });
    return { ok: true, skip: false };
  }
  if (a.type === "delete") {
    await gmail.users.messages.trash({ userId: "me", id: a.msgId });
    return { ok: true, skip: false };
  }
  if (a.type.startsWith("label:")) {
    const name = a.type.slice(6);
    const labels = await gmail.users.labels.list({ userId: "me" });
    let label = labels.data.labels?.find((l) => l.name === name);
    if (!label) { const c = await gmail.users.labels.create({ userId: "me", requestBody: { name } }); label = c.data; }
    await gmail.users.messages.modify({ userId: "me", id: a.msgId, requestBody: { addLabelIds: [label!.id!] } });
    return { ok: true, skip: false };
  }
  if (a.type === "star") {
    await gmail.users.messages.modify({ userId: "me", id: a.msgId, requestBody: { addLabelIds: ["STARRED"] } });
    return { ok: true, skip: false };
  }
  if (a.type === "mark-important") {
    await gmail.users.messages.modify({ userId: "me", id: a.msgId, requestBody: { addLabelIds: ["IMPORTANT"] } });
    return { ok: true, skip: false };
  }
  if (a.type === "unsubscribe") {
    const msg = await gmail.users.messages.get({ userId: "me", id: a.msgId, format: "metadata", metadataHeaders: ["From"] });
    const from = msg.data.payload?.headers?.find((h) => h.name === "From");
    const sender = (from?.value?.match(/<([^>]+)>/) || from?.value?.match(/(\S+@\S+)/))?.[1];
    await gmail.users.messages.trash({ userId: "me", id: a.msgId });
    if (sender) try { await gmail.users.settings.filters.create({ userId: "me", requestBody: { criteria: { from: sender }, action: { removeLabelIds: ["INBOX"], addLabelIds: ["TRASH"] } } }); } catch {}
    return { ok: true, skip: false };
  }
  if (a.type === "needs-reply") return { ok: false, skip: true, reason: "manual" };
  return { ok: false, skip: true, reason: `unknown: ${a.type}` };
}

async function main() {
  const reportPath = process.argv[2];
  if (!reportPath) { console.error("Usage: node gmail-clean.js <report>"); process.exit(1); }
  const fullPath = resolve(reportPath);
  if (!existsSync(fullPath)) { console.error(`Not found: ${fullPath}`); process.exit(1); }

  const gmail = getGmailClient();
  const pending = parseReport(fullPath).filter((a) => !a.done && a.type !== "needs-reply");
  if (!pending.length) { console.log("No pending actions."); return; }

  console.log(`Processing ${pending.length} actions...`);
  const stats: Record<string, number> = {};
  let skipped = 0;
  const done = new Set<string>();

  for (const a of pending) {
    const r = await execute(gmail, a);
    if (r.ok) { stats[a.type] = (stats[a.type] || 0) + 1; done.add(a.msgId); }
    else if (r.skip) { skipped++; }
  }

  // Update report
  let content = readFileSync(fullPath, "utf-8");
  for (const id of done) content = content.replace(new RegExp(`- \\[ \\] (.*\\| ${id} \\|)`), "- [x] $1");
  writeFileSync(fullPath, content);

  const parts = Object.entries(stats).map(([k, v]) => `${v} ${k}`);
  console.log(`Done: ${parts.join(", ")}. ${skipped} skipped.`);
}

main().catch(console.error);
