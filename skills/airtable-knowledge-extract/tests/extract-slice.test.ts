import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractSlice,
  bfsFromSeed,
  estimateTokens,
  slugify,
  parsePromptVariants,
  parseSonnetEntityResponse,
  parseStreamJsonLines,
  extractRecordLinks,
  buildSubgraphContext,
  renderPrompt,
  airtableRecordUrl,
  extractAiFields,
  extractAttachments,
  buildSlugMap,
  findRelatedWikilinks,
  findSourceRecordByEntity,
  resolveEntitySourceIds,
  SliceRejectedError,
  CLUSTER_CONTEXT_BUDGET,
  type SonnetRunner,
  type ExtractedEntity,
  type SonnetResponse,
} from "../scripts/extract-slice.mts";
import type { AirtableTable } from "../scripts/classify-clusters.mts";
import type { AirtableRecord } from "../scripts/legacy-link-detector.mts";

let tmp: string;
let promptsPath: string;

const PROMPT_FIXTURE = `# extract prompt variants

## crm

CRM cluster instructions. Output JSON.

Subgraph (cluster {{cluster_id}}, seed {{seed_record_id}}):

{{subgraph}}

## okr

OKR cluster instructions. Output JSON.

Subgraph (cluster {{cluster_id}}, seed {{seed_record_id}}):

{{subgraph}}

## decision

Decision cluster instructions. Output JSON.

Subgraph (cluster {{cluster_id}}, seed {{seed_record_id}}):

{{subgraph}}

## project

Project cluster instructions.

{{subgraph}}

## knowledge-note

Knowledge note cluster instructions.

{{subgraph}}

## orphan

Orphan cluster instructions.

{{subgraph}}
`;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "extract-slice-test-"));
  promptsPath = join(tmp, "extract.md");
  writeFileSync(promptsPath, PROMPT_FIXTURE);
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function table(
  id: string,
  name: string,
  links: Array<{ targetId: string; name?: string }> = [],
): AirtableTable {
  return {
    id,
    name,
    fields: [
      { id: `${id}-pk`, name: "Name", type: "singleLineText" },
      ...links.map((l, i) => ({
        id: `${id}-link${i}`,
        name: l.name ?? `Link${i}`,
        type: "multipleRecordLinks",
        options: { linkedTableId: l.targetId },
      })),
    ],
  };
}

function record(id: string, fields: Record<string, unknown> = {}): AirtableRecord {
  return { id, fields, createdTime: "2025-01-01T00:00:00.000Z" };
}

interface MockSpec {
  tables: AirtableTable[];
  recordsByTable: Record<string, AirtableRecord[]>;
}

function mockFetch(spec: MockSpec) {
  return async (url: string | URL): Promise<Response> => {
    const u = String(url);
    const metaMatch = u.match(/^https:\/\/api\.airtable\.com\/v0\/meta\/bases\/([^/?]+)\/tables/);
    if (metaMatch) {
      return new Response(JSON.stringify({ tables: spec.tables }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const recMatch = u.match(/^https:\/\/api\.airtable\.com\/v0\/([^/?]+)\/([^/?]+)/);
    if (recMatch) {
      const tableId = recMatch[2];
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

function staticSonnet(
  entities: ExtractedEntity[],
  usage = { input_tokens: 1000, output_tokens: 500 },
): SonnetResponse {
  return {
    rawText: JSON.stringify({ entities }),
    usage,
    model: "claude-sonnet-4-6",
  };
}

describe("estimateTokens", () => {
  test("rough chars/4 estimate", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(40))).toBe(10);
  });
});

describe("slugify", () => {
  test("kebabs, lowercases, strips punctuation", () => {
    expect(slugify("Acme Corp")).toBe("acme-corp");
    expect(slugify("Foo — Q2 2026 Strategy")).toBe("foo-q2-2026-strategy");
    expect(slugify("!!!")).toBe("untitled");
    expect(slugify("")).toBe("untitled");
  });

  test("caps at 80 chars", () => {
    const long = "a".repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(80);
  });
});

describe("parsePromptVariants", () => {
  test("extracts all 6 expected variants", () => {
    const m = parsePromptVariants(PROMPT_FIXTURE);
    expect([...m.keys()].sort()).toEqual(
      ["crm", "decision", "knowledge-note", "okr", "orphan", "project"],
    );
    expect(m.get("crm")).toContain("CRM cluster instructions");
    expect(m.get("okr")).toContain("OKR cluster instructions");
  });

  test("returns empty map on empty input", () => {
    expect(parsePromptVariants("").size).toBe(0);
  });

  test("ignores h1 (single #) headers", () => {
    const m = parsePromptVariants("# title\n## crm\nbody\n");
    expect(m.size).toBe(1);
    expect(m.get("crm")).toBe("body");
  });
});

describe("renderPrompt", () => {
  test("substitutes seed_record_id, cluster_id, subgraph", () => {
    const t = "seed={{seed_record_id}} cluster={{cluster_id}} body={{subgraph}}";
    const out = renderPrompt(t, {
      clusterType: "crm",
      clusterId: "cluster-1",
      seedRecordId: "recABC",
      subgraph: "RECORDS",
    });
    expect(out).toContain("seed=recABC");
    expect(out).toContain("cluster=cluster-1");
    expect(out).toContain("body=RECORDS");
  });

  test("multiple occurrences of same placeholder all substituted", () => {
    const t = "{{seed_record_id}} and {{seed_record_id}}";
    const out = renderPrompt(t, {
      clusterType: "crm",
      clusterId: "cluster-1",
      seedRecordId: "recX",
      subgraph: "",
    });
    expect(out).toBe("recX and recX");
  });
});

describe("extractRecordLinks", () => {
  test("collects multipleRecordLinks edges", () => {
    const t = table("tA", "A", [{ targetId: "tB", name: "Friends" }]);
    const recs: AirtableRecord[] = [
      record("a1", { Friends: ["b1", "b2"] }),
      record("a2", { Friends: ["b1"] }),
      record("a3", {}),
    ];
    const links = extractRecordLinks(recs, "tA", t);
    expect(links).toHaveLength(3);
    expect(links[0]).toMatchObject({
      fromRecordId: "a1",
      toRecordId: "b1",
      toTableId: "tB",
      fromField: "Friends",
    });
  });

  test("ignores non-link fields", () => {
    const t = table("tA", "A");
    const recs: AirtableRecord[] = [record("a1", { Name: "alpha" })];
    expect(extractRecordLinks(recs, "tA", t)).toHaveLength(0);
  });

  test("ignores non-array link values", () => {
    const t = table("tA", "A", [{ targetId: "tB", name: "Friend" }]);
    const recs: AirtableRecord[] = [record("a1", { Friend: "b1" })];
    expect(extractRecordLinks(recs, "tA", t)).toHaveLength(0);
  });
});

describe("bfsFromSeed", () => {
  test("returns empty when seed not found", () => {
    const recs = new Map([["r1", record("r1")]]);
    const r = bfsFromSeed("rMissing", recs, [], 100_000);
    expect(r.keptRecordIds.size).toBe(0);
    expect(r.truncated).toBe(false);
    expect(r.reason).toContain("seed");
  });

  test("kept all when within budget", () => {
    const recs = new Map([
      ["r1", record("r1", { Name: "a" })],
      ["r2", record("r2", { Name: "b" })],
      ["r3", record("r3", { Name: "c" })],
    ]);
    const links = [
      { fromRecordId: "r1", toRecordId: "r2", toTableId: "tB", fromField: "L" },
      { fromRecordId: "r2", toRecordId: "r3", toTableId: "tC", fromField: "L" },
    ];
    const r = bfsFromSeed("r1", recs, links, 100_000);
    expect(r.keptRecordIds.size).toBe(3);
    expect(r.truncated).toBe(false);
  });

  test("truncates when budget exceeded; keeps seed + as many neighbors as fit", () => {
    const recs = new Map<string, AirtableRecord>();
    for (let i = 0; i < 10; i++) {
      recs.set(`r${i}`, record(`r${i}`, { Name: "x".repeat(400) }));
    }
    const links = [];
    for (let i = 0; i < 9; i++) {
      links.push({
        fromRecordId: "r0",
        toRecordId: `r${i + 1}`,
        toTableId: "tB",
        fromField: "L",
      });
    }
    const r = bfsFromSeed("r0", recs, links, 500);
    expect(r.truncated).toBe(true);
    expect(r.reason).toContain("budget");
    expect(r.keptRecordIds.has("r0")).toBe(true);
    expect(r.keptRecordIds.size).toBeLessThan(10);
  });

  test("BFS prioritizes direct neighbors of seed before distance-2", () => {
    const recs = new Map<string, AirtableRecord>();
    for (let i = 0; i < 6; i++) {
      recs.set(`r${i}`, record(`r${i}`));
    }
    const links = [
      { fromRecordId: "r0", toRecordId: "r1", toTableId: "t", fromField: "L" },
      { fromRecordId: "r0", toRecordId: "r2", toTableId: "t", fromField: "L" },
      { fromRecordId: "r1", toRecordId: "r3", toTableId: "t", fromField: "L" },
      { fromRecordId: "r1", toRecordId: "r4", toTableId: "t", fromField: "L" },
      { fromRecordId: "r2", toRecordId: "r5", toTableId: "t", fromField: "L" },
    ];
    const r = bfsFromSeed("r0", recs, links, 30);
    expect(r.keptRecordIds.has("r0")).toBe(true);
    const kept = r.keptRecordIds;
    if (kept.has("r3") || kept.has("r4") || kept.has("r5")) {
      expect(kept.has("r1")).toBe(true);
      expect(kept.has("r2")).toBe(true);
    }
  });
});

describe("parseStreamJsonLines", () => {
  test("accumulates assistant text and final usage", () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Hello" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 200,
        },
        result: '{"entities":[]}',
      }),
    ];
    const r = parseStreamJsonLines(lines);
    expect(r.rawText).toBe('{"entities":[]}');
    expect(r.usage.input_tokens).toBe(100);
    expect(r.usage.output_tokens).toBe(50);
    expect(r.usage.cache_read_input_tokens).toBe(200);
  });

  test("falls back to assistant text if no result event", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "part1" },
            { type: "text", text: "part2" },
          ],
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      }),
    ];
    const r = parseStreamJsonLines(lines);
    expect(r.rawText).toBe("part1part2");
    expect(r.usage.input_tokens).toBe(1);
  });

  test("ignores blank and unparseable lines", () => {
    const lines = [
      "",
      "garbage",
      JSON.stringify({
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
        result: "ok",
      }),
    ];
    const r = parseStreamJsonLines(lines);
    expect(r.rawText).toBe("ok");
  });
});

