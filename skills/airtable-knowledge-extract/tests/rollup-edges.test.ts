/**
 * rollup-edges.test.ts — entity-page edge rollup generator (ai-brain#245, parent #237 AC#12).
 *
 * Pure helpers + a full `rollupEdges()` flow over a temp vault, exercising:
 *   - Marker-bounded `## Edges (incoming)` / `## Edges (outgoing)` sections
 *     written between deterministic `<!-- BEGIN ROLLUP -->` / `<!-- END ROLLUP -->`.
 *   - Counterparty resolution: matches another entity page's `source_record_id`
 *     → wikilink; unmatched → raw record-id in code-tick.
 *   - Idempotence: two consecutive runs on identical input produce a
 *     byte-identical file (the AC#12 contract).
 *   - Non-rollup content preservation across reruns.
 *   - Three-edge / two-entity fixture per the parent AC#12 acceptance line.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ROLLUP_BEGIN,
  ROLLUP_END,
  parseEdgesJsonl,
  parseFrontmatter,
  extractRecordIds,
  buildRecordIndex,
  groupEdgesByEntity,
  renderEdgeRow,
  renderRollupBlock,
  applyRollupToPage,
  rollupEdges,
  type EdgeRow,
  type EntityPage,
} from "../scripts/rollup-edges.mts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "rollup-edges-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function writeEdges(vault: string, edges: EdgeRow[]): string {
  const dir = join(vault, "knowledge", "graph");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "edges.jsonl");
  writeFileSync(
    path,
    edges.length === 0 ? "" : edges.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  return path;
}

function writeEntityPage(
  vault: string,
  relPath: string,
  frontmatter: Record<string, unknown>,
  body = "Some body content.\n",
): string {
  const path = join(vault, relPath);
  mkdirSync(dirname(path), { recursive: true });
  const fmLines: string[] = ["---"];
  for (const [k, v] of Object.entries(frontmatter)) {
    if (Array.isArray(v)) {
      fmLines.push(`${k}:`);
      for (const item of v) fmLines.push(`  - ${item}`);
    } else {
      fmLines.push(`${k}: ${v}`);
    }
  }
  fmLines.push("---", "", body);
  writeFileSync(path, fmLines.join("\n"));
  return path;
}

// ---------------------------------------------------------------------------
// Pure helpers — frontmatter parsing
// ---------------------------------------------------------------------------

describe("parseFrontmatter", () => {
  test("returns frontmatter map + body when present", () => {
    const text = "---\ntype: company\nslug: comp-a\nsource_record_id: recA\n---\n\nbody here\n";
    const r = parseFrontmatter(text);
    expect(r.frontmatter).toEqual({
      type: "company",
      slug: "comp-a",
      source_record_id: "recA",
    });
    expect(r.body).toBe("\nbody here\n");
  });

  test("returns null frontmatter when block missing", () => {
    const text = "no frontmatter here\n";
    expect(parseFrontmatter(text).frontmatter).toBeNull();
  });

  test("parses sequence values (sources: list)", () => {
    const text = "---\nslug: x\nsources:\n  - rec1\n  - rec2\n  - rec3\n---\n\nbody\n";
    const r = parseFrontmatter(text);
    expect(r.frontmatter).toMatchObject({
      slug: "x",
      sources: ["rec1", "rec2", "rec3"],
    });
  });
});

describe("extractRecordIds", () => {
  test("merges source_record_id + sources[] into a deduped list", () => {
    expect(
      extractRecordIds({ source_record_id: "rec1", sources: ["rec1", "rec2"] }),
    ).toEqual(["rec1", "rec2"]);
  });

  test("returns empty when no record-id keys present", () => {
    expect(extractRecordIds({ slug: "x" })).toEqual([]);
  });

  test("tolerates source_record_id alone (no sources list)", () => {
    expect(extractRecordIds({ source_record_id: "recA" })).toEqual(["recA"]);
  });
});

// ---------------------------------------------------------------------------
// buildRecordIndex / groupEdgesByEntity
// ---------------------------------------------------------------------------

describe("buildRecordIndex — record-id → slug map", () => {
  test("maps every record id (incl. extras from sources[]) to the page slug", () => {
    const pages: EntityPage[] = [
      { path: "/t/a.md", slug: "comp-a", recordIds: ["recA"], body: "" },
      { path: "/t/b.md", slug: "comp-b", recordIds: ["recB1", "recB2"], body: "" },
    ];
    const idx = buildRecordIndex(pages);
    expect(idx.get("recA")).toBe("comp-a");
    expect(idx.get("recB1")).toBe("comp-b");
    expect(idx.get("recB2")).toBe("comp-b");
    expect(idx.get("recUnknown")).toBeUndefined();
  });
});

describe("groupEdgesByEntity", () => {
  const edges: EdgeRow[] = [
    {
      id: "x-1",
      type: "payments",
      from: "recA",
      to: "recB",
      source_record_id: "rec1",
      source_table: "tblPay",
    },
    {
      id: "x-2",
      type: "payments",
      from: "recA",
      to: "recC",
      source_record_id: "rec2",
      source_table: "tblPay",
    },
    {
      id: "x-3",
      type: "payments",
      from: "recB",
      to: "recA",
      source_record_id: "rec3",
      source_table: "tblPay",
    },
  ];

  test("groups by record id with separate incoming + outgoing buckets", () => {
    const g = groupEdgesByEntity(edges);
    expect(g.outgoing.get("recA")?.length).toBe(2);
    expect(g.incoming.get("recA")?.length).toBe(1);
    expect(g.outgoing.get("recB")?.length).toBe(1);
    expect(g.incoming.get("recB")?.length).toBe(1);
    expect(g.incoming.get("recC")?.length).toBe(1);
    expect(g.outgoing.get("recC")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Renderers — single row + full block
// ---------------------------------------------------------------------------

describe("renderEdgeRow", () => {
  const idx = new Map<string, string>([["recCompB", "comp-b"]]);

  test("resolves counterparty wikilink when slug exists", () => {
    const row = renderEdgeRow(
      {
        id: "x-1",
        type: "payments",
        from: "recCompA",
        to: "recCompB",
        amount: 100,
        date: "2026-01-01",
        note: "inv 1",
        source_record_id: "rec1",
        source_table: "tblPay",
      },
      "recCompB",
      idx,
    );
    expect(row).toBe("| 2026-01-01 | [[comp-b]] | 100 | inv 1 |");
  });

  test("falls back to record-id in code-tick when unresolved", () => {
    const row = renderEdgeRow(
      {
        id: "x-2",
        type: "payments",
        from: "recCompA",
        to: "recUnknown",
        amount: 200,
        date: "2026-01-02",
        source_record_id: "rec2",
        source_table: "tblPay",
      },
      "recUnknown",
      idx,
    );
    expect(row).toBe("| 2026-01-02 | `recUnknown` | 200 | — |");
  });

  test("renders em-dash for missing date / amount / note", () => {
    const row = renderEdgeRow(
      {
        id: "x-3",
        type: "meetings",
        from: "recA",
        to: "recCompB",
        source_record_id: "rec3",
        source_table: "tblMtg",
      },
      "recCompB",
      idx,
    );
    expect(row).toBe("| — | [[comp-b]] | — | — |");
  });

  test("escapes pipes inside notes so the markdown table stays well-formed", () => {
    const row = renderEdgeRow(
      {
        id: "x-4",
        type: "payments",
        from: "recA",
        to: "recCompB",
        date: "2026-01-04",
        amount: 10,
        note: "split a|b",
        source_record_id: "rec4",
        source_table: "tblPay",
      },
      "recCompB",
      idx,
    );
    expect(row).toContain("split a\\|b");
  });
});

describe("renderRollupBlock", () => {
  const idx = new Map<string, string>([
    ["recCompA", "comp-a"],
    ["recCompB", "comp-b"],
  ]);
  const incoming: EdgeRow[] = [
    {
      id: "x-3",
      type: "payments",
      from: "recCompB",
      to: "recCompA",
      amount: 50,
      date: "2026-01-03",
      note: "refund",
      source_record_id: "rec3",
      source_table: "tblPay",
    },
  ];
  const outgoing: EdgeRow[] = [
    {
      id: "x-1",
      type: "payments",
      from: "recCompA",
      to: "recCompB",
      amount: 100,
      date: "2026-01-01",
      note: "inv 1",
      source_record_id: "rec1",
      source_table: "tblPay",
    },
    {
      id: "x-2",
      type: "payments",
      from: "recCompA",
      to: "recCompB",
      amount: 200,
      date: "2026-01-02",
      note: "inv 2",
      source_record_id: "rec2",
      source_table: "tblPay",
    },
  ];

  test("emits markers + both direction sections + table headers", () => {
    const block = renderRollupBlock({ incoming, outgoing, recordIndex: idx, ownerRecordIds: ["recCompA"] });
    expect(block.startsWith(ROLLUP_BEGIN)).toBe(true);
    expect(block.trimEnd().endsWith(ROLLUP_END)).toBe(true);
    expect(block).toContain("## Edges (incoming)");
    expect(block).toContain("## Edges (outgoing)");
    expect(block).toMatch(/\| Date \| Counterparty \| Amount \| Note \|/);
    expect(block).toMatch(/\| --- \| --- \| --- \| --- \|/);
  });

  test("sorts rows by date asc, then id asc within each direction", () => {
    const reversed: EdgeRow[] = [outgoing[1], outgoing[0]];
    const block = renderRollupBlock({
      incoming: [],
      outgoing: reversed,
      recordIndex: idx,
      ownerRecordIds: ["recCompA"],
    });
    const lines = block.split("\n");
    const i01 = lines.findIndex((l) => l.includes("2026-01-01"));
    const i02 = lines.findIndex((l) => l.includes("2026-01-02"));
    expect(i01).toBeLessThan(i02);
  });

  test("renders `_(none)_` for empty directions", () => {
    const block = renderRollupBlock({
      incoming: [],
      outgoing,
      recordIndex: idx,
      ownerRecordIds: ["recCompA"],
    });
    expect(block).toMatch(/## Edges \(incoming\)\n\n_\(none\)_/);
  });

  test("self-edges (counterparty == self) are dropped — not rendered to either direction", () => {
    const selfEdge: EdgeRow = {
      id: "x-self",
      type: "payments",
      from: "recCompA",
      to: "recCompA",
      amount: 1,
      date: "2026-02-01",
      source_record_id: "recSelf",
      source_table: "tblPay",
    };
    const block = renderRollupBlock({
      incoming: [selfEdge],
      outgoing: [selfEdge],
      recordIndex: idx,
      ownerRecordIds: ["recCompA"],
    });
    expect(block).not.toContain("recSelf");
  });
});

// ---------------------------------------------------------------------------
// applyRollupToPage — insert vs replace + non-rollup preservation
// ---------------------------------------------------------------------------

describe("applyRollupToPage", () => {
  const block = `${ROLLUP_BEGIN}\n\n## Edges (incoming)\n\n_(none)_\n\n## Edges (outgoing)\n\n_(none)_\n\n${ROLLUP_END}`;

  test("appends block to a page that has none", () => {
    const original = "---\nslug: a\n---\n\nbody\n";
    const out = applyRollupToPage(original, block);
    expect(out.startsWith(original.trimEnd())).toBe(true);
    expect(out).toContain(ROLLUP_BEGIN);
    expect(out).toContain(ROLLUP_END);
    expect(out.endsWith("\n")).toBe(true);
  });

  test("replaces an existing rollup block in place", () => {
    const original = `---\nslug: a\n---\n\nbody\n\n${ROLLUP_BEGIN}\nstale content\n${ROLLUP_END}\n\nfooter content\n`;
    const out = applyRollupToPage(original, block);
    expect(out).not.toContain("stale content");
    expect(out).toContain("footer content");
    expect(out).toContain("body");
    expect(out).toContain(ROLLUP_BEGIN);
    // exactly one BEGIN and one END after replacement
    expect(out.match(/<!-- BEGIN ROLLUP -->/g)?.length).toBe(1);
    expect(out.match(/<!-- END ROLLUP -->/g)?.length).toBe(1);
  });

  test("preserves all non-rollup content on rerun", () => {
    const original = `---\nslug: a\n---\n\n## Notes\n\nhand-written.\n\n${ROLLUP_BEGIN}\nold\n${ROLLUP_END}\n\n## More\n\ntrailing.\n`;
    const out = applyRollupToPage(original, block);
    expect(out).toContain("## Notes\n\nhand-written.");
    expect(out).toContain("## More\n\ntrailing.");
  });

  test("idempotent — applying the same block twice produces the same content", () => {
    const original = "---\nslug: a\n---\n\nbody\n";
    const once = applyRollupToPage(original, block);
    const twice = applyRollupToPage(once, block);
    expect(twice).toBe(once);
  });
});

// ---------------------------------------------------------------------------
// parseEdgesJsonl — basic round-trip
// ---------------------------------------------------------------------------

describe("parseEdgesJsonl", () => {
  test("parses one row per non-blank line", () => {
    const txt =
      '\n{"id":"a","type":"t","from":"f","to":"to","source_record_id":"r","source_table":"tbl"}\n\n';
    const rows = parseEdgesJsonl(txt);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("a");
  });

  test("returns empty on empty input", () => {
    expect(parseEdgesJsonl("")).toEqual([]);
  });

  test("ignores malformed lines without throwing", () => {
    const txt =
      '{"id":"a","type":"t","from":"f","to":"to","source_record_id":"r","source_table":"tbl"}\n{not-json\n';
    expect(parseEdgesJsonl(txt)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// rollupEdges — full flow: 3 edges → 2 entity pages each gain rollup
// ---------------------------------------------------------------------------

describe("rollupEdges (CLI flow) — 3 sample edges → 2 entity pages each gain rollup sections", () => {
  // Minimal fixture per AC#12 acceptance line.
  // recCompA + recCompB are the entities; 3 payments edges between them.
  function setupVault(): {
    vault: string;
    pageA: string;
    pageB: string;
  } {
    const vault = tmp;
    writeEdges(vault, [
      {
        id: "appBase-rec1",
        type: "payments",
        from: "recCompA",
        to: "recCompB",
        amount: 100,
        date: "2026-01-01",
        note: "inv 1",
        source_record_id: "rec1",
        source_table: "tblPay",
      },
      {
        id: "appBase-rec2",
        type: "payments",
        from: "recCompA",
        to: "recCompB",
        amount: 200,
        date: "2026-01-02",
        note: "inv 2",
        source_record_id: "rec2",
        source_table: "tblPay",
      },
      {
        id: "appBase-rec3",
        type: "payments",
        from: "recCompB",
        to: "recCompA",
        amount: 50,
        date: "2026-01-03",
        note: "refund",
        source_record_id: "rec3",
        source_table: "tblPay",
      },
    ]);
    const pageA = writeEntityPage(
      vault,
      "knowledge/companies/comp-a.md",
      {
        type: "company",
        slug: "comp-a",
        source_record_id: "recCompA",
        sources: ["recCompA"],
      },
      "Body of comp-a.\n",
    );
    const pageB = writeEntityPage(
      vault,
      "knowledge/companies/comp-b.md",
      {
        type: "company",
        slug: "comp-b",
        source_record_id: "recCompB",
        sources: ["recCompB"],
      },
      "Body of comp-b.\n",
    );
    return { vault, pageA, pageB };
  }

  test("happy path: both entity pages gain rollup blocks with correct directional rows", () => {
    const { vault, pageA, pageB } = setupVault();
    const result = rollupEdges({ vaultPath: vault });

    expect(result.entityPagesScanned).toBe(2);
    expect(result.pagesUpdated).toBe(2);
    expect(result.pagesSkipped).toBe(0);

    const aText = readFileSync(pageA, "utf8");
    expect(aText).toContain(ROLLUP_BEGIN);
    expect(aText).toContain(ROLLUP_END);
    expect(aText).toContain("## Edges (incoming)");
    expect(aText).toContain("## Edges (outgoing)");
    // counterparty resolved via record-index
    expect(aText).toContain("[[comp-b]]");
    // outgoing rows
    expect(aText).toMatch(/\| 2026-01-01 \| \[\[comp-b\]\] \| 100 \| inv 1 \|/);
    expect(aText).toMatch(/\| 2026-01-02 \| \[\[comp-b\]\] \| 200 \| inv 2 \|/);
    // incoming row
    expect(aText).toMatch(/\| 2026-01-03 \| \[\[comp-b\]\] \| 50 \| refund \|/);

    const bText = readFileSync(pageB, "utf8");
    expect(bText).toContain("[[comp-a]]");
    expect(bText).toMatch(/\| 2026-01-03 \| \[\[comp-a\]\] \| 50 \| refund \|/); // outgoing on B
    expect(bText).toMatch(/\| 2026-01-01 \| \[\[comp-a\]\] \| 100 \| inv 1 \|/); // incoming on B
  });

  test("idempotence: second consecutive run produces byte-identical pages (AC#12 contract)", () => {
    const { vault, pageA, pageB } = setupVault();
    rollupEdges({ vaultPath: vault });
    const a1 = readFileSync(pageA, "utf8");
    const b1 = readFileSync(pageB, "utf8");

    const r2 = rollupEdges({ vaultPath: vault });
    const a2 = readFileSync(pageA, "utf8");
    const b2 = readFileSync(pageB, "utf8");

    expect(a2).toBe(a1);
    expect(b2).toBe(b1);
    expect(r2.pagesUpdated).toBe(0); // no writes on second run
    expect(r2.pagesUntouched).toBe(2);
  });

  test("preserves hand-written sections on rerun", () => {
    const { vault, pageA } = setupVault();
    // Append a hand-written ## Notes section after first rollup.
    rollupEdges({ vaultPath: vault });
    const enriched = readFileSync(pageA, "utf8") + "\n## Notes\n\nhand-written addendum.\n";
    writeFileSync(pageA, enriched);

    rollupEdges({ vaultPath: vault });
    const after = readFileSync(pageA, "utf8");
    expect(after).toContain("## Notes\n\nhand-written addendum.");
    expect(after).toContain(ROLLUP_BEGIN);
  });

  test("page with no source_record_id is skipped (counted, not modified)", () => {
    const { vault } = setupVault();
    const orphanPath = writeEntityPage(
      vault,
      "knowledge/companies/no-record.md",
      { type: "company", slug: "no-record" },
      "no provenance.\n",
    );
    const before = readFileSync(orphanPath, "utf8");
    const result = rollupEdges({ vaultPath: vault });
    const after = readFileSync(orphanPath, "utf8");
    expect(after).toBe(before);
    expect(result.pagesSkipped).toBe(1);
  });

  test("entity page with zero matching edges and no existing markers stays untouched", () => {
    const { vault } = setupVault();
    const stranger = writeEntityPage(
      vault,
      "knowledge/companies/stranger.md",
      {
        type: "company",
        slug: "stranger",
        source_record_id: "recStranger",
      },
      "Stranger has no edges.\n",
    );
    const before = readFileSync(stranger, "utf8");
    const result = rollupEdges({ vaultPath: vault });
    const after = readFileSync(stranger, "utf8");
    expect(after).toBe(before);
    expect(result.pagesUntouched).toBeGreaterThanOrEqual(1);
  });

  test("counterparty resolves to record-id-in-code-tick when target page is missing", () => {
    const vault = tmp;
    writeEdges(vault, [
      {
        id: "appBase-rec99",
        type: "payments",
        from: "recCompA",
        to: "recOrphan",
        amount: 10,
        date: "2026-02-01",
        source_record_id: "rec99",
        source_table: "tblPay",
      },
    ]);
    const pageA = writeEntityPage(
      vault,
      "knowledge/companies/comp-a.md",
      { type: "company", slug: "comp-a", source_record_id: "recCompA" },
      "body\n",
    );
    rollupEdges({ vaultPath: vault });
    const text = readFileSync(pageA, "utf8");
    expect(text).toContain("`recOrphan`");
    expect(text).not.toContain("[[recOrphan]]");
  });

  test("returns gracefully with skipped result when edges.jsonl is absent", () => {
    const vault = tmp;
    writeEntityPage(
      vault,
      "knowledge/companies/comp-a.md",
      { type: "company", slug: "comp-a", source_record_id: "recCompA" },
    );
    const result = rollupEdges({ vaultPath: vault });
    expect(result.pagesUpdated).toBe(0);
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/edges\.jsonl/);
  });
});
