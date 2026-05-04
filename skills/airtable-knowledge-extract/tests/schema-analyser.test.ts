/**
 * schema-analyser.test.ts — tests for the Stage D1 natural-key scanner
 * (ai-brain#239).
 *
 * Covers the AC#5 contract:
 *   - 100-record sample → ≥0.95 routing → full-table verify → require 1.0
 *   - AI / formula / lookup / rollup / count / metadata fields excluded
 *   - Reject path returns `{ nk_field: null, reason }` + stderr WARN
 *   - Output filtered to entity-classified tables only (Stage 0 cache gate)
 *   - Per-base fixtures cover the three shapes called out in AC#5: a
 *     finance-records base (interaction tables filtered), a procurement
 *     base (multi-entity), and a distribution base (entity + interaction
 *     mix). Names anonymised — public-plugin path forbids customer
 *     identifiers; the shape under test, not the brand, is what matters.
 *
 * Strategy: pure functions tested with synthetic record sets; glue tested
 * with `fetch` mocked at the URL level (mirrors legacy-link-detector.test.ts).
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyseTable,
  analyseAllEntityTables,
  pickCandidatesFromSample,
  verifyOnFullTable,
  uniqueRate,
  normalizeValue,
  isScannableField,
  SCALAR_NK_FIELD_TYPES,
  SAMPLE_SIZE,
  SAMPLE_THRESHOLD,
  FULL_TABLE_THRESHOLD,
  type NkAccepted,
  type NkRejected,
} from "../scripts/schema-analyser.mts";
import type { AirtableTable, AirtableField } from "../scripts/classify-clusters.mts";
import type { AirtableRecord } from "../scripts/legacy-link-detector.mts";
import type { TableTypeClassification } from "../scripts/classify-table-type.mts";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function field(name: string, type: string, extra: Partial<AirtableField> = {}): AirtableField {
  return { id: `fld-${name.replace(/\s+/g, "-").toLowerCase()}`, name, type, ...extra };
}

function table(id: string, name: string, fields: AirtableField[]): AirtableTable {
  return { id, name, fields };
}

function record(id: string, fields: Record<string, unknown> = {}): AirtableRecord {
  return { id, fields, createdTime: "2026-01-01T00:00:00.000Z" };
}

interface MockSpec {
  tables: AirtableTable[];
  recordsByTable: Record<string, AirtableRecord[]>;
}

/**
 * URL-level fetch mock — same shape as legacy-link-detector.test.ts. Honors
 * the `pageSize` + `offset` query params so tests can exercise the paged
 * full-table fetch path with smaller-than-100 sample sizes.
 */
