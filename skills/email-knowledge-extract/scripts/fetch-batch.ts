#!/usr/bin/env tsx
/**
 * fetch-batch — fetch the next batch of non-junk emails for Sonnet extraction.
 *
 * Usage (live Gmail):
 *   tsx fetch-batch.ts --run-id 2026-04-17-1y --count 20
 *
 * Usage (dry-run on frozen samples):
 *   tsx fetch-batch.ts --run-id 2026-04-17-1y --count 20 --fixture references/phase0-samples.json
 *
 * If state.json does not exist, the first call will bootstrap one from the
 * window flags (--window 1y OR --window-start/--window-end).
 *
 * Output: JSON array of message objects (extract-bound) on stdout.
 *         Skipped messages written to safety-net JSONL as side effect.
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { getGmail, listMessageIds, fetchBatch, shapeMessage, type GmailMessage } from "./lib/gmail.js";
import { evaluate } from "./lib/junk-filter.js";
import { loadState, saveState, initState, loadProcessedIds, type State } from "./lib/checkpoint.js";
import { writeSkipped } from "./lib/safety-net.js";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  return process.argv[i + 1];
}

function requireArg(name: string): string {
  const v = arg(name);
  if (!v) {
    console.error(`fetch-batch: --${name} required`);
    process.exit(1);
  }
  return v;
}

function toEpochSec(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

function toGmailDate(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, "/");
}

function windowDates(window: string, startArg?: string, endArg?: string): { start: string; end: string } {
  const end = endArg || new Date().toISOString().slice(0, 10);
  if (startArg) return { start: startArg, end };
  const endDate = new Date(end + "T00:00:00Z");
  const m = window.match(/^(\d+)([ydm])$/);
  if (!m) throw new Error(`bad --window "${window}", expected e.g. 1y, 6m, 30d`);
  const n = Number(m[1]);
  const unit = m[2];
  const d = new Date(endDate);
  if (unit === "y") d.setUTCFullYear(d.getUTCFullYear() - n);
  else if (unit === "m") d.setUTCMonth(d.getUTCMonth() - n);
  else d.setUTCDate(d.getUTCDate() - n);
  return { start: d.toISOString().slice(0, 10), end };
}

async function loadOrInitState(runId: string): Promise<State> {
  const existing = loadState();
  if (existing && existing.run_id === runId) return existing;
  if (existing && existing.run_id !== runId) {
    console.error(`fetch-batch: state.json run_id=${existing.run_id} ≠ --run-id ${runId}; refusing to clobber`);
    process.exit(1);
  }
  const window = arg("window", "1y")!;
  const { start, end } = windowDates(window, arg("window-start"), arg("window-end"));
  const totalEstimated = Number(arg("total-estimated", "0"));
  const s = initState({
    run_id: runId,
    window,
    window_start: start,
    window_end: end,
    total_estimated: totalEstimated,
  });
  saveState(s);
  return s;
}

async function fixtureFetch(path: string, count: number, processedIds: Set<string>): Promise<GmailMessage[]> {
  const full = resolve(process.cwd(), path);
  if (!existsSync(full)) {
    console.error(`fetch-batch: fixture not found: ${full}`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(full, "utf-8")) as Array<{
    id: string;
    threadId: string;
    from: string;
    to?: string;
    cc?: string;
    subject: string;
    date: string;
    snippet?: string;
    body?: string;
    threadUrl?: string;
    category?: string;
  }>;
  const out: GmailMessage[] = [];
  for (const r of raw) {
    if (processedIds.has(r.id)) continue;
    if (out.length >= count * 3) break;
    out.push({
      id: r.id,
      thread_id: r.threadId,
      internal_date: "",
      snippet: r.snippet || "",
      from: r.from,
      to: r.to || "",
      cc: r.cc || "",
      subject: r.subject,
      date: r.date,
      label_ids: [],
      headers: {},
      body: r.body || "",
      gmail_url: r.threadUrl || `https://mail.google.com/mail/u/0/#all/${r.threadId}`,
    });
  }
  return out;
}

async function liveFetch(state: State, count: number, processedIds: Set<string>): Promise<GmailMessage[]> {
  const gmail = getGmail();
  const parts = [`after:${toGmailDate(state.window_start)}`, `before:${toGmailDate(state.window_end)}`];
  if (state.last_internal_date) {
    const sec = Math.floor(Number(state.last_internal_date) / 1000);
    parts.push(`before:${sec}`);
  }
  const query = parts.join(" ");
  const listed = await listMessageIds(gmail, query, count * 5);
  const toFetch = listed.filter((x) => !processedIds.has(x.id)).slice(0, count * 3);
  if (!toFetch.length) return [];
  return await fetchBatch(gmail, toFetch.map((x) => x.id), 10);
}

async function main(): Promise<void> {
  const runId = requireArg("run-id");
  const count = Number(arg("count", "20"));
  const fixture = arg("fixture");

  const state = await loadOrInitState(runId);
  const processedIds = loadProcessedIds(runId);

  const pending = state.failed_ids.filter((f) => f.attempts < 3).map((f) => f.msg_id);
  const retrySet = new Set(pending);

  const messages = fixture
    ? await fixtureFetch(fixture, count, processedIds)
    : await liveFetch(state, count, processedIds);

  const extract: Array<GmailMessage & { junk_filter_reason?: string; is_retry?: boolean }> = [];
  let taken = 0;

  for (const msg of messages) {
    if (taken >= count) break;
    const verdict = evaluate(msg);
    if (verdict.skip) {
      writeSkipped(runId, {
        msg_id: msg.id,
        thread_id: msg.thread_id,
        subject: msg.subject,
        sender: msg.from,
        reason: verdict.reason,
        matched_rule: verdict.matched_rule,
      });
      continue;
    }
    const is_retry = retrySet.has(msg.id);
    extract.push({ ...msg, junk_filter_reason: verdict.reason, is_retry });
    taken++;
  }

  process.stdout.write(JSON.stringify(extract, null, 2) + "\n");
}

main().catch((e) => {
  console.error(`fetch-batch: ${e.stack || e}`);
  process.exit(1);
});
