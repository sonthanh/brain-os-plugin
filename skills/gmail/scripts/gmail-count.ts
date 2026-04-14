#!/usr/bin/env tsx
import { gmail_v1, auth } from "@googleapis/gmail";
import { readFileSync } from "fs";
import { resolve } from "path";

const CREDENTIALS_PATH = resolve(process.env.HOME!, "work/brain-os-plugin/skills/gmail/.credentials.json");
const REDIRECT_URI = "http://localhost:3000/callback";

function getGmailClient(): gmail_v1.Gmail {
  const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
  const oauth2 = new auth.OAuth2(creds.client_id, creds.client_secret, REDIRECT_URI);
  oauth2.setCredentials({ refresh_token: creds.refresh_token, access_token: creds.access_token });
  return new gmail_v1.Gmail({ auth: oauth2 });
}

async function countMessages(gmail: gmail_v1.Gmail, query: string): Promise<number> {
  let total = 0;
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 500,
      pageToken,
    });
    const ids = res.data.messages || [];
    total += ids.length;
    pageToken = res.data.nextPageToken || undefined;
    pages++;
    if (pages % 10 === 0) console.error(`  ...counted ${total} so far (page ${pages})`);
    if (pages > 200) {
      console.error(`  hit 200 page cap, total so far: ${total}`);
      break;
    }
  } while (pageToken);
  return total;
}

async function main() {
  const gmail = getGmailClient();
  const windows = [
    { label: "1 year", query: "newer_than:1y" },
    { label: "2 years", query: "newer_than:2y" },
    { label: "3 years", query: "newer_than:3y" },
    { label: "5 years", query: "newer_than:5y" },
  ];
  console.log("Window         | Count");
  console.log("---------------|------");
  for (const w of windows) {
    console.error(`Querying ${w.label}...`);
    const count = await countMessages(gmail, w.query);
    console.log(`${w.label.padEnd(14)} | ${count}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
