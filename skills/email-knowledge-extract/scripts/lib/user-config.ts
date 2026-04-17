import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { resolveVaultPath } from "./safety-net.js";

export interface UserConfig {
  internal_domains: string[];
  few_shot: string;
  fixture_path: string | null;
}

const EMPTY: UserConfig = { internal_domains: [], few_shot: "", fixture_path: null };

let cached: UserConfig | null = null;

export function loadUserConfig(forcePath?: string): UserConfig {
  if (cached && !forcePath) return cached;
  const path = forcePath || resolve(resolveVaultPath(), "context/email-extract.md");
  if (!existsSync(path)) return { ...EMPTY };
  const md = readFileSync(path, "utf-8");
  const internal_domains = parseBulletList(extractSection(md, "Internal Domains"));
  const few_shot = extractSection(md, "Few-Shot Examples");
  const fixture_path = parseFixturePath(extractSection(md, "Dry-Run Fixture"));
  const out: UserConfig = { internal_domains, few_shot, fixture_path };
  if (!forcePath) cached = out;
  return out;
}

function extractSection(md: string, heading: string): string {
  const re = new RegExp(`^##\\s+${escapeRegex(heading)}\\s*$`, "m");
  const m = md.match(re);
  if (!m || m.index === undefined) return "";
  const start = m.index + m[0].length;
  const rest = md.slice(start);
  const nextH2 = rest.match(/\n##\s+/);
  const end = nextH2 ? start + nextH2.index! : md.length;
  return md.slice(start, end).trim();
}

function parseBulletList(section: string): string[] {
  return section
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);
}

function parseFixturePath(section: string): string | null {
  for (const line of section.split("\n")) {
    const m = line.match(/fixture_path:\s*(.+)$/);
    if (m) {
      const raw = m[1].trim();
      if (!raw) return null;
      if (raw.startsWith("/")) return raw;
      return resolve(resolveVaultPath(), raw);
    }
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