describe("parseSonnetEntityResponse", () => {
  test("parses {entities:[...]} shape", () => {
    const r = parseSonnetEntityResponse(
      JSON.stringify({
        entities: [
          { type: "person", slug: "x", body: "y", source_record_ids: ["r1"] },
        ],
      }),
    );
    expect(r).toHaveLength(1);
    expect(r[0].slug).toBe("x");
  });

  test("parses bare array shape", () => {
    const r = parseSonnetEntityResponse(
      JSON.stringify([{ type: "person", slug: "x", body: "y", source_record_ids: ["r1"] }]),
    );
    expect(r).toHaveLength(1);
  });

  test("strips ```json fenced code block", () => {
    const text =
      '```json\n{"entities":[{"type":"p","slug":"a","body":"b","source_record_ids":["r"]}]}\n```';
    const r = parseSonnetEntityResponse(text);
    expect(r).toHaveLength(1);
    expect(r[0].slug).toBe("a");
  });

  test("throws on missing JSON", () => {
    expect(() => parseSonnetEntityResponse("plain text no json")).toThrow();
  });

  test("throws on malformed entity shape", () => {
    expect(() =>
      parseSonnetEntityResponse(JSON.stringify({ entities: [{ slug: "x" }] })),
    ).toThrow();
  });

  test("lenient on missing source_record_ids — returns empty array (caller backfills)", () => {
    const r = parseSonnetEntityResponse(
      JSON.stringify({
        entities: [{ type: "person", slug: "x", body: "y" }],
      }),
    );
    expect(r).toHaveLength(1);
    expect(r[0].source_record_ids).toEqual([]);
  });

  test("lenient on non-array source_record_ids (string, null) — returns empty array", () => {
    const rString = parseSonnetEntityResponse(
      JSON.stringify({
        entities: [
          { type: "person", slug: "a", body: "b", source_record_ids: "recX" },
        ],
      }),
    );
    expect(rString[0].source_record_ids).toEqual([]);
    const rNull = parseSonnetEntityResponse(
      JSON.stringify({
        entities: [
          { type: "person", slug: "c", body: "d", source_record_ids: null },
        ],
      }),
    );
    expect(rNull[0].source_record_ids).toEqual([]);
  });
});

describe("buildSubgraphContext", () => {
  test("renders kept records grouped by table", () => {
    const recs = new Map([
      ["r1", record("r1", { Name: "alpha", Age: 30 })],
      ["r2", record("r2", { Name: "beta" })],
    ]);
    const tables = new Map([
      ["tA", table("tA", "Contacts")],
      ["tB", table("tB", "Companies")],
    ]);
    const recordToTable = new Map([
      ["r1", "tA"],
      ["r2", "tB"],
    ]);
    const ctx = buildSubgraphContext(recs, new Set(["r1", "r2"]), tables, recordToTable);
    expect(ctx).toContain("Contacts");
    expect(ctx).toContain("Companies");
    expect(ctx).toContain("r1");
    expect(ctx).toContain("alpha");
  });
});

describe("extractSlice (end-to-end CRM)", () => {
  test("CRM cluster → person/company/meeting entities with wikilinks", async () => {
    const tables = [
      table("tPeople", "Contacts", [{ targetId: "tCompanies", name: "Company" }]),
      table("tCompanies", "Companies"),
      table("tMeetings", "Meetings", [{ targetId: "tPeople", name: "Attendees" }]),
    ];
    const peopleRecs = [
      record("recP1", { Name: "Alice Smith", Company: ["recC1"] }),
    ];
    const companyRecs = [record("recC1", { Name: "Acme Corp" })];
    const meetingRecs = [record("recM1", { Name: "2025 Q2 Strategy", Attendees: ["recP1"] })];

    const sonnetCalls: string[] = [];
    const runSonnet = mockSonnet(
      () =>
        staticSonnet([
          {
            type: "person",
            slug: "alice-smith",
            frontmatter: { role: "founder", company: "[[acme-corp]]" },
            body: "Alice Smith, founder at [[acme-corp]].",
            source_record_ids: ["recP1"],
          },
          {
            type: "company",
            slug: "acme-corp",
            frontmatter: { industry: "saas" },
            body: "Acme Corp — generic test company.",
            source_record_ids: ["recC1"],
          },
          {
            type: "meeting",
            slug: "2025-q2-strategy",
            frontmatter: { attendees: ["[[alice-smith]]"] },
            body: "Q2 Strategy. Attendees: [[alice-smith]].",
            source_record_ids: ["recM1"],
          },
        ]),
      sonnetCalls,
    );

    const result = await extractSlice(
      {
        baseId: "appBase",
        clusterId: "cluster-1",
        clusterType: "crm",
        tableIds: ["tPeople", "tCompanies", "tMeetings"],
        seedRecordId: "recP1",
      },
      {
        fetch: mockFetch({
          tables,
          recordsByTable: {
            tPeople: peopleRecs,
            tCompanies: companyRecs,
            tMeetings: meetingRecs,
          },
        }),
        runSonnet,
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "run-crm",
        promptsPath,
      },
    );

    expect(result.entities).toHaveLength(3);
    expect(result.truncated).toBe(false);
    expect(result.cachedHit).toBe(false);

    const personPath = join(tmp, "run-crm", "out", "person", "alice-smith.md");
    const companyPath = join(tmp, "run-crm", "out", "company", "acme-corp.md");
    const meetingPath = join(tmp, "run-crm", "out", "meeting", "2025-q2-strategy.md");
    expect(existsSync(personPath)).toBe(true);
    expect(existsSync(companyPath)).toBe(true);
    expect(existsSync(meetingPath)).toBe(true);

    const personMd = readFileSync(personPath, "utf8");
    expect(personMd).toContain("[[acme-corp]]");
    expect(personMd).toContain("sources:");
    expect(personMd).toContain("recP1");
    expect(personMd).toContain("base_id: appBase");
    expect(personMd).toContain("cluster_id: cluster-1");

    const meetingMd = readFileSync(meetingPath, "utf8");
    expect(meetingMd).toContain("[[alice-smith]]");

    expect(sonnetCalls).toHaveLength(1);
    expect(sonnetCalls[0]).toContain("CRM cluster instructions");
    expect(sonnetCalls[0]).toContain("recP1");

    const costMeterPath = join(tmp, "run-crm", "cost-meter.jsonl");
    expect(existsSync(costMeterPath)).toBe(true);
    const costLines = readFileSync(costMeterPath, "utf8").trim().split("\n");
    expect(costLines.length).toBe(1);
    const cost = JSON.parse(costLines[0]);
    expect(cost.model).toContain("sonnet");
    expect(cost.input_tokens).toBeGreaterThan(0);
    expect(cost.output_tokens).toBeGreaterThan(0);

    expect(existsSync(result.manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    expect(manifest.seed_record_id).toBe("recP1");
    expect(manifest.entities).toHaveLength(3);
  });
});

describe("extractSlice — Sonnet output missing source_record_ids", () => {
  test("backfills source_record_ids with seedRecordId so downstream render + manifest stay valid", async () => {
    const tables = [table("tPeople", "Contacts")];
    const peopleRecs = [record("recP1", { Name: "Alice Smith" })];

    const runSonnet: SonnetRunner = async () => ({
      rawText: JSON.stringify({
        entities: [
          { type: "person", slug: "alice-smith", body: "Alice Smith." },
        ],
      }),
      usage: { input_tokens: 100, output_tokens: 50 },
      model: "claude-sonnet-4-6",
    });

    const result = await extractSlice(
      {
        baseId: "appBase",
        clusterId: "cluster-1",
        clusterType: "crm",
        tableIds: ["tPeople"],
        seedRecordId: "recP1",
      },
      {
        fetch: mockFetch({
          tables,
          recordsByTable: { tPeople: peopleRecs },
        }),
        runSonnet,
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "run-fallback",
        promptsPath,
      },
    );

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].source_record_ids).toEqual(["recP1"]);

    const personPath = join(tmp, "run-fallback", "out", "person", "alice-smith.md");
    expect(existsSync(personPath)).toBe(true);
    const personMd = readFileSync(personPath, "utf8");
    expect(personMd).toContain("sources:");
    expect(personMd).toContain("recP1");

    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    expect(manifest.entities[0].source_record_ids).toEqual(["recP1"]);
  });
});

