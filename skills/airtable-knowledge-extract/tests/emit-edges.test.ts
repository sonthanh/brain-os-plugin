/**
 * emit-edges.test.ts — interaction-table edge emitter (ai-brain#241, parent #237 AC#11).
 *
 * Pure helpers + a full `emitEdges()` flow with mocked fetch + Stage 0 cache,
 * exercising:
 *   - Schema-enforced JSONL rows (id, type, from, to, source_record_id, source_table).
 *   - Three distinct `from`/`to` rules in one fixture (two link fields populated;
 *     second link field with multiple IDs; single link field with ≥2 IDs).
 *   - Idempotence: re-running on same input produces a byte-identical file.
 *   - Last-write-wins by id on body changes.
 *   - Zero Sonnet: module-level import audit, plus a no-LLM-runner-API surface.
 *   - Orchestrator no-op fall-through when Stage 0 cache absent.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  slugify,
  deriveEdgeType,
  pickFromTo,
  pickAmount,
  pickDate,
  pickNote,
  buildEdgeRow,
  emitEdgesForTable,
  mergeEdgesById,
  parseJsonl,
  formatJsonl,
  emitEdges,
  type EdgeRow,
} from "../scripts/emit-edges.mts";
import type { AirtableTable } from "../scripts/classify-clusters.mts";
import type { AirtableRecord } from "../scripts/legacy-link-detector.mts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "emit-edges-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("slugify / deriveEdgeType", () => {
  test("lowercases + replaces non-alphanumerics with hyphen", () => {
    expect(slugify("Payments")).toBe("payments");
    expect(slugify("Sales Activities")).toBe("sales-activities");
    expect(slugify("PnL Reports")).toBe("pnl-reports");
    expect(slugify("Cash flows!")).toBe("cash-flows");
  });

  test("trims leading + trailing hyphens", () => {
    expect(slugify("  Payments  ")).toBe("payments");
    expect(slugify("__Payments__")).toBe("payments");
  });

  test("collapses runs of separators", () => {
    expect(slugify("Sales — Activities")).toBe("sales-activities");
  });

  test("does NOT singularize (intentional — fragile heuristic)", () => {
    expect(deriveEdgeType("Payments")).toBe("payments");
    expect(deriveEdgeType("Cashflows")).toBe("cashflows");
  });
});

// ---------------------------------------------------------------------------
// pickFromTo — three distinct rules, one fixture
// ---------------------------------------------------------------------------

describe("pickFromTo", () => {
  test("rule (a) — two link fields, each with one linked id", () => {
    const table: AirtableTable = {
      id: "tblA",
      name: "Payments",
      fields: [
        { id: "f1", name: "Reference Number", type: "singleLineText" },
        {
          id: "f2",
          name: "Payer",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblCompanies" },
        },
        {
          id: "f3",
          name: "Payee",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblCompanies" },
        },
      ],
    };
    const record: AirtableRecord = {
      id: "rec001",
      fields: {
        "Reference Number": "PAY-001",
        Payer: ["recCompA"],
        Payee: ["recCompB"],
      },
    };
    const ft = pickFromTo(table, record);
    expect(ft).toEqual({ from: "recCompA", to: "recCompB" });
  });

  test("rule (b) — two link fields, second has multiple IDs (only [0] is taken)", () => {
    const table: AirtableTable = {
      id: "tblA",
      name: "Payments",
      fields: [
        {
          id: "f1",
          name: "Source Account",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblAccounts" },
        },
        {
          id: "f2",
          name: "Tags",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblTags" },
        },
      ],
    };
    const record: AirtableRecord = {
      id: "rec002",
      fields: {
        "Source Account": ["recAccountX"],
        Tags: ["recTag1", "recTag2", "recTag3"],
      },
    };
    expect(pickFromTo(table, record)).toEqual({
      from: "recAccountX",
      to: "recTag1",
    });
  });

  test("rule (c) — single link field with ≥2 IDs uses [0] and [1]", () => {
    const table: AirtableTable = {
      id: "tblA",
      name: "Meetings",
      fields: [
        {
          id: "f1",
          name: "Attendees",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblPeople" },
        },
      ],
    };
    const record: AirtableRecord = {
      id: "rec003",
      fields: { Attendees: ["recPersonA", "recPersonB", "recPersonC"] },
    };
    expect(pickFromTo(table, record)).toEqual({
      from: "recPersonA",
      to: "recPersonB",
    });
  });

  test("returns null when single link field carries only 1 id", () => {
    const table: AirtableTable = {
      id: "tblA",
      name: "Payments",
      fields: [
        {
          id: "f1",
          name: "Payer",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblCompanies" },
        },
      ],
    };
    const record: AirtableRecord = {
      id: "rec004",
      fields: { Payer: ["recCompA"] },
    };
    expect(pickFromTo(table, record)).toBeNull();
  });

  test("returns null when no link fields carry content", () => {
    const table: AirtableTable = {
      id: "tblA",
      name: "Payments",
      fields: [
        {
          id: "f1",
          name: "Payer",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblCompanies" },
        },
        { id: "f2", name: "Note", type: "singleLineText" },
      ],
    };
    const record: AirtableRecord = {
      id: "rec005",
      fields: { Note: "lonely note" },
    };
    expect(pickFromTo(table, record)).toBeNull();
  });

  test("ignores non-link fields entirely", () => {
    const table: AirtableTable = {
      id: "tblA",
      name: "Payments",
      fields: [
        { id: "f1", name: "Amount", type: "number" },
        {
          id: "f2",
          name: "Payer",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblCompanies" },
        },
        {
          id: "f3",
          name: "Payee",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblCompanies" },
        },
      ],
    };
    const record: AirtableRecord = {
      id: "rec006",
      fields: { Amount: 100, Payer: ["recA"], Payee: ["recB"] },
    };
    expect(pickFromTo(table, record)).toEqual({ from: "recA", to: "recB" });
  });

  test("walks fields in schema order, not record-fields order", () => {
    const table: AirtableTable = {
      id: "tblA",
      name: "X",
      fields: [
        {
          id: "f1",
          name: "Alpha",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblT" },
        },
        {
          id: "f2",
          name: "Beta",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblT" },
        },
      ],
    };
    const record: AirtableRecord = {
      id: "rec007",
      // record fields object iteration order would put Beta first, but pickFromTo
      // must still walk the schema in declared order → Alpha first, Beta second.
      fields: { Beta: ["recBeta"], Alpha: ["recAlpha"] },
    };
    expect(pickFromTo(table, record)).toEqual({
      from: "recAlpha",
      to: "recBeta",
    });
  });
});

// ---------------------------------------------------------------------------
// pickAmount / pickDate / pickNote
// ---------------------------------------------------------------------------

describe("pickAmount", () => {
  test("matches Amount/Inflow/Outflow/Net/Total/Value/Sum (case-insensitive)", () => {
    const t: AirtableTable = {
      id: "t",
      name: "X",
      fields: [
        { id: "f1", name: "Amount", type: "number" },
        { id: "f2", name: "Misc", type: "number" },
      ],
    };
    expect(pickAmount(t, { id: "r", fields: { Amount: 42, Misc: 99 } })).toBe(42);
  });

  test("returns undefined when no matching field exists", () => {
    const t: AirtableTable = {
      id: "t",
      name: "X",
      fields: [{ id: "f1", name: "Comment", type: "singleLineText" }],
    };
    expect(pickAmount(t, { id: "r", fields: { Comment: "hi" } })).toBeUndefined();
  });

  test("returns undefined when matching field is empty/null on the record", () => {
    const t: AirtableTable = {
      id: "t",
      name: "X",
      fields: [{ id: "f1", name: "Amount", type: "number" }],
    };
    expect(pickAmount(t, { id: "r", fields: {} })).toBeUndefined();
  });

  test("coerces numeric strings to number", () => {
    const t: AirtableTable = {
      id: "t",
      name: "X",
      fields: [{ id: "f1", name: "Total", type: "number" }],
    };
    expect(pickAmount(t, { id: "r", fields: { Total: "123.5" } })).toBe(123.5);
  });
});

describe("pickDate", () => {
  test("matches Date/Timestamp/When", () => {
    const t: AirtableTable = {
      id: "t",
      name: "X",
      fields: [{ id: "f1", name: "Date", type: "date" }],
    };
    expect(pickDate(t, { id: "r", fields: { Date: "2026-01-01" } })).toBe(
      "2026-01-01",
    );
  });

  test("returns undefined when no matching field exists", () => {
    const t: AirtableTable = {
      id: "t",
      name: "X",
      fields: [{ id: "f1", name: "Note", type: "singleLineText" }],
    };
    expect(pickDate(t, { id: "r", fields: { Note: "hi" } })).toBeUndefined();
  });
});

describe("pickNote", () => {
  test("matches Note/Notes/Description/Memo/Comment", () => {
    const t: AirtableTable = {
      id: "t",
      name: "X",
      fields: [{ id: "f1", name: "Note", type: "singleLineText" }],
    };
    expect(pickNote(t, { id: "r", fields: { Note: "hello" } })).toBe("hello");
  });

  test("returns undefined when matching field is empty string", () => {
    const t: AirtableTable = {
      id: "t",
      name: "X",
      fields: [{ id: "f1", name: "Note", type: "singleLineText" }],
    };
    expect(pickNote(t, { id: "r", fields: { Note: "" } })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildEdgeRow / emitEdgesForTable
// ---------------------------------------------------------------------------

describe("buildEdgeRow", () => {
  test("produces full schema with required + optional fields populated", () => {
    const table: AirtableTable = {
      id: "tblPay",
      name: "Payments",
      fields: [
        { id: "f1", name: "Reference Number", type: "singleLineText" },
        { id: "f2", name: "Amount", type: "number" },
        { id: "f3", name: "Date", type: "date" },
        {
          id: "f4",
          name: "Payer",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblCompanies" },
        },
        {
          id: "f5",
          name: "Payee",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblCompanies" },
        },
        { id: "f6", name: "Note", type: "singleLineText" },
      ],
    };
    const record: AirtableRecord = {
      id: "rec001",
      fields: {
        "Reference Number": "PAY-001",
        Amount: 100,
        Date: "2026-01-01",
        Payer: ["recCompA"],
        Payee: ["recCompB"],
        Note: "invoice 1",
      },
    };
    const row = buildEdgeRow(table, record, "appBaseTest");
    expect(row).toEqual({
      id: "appBaseTest-rec001",
      type: "payments",
      from: "recCompA",
      to: "recCompB",
      amount: 100,
      date: "2026-01-01",
      note: "invoice 1",
      source_record_id: "rec001",
      source_table: "tblPay",
    });
  });

  test("omits optional fields when they aren't present", () => {
    const table: AirtableTable = {
      id: "tblPay",
      name: "Payments",
      fields: [
        {
          id: "f1",
          name: "Payer",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblCompanies" },
        },
        {
          id: "f2",
          name: "Payee",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblCompanies" },
        },
      ],
    };
    const record: AirtableRecord = {
      id: "rec099",
      fields: { Payer: ["recA"], Payee: ["recB"] },
    };
    const row = buildEdgeRow(table, record, "appBaseTest");
    expect(row).toEqual({
      id: "appBaseTest-rec099",
      type: "payments",
      from: "recA",
      to: "recB",
      source_record_id: "rec099",
      source_table: "tblPay",
    });
    expect(row).not.toHaveProperty("amount");
    expect(row).not.toHaveProperty("date");
    expect(row).not.toHaveProperty("note");
  });

  test("returns null when from/to cannot be derived", () => {
    const table: AirtableTable = {
      id: "tblPay",
      name: "Payments",
      fields: [
        {
          id: "f1",
          name: "Payer",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblCompanies" },
        },
      ],
    };
    const record: AirtableRecord = {
      id: "recOrphan",
      fields: { Payer: ["recA"] }, // single link field, single id → null
    };
    expect(buildEdgeRow(table, record, "appBaseTest")).toBeNull();
  });
});

describe("emitEdgesForTable — three sample interaction records → 3 JSONL rows", () => {
  // The fixture deliberately covers all three from/to derivation rules within
  // one table — see grill verdicts (parent #237 D7) on edge schema.
  const table: AirtableTable = {
    id: "tblPay",
    name: "Payments",
    fields: [
      { id: "f1", name: "Reference Number", type: "singleLineText" },
      { id: "f2", name: "Amount", type: "number" },
      { id: "f3", name: "Date", type: "date" },
      {
        id: "f4",
        name: "Payer",
        type: "multipleRecordLinks",
        options: { linkedTableId: "tblCompanies" },
      },
      {
        id: "f5",
        name: "Payee",
        type: "multipleRecordLinks",
        options: { linkedTableId: "tblCompanies" },
      },
      { id: "f6", name: "Note", type: "singleLineText" },
    ],
  };
  const records: AirtableRecord[] = [
    // (a) two link fields populated, both with one id
    {
      id: "rec001",
      fields: {
        "Reference Number": "PAY-001",
        Amount: 100,
        Date: "2026-01-01",
        Payer: ["recCompA"],
        Payee: ["recCompB"],
        Note: "invoice 1",
      },
    },
    // (b) two link fields, second has multiple IDs — only [0] taken
    {
      id: "rec002",
      fields: {
        "Reference Number": "PAY-002",
        Amount: 200,
        Date: "2026-01-02",
        Payer: ["recCompA"],
        Payee: ["recCompC", "recCompD", "recCompE"],
        Note: "invoice 2",
      },
    },
    // (c) only first link field populated, but with ≥2 IDs — IDs[0]/[1]
    {
      id: "rec003",
      fields: {
        "Reference Number": "PAY-003",
        Amount: 300,
        Date: "2026-01-03",
        Payer: ["recCompD", "recCompB"],
        Note: "invoice 3",
      },
    },
  ];

  test("emits exactly 3 rows, one per record", () => {
    const result = emitEdgesForTable({ table, records, baseId: "appBaseTest" });
    expect(result.rows).toHaveLength(3);
    expect(result.skipped).toHaveLength(0);
  });

  test("each row has the full required schema", () => {
    const { rows } = emitEdgesForTable({ table, records, baseId: "appBaseTest" });
    for (const r of rows) {
      expect(typeof r.id).toBe("string");
      expect(r.id.length).toBeGreaterThan(0);
      expect(typeof r.type).toBe("string");
      expect(typeof r.from).toBe("string");
      expect(typeof r.to).toBe("string");
      expect(typeof r.source_record_id).toBe("string");
      expect(typeof r.source_table).toBe("string");
    }
  });

  test("rule (a) — rec001 has from=recCompA to=recCompB", () => {
    const { rows } = emitEdgesForTable({ table, records, baseId: "appBaseTest" });
    const r = rows.find((x) => x.source_record_id === "rec001")!;
    expect(r.from).toBe("recCompA");
    expect(r.to).toBe("recCompB");
    expect(r.amount).toBe(100);
    expect(r.date).toBe("2026-01-01");
    expect(r.note).toBe("invoice 1");
  });

  test("rule (b) — rec002 has from=recCompA to=recCompC (only first ID of second field)", () => {
    const { rows } = emitEdgesForTable({ table, records, baseId: "appBaseTest" });
    const r = rows.find((x) => x.source_record_id === "rec002")!;
    expect(r.from).toBe("recCompA");
    expect(r.to).toBe("recCompC");
  });

  test("rule (c) — rec003 has from=recCompD to=recCompB (single field, IDs[0]/[1])", () => {
    const { rows } = emitEdgesForTable({ table, records, baseId: "appBaseTest" });
    const r = rows.find((x) => x.source_record_id === "rec003")!;
    expect(r.from).toBe("recCompD");
    expect(r.to).toBe("recCompB");
  });

  test("type slug matches the table name (lower-kebab, no singularization)", () => {
    const { rows } = emitEdgesForTable({ table, records, baseId: "appBaseTest" });
    expect(rows.every((r) => r.type === "payments")).toBe(true);
  });

  test("ids are baseId-recordId (cross-base safe)", () => {
    const { rows } = emitEdgesForTable({ table, records, baseId: "appBaseTest" });
    expect(new Set(rows.map((r) => r.id))).toEqual(
      new Set(["appBaseTest-rec001", "appBaseTest-rec002", "appBaseTest-rec003"]),
    );
  });

  test("orphan records (no from/to derivable) are surfaced via `skipped`, not silently dropped", () => {
    const orphanTable: AirtableTable = {
      id: "tblOrphan",
      name: "Orphans",
      fields: [
        {
          id: "f1",
          name: "Solo",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblTarget" },
        },
      ],
    };
    const orphanRecords: AirtableRecord[] = [
      { id: "recA", fields: { Solo: ["recOnly"] } }, // single link, single id → skip
      { id: "recB", fields: {} }, // empty → skip
    ];
    const result = emitEdgesForTable({
      table: orphanTable,
      records: orphanRecords,
      baseId: "appBaseTest",
    });
    expect(result.rows).toHaveLength(0);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.map((s) => s.recordId).sort()).toEqual(["recA", "recB"]);
  });
});

// ---------------------------------------------------------------------------
// JSONL serialize/parse + merge dedup
// ---------------------------------------------------------------------------

describe("formatJsonl / parseJsonl round-trip", () => {
  test("formats one row per line with trailing newline", () => {
    const rows: EdgeRow[] = [
      {
        id: "appB-rec1",
        type: "payments",
        from: "recA",
        to: "recB",
        source_record_id: "rec1",
        source_table: "tblPay",
      },
    ];
    const txt = formatJsonl(rows);
    expect(txt.endsWith("\n")).toBe(true);
    expect(txt.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
  });

  test("round-trips losslessly", () => {
    const rows: EdgeRow[] = [
      {
        id: "appB-rec1",
        type: "payments",
        from: "recA",
        to: "recB",
        amount: 42,
        date: "2026-01-01",
        note: "n1",
        source_record_id: "rec1",
        source_table: "tblPay",
      },
    ];
    expect(parseJsonl(formatJsonl(rows))).toEqual(rows);
  });

  test("parseJsonl tolerates blank lines and trims", () => {
    const txt =
      '\n{"id":"a","type":"t","from":"f","to":"to","source_record_id":"r","source_table":"tbl"}\n\n';
    const rows = parseJsonl(txt);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("a");
  });
});

describe("mergeEdgesById — last-write-wins", () => {
  test("incoming rows overwrite existing rows with same id", () => {
    const existing: EdgeRow[] = [
      {
        id: "x-rec1",
        type: "payments",
        from: "recA",
        to: "recB",
        note: "old",
        source_record_id: "rec1",
        source_table: "tbl",
      },
    ];
    const incoming: EdgeRow[] = [
      {
        id: "x-rec1",
        type: "payments",
        from: "recA",
        to: "recB",
        note: "new",
        source_record_id: "rec1",
        source_table: "tbl",
      },
    ];
    const { merged, added, updated } = mergeEdgesById(existing, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0].note).toBe("new");
    expect(added).toBe(0);
    expect(updated).toBe(1);
  });

  test("incoming rows with new ids are added", () => {
    const existing: EdgeRow[] = [
      {
        id: "x-rec1",
        type: "t",
        from: "a",
        to: "b",
        source_record_id: "rec1",
        source_table: "tbl",
      },
    ];
    const incoming: EdgeRow[] = [
      {
        id: "x-rec2",
        type: "t",
        from: "c",
        to: "d",
        source_record_id: "rec2",
        source_table: "tbl",
      },
    ];
    const { merged, added, updated } = mergeEdgesById(existing, incoming);
    expect(merged).toHaveLength(2);
    expect(added).toBe(1);
    expect(updated).toBe(0);
  });

  test("merged output is stable-sorted by id (so re-runs produce byte-identical files)", () => {
    const existing: EdgeRow[] = [
      {
        id: "x-rec3",
        type: "t",
        from: "a",
        to: "b",
        source_record_id: "rec3",
        source_table: "tbl",
      },
    ];
    const incoming: EdgeRow[] = [
      {
        id: "x-rec1",
        type: "t",
        from: "a",
        to: "b",
        source_record_id: "rec1",
        source_table: "tbl",
      },
      {
        id: "x-rec2",
        type: "t",
        from: "a",
        to: "b",
        source_record_id: "rec2",
        source_table: "tbl",
      },
    ];
    const { merged } = mergeEdgesById(existing, incoming);
    expect(merged.map((r) => r.id)).toEqual(["x-rec1", "x-rec2", "x-rec3"]);
  });
});

// ---------------------------------------------------------------------------
// emitEdges — full flow with mocked fetch + Stage 0 cache
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
}

function makeFetch(
  routes: Array<{ match: RegExp; status?: number; body: unknown }>,
): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, _init) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url });
    for (const r of routes) {
      if (r.match.test(url)) {
        return new Response(JSON.stringify(r.body), {
          status: r.status ?? 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ error: "no match" }), { status: 404 });
  };
  return { fetch: fetchImpl, calls };
}

function writeStageZeroCache(
  cacheDir: string,
  baseId: string,
  classifications: Record<
    string,
    { type: "entity" | "interaction" | "reject"; reasoning: string; schema_hash: string; classified_at: string }
  >,
): string {
  mkdirSync(cacheDir, { recursive: true });
  const path = join(cacheDir, `${baseId}.json`);
  writeFileSync(path, JSON.stringify(classifications, null, 2));
  return path;
}

function makeFixtureBase(): {
  baseId: string;
  table: AirtableTable;
  records: AirtableRecord[];
} {
  const baseId = "appFixture001";
  const table: AirtableTable = {
    id: "tblPayments",
    name: "Payments",
    fields: [
      { id: "f1", name: "Reference Number", type: "singleLineText" },
      { id: "f2", name: "Amount", type: "number" },
      { id: "f3", name: "Date", type: "date" },
      {
        id: "f4",
        name: "Payer",
        type: "multipleRecordLinks",
        options: { linkedTableId: "tblCompanies" },
      },
      {
        id: "f5",
        name: "Payee",
        type: "multipleRecordLinks",
        options: { linkedTableId: "tblCompanies" },
      },
      { id: "f6", name: "Note", type: "singleLineText" },
    ],
  };
  const records: AirtableRecord[] = [
    {
      id: "rec001",
      fields: {
        "Reference Number": "PAY-001",
        Amount: 100,
        Date: "2026-01-01",
        Payer: ["recCompA"],
        Payee: ["recCompB"],
        Note: "invoice 1",
      },
    },
    {
      id: "rec002",
      fields: {
        "Reference Number": "PAY-002",
        Amount: 200,
        Date: "2026-01-02",
        Payer: ["recCompA"],
        Payee: ["recCompC"],
        Note: "invoice 2",
      },
    },
    {
      id: "rec003",
      fields: {
        "Reference Number": "PAY-003",
        Amount: 300,
        Date: "2026-01-03",
        Payer: ["recCompD"],
        Payee: ["recCompB"],
        Note: "invoice 3",
      },
    },
  ];
  return { baseId, table, records };
}

describe("emitEdges (CLI flow) — Stage 0 cache + Airtable Records API + JSONL write", () => {
  test("happy path: 3 records → 3 JSONL rows in vault/knowledge/graph/edges.jsonl", async () => {
    const { baseId, table, records } = makeFixtureBase();
    const cacheDir = join(tmp, "cache", "table-types");
    writeStageZeroCache(cacheDir, baseId, {
      [table.id]: {
        type: "interaction",
        reasoning: "money + 2 link fields",
        schema_hash: "abc",
        classified_at: "2026-05-05T00:00:00Z",
      },
    });

    const vaultPath = join(tmp, "vault");
    const { fetch } = makeFetch([
      {
        match: new RegExp(`/v0/meta/bases/${baseId}/tables`),
        body: { tables: [table] },
      },
      {
        match: new RegExp(`/v0/${baseId}/${table.id}`),
        body: { records },
      },
    ]);

    const result = await emitEdges(baseId, {
      fetch,
      vaultPath,
      cacheBaseDir: cacheDir,
      env: { AIRTABLE_API_KEY: "test-token" },
    });

    expect(result.skipped).toBe(false);
    expect(result.tablesProcessed).toEqual([table.id]);
    expect(result.edgesWritten).toBe(3);
    expect(result.edgesAdded).toBe(3);
    expect(result.edgesUpdated).toBe(0);

    const edgesPath = join(vaultPath, "knowledge", "graph", "edges.jsonl");
    expect(existsSync(edgesPath)).toBe(true);
    const rows = parseJsonl(readFileSync(edgesPath, "utf8"));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.type === "payments")).toBe(true);
    expect(rows.map((r) => r.source_record_id).sort()).toEqual([
      "rec001",
      "rec002",
      "rec003",
    ]);
  });

  test("idempotence: re-running produces a byte-identical file", async () => {
    const { baseId, table, records } = makeFixtureBase();
    const cacheDir = join(tmp, "cache", "table-types");
    writeStageZeroCache(cacheDir, baseId, {
      [table.id]: {
        type: "interaction",
        reasoning: "x",
        schema_hash: "abc",
        classified_at: "2026-05-05T00:00:00Z",
      },
    });
    const vaultPath = join(tmp, "vault");

    // First run
    const { fetch: fetch1 } = makeFetch([
      {
        match: new RegExp(`/v0/meta/bases/${baseId}/tables`),
        body: { tables: [table] },
      },
      {
        match: new RegExp(`/v0/${baseId}/${table.id}`),
        body: { records },
      },
    ]);
    await emitEdges(baseId, {
      fetch: fetch1,
      vaultPath,
      cacheBaseDir: cacheDir,
      env: { AIRTABLE_API_KEY: "test-token" },
    });
    const edgesPath = join(vaultPath, "knowledge", "graph", "edges.jsonl");
    const after1 = readFileSync(edgesPath, "utf8");

    // Second run with identical input
    const { fetch: fetch2 } = makeFetch([
      {
        match: new RegExp(`/v0/meta/bases/${baseId}/tables`),
        body: { tables: [table] },
      },
      {
        match: new RegExp(`/v0/${baseId}/${table.id}`),
        body: { records },
      },
    ]);
    const r2 = await emitEdges(baseId, {
      fetch: fetch2,
      vaultPath,
      cacheBaseDir: cacheDir,
      env: { AIRTABLE_API_KEY: "test-token" },
    });
    const after2 = readFileSync(edgesPath, "utf8");

    expect(after1).toBe(after2);
    expect(r2.edgesAdded).toBe(0);
    expect(r2.edgesUpdated).toBe(3); // same id, body equal — still counted as overwrite
    expect(r2.edgesWritten).toBe(3);
  });

  test("last-write-wins: edited record body overwrites prior row, others untouched", async () => {
    const { baseId, table, records } = makeFixtureBase();
    const cacheDir = join(tmp, "cache", "table-types");
    writeStageZeroCache(cacheDir, baseId, {
      [table.id]: {
        type: "interaction",
        reasoning: "x",
        schema_hash: "abc",
        classified_at: "2026-05-05T00:00:00Z",
      },
    });
    const vaultPath = join(tmp, "vault");

    // First run
    const { fetch: fetch1 } = makeFetch([
      {
        match: new RegExp(`/v0/meta/bases/${baseId}/tables`),
        body: { tables: [table] },
      },
      {
        match: new RegExp(`/v0/${baseId}/${table.id}`),
        body: { records },
      },
    ]);
    await emitEdges(baseId, {
      fetch: fetch1,
      vaultPath,
      cacheBaseDir: cacheDir,
      env: { AIRTABLE_API_KEY: "test-token" },
    });

    // Second run with rec002.note edited
    const editedRecords = records.map((r) =>
      r.id === "rec002"
        ? { ...r, fields: { ...r.fields, Note: "EDITED invoice 2" } }
        : r,
    );
    const { fetch: fetch2 } = makeFetch([
      {
        match: new RegExp(`/v0/meta/bases/${baseId}/tables`),
        body: { tables: [table] },
      },
      {
        match: new RegExp(`/v0/${baseId}/${table.id}`),
        body: { records: editedRecords },
      },
    ]);
    await emitEdges(baseId, {
      fetch: fetch2,
      vaultPath,
      cacheBaseDir: cacheDir,
      env: { AIRTABLE_API_KEY: "test-token" },
    });

    const edgesPath = join(vaultPath, "knowledge", "graph", "edges.jsonl");
    const rows = parseJsonl(readFileSync(edgesPath, "utf8"));
    expect(rows).toHaveLength(3);
    const r2 = rows.find((r) => r.source_record_id === "rec002")!;
    expect(r2.note).toBe("EDITED invoice 2");
    const r1 = rows.find((r) => r.source_record_id === "rec001")!;
    expect(r1.note).toBe("invoice 1");
    const r3 = rows.find((r) => r.source_record_id === "rec003")!;
    expect(r3.note).toBe("invoice 3");
  });

  test("paginated Airtable response: follows `offset` to fetch all records", async () => {
    const { baseId, table, records } = makeFixtureBase();
    const cacheDir = join(tmp, "cache", "table-types");
    writeStageZeroCache(cacheDir, baseId, {
      [table.id]: {
        type: "interaction",
        reasoning: "x",
        schema_hash: "abc",
        classified_at: "2026-05-05T00:00:00Z",
      },
    });
    const vaultPath = join(tmp, "vault");

    let recordsCallCount = 0;
    const fetchImpl: typeof globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (new RegExp(`/v0/meta/bases/${baseId}/tables`).test(url)) {
        return new Response(JSON.stringify({ tables: [table] }), { status: 200 });
      }
      if (new RegExp(`/v0/${baseId}/${table.id}`).test(url)) {
        recordsCallCount++;
        if (recordsCallCount === 1) {
          // First page returns 2 records + offset
          return new Response(
            JSON.stringify({ records: records.slice(0, 2), offset: "page2" }),
            { status: 200 },
          );
        }
        // Second page returns the rest with no offset
        return new Response(JSON.stringify({ records: records.slice(2) }), {
          status: 200,
        });
      }
      return new Response("{}", { status: 404 });
    };

    const result = await emitEdges(baseId, {
      fetch: fetchImpl,
      vaultPath,
      cacheBaseDir: cacheDir,
      env: { AIRTABLE_API_KEY: "test-token" },
    });

    expect(recordsCallCount).toBe(2);
    expect(result.edgesWritten).toBe(3);
  });

  test("no Stage 0 cache → skipped: true (no file written, no fetch calls)", async () => {
    const baseId = "appNoCache";
    const cacheDir = join(tmp, "cache", "table-types"); // not populated
    const vaultPath = join(tmp, "vault");

    const { fetch, calls } = makeFetch([]);
    const result = await emitEdges(baseId, {
      fetch,
      vaultPath,
      cacheBaseDir: cacheDir,
      env: { AIRTABLE_API_KEY: "test-token" },
    });

    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/Stage 0 cache/i);
    expect(result.edgesWritten).toBe(0);
    expect(calls).toHaveLength(0);
    expect(existsSync(join(vaultPath, "knowledge", "graph", "edges.jsonl"))).toBe(
      false,
    );
  });

  test("Stage 0 cache exists but no interaction tables → skipped: true (no fetch, no file)", async () => {
    const baseId = "appAllEntity";
    const cacheDir = join(tmp, "cache", "table-types");
    writeStageZeroCache(cacheDir, baseId, {
      tblA: {
        type: "entity",
        reasoning: "x",
        schema_hash: "h",
        classified_at: "2026-05-05T00:00:00Z",
      },
      tblB: {
        type: "reject",
        reasoning: "x",
        schema_hash: "h",
        classified_at: "2026-05-05T00:00:00Z",
      },
    });
    const vaultPath = join(tmp, "vault");
    const { fetch, calls } = makeFetch([]);

    const result = await emitEdges(baseId, {
      fetch,
      vaultPath,
      cacheBaseDir: cacheDir,
      env: { AIRTABLE_API_KEY: "test-token" },
    });

    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/no interaction tables/i);
    expect(calls).toHaveLength(0);
    expect(existsSync(join(vaultPath, "knowledge", "graph", "edges.jsonl"))).toBe(
      false,
    );
  });

  test("creates knowledge/graph directory at runtime if absent", async () => {
    const { baseId, table, records } = makeFixtureBase();
    const cacheDir = join(tmp, "cache", "table-types");
    writeStageZeroCache(cacheDir, baseId, {
      [table.id]: {
        type: "interaction",
        reasoning: "x",
        schema_hash: "h",
        classified_at: "2026-05-05T00:00:00Z",
      },
    });
    const vaultPath = join(tmp, "vault");
    expect(existsSync(join(vaultPath, "knowledge", "graph"))).toBe(false);

    const { fetch } = makeFetch([
      {
        match: new RegExp(`/v0/meta/bases/${baseId}/tables`),
        body: { tables: [table] },
      },
      {
        match: new RegExp(`/v0/${baseId}/${table.id}`),
        body: { records },
      },
    ]);
    await emitEdges(baseId, {
      fetch,
      vaultPath,
      cacheBaseDir: cacheDir,
      env: { AIRTABLE_API_KEY: "test-token" },
    });

    expect(existsSync(join(vaultPath, "knowledge", "graph", "edges.jsonl"))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Zero-Sonnet — module-level import audit (parent #237 AC#11)
// ---------------------------------------------------------------------------

describe("Zero Sonnet — emit-edges.mts has no LLM imports or runners", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(here, "..", "scripts", "emit-edges.mts");
  const source = readFileSync(scriptPath, "utf8");

  test("module source has no anthropic / claude / spawn(claude) imports or invocations", () => {
    // Allow the words to appear in comments (e.g. "Zero Sonnet calls" docstring),
    // so we check for actual imports/invocations rather than substring presence.
    expect(source).not.toMatch(/^\s*import[^;]+from ["']@anthropic-ai\/sdk["']/m);
    expect(source).not.toMatch(/^\s*import[^;]+from ["']anthropic["']/m);
    // Reject any `spawn("claude"` or `spawn('claude'` invocation.
    expect(source).not.toMatch(/spawn\s*\(\s*["']claude["']/);
    // Reject any execFileSync/exec("claude") invocation.
    expect(source).not.toMatch(/execFile(?:Sync)?\s*\(\s*["']claude["']/);
    expect(source).not.toMatch(/exec\s*\(\s*["']claude["']/);
  });

  test("public API exposes no LLM-runner / model parameter", () => {
    // If a runClassifier or model parameter ever leaks into emit-edges, this
    // test catches the regression. The contract is: edge emission is purely
    // deterministic — no LLM dep, no token counter, no model name.
    expect(source).not.toMatch(/\brunClassifier\b/);
    expect(source).not.toMatch(/\bSONNET\b|\bclaude-sonnet\b|\bclaude-opus\b/);
  });
});

// ---------------------------------------------------------------------------
// pickEntityFromTo + buildEdgeRow with classification (ai-brain#251 S7 update)
// ---------------------------------------------------------------------------

describe("pickEntityFromTo (S7 / S5a integration)", () => {
  test("returns entity slugs for from-like + to-like classified text fields", async () => {
    const { pickEntityFromTo } = await import("../scripts/emit-edges.mts");
    const table: AirtableTable = {
      id: "tblPay",
      name: "Payments",
      fields: [
        { id: "f1", name: "Payer Name", type: "singleLineText" },
        { id: "f2", name: "Payee Name", type: "singleLineText" },
      ],
    };
    const record: AirtableRecord = {
      id: "rec1",
      fields: { "Payer Name": "John Doe", "Payee Name": "Acme Corp" },
    };
    const cls = {
      schema_hash: "h",
      classified_at: "t",
      fields: {
        "Payer Name": {
          kind: "person" as const,
          role: "from-like" as const,
          confidence: 0.95,
          reasoning: "x",
        },
        "Payee Name": {
          kind: "company" as const,
          role: "to-like" as const,
          confidence: 0.95,
          reasoning: "x",
        },
      },
    };
    expect(pickEntityFromTo(table, record, cls)).toEqual({
      from: "john-doe",
      to: "acme-corp",
    });
  });

  test("returns {} when classification is undefined", async () => {
    const { pickEntityFromTo } = await import("../scripts/emit-edges.mts");
    const table: AirtableTable = { id: "t", name: "T", fields: [] };
    const record: AirtableRecord = { id: "r", fields: {} };
    expect(pickEntityFromTo(table, record, undefined)).toEqual({});
  });

  test("ignores undirected + none roles", async () => {
    const { pickEntityFromTo } = await import("../scripts/emit-edges.mts");
    const table: AirtableTable = {
      id: "t",
      name: "T",
      fields: [
        { id: "f1", name: "Owner", type: "singleLineText" },
        { id: "f2", name: "Note", type: "singleLineText" },
      ],
    };
    const record: AirtableRecord = {
      id: "r",
      fields: { Owner: "Alice", Note: "ignore" },
    };
    const cls = {
      schema_hash: "h",
      classified_at: "t",
      fields: {
        Owner: {
          kind: "person" as const,
          role: "undirected" as const,
          confidence: 0.95,
          reasoning: "x",
        },
        Note: {
          kind: "none" as const,
          role: "none" as const,
          confidence: 0.95,
          reasoning: "x",
        },
      },
    };
    expect(pickEntityFromTo(table, record, cls)).toEqual({});
  });

  test("trims + canonicalises so 'JOHN  DOE' yields same slug as 'john doe'", async () => {
    const { pickEntityFromTo } = await import("../scripts/emit-edges.mts");
    const table: AirtableTable = {
      id: "t",
      name: "T",
      fields: [{ id: "f1", name: "Payer Name", type: "singleLineText" }],
    };
    const cls = {
      schema_hash: "h",
      classified_at: "t",
      fields: {
        "Payer Name": {
          kind: "person" as const,
          role: "from-like" as const,
          confidence: 0.95,
          reasoning: "x",
        },
      },
    };
    const r1 = { id: "r1", fields: { "Payer Name": "John Doe" } };
    const r2 = { id: "r2", fields: { "Payer Name": "  JOHN  DOE  " } };
    expect(pickEntityFromTo(table, r1, cls).from).toBe(
      pickEntityFromTo(table, r2, cls).from,
    );
  });

  test("partial — only from-like classified → returns only from", async () => {
    const { pickEntityFromTo } = await import("../scripts/emit-edges.mts");
    const table: AirtableTable = {
      id: "t",
      name: "T",
      fields: [
        { id: "f1", name: "Payer Name", type: "singleLineText" },
        { id: "f2", name: "Cashflow", type: "multipleRecordLinks" },
      ],
    };
    const record: AirtableRecord = {
      id: "r",
      fields: { "Payer Name": "John Doe", Cashflow: ["recCF1"] },
    };
    const cls = {
      schema_hash: "h",
      classified_at: "t",
      fields: {
        "Payer Name": {
          kind: "person" as const,
          role: "from-like" as const,
          confidence: 0.95,
          reasoning: "x",
        },
      },
    };
    const r = pickEntityFromTo(table, record, cls);
    expect(r.from).toBe("john-doe");
    expect(r.to).toBeUndefined();
  });

  test("empty value on classified field → that side is undefined", async () => {
    const { pickEntityFromTo } = await import("../scripts/emit-edges.mts");
    const table: AirtableTable = {
      id: "t",
      name: "T",
      fields: [
        { id: "f1", name: "Payer Name", type: "singleLineText" },
        { id: "f2", name: "Payee Name", type: "singleLineText" },
      ],
    };
    const record: AirtableRecord = {
      id: "r",
      fields: { "Payer Name": "John Doe", "Payee Name": "" },
    };
    const cls = {
      schema_hash: "h",
      classified_at: "t",
      fields: {
        "Payer Name": {
          kind: "person" as const,
          role: "from-like" as const,
          confidence: 0.95,
          reasoning: "x",
        },
        "Payee Name": {
          kind: "company" as const,
          role: "to-like" as const,
          confidence: 0.95,
          reasoning: "x",
        },
      },
    };
    const r = pickEntityFromTo(table, record, cls);
    expect(r.from).toBe("john-doe");
    expect(r.to).toBeUndefined();
  });
});

describe("buildEdgeRow with classification", () => {
  test("entity slugs override link-field record IDs when both are present", async () => {
    const { buildEdgeRow } = await import("../scripts/emit-edges.mts");
    const table: AirtableTable = {
      id: "tblPay",
      name: "Payments",
      fields: [
        { id: "f1", name: "Payer Name", type: "singleLineText" },
        { id: "f2", name: "Payee Name", type: "singleLineText" },
        {
          id: "f3",
          name: "Cashflow",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblCF" },
        },
        {
          id: "f4",
          name: "PnL",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblPnL" },
        },
      ],
    };
    const record: AirtableRecord = {
      id: "rec1",
      fields: {
        "Payer Name": "John Doe",
        "Payee Name": "Acme Corp",
        Cashflow: ["recCF1"],
        PnL: ["recPnL1"],
      },
    };
    const cls = {
      schema_hash: "h",
      classified_at: "t",
      fields: {
        "Payer Name": {
          kind: "person" as const,
          role: "from-like" as const,
          confidence: 0.95,
          reasoning: "x",
        },
        "Payee Name": {
          kind: "company" as const,
          role: "to-like" as const,
          confidence: 0.95,
          reasoning: "x",
        },
      },
    };
    const row = buildEdgeRow(table, record, "appX", { classification: cls });
    expect(row).not.toBeNull();
    expect(row!.from).toBe("john-doe");
    expect(row!.to).toBe("acme-corp");
    expect(row!.id).toBe("appX-rec1");
  });

  test("partial override — entity slug for from, link-field record ID for to", async () => {
    const { buildEdgeRow } = await import("../scripts/emit-edges.mts");
    const table: AirtableTable = {
      id: "tblPay",
      name: "Payments",
      fields: [
        { id: "f1", name: "Payer Name", type: "singleLineText" },
        {
          id: "f2",
          name: "Cashflow",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblCF" },
        },
        {
          id: "f3",
          name: "PnL",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblPnL" },
        },
      ],
    };
    const record: AirtableRecord = {
      id: "rec1",
      fields: {
        "Payer Name": "John Doe",
        Cashflow: ["recCF1"],
        PnL: ["recPnL1"],
      },
    };
    const cls = {
      schema_hash: "h",
      classified_at: "t",
      fields: {
        "Payer Name": {
          kind: "person" as const,
          role: "from-like" as const,
          confidence: 0.95,
          reasoning: "x",
        },
      },
    };
    const row = buildEdgeRow(table, record, "appX", { classification: cls });
    expect(row).not.toBeNull();
    expect(row!.from).toBe("john-doe");
    expect(row!.to).toBe("recPnL1"); // second link field, first ID — from pickFromTo
  });

  test("entity slug works when no link fields exist", async () => {
    const { buildEdgeRow } = await import("../scripts/emit-edges.mts");
    const table: AirtableTable = {
      id: "tblPay",
      name: "Payments",
      fields: [
        { id: "f1", name: "Payer Name", type: "singleLineText" },
        { id: "f2", name: "Payee Name", type: "singleLineText" },
      ],
    };
    const record: AirtableRecord = {
      id: "rec1",
      fields: { "Payer Name": "John Doe", "Payee Name": "Acme Corp" },
    };
    const cls = {
      schema_hash: "h",
      classified_at: "t",
      fields: {
        "Payer Name": {
          kind: "person" as const,
          role: "from-like" as const,
          confidence: 0.95,
          reasoning: "x",
        },
        "Payee Name": {
          kind: "company" as const,
          role: "to-like" as const,
          confidence: 0.95,
          reasoning: "x",
        },
      },
    };
    const row = buildEdgeRow(table, record, "appX", { classification: cls });
    expect(row).not.toBeNull();
    expect(row!.from).toBe("john-doe");
    expect(row!.to).toBe("acme-corp");
  });

  test("no classification → falls back to current pickFromTo (existing behaviour)", async () => {
    const { buildEdgeRow } = await import("../scripts/emit-edges.mts");
    const table: AirtableTable = {
      id: "tblPay",
      name: "Payments",
      fields: [
        {
          id: "f1",
          name: "Cashflow",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblCF" },
        },
        {
          id: "f2",
          name: "PnL",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblPnL" },
        },
      ],
    };
    const record: AirtableRecord = {
      id: "rec1",
      fields: { Cashflow: ["recCF1"], PnL: ["recPnL1"] },
    };
    const row = buildEdgeRow(table, record, "appX");
    expect(row!.from).toBe("recCF1");
    expect(row!.to).toBe("recPnL1");
  });
});

describe("emitEdges with text-field cache", () => {
  test("reads textFieldCacheBaseDir, applies classification per table", async () => {
    const { emitEdges } = await import("../scripts/emit-edges.mts");
    const baseId = "appTF001";
    const stage0Dir = join(tmp, "stage0");
    const tfDir = join(tmp, "tf");
    const vault = join(tmp, "vault");
    mkdirSync(stage0Dir, { recursive: true });
    mkdirSync(tfDir, { recursive: true });
    writeStageZeroCache(stage0Dir, baseId, {
      tblPay: {
        type: "interaction",
        reasoning: "x",
        schema_hash: "h",
        classified_at: "t",
      },
    });
    writeFileSync(
      join(tfDir, `${baseId}.json`),
      JSON.stringify({
        tblPay: {
          schema_hash: "h",
          classified_at: "t",
          fields: {
            "Payer Name": {
              kind: "person",
              role: "from-like",
              confidence: 0.95,
              reasoning: "x",
            },
            "Payee Name": {
              kind: "company",
              role: "to-like",
              confidence: 0.95,
              reasoning: "x",
            },
          },
        },
      }),
    );
    const table: AirtableTable = {
      id: "tblPay",
      name: "Payments",
      fields: [
        { id: "f1", name: "Payer Name", type: "singleLineText" },
        { id: "f2", name: "Payee Name", type: "singleLineText" },
      ],
    };
    const records: AirtableRecord[] = [
      {
        id: "rec1",
        fields: { "Payer Name": "John Doe", "Payee Name": "Acme Corp" },
      },
    ];
    const { fetch: fetchImpl } = makeFetch([
      { match: /\/meta\/bases\//, body: { tables: [table] } },
      { match: /\/tblPay/, body: { records } },
    ]);
    const result = await emitEdges(baseId, {
      fetch: fetchImpl,
      env: { AIRTABLE_API_KEY: "fake" },
      cacheBaseDir: stage0Dir,
      textFieldCacheBaseDir: tfDir,
      vaultPath: vault,
    });
    expect(result.skipped).toBe(false);
    const edgesPath = join(vault, "knowledge", "graph", "edges.jsonl");
    const written = readFileSync(edgesPath, "utf8");
    const lines = written.trim().split("\n");
    expect(lines.length).toBe(1);
    const row = JSON.parse(lines[0]);
    expect(row.from).toBe("john-doe");
    expect(row.to).toBe("acme-corp");
    expect(row.id).toBe(`${baseId}-rec1`);
  });

  test("AC#4 literal — 2 Payments with same Payer Name → 2 edge rows, both from='john-doe', different to", async () => {
    const { emitEdges } = await import("../scripts/emit-edges.mts");
    const baseId = "appAC4";
    const stage0Dir = join(tmp, "stage0c");
    const tfDir = join(tmp, "tfc");
    const vault = join(tmp, "vaultc");
    mkdirSync(stage0Dir, { recursive: true });
    mkdirSync(tfDir, { recursive: true });
    writeStageZeroCache(stage0Dir, baseId, {
      tblPay: {
        type: "interaction",
        reasoning: "x",
        schema_hash: "h",
        classified_at: "t",
      },
    });
    writeFileSync(
      join(tfDir, `${baseId}.json`),
      JSON.stringify({
        tblPay: {
          schema_hash: "h",
          classified_at: "t",
          fields: {
            "Payer Name": {
              kind: "person",
              role: "from-like",
              confidence: 0.95,
              reasoning: "x",
            },
            "Payee Name": {
              kind: "company",
              role: "to-like",
              confidence: 0.95,
              reasoning: "x",
            },
          },
        },
      }),
    );
    const table: AirtableTable = {
      id: "tblPay",
      name: "Payments",
      fields: [
        { id: "f1", name: "Payer Name", type: "singleLineText" },
        { id: "f2", name: "Payee Name", type: "singleLineText" },
      ],
    };
    const records: AirtableRecord[] = [
      {
        id: "recP1",
        fields: { "Payer Name": "John Doe", "Payee Name": "Acme Corp" },
      },
      {
        id: "recP2",
        fields: { "Payer Name": "John Doe", "Payee Name": "Beta LLC" },
      },
    ];
    const { fetch: fetchImpl } = makeFetch([
      { match: /\/meta\/bases\//, body: { tables: [table] } },
      { match: /\/tblPay/, body: { records } },
    ]);
    const result = await emitEdges(baseId, {
      fetch: fetchImpl,
      env: { AIRTABLE_API_KEY: "fake" },
      cacheBaseDir: stage0Dir,
      textFieldCacheBaseDir: tfDir,
      vaultPath: vault,
    });
    expect(result.skipped).toBe(false);
    const edgesPath = join(vault, "knowledge", "graph", "edges.jsonl");
    const lines = readFileSync(edgesPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    const rows = lines.map((l) => JSON.parse(l));
    const fromVals = new Set(rows.map((r) => r.from));
    const toVals = new Set(rows.map((r) => r.to));
    expect(fromVals).toEqual(new Set(["john-doe"]));
    expect(toVals).toEqual(new Set(["acme-corp", "beta-llc"]));
    expect(rows.every((r) => r.id.startsWith(`${baseId}-`))).toBe(true);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });

  test("missing textFieldCacheBaseDir → falls back to link-field behaviour", async () => {
    const { emitEdges } = await import("../scripts/emit-edges.mts");
    const baseId = "appTF002";
    const stage0Dir = join(tmp, "stage0b");
    const vault = join(tmp, "vaultb");
    mkdirSync(stage0Dir, { recursive: true });
    writeStageZeroCache(stage0Dir, baseId, {
      tblPay: {
        type: "interaction",
        reasoning: "x",
        schema_hash: "h",
        classified_at: "t",
      },
    });
    const table: AirtableTable = {
      id: "tblPay",
      name: "Payments",
      fields: [
        {
          id: "f1",
          name: "Cashflow",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblCF" },
        },
        {
          id: "f2",
          name: "PnL",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblPnL" },
        },
      ],
    };
    const records: AirtableRecord[] = [
      { id: "rec1", fields: { Cashflow: ["recCF1"], PnL: ["recPnL1"] } },
    ];
    const { fetch: fetchImpl } = makeFetch([
      { match: /\/meta\/bases\//, body: { tables: [table] } },
      { match: /\/tblPay/, body: { records } },
    ]);
    // Pass a non-existent textFieldCacheBaseDir.
    const result = await emitEdges(baseId, {
      fetch: fetchImpl,
      env: { AIRTABLE_API_KEY: "fake" },
      cacheBaseDir: stage0Dir,
      textFieldCacheBaseDir: join(tmp, "nonexistent"),
      vaultPath: vault,
    });
    expect(result.skipped).toBe(false);
    const edgesPath = join(vault, "knowledge", "graph", "edges.jsonl");
    const written = readFileSync(edgesPath, "utf8");
    const row = JSON.parse(written.trim().split("\n")[0]);
    expect(row.from).toBe("recCF1");
    expect(row.to).toBe("recPnL1");
  });
});
