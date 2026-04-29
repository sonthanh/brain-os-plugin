import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectLegacyLinks,
  computeSparseEdge,
  assessBrokenTarget,
  type AirtableRecord,
} from "../scripts/legacy-link-detector.mts";
import type { AirtableTable } from "../scripts/classify-clusters.mts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "legacy-link-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function table(id: string, name: string, links: Array<{ targetId: string; name?: string }> = []): AirtableTable {
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

describe("computeSparseEdge", () => {
  test("returns sparse=true when no source records exist", () => {
    const r = computeSparseEdge([], "Link", 0.1);
    expect(r.sparse).toBe(true);
    expect(r.totalSourceRecords).toBe(0);
    expect(r.linkedCount).toBe(0);
    expect(r.sparseRatio).toBe(0);
  });

  test("returns sparse=true when fewer than threshold carry link", () => {
    const records = [
      record("r1", { Link: ["x"] }),
      ...Array.from({ length: 99 }, (_, i) => record(`r${i + 2}`)),
    ];
    const r = computeSparseEdge(records, "Link", 0.1);
    expect(r.linkedCount).toBe(1);
    expect(r.totalSourceRecords).toBe(100);
    expect(r.sparseRatio).toBeCloseTo(0.01);
    expect(r.sparse).toBe(true);
  });

  test("returns sparse=false when >= threshold carry link", () => {
    const records = [
      ...Array.from({ length: 20 }, (_, i) => record(`r${i + 1}`, { Link: [`t${i}`] })),
      ...Array.from({ length: 80 }, (_, i) => record(`r${i + 21}`)),
    ];
    const r = computeSparseEdge(records, "Link", 0.1);
    expect(r.linkedCount).toBe(20);
    expect(r.sparseRatio).toBeCloseTo(0.2);
    expect(r.sparse).toBe(false);
  });

  test("ignores empty array link values when counting", () => {
    const records = [
      record("r1", { Link: [] }),
      record("r2", { Link: ["x"] }),
    ];
    const r = computeSparseEdge(records, "Link", 0.6);
    expect(r.linkedCount).toBe(1);
    expect(r.sparseRatio).toBeCloseTo(0.5);
    expect(r.sparse).toBe(true);
  });

  test("threshold is strict less-than", () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      i === 0 ? record(`r${i}`, { Link: ["x"] }) : record(`r${i}`),
    );
    const r = computeSparseEdge(records, "Link", 0.1);
    expect(r.sparseRatio).toBeCloseTo(0.1);
    expect(r.sparse).toBe(false);
  });
});

describe("assessBrokenTarget", () => {
  test("zero records → empty + broken", () => {
    const r = assessBrokenTarget([]);
    expect(r.empty).toBe(true);
    expect(r.archived).toBe(false);
    expect(r.broken).toBe(true);
  });

  test("all records with no fields populated → empty", () => {
    const r = assessBrokenTarget([record("r1"), record("r2")]);
    expect(r.empty).toBe(true);
    expect(r.broken).toBe(true);
  });

  test("at least one populated field → not empty", () => {
    const r = assessBrokenTarget([record("r1", { Name: "alive" }), record("r2")]);
    expect(r.empty).toBe(false);
  });

  test("all records archived (Archived=true) → archived + broken", () => {
    const r = assessBrokenTarget([
      record("r1", { Name: "x", Archived: true }),
      record("r2", { Name: "y", Archived: true }),
    ]);
    expect(r.archived).toBe(true);
    expect(r.broken).toBe(true);
  });

  test("matches IsArchived field name pattern", () => {
    const r = assessBrokenTarget([
      record("r1", { Name: "x", IsArchived: 1 }),
      record("r2", { Name: "y", IsArchived: "yes" }),
    ]);
    expect(r.archived).toBe(true);
  });

  test("one live record breaks archived flag", () => {
    const r = assessBrokenTarget([
      record("r1", { Name: "x", Archived: true }),
      record("r2", { Name: "y" }),
    ]);
    expect(r.archived).toBe(false);
    expect(r.empty).toBe(false);
    expect(r.broken).toBe(false);
  });

  test("falsy archived value does not flag", () => {
    const r = assessBrokenTarget([
      record("r1", { Name: "x", Archived: false }),
      record("r2", { Name: "y", Archived: "" }),
    ]);
    expect(r.archived).toBe(false);
  });
});