describe("extractSlice (per-table-type variants)", () => {
  test("OKR cluster fires okr prompt and produces objective + key-result", async () => {
    const tables = [
      table("tObj", "Objectives", [{ targetId: "tKR", name: "KeyResults" }]),
      table("tKR", "Key Results"),
    ];
    const objRecs = [record("recO1", { Name: "2026 Q2 Launch", KeyResults: ["recK1"] })];
    const krRecs = [record("recK1", { Name: "2026 Q2 Launch KR 1" })];

    const sonnetCalls: string[] = [];
    const runSonnet = mockSonnet(
      () =>
        staticSonnet([
          {
            type: "objective",
            slug: "2026-q2-launch",
            frontmatter: { period: "2026-q2" },
            body: "Objective Launch.",
            source_record_ids: ["recO1"],
          },
          {
            type: "key-result",
            slug: "2026-q2-launch-kr-1",
            frontmatter: { objective: "[[2026-q2-launch]]" },
            body: "Vault live.",
            source_record_ids: ["recK1"],
          },
        ]),
      sonnetCalls,
    );

    const result = await extractSlice(
      {
        baseId: "appOKR",
        clusterId: "cluster-okr",
        clusterType: "okr",
        tableIds: ["tObj", "tKR"],
        seedRecordId: "recO1",
      },
      {
        fetch: mockFetch({
          tables,
          recordsByTable: { tObj: objRecs, tKR: krRecs },
        }),
        runSonnet,
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "run-okr",
        promptsPath,
      },
    );

    expect(result.entities).toHaveLength(2);
    expect(sonnetCalls[0]).toContain("OKR cluster instructions");
    expect(sonnetCalls[0]).not.toContain("CRM cluster instructions");

    expect(existsSync(join(tmp, "run-okr", "out", "objective", "2026-q2-launch.md"))).toBe(true);
    expect(existsSync(join(tmp, "run-okr", "out", "key-result", "2026-q2-launch-kr-1.md"))).toBe(
      true,
    );
  });

  test("decision cluster fires decision prompt", async () => {
    const tables = [table("tDec", "Decisions")];
    const decRecs = [record("recD1", { Name: "2026-04-27 Adopt bun" })];

    const sonnetCalls: string[] = [];
    const runSonnet = mockSonnet(
      () =>
        staticSonnet([
          {
            type: "decision",
            slug: "2026-04-27-adopt-bun",
            frontmatter: { date: "2026-04-27", status: "accepted" },
            body: "Adopt bun for TS scripts.",
            source_record_ids: ["recD1"],
          },
        ]),
      sonnetCalls,
    );

    await extractSlice(
      {
        baseId: "appDec",
        clusterId: "cluster-dec",
        clusterType: "decision",
        tableIds: ["tDec"],
        seedRecordId: "recD1",
      },
      {
        fetch: mockFetch({ tables, recordsByTable: { tDec: decRecs } }),
        runSonnet,
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "run-decision",
        promptsPath,
      },
    );

    expect(sonnetCalls[0]).toContain("Decision cluster instructions");
    expect(existsSync(join(tmp, "run-decision", "out", "decision", "2026-04-27-adopt-bun.md"))).toBe(
      true,
    );
  });
});

describe("extractSlice (truncation)", () => {
  test("logs truncation when subgraph exceeds budget", async () => {
    const tables = [table("tA", "A", [{ targetId: "tA", name: "Next" }])];
    const recs: AirtableRecord[] = [];
    for (let i = 0; i < 50; i++) {
      const fields: Record<string, unknown> =
        i === 0 ? { Name: "anchor" } : { Name: `${"x".repeat(500)}-${i}` };
      if (i + 1 < 50) fields.Next = [`r${i + 1}`];
      recs.push(record(`r${i}`, fields));
    }

    const runSonnet = mockSonnet(() =>
      staticSonnet([
        {
          type: "note",
          slug: "anchor",
          body: "anchor",
          source_record_ids: ["r0"],
        },
      ]),
    );

    const result = await extractSlice(
      {
        baseId: "appBig",
        clusterId: "cluster-big",
        clusterType: "knowledge-note",
        tableIds: ["tA"],
        seedRecordId: "r0",
      },
      {
        fetch: mockFetch({ tables, recordsByTable: { tA: recs } }),
        runSonnet,
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "run-trunc",
        promptsPath,
        clusterContextBudget: 200,
      },
    );

    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toContain("budget");

    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    expect(manifest.truncated).toBe(true);
  });

  test("uses CLUSTER_CONTEXT_BUDGET=100K by default", () => {
    expect(CLUSTER_CONTEXT_BUDGET).toBe(100_000);
  });
});

describe("extractSlice (idempotency)", () => {
  test("re-running on same seed returns cached entities and skips Sonnet", async () => {
    const tables = [table("tA", "Contacts")];
    const recs = [record("recP1", { Name: "Alice Smith" })];

    const sonnetCalls: string[] = [];
    const runSonnet = mockSonnet(
      () =>
        staticSonnet([
          {
            type: "person",
            slug: "alice-smith",
            body: "Alice.",
            source_record_ids: ["recP1"],
          },
        ]),
      sonnetCalls,
    );

    const input = {
      baseId: "appIdem",
      clusterId: "cluster-idem",
      clusterType: "crm" as const,
      tableIds: ["tA"],
      seedRecordId: "recP1",
    };
    const opts = {
      fetch: mockFetch({ tables, recordsByTable: { tA: recs } }),
      runSonnet,
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "run-idem",
      promptsPath,
    };

    const r1 = await extractSlice(input, opts);
    const r2 = await extractSlice(input, opts);

    expect(sonnetCalls).toHaveLength(1);
    expect(r1.cachedHit).toBe(false);
    expect(r2.cachedHit).toBe(true);
    expect(r2.entities).toEqual(r1.entities);

    const personPath = join(tmp, "run-idem", "out", "person", "alice-smith.md");
    const md1 = readFileSync(personPath, "utf8");
    const r3 = await extractSlice(input, opts);
    expect(r3.cachedHit).toBe(true);
    const md2 = readFileSync(personPath, "utf8");
    expect(md1).toBe(md2);
  });
});

// ---------------------------------------------------------------------------
// AC#2 spec compliance: source traceability, wikilinks, AI fields, attachments
// ai-brain#231 — entity render must surface per-entity source record metadata
// + AI text fields + attachment count + Related-section wikilinks.
// ---------------------------------------------------------------------------

describe("airtableRecordUrl", () => {
  test("produces canonical https://airtable.com/<base>/<table>/<record> URL", () => {
    expect(airtableRecordUrl("appBase", "tblPay", "recPay1")).toBe(
      "https://airtable.com/appBase/tblPay/recPay1",
    );
  });
});

describe("extractAiFields", () => {
  test("captures plain-string aiText values", () => {
    const t: AirtableTable = {
      id: "t1",
      name: "Payments",
      fields: [
        { id: "fName", name: "Name", type: "singleLineText" },
        { id: "fRisk", name: "Payment Risk Assessment (AI)", type: "aiText" },
      ],
    };
    const r = record("recX", {
      Name: "X",
      "Payment Risk Assessment (AI)": "Medium risk: monitor.",
    });
    expect(extractAiFields(r, t)).toEqual([
      { field: "Payment Risk Assessment (AI)", value: "Medium risk: monitor." },
    ]);
  });

  test("captures object-shape aiText values via .value", () => {
    const t: AirtableTable = {
      id: "t1",
      name: "Cashflows",
      fields: [
        { id: "fSum", name: "Cashflow Summary (AI)", type: "aiText" },
      ],
    };
    const r = record("recY", {
      "Cashflow Summary (AI)": { value: "Quarterly summary.", state: "generated", isStale: false },
    });
    expect(extractAiFields(r, t)).toEqual([
      { field: "Cashflow Summary (AI)", value: "Quarterly summary." },
    ]);
  });

  test("ignores non-aiText fields and empty values", () => {
    const t: AirtableTable = {
      id: "t1",
      name: "Notes",
      fields: [
        { id: "fA", name: "Plain", type: "singleLineText" },
        { id: "fB", name: "EmptyAI", type: "aiText" },
        { id: "fC", name: "ObjectErr", type: "aiText" },
      ],
    };
    const r = record("recZ", {
      Plain: "ignored — not aiText",
      EmptyAI: "",
      ObjectErr: { state: "error" },
    });
    expect(extractAiFields(r, t)).toEqual([]);
  });
});

describe("extractAttachments", () => {
  test("counts attachments and surfaces first URL", () => {
    const t: AirtableTable = {
      id: "t1",
      name: "Payments",
      fields: [
        { id: "fA", name: "Receipt", type: "multipleAttachments" },
      ],
    };
    const r = record("recA", {
      Receipt: [
        { id: "att1", url: "https://dl.airtable.com/a.png", filename: "a.png" },
        { id: "att2", url: "https://dl.airtable.com/b.png", filename: "b.png" },
      ],
    });
    expect(extractAttachments(r, t)).toEqual({
      count: 2,
      firstUrl: "https://dl.airtable.com/a.png",
    });
  });

  test("returns zero when no attachment fields", () => {
    const t: AirtableTable = {
      id: "t1",
      name: "Plain",
      fields: [{ id: "fA", name: "Name", type: "singleLineText" }],
    };
    const r = record("recA", { Name: "X" });
    expect(extractAttachments(r, t)).toEqual({ count: 0, firstUrl: null });
  });

  test("ignores malformed attachment entries (no url)", () => {
    const t: AirtableTable = {
      id: "t1",
      name: "Files",
      fields: [{ id: "fA", name: "Files", type: "multipleAttachments" }],
    };
    const r = record("recA", { Files: [{ id: "att1" }, "garbage"] });
    expect(extractAttachments(r, t)).toEqual({ count: 0, firstUrl: null });
  });
});

