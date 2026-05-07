/**
 * extract-text-field-entities.test.ts — S5b deterministic entity emitter
 * (ai-brain#251, parent #237).
 */
import {
  describe,
  expect,
  test,
  beforeEach,
  afterEach,
} from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalName,
  buildEntities,
  walkTable,
  renderEntityPage,
  writeEntityPages,
  extractTextFieldEntities,
  type WalkInput,
  type TextFieldEntity,
} from "../scripts/extract-text-field-entities.mts";
import type { AirtableTable } from "../scripts/classify-clusters.mts";
import type { AirtableRecord } from "../scripts/legacy-link-detector.mts";
import type { TableTextFieldClassification } from "../scripts/classify-text-field-entities.mts";
import type { TableTypeClassification } from "../scripts/classify-table-type.mts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE = "appUV3hAWcRzrGjqK";

const PAYMENTS_TABLE: AirtableTable = {
  id: "tblPayments",
  name: "Payments",
  fields: [
    { id: "f1", name: "Payer Name", type: "singleLineText" },
    { id: "f2", name: "Payee Name", type: "singleLineText" },
    { id: "f3", name: "Amount", type: "currency" },
    { id: "f4", name: "Reference Number", type: "singleLineText" },
  ],
};

const PAYMENT_RECORDS: AirtableRecord[] = [
  {
    id: "recP1",
    fields: {
      "Payer Name": "John Doe",
      "Payee Name": "Acme Corp",
      Amount: 1000,
      "Reference Number": "PAY-001",
    },
  },
  {
    id: "recP2",
    fields: {
      "Payer Name": "John Doe",
      "Payee Name": "Acme Corp",
      Amount: 2000,
      "Reference Number": "PAY-002",
    },
  },
  {
    id: "recP3",
    fields: {
      "Payer Name": "  john  doe  ",
      "Payee Name": "Beta LLC",
      Amount: 500,
      "Reference Number": "PAY-003",
    },
  },
  {
    id: "recP4",
    fields: {
      "Payer Name": "Jane Smith",
      "Payee Name": "Acme Corp",
      Amount: 750,
      "Reference Number": "PAY-004",
    },
  },
];

const PAYMENTS_CLS: TableTextFieldClassification = {
  schema_hash: "h1",
  classified_at: "t0",
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
    "Reference Number": {
      kind: "none",
      role: "none",
      confidence: 0.99,
      reasoning: "ids",
    },
  },
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("canonicalName", () => {
  test("trims, NFKC-normalises, lowercases, collapses whitespace", () => {
    expect(canonicalName("John Doe")).toBe("john doe");
    expect(canonicalName("  John   Doe  ")).toBe("john doe");
    expect(canonicalName("JOHN DOE")).toBe("john doe");
  });
  test("preserves Unicode", () => {
    expect(canonicalName("Nguyễn Văn A")).toContain("nguyễn");
  });
});

