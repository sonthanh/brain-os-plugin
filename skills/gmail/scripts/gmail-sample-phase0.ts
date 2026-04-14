#!/usr/bin/env tsx
/**
 * Phase 0 email sampling — stratified sample of 100 emails from 1y window
 * for pipeline experiment. See daily/grill-sessions/2026-04-14-email-knowledge-scan.md
 */
import { gmail_v1, auth } from "@googleapis/gmail";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

const CREDS = resolve(process.env.HOME!, "work/brain-os-plugin/skills/gmail/.credentials.json");
const OUT = "/tmp/email-phase0/samples.json";
const SAMPLE_SIZE = 100;
const FETCH_POOL = 3000;

const TARGETS: Record<string, number> = {
  internal_vn: 25,
  external_en: 25,
  financial: 15,
  multithread: 15,
  calendar: 10,
  personal: 10,
};

const EMVN_DOMAINS = ["emvn.co", "melosy.com", "melosymusic.com", "tunebot.io", "songgen.ai", "cremi.ai", "dzus.vn", "cremi.com"];
const VN_REGEX = /[áàảãạăắằẳẵặâấầẩẫậđéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵ]/i;

function getGmail(): gmail_v1.Gmail {
  const creds = JSON.parse(readFileSync(CREDS, "utf-8"));
  const oauth = new auth.OAuth2(creds.client_id, creds.client_secret, "http://localhost:3000/callback");
  oauth.setCredentials({ refresh_token: creds.refresh_token, access_token: creds.access_token });
  return new gmail_v1.Gmail({ auth: oauth });
}

function classify(m: any): string {
  const subj = (m.subject || "").toLowerCase();
  const snippet = (m.snippet || "").toLowerCase();
  const from = (m.from || "").toLowerCase();
  const ct = (m.contentType || "").toLowerCase();
  const combined = `${subj} ${snippet}`;

  if (ct.includes("text/calendar") || /\b(invite|invitation|meeting|call\b|standup|agenda|appointment|calendar)\b/.test(combined)) {
    return "calendar";
  }
  if (/\$|usd|vnd|eur|invoice|payment|contract|signed|agreement|royalty|wire|commission|billing/.test(combined)) {
    return "financial";
  }
  if (m.threadSize >= 5 && /^(re|fwd|fw):/i.test(m.subject || "")) {
    return "multithread";
  }
  const fromDomain = from.match(/@([a-z0-9.-]+)/)?.[1] || "";
  const isEmvn = EMVN_DOMAINS.some((d) => fromDomain.endsWith(d));
  const hasVN = VN_REGEX.test(combined);
  if (isEmvn || hasVN) return "internal_vn";
  if (combined.length > 20) return "external_en";
  return "personal";
}

