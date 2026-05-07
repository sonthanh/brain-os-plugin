/**
 * classify-text-field-entities.test.ts — S5a text-field entity classifier
 * (ai-brain#251, parent #237).
 *
 * Validates pipeline glue (prompt build, response parser, schema_hash cache,
 * HITL audit-gate, model gate, text-field selection). Mocks the LLM runner —
 * no `claude -p` calls and no Airtable network (all I/O is stubbed via the
 * `fetch` and `runClassifier` injection points).
 */
import {
  describe,
  expect,
  test,
  beforeEach,
  afterEach,
} from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClassifyTextFieldEntitiesPrompt,
  parseClassifyTextFieldEntitiesResponse,
  classifyTextFieldEntities,
  classifyAllInteractionTables,
  selectTextFields,
  isTextField,
  lowConfidenceFields,
  entityFields,
  assertNotHaiku,
  pickSampleRecords,
  DEFAULT_TEXT_FIELD_ENTITY_MODEL,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DECISION_NEEDED_FILENAME,
  DECISION_FILENAME,
  type ClassificationRunner,
  type TableTextFieldClassification,
  type FieldClassification,
} from "../scripts/classify-text-field-entities.mts";
import type { AirtableTable } from "../scripts/classify-clusters.mts";
import type { AirtableRecord } from "../scripts/legacy-link-detector.mts";
import type { TableTypeClassification } from "../scripts/classify-table-type.mts";
import { HITL_PENDING_EXIT_CODE, HitlPendingError } from "../scripts/hitl.mts";

// ---------------------------------------------------------------------------
// Fixtures — Staronline Payments + Cashflow + a Sales Activity-like table
// ---------------------------------------------------------------------------

const PAYMENTS_TABLE: AirtableTable = {
  id: "tblPayments",
  name: "Payments",
  fields: [
    { id: "fld1", name: "Payer Name", type: "singleLineText" },
    { id: "fld2", name: "Payee Name", type: "singleLineText" },
    { id: "fld3", name: "Amount", type: "currency" },
    { id: "fld4", name: "Payment Date", type: "date" },
    { id: "fld5", name: "Reference Number", type: "singleLineText" },
    {
      id: "fld6",
      name: "Cashflow",
      type: "multipleRecordLinks",
      options: { linkedTableId: "tblCashflows" },
    },
  ],
};

const PAYMENT_RECORDS: AirtableRecord[] = [
  {
    id: "recP1",
    fields: {
      "Payer Name": "John Doe",
      "Payee Name": "Acme Corp",
      Amount: 1000,
      "Payment Date": "2025-09-01",
      "Reference Number": "PAY-001",
      Cashflow: ["recCF1"],
    },
  },
  {
    id: "recP2",
    fields: {
      "Payer Name": "Jane Smith",
      "Payee Name": "Acme Corp",
      Amount: 2500,
      "Payment Date": "2025-09-15",
      "Reference Number": "PAY-002",
      Cashflow: ["recCF2"],
    },
  },
];

const CASHFLOWS_TABLE: AirtableTable = {
  id: "tblCashflows",
  name: "Cashflows",
  fields: [
    { id: "fld1", name: "Name", type: "singleLineText" },
    { id: "fld2", name: "Amount", type: "currency" },
    { id: "fld3", name: "Transaction Date", type: "date" },
    {
      id: "fld4",
      name: "Payments",
      type: "multipleRecordLinks",
      options: { linkedTableId: "tblPayments" },
    },
  ],
};

const CASHFLOW_RECORDS: AirtableRecord[] = [
  {
    id: "recCF1",
    fields: {
      Name: "Funds received from angel investors to support platform expansion.",
      Amount: 10000,
      "Transaction Date": "2025-09-01",
      Payments: ["recP1"],
    },
  },
  {
    id: "recCF2",
    fields: {
      Name: "Monthly subscription payments collected from users for September 2025.",
      Amount: 1200,
      "Transaction Date": "2025-09-15",
      Payments: ["recP2"],
    },
  },
];

// ---------------------------------------------------------------------------
// Mock runner — keyed on table name in prompt
// ---------------------------------------------------------------------------

interface MockMap {
  [tableName: string]: { fields: Record<string, FieldClassification> };
}

