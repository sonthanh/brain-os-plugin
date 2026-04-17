import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve, basename } from "path";
import { resolveVaultPath } from "./safety-net.js";

export function asciiFold(s: string): string {
  const map: Record<string, string> = {
    "á":"a","à":"a","ả":"a","ã":"a","ạ":"a","ă":"a","ắ":"a","ằ":"a","ẳ":"a","ẵ":"a","ặ":"a",
    "â":"a","ấ":"a","ầ":"a","ẩ":"a","ẫ":"a","ậ":"a","đ":"d","é":"e","è":"e","ẻ":"e","ẽ":"e","ẹ":"e",
    "ê":"e","ế":"e","ề":"e","ể":"e","ễ":"e","ệ":"e","í":"i","ì":"i","ỉ":"i","ĩ":"i","ị":"i",
    "ó":"o","ò":"o","ỏ":"o","õ":"o","ọ":"o","ô":"o","ố":"o","ồ":"o","ổ":"o","ỗ":"o","ộ":"o",
    "ơ":"o","ớ":"o","ờ":"o","ở":"o","ỡ":"o","ợ":"o","ú":"u","ù":"u","ủ":"u","ũ":"u","ụ":"u",
    "ư":"u","ứ":"u","ừ":"u","ử":"u","ữ":"u","ự":"u","ý":"y","ỳ":"y","ỷ":"y","ỹ":"y","ỵ":"y",
  };
  return s.toLowerCase().replace(/./g, (c) => map[c] ?? c);
}

export function slugify(s: string): string {
  return asciiFold(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function personKey(p: { name: string; email: string }): string {
  if (p.email) return p.email.trim().toLowerCase();
  return `name:${slugify(p.name)}`;
}

export function companyKey(c: { name: string; domain: string }): string {
  if (c.domain) return c.domain.trim().toLowerCase();
  return `name:${slugify(c.name)}`;
}

export function meetingKey(m: { uid: string; subject: string; date: string }): string {
  if (m.uid) return `uid:${m.uid}`;
  return `${m.date}:${slugify(m.subject)}`;
}

function readFrontmatter(file: string): Record<string, string> {
  const txt = readFileSync(file, "utf-8");
  const m = txt.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

export interface IndexEntry {
  slug: string;
  file: string;
  key: string;
}

export interface EntityIndex {
  people: IndexEntry[];
  companies: IndexEntry[];
  meetings: IndexEntry[];
}

function scanDir(dir: string, deriveKey: (fm: Record<string, string>, slug: string) => string | null): IndexEntry[] {
  if (!existsSync(dir)) return [];
  const entries: IndexEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md") || name === "README.md") continue;
    const slug = name.replace(/\.md$/, "");
    const file = resolve(dir, name);
    const fm = readFrontmatter(file);
    const key = deriveKey(fm, slug);
    if (key) entries.push({ slug, file, key });
  }
  return entries;
}

export function buildIndex(): EntityIndex {
  const vault = resolveVaultPath();
  const people = scanDir(resolve(vault, "people"),
    (fm, slug) => (fm.email ? fm.email.toLowerCase() : `name:${slug}`));
  const companies = scanDir(resolve(vault, "companies"),
    (fm, slug) => (fm.domain ? fm.domain.toLowerCase() : `name:${slug}`));
  const meetings = scanDir(resolve(vault, "meetings"),
    (fm, slug) => (fm.uid ? `uid:${fm.uid}` : slug.replace(/^(\d{4}-\d{2}-\d{2})-/, "$1:")));
  return { people, companies, meetings };
}

export type MatchKind = "exact" | "fuzzy" | "none";

export interface MatchResult {
  kind: MatchKind;
  slug?: string;
  file?: string;
  reason?: string;
}

export function matchPerson(index: EntityIndex, p: { name: string; email: string }): MatchResult {
  const key = personKey(p);
  const exact = index.people.find((e) => e.key === key);
  if (exact) return { kind: "exact", slug: exact.slug, file: exact.file };
  if (p.name) {
    const nameKey = `name:${slugify(p.name)}`;
    const fuzzy = index.people.find((e) => e.key === nameKey);
    if (fuzzy) return { kind: "fuzzy", slug: fuzzy.slug, file: fuzzy.file, reason: "name match, email differs" };
  }
  return { kind: "none" };
}

export function matchCompany(index: EntityIndex, c: { name: string; domain: string }): MatchResult {
  const key = companyKey(c);
  const exact = index.companies.find((e) => e.key === key);
  if (exact) return { kind: "exact", slug: exact.slug, file: exact.file };
  if (c.name) {
    const nameKey = `name:${slugify(c.name)}`;
    const fuzzy = index.companies.find((e) => e.key === nameKey);
    if (fuzzy) return { kind: "fuzzy", slug: fuzzy.slug, file: fuzzy.file, reason: "name match, domain differs" };
  }
  return { kind: "none" };
}

export function matchMeeting(index: EntityIndex, m: { uid: string; subject: string; date: string }): MatchResult {
  const key = meetingKey(m);
  const exact = index.meetings.find((e) => e.key === key);
  if (exact) return { kind: "exact", slug: exact.slug, file: exact.file };
  return { kind: "none" };
}

export function targetPath(kind: "person" | "company" | "meeting", slug: string): string {
  const vault = resolveVaultPath();
  if (kind === "meeting") return resolve(vault, "meetings", `${slug}.md`);
  return resolve(vault, kind === "person" ? "people" : "companies", `${slug}.md`);
}

export function meetingSlug(m: { date: string; subject: string }): string {
  const date = m.date || "unknown-date";
  return `${date}-${slugify(m.subject || "meeting")}`;
}