function decodeBody(part: any): string {
  if (!part) return "";
  if (part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf-8");
  }
  if (part.parts) {
    const text = part.parts.find((p: any) => p.mimeType === "text/plain");
    if (text?.body?.data) return Buffer.from(text.body.data, "base64url").toString("utf-8");
    const html = part.parts.find((p: any) => p.mimeType === "text/html");
    if (html?.body?.data) return Buffer.from(html.body.data, "base64url").toString("utf-8").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    for (const p of part.parts) {
      const t = decodeBody(p);
      if (t) return t;
    }
  }
  return "";
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function main() {
  const gmail = getGmail();
  const CONCURRENCY = 10;

  // 1. Fetch message IDs
  console.error(`Fetching up to ${FETCH_POOL} message IDs from 1y window...`);
  const ids: string[] = [];
  let pageToken: string | undefined;
  while (ids.length < FETCH_POOL) {
    const res = await gmail.users.messages.list({ userId: "me", q: "newer_than:1y", maxResults: 500, pageToken });
    ids.push(...(res.data.messages || []).map((m) => m.id!));
    pageToken = res.data.nextPageToken || undefined;
    if (!pageToken) break;
  }
  const pool = ids.slice(0, FETCH_POOL);
  console.error(`  got ${pool.length} IDs`);

  // 2. Fetch metadata in batches
  console.error(`Fetching metadata (batch size ${CONCURRENCY})...`);
  const metas: any[] = [];
  for (let i = 0; i < pool.length; i += CONCURRENCY) {
    const batch = pool.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((id) =>
        gmail.users.messages.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["From", "To", "Cc", "Subject", "Date", "Content-Type"],
        })
      )
    );
    for (const r of results) {
      const h = r.data.payload?.headers || [];
      const getHdr = (name: string) => h.find((x) => x.name?.toLowerCase() === name.toLowerCase())?.value || "";
      metas.push({
        id: r.data.id!,
        threadId: r.data.threadId!,
        snippet: r.data.snippet || "",
        from: getHdr("From"),
        to: getHdr("To"),
        cc: getHdr("Cc"),
        subject: getHdr("Subject"),
        date: getHdr("Date"),
        contentType: getHdr("Content-Type"),
        labelIds: r.data.labelIds || [],
      });
    }
    if ((i + CONCURRENCY) % 200 === 0) console.error(`  ...${Math.min(i + CONCURRENCY, pool.length)}/${pool.length}`);
  }
  console.error(`  got ${metas.length} metadata records`);

  // 3. Compute thread sizes
  const tsz: Record<string, number> = {};
  for (const m of metas) tsz[m.threadId] = (tsz[m.threadId] || 0) + 1;
  for (const m of metas) m.threadSize = tsz[m.threadId];

  // 4. Classify
  for (const m of metas) m.category = classify(m);

  // 5. Sample per bucket
  const buckets: Record<string, any[]> = {};
  for (const m of metas) (buckets[m.category] = buckets[m.category] || []).push(m);
  console.error("Bucket sizes:");
  for (const [k, v] of Object.entries(buckets)) console.error(`  ${k}: ${v.length}`);

  const sampled: any[] = [];
  for (const [cat, target] of Object.entries(TARGETS)) {
    const pool = buckets[cat] || [];
    const picked = shuffle(pool).slice(0, target);
    sampled.push(...picked);
    console.error(`  sampled ${picked.length}/${target} from ${cat}`);
  }

  // 6. Fill gaps from largest remaining bucket if short
  while (sampled.length < SAMPLE_SIZE) {
    const taken = new Set(sampled.map((s) => s.id));
    const remaining = metas.filter((m) => !taken.has(m.id));
    if (!remaining.length) break;
    const need = SAMPLE_SIZE - sampled.length;
    sampled.push(...shuffle(remaining).slice(0, need));
    console.error(`  filled ${need} extras from remaining pool`);
    break;
  }

  // 7. Fetch full bodies for sampled
  console.error(`Fetching full content for ${sampled.length} sampled emails...`);
  const full: any[] = [];
  for (let i = 0; i < sampled.length; i += CONCURRENCY) {
    const batch = sampled.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((m) => gmail.users.messages.get({ userId: "me", id: m.id, format: "full" }))
    );
    for (let j = 0; j < results.length; j++) {
      const meta = batch[j];
      const body = decodeBody(results[j].data.payload).slice(0, 8000);
      full.push({
        id: meta.id,
        threadId: meta.threadId,
        category: meta.category,
        from: meta.from,
        to: meta.to,
        cc: meta.cc,
        subject: meta.subject,
        date: meta.date,
        snippet: meta.snippet,
        threadSize: meta.threadSize,
        body,
        threadUrl: `https://mail.google.com/mail/u/0/#all/${meta.threadId}`,
      });
    }
  }

  // 8. Save
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(full, null, 2));
  console.error(`\nWrote ${full.length} samples to ${OUT}`);

  const finalCounts: Record<string, number> = {};
  for (const m of full) finalCounts[m.category] = (finalCounts[m.category] || 0) + 1;
  console.log("\nFinal stratification:");
  for (const [k, v] of Object.entries(finalCounts).sort()) console.log(`  ${k}: ${v}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
