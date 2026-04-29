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
    const meetingRecs = [record("recM1", { Name: "Q2 Strategy", Attendees: ["recP1"] })];

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

describe("extractSlice (per-table-type variants)", () => {
  test("OKR cluster fires okr prompt and produces objective + key-result", async () => {
    const tables = [
      table("tObj", "Objectives", [{ targetId: "tKR", name: "KeyResults" }]),
      table("tKR", "Key Results"),
    ];
    const objRecs = [record("recO1", { Name: "Launch", KeyResults: ["recK1"] })];
    const krRecs = [record("recK1", { Name: "Vault live" })];

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
    const decRecs = [record("recD1", { Name: "Adopt bun" })];

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
      const fields: Record<string, unknown> = { Name: "x".repeat(500) };
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