describe("walkTable + buildEntities", () => {
  test("dedups by canonical name, accumulates source_record_ids + tables", () => {
    const inputs: WalkInput[] = [
      {
        baseId: BASE,
        table: PAYMENTS_TABLE,
        records: PAYMENT_RECORDS,
        classification: PAYMENTS_CLS,
      },
    ];
    const { entities, warnings } = buildEntities(inputs);
    const slugs = entities.map((e) => e.slug);
    expect(slugs).toContain("john-doe");
    expect(slugs).toContain("acme-corp");
    expect(slugs).toContain("jane-smith");
    expect(slugs).toContain("beta-llc");
    expect(warnings).toEqual([]);

    const john = entities.find((e) => e.slug === "john-doe")!;
    expect(john.kind).toBe("person");
    expect(john.roles).toEqual(["from-like"]);
    expect(john.source_record_ids.sort()).toEqual([
      `${BASE}-recP1`,
      `${BASE}-recP2`,
      `${BASE}-recP3`,
    ]);
    expect(john.source_tables).toEqual(["Payments"]);
    expect(john.field_mentions).toEqual([
      { field: "Payer Name", table: "Payments", count: 3 },
    ]);

    const acme = entities.find((e) => e.slug === "acme-corp")!;
    expect(acme.kind).toBe("company");
    expect(acme.roles).toEqual(["to-like"]);
    expect(acme.source_record_ids.length).toBe(3);
    expect(acme.field_mentions).toEqual([
      { field: "Payee Name", table: "Payments", count: 3 },
    ]);
  });

  test("ignores non-string field values", () => {
    const records: AirtableRecord[] = [
      { id: "rec1", fields: { "Payer Name": 12345 } },
      { id: "rec2", fields: { "Payer Name": null } },
      { id: "rec3", fields: { "Payer Name": "" } },
    ];
    const cls: TableTextFieldClassification = {
      schema_hash: "h",
      classified_at: "t",
      fields: {
        "Payer Name": {
          kind: "person",
          role: "from-like",
          confidence: 0.95,
          reasoning: "x",
        },
      },
    };
    const { entities } = buildEntities([
      { baseId: BASE, table: PAYMENTS_TABLE, records, classification: cls },
    ]);
    expect(entities).toEqual([]);
  });

  test("ignores classification with no entity fields", () => {
    const cls: TableTextFieldClassification = {
      schema_hash: "h",
      classified_at: "t",
      fields: {
        "Reference Number": {
          kind: "none",
          role: "none",
          confidence: 0.99,
          reasoning: "id",
        },
      },
    };
    const { entities } = buildEntities([
      {
        baseId: BASE,
        table: PAYMENTS_TABLE,
        records: PAYMENT_RECORDS,
        classification: cls,
      },
    ]);
    expect(entities).toEqual([]);
  });

  test("kind conflict (person vs company on same canonical) emits warning + keeps first", () => {
    const TABLE_A: AirtableTable = {
      id: "tblA",
      name: "A",
      fields: [{ id: "f1", name: "Sender", type: "singleLineText" }],
    };
    const TABLE_B: AirtableTable = {
      id: "tblB",
      name: "B",
      fields: [{ id: "f1", name: "Org", type: "singleLineText" }],
    };
    const CLS_A: TableTextFieldClassification = {
      schema_hash: "h",
      classified_at: "t",
      fields: {
        Sender: { kind: "person", role: "from-like", confidence: 0.95, reasoning: "x" },
      },
    };
    const CLS_B: TableTextFieldClassification = {
      schema_hash: "h",
      classified_at: "t",
      fields: {
        Org: { kind: "company", role: "undirected", confidence: 0.95, reasoning: "x" },
      },
    };
    const { entities, warnings } = buildEntities([
      {
        baseId: BASE,
        table: TABLE_A,
        records: [{ id: "r1", fields: { Sender: "Foo" } }],
        classification: CLS_A,
      },
      {
        baseId: BASE,
        table: TABLE_B,
        records: [{ id: "r2", fields: { Org: "foo" } }],
        classification: CLS_B,
      },
    ]);
    expect(entities.length).toBe(1);
    expect(entities[0].kind).toBe("person"); // first wins
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("kind conflict");
  });

  test("multiple roles across mentions → roles list deduplicated + sorted", () => {
    const TABLE: AirtableTable = {
      id: "tbl",
      name: "T",
      fields: [
        { id: "f1", name: "Payer", type: "singleLineText" },
        { id: "f2", name: "Payee", type: "singleLineText" },
      ],
    };
    const CLS: TableTextFieldClassification = {
      schema_hash: "h",
      classified_at: "t",
      fields: {
        Payer: { kind: "person", role: "from-like", confidence: 0.95, reasoning: "x" },
        Payee: { kind: "person", role: "to-like", confidence: 0.95, reasoning: "x" },
      },
    };
    const { entities } = buildEntities([
      {
        baseId: BASE,
        table: TABLE,
        records: [
          { id: "r1", fields: { Payer: "Alex", Payee: "Beth" } },
          { id: "r2", fields: { Payer: "Beth", Payee: "Alex" } },
        ],
        classification: CLS,
      },
    ]);
    const alex = entities.find((e) => e.slug === "alex")!;
    expect(alex.roles).toEqual(["from-like", "to-like"]);
  });

  test("output sorted by slug (idempotent)", () => {
    const inputs: WalkInput[] = [
      {
        baseId: BASE,
        table: PAYMENTS_TABLE,
        records: PAYMENT_RECORDS,
        classification: PAYMENTS_CLS,
      },
    ];
    const { entities } = buildEntities(inputs);
    const slugs = entities.map((e) => e.slug);
    const sorted = [...slugs].sort();
    expect(slugs).toEqual(sorted);
  });
});