describe("detectLegacyLinks (end-to-end)", () => {
  test("flags sparse + broken edge as legacy and prunes the graph", async () => {
    const tables = [
      table("tContacts", "Contacts", [{ targetId: "tArchive", name: "Old Archive" }]),
      table("tArchive", "Old Archive"),
    ];
    const contactsRecords = [
      record("c1", { Name: "alive1", "Old Archive": ["a1"] }),
      ...Array.from({ length: 99 }, (_, i) => record(`c${i + 2}`, { Name: `alive${i + 2}` })),
    ];
    const archiveRecords = [
      record("a1", { Name: "old1", Archived: true }),
      record("a2", { Name: "old2", Archived: true }),
    ];

    const { legacyEdges, edges, prunedClusters, metricsPath, cleanupPath } = await detectLegacyLinks(
      "appBase",
      {
        fetch: mockFetch({
          tables,
          recordsByTable: { tContacts: contactsRecords, tArchive: archiveRecords },
        }),
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "run-legacy",
      },
    );

    expect(edges).toHaveLength(1);
    expect(edges[0].sparse).toBe(true);
    expect(edges[0].targetArchived).toBe(true);
    expect(edges[0].broken).toBe(true);
    expect(edges[0].legacy).toBe(true);
    expect(legacyEdges).toHaveLength(1);

    expect(prunedClusters).toHaveLength(2);
    const clusterTables = prunedClusters.map((c) => c.table_ids.sort());
    expect(clusterTables).toContainEqual(["tContacts"]);
    expect(clusterTables).toContainEqual(["tArchive"]);

    expect(existsSync(metricsPath)).toBe(true);
    expect(existsSync(cleanupPath)).toBe(true);
    const metrics = JSON.parse(readFileSync(metricsPath, "utf8"));
    expect(metrics.base_id).toBe("appBase");
    expect(metrics.legacy_count).toBe(1);
    expect(metrics.sparse_threshold).toBeCloseTo(0.1);
    expect(metrics.edges).toHaveLength(1);
    expect(metrics.pruned_clusters).toHaveLength(2);

    const md = readFileSync(cleanupPath, "utf8");
    expect(md).toContain("Contacts");
    expect(md).toContain("Old Archive");
    expect(md).toContain("1 of 100");
  });

  test("dense link is not legacy even if target is broken", async () => {
    const tables = [
      table("tA", "A", [{ targetId: "tB", name: "Link" }]),
      table("tB", "B"),
    ];
    const aRecords = Array.from({ length: 10 }, (_, i) =>
      record(`a${i}`, { Name: `a${i}`, Link: [`b${i}`] }),
    );
    const bRecords: AirtableRecord[] = [];

    const { edges, legacyEdges, prunedClusters } = await detectLegacyLinks("appBase", {
      fetch: mockFetch({ tables, recordsByTable: { tA: aRecords, tB: bRecords } }),
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "run-dense",
    });

    expect(edges[0].sparse).toBe(false);
    expect(edges[0].broken).toBe(true);
    expect(edges[0].legacy).toBe(false);
    expect(legacyEdges).toHaveLength(0);
    expect(prunedClusters).toHaveLength(1);
  });

  test("sparse link is not legacy when target is healthy", async () => {
    const tables = [
      table("tA", "A", [{ targetId: "tB", name: "Link" }]),
      table("tB", "B"),
    ];
    const aRecords = [
      record("a1", { Name: "a1", Link: ["b1"] }),
      ...Array.from({ length: 99 }, (_, i) => record(`a${i + 2}`, { Name: `a${i + 2}` })),
    ];
    const bRecords = [
      record("b1", { Name: "b1" }),
      record("b2", { Name: "b2" }),
    ];

    const { edges, legacyEdges, prunedClusters } = await detectLegacyLinks("appBase", {
      fetch: mockFetch({ tables, recordsByTable: { tA: aRecords, tB: bRecords } }),
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "run-healthy-target",
    });

    expect(edges[0].sparse).toBe(true);
    expect(edges[0].broken).toBe(false);
    expect(edges[0].legacy).toBe(false);
    expect(legacyEdges).toHaveLength(0);
    expect(prunedClusters).toHaveLength(1);
  });

  test("sparseThreshold override flags otherwise-healthy edges", async () => {
    const tables = [
      table("tA", "A", [{ targetId: "tB", name: "Link" }]),
      table("tB", "B"),
    ];
    const aRecords = [
      ...Array.from({ length: 4 }, (_, i) => record(`a${i}`, { Name: `a${i}`, Link: ["x"] })),
      ...Array.from({ length: 96 }, (_, i) => record(`a${i + 4}`, { Name: `a${i + 4}` })),
    ];
    const bRecords: AirtableRecord[] = []; // empty target → broken

    const { edges } = await detectLegacyLinks("appBase", {
      fetch: mockFetch({ tables, recordsByTable: { tA: aRecords, tB: bRecords } }),
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "run-default-threshold",
    });
    expect(edges[0].sparseRatio).toBeCloseTo(0.04);
    expect(edges[0].sparse).toBe(true);
    expect(edges[0].legacy).toBe(true);

    const { edges: edges2, legacyEdges: legacy2 } = await detectLegacyLinks("appBase", {
      fetch: mockFetch({ tables, recordsByTable: { tA: aRecords, tB: bRecords } }),
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "run-tight-threshold",
      sparseThreshold: 0.01,
    });
    expect(edges2[0].sparse).toBe(false);
    expect(edges2[0].legacy).toBe(false);
    expect(legacy2).toHaveLength(0);

    const metrics = JSON.parse(
      readFileSync(join(tmp, "run-tight-threshold", "metrics", "legacy-links.json"), "utf8"),
    );
    expect(metrics.sparse_threshold).toBeCloseTo(0.01);
  });

  test("two-edge graph: prunes only the legacy edge, keeps healthy cluster intact", async () => {
    const tables = [
      table("tContacts", "Contacts", [
        { targetId: "tDeals", name: "Deal" },
        { targetId: "tArchive", name: "Archive" },
      ]),
      table("tDeals", "Deals"),
      table("tArchive", "Old Stuff"),
    ];
    const contactsRecords = Array.from({ length: 50 }, (_, i) =>
      record(`c${i}`, { Name: `c${i}`, Deal: [`d${i % 5}`] }),
    );
    contactsRecords[0].fields.Archive = ["x1"];
    const dealsRecords = Array.from({ length: 5 }, (_, i) => record(`d${i}`, { Name: `d${i}` }));
    const archiveRecords: AirtableRecord[] = [];

    const { edges, legacyEdges, prunedClusters } = await detectLegacyLinks("appBase", {
      fetch: mockFetch({
        tables,
        recordsByTable: { tContacts: contactsRecords, tDeals: dealsRecords, tArchive: archiveRecords },
      }),
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "run-mixed",
    });

    expect(edges).toHaveLength(2);
    expect(legacyEdges).toHaveLength(1);
    expect(legacyEdges[0].targetTableId).toBe("tArchive");

    const sizes = prunedClusters.map((c) => c.table_ids.length).sort();
    expect(sizes).toEqual([1, 2]);
    const cluster2 = prunedClusters.find((c) => c.table_ids.length === 2)!;
    expect(cluster2.table_ids.sort()).toEqual(["tContacts", "tDeals"]);
  });

  test("paginates Records API via offset", async () => {
    const tables = [table("tA", "A", [{ targetId: "tB", name: "Link" }]), table("tB", "B")];
    const aRecordsPage1 = Array.from({ length: 100 }, (_, i) => record(`a${i}`, { Name: `a${i}` }));
    const aRecordsPage2 = Array.from({ length: 50 }, (_, i) => record(`a${i + 100}`, { Name: `a${i + 100}` }));
    const bRecords = [record("b1", { Name: "b1" })];

    let aCalls = 0;
    const fetchImpl = async (url: string | URL): Promise<Response> => {
      const u = String(url);
      if (u.startsWith("https://api.airtable.com/v0/meta/bases/")) {
        return new Response(JSON.stringify({ tables }), { status: 200 });
      }
      if (u.includes("/v0/appBase/tA")) {
        aCalls++;
        if (!u.includes("offset=")) {
          return new Response(JSON.stringify({ records: aRecordsPage1, offset: "next-page" }), { status: 200 });
        }
        return new Response(JSON.stringify({ records: aRecordsPage2 }), { status: 200 });
      }
      return new Response(JSON.stringify({ records: bRecords }), { status: 200 });
    };

    const { edges } = await detectLegacyLinks("appBase", {
      fetch: fetchImpl,
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "run-paginated",
    });

    expect(aCalls).toBe(2);
    expect(edges[0].totalSourceRecords).toBe(150);
  });

  test("self-links are skipped", async () => {
    const tables = [table("tA", "A", [{ targetId: "tA", name: "SelfLink" }])];
    const aRecords = [record("r1")];
    const { edges } = await detectLegacyLinks("appBase", {
      fetch: mockFetch({ tables, recordsByTable: { tA: aRecords } }),
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "run-self",
    });
    expect(edges).toHaveLength(0);
  });

  test("zero edges produces empty outputs but still writes files", async () => {
    const tables = [table("tA", "A"), table("tB", "B")];
    const { edges, legacyEdges, prunedClusters, metricsPath, cleanupPath } = await detectLegacyLinks(
      "appBase",
      {
        fetch: mockFetch({ tables, recordsByTable: {} }),
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "run-empty",
      },
    );
    expect(edges).toHaveLength(0);
    expect(legacyEdges).toHaveLength(0);
    expect(prunedClusters).toHaveLength(2);
    expect(existsSync(metricsPath)).toBe(true);
    expect(existsSync(cleanupPath)).toBe(true);
    const md = readFileSync(cleanupPath, "utf8");
    expect(md).toContain("0 legacy");
  });

  test("writes metrics + cleanup at expected paths under runId", async () => {
    const tables = [table("tA", "A")];
    const { metricsPath, cleanupPath } = await detectLegacyLinks("appBaseXYZ", {
      fetch: mockFetch({ tables, recordsByTable: {} }),
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "run-paths",
    });
    expect(metricsPath).toBe(join(tmp, "run-paths", "metrics", "legacy-links.json"));
    expect(cleanupPath).toBe(join(tmp, "run-paths", "out", "airtable-cleanup-tasks.md"));
  });

  test("throws when Records API returns non-2xx", async () => {
    const tables = [table("tA", "A", [{ targetId: "tB", name: "Link" }]), table("tB", "B")];
    const fetchImpl = async (url: string | URL): Promise<Response> => {
      const u = String(url);
      if (u.startsWith("https://api.airtable.com/v0/meta/bases/")) {
        return new Response(JSON.stringify({ tables }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "denied" }), { status: 403 });
    };
    await expect(
      detectLegacyLinks("appBase", {
        fetch: fetchImpl,
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "run-403",
      }),
    ).rejects.toThrow(/Airtable Records.*403/);
  });

  test("throws when no token can be resolved", async () => {
    await expect(
      detectLegacyLinks("appBase", {
        fetch: mockFetch({ tables: [], recordsByTable: {} }),
        env: {},
        configPath: join(tmp, "no-such.json"),
        cacheDir: tmp,
        runId: "run-no-token",
      }),
    ).rejects.toThrow(/AIRTABLE_API_KEY/);
  });

  test("markdown groups recommendations per source table", async () => {
    const tables = [
      table("tA", "Source A", [{ targetId: "tArchive1", name: "Stale1" }, { targetId: "tArchive2", name: "Stale2" }]),
      table("tArchive1", "Old1"),
      table("tArchive2", "Old2"),
    ];
    const aRecords = Array.from({ length: 100 }, (_, i) => record(`a${i}`, { Name: `a${i}` }));
    aRecords[0].fields.Stale1 = ["x"];
    aRecords[0].fields.Stale2 = ["y"];

    const { cleanupPath } = await detectLegacyLinks("appBase", {
      fetch: mockFetch({ tables, recordsByTable: { tA: aRecords, tArchive1: [], tArchive2: [] } }),
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "run-grouped",
    });
    const md = readFileSync(cleanupPath, "utf8");
    expect(md).toContain("Source A");
    expect(md).toContain("Stale1");
    expect(md).toContain("Stale2");
    expect(md).toContain("Old1");
    expect(md).toContain("Old2");
  });
});
