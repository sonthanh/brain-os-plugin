import { gmail_v1, auth } from "@googleapis/gmail";
import { readFileSync } from "fs";
import { resolve } from "path";

const CREDS = resolve(process.env.HOME!, "work/brain-os-plugin/skills/gmail/.credentials.json");

export function getGmail(): gmail_v1.Gmail {
  const creds = JSON.parse(readFileSync(CREDS, "utf-8"));
  const oauth = new auth.OAuth2(creds.client_id, creds.client_secret, "http://localhost:3000/callback");
  oauth.setCredentials({ refresh_token: creds.refresh_token, access_token: creds.access_token });
  return new gmail_v1.Gmail({ auth: oauth });
}

export interface GmailMessage {
  id: string;
  thread_id: string;
  internal_date: string;
  snippet: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  label_ids: string[];
  headers: Record<string, string>;
  body: string;
  gmail_url: string;
}

function getHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

function decodeBody(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return "";
  if (part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf-8");
  }
  if (part.parts) {
    const text = part.parts.find((p) => p.mimeType === "text/plain");
    if (text?.body?.data) return Buffer.from(text.body.data, "base64url").toString("utf-8");
    const html = part.parts.find((p) => p.mimeType === "text/html");
    if (html?.body?.data) {
      return Buffer.from(html.body.data, "base64url").toString("utf-8").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    }
    for (const p of part.parts) {
      const t = decodeBody(p);
      if (t) return t;
    }
  }
  return "";
}

export function shapeMessage(raw: gmail_v1.Schema$Message): GmailMessage {
  const headers = raw.payload?.headers;
  const headerMap: Record<string, string> = {};
  for (const h of headers || []) if (h.name && h.value !== undefined) headerMap[h.name.toLowerCase()] = h.value || "";
  return {
    id: raw.id!,
    thread_id: raw.threadId!,
    internal_date: raw.internalDate || "",
    snippet: raw.snippet || "",
    from: getHeader(headers, "From"),
    to: getHeader(headers, "To"),
    cc: getHeader(headers, "Cc"),
    subject: getHeader(headers, "Subject"),
    date: getHeader(headers, "Date"),
    label_ids: raw.labelIds || [],
    headers: headerMap,
    body: decodeBody(raw.payload).slice(0, 24_000),
    gmail_url: `https://mail.google.com/mail/u/0/#all/${raw.threadId}`,
  };
}

export async function listMessageIds(
  gmail: gmail_v1.Gmail,
  query: string,
  cap: number,
): Promise<{ id: string; thread_id: string }[]> {
  const out: { id: string; thread_id: string }[] = [];
  let pageToken: string | undefined;
  while (out.length < cap) {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: Math.min(500, cap - out.length),
      pageToken,
    });
    for (const m of res.data.messages || []) if (m.id && m.threadId) out.push({ id: m.id, thread_id: m.threadId });
    pageToken = res.data.nextPageToken || undefined;
    if (!pageToken) break;
  }
  return out;
}

export async function fetchFull(gmail: gmail_v1.Gmail, id: string): Promise<GmailMessage> {
  const res = await gmail.users.messages.get({ userId: "me", id, format: "full" });
  return shapeMessage(res.data);
}

export async function fetchBatch(gmail: gmail_v1.Gmail, ids: string[], concurrency = 10): Promise<GmailMessage[]> {
  const out: GmailMessage[] = [];
  for (let i = 0; i < ids.length; i += concurrency) {
    const slice = ids.slice(i, i + concurrency);
    const results = await Promise.all(slice.map((id) => fetchFull(gmail, id).catch((e) => ({ _error: String(e), id }))));
    for (const r of results) {
      if ("_error" in (r as any)) {
        process.stderr.write(`gmail: fetch ${(r as any).id} failed: ${(r as any)._error}\n`);
        continue;
      }
      out.push(r as GmailMessage);
    }
  }
  return out;
}