function mockFetch(spec: MockSpec) {
  return async (url: string | URL): Promise<Response> => {
    const u = new URL(String(url));
    const metaMatch = u.pathname.match(/^\/v0\/meta\/bases\/([^/]+)\/tables$/);
    if (metaMatch) {
      return new Response(JSON.stringify({ tables: spec.tables }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const recMatch = u.pathname.match(/^\/v0\/([^/]+)\/([^/]+)$/);
    if (recMatch) {
      const tableId = recMatch[2];
      const all = spec.recordsByTable[tableId] ?? [];
      const pageSize = Number(u.searchParams.get("pageSize") ?? "100");
      const offsetStr = u.searchParams.get("offset");
      const start = offsetStr ? Number(offsetStr) : 0;
      const slice = all.slice(start, start + pageSize);
      const nextStart = start + slice.length;
      const body: { records: AirtableRecord[]; offset?: string } = { records: slice };
      if (nextStart < all.length) body.offset = String(nextStart);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  };
}

function writeStage0Cache(
  path: string,
  classifications: Record<string, TableTypeClassification>,
): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(classifications, null, 2));
}

function classify(type: TableTypeClassification["type"]): TableTypeClassification {
  return {
    type,
    reasoning: `synthetic ${type} fixture`,
    schema_hash: "synthetic",
    classified_at: "2026-01-01T00:00:00.000Z",
  };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "schema-analyser-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure helper tests
// ---------------------------------------------------------------------------

describe("normalizeValue", () => {
  test("returns null for null/undefined/empty/whitespace string", () => {
    expect(normalizeValue(null)).toBeNull();
    expect(normalizeValue(undefined)).toBeNull();
    expect(normalizeValue("")).toBeNull();
    expect(normalizeValue("   ")).toBeNull();
  });

  test("trims string values", () => {
    expect(normalizeValue("  alice  ")).toBe("alice");
  });

  test("stringifies numbers and booleans", () => {
    expect(normalizeValue(42)).toBe("42");
    expect(normalizeValue(0)).toBe("0");
    expect(normalizeValue(true)).toBe("true");
    expect(normalizeValue(false)).toBe("false");
  });

  test("rejects arrays and objects", () => {
    expect(normalizeValue([1, 2, 3])).toBeNull();
    expect(normalizeValue({ x: 1 })).toBeNull();
  });
});

describe("uniqueRate", () => {
  test("returns 1.0 when every record has a distinct value", () => {
    const r = [
      record("r1", { Email: "a@x.com" }),
      record("r2", { Email: "b@x.com" }),
      record("r3", { Email: "c@x.com" }),
    ];
    const out = uniqueRate(r, "Email");
    expect(out.rate).toBe(1.0);
    expect(out.distinctCount).toBe(3);
    expect(out.nonNullCount).toBe(3);
  });

  test("computes rate from distinct / non-null count", () => {
    const r = [
      record("r1", { Name: "Alice" }),
      record("r2", { Name: "Alice" }),
      record("r3", { Name: "Bob" }),
      record("r4", { Name: "Carol" }),
    ];
    const out = uniqueRate(r, "Name");
    expect(out.distinctCount).toBe(3);
    expect(out.nonNullCount).toBe(4);
    expect(out.rate).toBeCloseTo(0.75, 5);
  });

  test("excludes null/empty values from both numerator and denominator", () => {
    const r = [
      record("r1", { Email: "a@x.com" }),
      record("r2", { Email: "b@x.com" }),
      record("r3", {}), // missing entirely
      record("r4", { Email: "" }), // empty string
      record("r5", { Email: null }),
    ];
    const out = uniqueRate(r, "Email");
    expect(out.nonNullCount).toBe(2);
    expect(out.distinctCount).toBe(2);
    expect(out.rate).toBe(1.0);
  });

  test("returns 0 for an all-empty field", () => {
    const r = [record("r1", {}), record("r2", { X: null })];
    const out = uniqueRate(r, "X");
    expect(out.rate).toBe(0);
    expect(out.nonNullCount).toBe(0);
  });
});

describe("SCALAR_NK_FIELD_TYPES allowlist", () => {
  test("excludes derived field types per AC + grill Q12", () => {
    const derived = [
      "aiText",
      "formula",
      "rollup",
      "lookup",
      "multipleLookupValues",
      "count",
      "createdTime",
      "lastModifiedTime",
      "createdBy",
      "lastModifiedBy",
      "button",
      "multipleSelects",
      "multipleAttachments",
      "attachment",
      "multipleRecordLinks",
    ];
    for (const t of derived) {
      expect(SCALAR_NK_FIELD_TYPES.has(t)).toBe(false);
    }
  });

  test("includes the canonical scalar source-of-truth types", () => {
    const scalar = [
      "singleLineText",
      "multilineText",
      "email",
      "phoneNumber",
      "url",
      "number",
      "currency",
      "date",
      "dateTime",
      "singleSelect",
      "autoNumber",
    ];
    for (const t of scalar) {
      expect(SCALAR_NK_FIELD_TYPES.has(t)).toBe(true);
    }
  });

  test("isScannableField agrees with the allowlist", () => {
    expect(isScannableField(field("Email", "email"))).toBe(true);
    expect(isScannableField(field("Computed", "formula"))).toBe(false);
    expect(isScannableField(field("Lookup", "multipleLookupValues"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pickCandidatesFromSample
// ---------------------------------------------------------------------------

describe("pickCandidatesFromSample", () => {
  test("returns single high-uniqueness candidate for People-shaped table", () => {
    const t = table("tblPeople", "People", [
      field("Full Name", "singleLineText"),
      field("Email", "email"),
      field("Role", "singleLineText"),
      field("Company", "multipleRecordLinks", { options: { linkedTableId: "tblCompanies" } }),
    ]);
    const sample = [
      record("r1", { "Full Name": "Alice Nguyen", Email: "alice@x.com", Role: "Engineer" }),
      record("r2", { "Full Name": "Bao Tran", Email: "bao@x.com", Role: "Designer" }),
      record("r3", { "Full Name": "Chi Le", Email: "chi@x.com", Role: "PM" }),
      record("r4", { "Full Name": "Duy Pham", Email: "duy@x.com", Role: "Engineer" }),
      record("r5", { "Full Name": "Em Vu", Email: "em@x.com", Role: "CEO" }),
    ];
    const cands = pickCandidatesFromSample(t, sample);
    // Full Name + Email both 1.0; sorted by name asc as tie-breaker.
    expect(cands.map((c) => c.field)).toEqual(["Email", "Full Name"]);
    expect(cands[0].rate).toBe(1.0);
    expect(cands[1].rate).toBe(1.0);
    // Role is 0.6 (3 distinct of 5), excluded; Company is a link, excluded.
    for (const c of cands) {
      expect(["Role", "Company"]).not.toContain(c.field);
    }
  });

  test("returns empty when no scalar field clears 0.95", () => {
    const t = table("tblLow", "Low Uniqueness", [
      field("Name", "singleLineText"),
      field("Status", "singleSelect"),
    ]);
    // 5 records, 3 distinct names, 2 distinct statuses → 0.6 + 0.4 → both reject.
    const sample = [
      record("r1", { Name: "Alice", Status: "Open" }),
      record("r2", { Name: "Alice", Status: "Open" }),
      record("r3", { Name: "Bob", Status: "Closed" }),
      record("r4", { Name: "Carol", Status: "Open" }),
      record("r5", { Name: "Carol", Status: "Closed" }),
    ];
    expect(pickCandidatesFromSample(t, sample)).toEqual([]);
  });

  test("excludes derived fields even when their values are unique by coincidence", () => {
    const t = table("tblDerived", "All Derived", [
      field("Computed Slug", "formula"),
      field("AI Summary", "aiText"),
      field("Linked Names", "multipleLookupValues"),
      field("Created", "createdTime"),
    ]);
    const sample = [
      record("r1", {
        "Computed Slug": "alice-x",
        "AI Summary": "AI says A",
        "Linked Names": ["Alice"],
        Created: "2026-01-01",
      }),
      record("r2", {
        "Computed Slug": "bob-y",
        "AI Summary": "AI says B",
        "Linked Names": ["Bob"],
        Created: "2026-01-02",
      }),
    ];
    expect(pickCandidatesFromSample(t, sample)).toEqual([]);
  });

  test("sorts candidates by rate desc, then name asc", () => {
    const t = table("tblMix", "Mixed", [
      field("A", "singleLineText"),
      field("B", "singleLineText"),
      field("C", "singleLineText"),
    ]);
    // 20-record sample so a 0.95 rate (= 19/20) is actually reachable.
    // A: all distinct → 1.0
    // C: all distinct → 1.0
    // B: 19 distinct + 1 dup → 0.95 (clears threshold)
    // Expected order: A, C (1.0 tied, name asc), B (0.95).
    const sample = Array.from({ length: 20 }, (_, i) =>
      record(`r${i}`, {
        A: `a${i}`,
        B: i === 0 ? "shared" : i === 1 ? "shared" : `b${i}`,
        C: `c${i}`,
      }),
    );
    const cands = pickCandidatesFromSample(t, sample);
    expect(cands.map((c) => c.field)).toEqual(["A", "C", "B"]);
    expect(cands[0].rate).toBe(1.0);
    expect(cands[2].rate).toBeCloseTo(0.95, 5);
  });
});

// ---------------------------------------------------------------------------
// verifyOnFullTable
// ---------------------------------------------------------------------------

describe("verifyOnFullTable", () => {
  test("returns 1.0 when every record value is distinct", () => {
    const recs = Array.from({ length: 50 }, (_, i) =>
      record(`r${i}`, { Email: `user${i}@x.com` }),
    );
    expect(verifyOnFullTable(recs, "Email").rate).toBe(1.0);
  });

  test("returns < 1.0 when a collision exists in the full set", () => {
    const recs = [
      ...Array.from({ length: 99 }, (_, i) =>
        record(`r${i}`, { Email: `user${i}@x.com` }),
      ),
      record("r99-dup", { Email: "user0@x.com" }),
    ];
    const out = verifyOnFullTable(recs, "Email");
    expect(out.rate).toBeLessThan(1.0);
    expect(out.recordCount).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// analyseTable (composition of sample + full)
// ---------------------------------------------------------------------------

describe("analyseTable", () => {
  test("accepts a clean entity table; reports verified unique_rate + sample_size", () => {
    const t = table("tblPeople", "People", [
      field("Full Name", "singleLineText"),
      field("Email", "email"),
    ]);
    const recs = Array.from({ length: 30 }, (_, i) =>
      record(`r${i}`, { "Full Name": `Person ${i}`, Email: `p${i}@x.com` }),
    );
    const result = analyseTable(t, recs, recs);
    expect(result.nk_field).toBe("Email");
    const accepted = result as NkAccepted;
    expect(accepted.unique_rate).toBe(1.0);
    expect(accepted.sample_size).toBe(30);
  });

  test("rejects when sample fails the routing threshold", () => {
    const t = table("tblLow", "Low", [field("Name", "singleLineText")]);
    const sample = [
      record("r1", { Name: "X" }),
      record("r2", { Name: "X" }),
      record("r3", { Name: "Y" }),
    ];
    const result = analyseTable(t, sample, sample);
    expect(result.nk_field).toBeNull();
    expect((result as NkRejected).reason).toContain(
      `unique_rate >= ${SAMPLE_THRESHOLD}`,
    );
  });

  test("rejects when sample passes but full-table verification fails (the #236 trap)", () => {
    const t = table("tblPayments", "Payments", [field("Payer Name", "singleLineText")]);
    // Sample: 5 distinct payers (1.0). Full: 5 distinct + 5 dupes (0.5).
    const sample = Array.from({ length: 5 }, (_, i) =>
      record(`r${i}`, { "Payer Name": `Payer ${i}` }),
    );
    const full = [
      ...sample,
      ...Array.from({ length: 5 }, (_, i) =>
        record(`r${i + 5}`, { "Payer Name": `Payer ${i % 3}` }),
      ),
    ];
    const result = analyseTable(t, sample, full);
    expect(result.nk_field).toBeNull();
    expect((result as NkRejected).reason).toContain(
      `unique_rate=${FULL_TABLE_THRESHOLD}`,
    );
    expect((result as NkRejected).reason).toContain("Payer Name");
  });

  test("rejects an empty table with a clear reason", () => {
    const t = table("tblEmpty", "Empty", [field("Name", "singleLineText")]);
    const result = analyseTable(t, [], []);
    expect(result.nk_field).toBeNull();
    expect((result as NkRejected).reason).toContain("empty");
  });

  test("tries strongest candidate first; falls through to weaker candidate that verifies clean", () => {
    const t = table("tblMulti", "MultiCandidate", [
      field("Slug", "singleLineText"),
      field("Email", "email"),
    ]);
    // Sample: both 1.0. Full: Slug collides on record 4; Email is clean.
    // pickCandidatesFromSample sorts (1.0,1.0) by name asc → Email first.
    // Email verifies → accepted as Email.
    const sample = Array.from({ length: 5 }, (_, i) =>
      record(`r${i}`, { Slug: `s${i}`, Email: `u${i}@x.com` }),
    );
    const full = [
      ...sample,
      record("r5", { Slug: "s0", Email: "u5@x.com" }), // Slug collides; Email distinct
    ];
    const result = analyseTable(t, sample, full);
    expect(result.nk_field).toBe("Email");
  });
});

// ---------------------------------------------------------------------------
// analyseAllEntityTables — glue with mocked fetch
// ---------------------------------------------------------------------------

describe("analyseAllEntityTables — Stage 0 cache gate", () => {
  test("aborts when Stage 0 classifier cache is missing", async () => {
    await expect(
      analyseAllEntityTables("appMissing", {
        fetch: mockFetch({ tables: [], recordsByTable: {} }),
        env: { AIRTABLE_API_KEY: "tok" },
        cacheDir: tmp,
        runId: "test-run",
        classificationsCachePath: join(tmp, "does-not-exist.json"),
      }),
    ).rejects.toThrow(/Stage 0 classifier cache not found/);
  });

  test("scans only entity-classified tables; skips interaction + reject", async () => {
    const tPeople = table("tblPeople", "People", [
      field("Email", "email"),
      field("Full Name", "singleLineText"),
    ]);
    const tPayments = table("tblPayments", "Payments", [
      field("Amount", "currency"),
      field("Payer", "multipleRecordLinks", { options: { linkedTableId: "tblPeople" } }),
    ]);
    const tJunk = table("tblJunk", "Junk", [field("Note", "multilineText")]);

    const stage0 = join(tmp, "stage0.json");
    writeStage0Cache(stage0, {
      tblPeople: classify("entity"),
      tblPayments: classify("interaction"),
      tblJunk: classify("reject"),
    });

    const warned: string[] = [];
    const { output, cachePath } = await analyseAllEntityTables("appT1", {
      fetch: mockFetch({
        tables: [tPeople, tPayments, tJunk],
        recordsByTable: {
          tblPeople: [
            record("r1", { Email: "a@x.com", "Full Name": "Alice" }),
            record("r2", { Email: "b@x.com", "Full Name": "Bao" }),
            record("r3", { Email: "c@x.com", "Full Name": "Chi" }),
          ],
          tblPayments: [record("p1", { Amount: 100 })],
          tblJunk: [record("j1", { Note: "ignore" })],
        },
      }),
      env: { AIRTABLE_API_KEY: "tok" },
      cacheDir: tmp,
      runId: "test-run",
      classificationsCachePath: stage0,
      warn: (m) => warned.push(m),
    });

    expect(Object.keys(output).sort()).toEqual(["tblPeople"]);
    expect((output.tblPeople as NkAccepted).nk_field).toBe("Email");
    expect((output.tblPeople as NkAccepted).unique_rate).toBe(1.0);
    expect((output.tblPeople as NkAccepted).sample_size).toBe(3);

    expect(existsSync(cachePath)).toBe(true);
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    expect(cached).toEqual(output);

    // No reject for tblPeople → no warn.
    expect(warned).toEqual([]);
  });

  test("emits stderr WARN per reject + embeds reason in output", async () => {
    const tLow = table("tblLow", "Low Uniqueness", [
      field("Name", "singleLineText"),
      field("Status", "singleSelect"),
    ]);

    const stage0 = join(tmp, "stage0.json");
    writeStage0Cache(stage0, { tblLow: classify("entity") });

    const warned: string[] = [];
    const { output } = await analyseAllEntityTables("appReject", {
      fetch: mockFetch({
        tables: [tLow],
        recordsByTable: {
          tblLow: [
            record("r1", { Name: "X", Status: "Open" }),
            record("r2", { Name: "X", Status: "Open" }),
            record("r3", { Name: "Y", Status: "Open" }),
            record("r4", { Name: "Y", Status: "Closed" }),
            record("r5", { Name: "Z", Status: "Closed" }),
          ],
        },
      }),
      env: { AIRTABLE_API_KEY: "tok" },
      cacheDir: tmp,
      runId: "test-run",
      classificationsCachePath: stage0,
      warn: (m) => warned.push(m),
    });

    expect((output.tblLow as NkRejected).nk_field).toBeNull();
    expect((output.tblLow as NkRejected).reason).toContain("0.95");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("REJECT tblLow (Low Uniqueness)");
  });

  test("handles empty entity tables with explicit reason", async () => {
    const tEmpty = table("tblEmpty", "Sandbox", [field("Name", "singleLineText")]);
    const stage0 = join(tmp, "stage0.json");
    writeStage0Cache(stage0, { tblEmpty: classify("entity") });

    const warned: string[] = [];
    const { output } = await analyseAllEntityTables("appEmpty", {
      fetch: mockFetch({ tables: [tEmpty], recordsByTable: { tblEmpty: [] } }),
      env: { AIRTABLE_API_KEY: "tok" },
      cacheDir: tmp,
      runId: "test-run",
      classificationsCachePath: stage0,
      warn: (m) => warned.push(m),
    });

    expect((output.tblEmpty as NkRejected).reason).toContain("empty");
    expect(warned[0]).toContain("REJECT tblEmpty");
  });

  test("paginates the verification fetch when sample fills a full page", async () => {
    const t = table("tblBig", "Big Entities", [
      field("Slug", "singleLineText"),
      field("Email", "email"),
    ]);
    // 12 records; sampleSize=5 → first 5 = sample, full = 12.
    const recs = Array.from({ length: 12 }, (_, i) =>
      record(`r${i}`, { Slug: `slug-${i}`, Email: `u${i}@x.com` }),
    );

    const stage0 = join(tmp, "stage0.json");
    writeStage0Cache(stage0, { tblBig: classify("entity") });

    const calls: string[] = [];
    const f = mockFetch({ tables: [t], recordsByTable: { tblBig: recs } });
    const tracedFetch: typeof globalThis.fetch = async (url) => {
      calls.push(String(url));
      return f(url);
    };

    const { output } = await analyseAllEntityTables("appBig", {
      fetch: tracedFetch,
      env: { AIRTABLE_API_KEY: "tok" },
      cacheDir: tmp,
      runId: "test-run",
      classificationsCachePath: stage0,
      sampleSize: 5,
    });

    // Accepted; sample_size reports the FULL count (12), not the sample (5).
    expect(output.tblBig.nk_field).toBe("Email");
    expect((output.tblBig as NkAccepted).sample_size).toBe(12);

    // Calls: 1 meta + 1 sample (pageSize=5) + paged full (3 pages of 5/5/2).
    const recordCalls = calls.filter((c) => c.includes("/v0/appBig/tblBig"));
    expect(recordCalls.length).toBeGreaterThanOrEqual(2);
    // Final paged sweep must include offset params after the first page.
    const pagedCalls = recordCalls.filter((c) => c.includes("offset="));
    expect(pagedCalls.length).toBeGreaterThan(0);
  });

  test("skips full-table fetch when sample fits in one page (cheap reject path)", async () => {
    const t = table("tblTiny", "Tiny", [
      field("Name", "singleLineText"),
      field("Status", "singleSelect"),
    ]);
    // 4 records, sampleSize=10 → sample is full; no second fetch ever needed.
    const recs = [
      record("r1", { Name: "X", Status: "Open" }),
      record("r2", { Name: "X", Status: "Open" }),
      record("r3", { Name: "Y", Status: "Closed" }),
      record("r4", { Name: "Y", Status: "Closed" }),
    ];

    const stage0 = join(tmp, "stage0.json");
    writeStage0Cache(stage0, { tblTiny: classify("entity") });

    const calls: string[] = [];
    const f = mockFetch({ tables: [t], recordsByTable: { tblTiny: recs } });
    const tracedFetch: typeof globalThis.fetch = async (url) => {
      calls.push(String(url));
      return f(url);
    };

    await analyseAllEntityTables("appTiny", {
      fetch: tracedFetch,
      env: { AIRTABLE_API_KEY: "tok" },
      cacheDir: tmp,
      runId: "test-run",
      classificationsCachePath: stage0,
      sampleSize: 10,
      warn: () => {},
    });

    const recordCalls = calls.filter((c) => c.includes("/v0/appTiny/tblTiny"));
    // Sample call only; no offset paging because sample fit in one page.
    expect(recordCalls.length).toBe(1);
    expect(recordCalls[0]).not.toContain("offset=");
  });
});

// ---------------------------------------------------------------------------
// Per-base shape fixtures (AC#5: scanner must handle the three base shapes
// from the empirical 5-base research without leaking the brand names into
// the public plugin path).
// ---------------------------------------------------------------------------

describe("analyseAllEntityTables — per-base fixtures (AC#5)", () => {
  test("finance-records shape: interaction tables filtered, entity tables scanned", async () => {
    // Mirrors a finance-records base shape: Cashflows / Payments / PnL
    // Reports = interaction; an entity-classified Customers table coexists.
    const tCustomers = table("tblCustomers", "Customers", [
      field("Customer Code", "singleLineText"),
      field("Email", "email"),
      field("Industry", "singleSelect"),
    ]);
    const tPayments = table("tblPayments", "Payments", [
      field("Payer Name", "singleLineText"),
      field("Amount", "currency"),
      field("Date", "date"),
    ]);
    const tCashflows = table("tblCashflows", "Cashflows", [
      field("Inflow", "currency"),
      field("Outflow", "currency"),
      field("Date", "date"),
    ]);
    const tPnL = table("tblPnL", "PnL Reports", [
      field("Period", "singleLineText"),
      field("Net", "currency"),
    ]);

    const stage0 = join(tmp, "stage0-finance.json");
    writeStage0Cache(stage0, {
      tblCustomers: classify("entity"),
      tblPayments: classify("interaction"),
      tblCashflows: classify("interaction"),
      tblPnL: classify("interaction"),
    });

    const customers = Array.from({ length: 10 }, (_, i) =>
      record(`recCust${i}`, {
        "Customer Code": `CUST-${String(i).padStart(3, "0")}`,
        Email: `customer${i}@example.com`,
        Industry: i % 2 === 0 ? "Retail" : "Hospitality",
      }),
    );

    const { output } = await analyseAllEntityTables("appFinanceSyn", {
      fetch: mockFetch({
        tables: [tCustomers, tPayments, tCashflows, tPnL],
        recordsByTable: {
          tblCustomers: customers,
          tblPayments: [],
          tblCashflows: [],
          tblPnL: [],
        },
      }),
      env: { AIRTABLE_API_KEY: "tok" },
      cacheDir: tmp,
      runId: "finance-run",
      classificationsCachePath: stage0,
      warn: () => {},
    });

    // ONLY entity tables in output. Interaction tables filtered.
    expect(Object.keys(output).sort()).toEqual(["tblCustomers"]);
    expect(output.tblCustomers.nk_field).toBe("Customer Code");
    expect((output.tblCustomers as NkAccepted).unique_rate).toBe(1.0);
  });

  test("procurement shape: Suppliers + POs + Items, all entity-classified", async () => {
    const tSuppliers = table("tblSuppliers", "Suppliers", [
      field("Supplier Code", "singleLineText"),
      field("Tax ID", "singleLineText"),
      field("Country", "singleSelect"),
    ]);
    const tPOs = table("tblPOs", "Purchase Orders", [
      field("PO Number", "singleLineText"),
      field("Status", "singleSelect"),
    ]);
    const tItems = table("tblItems", "Items", [
      field("SKU", "singleLineText"),
      field("Item Name", "singleLineText"),
    ]);

    const stage0 = join(tmp, "stage0-procurement.json");
    writeStage0Cache(stage0, {
      tblSuppliers: classify("entity"),
      tblPOs: classify("entity"),
      tblItems: classify("entity"),
    });

    const { output } = await analyseAllEntityTables("appProcurementSyn", {
      fetch: mockFetch({
        tables: [tSuppliers, tPOs, tItems],
        recordsByTable: {
          tblSuppliers: Array.from({ length: 8 }, (_, i) =>
            record(`recSup${i}`, {
              "Supplier Code": `SUP-${i}`,
              "Tax ID": `TAX${i}`,
              Country: i < 4 ? "VN" : "TH",
            }),
          ),
          tblPOs: Array.from({ length: 12 }, (_, i) =>
            record(`recPO${i}`, {
              "PO Number": `PO-2026-${String(i).padStart(4, "0")}`,
              Status: i % 3 === 0 ? "Open" : "Closed",
            }),
          ),
          tblItems: Array.from({ length: 6 }, (_, i) =>
            record(`recIt${i}`, {
              SKU: `SKU-${i}`,
              "Item Name": `Item ${i}`,
            }),
          ),
        },
      }),
      env: { AIRTABLE_API_KEY: "tok" },
      cacheDir: tmp,
      runId: "procurement-run",
      classificationsCachePath: stage0,
      warn: () => {},
    });

    expect(Object.keys(output).sort()).toEqual(["tblItems", "tblPOs", "tblSuppliers"]);
    // Each entity table picks a verified NK at 1.0.
    for (const id of Object.keys(output)) {
      const r = output[id] as NkAccepted;
      expect(r.nk_field).not.toBeNull();
      expect(r.unique_rate).toBe(1.0);
    }
  });

  test("distribution shape: Distributors entity scanned; Shipments interaction filtered", async () => {
    const tDistributors = table("tblDistributors", "Distributors", [
      field("Distributor Code", "singleLineText"),
      field("Region", "singleSelect"),
      field("Contact Email", "email"),
    ]);
    const tShipments = table("tblShipments", "Shipments", [
      field("Tracking Number", "singleLineText"),
      field("From", "multipleRecordLinks", { options: { linkedTableId: "tblDistributors" } }),
      field("To", "multipleRecordLinks", { options: { linkedTableId: "tblDistributors" } }),
      field("Date", "date"),
    ]);

    const stage0 = join(tmp, "stage0-distribution.json");
    writeStage0Cache(stage0, {
      tblDistributors: classify("entity"),
      tblShipments: classify("interaction"),
    });

    const { output } = await analyseAllEntityTables("appDistributionSyn", {
      fetch: mockFetch({
        tables: [tDistributors, tShipments],
        recordsByTable: {
          tblDistributors: Array.from({ length: 5 }, (_, i) =>
            record(`recDist${i}`, {
              "Distributor Code": `DIST-${String(i).padStart(2, "0")}`,
              Region: i < 3 ? "North" : "South",
              "Contact Email": `dist${i}@example.com`,
            }),
          ),
          tblShipments: [],
        },
      }),
      env: { AIRTABLE_API_KEY: "tok" },
      cacheDir: tmp,
      runId: "distribution-run",
      classificationsCachePath: stage0,
      warn: () => {},
    });

    expect(Object.keys(output).sort()).toEqual(["tblDistributors"]);
    const r = output.tblDistributors as NkAccepted;
    // Multiple candidates clear the bar; the lowest-named clean one wins by
    // the deterministic name-asc tiebreak.
    expect(r.nk_field).toBe("Contact Email");
    expect(r.unique_rate).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Constants sanity
// ---------------------------------------------------------------------------

describe("constants", () => {
  test("SAMPLE_SIZE = 100 (per AC + grill Q8)", () => {
    expect(SAMPLE_SIZE).toBe(100);
  });
  test("SAMPLE_THRESHOLD = 0.95 (per AC + grill Q9)", () => {
    expect(SAMPLE_THRESHOLD).toBe(0.95);
  });
  test("FULL_TABLE_THRESHOLD = 1.0 (per AC + grill Q9)", () => {
    expect(FULL_TABLE_THRESHOLD).toBe(1.0);
  });
});