describe("buildSlugMap", () => {
  test("maps each source_record_id to its entity slug; first wins on conflict", () => {
    const entities: ExtractedEntity[] = [
      { type: "person", slug: "alice", body: "", source_record_ids: ["recP1"] },
      { type: "company", slug: "acme", body: "", source_record_ids: ["recC1", "recC2"] },
      { type: "person", slug: "shadow", body: "", source_record_ids: ["recP1"] },
    ];
    const m = buildSlugMap(entities);
    expect(m.get("recP1")).toBe("alice");
    expect(m.get("recC1")).toBe("acme");
    expect(m.get("recC2")).toBe("acme");
    expect(m.size).toBe(3);
  });
});

describe("findRelatedWikilinks", () => {
  test("returns linked-record wikilinks for entities present in slice", () => {
    const t: AirtableTable = {
      id: "tPeople",
      name: "Contacts",
      fields: [
        { id: "fName", name: "Name", type: "singleLineText" },
        {
          id: "fCo",
          name: "Company",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tCompanies" },
        },
      ],
    };
    const tCo: AirtableTable = {
      id: "tCompanies",
      name: "Companies",
      fields: [{ id: "fName", name: "Name", type: "singleLineText" }],
    };
    const recs = new Map<string, AirtableRecord>([
      ["recP1", record("recP1", { Name: "Alice", Company: ["recC1"] })],
      ["recC1", record("recC1", { Name: "Acme" })],
    ]);
    const recordToTable = new Map<string, string>([
      ["recP1", "tPeople"],
      ["recC1", "tCompanies"],
    ]);
    const tablesById = new Map<string, AirtableTable>([
      ["tPeople", t],
      ["tCompanies", tCo],
    ]);
    const slugMap = new Map<string, string>([
      ["recP1", "alice"],
      ["recC1", "acme"],
    ]);
    const entity: ExtractedEntity = {
      type: "person",
      slug: "alice",
      body: "Alice",
      source_record_ids: ["recP1"],
    };
    const links = findRelatedWikilinks(entity, recs, recordToTable, tablesById, slugMap);
    expect(links).toEqual([{ slug: "acme", recordId: "recC1", tableName: "Companies" }]);
  });

  test("skips self-references", () => {
    const t: AirtableTable = {
      id: "tA",
      name: "Notes",
      fields: [
        {
          id: "fSelf",
          name: "Related",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tA" },
        },
      ],
    };
    const recs = new Map<string, AirtableRecord>([
      ["r1", record("r1", { Related: ["r1"] })],
    ]);
    const slugMap = new Map<string, string>([["r1", "self"]]);
    const entity: ExtractedEntity = {
      type: "note",
      slug: "self",
      body: "",
      source_record_ids: ["r1"],
    };
    const links = findRelatedWikilinks(
      entity,
      recs,
      new Map([["r1", "tA"]]),
      new Map([["tA", t]]),
      slugMap,
    );
    expect(links).toEqual([]);
  });

  test("skips linked records not represented in this slice", () => {
    const t: AirtableTable = {
      id: "tA",
      name: "A",
      fields: [
        {
          id: "fLink",
          name: "Other",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tB" },
        },
      ],
    };
    const recs = new Map<string, AirtableRecord>([
      ["r1", record("r1", { Other: ["rUnknown"] })],
    ]);
    const slugMap = new Map<string, string>([["r1", "alpha"]]);
    const entity: ExtractedEntity = {
      type: "x",
      slug: "alpha",
      body: "",
      source_record_ids: ["r1"],
    };
    const links = findRelatedWikilinks(
      entity,
      recs,
      new Map([["r1", "tA"]]),
      new Map([["tA", t]]),
      slugMap,
    );
    expect(links).toEqual([]);
  });

  test("dedupes by target slug across multiple link fields", () => {
    const t: AirtableTable = {
      id: "tA",
      name: "A",
      fields: [
        {
          id: "fL1",
          name: "Link1",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tB" },
        },
        {
          id: "fL2",
          name: "Link2",
          type: "multipleRecordLinks",
          options: { linkedTableId: "tB" },
        },
      ],
    };
    const recs = new Map<string, AirtableRecord>([
      ["r1", record("r1", { Link1: ["r2"], Link2: ["r2"] })],
      ["r2", record("r2", {})],
    ]);
    const slugMap = new Map<string, string>([
      ["r1", "alpha"],
      ["r2", "beta"],
    ]);
    const entity: ExtractedEntity = {
      type: "x",
      slug: "alpha",
      body: "",
      source_record_ids: ["r1"],
    };
    const links = findRelatedWikilinks(
      entity,
      recs,
      new Map([["r1", "tA"], ["r2", "tA"]]),
      new Map([["tA", t]]),
      slugMap,
    );
    expect(links).toHaveLength(1);
    expect(links[0].slug).toBe("beta");
  });
});

describe("extractSlice (AC#1 — per-entity source traceability)", () => {
  test("each entity gets distinct source_record_id, source_table, source_url in frontmatter", async () => {
    const tables = [
      table("tPay", "Payments", [{ targetId: "tCash", name: "RelatedCashflow" }]),
      table("tCash", "Cashflows"),
    ];
    const payRecs = [
      record("recPay1", { Name: "Payment alpha", RelatedCashflow: ["recCash1"] }),
      record("recPay2", { Name: "Payment beta" }),
    ];
    const cashRecs = [record("recCash1", { Name: "Cashflow root" })];

    const runSonnet = mockSonnet(() =>
      staticSonnet([
        {
          type: "payment",
          slug: "payment-alpha",
          body: "Payment alpha.",
          source_record_ids: ["recPay1"],
        },
        {
          type: "payment",
          slug: "payment-beta",
          body: "Payment beta.",
          source_record_ids: ["recPay2"],
        },
        {
          type: "cashflow",
          slug: "cashflow-root",
          body: "Cashflow root.",
          source_record_ids: ["recCash1"],
        },
      ]),
    );

    const result = await extractSlice(
      {
        baseId: "appUV3hAWcRzrGjqK",
        clusterId: "cluster-fin",
        clusterType: "knowledge-note",
        tableIds: ["tPay", "tCash"],
        seedRecordId: "recCash1",
      },
      {
        fetch: mockFetch({
          tables,
          recordsByTable: { tPay: payRecs, tCash: cashRecs },
        }),
        runSonnet,
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "run-ac1",
        promptsPath,
      },
    );

    expect(result.entities).toHaveLength(3);

    const alphaMd = readFileSync(
      join(tmp, "run-ac1", "out", "payment", "payment-alpha.md"),
      "utf8",
    );
    expect(alphaMd).toContain("source_record_id: recPay1");
    expect(alphaMd).toContain('source_table: "Payments"');
    expect(alphaMd).toContain('source_url: "https://airtable.com/appUV3hAWcRzrGjqK/tPay/recPay1"');

    const betaMd = readFileSync(
      join(tmp, "run-ac1", "out", "payment", "payment-beta.md"),
      "utf8",
    );
    expect(betaMd).toContain("source_record_id: recPay2");
    expect(betaMd).toContain('source_url: "https://airtable.com/appUV3hAWcRzrGjqK/tPay/recPay2"');

    const cashMd = readFileSync(
      join(tmp, "run-ac1", "out", "cashflow", "cashflow-root.md"),
      "utf8",
    );
    expect(cashMd).toContain("source_record_id: recCash1");
    expect(cashMd).toContain('source_table: "Cashflows"');
    expect(cashMd).toContain('source_url: "https://airtable.com/appUV3hAWcRzrGjqK/tCash/recCash1"');
  });

  test("entity with no source_record_ids resolves to the seed record via reverse-lookup (slug matches Name)", async () => {
    const tables = [table("tA", "Things")];
    const recs = [record("recSeed", { Name: "alpha" })];

    const runSonnet: SonnetRunner = async () => ({
      rawText: JSON.stringify({
        entities: [{ type: "thing", slug: "alpha", body: "x" }],
      }),
      usage: { input_tokens: 10, output_tokens: 5 },
      model: "claude-sonnet-4-6",
    });

    const result = await extractSlice(
      {
        baseId: "appB",
        clusterId: "c1",
        clusterType: "knowledge-note",
        tableIds: ["tA"],
        seedRecordId: "recSeed",
      },
      {
        fetch: mockFetch({ tables, recordsByTable: { tA: recs } }),
        runSonnet,
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "run-ac1-fallback",
        promptsPath,
      },
    );

    const md = readFileSync(
      join(tmp, "run-ac1-fallback", "out", "thing", "alpha.md"),
      "utf8",
    );
    expect(md).toContain("source_record_id: recSeed");
    expect(md).toContain('source_table: "Things"');
    expect(result.entities[0].source_record_ids).toEqual(["recSeed"]);
  });
});

