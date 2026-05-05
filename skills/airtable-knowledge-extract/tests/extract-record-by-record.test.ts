/**
 * extract-record-by-record.test.ts — orphan-table per-record extractor
 * (ai-brain#244, parent #237 AC#9).
 *
 * Pure helpers + a full `extractRecordByRecord()` flow with mocked fetch +
 * mocked Sonnet runner, exercising:
 *   - Deterministic identity: `source_record_id` ALWAYS === record.id;
 *     LLM is never asked for it (prompt-text audit + module-source audit).
 *   - Slug-collision invariant: two records with same NK value still produce
 *     two distinct entity files (record_id baked into slug).
 *   - Sonnet call count = N (one per record).
 *   - Cost-meter line per Sonnet call.
 *   - Outcome-log row written to vault.
 *   - Idempotence: second run is a cache hit, zero new Sonnet calls.
 *   - Defensive parser: even if Sonnet returns `slug` / `source_record_id` /
 *     `type`, those keys are stripped from the rendered output.
 *   - Empty-table edge case: 0 records → 0 entities, 0 Sonnet calls.
 *   - Procurement orphan fixture (loaded from JSON) passes.
 *   - Distribution orphan fixture (inline) passes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  airtableRecordUrl,
  buildPerRecordPrompt,
  deriveEntityType,
  deriveSlug,
  extractRecordByRecord,
  parsePerRecordResponse,
  renderEntityMarkdown,
  slugify,
  type PerRecordEntity,
  type SonnetResponse,
  type SonnetRunner,
} from "../scripts/extract-record-by-record.mts";
import type { AirtableTable } from "../scripts/classify-clusters.mts";
import type { AirtableRecord } from "../scripts/legacy-link-detector.mts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "rxr-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface FixtureFile {
  base_id: string;
  table: AirtableTable;
  natural_key_field: string;
  records: AirtableRecord[];
  expected: {
    entity_count: number;
    entity_type: string;
    natural_key_unique_rate: number;
    collision_pair: [string, string];
  };
}

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

function loadFixture(name: string): FixtureFile {
  const path = join(FIXTURES_DIR, `${name}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as FixtureFile;
}

function distributionFixture(): FixtureFile {
  // Inline Distribution-shape orphan fixture — second AC bullet on #244.
  // Distinct from Procurement: longer NK values, multi-line notes, no
  // collision pair (clean unique_rate=1.0 — exercises the "single-record
  // slug" path of `deriveSlug`).
  return {
    base_id: "appDistOrphanFixture",
    table: {
      id: "tblDistribution",
      name: "Distribution Operation",
      fields: [
        { id: "fldDist01", name: "shipment_ref", type: "singleLineText" },
        { id: "fldDist02", name: "destination", type: "singleLineText" },
        { id: "fldDist03", name: "shipped_on", type: "date" },
        { id: "fldDist04", name: "weight_kg", type: "number" },
        { id: "fldDist05", name: "carrier", type: "singleSelect" },
      ],
    },
    natural_key_field: "shipment_ref",
    records: [
      {
        id: "recDist01",
        fields: {
          shipment_ref: "SHP-2026-001",
          destination: "Hanoi Warehouse A",
          shipped_on: "2026-01-15",
          weight_kg: 245,
          carrier: "Local Express",
        },
      },
      {
        id: "recDist02",
        fields: {
          shipment_ref: "SHP-2026-002",
          destination: "Da Nang Hub",
          shipped_on: "2026-01-22",
          weight_kg: 180,
          carrier: "Local Express",
        },
      },
      {
        id: "recDist03",
        fields: {
          shipment_ref: "SHP-2026-003",
          destination: "HCMC Distribution Center",
          shipped_on: "2026-02-01",
          weight_kg: 520,
          carrier: "National Cargo",
        },
      },
      {
        id: "recDist04",
        fields: {
          shipment_ref: "SHP-2026-004",
          destination: "Hai Phong Port",
          shipped_on: "2026-02-12",
          weight_kg: 310,
          carrier: "Sea Freight Co",
        },
      },
    ],
    expected: {
      entity_count: 4,
      entity_type: "distribution-operation",
      natural_key_unique_rate: 1.0,
      collision_pair: ["recDist01", "recDist01"],
    },
  };
}

// ---------------------------------------------------------------------------
// Mocked Sonnet runner — counts invocations + records prompts received.
// ---------------------------------------------------------------------------

interface SonnetCall {
  prompt: string;
  model: string;
}

function makeSonnetRunner(
  responder: (call: SonnetCall, idx: number) => string,
): { runner: SonnetRunner; calls: SonnetCall[] } {
  const calls: SonnetCall[] = [];
  const runner: SonnetRunner = async (prompt, model) => {
    calls.push({ prompt, model });
    const rawText = responder({ prompt, model }, calls.length - 1);
    const resp: SonnetResponse = {
      rawText,
      model,
      usage: { input_tokens: 100 + calls.length, output_tokens: 50 + calls.length },
    };
    return resp;
  };
  return { runner, calls };
}

// ---------------------------------------------------------------------------
// Mocked fetch — replays Meta API + Records API for one base+table.
// ---------------------------------------------------------------------------

function makeFetch(args: {
  baseId: string;
  table: AirtableTable;
  records: AirtableRecord[];
}): typeof globalThis.fetch {
  const metaUrl =
    `https://api.airtable.com/v0/meta/bases/${encodeURIComponent(args.baseId)}/tables`;
  const recordsUrlPrefix =
    `https://api.airtable.com/v0/${encodeURIComponent(args.baseId)}/${encodeURIComponent(args.table.id)}`;
  const fn: typeof globalThis.fetch = async (input, _init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    if (url.startsWith(metaUrl)) {
      return new Response(JSON.stringify({ tables: [args.table] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith(recordsUrlPrefix)) {
      return new Response(JSON.stringify({ records: args.records }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(`unmocked URL: ${url}`, { status: 404 });
  };
  return fn;
}

function writeNkCache(args: {
  runDir: string;
  baseId: string;
  tableId: string;
  nkField: string | null;
}): string {
  mkdirSync(args.runDir, { recursive: true });
  const path = join(args.runDir, `natural-keys-${args.baseId}.json`);
  const body =
    args.nkField === null
      ? { [args.tableId]: { nk_field: null, reason: "no candidate" } }
      : {
          [args.tableId]: {
            nk_field: args.nkField,
            unique_rate: 0.99,
            sample_size: 5,
          },
        };
  writeFileSync(path, JSON.stringify(body, null, 2));
  return path;
}

function writeBrainOsConfig(vaultPath: string): string {
  const dir = join(tmp, "brain-os-config");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "brain-os.config.md");
  writeFileSync(path, `# brain-os.config.md\n\nvault_path: ${vaultPath}\n`);
  return path;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("slugify", () => {
  test("lowercases + collapses non-alphanumeric", () => {
    expect(slugify("Office Printer Purchase")).toBe("office-printer-purchase");
  });
  test("strips diacritics via NFKD", () => {
    expect(slugify("Tiền điện văn phòng")).toBe("tien-dien-van-phong");
  });
  test("returns 'untitled' on empty", () => {
    expect(slugify("")).toBe("untitled");
    expect(slugify("---")).toBe("untitled");
  });
  test("trims edge hyphens", () => {
    expect(slugify("  hello   world  ")).toBe("hello-world");
  });
  test("caps length at 120", () => {
    const s = "x".repeat(200);
    expect(slugify(s).length).toBeLessThanOrEqual(120);
  });
});

describe("deriveEntityType", () => {
  test("slugifies the table name", () => {
    expect(deriveEntityType("Knowledge Notes")).toBe("knowledge-notes");
    expect(deriveEntityType("Procurement")).toBe("procurement");
    expect(deriveEntityType("Distribution Operation")).toBe(
      "distribution-operation",
    );
  });
});

describe("deriveSlug", () => {
  test("bakes record_id into slug when NK present (collision-safe)", () => {
    const recA: AirtableRecord = {
      id: "recABC",
      fields: { description: "Office printer purchase" },
    };
    const recB: AirtableRecord = {
      id: "recXYZ",
      fields: { description: "Office printer purchase" },
    };
    const a = deriveSlug(recA, "description");
    const b = deriveSlug(recB, "description");
    expect(a).not.toBe(b);
    expect(a).toBe("office-printer-purchase-recabc");
    expect(b).toBe("office-printer-purchase-recxyz");
  });

  test("falls back to record_id slug when NK field missing", () => {
    const rec: AirtableRecord = { id: "recXYZ", fields: {} };
    expect(deriveSlug(rec, "description")).toBe("recxyz");
    expect(deriveSlug(rec, null)).toBe("recxyz");
  });

  test("falls back to record_id slug when NK value empty/null", () => {
    const rec1: AirtableRecord = {
      id: "recAAA",
      fields: { description: "" },
    };
    const rec2: AirtableRecord = {
      id: "recBBB",
      fields: { description: null as unknown as string },
    };
    expect(deriveSlug(rec1, "description")).toBe("recaaa");
    expect(deriveSlug(rec2, "description")).toBe("recbbb");
  });

  test("normalises numeric NK value", () => {
    const rec: AirtableRecord = { id: "recNum", fields: { count: 42 } };
    expect(deriveSlug(rec, "count")).toBe("42-recnum");
  });
});

// ---------------------------------------------------------------------------
// Prompt audit — the contract that LLM is never asked for identity
// ---------------------------------------------------------------------------

describe("buildPerRecordPrompt — prompt-text audit (AC#2)", () => {
  const table: AirtableTable = {
    id: "tblTest",
    name: "Procurement",
    fields: [
      { id: "f1", name: "description", type: "singleLineText" },
      { id: "f2", name: "amount", type: "currency" },
    ],
  };
  const record: AirtableRecord = {
    id: "recTest1",
    fields: { description: "Sample row", amount: 100 },
  };
  const prompt = buildPerRecordPrompt({
    record,
    table,
    entityType: "procurement",
    slug: "sample-row-rectest1",
    naturalKeyField: "description",
  });

  test("explicitly forbids producing slug / source_record_id / type", () => {
    // Three forbidden identity keys appear under a "do not include" /
    // "do NOT echo" instruction in the prompt body.
    expect(prompt).toMatch(/do not include them/i);
    expect(prompt).toMatch(/slug/);
    expect(prompt).toMatch(/source_record_id/);
    expect(prompt).toMatch(/type/);
    expect(prompt).toMatch(/do NOT echo/);
  });

  test("specifies STRICT JSON {body, frontmatter} as the output shape", () => {
    expect(prompt).toMatch(/STRICT JSON/);
    expect(prompt).toMatch(/"body"/);
    expect(prompt).toMatch(/"frontmatter"/);
  });

  test("never asks for the source_record_id as an output field", () => {
    // The only mention of source_record_id is in the "do NOT echo" /
    // "MUST NOT contain" lists — never as a "produce" / "return" instruction.
    const lines = prompt.split("\n");
    const askLines = lines.filter((l) => /produce|return|emit/i.test(l));
    for (const l of askLines) {
      expect(l).not.toMatch(/source_record_id/);
      expect(l).not.toMatch(/produce.*slug/i);
    }
  });

  test("includes the record_id + slug + type as REFERENCE-only", () => {
    // The deterministic identity values appear in the prompt for the
    // model's *context* (so it knows the entity it's summarising) — but
    // are explicitly framed as already-derived inputs.
    expect(prompt).toContain(record.id);
    expect(prompt).toContain("sample-row-rectest1");
    expect(prompt).toContain("procurement");
  });
});

// ---------------------------------------------------------------------------
// Module-source audit — make sure the SOURCE FILE never asks Sonnet for IDs
// ---------------------------------------------------------------------------

describe("module-source audit", () => {
  test("source contains the structural anchors that enforce the no-LLM-identity contract", () => {
    const sourcePath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "scripts",
      "extract-record-by-record.mts",
    );
    const src = readFileSync(sourcePath, "utf8");

    // Three load-bearing anchors. If a future refactor accidentally weakens
    // the contract (e.g. removes the forbid list, drops the strip step in
    // the parser) this test fails before the bad change can ship. We do NOT
    // grep for absence of `return.*slug` because the source legitimately
    // returns the deterministic-slug value internally — that's not a leak.
    // The leak surface is (a) what the prompt asks for and (b) what the
    // parser strips. Prompt content is audited in `buildPerRecordPrompt —
    // prompt-text audit`; parser is audited in `parsePerRecordResponse`.
    expect(src).toMatch(/do NOT echo/);
    expect(src).toMatch(/FORBIDDEN_TOP_KEYS/);
    expect(src).toMatch(/FORBIDDEN_FRONTMATTER_KEYS/);
    // The deterministic-identity construction site:
    //   source_record_id: record.id    // in PerRecordEntity construction
    expect(src).toMatch(/source_record_id:\s*record\.id/);
  });
});

// ---------------------------------------------------------------------------
// Defensive parser — strip forbidden keys even if Sonnet ignores the prompt
// ---------------------------------------------------------------------------

describe("parsePerRecordResponse", () => {
  test("returns body + frontmatter for the happy path", () => {
    const text = JSON.stringify({
      body: "## Office printer\n\nA new printer.",
      frontmatter: { tags: ["office", "capex"], status: "paid" },
    });
    const out = parsePerRecordResponse(text);
    expect(out.body).toContain("Office printer");
    expect(out.frontmatter.tags).toEqual(["office", "capex"]);
    expect(out.frontmatter.status).toBe("paid");
  });

  test("strips top-level identity keys when Sonnet returns them anyway", () => {
    // Adversarial: model ignored the prompt and returned slug + source_record_id.
    // Parser MUST drop them so identity stays caller-controlled.
    const text = JSON.stringify({
      body: "Body text",
      slug: "wrong-slug",
      source_record_id: "recHallucinated",
      type: "wrong-type",
      frontmatter: { tags: ["x"] },
    });
    const out = parsePerRecordResponse(text);
    expect(out.body).toBe("Body text");
    expect((out as Record<string, unknown>).slug).toBeUndefined();
    expect((out as Record<string, unknown>).source_record_id).toBeUndefined();
    expect((out as Record<string, unknown>).type).toBeUndefined();
    expect(out.frontmatter.tags).toEqual(["x"]);
  });

  test("strips identity keys nested inside frontmatter", () => {
    const text = JSON.stringify({
      body: "Body text",
      frontmatter: {
        tags: ["x"],
        slug: "leak-attempt",
        source_record_id: "recHallucinated",
        type: "leak",
        source_table: "leak",
        base_id: "leak",
        valid_field: "kept",
      },
    });
    const out = parsePerRecordResponse(text);
    expect(out.frontmatter.slug).toBeUndefined();
    expect(out.frontmatter.source_record_id).toBeUndefined();
    expect(out.frontmatter.type).toBeUndefined();
    expect(out.frontmatter.source_table).toBeUndefined();
    expect(out.frontmatter.base_id).toBeUndefined();
    expect(out.frontmatter.valid_field).toBe("kept");
    expect(out.frontmatter.tags).toEqual(["x"]);
  });

  test("tolerates fenced JSON", () => {
    const text = "```json\n" + JSON.stringify({ body: "Hi", frontmatter: {} }) + "\n```";
    const out = parsePerRecordResponse(text);
    expect(out.body).toBe("Hi");
  });

  test("falls back to bare-text body when no JSON found", () => {
    const out = parsePerRecordResponse("Just some prose without JSON.");
    expect(out.body).toBe("Just some prose without JSON.");
    expect(out.frontmatter).toEqual({});
  });

  test("tolerates malformed JSON by falling back to bare text", () => {
    const out = parsePerRecordResponse("{ this is not valid JSON ");
    // Bare-text fallback — just preserves whatever was returned.
    expect(typeof out.body).toBe("string");
    expect(out.frontmatter).toEqual({});
  });

  test("missing frontmatter defaults to empty object", () => {
    const text = JSON.stringify({ body: "Just body" });
    const out = parsePerRecordResponse(text);
    expect(out.body).toBe("Just body");
    expect(out.frontmatter).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// renderEntityMarkdown
// ---------------------------------------------------------------------------

describe("renderEntityMarkdown", () => {
  test("emits frontmatter with deterministic identity + extraction strategy", () => {
    const entity: PerRecordEntity = {
      type: "procurement",
      slug: "office-electricity-jan-2026-recproc01",
      source_record_id: "recProc01",
      body: "## Office electricity\n\nJanuary 2026 cycle.",
      frontmatter: { tags: ["operating", "utility"], amount: 4500000 },
    };
    const md = renderEntityMarkdown({
      entity,
      baseId: "appProc",
      tableId: "tblProcurement",
      tableName: "Procurement",
      extractedAt: "2026-05-05T00:00:00Z",
    });
    expect(md).toContain("type: procurement");
    expect(md).toContain("slug: office-electricity-jan-2026-recproc01");
    expect(md).toContain("source_record_id: recProc01");
    expect(md).toContain("base_id: appProc");
    expect(md).toContain("source_table: \"Procurement\"");
    expect(md).toContain("extraction_strategy: record-by-record");
    expect(md).toContain("source_url: \"https://airtable.com/appProc/tblProcurement/recProc01\"");
    expect(md).toContain("Office electricity");
    expect(md).toContain("tags:\n  - \"operating\"\n  - \"utility\"");
  });
});

describe("airtableRecordUrl", () => {
  test("formats the record URL", () => {
    expect(airtableRecordUrl("appA", "tblB", "recC")).toBe(
      "https://airtable.com/appA/tblB/recC",
    );
  });
});

// ---------------------------------------------------------------------------
// Full flow — Procurement orphan fixture (loaded from JSON)
// ---------------------------------------------------------------------------

describe("extractRecordByRecord — Procurement orphan fixture", () => {
  test("produces 1 entity per record with deterministic source_record_id", async () => {
    const fx = loadFixture("procurement-orphan");
    const cacheDir = join(tmp, "cache");
    const runId = "test-run-procurement";
    const runDir = join(cacheDir, runId);
    writeNkCache({
      runDir,
      baseId: fx.base_id,
      tableId: fx.table.id,
      nkField: fx.natural_key_field,
    });

    const { runner, calls } = makeSonnetRunner((_call, idx) =>
      JSON.stringify({
        body: `## ${fx.records[idx].fields.description}\n\nSynthetic body for record ${idx}.`,
        frontmatter: { idx, tag: "procurement" },
      }),
    );

    const result = await extractRecordByRecord(
      { baseId: fx.base_id, tableId: fx.table.id },
      {
        cacheDir,
        runId,
        runSonnet: runner,
        env: { AIRTABLE_API_KEY: "fake-token" },
        fetch: makeFetch({
          baseId: fx.base_id,
          table: fx.table,
          records: fx.records,
        }),
        writeOutcomeLog: false,
      },
    );

    // AC#1: 1 entity per record
    expect(result.entitiesEmitted).toBe(fx.expected.entity_count);
    expect(result.entityPaths.length).toBe(fx.expected.entity_count);
    expect(result.cachedHit).toBe(false);

    // AC#3: Sonnet call count = N
    expect(result.sonnetCallCount).toBe(fx.records.length);
    expect(calls.length).toBe(fx.records.length);

    // AC#9 — entity_type derived deterministically from table.name
    expect(result.entityType).toBe(fx.expected.entity_type);

    // AC#2: every emitted entity file has source_record_id === record.id
    for (const recordIdx in fx.records) {
      const path = result.entityPaths[recordIdx];
      const md = readFileSync(path, "utf8");
      expect(md).toContain(`source_record_id: ${fx.records[recordIdx].id}`);
      // Defensive: assert no Sonnet-derived fake ID slips in.
      expect(md).not.toContain("source_record_id: recHallucinated");
    }

    // Slug-collision invariant — rec03 + rec04 share NK value but produce
    // distinct entity files (record_id baked into slug). Otherwise the
    // second record would have overwritten the first and we'd see fewer
    // files than records.
    const [c1, c2] = fx.expected.collision_pair;
    const entityPathFor = (recId: string) =>
      result.entityPaths.find((p) => p.toLowerCase().endsWith(`${recId.toLowerCase()}.md`));
    expect(entityPathFor(c1)).toBeDefined();
    expect(entityPathFor(c2)).toBeDefined();
    expect(entityPathFor(c1)).not.toBe(entityPathFor(c2));
    expect(existsSync(entityPathFor(c1)!)).toBe(true);
    expect(existsSync(entityPathFor(c2)!)).toBe(true);
  });

  test("idempotent — second run is a cache hit, zero new Sonnet calls", async () => {
    const fx = loadFixture("procurement-orphan");
    const cacheDir = join(tmp, "cache");
    const runId = "test-run-idempotent";
    const runDir = join(cacheDir, runId);
    writeNkCache({
      runDir,
      baseId: fx.base_id,
      tableId: fx.table.id,
      nkField: fx.natural_key_field,
    });

    const responder1 = makeSonnetRunner(() =>
      JSON.stringify({ body: "first", frontmatter: {} }),
    );
    const result1 = await extractRecordByRecord(
      { baseId: fx.base_id, tableId: fx.table.id },
      {
        cacheDir,
        runId,
        runSonnet: responder1.runner,
        env: { AIRTABLE_API_KEY: "fake-token" },
        fetch: makeFetch({
          baseId: fx.base_id,
          table: fx.table,
          records: fx.records,
        }),
        writeOutcomeLog: false,
      },
    );
    expect(result1.cachedHit).toBe(false);
    expect(responder1.calls.length).toBe(fx.records.length);

    const responder2 = makeSonnetRunner(() =>
      JSON.stringify({ body: "second", frontmatter: {} }),
    );
    const result2 = await extractRecordByRecord(
      { baseId: fx.base_id, tableId: fx.table.id },
      {
        cacheDir,
        runId,
        runSonnet: responder2.runner,
        env: { AIRTABLE_API_KEY: "fake-token" },
        fetch: makeFetch({
          baseId: fx.base_id,
          table: fx.table,
          records: fx.records,
        }),
        writeOutcomeLog: false,
      },
    );
    expect(result2.cachedHit).toBe(true);
    expect(result2.entitiesEmitted).toBe(result1.entitiesEmitted);
    expect(responder2.calls.length).toBe(0);
  });

  test("runtime defence — adversarial Sonnet response cannot leak hallucinated IDs", async () => {
    const fx = loadFixture("procurement-orphan");
    const cacheDir = join(tmp, "cache");
    const runId = "test-run-adversarial";
    const runDir = join(cacheDir, runId);
    writeNkCache({
      runDir,
      baseId: fx.base_id,
      tableId: fx.table.id,
      nkField: fx.natural_key_field,
    });

    // Sonnet ignores the prompt and tries to inject identity fields.
    const { runner } = makeSonnetRunner(() =>
      JSON.stringify({
        body: "Adversarial body",
        slug: "fake-slug",
        source_record_id: "recHallucinated",
        type: "fake-type",
        frontmatter: {
          slug: "frontmatter-fake-slug",
          source_record_id: "recAlsoFake",
          type: "fake",
          tag: "kept",
        },
      }),
    );

    const result = await extractRecordByRecord(
      { baseId: fx.base_id, tableId: fx.table.id },
      {
        cacheDir,
        runId,
        runSonnet: runner,
        env: { AIRTABLE_API_KEY: "fake-token" },
        fetch: makeFetch({
          baseId: fx.base_id,
          table: fx.table,
          records: fx.records,
        }),
        writeOutcomeLog: false,
      },
    );

    for (const path of result.entityPaths) {
      const md = readFileSync(path, "utf8");
      expect(md).not.toContain("recHallucinated");
      expect(md).not.toContain("recAlsoFake");
      expect(md).not.toContain("fake-slug");
      expect(md).not.toContain("frontmatter-fake-slug");
      // Legitimate frontmatter survives the strip.
      expect(md).toContain("tag: \"kept\"");
      // Real source_record_id is the deterministic Airtable record id.
      const rec = fx.records.find((r) =>
        path.toLowerCase().endsWith(`${r.id.toLowerCase()}.md`),
      );
      expect(rec).toBeDefined();
      expect(md).toContain(`source_record_id: ${rec!.id}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Distribution orphan fixture (inline) — second AC bullet
// ---------------------------------------------------------------------------

describe("extractRecordByRecord — Distribution orphan fixture", () => {
  test("produces 1 entity per record with deterministic IDs (clean unique_rate=1.0)", async () => {
    const fx = distributionFixture();
    const cacheDir = join(tmp, "cache");
    const runId = "test-run-distribution";
    const runDir = join(cacheDir, runId);
    writeNkCache({
      runDir,
      baseId: fx.base_id,
      tableId: fx.table.id,
      nkField: fx.natural_key_field,
    });

    const { runner, calls } = makeSonnetRunner((_call, idx) =>
      JSON.stringify({
        body: `## ${fx.records[idx].fields.shipment_ref}\n\nDelivery to ${fx.records[idx].fields.destination}.`,
        frontmatter: {
          carrier: fx.records[idx].fields.carrier,
        },
      }),
    );

    const result = await extractRecordByRecord(
      { baseId: fx.base_id, tableId: fx.table.id },
      {
        cacheDir,
        runId,
        runSonnet: runner,
        env: { AIRTABLE_API_KEY: "fake-token" },
        fetch: makeFetch({
          baseId: fx.base_id,
          table: fx.table,
          records: fx.records,
        }),
        writeOutcomeLog: false,
      },
    );

    expect(result.entitiesEmitted).toBe(fx.expected.entity_count);
    expect(result.sonnetCallCount).toBe(fx.records.length);
    expect(calls.length).toBe(fx.records.length);
    expect(result.entityType).toBe(fx.expected.entity_type);
    expect(result.naturalKeyField).toBe(fx.natural_key_field);

    for (let i = 0; i < fx.records.length; i++) {
      const md = readFileSync(result.entityPaths[i], "utf8");
      expect(md).toContain(`source_record_id: ${fx.records[i].id}`);
      // Slug starts with the slugified shipment_ref + record_id suffix.
      const expectedSlugStart = slugify(
        fx.records[i].fields.shipment_ref as string,
      );
      expect(md).toContain(`slug: ${expectedSlugStart}-${fx.records[i].id.toLowerCase()}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases — empty table + missing NK cache
// ---------------------------------------------------------------------------

describe("extractRecordByRecord — edge cases", () => {
  test("empty table → 0 entities, 0 Sonnet calls (clean exit)", async () => {
    const baseId = "appEmpty";
    const tableId = "tblEmpty";
    const table: AirtableTable = {
      id: tableId,
      name: "Empty Table",
      fields: [{ id: "f1", name: "title", type: "singleLineText" }],
    };
    const cacheDir = join(tmp, "cache");
    const runId = "test-run-empty";
    const runDir = join(cacheDir, runId);
    writeNkCache({ runDir, baseId, tableId, nkField: "title" });

    const { runner, calls } = makeSonnetRunner(() =>
      JSON.stringify({ body: "should not be called", frontmatter: {} }),
    );

    const result = await extractRecordByRecord(
      { baseId, tableId },
      {
        cacheDir,
        runId,
        runSonnet: runner,
        env: { AIRTABLE_API_KEY: "fake-token" },
        fetch: makeFetch({ baseId, table, records: [] }),
        writeOutcomeLog: false,
      },
    );

    expect(result.recordsProcessed).toBe(0);
    expect(result.entitiesEmitted).toBe(0);
    expect(result.sonnetCallCount).toBe(0);
    expect(calls.length).toBe(0);
    expect(result.entityPaths).toEqual([]);
  });

  test("missing NK cache → falls back to record_id slug (warn, no throw)", async () => {
    const baseId = "appNoNk";
    const tableId = "tblNoNk";
    const table: AirtableTable = {
      id: tableId,
      name: "No NK",
      fields: [{ id: "f1", name: "title", type: "singleLineText" }],
    };
    const records: AirtableRecord[] = [
      { id: "recAA", fields: { title: "Alpha" } },
      { id: "recBB", fields: { title: "Beta" } },
    ];
    const cacheDir = join(tmp, "cache");
    const runId = "test-run-no-nk";
    // Intentionally do NOT writeNkCache.

    const warnings: string[] = [];
    const { runner } = makeSonnetRunner(() =>
      JSON.stringify({ body: "fallback body", frontmatter: {} }),
    );

    const result = await extractRecordByRecord(
      { baseId, tableId },
      {
        cacheDir,
        runId,
        runSonnet: runner,
        env: { AIRTABLE_API_KEY: "fake-token" },
        fetch: makeFetch({ baseId, table, records }),
        writeOutcomeLog: false,
        warn: (m) => warnings.push(m),
      },
    );

    expect(result.naturalKeyField).toBeNull();
    expect(result.entitiesEmitted).toBe(2);
    expect(warnings.some((w) => /natural-keys cache absent/.test(w))).toBe(true);
    // Slug = slugify(record.id) only (no NK to bake in).
    for (let i = 0; i < records.length; i++) {
      const md = readFileSync(result.entityPaths[i], "utf8");
      expect(md).toContain(`slug: ${records[i].id.toLowerCase()}`);
      expect(md).toContain(`source_record_id: ${records[i].id}`);
    }
  });

  test("NK cache rejected for this table → falls back to record_id slug", async () => {
    const baseId = "appNkRejected";
    const tableId = "tblNkRejected";
    const table: AirtableTable = {
      id: tableId,
      name: "NK Rejected",
      fields: [{ id: "f1", name: "title", type: "singleLineText" }],
    };
    const records: AirtableRecord[] = [
      { id: "recRJ1", fields: { title: "alpha" } },
    ];
    const cacheDir = join(tmp, "cache");
    const runId = "test-run-nk-rejected";
    const runDir = join(cacheDir, runId);
    writeNkCache({ runDir, baseId, tableId, nkField: null });

    const { runner } = makeSonnetRunner(() =>
      JSON.stringify({ body: "body", frontmatter: {} }),
    );

    const result = await extractRecordByRecord(
      { baseId, tableId },
      {
        cacheDir,
        runId,
        runSonnet: runner,
        env: { AIRTABLE_API_KEY: "fake-token" },
        fetch: makeFetch({ baseId, table, records }),
        writeOutcomeLog: false,
      },
    );
    expect(result.naturalKeyField).toBeNull();
    expect(result.entitiesEmitted).toBe(1);
    const md = readFileSync(result.entityPaths[0], "utf8");
    expect(md).toContain(`slug: recrj1`);
  });
});

// ---------------------------------------------------------------------------
// Cost-meter + outcome-log integration
// ---------------------------------------------------------------------------

describe("extractRecordByRecord — instrumentation", () => {
  test("cost-meter line per Sonnet call (AC#3 budget tracking)", async () => {
    const fx = loadFixture("procurement-orphan");
    const cacheDir = join(tmp, "cache");
    const runId = "test-run-cost-meter";
    const runDir = join(cacheDir, runId);
    writeNkCache({
      runDir,
      baseId: fx.base_id,
      tableId: fx.table.id,
      nkField: fx.natural_key_field,
    });

    const { runner } = makeSonnetRunner(() =>
      JSON.stringify({ body: "body", frontmatter: {} }),
    );

    const result = await extractRecordByRecord(
      { baseId: fx.base_id, tableId: fx.table.id },
      {
        cacheDir,
        runId,
        runSonnet: runner,
        env: { AIRTABLE_API_KEY: "fake-token" },
        fetch: makeFetch({
          baseId: fx.base_id,
          table: fx.table,
          records: fx.records,
        }),
        writeOutcomeLog: false,
      },
    );

    expect(existsSync(result.costMeterPath)).toBe(true);
    const lines = readFileSync(result.costMeterPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.length).toBe(fx.records.length);
    for (let i = 0; i < lines.length; i++) {
      const event = JSON.parse(lines[i]);
      expect(event.strategy).toBe("record-by-record");
      expect(event.base_id).toBe(fx.base_id);
      expect(event.table_id).toBe(fx.table.id);
      expect(event.record_id).toBe(fx.records[i].id);
      expect(typeof event.input_tokens).toBe("number");
      expect(typeof event.output_tokens).toBe("number");
    }
  });

  test("appends per-table row to outcome log when writeOutcomeLog=true", async () => {
    const fx = loadFixture("procurement-orphan");
    const cacheDir = join(tmp, "cache");
    const runId = "test-run-outcome-log";
    const runDir = join(cacheDir, runId);
    writeNkCache({
      runDir,
      baseId: fx.base_id,
      tableId: fx.table.id,
      nkField: fx.natural_key_field,
    });

    const vaultDir = join(tmp, "vault");
    mkdirSync(vaultDir, { recursive: true });
    const { runner } = makeSonnetRunner(() =>
      JSON.stringify({ body: "body", frontmatter: {} }),
    );

    await extractRecordByRecord(
      { baseId: fx.base_id, tableId: fx.table.id },
      {
        cacheDir,
        runId,
        runSonnet: runner,
        env: { AIRTABLE_API_KEY: "fake-token" },
        fetch: makeFetch({
          baseId: fx.base_id,
          table: fx.table,
          records: fx.records,
        }),
        writeOutcomeLog: true,
        vaultPath: vaultDir,
      },
    );

    const logPath = join(
      vaultDir,
      "daily",
      "skill-outcomes",
      "airtable-knowledge-extract.log",
    );
    expect(existsSync(logPath)).toBe(true);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("airtable-knowledge-extract | extract-record-by-record");
    expect(log).toContain(`base_id=${fx.base_id}`);
    expect(log).toContain(`table_id=${fx.table.id}`);
    expect(log).toContain(`records=${fx.records.length}`);
    expect(log).toContain(`sonnet_calls=${fx.records.length}`);
    expect(log).toContain("strategy=record-by-record");
    expect(log).toContain("| pass |");
  });
});