describe("renderEntityPage", () => {
  test("emits valid frontmatter with required keys + body paragraph", () => {
    const entity: TextFieldEntity = {
      name: "John Doe",
      canonical: "john doe",
      slug: "john-doe",
      kind: "person",
      roles: ["from-like"],
      source_record_ids: [`${BASE}-recP1`, `${BASE}-recP2`, `${BASE}-recP3`],
      source_tables: ["Payments"],
      field_mentions: [{ field: "Payer Name", table: "Payments", count: 3 }],
    };
    const page = renderEntityPage(entity, BASE, "2026-05-07T12:00:00Z");
    expect(page).toContain('name: "John Doe"');
    expect(page).toContain("slug: john-doe");
    expect(page).toContain("kind: person");
    expect(page).toContain("extraction_strategy: text-field");
    expect(page).toContain(`base_id: ${BASE}`);
    expect(page).toContain("- from-like");
    expect(page).toContain(`- ${BASE}-recP1`);
    expect(page).toContain('- "Payments"');
    expect(page).toContain("count: 3");
    expect(page).toContain("extracted_at: 2026-05-07T12:00:00Z");
    expect(page).toContain("John Doe appears as a person reference in 3 records");
  });

  test("byte-stable on identical input (idempotent)", () => {
    const entity: TextFieldEntity = {
      name: "Acme",
      canonical: "acme",
      slug: "acme",
      kind: "company",
      roles: ["undirected"],
      source_record_ids: [`${BASE}-rec1`],
      source_tables: ["Payments"],
      field_mentions: [{ field: "Payee Name", table: "Payments", count: 1 }],
    };
    const a = renderEntityPage(entity, BASE, "2026-05-07T12:00:00Z");
    const b = renderEntityPage(entity, BASE, "2026-05-07T12:00:00Z");
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// File output
// ---------------------------------------------------------------------------

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tfent-emit-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("writeEntityPages", () => {
  test("writes person + company pages to subdirs", () => {
    const entities: TextFieldEntity[] = [
      {
        name: "John Doe",
        canonical: "john doe",
        slug: "john-doe",
        kind: "person",
        roles: ["from-like"],
        source_record_ids: [`${BASE}-rec1`],
        source_tables: ["Payments"],
        field_mentions: [{ field: "Payer Name", table: "Payments", count: 1 }],
      },
      {
        name: "Acme Corp",
        canonical: "acme corp",
        slug: "acme-corp",
        kind: "company",
        roles: ["to-like"],
        source_record_ids: [`${BASE}-rec1`],
        source_tables: ["Payments"],
        field_mentions: [{ field: "Payee Name", table: "Payments", count: 1 }],
      },
    ];
    const outDir = join(tmp, "out");
    const result = writeEntityPages(entities, outDir, BASE, "2026-05-07T12:00:00Z");
    expect(result.peopleWritten).toBe(1);
    expect(result.companiesWritten).toBe(1);
    expect(existsSync(join(outDir, "people", "john-doe.md"))).toBe(true);
    expect(existsSync(join(outDir, "companies", "acme-corp.md"))).toBe(true);
    const johnPage = readFileSync(join(outDir, "people", "john-doe.md"), "utf8");
    expect(johnPage).toContain('name: "John Doe"');
  });
});

// ---------------------------------------------------------------------------
// extractTextFieldEntities — orchestrated
// ---------------------------------------------------------------------------

let stage0Dir: string;
let tfDir: string;
let runDir: string;

beforeEach(() => {
  stage0Dir = join(tmp, "stage0");
  tfDir = join(tmp, "tf");
  runDir = join(tmp, "run");
  mkdirSync(stage0Dir, { recursive: true });
  mkdirSync(tfDir, { recursive: true });
});

function writeStage0(baseId: string, classifications: Record<string, TableTypeClassification>) {
  writeFileSync(join(stage0Dir, `${baseId}.json`), JSON.stringify(classifications));
}
function writeTf(baseId: string, classifications: Record<string, TableTextFieldClassification>) {
  writeFileSync(join(tfDir, `${baseId}.json`), JSON.stringify(classifications));
}

function makeFetch(
  metaTables: AirtableTable[],
  recordsByTable: Record<string, AirtableRecord[]>,
): typeof globalThis.fetch {
  return (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes("/meta/bases/")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ tables: metaTables }),
        text: async () => "",
      } as unknown as Response;
    }
    for (const [tid, recs] of Object.entries(recordsByTable)) {
      if (u.includes(tid)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ records: recs }),
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

describe("extractTextFieldEntities", () => {
  test("happy path — Staronline Payments → john-doe + acme-corp pages", async () => {
    writeStage0(BASE, {
      [PAYMENTS_TABLE.id]: {
        type: "interaction",
        reasoning: "x",
        schema_hash: "h",
        classified_at: "t0",
      },
    });
    writeTf(BASE, { [PAYMENTS_TABLE.id]: PAYMENTS_CLS });
    const fetchImpl = makeFetch(
      [PAYMENTS_TABLE],
      { [PAYMENTS_TABLE.id]: PAYMENT_RECORDS },
    );
    const result = await extractTextFieldEntities(BASE, {
      fetch: fetchImpl,
      env: { AIRTABLE_API_KEY: "fake" },
      stage0CacheBaseDir: stage0Dir,
      textFieldCacheBaseDir: tfDir,
      runDir,
      now: () => "2026-05-07T12:00:00Z",
    });
    expect(result.skipped).toBe(false);
    expect(result.peopleWritten).toBe(2); // john-doe, jane-smith
    expect(result.companiesWritten).toBe(2); // acme-corp, beta-llc
    const peopleDir = join(runDir, "bases", BASE, "out", "people");
    const companiesDir = join(runDir, "bases", BASE, "out", "companies");
    expect(existsSync(join(peopleDir, "john-doe.md"))).toBe(true);
    expect(existsSync(join(peopleDir, "jane-smith.md"))).toBe(true);
    expect(existsSync(join(companiesDir, "acme-corp.md"))).toBe(true);
    expect(existsSync(join(companiesDir, "beta-llc.md"))).toBe(true);
    const johnPage = readFileSync(join(peopleDir, "john-doe.md"), "utf8");
    expect(johnPage).toContain(`base_id: ${BASE}`);
    expect(johnPage).toContain("count: 3"); // John Doe appears in 3 Payer Name records
  });

  test("Stage 0 cache absent → skipped with reason", async () => {
    const result = await extractTextFieldEntities("appMissing", {
      env: { AIRTABLE_API_KEY: "fake" },
      stage0CacheBaseDir: stage0Dir,
      textFieldCacheBaseDir: tfDir,
      runDir,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("Stage 0 cache absent");
  });

  test("text-field cache absent → skipped with reason", async () => {
    writeStage0("appOnly0", {
      [PAYMENTS_TABLE.id]: {
        type: "interaction",
        reasoning: "x",
        schema_hash: "h",
        classified_at: "t0",
      },
    });
    const result = await extractTextFieldEntities("appOnly0", {
      env: { AIRTABLE_API_KEY: "fake" },
      stage0CacheBaseDir: stage0Dir,
      textFieldCacheBaseDir: tfDir,
      runDir,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("Text-field-entity cache absent");
  });

  test("no entity fields classified → skipped (no API call)", async () => {
    const NO_ENT_CLS: TableTextFieldClassification = {
      schema_hash: "h",
      classified_at: "t",
      fields: {
        "Reference Number": {
          kind: "none",
          role: "none",
          confidence: 0.99,
          reasoning: "id",
        },
      },
    };
    writeStage0(BASE, {
      [PAYMENTS_TABLE.id]: {
        type: "interaction",
        reasoning: "x",
        schema_hash: "h",
        classified_at: "t0",
      },
    });
    writeTf(BASE, { [PAYMENTS_TABLE.id]: NO_ENT_CLS });
    const result = await extractTextFieldEntities(BASE, {
      env: { AIRTABLE_API_KEY: "fake" },
      stage0CacheBaseDir: stage0Dir,
      textFieldCacheBaseDir: tfDir,
      runDir,
      // no fetch — should never be called
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("no interaction tables");
    expect(result.peopleWritten).toBe(0);
  });

  test("entity tables in Stage 0 are NOT walked", async () => {
    writeStage0(BASE, {
      [PAYMENTS_TABLE.id]: {
        type: "interaction",
        reasoning: "x",
        schema_hash: "h",
        classified_at: "t0",
      },
      tblPeople: {
        type: "entity",
        reasoning: "x",
        schema_hash: "h",
        classified_at: "t0",
      },
    });
    writeTf(BASE, { [PAYMENTS_TABLE.id]: PAYMENTS_CLS });
    const fetchImpl = makeFetch(
      [PAYMENTS_TABLE, { id: "tblPeople", name: "People", fields: [] }],
      { [PAYMENTS_TABLE.id]: PAYMENT_RECORDS, tblPeople: [] },
    );
    const result = await extractTextFieldEntities(BASE, {
      fetch: fetchImpl,
      env: { AIRTABLE_API_KEY: "fake" },
      stage0CacheBaseDir: stage0Dir,
      textFieldCacheBaseDir: tfDir,
      runDir,
      now: () => "2026-05-07T12:00:00Z",
    });
    expect(result.skipped).toBe(false);
    expect(result.peopleWritten).toBe(2);
    expect(result.companiesWritten).toBe(2);
    // Confirm we did not walk the entity table — no records there anyway, but
    // nothing leaks into output.
  });
});
