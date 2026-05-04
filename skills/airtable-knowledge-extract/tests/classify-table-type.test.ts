/**
 * classify-table-type.test.ts — Stage 0 LLM table-type classifier (ai-brain#238).
 *
 * Two run modes mirror tests/judge-fidelity.test.ts:
 *
 *   - **Default (no env var):** uses a deterministic mock classifier that
 *     answers the golden-set entries by their `expected_type`. Validates
 *     pipeline glue (schema hash, prompt build, response parser, cache
 *     read/write, escalation, model gate) — NOT real-model fidelity.
 *
 *   - **Live (AIRTABLE_TABLE_TYPE_LIVE=1):** invokes real
 *     `claude -p --model $AIRTABLE_TABLE_TYPE_MODEL` (default
 *     `claude-sonnet-4-6`) for every golden-set entry and asserts ≥95%
 *     agreement with the fixture labels (parent AC#4). No Airtable
 *     network call — fixture carries all (table, samples) inline.
 *
 *   To run live:
 *     AIRTABLE_TABLE_TYPE_LIVE=1 bun test tests/classify-table-type.test.ts
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyTableType,
  classifyAllTables,
  computeSchemaHash,
  buildClassificationPrompt,
  parseClassificationResponse,
  assertNotHaiku,
  filterAcceptedTableIds,
  DEFAULT_TABLE_TYPE_MODEL,
  type ClassificationRunner,
  type TableType,
  type TableTypeClassification,
} from "../scripts/classify-table-type.mts";
import type { AirtableTable } from "../scripts/classify-clusters.mts";
import type { AirtableRecord } from "../scripts/legacy-link-detector.mts";

interface GoldenEntry {
  id: string;
  table: AirtableTable;
  sample_records: AirtableRecord[];
  expected_type: TableType;
}

function loadGoldenSet(): GoldenEntry[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const fixturePath = join(here, "fixtures", "table-types-golden-set.json");
  const raw = JSON.parse(readFileSync(fixturePath, "utf8")) as { entries: GoldenEntry[] };
  return raw.entries;
}

function makeMockRunner(
  perEntry: (entry: GoldenEntry) => { type: TableType; reasoning: string },
): { runner: ClassificationRunner; calls: number } {
  let calls = 0;
  const set = loadGoldenSet();
  const runner: ClassificationRunner = async (prompt: string) => {
    calls += 1;
    const match = set.find((e) => prompt.includes(`Table: ${e.table.name} (${e.table.id})`));
    if (!match) {
      throw new Error(`mock runner: no fixture entry matched the prompt`);
    }
    const v = perEntry(match);
    return {
      rawText: JSON.stringify({ type: v.type, reasoning: v.reasoning }),
      usage: { input_tokens: 100, output_tokens: 30 },
      model: DEFAULT_TABLE_TYPE_MODEL,
    };
  };
  return {
    runner,
    get calls() {
      return calls;
    },
  } as { runner: ClassificationRunner; calls: number };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "classify-table-type-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture sanity
// ---------------------------------------------------------------------------

describe("table-types-golden-set fixture sanity", () => {
  test("loads with at least 5 entries and only valid types", () => {
    const set = loadGoldenSet();
    expect(set.length).toBeGreaterThanOrEqual(5);
    for (const e of set) {
      expect(["entity", "interaction", "reject"]).toContain(e.expected_type);
    }
  });

  test("covers all three classes", () => {
    const set = loadGoldenSet();
    const types = new Set(set.map((e) => e.expected_type));
    expect(types).toEqual(new Set(["entity", "interaction", "reject"]));
  });

  test("entry ids are unique", () => {
    const set = loadGoldenSet();
    const ids = new Set(set.map((e) => e.id));
    expect(ids.size).toBe(set.length);
  });

  test("each entry table has at least one field", () => {
    const set = loadGoldenSet();
    for (const e of set) {
      expect(e.table.fields.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("computeSchemaHash", () => {
  test("stable across calls for same input", () => {
    const t: AirtableTable = {
      id: "tbl1",
      name: "X",
      fields: [
        { id: "f1", name: "A", type: "singleLineText" },
        { id: "f2", name: "B", type: "number" },
      ],
    };
    expect(computeSchemaHash(t)).toBe(computeSchemaHash(t));
  });

  test("stable across field order permutations (sorted internally)", () => {
    const a: AirtableTable = {
      id: "tbl1",
      name: "X",
      fields: [
        { id: "f1", name: "A", type: "singleLineText" },
        { id: "f2", name: "B", type: "number" },
      ],
    };
    const b: AirtableTable = {
      id: "tbl1",
      name: "X",
      fields: [
        { id: "f2", name: "B", type: "number" },
        { id: "f1", name: "A", type: "singleLineText" },
      ],
    };
    expect(computeSchemaHash(a)).toBe(computeSchemaHash(b));
  });

  test("changes when a field is added", () => {
    const before: AirtableTable = {
      id: "tbl1",
      name: "X",
      fields: [{ id: "f1", name: "A", type: "singleLineText" }],
    };
    const after: AirtableTable = {
      id: "tbl1",
      name: "X",
      fields: [
        { id: "f1", name: "A", type: "singleLineText" },
        { id: "f2", name: "B", type: "number" },
      ],
    };
    expect(computeSchemaHash(before)).not.toBe(computeSchemaHash(after));
  });

  test("changes when a field is renamed", () => {
    const before: AirtableTable = {
      id: "tbl1",
      name: "X",
      fields: [{ id: "f1", name: "A", type: "singleLineText" }],
    };
    const after: AirtableTable = {
      id: "tbl1",
      name: "X",
      fields: [{ id: "f1", name: "RenamedA", type: "singleLineText" }],
    };
    expect(computeSchemaHash(before)).not.toBe(computeSchemaHash(after));
  });

  test("changes when a field's type changes", () => {
    const before: AirtableTable = {
      id: "tbl1",
      name: "X",
      fields: [{ id: "f1", name: "A", type: "singleLineText" }],
    };
    const after: AirtableTable = {
      id: "tbl1",
      name: "X",
      fields: [{ id: "f1", name: "A", type: "number" }],
    };
    expect(computeSchemaHash(before)).not.toBe(computeSchemaHash(after));
  });

  test("changes when a multipleRecordLinks linkedTableId changes (semantic shift)", () => {
    const before: AirtableTable = {
      id: "tbl1",
      name: "X",
      fields: [
        {
          id: "f1",
          name: "Linked",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblTargetA" },
        },
      ],
    };
    const after: AirtableTable = {
      id: "tbl1",
      name: "X",
      fields: [
        {
          id: "f1",
          name: "Linked",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tblTargetB" },
        },
      ],
    };
    expect(computeSchemaHash(before)).not.toBe(computeSchemaHash(after));
  });

  test("returns a non-empty hex string", () => {
    const t: AirtableTable = {
      id: "tbl1",
      name: "X",
      fields: [{ id: "f1", name: "A", type: "singleLineText" }],
    };
    const h = computeSchemaHash(t);
    expect(h).toMatch(/^[a-f0-9]+$/);
    expect(h.length).toBeGreaterThan(0);
  });
});

describe("buildClassificationPrompt", () => {
  test("includes table name, id, fields, sample records", () => {
    const set = loadGoldenSet();
    const entry = set[0];
    const prompt = buildClassificationPrompt({
      table: entry.table,
      sampleRecords: entry.sample_records,
    });
    expect(prompt).toContain(`Table: ${entry.table.name} (${entry.table.id})`);
    expect(prompt).toContain("entity");
    expect(prompt).toContain("interaction");
    expect(prompt).toContain("reject");
    for (const f of entry.table.fields) {
      expect(prompt).toContain(f.name);
    }
  });

  test("handles tables with zero sample records (no crash, prompt notes empty)", () => {
    const t: AirtableTable = {
      id: "tblEmpty",
      name: "Empty",
      fields: [{ id: "f1", name: "A", type: "singleLineText" }],
    };
    const prompt = buildClassificationPrompt({ table: t, sampleRecords: [] });
    expect(prompt).toContain("Table: Empty (tblEmpty)");
    expect(prompt.length).toBeGreaterThan(0);
  });
});

describe("parseClassificationResponse", () => {
  test("parses bare JSON", () => {
    const r = parseClassificationResponse(
      `{"type": "entity", "reasoning": "Each record is a unique person."}`,
    );
    expect(r.type).toBe("entity");
    expect(r.reasoning).toBe("Each record is a unique person.");
  });

  test("parses fenced JSON", () => {
    const r = parseClassificationResponse(
      "```json\n{\"type\": \"interaction\", \"reasoning\": \"Records are events.\"}\n```",
    );
    expect(r.type).toBe("interaction");
    expect(r.reasoning).toBe("Records are events.");
  });

  test("parses JSON with leading prose", () => {
    const r = parseClassificationResponse(
      "Here is my classification:\n{\"type\": \"reject\", \"reasoning\": \"No usable primary key.\"}",
    );
    expect(r.type).toBe("reject");
    expect(r.reasoning).toBe("No usable primary key.");
  });

  test("throws on missing type", () => {
    expect(() => parseClassificationResponse(`{"reasoning": "ok"}`)).toThrow();
  });

  test("throws on invalid type value", () => {
    expect(() =>
      parseClassificationResponse(`{"type": "not-a-real-type", "reasoning": "ok"}`),
    ).toThrow();
  });

  test("throws on missing reasoning", () => {
    expect(() => parseClassificationResponse(`{"type": "entity"}`)).toThrow();
  });

  test("throws on no JSON", () => {
    expect(() => parseClassificationResponse(`I cannot parse this.`)).toThrow();
  });
});

describe("filterAcceptedTableIds (downstream-pipeline gate)", () => {
  test("excludes reject tables; keeps entity + interaction; preserves order", () => {
    const classifications: Record<string, TableTypeClassification> = {
      tblA: { type: "entity", reasoning: "...", schema_hash: "h1", classified_at: "t" },
      tblB: { type: "reject", reasoning: "...", schema_hash: "h2", classified_at: "t" },
      tblC: { type: "interaction", reasoning: "...", schema_hash: "h3", classified_at: "t" },
      tblD: { type: "reject", reasoning: "...", schema_hash: "h4", classified_at: "t" },
    };
    expect(filterAcceptedTableIds(classifications)).toEqual(["tblA", "tblC"]);
  });

  test("returns [] when every table is rejected", () => {
    const classifications: Record<string, TableTypeClassification> = {
      tblA: { type: "reject", reasoning: "...", schema_hash: "h1", classified_at: "t" },
    };
    expect(filterAcceptedTableIds(classifications)).toEqual([]);
  });

  test("returns all table ids when nothing is rejected", () => {
    const classifications: Record<string, TableTypeClassification> = {
      tblA: { type: "entity", reasoning: "...", schema_hash: "h1", classified_at: "t" },
      tblB: { type: "interaction", reasoning: "...", schema_hash: "h2", classified_at: "t" },
    };
    expect(filterAcceptedTableIds(classifications)).toEqual(["tblA", "tblB"]);
  });
});

describe("assertNotHaiku", () => {
  test("accepts sonnet-4-6", () => {
    expect(() => assertNotHaiku("claude-sonnet-4-6")).not.toThrow();
  });

  test("accepts opus", () => {
    expect(() => assertNotHaiku("claude-opus-4-6")).not.toThrow();
  });

  test("rejects haiku-4-5", () => {
    expect(() => assertNotHaiku("claude-haiku-4-5")).toThrow(/haiku/i);
  });

  test("rejects haiku regardless of casing", () => {
    expect(() => assertNotHaiku("Claude-Haiku-Latest")).toThrow(/haiku/i);
  });
});

// ---------------------------------------------------------------------------
// classifyTableType (single-table)
// ---------------------------------------------------------------------------

describe("classifyTableType", () => {
  test("returns classification with type, reasoning, schema_hash, classified_at", async () => {
    const set = loadGoldenSet();
    const entry = set[0];
    const { runner } = makeMockRunner((e) => ({
      type: e.expected_type,
      reasoning: `mock-${e.expected_type}`,
    }));
    const result = await classifyTableType(
      { table: entry.table, sampleRecords: entry.sample_records },
      { runClassifier: runner, now: () => "2026-05-05T00:00:00.000Z" },
    );
    expect(result.type).toBe(entry.expected_type);
    expect(result.reasoning).toBe(`mock-${entry.expected_type}`);
    expect(result.schema_hash).toBe(computeSchemaHash(entry.table));
    expect(result.classified_at).toBe("2026-05-05T00:00:00.000Z");
  });

  test("rejects haiku model", async () => {
    const set = loadGoldenSet();
    const entry = set[0];
    const { runner } = makeMockRunner(() => ({ type: "entity", reasoning: "x" }));
    await expect(
      classifyTableType(
        { table: entry.table, sampleRecords: entry.sample_records },
        { runClassifier: runner, model: "claude-haiku-4-5" },
      ),
    ).rejects.toThrow(/haiku/i);
  });

  test("default model is claude-sonnet-4-6 (passed through to runner)", async () => {
    const set = loadGoldenSet();
    const entry = set[0];
    let observedModel = "";
    const runner: ClassificationRunner = async (_p, model) => {
      observedModel = model;
      return {
        rawText: JSON.stringify({ type: "entity", reasoning: "ok" }),
        usage: { input_tokens: 10, output_tokens: 5 },
        model,
      };
    };
    await classifyTableType(
      { table: entry.table, sampleRecords: entry.sample_records },
      { runClassifier: runner },
    );
    expect(observedModel).toBe("claude-sonnet-4-6");
  });

  test("on reject, calls warn callback with reasoning", async () => {
    const t: AirtableTable = {
      id: "tblJunk",
      name: "Untitled",
      fields: [{ id: "f1", name: "Field 1", type: "singleLineText" }],
    };
    const warnings: string[] = [];
    const runner: ClassificationRunner = async () => ({
      rawText: JSON.stringify({ type: "reject", reasoning: "no usable primary" }),
      usage: { input_tokens: 10, output_tokens: 5 },
      model: DEFAULT_TABLE_TYPE_MODEL,
    });
    const result = await classifyTableType(
      { table: t, sampleRecords: [] },
      { runClassifier: runner, warn: (m) => warnings.push(m) },
    );
    expect(result.type).toBe("reject");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes("tblJunk") && w.includes("no usable primary"))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// classifyAllTables (cache + re-classification + Airtable fetch)
// ---------------------------------------------------------------------------

interface MockApiState {
  tables: AirtableTable[];
  recordsByTableId: Map<string, AirtableRecord[]>;
}

function mockMetaAndRecordsFetch(state: MockApiState): typeof globalThis.fetch {
  return (async (urlInput: string | URL, _init?: RequestInit) => {
    const url = String(urlInput);
    const metaMatch = url.match(/\/v0\/meta\/bases\/[^/]+\/tables$/);
    if (metaMatch) {
      return new Response(JSON.stringify({ tables: state.tables }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const recordsMatch = url.match(/\/v0\/[^/]+\/([^/?]+)\?/);
    if (recordsMatch) {
      const tableId = recordsMatch[1];
      const records = state.recordsByTableId.get(tableId) ?? [];
      return new Response(JSON.stringify({ records }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
}

describe("classifyAllTables", () => {
  test("writes cache JSON to <cacheBaseDir>/<base_id>.json with correct shape", async () => {
    const set = loadGoldenSet();
    const entries = set.slice(0, 3);
    const tables = entries.map((e) => e.table);
    const recordsByTableId = new Map(entries.map((e) => [e.table.id, e.sample_records]));
    const fetchImpl = mockMetaAndRecordsFetch({ tables, recordsByTableId });
    const { runner } = makeMockRunner((e) => ({
      type: e.expected_type,
      reasoning: `mock-${e.expected_type}`,
    }));

    const { classifications, cachePath } = await classifyAllTables("appBase1", {
      fetch: fetchImpl,
      runClassifier: runner,
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheBaseDir: tmp,
      now: () => "2026-05-05T00:00:00.000Z",
    });

    expect(cachePath).toBe(join(tmp, "appBase1.json"));
    expect(existsSync(cachePath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(cachePath, "utf8"));
    for (const e of entries) {
      const entry = onDisk[e.table.id];
      expect(entry).toBeDefined();
      expect(entry.type).toBe(e.expected_type);
      expect(entry.reasoning).toBe(`mock-${e.expected_type}`);
      expect(entry.schema_hash).toBe(computeSchemaHash(e.table));
      expect(entry.classified_at).toBe("2026-05-05T00:00:00.000Z");
    }
    expect(classifications).toEqual(onDisk);
  });

  test("re-uses cached classification when schema_hash matches", async () => {
    const set = loadGoldenSet();
    const entry = set[0];
    const fetchImpl = mockMetaAndRecordsFetch({
      tables: [entry.table],
      recordsByTableId: new Map([[entry.table.id, entry.sample_records]]),
    });
    const { runner } = makeMockRunner((e) => ({
      type: e.expected_type,
      reasoning: `pass1`,
    }));

    // Pass 1 — populates cache
    await classifyAllTables("appBase2", {
      fetch: fetchImpl,
      runClassifier: runner,
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheBaseDir: tmp,
    });

    // Pass 2 — should NOT call runner (cache hit)
    let pass2Calls = 0;
    const runner2: ClassificationRunner = async () => {
      pass2Calls += 1;
      throw new Error("runner should not be called when schema_hash matches");
    };
    const { classifications } = await classifyAllTables("appBase2", {
      fetch: fetchImpl,
      runClassifier: runner2,
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheBaseDir: tmp,
    });
    expect(pass2Calls).toBe(0);
    expect(classifications[entry.table.id].reasoning).toBe("pass1");
  });

  test("re-classifies when schema_hash mismatches (field added)", async () => {
    const set = loadGoldenSet();
    const entry = set[0];
    // pass 1 — original schema
    const fetchA = mockMetaAndRecordsFetch({
      tables: [entry.table],
      recordsByTableId: new Map([[entry.table.id, entry.sample_records]]),
    });
    const runnerA: ClassificationRunner = async () => ({
      rawText: JSON.stringify({ type: "entity", reasoning: "v1" }),
      usage: { input_tokens: 10, output_tokens: 5 },
      model: DEFAULT_TABLE_TYPE_MODEL,
    });
    await classifyAllTables("appBase3", {
      fetch: fetchA,
      runClassifier: runnerA,
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheBaseDir: tmp,
    });

    // pass 2 — new field added → schema_hash mismatch → re-classify
    const newTable: AirtableTable = {
      ...entry.table,
      fields: [
        ...entry.table.fields,
        { id: "fldNew", name: "ExtraField", type: "singleLineText" },
      ],
    };
    const fetchB = mockMetaAndRecordsFetch({
      tables: [newTable],
      recordsByTableId: new Map([[newTable.id, entry.sample_records]]),
    });
    let pass2Calls = 0;
    const runnerB: ClassificationRunner = async () => {
      pass2Calls += 1;
      return {
        rawText: JSON.stringify({ type: "entity", reasoning: "v2" }),
        usage: { input_tokens: 10, output_tokens: 5 },
        model: DEFAULT_TABLE_TYPE_MODEL,
      };
    };
    const { classifications } = await classifyAllTables("appBase3", {
      fetch: fetchB,
      runClassifier: runnerB,
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheBaseDir: tmp,
    });
    expect(pass2Calls).toBe(1);
    expect(classifications[entry.table.id].reasoning).toBe("v2");
  });

  test("rejected tables are excluded from a returned `accepted` set", async () => {
    const set = loadGoldenSet();
    const okEntry = set.find((e) => e.expected_type === "entity")!;
    const rejectEntry = set.find((e) => e.expected_type === "reject")!;
    const tables = [okEntry.table, rejectEntry.table];
    const recordsByTableId = new Map([
      [okEntry.table.id, okEntry.sample_records],
      [rejectEntry.table.id, rejectEntry.sample_records],
    ]);
    const fetchImpl = mockMetaAndRecordsFetch({ tables, recordsByTableId });
    const { runner } = makeMockRunner((e) => ({
      type: e.expected_type,
      reasoning: `mock`,
    }));
    const warns: string[] = [];

    const { classifications } = await classifyAllTables("appBase4", {
      fetch: fetchImpl,
      runClassifier: runner,
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheBaseDir: tmp,
      warn: (m) => warns.push(m),
    });
    // Both classifications stored — downstream pipeline filters on type.
    expect(classifications[okEntry.table.id].type).toBe("entity");
    expect(classifications[rejectEntry.table.id].type).toBe("reject");
    // Reject must surface a warn line so the operator notices.
    expect(warns.some((w) => w.includes(rejectEntry.table.id))).toBe(true);
  });

  test("samples up to 5 records from a large table; orders by record id ascending", async () => {
    const t: AirtableTable = {
      id: "tblBig",
      name: "Big",
      fields: [{ id: "f1", name: "Title", type: "singleLineText" }],
    };
    // 10 records, intentionally out of order
    const records: AirtableRecord[] = [];
    for (const id of ["recE", "recA", "recC", "recH", "recB", "recD", "recG", "recF", "recI", "recJ"]) {
      records.push({ id, fields: { Title: id } });
    }
    const fetchImpl = mockMetaAndRecordsFetch({
      tables: [t],
      recordsByTableId: new Map([[t.id, records]]),
    });
    let observedPrompt = "";
    const runner: ClassificationRunner = async (prompt) => {
      observedPrompt = prompt;
      return {
        rawText: JSON.stringify({ type: "entity", reasoning: "ok" }),
        usage: { input_tokens: 10, output_tokens: 5 },
        model: DEFAULT_TABLE_TYPE_MODEL,
      };
    };
    await classifyAllTables("appBaseBig", {
      fetch: fetchImpl,
      runClassifier: runner,
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheBaseDir: tmp,
    });

    // Should include the 5 lowest-id records and exclude the rest
    expect(observedPrompt).toContain("recA");
    expect(observedPrompt).toContain("recB");
    expect(observedPrompt).toContain("recC");
    expect(observedPrompt).toContain("recD");
    expect(observedPrompt).toContain("recE");
    expect(observedPrompt).not.toContain("recH");
    expect(observedPrompt).not.toContain("recI");
    expect(observedPrompt).not.toContain("recJ");
  });

  test("graceful with fewer than 5 records (uses what's there, no fail)", async () => {
    const set = loadGoldenSet();
    const entry = set.find((e) => e.id === "empty-shell")!;
    const fetchImpl = mockMetaAndRecordsFetch({
      tables: [entry.table],
      recordsByTableId: new Map([[entry.table.id, []]]),
    });
    const runner: ClassificationRunner = async () => ({
      rawText: JSON.stringify({
        type: "reject",
        reasoning: "no records to assess uniqueness",
      }),
      usage: { input_tokens: 10, output_tokens: 5 },
      model: DEFAULT_TABLE_TYPE_MODEL,
    });
    const { classifications } = await classifyAllTables("appBaseEmpty", {
      fetch: fetchImpl,
      runClassifier: runner,
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheBaseDir: tmp,
    });
    expect(classifications[entry.table.id].type).toBe("reject");
  });

  test("persists cache across runs (idempotent re-read)", async () => {
    const set = loadGoldenSet();
    const entry = set[0];
    const fetchImpl = mockMetaAndRecordsFetch({
      tables: [entry.table],
      recordsByTableId: new Map([[entry.table.id, entry.sample_records]]),
    });
    const { runner } = makeMockRunner((e) => ({
      type: e.expected_type,
      reasoning: "first",
    }));
    const baseId = "appBasePersist";

    await classifyAllTables(baseId, {
      fetch: fetchImpl,
      runClassifier: runner,
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheBaseDir: tmp,
    });
    const cachePath = join(tmp, `${baseId}.json`);
    const beforeBytes = readFileSync(cachePath, "utf8");

    // second call — same schema → should not write a different cache
    const { runner: runner2 } = makeMockRunner((e) => ({
      type: e.expected_type,
      reasoning: "second",
    }));
    await classifyAllTables(baseId, {
      fetch: fetchImpl,
      runClassifier: runner2,
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheBaseDir: tmp,
    });
    const afterBytes = readFileSync(cachePath, "utf8");
    // Reasoning unchanged because the cache was reused.
    expect(JSON.parse(afterBytes)[entry.table.id].reasoning).toBe("first");
    expect(afterBytes).toBe(beforeBytes);
  });

  test("creates cache directory if missing", async () => {
    const set = loadGoldenSet();
    const entry = set[0];
    const fetchImpl = mockMetaAndRecordsFetch({
      tables: [entry.table],
      recordsByTableId: new Map([[entry.table.id, entry.sample_records]]),
    });
    const { runner } = makeMockRunner((e) => ({
      type: e.expected_type,
      reasoning: "x",
    }));
    const nestedDir = join(tmp, "deeply", "nested", "cache");
    expect(existsSync(nestedDir)).toBe(false);
    await classifyAllTables("appBaseNested", {
      fetch: fetchImpl,
      runClassifier: runner,
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheBaseDir: nestedDir,
    });
    expect(existsSync(join(nestedDir, "appBaseNested.json"))).toBe(true);
  });

  test("rejects haiku model in classifyAllTables", async () => {
    const set = loadGoldenSet();
    const entry = set[0];
    const fetchImpl = mockMetaAndRecordsFetch({
      tables: [entry.table],
      recordsByTableId: new Map([[entry.table.id, entry.sample_records]]),
    });
    const runner: ClassificationRunner = async () => ({
      rawText: "{}",
      usage: { input_tokens: 1, output_tokens: 1 },
      model: "claude-haiku-4-5",
    });
    await expect(
      classifyAllTables("appBaseHaiku", {
        fetch: fetchImpl,
        runClassifier: runner,
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheBaseDir: tmp,
        model: "claude-haiku-4-5",
      }),
    ).rejects.toThrow(/haiku/i);
  });
});

// ---------------------------------------------------------------------------
// Mock-mode golden-set agreement (deterministic — always runs)
// ---------------------------------------------------------------------------

describe("golden-set classification (mock — deterministic)", () => {
  test("perfect mock → 100% agreement (validates pipeline glue, not LLM fidelity)", async () => {
    const set = loadGoldenSet();
    const { runner } = makeMockRunner((e) => ({
      type: e.expected_type,
      reasoning: "mocked-correct",
    }));
    let agree = 0;
    for (const e of set) {
      const result = await classifyTableType(
        { table: e.table, sampleRecords: e.sample_records },
        { runClassifier: runner, warn: () => {} },
      );
      if (result.type === e.expected_type) agree += 1;
    }
    expect(agree / set.length).toBeGreaterThanOrEqual(0.95);
  });
});

// ---------------------------------------------------------------------------
// Live-mode (gated by AIRTABLE_TABLE_TYPE_LIVE=1)
// ---------------------------------------------------------------------------

describe("golden-set classification (live claude -p — AIRTABLE_TABLE_TYPE_LIVE=1)", () => {
  const live = process.env.AIRTABLE_TABLE_TYPE_LIVE === "1";

  test.skipIf(!live)(
    "real classifier achieves ≥95% agreement against golden-set fixture",
    async () => {
      const set = loadGoldenSet();
      let agree = 0;
      const disagreements: Array<{
        id: string;
        expected: TableType;
        got: TableType;
        reasoning: string;
      }> = [];
      for (const e of set) {
        const result = await classifyTableType(
          { table: e.table, sampleRecords: e.sample_records },
          { warn: () => {} },
        );
        if (result.type === e.expected_type) {
          agree += 1;
        } else {
          disagreements.push({
            id: e.id,
            expected: e.expected_type,
            got: result.type,
            reasoning: result.reasoning,
          });
        }
      }
      const rate = agree / set.length;
      // eslint-disable-next-line no-console
      console.log(
        `[classify-table-type live] agreement=${rate.toFixed(3)} (${agree}/${set.length})`,
      );
      if (disagreements.length > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[classify-table-type live] disagreements: ${JSON.stringify(disagreements, null, 2)}`,
        );
      }
      expect(rate).toBeGreaterThanOrEqual(0.95);
    },
    600_000,
  );
});

// Suppress unused-import warning when test fails before mkdirSync/writeFileSync are referenced.
void mkdirSync;
void writeFileSync;
