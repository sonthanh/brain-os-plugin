import { readFileSync } from "fs";
import { resolve } from "path";
import { resolveSkillRoot } from "./safety-net.js";
import type { GmailMessage } from "./gmail.js";

type Scope = "sender" | "subject" | "header" | "label";
type Action = "skip" | "force-extract";

interface Rule {
  scope: Scope;
  regex: RegExp;
  raw: string;
  action: Action;
  reason: string;
}

let cachedRules: { force: Rule[]; skip: Rule[] } | null = null;

function splitRow(line: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && line[i + 1] === "|") {
      current += "|";
      i++;
    } else if (line[i] === "|") {
      parts.push(current);
      current = "";
    } else {
      current += line[i];
    }
  }
  parts.push(current);
  return parts;
}

function parseTableRows(md: string): string[][] {
  const lines = md.split("\n");
  const rows: string[][] = [];
  let inTable = false;
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("|")) {
      if (inTable && rows.length > 1) break;
      continue;
    }
    if (/^\|\s*-+/.test(t)) { inTable = true; continue; }
    const cells = splitRow(t).slice(1, -1).map((c) => c.trim());
    if (cells.length >= 4) rows.push(cells);
  }
  return rows.slice(1);
}

function compileRule(row: string[], filePath: string): Rule {
  const [scopeRaw, regexRaw, actionRaw, reason] = row;
  const scope = scopeRaw as Scope;
  if (!["sender", "subject", "header", "label"].includes(scope)) {
    throw new Error(`${filePath}: bad scope "${scopeRaw}"`);
  }
  const action = actionRaw as Action;
  if (!["skip", "force-extract"].includes(action)) {
    throw new Error(`${filePath}: bad action "${actionRaw}"`);
  }
  const pattern = regexRaw.replace(/^`|`$/g, "");
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch (e) {
    throw new Error(`${filePath}: unparseable regex "${pattern}": ${e}`);
  }
  return { scope, regex, raw: pattern, action, reason };
}

export function loadRules(forcePath?: string): { force: Rule[]; skip: Rule[] } {
  if (cachedRules && !forcePath) return cachedRules;
  const path = forcePath || resolve(resolveSkillRoot(), "references/junk-patterns.md");
  const md = readFileSync(path, "utf-8");
  const rows = parseTableRows(md);
  const force: Rule[] = [];
  const skip: Rule[] = [];
  for (const row of rows) {
    const rule = compileRule(row, path);
    (rule.action === "force-extract" ? force : skip).push(rule);
  }
  const out = { force, skip };
  if (!forcePath) cachedRules = out;
  return out;
}

function matchRule(rule: Rule, msg: GmailMessage): boolean {
  switch (rule.scope) {
    case "sender":  return rule.regex.test(msg.from);
    case "subject": return rule.regex.test(msg.subject);
    case "label":   return msg.label_ids.some((id) => rule.regex.test(id));
    case "header":  return Object.keys(msg.headers).some((name) => rule.regex.test(name));
  }
}

export interface Verdict {
  skip: boolean;
  reason: string;
  matched_rule?: string;
  action?: Action;
}

export function evaluate(msg: GmailMessage, forcePath?: string): Verdict {
  const { force, skip } = loadRules(forcePath);
  for (const r of force) {
    if (matchRule(r, msg)) return { skip: false, reason: `force-extract: ${r.reason}`, matched_rule: r.raw, action: "force-extract" };
  }
  for (const r of skip) {
    if (matchRule(r, msg)) return { skip: true, reason: `skip: ${r.reason}`, matched_rule: r.raw, action: "skip" };
  }
  return { skip: false, reason: "default" };
}