function makeMockRunner(map: MockMap): {
  runner: ClassificationRunner;
  callCount: () => number;
} {
  let calls = 0;
  const runner: ClassificationRunner = async (prompt: string) => {
    calls += 1;
    let match: { fields: Record<string, FieldClassification> } | null = null;
    for (const [name, response] of Object.entries(map)) {
      if (prompt.includes(`Table: ${name}`)) {
        match = response;
        break;
      }
    }
    if (!match) {
      throw new Error(`mock runner: no entry matched the prompt`);
    }
    return {
      rawText: JSON.stringify(match),
      usage: { input_tokens: 100, output_tokens: 50 },
      model: DEFAULT_TEXT_FIELD_ENTITY_MODEL,
    };
  };
  return { runner, callCount: () => calls };
}

const HIGH_CONF_PAYMENTS = {
  Payments: {
    fields: {
      "Payer Name": {
        kind: "person" as const,
        role: "from-like" as const,
        confidence: 0.95,
        reasoning: "'Payer Name' values are person names like 'John Doe'.",
      },
      "Payee Name": {
        kind: "person" as const,
        role: "to-like" as const,
        confidence: 0.92,
        reasoning: "'Payee Name' values like 'Acme Corp' are recipient names.",
      },
      "Reference Number": {
        kind: "none" as const,
        role: "none" as const,
        confidence: 0.99,
        reasoning: "Values like 'PAY-001' are IDs, not entity references.",
      },
    },
  },
};

const HIGH_CONF_CASHFLOWS = {
  Cashflows: {
    fields: {
      Name: {
        kind: "none" as const,
        role: "none" as const,
        confidence: 0.95,
        reasoning: "Values are transaction descriptions, not person/company names.",
      },
    },
  },
};

