#!/usr/bin/env tsx
/**
 * write-pages — THE single atomic write point per batch.
 *
 * Reads a results file produced by the SKILL.md orchestrator
 * (JSON array of per-email Sonnet outputs + email metadata), validates each
 * against the entity schema, deduplicates against existing vault pages,
 * writes / appends entity pages (idempotent by msg_id in `sources:`
 * frontmatter), appends processed-ids JSONL, writes WARN logs, updates
 * state.json atomically, and appends the outcome-log line (§11).
 *
 * Usage:
 *   tsx write-pages.ts --run-id 2026-04-17-1y --results /tmp/batch-results.json
 *
 * Results file shape (one entry per email in the batch):
 *   [
 *     {
 *       "email_id": "abc",
 *       "sonnet_raw_text": "{...}",
 *       "email_meta": {
 *         "msg_id": "abc",
 *         "thread_id": "...",
 *         "subject": "...",
 *         "from": "...",
 *         "date": "2026-04-15",
 *         "body": "...",              (truncated, ≤ 2k chars for Timeline blockquote)
 *         "gmail_url": "...",
 *         "junk_filter_reason": "..." (optional)
 *       },
 *       "is_retry": false             (optional)
 *     }
 *   ]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { resolve, dirname } from "path";
import { loadState, saveState, appendProcessed, type State } from "./lib/checkpoint.js";
import {
  writeWarning,
  writeRaw,
  writeFailed,
  resolveVaultPath,
} from "./lib/safety-net.js";
import {
  validate,
  patch3Warnings,
  isExtractedEmpty,
  type ExtractionResult,
  type PersonResult,
  type CompanyResult,
  type MeetingResult,
} from "./lib/sanity-check.js";
import {
  buildIndex,
  matchPerson,
  matchCompany,
  matchMeeting,
  slugify,
  meetingSlug,
  targetPath,
  type EntityIndex,
} from "./lib/entity-dedup.js";

interface EmailMeta {
  msg_id: string;
  thread_id: string;
  subject: string;
  from: string;
  date: string;
  body: string;
  gmail_url: string;
  internal_date?: string;
  junk_filter_reason?: string;
}

interface ResultRow {
  email_id: string;
  sonnet_raw_text: string;
  email_meta: EmailMeta;
  is_retry?: boolean;
}

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  return process.argv[i + 1];
}

function requireArg(name: string): string {
  const v = arg(name);
  if (!v) { console.error(`write-pages: --${name} required`); process.exit(1); }
  return v;
}

function isoDate(s: string): string {
  if (!s) return new Date().toISOString().slice(0, 10);
  const d = new Date(s);
  if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function oneLineSanitize(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 240);
}

function blockquote(body: string): string {
  const clipped = body.replace(/\r/g, "").trim().slice(0, 800);
  return clipped.split("\n").map((l) => `  > ${l}`).join("\n");
}

function parsePage(md: string): { fm: string[]; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: [], body: md };
  return { fm: m[1].split("\n"), body: m[2] };
}

function hasSource(fm: string[], msgId: string): boolean {
  for (const line of fm) {
    if (/^sources:\s*\[/.test(line)) {
      const arr = line.replace(/^sources:\s*\[/, "").replace(/\]\s*$/, "");
      return arr.split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).includes(msgId);
    }
  }
  return false;
}

function addSource(fm: string[], msgId: string): string[] {
  let hasKey = false;
  const updated = fm.map((line) => {
    if (!/^sources:\s*\[/.test(line)) return line;
    hasKey = true;
    const inner = line.replace(/^sources:\s*\[/, "").replace(/\]\s*$/, "").trim();
    const items = inner ? inner.split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")) : [];
    if (!items.includes(msgId)) items.push(msgId);
    return `sources: [${items.map((id) => `"${id}"`).join(", ")}]`;
  });
  if (!hasKey) updated.push(`sources: ["${msgId}"]`);
  return updated;
}

function renderPage(fm: string[], body: string): string {
  return `---\n${fm.join("\n")}\n---\n${body.replace(/^\n/, "")}\n`;
}

function ensureTimelineSection(body: string): string {
  if (/\n## Timeline\b/.test(body) || /^## Timeline\b/.test(body)) return body;
  const sep = body.endsWith("\n") ? "" : "\n";
  return `${body}${sep}\n---\n\n## Timeline\n`;
}

function appendTimelineEntry(body: string, entry: string): string {
  const ensured = ensureTimelineSection(body);
  return ensured.replace(/\n*$/, "\n") + entry + "\n";
}

function buildTimelineEntry(
  meta: EmailMeta,
  result: ExtractionResult,
): string {
  const date = isoDate(meta.date);
  const lines: string[] = [];
  lines.push(`- ${date}: ${oneLineSanitize(result.one_line)}`);
  for (const d of result.decisions) {
    const amount = d.amount ? ` — ${d.amount}` : "";
    const actors = d.actors.length ? ` (${d.actors.join(", ")})` : "";
    lines.push(`  - Decision [${d.type}]${amount}: ${oneLineSanitize(d.text)}${actors}`);
  }
  if (meta.body.trim()) lines.push(blockquote(meta.body));
  lines.push(`  [Source: Gmail "${meta.subject.replace(/"/g, "'")}", from ${meta.from}, ${date}] ([open](${meta.gmail_url}))`);
  return lines.join("\n");
}

function newPersonPage(p: PersonResult, meta: EmailMeta): { fm: string[]; body: string } {
  const date = isoDate(meta.date);
  const fm = [
    `title: ${p.name}`,
    `type: person`,
    `created: ${date}`,
    `email: ${p.email || ""}`,
    `sources: []`,
  ];
  const body = `
# ${p.name}

## Summary

${p.role || "First observed via email thread."} First observed ${date}.

## Role

- ${p.role || "(to be refined)"} [Source: Gmail, ${date}]

## Open Threads

- (none yet)

---

## Timeline
`;
  return { fm, body };
}

function newCompanyPage(c: CompanyResult, meta: EmailMeta): { fm: string[]; body: string } {
  const date = isoDate(meta.date);
  const fm = [
    `title: ${c.name}`,
    `type: company`,
    `created: ${date}`,
    `domain: ${c.domain || ""}`,
    `sources: []`,
  ];
  const body = `
# ${c.name}

## Summary

${c.context || "First observed via email thread."} First observed ${date}.

## State

${c.context || "(synthesize after more signals)"} [Source: Gmail, ${date}]

## Key People

- (to be populated)

## Open Threads

- (none yet)

---

## Timeline
`;
  return { fm, body };
}

function newMeetingPage(m: MeetingResult, meta: EmailMeta): { fm: string[]; body: string } {
  const date = m.date || isoDate(meta.date);
  const fm = [
    `title: ${m.subject || "Meeting"}`,
    `type: meeting`,
    `date: ${date}`,
    `created: ${date}`,
    `uid: ${m.uid || ""}`,
    `sources: []`,
  ];
  const body = `
# ${m.subject || "Meeting"}

## Summary

${m.context || "Meeting referenced in email thread."} Date: ${date}.

## Attendees

${m.attendees.length ? m.attendees.map((a) => `- ${a}`).join("\n") : "- (to be populated)"}

## Agenda / Notes

${m.context || "(agenda pending)"} [Source: Gmail, ${date}]

---

## Timeline
`;
  return { fm, body };
}

interface PlannedWrite {
  path: string;
  create: boolean;
  initial?: { fm: string[]; body: string };
  timelineEntry: string;
  msgId: string;
}

function planPersonWrites(r: ExtractionResult, meta: EmailMeta, index: EntityIndex, warnings: any[]): PlannedWrite[] {
  const writes: PlannedWrite[] = [];
  const entry = buildTimelineEntry(meta, r);
  for (const p of r.people) {
    if (!p.worth_page) continue;
    if (!p.name.trim()) continue;
    const match = matchPerson(index, p);
    if (match.kind === "exact") {
      writes.push({ path: match.file!, create: false, timelineEntry: entry, msgId: meta.msg_id });
    } else if (match.kind === "fuzzy") {
      warnings.push({ msg_id: meta.msg_id, warning: "fuzzy_person_match", name: p.name, email: p.email, candidate: match.slug, reason: match.reason });
      const slug = slugify(p.email || p.name);
      writes.push({ path: targetPath("person", slug), create: true, initial: newPersonPage(p, meta), timelineEntry: entry, msgId: meta.msg_id });
    } else {
      const slug = slugify(p.email || p.name);
      if (!slug) continue;
      writes.push({ path: targetPath("person", slug), create: true, initial: newPersonPage(p, meta), timelineEntry: entry, msgId: meta.msg_id });
    }
  }
  return writes;
}

function planCompanyWrites(r: ExtractionResult, meta: EmailMeta, index: EntityIndex, warnings: any[]): PlannedWrite[] {
  const writes: PlannedWrite[] = [];
  const entry = buildTimelineEntry(meta, r);
  for (const c of r.companies) {
    if (!c.worth_page) continue;
    if (!c.name.trim()) continue;
    const match = matchCompany(index, c);
    if (match.kind === "exact") {
      writes.push({ path: match.file!, create: false, timelineEntry: entry, msgId: meta.msg_id });
    } else if (match.kind === "fuzzy") {
      warnings.push({ msg_id: meta.msg_id, warning: "fuzzy_company_match", name: c.name, domain: c.domain, candidate: match.slug, reason: match.reason });
      const slug = slugify(c.domain || c.name);
      writes.push({ path: targetPath("company", slug), create: true, initial: newCompanyPage(c, meta), timelineEntry: entry, msgId: meta.msg_id });
    } else {
      const slug = slugify(c.domain || c.name);
      if (!slug) continue;
      writes.push({ path: targetPath("company", slug), create: true, initial: newCompanyPage(c, meta), timelineEntry: entry, msgId: meta.msg_id });
    }
  }
  return writes;
}

function planMeetingWrites(r: ExtractionResult, meta: EmailMeta, index: EntityIndex): PlannedWrite[] {
  const writes: PlannedWrite[] = [];
  const entry = buildTimelineEntry(meta, r);
  for (const m of r.meetings) {
    if (!m.subject.trim()) continue;
    const match = matchMeeting(index, m);
    if (match.kind === "exact") {
      writes.push({ path: match.file!, create: false, timelineEntry: entry, msgId: meta.msg_id });
    } else {
      const date = m.date || isoDate(meta.date);
      const slug = meetingSlug({ date, subject: m.subject });
      writes.push({ path: targetPath("meeting", slug), create: true, initial: newMeetingPage(m, meta), timelineEntry: entry, msgId: meta.msg_id });
    }
  }
  return writes;
}

function applyWrite(w: PlannedWrite): void {
  let fm: string[];
  let body: string;
  if (w.create && !existsSync(w.path)) {
    fm = w.initial!.fm;
    body = w.initial!.body;
    mkdirSync(dirname(w.path), { recursive: true });
  } else {
    const raw = readFileSync(w.path, "utf-8");
    const parsed = parsePage(raw);
    fm = parsed.fm.length ? parsed.fm : [`title: ${w.path.split("/").pop()!.replace(/\.md$/, "")}`];
    body = parsed.body;
  }
  if (hasSource(fm, w.msgId)) return;
  fm = addSource(fm, w.msgId);
  body = appendTimelineEntry(body, w.timelineEntry);
  writeFileSync(w.path, renderPage(fm, body));
}

function appendOutcomeLog(vault: string, runId: string, result: string, batchSummary: string): void {
  const log = resolve(vault, "daily/skill-outcomes/email-knowledge-extract.log");
  mkdirSync(dirname(log), { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const line = `${date} | email-knowledge-extract | batch | ~/work/brain-os-plugin | ${vault}/daily/email-extraction-state.json | commit:N/A | ${result} | run=${runId} ${batchSummary}\n`;
  appendFileSync(log, line);
}

async function main(): Promise<void> {
  const runId = requireArg("run-id");
  const resultsPath = requireArg("results");
  const raw = readFileSync(resultsPath, "utf-8");
  const rows = JSON.parse(raw) as ResultRow[];
  const state = loadState();
  if (!state || state.run_id !== runId) {
    console.error(`write-pages: state.json not found or run_id mismatch (expected ${runId})`);
    process.exit(1);
  }

  const index = buildIndex();
  const processedEntries: Array<{ msg_id: string; outcome: any; reason?: string }> = [];
  const writes: PlannedWrite[] = [];
  const warnings: any[] = [];
  const rawSaves: Array<{ msg_id: string; thread_id?: string; sonnet_output: unknown }> = [];
  const failures: Array<{ msg_id: string; error: string; attempts: number; detail?: string }> = [];
  let newLastMsgId = state.last_msg_id;
  let newLastInternalDate = state.last_internal_date;
  let counts = { extracted: 0, extracted_empty: 0, skipped_by_sonnet: 0, failed: 0 };

  for (const row of rows) {
    const { email_id, sonnet_raw_text, email_meta, is_retry } = row;
    const outcome = validate(sonnet_raw_text, email_id);
    if (!outcome.ok) {
      const existing = state.failed_ids.find((f) => f.msg_id === email_id);
      const attempts = (existing?.attempts ?? 0) + 1;
      failures.push({ msg_id: email_id, error: outcome.error.kind, attempts, detail: outcome.error.detail });
      counts.failed++;
      processedEntries.push({ msg_id: email_id, outcome: "failed", reason: outcome.error.detail.slice(0, 200) });
      continue;
    }
    const result = outcome.result;
    rawSaves.push({ msg_id: email_id, thread_id: email_meta.thread_id, sonnet_output: result });
    if (result.skip) {
      processedEntries.push({ msg_id: email_id, outcome: "extracted_empty", reason: result.skip_reason || "sonnet skip" });
      counts.skipped_by_sonnet++;
    } else if (isExtractedEmpty(result)) {
      processedEntries.push({ msg_id: email_id, outcome: "extracted_empty" });
      counts.extracted_empty++;
    } else {
      warnings.push(...patch3Warnings(result));
      writes.push(...planPersonWrites(result, email_meta, index, warnings));
      writes.push(...planCompanyWrites(result, email_meta, index, warnings));
      writes.push(...planMeetingWrites(result, email_meta, index));
      processedEntries.push({ msg_id: email_id, outcome: is_retry ? "force-extracted" : "extracted" });
      counts.extracted++;
    }
    newLastMsgId = email_id;
    if (email_meta?.internal_date) newLastInternalDate = email_meta.internal_date;
  }

  const byPath = new Map<string, PlannedWrite[]>();
  for (const w of writes) {
    if (!byPath.has(w.path)) byPath.set(w.path, []);
    byPath.get(w.path)!.push(w);
  }
  for (const [path, list] of byPath) {
    for (const w of list) applyWrite({ ...w, path });
  }

  for (const s of rawSaves) writeRaw(runId, s);
  for (const w of warnings) writeWarning(runId, w);
  for (const f of failures) writeFailed(runId, f);
  appendProcessed(runId, processedEntries);

  const updatedFailed = [...state.failed_ids];
  const keepIds = new Set(processedEntries.filter((p) => p.outcome !== "failed").map((p) => p.msg_id));
  for (let i = updatedFailed.length - 1; i >= 0; i--) {
    if (keepIds.has(updatedFailed[i].msg_id)) updatedFailed.splice(i, 1);
  }
  for (const f of failures) {
    const existing = updatedFailed.find((e) => e.msg_id === f.msg_id);
    if (existing) {
      existing.attempts = f.attempts;
      existing.error = f.error;
      existing.last_attempt_at = new Date().toISOString();
      existing.detail = f.detail;
    } else {
      updatedFailed.push({ ...f, last_attempt_at: new Date().toISOString() });
    }
  }

  const next: State = {
    ...state,
    processed_count: state.processed_count + processedEntries.length,
    skipped_count: state.skipped_count,
    extracted_count: state.extracted_count + counts.extracted,
    extracted_empty_count: state.extracted_empty_count + counts.extracted_empty + counts.skipped_by_sonnet,
    error_count: state.error_count + counts.failed,
    last_msg_id: newLastMsgId,
    last_internal_date: newLastInternalDate,
    last_checkpoint_at: new Date().toISOString(),
    batches_completed: state.batches_completed + 1,
    batches_this_session: state.batches_this_session + 1,
    failed_ids: updatedFailed,
  };
  saveState(next);

  const vault = resolveVaultPath();
  const summary = `processed=${processedEntries.length} extracted=${counts.extracted} empty=${counts.extracted_empty + counts.skipped_by_sonnet} failed=${counts.failed} warnings=${warnings.length}`;
  const result = counts.failed > 0 ? "partial" : "pass";
  appendOutcomeLog(vault, runId, result, summary);

  console.log(JSON.stringify({
    ok: true,
    batch: next.batches_completed,
    batches_this_session: next.batches_this_session,
    counts,
    warnings: warnings.length,
    failed: failures.length,
    state_phase: next.phase,
    last_msg_id: next.last_msg_id,
  }));
}

main().catch((e) => {
  console.error(`write-pages: ${e.stack || e}`);
  process.exit(1);
});
