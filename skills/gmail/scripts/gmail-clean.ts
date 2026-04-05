#!/usr/bin/env tsx
import { gmail_v1, auth } from "@googleapis/gmail";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

const CREDENTIALS_PATH = process.env.GMAIL_CREDENTIALS_PATH || resolve(process.cwd(), ".credentials.json");
const CONCURRENCY = 10;
const REDIRECT_URI = "http://localhost:3000/callback";

interface Action {
  done: boolean;
  type: string;
  msgId: string;
  context: string;
}

function getGmailClient(): gmail_v1.Gmail {
  const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
  const oauth2 = new auth.OAuth2(creds.client_id, creds.client_secret, REDIRECT_URI);
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

function extractSender(value: string): string | undefined {
  return (value.match(/<([^>]+)>/) || value.match(/(\S+@\S+)/))?.[1];
}

async function execute(
  gmail: gmail_v1.Gmail,
  a: Action,
  labelCache: Map<string, string>
): Promise<{ ok: boolean; skip: boolean; reason?: string }> {
  try {
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
      let labelId = labelCache.get(name);
      if (!labelId) {
        const created = await gmail.users.labels.create({ userId: "me", requestBody: { name } });
        labelId = created.data.id!;
        labelCache.set(name, labelId);
      }
      await gmail.users.messages.modify({ userId: "me", id: a.msgId, requestBody: { addLabelIds: [labelId] } });
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
      const sender = from?.value ? extractSender(from.value) : undefined;
      await gmail.users.messages.trash({ userId: "me", id: a.msgId });
      if (sender) try { await gmail.users.settings.filters.create({ userId: "me", requestBody: { criteria: { from: sender }, action: { removeLabelIds: ["INBOX"], addLabelIds: ["TRASH"] } } }); } catch {}
      return { ok: true, skip: false };
    }
    if (a.type === "needs-reply") return { ok: false, skip: true, reason: "manual" };
    return { ok: false, skip: true, reason: `unknown: ${a.type}` };
  } catch (e: any) {
    if (e?.code === 404) return { ok: false, skip: true, reason: "not found" };
    throw e;
  }
}

async function runBatch<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    results.push(...await Promise.all(batch.map(fn)));
  }
  return results;
}

async function main() {
  const reportPath = process.argv[2];
  if (!reportPath) { console.error("Usage: node gmail-clean.js <report>"); process.exit(1); }
  const fullPath = resolve(reportPath);
  if (!existsSync(fullPath)) { console.error(`Not found: ${fullPath}`); process.exit(1); }

  const gmail = getGmailClient();
  const pending = parseReport(fullPath).filter((a) => !a.done && a.type !== "needs-reply");
  if (!pending.length) { console.log("No pending actions."); return; }

  // Cache labels upfront
  const labelCache = new Map<string, string>();
  const labelsNeeded = new Set(pending.filter((a) => a.type.startsWith("label:")).map((a) => a.type.slice(6)));
  if (labelsNeeded.size > 0) {
    const existing = await gmail.users.labels.list({ userId: "me" });
    for (const l of existing.data.labels || []) {
      if (l.name && l.id && labelsNeeded.has(l.name)) labelCache.set(l.name, l.id);
    }
  }

  console.log(`Processing ${pending.length} actions (${CONCURRENCY} concurrent)...`);
  const stats: Record<string, number> = {};
  let skipped = 0;
  const done = new Set<string>();

  const results = await runBatch(pending, CONCURRENCY, (a) => execute(gmail, a, labelCache));
  for (let i = 0; i < pending.length; i++) {
    const r = results[i];
    if (r.ok) { stats[pending[i].type] = (stats[pending[i].type] || 0) + 1; done.add(pending[i].msgId); }
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
