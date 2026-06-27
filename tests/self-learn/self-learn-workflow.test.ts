// Behavior contract for skills/self-learn/references/self-learn.workflow.js (#321).
// Runs the workflow through the runtime-faithful harness (validated against the
// shipped auto-grill.workflow.js in tests/verify/harness-fidelity.test.ts) with a
// mocked agent boundary — exercising the Phase 0 → parallel Phase 1 → Phase 1b
// architecture on the real file, no epub and no live agents.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runWorkflow } from "../verify/_workflow-harness.ts";

const WORKFLOW = join(
  import.meta.dir,
  "..",
  "..",
  "skills",
  "self-learn",
  "references",
  "self-learn.workflow.js",
);

const CATS = ["decision-making", "mindset", "strategy"];

function makeChapters(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    title: `Chapter ${i}`,
    path: `/tmp/sl/ch-${i}.txt`,
    wordCount: 1000 + i,
  }));
}

function selfLearnAgent(chapters: ReturnType<typeof makeChapters>) {
  return (_prompt: string, opts: Record<string, unknown>) => {
    const label = String(opts.label ?? "");
    if (label === "parse+taxonomy") return { chapters, categories: CATS };
    if (label.startsWith("extract:ch-")) {
      const idx = Number(label.split("ch-")[1]);
      return {
        notes: [
          { slug: `concept-${idx}a`, category: CATS[idx % CATS.length], title: `Concept ${idx}a` },
          { slug: `concept-${idx}b`, category: CATS[(idx + 1) % CATS.length], title: `Concept ${idx}b` },
        ],
      };
    }
    if (label === "backlink") return { updated: ["concept-0a"] };
    return {};
  };
}

const baseArgs = {
  bookSlug: "the-road-less-stupid",
  epubPath: "/x.epub",
  vaultPath: "/vault",
  bookTitle: "The Road Less Stupid",
  author: "Keith J. Cunningham",
};

test("Phase 1 fans out one agent per chapter; Phase 0 + Phase 1b run once each", async () => {
  const chapters = makeChapters(3);
  const { result, callsFor } = await runWorkflow(WORKFLOW, { args: baseArgs, agent: selfLearnAgent(chapters) });
  expect(callsFor("parse+taxonomy").length).toBe(1);
  expect(callsFor("extract:").length).toBe(3); // one per chapter
  expect(callsFor("backlink").length).toBe(1); // single barrier
  const r = result as Record<string, any>;
  expect(r.bookSlug).toBe("the-road-less-stupid");
  expect(r.noteCount).toBe(6); // 2 notes × 3 chapters
  expect(r.categories).toEqual(CATS);
});

test("fan-out cardinality tracks chapter count (not hardcoded)", async () => {
  const chapters = makeChapters(5);
  const { callsFor } = await runWorkflow(WORKFLOW, { args: baseArgs, agent: selfLearnAgent(chapters) });
  expect(callsFor("extract:").length).toBe(5);
});

test("each chapter worker reads ONLY its own file, writes via note_writer, constrained to the closed enum", async () => {
  const chapters = makeChapters(3);
  const { calls } = await runWorkflow(WORKFLOW, { args: baseArgs, agent: selfLearnAgent(chapters) });
  const ch0 = calls.find((c) => c.opts.label === "extract:ch-0")!;
  expect(ch0.prompt).toContain("/tmp/sl/ch-0.txt"); // its own chapter file
  expect(ch0.prompt).not.toContain("/tmp/sl/ch-1.txt"); // no other chapter
  expect(ch0.prompt).toMatch(/Read ONLY/i);
  expect(ch0.prompt).toContain("note_writer"); // writes via the script, not hand-rolled MD
  for (const cat of CATS) expect(ch0.prompt).toContain(cat); // closed enum injected → no drift
});

test("Phase 1b receives the GLOBAL slug list a single worker never had", async () => {
  const chapters = makeChapters(3);
  const { calls } = await runWorkflow(WORKFLOW, { args: baseArgs, agent: selfLearnAgent(chapters) });
  const back = calls.find((c) => c.opts.label === "backlink")!;
  expect(back.prompt).toContain("concept-0a"); // from chapter 0
  expect(back.prompt).toContain("concept-2b"); // and chapter 2 — the cross-chapter union
});

test("orchestrator return carries slugs/category/title/chapter only — no chapter body text", async () => {
  const chapters = makeChapters(2);
  const { result } = await runWorkflow(WORKFLOW, { args: baseArgs, agent: selfLearnAgent(chapters) });
  const r = result as Record<string, any>;
  for (const n of r.notes) {
    expect(Object.keys(n).sort()).toEqual(["category", "chapter", "slug", "title"]);
  }
});

test("structural: meta.phases Phase 0/1/1b, parallel() fan-out, note_writer in worker prompt", () => {
  const src = readFileSync(WORKFLOW, "utf8");
  expect(src).toMatch(/export const meta\b/);
  for (const p of ["Phase 0", "Phase 1", "Phase 1b"]) expect(src).toContain(p);
  expect(src).toMatch(/parallel\(/);
  expect(src).toContain("note_writer");
});
