import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractSinglePass,
  dedupEntitiesByRecordId,
  type ExtractSinglePassInput,
  type ExtractSinglePassDeps,
} from "../scripts/extract-single-pass.mts";
import type {
  ExtractedEntity,
  SonnetResponse,
  SonnetRunner,
} from "../scripts/extract-slice.mts";
import type { AirtableTable } from "../scripts/classify-clusters.mts";
import type { AirtableRecord } from "../scripts/legacy-link-detector.mts";

interface FixtureExpected {
  type: string;
  slug: string;
  expectedSourceRecordId: string;
}

interface Fixture {
  baseId: string;
  componentId: string;
  entityTables: string[];
  interactionTables: string[];
  tables: AirtableTable[];
  recordsByTable: Record<string, AirtableRecord[]>;
  expectedEntities: FixtureExpected[];
}

const FIXTURE: Fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "staronline-cluster-fixture.json"), "utf8"),
) as Fixture;

let tmp: string;
let promptsPath: string;

const PROMPT_FIXTURE = `## single-pass

Component: {{cluster_id}}

Subgraph:

{{subgraph}}

Output strict JSON only.
`;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "extract-single-pass-test-"));
  promptsPath = join(tmp, "extract.md");
  writeFileSync(promptsPath, PROMPT_FIXTURE);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function mockFetch(spec: {
  tables: AirtableTable[];
  recordsByTable: Record<string, AirtableRecord[]>;
}) {
  return async (url: string | URL): Promise<Response> => {
    const u = String(url);
    if (/\/v0\/meta\/bases\/[^/?]+\/tables/.test(u)) {
      return new Response(JSON.stringify({ tables: spec.tables }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const recMatch = u.match(/\/v0\/[^/?]+\/([^/?]+)/);
    if (recMatch) {
      const tableId = recMatch[1];
      const records = spec.recordsByTable[tableId] ?? [];
      return new Response(JSON.stringify({ records }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  };
}

function mockSonnet(
  responder: (prompt: string) => SonnetResponse,
  callLog?: string[],
): SonnetRunner {
  return async (prompt: string) => {
    callLog?.push(prompt);
    return responder(prompt);
  };
}

function entitiesFromFixture(fx: Fixture): ExtractedEntity[] {
  return fx.expectedEntities.map((e) => ({
    type: e.type,
    slug: e.slug,
    body: `Auto-generated body for ${e.slug}.`,
    source_record_ids: [e.expectedSourceRecordId],
  }));
}

function staticSonnet(entities: ExtractedEntity[]): SonnetResponse {
  return {
    rawText: JSON.stringify({ entities }),
    usage: { input_tokens: 1000, output_tokens: 500 },
    model: "claude-sonnet-4-6",
  };
}

function baseInput(): ExtractSinglePassInput {
  return {
    baseId: FIXTURE.baseId,
    componentId: FIXTURE.componentId,
    entityTables: FIXTURE.entityTables,
    interactionTables: FIXTURE.interactionTables,
  };
}

function baseDeps(extra: Partial<ExtractSinglePassDeps> = {}): ExtractSinglePassDeps {
  return {
    cacheDir: join(tmp, "cache"),
    runId: "test-run",
    promptsPath,
    env: { AIRTABLE_API_KEY: "test-key" },
    fetch: mockFetch({
      tables: FIXTURE.tables,
      recordsByTable: FIXTURE.recordsByTable,
    }),
    runSonnet: mockSonnet(() => staticSonnet(entitiesFromFixture(FIXTURE))),
    now: () => "2026-05-05T00:00:00.000Z",
    ...extra,
  };
}

describe("dedupEntitiesByRecordId (AC#4 helper)", () => {
  test("keeps last entry per source_record_id (last-write-wins within one Sonnet output)", () => {
    const e1: ExtractedEntity = {
      type: "person",
      slug: "alice",
      body: "v1",
      source_record_ids: ["recPpl001"],
    };
    const e2: ExtractedEntity = {
      type: "person",
      slug: "alice-renamed",
      body: "v2",
      source_record_ids: ["recPpl001"],
    };
    const e3: ExtractedEntity = {
      type: "company",
      slug: "acme",
      body: "co",
      source_record_ids: ["recCo999"],
    };
    const out = dedupEntitiesByRecordId([e1, e2, e3]);
    expect(out).toHaveLength(2);
    expect(out.find((e) => e.source_record_ids[0] === "recPpl001")?.body).toBe("v2");
    expect(out.find((e) => e.source_record_ids[0] === "recCo999")?.body).toBe("co");
  });

  test("preserves order of first appearance for non-duplicates", () => {
    const a: ExtractedEntity = { type: "x", slug: "a", body: "a", source_record_ids: ["r1"] };
    const b: ExtractedEntity = { type: "x", slug: "b", body: "b", source_record_ids: ["r2"] };
    const c: ExtractedEntity = { type: "x", slug: "c", body: "c", source_record_ids: ["r3"] };
    const out = dedupEntitiesByRecordId([a, b, c]);
    expect(out.map((e) => e.slug)).toEqual(["a", "b", "c"]);
  });

  test("drops entities with empty source_record_ids", () => {
    const a: ExtractedEntity = { type: "x", slug: "a", body: "a", source_record_ids: [] };
    const b: ExtractedEntity = { type: "x", slug: "b", body: "b", source_record_ids: ["r2"] };
    const out = dedupEntitiesByRecordId([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].slug).toBe("b");
  });
});

describe("extractSinglePass — Staronline cluster fixture (AC#1, #2, #3, #5)", () => {
  test("AC#1: Sonnet called exactly once per cluster", async () => {
    const calls: string[] = [];
    const deps = baseDeps({
      runSonnet: mockSonnet(() => staticSonnet(entitiesFromFixture(FIXTURE)), calls),
    });
    const result = await extractSinglePass(baseInput(), deps);
    expect(result.sonnetCallCount).toBe(1);
    expect(calls).toHaveLength(1);
  });

  test("AC#3: ExtractSinglePassInput has no seedRecordId / anchor field", () => {
    const input = baseInput();
    expect(input).not.toHaveProperty("seedRecordId");
    expect(input).not.toHaveProperty("anchor");
    expect(input).not.toHaveProperty("seed");
  });

  test("AC#5: Staronline 3-table fixture produces exactly 12 unique entities (no per-seed redundancy)", async () => {
    const result = await extractSinglePass(baseInput(), baseDeps());
    expect(result.entities).toHaveLength(12);
    const slugs = new Set(result.entities.map((e) => e.slug));
    expect(slugs.size).toBe(12);
    expect(result.entityPaths).toHaveLength(12);
  });

  test("AC#2: each entity page's source_record_id matches its OWN record (not a seed)", async () => {
    const result = await extractSinglePass(baseInput(), baseDeps());
    const expectedById = new Map(
      FIXTURE.expectedEntities.map((e) => [e.slug, e.expectedSourceRecordId]),
    );
    for (const path of result.entityPaths) {
      expect(existsSync(path)).toBe(true);
      const body = readFileSync(path, "utf8");
      const slugMatch = body.match(/^slug:\s*(\S+)$/m);
      expect(slugMatch).not.toBeNull();
      const slug = slugMatch![1];
      const sridMatch = body.match(/^source_record_id:\s*(\S+)$/m);
      expect(sridMatch).not.toBeNull();
      const srid = sridMatch![1];
      expect(srid).toBe(expectedById.get(slug));
    }
  });

  test("entity pages have no seed_record_id frontmatter (single-pass has no seed)", async () => {
    const result = await extractSinglePass(baseInput(), baseDeps());
    for (const path of result.entityPaths) {
      const body = readFileSync(path, "utf8");
      expect(body).not.toMatch(/^seed_record_id:/m);
    }
  });

  test("entity pages stamp component_id (schema-driven), not legacy cluster_type", async () => {
    const result = await extractSinglePass(baseInput(), baseDeps());
    const sample = readFileSync(result.entityPaths[0], "utf8");
    expect(sample).toMatch(/^component_id:\s+comp-staronline-people-companies-projects$/m);
    expect(sample).not.toMatch(/^cluster_type:/m);
  });

  test("uses single-pass prompt variant; substitutes component_id + subgraph", async () => {
    const calls: string[] = [];
    await extractSinglePass(
      baseInput(),
      baseDeps({
        runSonnet: mockSonnet(() => staticSonnet(entitiesFromFixture(FIXTURE)), calls),
      }),
    );
    expect(calls[0]).toContain(FIXTURE.componentId);
    expect(calls[0]).toContain("recPpl001");
    expect(calls[0]).not.toMatch(/seed/i);
  });
});

describe("extractSinglePass — AC#4 cross-cluster overlap dedup (last-write-wins)", () => {
  test("re-running same component to same outDir overwrites entity files (filesystem dedup)", async () => {
    const cacheDir = join(tmp, "cache-shared");
    const v1 = entitiesFromFixture(FIXTURE).map((e) =>
      e.slug === "alice-tran" ? { ...e, body: "FIRST RUN BODY" } : e,
    );
    const v2 = entitiesFromFixture(FIXTURE).map((e) =>
      e.slug === "alice-tran" ? { ...e, body: "SECOND RUN BODY" } : e,
    );

    const r1 = await extractSinglePass(baseInput(), {
      ...baseDeps({ runSonnet: mockSonnet(() => staticSonnet(v1)) }),
      cacheDir,
    });
    const r2 = await extractSinglePass(baseInput(), {
      ...baseDeps({ runSonnet: mockSonnet(() => staticSonnet(v2)) }),
      cacheDir,
    });

    const aliceR1 = r1.entityPaths.find((p) => p.endsWith("alice-tran.md"))!;
    const aliceR2 = r2.entityPaths.find((p) => p.endsWith("alice-tran.md"))!;
    expect(aliceR1).toBe(aliceR2);
    const finalBody = readFileSync(aliceR2, "utf8");
    expect(finalBody).toContain("SECOND RUN BODY");
    expect(finalBody).not.toContain("FIRST RUN BODY");
  });

  test("two different components writing the same record/slug → second wins (cross-cluster overlap)", async () => {
    const cacheDir = join(tmp, "cache-cross");
    const sharedRec: ExtractedEntity = {
      type: "person",
      slug: "alice-tran",
      body: "FROM CLUSTER A",
      source_record_ids: ["recPpl001"],
    };
    const inputA: ExtractSinglePassInput = { ...baseInput(), componentId: "comp-A" };
    const inputB: ExtractSinglePassInput = { ...baseInput(), componentId: "comp-B" };

    const ra = await extractSinglePass(inputA, {
      ...baseDeps({ runSonnet: mockSonnet(() => staticSonnet([sharedRec])) }),
      cacheDir,
    });
    expect(readFileSync(ra.entityPaths[0], "utf8")).toContain("FROM CLUSTER A");

    const rb = await extractSinglePass(inputB, {
      ...baseDeps({
        runSonnet: mockSonnet(() =>
          staticSonnet([{ ...sharedRec, body: "FROM CLUSTER B" }]),
        ),
      }),
      cacheDir,
    });
    expect(readFileSync(rb.entityPaths[0], "utf8")).toContain("FROM CLUSTER B");
    expect(rb.entityPaths[0]).toBe(ra.entityPaths[0]);
  });
});

describe("extractSinglePass — reverse-lookup discipline", () => {
  test("matches Sonnet entities back to their OWN entity-table records via slug", async () => {
    const result = await extractSinglePass(baseInput(), baseDeps());
    for (const e of result.entities) {
      expect(e.source_record_ids).toHaveLength(1);
      const srid = e.source_record_ids[0];
      const allRecs = Object.values(FIXTURE.recordsByTable).flat();
      const owningRecord = allRecs.find((r) => r.id === srid);
      expect(owningRecord).toBeDefined();
    }
  });

  test("does NOT route any record_id to source via interaction-table-only lookup (no entity tables in component → empty result)", async () => {
    const noEntityInput: ExtractSinglePassInput = {
      ...baseInput(),
      entityTables: [],
      interactionTables: FIXTURE.entityTables,
    };
    const result = await extractSinglePass(noEntityInput, baseDeps({ warn: () => {} }));
    expect(result.entities).toHaveLength(0);
    expect(result.entityPaths).toHaveLength(0);
    expect(result.sonnetCallCount).toBe(0);
  });
});