const LOW_CONF_PAYMENTS = {
  Payments: {
    fields: {
      "Payer Name": {
        kind: "person" as const,
        role: "from-like" as const,
        confidence: 0.7,
        reasoning: "Values look name-like but field name is ambiguous.",
      },
      "Payee Name": {
        kind: "person" as const,
        role: "to-like" as const,
        confidence: 0.95,
        reasoning: "'Payee Name' values are entity references.",
      },
      "Reference Number": {
        kind: "none" as const,
        role: "none" as const,
        confidence: 0.99,
        reasoning: "Reference numbers are IDs.",
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("isTextField / selectTextFields", () => {
  test("recognises singleLineText, multilineText, richText, email, phoneNumber", () => {
    expect(isTextField({ id: "f", name: "x", type: "singleLineText" })).toBe(true);
    expect(isTextField({ id: "f", name: "x", type: "multilineText" })).toBe(true);
    expect(isTextField({ id: "f", name: "x", type: "richText" })).toBe(true);
    expect(isTextField({ id: "f", name: "x", type: "email" })).toBe(true);
    expect(isTextField({ id: "f", name: "x", type: "phoneNumber" })).toBe(true);
  });
  test("rejects non-text types", () => {
    expect(isTextField({ id: "f", name: "x", type: "currency" })).toBe(false);
    expect(isTextField({ id: "f", name: "x", type: "date" })).toBe(false);
    expect(isTextField({ id: "f", name: "x", type: "multipleRecordLinks" })).toBe(false);
  });
  test("selectTextFields filters Payments table to 3 text fields", () => {
    const fields = selectTextFields(PAYMENTS_TABLE);
    expect(fields.map((f) => f.name)).toEqual([
      "Payer Name",
      "Payee Name",
      "Reference Number",
    ]);
  });
});

describe("buildClassifyTextFieldEntitiesPrompt", () => {
  test("includes table name + id, all text fields, sample values, and STRICT JSON instruction", () => {
    const prompt = buildClassifyTextFieldEntitiesPrompt({
      table: PAYMENTS_TABLE,
      sampleRecords: PAYMENT_RECORDS,
    });
    expect(prompt).toContain("Table: Payments (tblPayments)");
    expect(prompt).toContain("Payer Name");
    expect(prompt).toContain("Payee Name");
    expect(prompt).toContain("Reference Number");
    expect(prompt).toContain("John Doe");
    expect(prompt).toContain("Acme Corp");
    expect(prompt).toContain("STRICT JSON");
    expect(prompt).toContain("from-like");
    expect(prompt).toContain("to-like");
  });

  test("does not show non-text field VALUES (Amount=1000) but does show schema-line type", () => {
    const prompt = buildClassifyTextFieldEntitiesPrompt({
      table: PAYMENTS_TABLE,
      sampleRecords: PAYMENT_RECORDS,
    });
    expect(prompt).toContain("Amount :: currency");
    expect(prompt).not.toContain("Amount: 1000");
    expect(prompt).not.toContain("Amount: 2500");
  });

  test("warns when no records present", () => {
    const prompt = buildClassifyTextFieldEntitiesPrompt({
      table: PAYMENTS_TABLE,
      sampleRecords: [],
    });
    expect(prompt).toContain("(no records — empty table)");
  });
});

describe("parseClassifyTextFieldEntitiesResponse", () => {
  test("parses a clean JSON response", () => {
    const text = JSON.stringify(HIGH_CONF_PAYMENTS.Payments);
    const out = parseClassifyTextFieldEntitiesResponse(text);
    expect(out.fields["Payer Name"].kind).toBe("person");
    expect(out.fields["Payer Name"].role).toBe("from-like");
    expect(out.fields["Payer Name"].confidence).toBe(0.95);
  });

  test("strips markdown fences", () => {
    const text =
      "```json\n" + JSON.stringify(HIGH_CONF_PAYMENTS.Payments) + "\n```";
    const out = parseClassifyTextFieldEntitiesResponse(text);
    expect(out.fields["Payer Name"]).toBeDefined();
  });

  test("rejects invalid kind", () => {
    const bad = {
      fields: {
        Foo: {
          kind: "bogus",
          role: "from-like",
          confidence: 0.9,
          reasoning: "test",
        },
      },
    };
    expect(() => parseClassifyTextFieldEntitiesResponse(JSON.stringify(bad))).toThrow(
      /invalid kind/,
    );
  });

  test("rejects invalid role", () => {
    const bad = {
      fields: {
        Foo: {
          kind: "person",
          role: "bogus",
          confidence: 0.9,
          reasoning: "test",
        },
      },
    };
    expect(() => parseClassifyTextFieldEntitiesResponse(JSON.stringify(bad))).toThrow(
      /invalid role/,
    );
  });

  test("rejects out-of-range confidence", () => {
    const bad = {
      fields: {
        Foo: {
          kind: "person",
          role: "from-like",
          confidence: 1.5,
          reasoning: "test",
        },
      },
    };
    expect(() => parseClassifyTextFieldEntitiesResponse(JSON.stringify(bad))).toThrow(
      /invalid confidence/,
    );
  });

  test("rejects kind=none with role!=none", () => {
    const bad = {
      fields: {
        Foo: {
          kind: "none",
          role: "from-like",
          confidence: 0.9,
          reasoning: "test",
        },
      },
    };
    expect(() => parseClassifyTextFieldEntitiesResponse(JSON.stringify(bad))).toThrow(
      /must be none when kind is none/,
    );
  });
});

describe("classifyTextFieldEntities (single table)", () => {
  test("returns classification with schema_hash + classified_at", async () => {
    const { runner } = makeMockRunner(HIGH_CONF_PAYMENTS);
    const result = await classifyTextFieldEntities(
      { table: PAYMENTS_TABLE, sampleRecords: PAYMENT_RECORDS },
      { runClassifier: runner, now: () => "2026-05-07T12:00:00Z" },
    );
    expect(result.fields["Payer Name"].kind).toBe("person");
    expect(result.fields["Payee Name"].role).toBe("to-like");
    expect(result.fields["Reference Number"].kind).toBe("none");
    expect(result.classified_at).toBe("2026-05-07T12:00:00Z");
    expect(result.schema_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("skips LLM for tables with no text fields", async () => {
    const { runner, callCount } = makeMockRunner({});
    const NO_TEXT: AirtableTable = {
      id: "tblNoText",
      name: "NoText",
      fields: [
        { id: "f1", name: "Amount", type: "currency" },
        { id: "f2", name: "Date", type: "date" },
      ],
    };
    const result = await classifyTextFieldEntities(
      { table: NO_TEXT, sampleRecords: [] },
      { runClassifier: runner },
    );
    expect(callCount()).toBe(0);
    expect(Object.keys(result.fields).length).toBe(0);
  });

  test("throws when response missing a text field", async () => {
    const partial = {
      Payments: {
        fields: {
          "Payer Name": {
            kind: "person",
            role: "from-like",
            confidence: 0.9,
            reasoning: "ok",
          },
        },
      },
    };
    const { runner } = makeMockRunner(partial as MockMap);
    await expect(
      classifyTextFieldEntities(
        { table: PAYMENTS_TABLE, sampleRecords: PAYMENT_RECORDS },
        { runClassifier: runner },
      ),
    ).rejects.toThrow(/missing classification for text field/);
  });
});

describe("assertNotHaiku", () => {
  test("rejects haiku models", () => {
    expect(() => assertNotHaiku("claude-haiku-4-5-20251001")).toThrow(/Haiku/);
    expect(() => assertNotHaiku("claude-3-5-haiku-latest")).toThrow(/Haiku/);
  });
  test("accepts opus + sonnet", () => {
    expect(() => assertNotHaiku("claude-opus-4-6")).not.toThrow();
    expect(() => assertNotHaiku("claude-sonnet-4-6")).not.toThrow();
    expect(() => assertNotHaiku("claude-opus-4-7")).not.toThrow();
  });
});

describe("lowConfidenceFields + entityFields", () => {
  test("lowConfidenceFields returns names below threshold", () => {
    const c: TableTextFieldClassification = {
      schema_hash: "h",
      classified_at: "t",
      fields: {
        a: { kind: "person", role: "from-like", confidence: 0.9, reasoning: "x" },
        b: { kind: "person", role: "to-like", confidence: 0.7, reasoning: "x" },
        c: { kind: "none", role: "none", confidence: 0.99, reasoning: "x" },
      },
    };
    expect(lowConfidenceFields(c, 0.85)).toEqual(["b"]);
  });

  test("entityFields excludes none, includes person + company with role", () => {
    const c: TableTextFieldClassification = {
      schema_hash: "h",
      classified_at: "t",
      fields: {
        Payer: { kind: "person", role: "from-like", confidence: 0.95, reasoning: "x" },
        Payee: { kind: "company", role: "to-like", confidence: 0.95, reasoning: "x" },
        Ref: { kind: "none", role: "none", confidence: 0.99, reasoning: "x" },
      },
    };
    expect(entityFields(c)).toEqual([
      { name: "Payer", kind: "person", role: "from-like" },
      { name: "Payee", kind: "company", role: "to-like" },
    ]);
  });
});

describe("pickSampleRecords", () => {
  test("returns up to N records sorted by id", () => {
    const records: AirtableRecord[] = [
      { id: "recC", fields: {} },
      { id: "recA", fields: {} },
      { id: "recB", fields: {} },
    ];
    const out = pickSampleRecords(records, 2);
    expect(out.map((r) => r.id)).toEqual(["recA", "recB"]);
  });
});

// ---------------------------------------------------------------------------
// classifyAllInteractionTables — integration with Stage 0 cache + Airtable I/O
// ---------------------------------------------------------------------------

let tmp: string;
let stage0Dir: string;
let cacheDir: string;
let hitlDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tfent-test-"));
  stage0Dir = join(tmp, "stage0");
  cacheDir = join(tmp, "cache");
  hitlDir = join(tmp, "hitl");
  mkdirSync(stage0Dir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeStage0(baseId: string, classifications: Record<string, TableTypeClassification>) {
  writeFileSync(join(stage0Dir, `${baseId}.json`), JSON.stringify(classifications, null, 2));
}

function makeFetch(
  metaTables: AirtableTable[],
  recordsByTable: Record<string, AirtableRecord[]>,
): typeof globalThis.fetch {
  return (async (url: string | URL, _opts?: unknown) => {
    const u = url.toString();
    if (u.includes("/meta/bases/")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ tables: metaTables }),
        text: async () => "",
      } as unknown as Response;
    }
    for (const [tableId, records] of Object.entries(recordsByTable)) {
      if (u.includes(tableId)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ records }),
          text: async () => "",
        } as unknown as Response;
      }
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => "not found",
      statusText: "not found",
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}

describe("classifyAllInteractionTables — Stage 0 integration", () => {
  test("reads Stage 0 cache, classifies only interaction tables, writes per-base cache", async () => {
    writeStage0("appTest", {
      tblPayments: {
        type: "interaction",
        reasoning: "payment events",
        schema_hash: "old",
        classified_at: "t0",
      },
      tblCashflows: {
        type: "interaction",
        reasoning: "cashflow events",
        schema_hash: "old",
        classified_at: "t0",
      },
      tblPeople: {
        type: "entity",
        reasoning: "people are entities",
        schema_hash: "old",
        classified_at: "t0",
      },
    });

    const { runner, callCount } = makeMockRunner({
      ...HIGH_CONF_PAYMENTS,
      ...HIGH_CONF_CASHFLOWS,
    });
    const fetchImpl = makeFetch(
      [PAYMENTS_TABLE, CASHFLOWS_TABLE],
      {
        [PAYMENTS_TABLE.id]: PAYMENT_RECORDS,
        [CASHFLOWS_TABLE.id]: CASHFLOW_RECORDS,
      },
    );

    const result = await classifyAllInteractionTables("appTest", {
      fetch: fetchImpl,
      runClassifier: runner,
      env: { AIRTABLE_API_KEY: "fake-token" },
      cacheBaseDir: cacheDir,
      stage0CacheBaseDir: stage0Dir,
      hitlDir,
      now: () => "2026-05-07T12:00:00Z",
    });

    expect(callCount()).toBe(2);
    expect(result.tablesProcessed.sort()).toEqual(["tblCashflows", "tblPayments"]);
    expect(result.classifications.tblPayments.fields["Payer Name"].kind).toBe("person");
    expect(result.classifications.tblCashflows.fields.Name.kind).toBe("none");
    expect(existsSync(result.cachePath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(result.cachePath, "utf8"));
    expect(onDisk.tblPayments.schema_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("schema_hash unchanged → cache hit, 0 LLM calls", async () => {
    writeStage0("appTest", {
      tblPayments: {
        type: "interaction",
        reasoning: "x",
        schema_hash: "old",
        classified_at: "t0",
      },
    });

    const fetchImpl = makeFetch([PAYMENTS_TABLE], {
      [PAYMENTS_TABLE.id]: PAYMENT_RECORDS,
    });

    const { runner: runner1, callCount: cc1 } = makeMockRunner(HIGH_CONF_PAYMENTS);
    const first = await classifyAllInteractionTables("appTest", {
      fetch: fetchImpl,
      runClassifier: runner1,
      env: { AIRTABLE_API_KEY: "fake-token" },
      cacheBaseDir: cacheDir,
      stage0CacheBaseDir: stage0Dir,
      hitlDir,
      now: () => "2026-05-07T12:00:00Z",
    });
    expect(cc1()).toBe(1);
    expect(first.tablesProcessed).toEqual(["tblPayments"]);

    const { runner: runner2, callCount: cc2 } = makeMockRunner(HIGH_CONF_PAYMENTS);
    const second = await classifyAllInteractionTables("appTest", {
      fetch: fetchImpl,
      runClassifier: runner2,
      env: { AIRTABLE_API_KEY: "fake-token" },
      cacheBaseDir: cacheDir,
      stage0CacheBaseDir: stage0Dir,
      hitlDir,
      now: () => "2026-05-07T12:00:00Z",
    });
    expect(cc2()).toBe(0);
    expect(second.tablesSkippedCached).toEqual(["tblPayments"]);
    expect(second.tablesProcessed).toEqual([]);
  });

  test("schema change → re-classify (cache invalidated)", async () => {
    writeStage0("appTest", {
      tblPayments: {
        type: "interaction",
        reasoning: "x",
        schema_hash: "old",
        classified_at: "t0",
      },
    });

    const fetchImpl1 = makeFetch([PAYMENTS_TABLE], {
      [PAYMENTS_TABLE.id]: PAYMENT_RECORDS,
    });
    const { runner: runner1 } = makeMockRunner(HIGH_CONF_PAYMENTS);
    await classifyAllInteractionTables("appTest", {
      fetch: fetchImpl1,
      runClassifier: runner1,
      env: { AIRTABLE_API_KEY: "fake-token" },
      cacheBaseDir: cacheDir,
      stage0CacheBaseDir: stage0Dir,
      hitlDir,
      now: () => "t1",
    });

    // Add a new field — schema_hash changes.
    const evolved: AirtableTable = {
      ...PAYMENTS_TABLE,
      fields: [
        ...PAYMENTS_TABLE.fields,
        { id: "fldNew", name: "Memo", type: "singleLineText" },
      ],
    };
    const fetchImpl2 = makeFetch([evolved], {
      [evolved.id]: PAYMENT_RECORDS,
    });
    const { runner: runner2, callCount: cc2 } = makeMockRunner({
      Payments: {
        fields: {
          ...HIGH_CONF_PAYMENTS.Payments.fields,
          Memo: {
            kind: "none" as const,
            role: "none" as const,
            confidence: 0.95,
            reasoning: "free text memo",
          },
        },
      },
    });
    const result = await classifyAllInteractionTables("appTest", {
      fetch: fetchImpl2,
      runClassifier: runner2,
      env: { AIRTABLE_API_KEY: "fake-token" },
      cacheBaseDir: cacheDir,
      stage0CacheBaseDir: stage0Dir,
      hitlDir,
      now: () => "t2",
    });
    expect(cc2()).toBe(1);
    expect(result.tablesProcessed).toEqual(["tblPayments"]);
    expect(result.classifications.tblPayments.fields.Memo.kind).toBe("none");
  });

  test("low confidence → throws HitlPendingError + writes decision-needed JSON", async () => {
    writeStage0("appTest", {
      tblPayments: {
        type: "interaction",
        reasoning: "x",
        schema_hash: "old",
        classified_at: "t0",
      },
    });
    const fetchImpl = makeFetch([PAYMENTS_TABLE], {
      [PAYMENTS_TABLE.id]: PAYMENT_RECORDS,
    });
    const { runner } = makeMockRunner(LOW_CONF_PAYMENTS);

    await expect(
      classifyAllInteractionTables("appTest", {
        fetch: fetchImpl,
        runClassifier: runner,
        env: { AIRTABLE_API_KEY: "fake-token" },
        cacheBaseDir: cacheDir,
        stage0CacheBaseDir: stage0Dir,
        hitlDir,
        now: () => "t1",
      }),
    ).rejects.toThrow(HitlPendingError);

    const neededPath = join(hitlDir, DECISION_NEEDED_FILENAME);
    expect(existsSync(neededPath)).toBe(true);
    const payload = JSON.parse(readFileSync(neededPath, "utf8"));
    expect(payload.base_id).toBe("appTest");
    expect(payload.table_id).toBe("tblPayments");
    expect(payload.fields_needing_review.length).toBe(1);
    expect(payload.fields_needing_review[0].field_name).toBe("Payer Name");
    expect(payload.fields_needing_review[0].sample_values).toContain("John Doe");
    expect(payload.wake_token).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("decision file present → consumes + merges + deletes decision file", async () => {
    writeStage0("appTest", {
      tblPayments: {
        type: "interaction",
        reasoning: "x",
        schema_hash: "old",
        classified_at: "t0",
      },
    });
    const fetchImpl = makeFetch([PAYMENTS_TABLE], {
      [PAYMENTS_TABLE.id]: PAYMENT_RECORDS,
    });
    const { runner } = makeMockRunner(LOW_CONF_PAYMENTS);

    mkdirSync(hitlDir, { recursive: true });
    const decisionPath = join(hitlDir, DECISION_FILENAME);
    writeFileSync(
      decisionPath,
      JSON.stringify({
        decisions: {
          "Payer Name": {
            kind: "person",
            role: "from-like",
            confidence: 1.0,
            reasoning: "user confirmed Payer is the from-side",
          },
        },
      }),
    );

    const result = await classifyAllInteractionTables("appTest", {
      fetch: fetchImpl,
      runClassifier: runner,
      env: { AIRTABLE_API_KEY: "fake-token" },
      cacheBaseDir: cacheDir,
      stage0CacheBaseDir: stage0Dir,
      hitlDir,
      now: () => "t1",
    });

    expect(result.classifications.tblPayments.fields["Payer Name"].confidence).toBe(1.0);
    expect(existsSync(decisionPath)).toBe(false);
  });

  test("Stage 0 cache absent → throws", async () => {
    await expect(
      classifyAllInteractionTables("appMissing", {
        fetch: globalThis.fetch,
        env: { AIRTABLE_API_KEY: "fake-token" },
        cacheBaseDir: cacheDir,
        stage0CacheBaseDir: stage0Dir,
        hitlDir,
      }),
    ).rejects.toThrow(/Stage 0 cache absent/);
  });

  test("no interaction tables in Stage 0 → no LLM call, writes empty cache", async () => {
    writeStage0("appAllEntity", {
      tblPeople: {
        type: "entity",
        reasoning: "x",
        schema_hash: "old",
        classified_at: "t0",
      },
    });
    const { runner, callCount } = makeMockRunner({});
    const result = await classifyAllInteractionTables("appAllEntity", {
      fetch: globalThis.fetch,
      runClassifier: runner,
      env: { AIRTABLE_API_KEY: "fake-token" },
      cacheBaseDir: cacheDir,
      stage0CacheBaseDir: stage0Dir,
      hitlDir,
    });
    expect(callCount()).toBe(0);
    expect(result.tablesProcessed).toEqual([]);
    expect(result.classifications).toEqual({});
  });
});

describe("HITL_PENDING_EXIT_CODE re-export sanity", () => {
  test("matches the canonical 42", () => {
    expect(HITL_PENDING_EXIT_CODE).toBe(42);
  });
});