describe("extractSlice (AC#2 — wikilinks for linked records)", () => {
  test("appends ## Related section with [[slug]] for each linked record present in slice", async () => {
    const tables = [
      table("tPay", "Payments", [{ targetId: "tCash", name: "Linked" }]),
      table("tCash", "Cashflows"),
    ];
    const payRecs = [record("recPay1", { Name: "Pay", Linked: ["recCash1"] })];
    const cashRecs = [record("recCash1", { Name: "Cash" })];

    const runSonnet = mockSonnet(() =>
      staticSonnet([
        {
          type: "payment",
          slug: "pay",
          body: "Linked to Cash cashflow.",
          source_record_ids: ["recPay1"],
        },
        {
          type: "cashflow",
          slug: "cash",
          body: "Cashflow root.",
          source_record_ids: ["recCash1"],
        },
      ]),
    );

    await extractSlice(
      {
        baseId: "appB",
        clusterId: "c1",
        clusterType: "knowledge-note",
        tableIds: ["tPay", "tCash"],
        seedRecordId: "recPay1",
      },
      {
        fetch: mockFetch({
          tables,
          recordsByTable: { tPay: payRecs, tCash: cashRecs },
        }),
        runSonnet,
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "run-ac2",
        promptsPath,
      },
    );

    const payMd = readFileSync(join(tmp, "run-ac2", "out", "payment", "pay.md"), "utf8");
    expect(payMd).toContain("## Related");
    expect(payMd).toContain("[[cash]]");
    expect(payMd).toContain("recCash1");
    expect(payMd).toContain("Cashflows");
  });

  test("skips Related entry when wikilink already in body (idempotent against existing CRM-style outputs)", async () => {
    const tables = [
      table("tPeople", "Contacts", [{ targetId: "tCompanies", name: "Company" }]),
      table("tCompanies", "Companies"),
    ];
    const peopleRecs = [
      record("recP1", { Name: "Alice", Company: ["recC1"] }),
    ];
    const companyRecs = [record("recC1", { Name: "Acme" })];

    const runSonnet = mockSonnet(() =>
      staticSonnet([
        {
          type: "person",
          slug: "alice",
          body: "Alice — founder at [[acme]].",
          source_record_ids: ["recP1"],
        },
        {
          type: "company",
          slug: "acme",
          body: "Acme.",
          source_record_ids: ["recC1"],
        },
      ]),
    );

    await extractSlice(
      {
        baseId: "appB",
        clusterId: "c1",
        clusterType: "crm",
        tableIds: ["tPeople", "tCompanies"],
        seedRecordId: "recP1",
      },
      {
        fetch: mockFetch({
          tables,
          recordsByTable: {
            tPeople: peopleRecs,
            tCompanies: companyRecs,
          },
        }),
        runSonnet,
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "run-ac2-dup",
        promptsPath,
      },
    );

    const aliceMd = readFileSync(join(tmp, "run-ac2-dup", "out", "person", "alice.md"), "utf8");
    const matches = aliceMd.match(/\[\[acme\]\]/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(aliceMd).not.toContain("## Related");
  });
});

describe("extractSlice (AC#3 — AI fields preserved)", () => {
  test("ai_fields list rendered in frontmatter for both string and object aiText shapes", async () => {
    const tables: AirtableTable[] = [
      {
        id: "tPay",
        name: "Payments",
        fields: [
          { id: "fName", name: "Name", type: "singleLineText" },
          { id: "fRisk", name: "Payment Risk Assessment (AI)", type: "aiText" },
          { id: "fSum", name: "Cashflow Summary (AI)", type: "aiText" },
        ],
      },
    ];
    const payRecs = [
      record("recP1", {
        Name: "Pay alpha",
        "Payment Risk Assessment (AI)": "Medium risk: monitor closely.",
        "Cashflow Summary (AI)": {
          value: "Steady inflow Q2.",
          state: "generated",
          isStale: false,
        },
      }),
    ];

    const runSonnet = mockSonnet(() =>
      staticSonnet([
        {
          type: "payment",
          slug: "pay-alpha",
          body: "Pay alpha.",
          source_record_ids: ["recP1"],
        },
      ]),
    );

    await extractSlice(
      {
        baseId: "appB",
        clusterId: "c1",
        clusterType: "knowledge-note",
        tableIds: ["tPay"],
        seedRecordId: "recP1",
      },
      {
        fetch: mockFetch({ tables, recordsByTable: { tPay: payRecs } }),
        runSonnet,
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "run-ac3",
        promptsPath,
      },
    );

    const md = readFileSync(join(tmp, "run-ac3", "out", "payment", "pay-alpha.md"), "utf8");
    expect(md).toContain("ai_fields:");
    expect(md).toContain('Payment Risk Assessment (AI)');
    expect(md).toContain("Medium risk: monitor closely.");
    expect(md).toContain("Cashflow Summary (AI)");
    expect(md).toContain("Steady inflow Q2.");
  });

  test("no ai_fields key emitted when source records have no aiText fields", async () => {
    const tables = [table("tA", "Plain")];
    const recs = [record("rA", { Name: "alpha" })];

    const runSonnet = mockSonnet(() =>
      staticSonnet([
        {
          type: "thing",
          slug: "alpha",
          body: "Alpha.",
          source_record_ids: ["rA"],
        },
      ]),
    );

    await extractSlice(
      {
        baseId: "appB",
        clusterId: "c1",
        clusterType: "knowledge-note",
        tableIds: ["tA"],
        seedRecordId: "rA",
      },
      {
        fetch: mockFetch({ tables, recordsByTable: { tA: recs } }),
        runSonnet,
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "run-ac3-empty",
        promptsPath,
      },
    );

    const md = readFileSync(join(tmp, "run-ac3-empty", "out", "thing", "alpha.md"), "utf8");
    expect(md).not.toContain("ai_fields:");
  });
});

describe("extractSlice (AC#4 — attachment metadata)", () => {
  test("frontmatter has attachments_count + first_attachment_url when source record has attachments", async () => {
    const tables: AirtableTable[] = [
      {
        id: "tPay",
        name: "Payments",
        fields: [
          { id: "fName", name: "Name", type: "singleLineText" },
          { id: "fRecpt", name: "Payment Receipt Photo", type: "multipleAttachments" },
        ],
      },
    ];
    const payRecs = [
      record("recP1", {
        Name: "Pay",
        "Payment Receipt Photo": [
          {
            id: "att1",
            url: "https://dl.airtable.com/receipt-1.png",
            filename: "receipt-1.png",
          },
          {
            id: "att2",
            url: "https://dl.airtable.com/receipt-2.png",
            filename: "receipt-2.png",
          },
        ],
      }),
    ];

    const runSonnet = mockSonnet(() =>
      staticSonnet([
        {
          type: "payment",
          slug: "pay",
          body: "Pay.",
          source_record_ids: ["recP1"],
        },
      ]),
    );

    await extractSlice(
      {
        baseId: "appB",
        clusterId: "c1",
        clusterType: "knowledge-note",
        tableIds: ["tPay"],
        seedRecordId: "recP1",
      },
      {
        fetch: mockFetch({ tables, recordsByTable: { tPay: payRecs } }),
        runSonnet,
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "run-ac4",
        promptsPath,
      },
    );

    const md = readFileSync(join(tmp, "run-ac4", "out", "payment", "pay.md"), "utf8");
    expect(md).toContain("attachments_count: 2");
    expect(md).toContain('first_attachment_url: "https://dl.airtable.com/receipt-1.png"');
  });

  test("no attachment keys emitted when source record has no attachments", async () => {
    const tables = [table("tA", "Plain")];
    const recs = [record("rA", { Name: "alpha" })];

    const runSonnet = mockSonnet(() =>
      staticSonnet([
        {
          type: "thing",
          slug: "alpha",
          body: "Alpha.",
          source_record_ids: ["rA"],
        },
      ]),
    );

    await extractSlice(
      {
        baseId: "appB",
        clusterId: "c1",
        clusterType: "knowledge-note",
        tableIds: ["tA"],
        seedRecordId: "rA",
      },
      {
        fetch: mockFetch({ tables, recordsByTable: { tA: recs } }),
        runSonnet,
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "run-ac4-empty",
        promptsPath,
      },
    );

    const md = readFileSync(join(tmp, "run-ac4-empty", "out", "thing", "alpha.md"), "utf8");
    expect(md).not.toContain("attachments_count:");
    expect(md).not.toContain("first_attachment_url:");
  });
});

describe("extractSlice (AC#5 — legacy seed_record_id coexists with source_record_id)", () => {
  test("non-seed entity has both seed_record_id and a distinct source_record_id", async () => {
    const tables = [table("tCash", "Cashflows", [{ targetId: "tPay", name: "Payments" }]), table("tPay", "Payments")];
    const cashRecs = [
      record("recCashSeed", { Name: "Seed cashflow", Payments: ["recPayChild"] }),
    ];
    const payRecs = [record("recPayChild", { Name: "Child payment" })];

    const runSonnet = mockSonnet(() =>
      staticSonnet([
        {
          type: "cashflow",
          slug: "seed-cashflow",
          body: "Seed.",
          source_record_ids: ["recCashSeed"],
        },
        {
          type: "payment",
          slug: "child-payment",
          body: "Child.",
          source_record_ids: ["recPayChild"],
        },
      ]),
    );

    await extractSlice(
      {
        baseId: "appLegacy",
        clusterId: "c-legacy",
        clusterType: "knowledge-note",
        tableIds: ["tCash", "tPay"],
        seedRecordId: "recCashSeed",
      },
      {
        fetch: mockFetch({
          tables,
          recordsByTable: { tCash: cashRecs, tPay: payRecs },
        }),
        runSonnet,
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "run-ac5",
        promptsPath,
      },
    );

    const childMd = readFileSync(
      join(tmp, "run-ac5", "out", "payment", "child-payment.md"),
      "utf8",
    );
    expect(childMd).toContain("seed_record_id: recCashSeed");
    expect(childMd).toContain("source_record_id: recPayChild");
    expect(childMd).toContain("sources:");
  });
});

describe("extractSlice (error paths)", () => {
  test("throws when prompts variant missing for cluster type", async () => {
    const partialPath = join(tmp, "extract-partial.md");
    writeFileSync(partialPath, "## crm\nbody\n");

    const tables = [table("tA", "A")];
    const recs = [record("r0")];

    await expect(
      extractSlice(
        {
          baseId: "appX",
          clusterId: "c1",
          clusterType: "okr",
          tableIds: ["tA"],
          seedRecordId: "r0",
        },
        {
          fetch: mockFetch({ tables, recordsByTable: { tA: recs } }),
          runSonnet: mockSonnet(() => staticSonnet([])),
          env: { AIRTABLE_API_KEY: "patFake" },
          cacheDir: tmp,
          runId: "run-missing-variant",
          promptsPath: partialPath,
        },
      ),
    ).rejects.toThrow(/variant.*okr/i);
  });

  test("throws when seed record not present in cluster tables", async () => {
    const tables = [table("tA", "A")];
    const recs = [record("rOther")];

    await expect(
      extractSlice(
        {
          baseId: "appX",
          clusterId: "c1",
          clusterType: "crm",
          tableIds: ["tA"],
          seedRecordId: "rNotThere",
        },
        {
          fetch: mockFetch({ tables, recordsByTable: { tA: recs } }),
          runSonnet: mockSonnet(() => staticSonnet([])),
          env: { AIRTABLE_API_KEY: "patFake" },
          cacheDir: tmp,
          runId: "run-no-seed",
          promptsPath,
        },
      ),
    ).rejects.toThrow(/seed/i);
  });
});

// ---------------------------------------------------------------------------
// ai-brain#233 — per-entity source provenance: hallucination filter +
// reverse-lookup by primary-field match. Bug: prior code stamped every
// empty-source-IDs entity with seedRecordId, so AI fields, attachments,
// source_url, and wikilinks all reflected the seed instead of the entity.
// ---------------------------------------------------------------------------

describe("findSourceRecordByEntity", () => {
  function setupOneTable(
    primaryFieldName: string,
    rows: Array<{ id: string; primary: string }>,
  ) {
    const t: AirtableTable = {
      id: "t1",
      name: "Things",
      fields: [{ id: "fp", name: primaryFieldName, type: "singleLineText" }],
    };
    const recs = new Map<string, AirtableRecord>();
    const recordToTable = new Map<string, string>();
    for (const r of rows) {
      recs.set(r.id, record(r.id, { [primaryFieldName]: r.primary }));
      recordToTable.set(r.id, "t1");
    }
    return {
      recs,
      recordToTable,
      tablesById: new Map<string, AirtableTable>([["t1", t]]),
    };
  }

  test("matches entity slug to slugified primary field of single record", () => {
    const { recs, recordToTable, tablesById } = setupOneTable("Name", [
      { id: "recA", primary: "Alpha Thing" },
    ]);
    const entity: ExtractedEntity = {
      type: "thing",
      slug: "alpha-thing",
      body: "",
      source_record_ids: [],
    };
    expect(findSourceRecordByEntity(entity, recs, recordToTable, tablesById)).toEqual({
      recordId: "recA",
      reason: "match",
    });
  });

  test("returns no-match when slug matches no record's primary", () => {
    const { recs, recordToTable, tablesById } = setupOneTable("Name", [
      { id: "recA", primary: "alpha" },
    ]);
    const entity: ExtractedEntity = {
      type: "thing",
      slug: "no-such-slug",
      body: "",
      source_record_ids: [],
    };
    expect(findSourceRecordByEntity(entity, recs, recordToTable, tablesById)).toEqual({
      recordId: null,
      reason: "no-match",
    });
  });

  test("returns ambiguous when multiple records share a primary value", () => {
    const { recs, recordToTable, tablesById } = setupOneTable("Name", [
      { id: "recA", primary: "duplicate" },
      { id: "recB", primary: "duplicate" },
    ]);
    const entity: ExtractedEntity = {
      type: "thing",
      slug: "duplicate",
      body: "",
      source_record_ids: [],
    };
    const r = findSourceRecordByEntity(entity, recs, recordToTable, tablesById);
    expect(r.recordId).toBeNull();
    expect(r.reason).toBe("ambiguous");
    expect(r.candidates?.sort()).toEqual(["recA", "recB"]);
  });

  test("matches `Name` field as fallback when fields[0] is something else", () => {
    const t: AirtableTable = {
      id: "t1",
      name: "Things",
      fields: [
        { id: "fr", name: "Reference", type: "singleLineText" },
        { id: "fn", name: "Name", type: "singleLineText" },
      ],
    };
    const recs = new Map<string, AirtableRecord>([
      ["recA", record("recA", { Reference: "REF-001", Name: "alpha-via-name" })],
    ]);
    const recordToTable = new Map<string, string>([["recA", "t1"]]);
    const tablesById = new Map<string, AirtableTable>([["t1", t]]);
    const entity: ExtractedEntity = {
      type: "thing",
      slug: "alpha-via-name",
      body: "",
      source_record_ids: [],
    };
    expect(findSourceRecordByEntity(entity, recs, recordToTable, tablesById)).toEqual({
      recordId: "recA",
      reason: "match",
    });
  });
});

describe("resolveEntitySourceIds", () => {
  const t: AirtableTable = {
    id: "t1",
    name: "Things",
    fields: [{ id: "fp", name: "Name", type: "singleLineText" }],
  };
  const tablesById = new Map<string, AirtableTable>([["t1", t]]);

  test("keeps validated IDs and drops hallucinations", () => {
    const recs = new Map<string, AirtableRecord>([
      ["recReal", record("recReal", { Name: "real" })],
    ]);
    const recordToTable = new Map<string, string>([["recReal", "t1"]]);
    const warnings: string[] = [];
    const out = resolveEntitySourceIds(
      {
        type: "thing",
        slug: "real",
        body: "",
        source_record_ids: ["recReal", "recBOGUS", "recAlsoBogus"],
      },
      recs,
      recordToTable,
      tablesById,
      "recSeed",
      (m) => warnings.push(m),
    );
    expect(out).toEqual(["recReal"]);
    expect(warnings.some((w) => /hallucinated/.test(w) && /recBOGUS/.test(w))).toBe(true);
  });

  test("falls through to reverse-lookup when validation drops all IDs", () => {
    const recs = new Map<string, AirtableRecord>([
      ["recReal", record("recReal", { Name: "real" })],
      ["recSeed", record("recSeed", { Name: "seed" })],
    ]);
    const recordToTable = new Map<string, string>([
      ["recReal", "t1"],
      ["recSeed", "t1"],
    ]);
    const out = resolveEntitySourceIds(
      {
        type: "thing",
        slug: "real",
        body: "",
        source_record_ids: ["recBOGUS"],
      },
      recs,
      recordToTable,
      tablesById,
      "recSeed",
      () => {},
    );
    expect(out).toEqual(["recReal"]);
  });

  test("throws SliceRejectedError when reverse-lookup finds no match (#234 — no silent seed fallback)", () => {
    const recs = new Map<string, AirtableRecord>([
      ["recSeed", record("recSeed", { Name: "seed" })],
    ]);
    const recordToTable = new Map<string, string>([["recSeed", "t1"]]);
    expect(() =>
      resolveEntitySourceIds(
        {
          type: "thing",
          slug: "no-match",
          body: "",
          source_record_ids: [],
        },
        recs,
        recordToTable,
        tablesById,
        "recSeed",
        () => {},
      ),
    ).toThrow(SliceRejectedError);
  });

  test("throws SliceRejectedError on ambiguous reverse-lookup (#234 — no silent seed fallback)", () => {
    const recs = new Map<string, AirtableRecord>([
      ["recA", record("recA", { Name: "duplicate" })],
      ["recB", record("recB", { Name: "duplicate" })],
      ["recSeed", record("recSeed", { Name: "seed" })],
    ]);
    const recordToTable = new Map<string, string>([
      ["recA", "t1"],
      ["recB", "t1"],
      ["recSeed", "t1"],
    ]);
    let caught: SliceRejectedError | null = null;
    try {
      resolveEntitySourceIds(
        {
          type: "thing",
          slug: "duplicate",
          body: "",
          source_record_ids: [],
        },
        recs,
        recordToTable,
        tablesById,
        "recSeed",
        () => {},
      );
    } catch (err) {
      caught = err as SliceRejectedError;
    }
    expect(caught).toBeInstanceOf(SliceRejectedError);
    expect(caught?.reason).toBe("ambiguous");
    expect(caught?.candidates?.sort()).toEqual(["recA", "recB"]);
  });
});

describe("extractSlice (ai-brain#233 — multi-entity reverse-lookup)", () => {
  test("3 entities with empty source_record_ids each get their own distinct stamping (NOT all seed)", async () => {
    const tables: AirtableTable[] = [
      {
        id: "tPay",
        name: "Payments",
        fields: [
          { id: "fName", name: "Name", type: "singleLineText" },
          { id: "fRisk", name: "Payment Risk Assessment (AI)", type: "aiText" },
          { id: "fRecpt", name: "Receipt", type: "multipleAttachments" },
        ],
      },
      {
        id: "tCash",
        name: "Cashflows",
        fields: [
          { id: "fName", name: "Name", type: "singleLineText" },
          { id: "fSum", name: "Cashflow Summary (AI)", type: "aiText" },
        ],
      },
    ];
    const payRecs = [
      record("recPayAlpha", {
        Name: "payment-alpha",
        "Payment Risk Assessment (AI)": "alpha-risk-text",
        Receipt: [
          { id: "att-a", url: "https://dl.airtable.com/alpha.png", filename: "alpha.png" },
        ],
      }),
      record("recPayBeta", {
        Name: "payment-beta",
        "Payment Risk Assessment (AI)": "beta-risk-text",
      }),
    ];
    const cashRecs = [
      record("recCashSeed", {
        Name: "cashflow-seed",
        "Cashflow Summary (AI)": "seed-summary-text",
      }),
    ];

    const runSonnet = mockSonnet(() => ({
      rawText: JSON.stringify({
        entities: [
          { type: "payment", slug: "payment-alpha", body: "Payment alpha." },
          { type: "payment", slug: "payment-beta", body: "Payment beta." },
          { type: "cashflow", slug: "cashflow-seed", body: "Cashflow seed." },
        ],
      }),
      usage: { input_tokens: 100, output_tokens: 50 },
      model: "claude-sonnet-4-6",
    }));

    const result = await extractSlice(
      {
        baseId: "appUV3hAWcRzrGjqK",
        clusterId: "c233",
        clusterType: "knowledge-note",
        tableIds: ["tPay", "tCash"],
        seedRecordId: "recCashSeed",
      },
      {
        fetch: mockFetch({
          tables,
          recordsByTable: { tPay: payRecs, tCash: cashRecs },
        }),
        runSonnet,
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "run-233-multi",
        promptsPath,
      },
    );

    expect(result.entities).toHaveLength(3);

    const alphaMd = readFileSync(
      join(tmp, "run-233-multi", "out", "payment", "payment-alpha.md"),
      "utf8",
    );
    expect(alphaMd).toContain("source_record_id: recPayAlpha");
    expect(alphaMd).toContain('source_table: "Payments"');
    expect(alphaMd).toContain('source_url: "https://airtable.com/appUV3hAWcRzrGjqK/tPay/recPayAlpha"');
    expect(alphaMd).toContain("alpha-risk-text");
    expect(alphaMd).not.toContain("beta-risk-text");
    expect(alphaMd).not.toContain("seed-summary-text");
    expect(alphaMd).toContain("attachments_count: 1");
    expect(alphaMd).toContain("alpha.png");

    const betaMd = readFileSync(
      join(tmp, "run-233-multi", "out", "payment", "payment-beta.md"),
      "utf8",
    );
    expect(betaMd).toContain("source_record_id: recPayBeta");
    expect(betaMd).toContain('source_url: "https://airtable.com/appUV3hAWcRzrGjqK/tPay/recPayBeta"');
    expect(betaMd).toContain("beta-risk-text");
    expect(betaMd).not.toContain("alpha-risk-text");
    expect(betaMd).not.toContain("seed-summary-text");
    expect(betaMd).not.toContain("attachments_count:");

    const seedMd = readFileSync(
      join(tmp, "run-233-multi", "out", "cashflow", "cashflow-seed.md"),
      "utf8",
    );
    expect(seedMd).toContain("source_record_id: recCashSeed");
    expect(seedMd).toContain('source_table: "Cashflows"');
    expect(seedMd).toContain("seed-summary-text");
    expect(seedMd).not.toContain("alpha-risk-text");
  });

  test("wikilinks reflect entity's own record links, not seed's (regression)", async () => {
    const tables: AirtableTable[] = [
      {
        id: "tPay",
        name: "Payments",
        fields: [
          { id: "fName", name: "Name", type: "singleLineText" },
          {
            id: "fLink",
            name: "RelatedCash",
            type: "multipleRecordLinks",
            options: { linkedTableId: "tCash" },
          },
        ],
      },
      {
        id: "tCash",
        name: "Cashflows",
        fields: [{ id: "fName", name: "Name", type: "singleLineText" }],
      },
    ];
    const payRecs = [
      record("recPay", { Name: "payment-with-link", RelatedCash: ["recCashLinked"] }),
    ];
    const cashRecs = [
      record("recSeedCash", { Name: "seed-cashflow" }),
      record("recCashLinked", { Name: "linked-cashflow" }),
    ];

    const runSonnet = mockSonnet(() => ({
      rawText: JSON.stringify({
        entities: [
          { type: "payment", slug: "payment-with-link", body: "Has a link." },
          { type: "cashflow", slug: "seed-cashflow", body: "Seed." },
          { type: "cashflow", slug: "linked-cashflow", body: "Linked." },
        ],
      }),
      usage: { input_tokens: 10, output_tokens: 5 },
      model: "claude-sonnet-4-6",
    }));

    await extractSlice(
      {
        baseId: "appB",
        clusterId: "c233-wiki",
        clusterType: "knowledge-note",
        tableIds: ["tPay", "tCash"],
        seedRecordId: "recSeedCash",
      },
      {
        fetch: mockFetch({
          tables,
          recordsByTable: { tPay: payRecs, tCash: cashRecs },
        }),
        runSonnet,
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "run-233-wiki",
        promptsPath,
      },
    );

    const payMd = readFileSync(
      join(tmp, "run-233-wiki", "out", "payment", "payment-with-link.md"),
      "utf8",
    );
    expect(payMd).toContain("[[linked-cashflow]]");
  });

  test("filters Sonnet hallucinated record IDs and falls through to reverse-lookup", async () => {
    const tables = [table("tA", "Things")];
    const recs = [record("recReal", { Name: "real-thing" })];

    const runSonnet: SonnetRunner = async () => ({
      rawText: JSON.stringify({
        entities: [
          {
            type: "thing",
            slug: "real-thing",
            body: "x",
            source_record_ids: ["recBOGUS", "recAlsoBogus"],
          },
        ],
      }),
      usage: { input_tokens: 10, output_tokens: 5 },
      model: "claude-sonnet-4-6",
    });

    const warnings: string[] = [];
    const result = await extractSlice(
      {
        baseId: "appB",
        clusterId: "c233-hall",
        clusterType: "knowledge-note",
        tableIds: ["tA"],
        seedRecordId: "recReal",
      },
      {
        fetch: mockFetch({ tables, recordsByTable: { tA: recs } }),
        runSonnet,
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "run-233-hall",
        promptsPath,
        warn: (m) => warnings.push(m),
      },
    );

    expect(result.entities[0].source_record_ids).toEqual(["recReal"]);
    expect(warnings.some((w) => /hallucinated/.test(w))).toBe(true);

    const md = readFileSync(
      join(tmp, "run-233-hall", "out", "thing", "real-thing.md"),
      "utf8",
    );
    expect(md).toContain("source_record_id: recReal");
  });

  test("reverse-lookup no match → throws SliceRejectedError (#234 supersedes #233 fallback)", async () => {
    const tables = [table("tA", "Things")];
    const recs = [record("recSeed", { Name: "totally-different" })];

    const runSonnet: SonnetRunner = async () => ({
      rawText: JSON.stringify({
        entities: [{ type: "thing", slug: "no-match-anywhere", body: "x" }],
      }),
      usage: { input_tokens: 10, output_tokens: 5 },
      model: "claude-sonnet-4-6",
    });

    let caught: unknown = null;
    try {
      await extractSlice(
        {
          baseId: "appB",
          clusterId: "c233-fallback",
          clusterType: "knowledge-note",
          tableIds: ["tA"],
          seedRecordId: "recSeed",
        },
        {
          fetch: mockFetch({ tables, recordsByTable: { tA: recs } }),
          runSonnet,
          env: { AIRTABLE_API_KEY: "patFake" },
          cacheDir: tmp,
          runId: "run-233-fallback",
          promptsPath,
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SliceRejectedError);
  });
});

describe("extractSlice (ai-brain#234 — per-entity provenance deterministic across cluster shapes)", () => {
  test("Cashflow-seed slice with Payment entity: source_record_id is the Payment record, NOT the seed", async () => {
    // Reproduces the headline bug from #234: seed.table != entity.table.
    // Sonnet emits the seed's record_id for a Payment entity (because the prompt
    // anchors on seed_record_id). Script must override via reverse-lookup.
    const tables: AirtableTable[] = [
      {
        id: "tCash",
        name: "Cashflows",
        fields: [{ id: "fCashName", name: "Name", type: "singleLineText" }],
      },
      {
        id: "tPay",
        name: "Payments",
        fields: [{ id: "fRef", name: "Reference", type: "singleLineText" }],
      },
    ];
    const cashRecs = [record("recCashSeed", { Name: "Server Hosting Fees" })];
    const payRecs = [record("recPayActual", { Reference: "AP09252025d" })];

    const runSonnet = mockSonnet(() =>
      staticSonnet([
        {
          type: "payment",
          slug: "payment-ap09252025d",
          body: "Payment for hosting.",
          source_record_ids: ["recCashSeed"], // ← seed-anchored bug pattern
        },
        {
          type: "cashflow",
          slug: "server-hosting-fees",
          body: "Hosting cashflow.",
          source_record_ids: ["recCashSeed"],
        },
      ]),
    );

    const result = await extractSlice(
      {
        baseId: "appUV3hAWcRzrGjqK",
        clusterId: "c234-cash-seed",
        clusterType: "knowledge-note",
        tableIds: ["tCash", "tPay"],
        seedRecordId: "recCashSeed",
      },
      {
        fetch: mockFetch({
          tables,
          recordsByTable: { tCash: cashRecs, tPay: payRecs },
        }),
        runSonnet,
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "run-234-cash-seed",
        promptsPath,
      },
    );

    const paymentEntity = result.entities.find((e) => e.slug === "payment-ap09252025d");
    expect(paymentEntity?.source_record_ids).toEqual(["recPayActual"]);

    const payMd = readFileSync(
      join(tmp, "run-234-cash-seed", "out", "payment", "payment-ap09252025d.md"),
      "utf8",
    );
    expect(payMd).toContain("source_record_id: recPayActual");
    expect(payMd).toContain('source_table: "Payments"');
    expect(payMd).toContain('source_url: "https://airtable.com/appUV3hAWcRzrGjqK/tPay/recPayActual"');
    expect(payMd).not.toContain("source_record_id: recCashSeed");
  });

  test("PnL-seed slice with Payment entity: same shape, primary = report_name, payment is reverse-looked-up via type-prefix", async () => {
    const tables: AirtableTable[] = [
      {
        id: "tPnL",
        name: "PnL Reports",
        fields: [{ id: "fReport", name: "Report Name", type: "singleLineText" }],
      },
      {
        id: "tPay",
        name: "Payments",
        fields: [{ id: "fRef", name: "Reference", type: "singleLineText" }],
      },
    ];
    const pnlRecs = [record("recPnLSeed", { "Report Name": "2025 Q3 P&L" })];
    const payRecs = [record("recPayBT", { Reference: "BT-2025-09-001" })];

    const runSonnet = mockSonnet(() =>
      staticSonnet([
        {
          type: "payment",
          slug: "payment-bt-2025-09-001",
          body: "Payment BT-2025-09-001.",
          source_record_ids: ["recPnLSeed"],
        },
        {
          type: "pnl-report",
          slug: "pnl-report-2025-q3-p-l",
          body: "Q3 P&L.",
          source_record_ids: ["recPnLSeed"],
        },
      ]),
    );

    const result = await extractSlice(
      {
        baseId: "appUV3hAWcRzrGjqK",
        clusterId: "c234-pnl-seed",
        clusterType: "knowledge-note",
        tableIds: ["tPnL", "tPay"],
        seedRecordId: "recPnLSeed",
      },
      {
        fetch: mockFetch({
          tables,
          recordsByTable: { tPnL: pnlRecs, tPay: payRecs },
        }),
        runSonnet,
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "run-234-pnl-seed",
        promptsPath,
      },
    );

    const pay = result.entities.find((e) => e.slug === "payment-bt-2025-09-001");
    expect(pay?.source_record_ids).toEqual(["recPayBT"]);

    const pnl = result.entities.find((e) => e.slug === "pnl-report-2025-q3-p-l");
    expect(pnl?.source_record_ids).toEqual(["recPnLSeed"]);
  });

  test("Payment-seed slice continues to pass (regression: do not break the case #233 fixed)", async () => {
    const tables: AirtableTable[] = [
      {
        id: "tPay",
        name: "Payments",
        fields: [{ id: "fRef", name: "Reference", type: "singleLineText" }],
      },
    ];
    const payRecs = [
      record("recPay1", { Reference: "BT-001" }),
      record("recPay2", { Reference: "BT-002" }),
    ];

    const runSonnet = mockSonnet(() =>
      staticSonnet([
        {
          type: "payment",
          slug: "payment-bt-001",
          body: "P1",
          source_record_ids: ["recPay1"],
        },
        {
          type: "payment",
          slug: "payment-bt-002",
          body: "P2",
          source_record_ids: ["recPay2"],
        },
      ]),
    );

    const result = await extractSlice(
      {
        baseId: "appB",
        clusterId: "c234-pay-seed",
        clusterType: "knowledge-note",
        tableIds: ["tPay"],
        seedRecordId: "recPay1",
      },
      {
        fetch: mockFetch({ tables, recordsByTable: { tPay: payRecs } }),
        runSonnet,
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "run-234-pay-seed",
        promptsPath,
      },
    );

    const e1 = result.entities.find((e) => e.slug === "payment-bt-001");
    const e2 = result.entities.find((e) => e.slug === "payment-bt-002");
    expect(e1?.source_record_ids).toEqual(["recPay1"]);
    expect(e2?.source_record_ids).toEqual(["recPay2"]);
  });

  test("findSourceRecordByEntity matches type-prefixed slug against bare-primary records (slug='payment-ap09252025d', primary='AP09252025d')", () => {
    const t: AirtableTable = {
      id: "t1",
      name: "Payments",
      fields: [{ id: "fp", name: "Reference", type: "singleLineText" }],
    };
    const recs = new Map<string, AirtableRecord>([
      ["recA", record("recA", { Reference: "AP09252025d" })],
    ]);
    const recordToTable = new Map<string, string>([["recA", "t1"]]);
    const tablesById = new Map<string, AirtableTable>([["t1", t]]);
    const entity: ExtractedEntity = {
      type: "payment",
      slug: "payment-ap09252025d",
      body: "",
      source_record_ids: [],
    };
    expect(findSourceRecordByEntity(entity, recs, recordToTable, tablesById)).toEqual({
      recordId: "recA",
      reason: "match",
    });
  });

  test("extractSlice writes escalation.md and throws when reverse-lookup has no match", async () => {
    const tables = [table("tA", "Things")];
    const recs = [record("recSeed", { Name: "different-thing" })];

    const runSonnet: SonnetRunner = async () => ({
      rawText: JSON.stringify({
        entities: [{ type: "thing", slug: "no-such-entity", body: "x" }],
      }),
      usage: { input_tokens: 10, output_tokens: 5 },
      model: "claude-sonnet-4-6",
    });

    let caught: SliceRejectedError | null = null;
    try {
      await extractSlice(
        {
          baseId: "appB",
          clusterId: "c234-escalate",
          clusterType: "knowledge-note",
          tableIds: ["tA"],
          seedRecordId: "recSeed",
        },
        {
          fetch: mockFetch({ tables, recordsByTable: { tA: recs } }),
          runSonnet,
          env: { AIRTABLE_API_KEY: "patFake" },
          cacheDir: tmp,
          runId: "run-234-escalate-no-match",
          promptsPath,
        },
      );
    } catch (err) {
      caught = err as SliceRejectedError;
    }
    expect(caught).toBeInstanceOf(SliceRejectedError);

    const escalationPath = join(tmp, "run-234-escalate-no-match", "escalation.md");
    expect(existsSync(escalationPath)).toBe(true);
    const md = readFileSync(escalationPath, "utf8");
    expect(md).toContain("recSeed");
    expect(md).toContain("no-such-entity");
    expect(md).toContain("no-match");
  });

  test("extractSlice writes escalation.md and throws when reverse-lookup is ambiguous", async () => {
    const tables = [table("tA", "Things")];
    const recs = [
      record("recA", { Name: "duplicate" }),
      record("recB", { Name: "duplicate" }),
    ];

    const runSonnet: SonnetRunner = async () => ({
      rawText: JSON.stringify({
        entities: [{ type: "thing", slug: "duplicate", body: "x" }],
      }),
      usage: { input_tokens: 10, output_tokens: 5 },
      model: "claude-sonnet-4-6",
    });

    let caught: SliceRejectedError | null = null;
    try {
      await extractSlice(
        {
          baseId: "appB",
          clusterId: "c234-ambiguous",
          clusterType: "knowledge-note",
          tableIds: ["tA"],
          seedRecordId: "recA",
        },
        {
          fetch: mockFetch({ tables, recordsByTable: { tA: recs } }),
          runSonnet,
          env: { AIRTABLE_API_KEY: "patFake" },
          cacheDir: tmp,
          runId: "run-234-escalate-ambiguous",
          promptsPath,
        },
      );
    } catch (err) {
      caught = err as SliceRejectedError;
    }
    expect(caught).toBeInstanceOf(SliceRejectedError);
    expect(caught?.reason).toBe("ambiguous");
    expect(caught?.candidates?.sort()).toEqual(["recA", "recB"]);

    const escalationPath = join(tmp, "run-234-escalate-ambiguous", "escalation.md");
    expect(existsSync(escalationPath)).toBe(true);
    const md = readFileSync(escalationPath, "utf8");
    expect(md).toContain("ambiguous");
    expect(md).toContain("recA");
    expect(md).toContain("recB");
  });

  test("extractSlice ignores Sonnet's seed-anchored source_record_ids when reverse-lookup finds the actual entity record", async () => {
    // Even when Sonnet's emit is wire-level "valid" (record exists in cluster),
    // the reverse-lookup result wins. This is the core architectural change of #234:
    // zero LLM judgment on provenance fields.
    const tables: AirtableTable[] = [
      {
        id: "tCash",
        name: "Cashflows",
        fields: [{ id: "fCashName", name: "Name", type: "singleLineText" }],
      },
      {
        id: "tPay",
        name: "Payments",
        fields: [{ id: "fRef", name: "Reference", type: "singleLineText" }],
      },
    ];
    const cashRecs = [record("recCash", { Name: "Hosting" })];
    const payRecs = [record("recPay", { Reference: "BT-001" })];

    const runSonnet = mockSonnet(() =>
      staticSonnet([
        {
          // Sonnet "claims" the Payment entity is sourced from the Cashflow seed —
          // wire-level valid (recCash IS in the cluster) but semantically wrong.
          type: "payment",
          slug: "payment-bt-001",
          body: "P1",
          source_record_ids: ["recCash"],
        },
      ]),
    );

    const result = await extractSlice(
      {
        baseId: "appB",
        clusterId: "c234-trust-script",
        clusterType: "knowledge-note",
        tableIds: ["tCash", "tPay"],
        seedRecordId: "recCash",
      },
      {
        fetch: mockFetch({
          tables,
          recordsByTable: { tCash: cashRecs, tPay: payRecs },
        }),
        runSonnet,
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "run-234-trust-script",
        promptsPath,
      },
    );

    expect(result.entities[0].source_record_ids).toEqual(["recPay"]);
  });
});
