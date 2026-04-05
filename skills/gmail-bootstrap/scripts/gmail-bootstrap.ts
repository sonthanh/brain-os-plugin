#!/usr/bin/env tsx
/**
 * Gmail Bootstrap Script
 * Scans 3 months of inbox history to build gmail-rules.md with sender patterns.
 *
 * Usage: tsx gmail-bootstrap.ts <vault-path>
 *
 * Outputs: {vault}/business/intelligence/gmail-rules.md
 */

import { gmail_v1, auth } from "@googleapis/gmail";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CREDENTIALS_PATH = resolve(
  __dirname,
  "../../gmail/.credentials.json"
);

interface SenderProfile {
  email: string;
  displayName: string;
  totalEmails: number;
  replied: number;
  drafted: number;
  starred: number;
  read: number;
  unread: number;
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
  const oauth2 = new auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    "http://localhost:3000/callback"
  );
  oauth2.setCredentials({
    refresh_token: creds.refresh_token,
    access_token: creds.access_token,
  });
  return new gmail_v1.Gmail({ auth: oauth2 });
}

function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/) || from.match(/(\S+@\S+)/);
  return match?.[1]?.toLowerCase() || from.toLowerCase();
}

function extractName(from: string): string {
  const match = from.match(/^"?([^"<]+)"?\s*</);
  return match?.[1]?.trim() || extractEmail(from);
}

async function fetchAllMessages(
  gmail: gmail_v1.Gmail,
  query: string
): Promise<Array<{ id: string; threadId: string }>> {
  const messages: Array<{ id: string; threadId: string }> = [];
  let pageToken: string | undefined;

  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 500,
      pageToken,
    });

    if (res.data.messages) {
      messages.push(
        ...res.data.messages.map((m) => ({
          id: m.id!,
          threadId: m.threadId!,
        }))
      );
    }
    pageToken = res.data.nextPageToken ?? undefined;
    console.log(`  Fetched ${messages.length} messages...`);
  } while (pageToken);

  return messages;
}

async function main() {
  const vaultPath = process.argv[2];
  if (!vaultPath) {
    console.error("Usage: tsx gmail-bootstrap.ts <vault-path>");
    process.exit(1);
  }

  const gmail = getGmailClient();

  // Get user's email address
  const profile = await gmail.users.getProfile({ userId: "me" });
  const myEmail = profile.data.emailAddress!.toLowerCase();
  console.log(`Scanning inbox for: ${myEmail}\n`);

  // Calculate 3 months ago
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const afterDate = threeMonthsAgo.toISOString().split("T")[0].replace(/-/g, "/");

  console.log("Fetching inbox messages...");
  const inboxMessages = await fetchAllMessages(
    gmail,
    `in:inbox after:${afterDate}`
  );

  console.log("Fetching sent messages...");
  const sentMessages = await fetchAllMessages(
    gmail,
    `in:sent after:${afterDate}`
  );

  // Build set of threads user replied to
  const repliedThreads = new Set(sentMessages.map((m) => m.threadId));

  // Process inbox messages to build sender profiles
  const senders = new Map<string, SenderProfile>();
  let processed = 0;

  for (const msg of inboxMessages) {
    try {
      const full = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "metadata",
        metadataHeaders: ["From"],
      });

      const fromHeader = full.data.payload?.headers?.find(
        (h) => h.name === "From"
      );
      if (!fromHeader?.value) continue;

      const email = extractEmail(fromHeader.value);
      if (email === myEmail) continue; // Skip own emails

      const profile = senders.get(email) || {
        email,
        displayName: extractName(fromHeader.value),
        totalEmails: 0,
        replied: 0,
        drafted: 0,
        starred: 0,
        read: 0,
        unread: 0,
      };

      profile.totalEmails++;

      const labels = full.data.labelIds || [];
      if (labels.includes("UNREAD")) profile.unread++;
      else profile.read++;
      if (labels.includes("STARRED")) profile.starred++;
      if (repliedThreads.has(msg.threadId)) profile.replied++;
      if (labels.includes("DRAFT")) profile.drafted++;

      senders.set(email, profile);

      processed++;
      if (processed % 50 === 0) {
        console.log(`  Processed ${processed}/${inboxMessages.length}...`);
      }
    } catch {
      // Skip messages we can't read
    }
  }

  console.log(`\nAnalyzed ${processed} messages from ${senders.size} senders.\n`);

  // Classify senders
  const alwaysImportant: SenderProfile[] = [];
  const important: SenderProfile[] = [];
  const informational: SenderProfile[] = [];
  const autoDelete: SenderProfile[] = [];

  for (const sender of senders.values()) {
    if (sender.replied > 0 || sender.drafted > 0 || sender.starred > 0) {
      alwaysImportant.push(sender);
    } else if (sender.read > 0 && sender.read / sender.totalEmails > 0.5) {
      informational.push(sender);
    } else if (sender.unread === sender.totalEmails && sender.totalEmails >= 3) {
      autoDelete.push(sender);
    } else {
      important.push(sender);
    }
  }

  // Sort by engagement
  alwaysImportant.sort((a, b) => b.replied - a.replied);
  autoDelete.sort((a, b) => b.totalEmails - a.totalEmails);

  // Generate rules file
  const rulesPath = resolve(vaultPath, "business/intelligence/gmail-rules.md");
  mkdirSync(dirname(rulesPath), { recursive: true });

  // Preserve custom rules if file exists
  let customRules = "";
  if (existsSync(rulesPath)) {
    const existing = readFileSync(rulesPath, "utf-8");
    const customMatch = existing.match(
      /## Custom Rules\n([\s\S]*?)$/
    );
    if (customMatch) customRules = customMatch[1];
  }

  const formatSender = (s: SenderProfile): string => {
    const stats: string[] = [];
    if (s.replied > 0) stats.push(`replied ${s.replied}x`);
    if (s.drafted > 0) stats.push(`drafted ${s.drafted}x`);
    if (s.starred > 0) stats.push(`starred ${s.starred}x`);
    if (stats.length === 0) stats.push(`${s.totalEmails} emails`);
    return `- from:${s.email} — ${stats.join(", ")}`;
  };

  const date = new Date().toISOString().split("T")[0];
  const rules = `# Gmail Rules
<!-- Auto-generated by /gmail-bootstrap on ${date} -->
<!-- Edit freely — the triage system reads this file every run -->

## Always Important (save to vault + flag for reply)
${alwaysImportant.map(formatSender).join("\n") || "<!-- none detected -->"}

## Important (read, but auto-archive if no action in 24h)
${important.map(formatSender).join("\n") || "<!-- none detected -->"}

## Informational (auto-archive)
${informational.map(formatSender).join("\n") || "<!-- none detected -->"}

## Auto-delete + Filter
${autoDelete.map(formatSender).join("\n") || "<!-- none detected -->"}

## Custom Rules
${customRules || "<!-- Add your own patterns below -->\n"}`;

  writeFileSync(rulesPath, rules);
  console.log(`Rules saved to: ${rulesPath}`);
  console.log(`  ${alwaysImportant.length} always important`);
  console.log(`  ${important.length} important`);
  console.log(`  ${informational.length} informational`);
  console.log(`  ${autoDelete.length} auto-delete candidates`);
}

main().catch(console.error);
