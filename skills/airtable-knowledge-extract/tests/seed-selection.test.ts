import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  seedSelection,
  rankSeedRecords,
  computeConnectivity,
  isArchived,
  isEmpty,
  resolveUpdatedAt,
  type SeedRecord,
  type AirtableTable,
  type AirtableRecord,
  type Cluster,
} from "../scripts/seed-selection.mts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "seed-selection-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function syntheticTwentyRows(): SeedRecord[] {
  const conns = [12, 9, 9, 8, 7, 7, 7, 6, 6, 5, 5, 4, 4, 3, 3, 2, 2, 1, 1, 0];
  const rows: SeedRecord[] = [];
  for (let i = 0; i < 20; i++) {
    rows.push({
      id: `rec${String(i + 1).padStart(2, "0")}`,
      tableId: "t1",
      connectivity: conns[i],
      updatedAt: `2026-04-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    });
  }
  return rows;
}

describe("rankSeedRecords (synthetic 20-row fixture)", () => {
  test("returns top 10 by connectivity descending (default N)", () => {
    const ranked = rankSeedRecords(syntheticTwentyRows(), 10);
    expect(ranked).toHaveLength(10);
    expect(ranked[0].connectivity).toBe(12);
    expect(ranked[ranked.length - 1].connectivity).toBe(5);
    const conns = ranked.map((r) => r.connectivity);
    for (let i = 1; i < conns.length; i++) {
      expect(conns[i]).toBeLessThanOrEqual(conns[i - 1]);
    }
  });

  test("connectivity tie broken by updatedAt descending (most-recent wins)", () => {
    const ranked = rankSeedRecords(syntheticTwentyRows(), 10);
    const ties = ranked.filter((r) => r.connectivity === 9);
    expect(ties).toHaveLength(2);
    expect(ties[0].id).toBe("rec03");
    expect(ties[1].id).toBe("rec02");
  });

  test("respects n parameter (smaller and larger than fixture)", () => {
    expect(rankSeedRecords(syntheticTwentyRows(), 5)).toHaveLength(5);
    expect(rankSeedRecords(syntheticTwentyRows(), 25)).toHaveLength(20);
  });

  test("stable ordering when connectivity and updatedAt both tie", () => {
    const rows: SeedRecord[] = [
      { id: "recB", tableId: "t1", connectivity: 5, updatedAt: "2026-01-01T00:00:00Z" },
      { id: "recA", tableId: "t1", connectivity: 5, updatedAt: "2026-01-01T00:00:00Z" },
    ];
    const ranked = rankSeedRecords(rows, 2);
    expect(ranked.map((r) => r.id)).toEqual(["recA", "recB"]);
  });

  test("empty input returns empty list", () => {
    expect(rankSeedRecords([], 10)).toEqual([]);
  });
});

describe("computeConnectivity", () => {
  test("counts populated multipleRecordLinks fields only", () => {
    const rec: AirtableRecord = {
      id: "r1",
      createdTime: "2026-01-01T00:00:00Z",
      fields: {
        Companies: ["recA"],
        Deals: ["recB", "recC"],
        EmptyLink: [],
        Notes: "string field, ignored",
      },
    };
    expect(computeConnectivity(rec, ["Companies", "Deals", "EmptyLink"])).toBe(2);
  });

  test("returns 0 when no link fields are populated", () => {
    const rec: AirtableRecord = {
      id: "r1",
      createdTime: "2026-01-01T00:00:00Z",
      fields: { Name: "x" },
    };
    expect(computeConnectivity(rec, ["Companies"])).toBe(0);
  });

  test("returns 0 when no link field names provided", () => {
    const rec: AirtableRecord = {
      id: "r1",
      createdTime: "2026-01-01T00:00:00Z",
      fields: { Companies: ["x"] },
    };
    expect(computeConnectivity(rec, [])).toBe(0);
  });
});

describe("isEmpty / isArchived", () => {
  const empty: AirtableRecord = {
    id: "r1",
    createdTime: "2026-01-01T00:00:00Z",
    fields: {},
  };
  const archivedTrue: AirtableRecord = {
    id: "r2",
    createdTime: "2026-01-01T00:00:00Z",
    fields: { Archived: true },
  };
  const archivedFalse: AirtableRecord = {
    id: "r3",
    createdTime: "2026-01-01T00:00:00Z",
    fields: { Archived: false, Name: "alive" },
  };
  const live: AirtableRecord = {
    id: "r4",
    createdTime: "2026-01-01T00:00:00Z",
    fields: { Name: "alive" },
  };

  test("isEmpty true only when fields object empty", () => {
    expect(isEmpty(empty)).toBe(true);
    expect(isEmpty(live)).toBe(false);
  });

  test("isArchived true on truthy Archived field", () => {
    expect(isArchived(archivedTrue, ["Archived"])).toBe(true);
    expect(isArchived(archivedFalse, ["Archived"])).toBe(false);
    expect(isArchived(live, ["Archived"])).toBe(false);
  });

  test("isArchived honors multiple field name variants", () => {
    const rec: AirtableRecord = {
      id: "r5",
      createdTime: "2026-01-01T00:00:00Z",
      fields: { archived: 1 },
    };
    expect(isArchived(rec, ["Archived", "archived"])).toBe(true);
  });
});

describe("resolveUpdatedAt", () => {
  test("uses lastModifiedFieldName value when present and string", () => {
    const rec: AirtableRecord = {
      id: "r1",
      createdTime: "2026-01-01T00:00:00Z",
      fields: { LastModified: "2026-04-15T00:00:00Z" },
    };
    expect(resolveUpdatedAt(rec, "LastModified")).toBe("2026-04-15T00:00:00Z");
  });

  test("falls back to createdTime when last-modified field absent", () => {
    const rec: AirtableRecord = {
      id: "r1",
      createdTime: "2026-01-01T00:00:00Z",
      fields: {},
    };
    expect(resolveUpdatedAt(rec, "LastModified")).toBe("2026-01-01T00:00:00Z");
  });

  test("falls back to createdTime when no field name provided", () => {
    const rec: AirtableRecord = {
      id: "r1",
      createdTime: "2026-01-01T00:00:00Z",
      fields: {},
    };
    expect(resolveUpdatedAt(rec)).toBe("2026-01-01T00:00:00Z");
  });
});

describe("seedSelection (end-to-end)", () => {
  function writeClusterCache(cluster: Cluster, baseId: string, runId: string) {
    const dir = join(tmp, runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `clusters-${baseId}.json`),
      JSON.stringify([cluster], null, 2),
    );
  }

  function makeFetch(
    tables: AirtableTable[],
    recordsByTable: Record<string, AirtableRecord[]>,
  ) {
    return async (input: string | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/meta/bases/")) {
        return new Response(JSON.stringify({ tables }), { status: 200 });
      }
      const m = url.match(/\/v0\/[^/]+\/([^/?]+)/);
      const tableId = m ? m[1] : "";
      const records = recordsByTable[tableId] ?? [];
      return new Response(JSON.stringify({ records }), { status: 200 });
    };
  }

  test("ranks seeds across cluster tables and writes cache file", async () => {
    const tables: AirtableTable[] = [
      {
        id: "tCompanies",
        name: "Companies",
        fields: [
          { id: "f1", name: "Name", type: "singleLineText" },
          {
            id: "f2",
            name: "Deals",
            type: "multipleRecordLinks",
            options: { linkedTableId: "tDeals" },
          },
          {
            id: "f3",
            name: "Contacts",
            type: "multipleRecordLinks",
            options: { linkedTableId: "tContacts" },
          },
          { id: "f4", name: "LastMod", type: "lastModifiedTime" },
        ],
      },
      {
        id: "tDeals",
        name: "Deals",
        fields: [
          { id: "g1", name: "Name", type: "singleLineText" },
          {
            id: "g2",
            name: "Companies",
            type: "multipleRecordLinks",
            options: { linkedTableId: "tCompanies" },
          },
        ],
      },
      {
        id: "tContacts",
        name: "Contacts",
        fields: [{ id: "h1", name: "Name", type: "singleLineText" }],
      },
    ];
    writeClusterCache(
      {
        cluster_id: "cluster-1",
        table_ids: ["tCompanies", "tDeals"],
        type: "crm",
        dominant_table: "tCompanies",
      },
      "appBase",
      "run-1",
    );

    const recordsByTable: Record<string, AirtableRecord[]> = {
      tCompanies: [
        {
          id: "recHigh",
          createdTime: "2026-01-01T00:00:00Z",
          fields: {
            Name: "Acme",
            Deals: ["d1", "d2"],
            Contacts: ["c1"],
            LastMod: "2026-04-15T00:00:00Z",
          },
        },
        {
          id: "recArchived",
          createdTime: "2026-01-01T00:00:00Z",
          fields: { Name: "Old", Archived: true, Deals: ["d3"] },
        },
        {
          id: "recEmpty",
          createdTime: "2026-01-01T00:00:00Z",
          fields: {},
        },
      ],
      tDeals: [
        {
          id: "recDeal",
          createdTime: "2026-01-01T00:00:00Z",
          fields: { Name: "D1", Companies: ["recHigh"] },
        },
      ],
    };

    const { seeds, cachePath } = await seedSelection("appBase", "cluster-1", {
      fetch: makeFetch(tables, recordsByTable),
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "run-1",
    });

    expect(seeds.map((s) => s.id)).toEqual(["recHigh", "recDeal"]);
    expect(seeds[0].connectivity).toBe(2);
    expect(seeds[0].updatedAt).toBe("2026-04-15T00:00:00Z");
    expect(seeds[0].tableId).toBe("tCompanies");
    expect(seeds[1].connectivity).toBe(1);
    expect(seeds[1].updatedAt).toBe("2026-01-01T00:00:00Z");
    expect(seeds[1].tableId).toBe("tDeals");

    const expected = join(tmp, "run-1", "seed-records-appBase-cluster-1.json");
    expect(cachePath).toBe(expected);
    expect(existsSync(expected)).toBe(true);
    expect(JSON.parse(readFileSync(expected, "utf8"))).toEqual(seeds);
  });

  test("respects n option", async () => {
    const tables: AirtableTable[] = [
      {
        id: "tA",
        name: "A",
        fields: [
          {
            id: "f1",
            name: "Link",
            type: "multipleRecordLinks",
            options: { linkedTableId: "tB" },
          },
        ],
      },
    ];
    const records: AirtableRecord[] = [];
    for (let i = 0; i < 15; i++) {
      records.push({
        id: `rec${i}`,
        createdTime: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
        fields: { Link: ["x"] },
      });
    }
    writeClusterCache(
      {
        cluster_id: "cluster-1",
        table_ids: ["tA"],
        type: "orphan",
        dominant_table: "tA",
      },
      "appBase",
      "run-2",
    );
    const { seeds } = await seedSelection("appBase", "cluster-1", {
      fetch: makeFetch(tables, { tA: records }),
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "run-2",
      n: 5,
    });
    expect(seeds).toHaveLength(5);
  });

  test("excludes empty + archived rows", async () => {
    const tables: AirtableTable[] = [
      {
        id: "tA",
        name: "A",
        fields: [
          {
            id: "f1",
            name: "Link",
            type: "multipleRecordLinks",
            options: { linkedTableId: "tB" },
          },
        ],
      },
    ];
    const records: AirtableRecord[] = [
      {
        id: "rA",
        createdTime: "2026-01-01T00:00:00Z",
        fields: { Link: ["x"] },
      },
      {
        id: "rEmpty",
        createdTime: "2026-01-01T00:00:00Z",
        fields: {},
      },
      {
        id: "rArchived",
        createdTime: "2026-01-01T00:00:00Z",
        fields: { Archived: true, Link: ["y"] },
      },
    ];
    writeClusterCache(
      {
        cluster_id: "cluster-1",
        table_ids: ["tA"],
        type: "orphan",
        dominant_table: "tA",
      },
      "appBase",
      "run-3",
    );
    const { seeds } = await seedSelection("appBase", "cluster-1", {
      fetch: makeFetch(tables, { tA: records }),
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "run-3",
    });
    expect(seeds.map((s) => s.id)).toEqual(["rA"]);
  });

  test("paginates Records API via offset cursor", async () => {
    const tables: AirtableTable[] = [
      {
        id: "tA",
        name: "A",
        fields: [
          {
            id: "f1",
            name: "Link",
            type: "multipleRecordLinks",
            options: { linkedTableId: "tB" },
          },
        ],
      },
    ];
    writeClusterCache(
      {
        cluster_id: "cluster-1",
        table_ids: ["tA"],
        type: "orphan",
        dominant_table: "tA",
      },
      "appBase",
      "run-pg",
    );
    let recordPages = 0;
    const fetchImpl = async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/meta/bases/")) {
        return new Response(JSON.stringify({ tables }), { status: 200 });
      }
      recordPages++;
      if (recordPages === 1) {
        return new Response(
          JSON.stringify({
            records: [
              {
                id: "p1",
                createdTime: "2026-01-01T00:00:00Z",
                fields: { Link: ["x"] },
              },
            ],
            offset: "tok2",
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          records: [
            {
              id: "p2",
              createdTime: "2026-01-02T00:00:00Z",
              fields: { Link: ["x", "y"] },
            },
          ],
        }),
        { status: 200 },
      );
    };
    const { seeds } = await seedSelection("appBase", "cluster-1", {
      fetch: fetchImpl,
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "run-pg",
    });
    expect(seeds.map((s) => s.id)).toEqual(["p2", "p1"]);
    expect(recordPages).toBe(2);
  });

  test("throws when runId missing", async () => {
    await expect(
      seedSelection("appBase", "cluster-1", {
        fetch: makeFetch([], {}),
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
      }),
    ).rejects.toThrow(/runId required/);
  });

  test("throws when cluster cache file missing", async () => {
    await expect(
      seedSelection("appBaseMissing", "cluster-1", {
        fetch: makeFetch([], {}),
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "no-such-run",
      }),
    ).rejects.toThrow(/Cluster cache not found/);
  });

  test("throws when cluster id not in cache", async () => {
    writeClusterCache(
      {
        cluster_id: "cluster-1",
        table_ids: ["tA"],
        type: "orphan",
        dominant_table: "tA",
      },
      "appBase",
      "run-x",
    );
    await expect(
      seedSelection("appBase", "cluster-99", {
        fetch: makeFetch([], {}),
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "run-x",
      }),
    ).rejects.toThrow(/Cluster cluster-99 not found/);
  });

  test("throws when Records API returns non-2xx", async () => {
    const tables: AirtableTable[] = [
      {
        id: "tA",
        name: "A",
        fields: [
          {
            id: "f1",
            name: "Link",
            type: "multipleRecordLinks",
            options: { linkedTableId: "tB" },
          },
        ],
      },
    ];
    writeClusterCache(
      {
        cluster_id: "cluster-1",
        table_ids: ["tA"],
        type: "orphan",
        dominant_table: "tA",
      },
      "appBase",
      "run-403",
    );
    const fetchImpl = async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/meta/bases/")) {
        return new Response(JSON.stringify({ tables }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "denied" }), { status: 403 });
    };
    await expect(
      seedSelection("appBase", "cluster-1", {
        fetch: fetchImpl,
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "run-403",
      }),
    ).rejects.toThrow(/Airtable Records API.*403/);
  });
});
