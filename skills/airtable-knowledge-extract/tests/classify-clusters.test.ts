import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyClusters,
  buildLinkGraph,
  findComponents,
  type AirtableTable,
} from "../scripts/classify-clusters.mts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "classify-clusters-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function table(id: string, name: string, links: string[] = []): AirtableTable {
  return {
    id,
    name,
    fields: [
      { id: `${id}-pk`, name: "Name", type: "singleLineText" },
      ...links.map((targetId, i) => ({
        id: `${id}-link${i}`,
        name: `Link${i}`,
        type: "multipleRecordLinks",
        options: { linkedTableId: targetId },
      })),
    ],
  };
}

function ok(tables: AirtableTable[]) {
  return async () =>
    new Response(JSON.stringify({ tables }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

describe("buildLinkGraph", () => {
  test("creates undirected adjacency from multipleRecordLinks fields", () => {
    const tables = [
      table("t1", "A", ["t2"]),
      table("t2", "B"),
    ];
    const adj = buildLinkGraph(tables);
    expect([...(adj.get("t1") ?? [])]).toEqual(["t2"]);
    expect([...(adj.get("t2") ?? [])]).toEqual(["t1"]);
  });

  test("ignores self-links", () => {
    const tables = [table("t1", "A", ["t1"])];
    const adj = buildLinkGraph(tables);
    expect(adj.get("t1")?.size).toBe(0);
  });

  test("ignores non-link field types", () => {
    const tables: AirtableTable[] = [
      {
        id: "t1",
        name: "A",
        fields: [
          { id: "f1", name: "Lookup", type: "multipleLookupValues", options: { linkedTableId: "t2" } },
        ],
      },
      table("t2", "B"),
    ];
    const adj = buildLinkGraph(tables);
    expect(adj.get("t1")?.size).toBe(0);
    expect(adj.get("t2")?.size).toBe(0);
  });
});

describe("findComponents", () => {
  test("single connected component for 5-table 4-link chain", () => {
    const tables = [
      table("t1", "A", ["t2"]),
      table("t2", "B", ["t3"]),
      table("t3", "C", ["t4"]),
      table("t4", "D", ["t5"]),
      table("t5", "E"),
    ];
    const comps = findComponents(buildLinkGraph(tables));
    expect(comps).toHaveLength(1);
    expect(comps[0].sort()).toEqual(["t1", "t2", "t3", "t4", "t5"]);
  });

  test("two disjoint components", () => {
    const tables = [
      table("t1", "A", ["t2"]),
      table("t2", "B"),
      table("t3", "C", ["t4"]),
      table("t4", "D"),
    ];
    const comps = findComponents(buildLinkGraph(tables));
    expect(comps).toHaveLength(2);
    expect(comps.map((c) => c.sort())).toEqual([
      ["t1", "t2"],
      ["t3", "t4"],
    ]);
  });

  test("fully linked 4-table cluster is one component", () => {
    const tables = [
      table("t1", "A", ["t2", "t3", "t4"]),
      table("t2", "B", ["t3", "t4"]),
      table("t3", "C", ["t4"]),
      table("t4", "D"),
    ];
    const comps = findComponents(buildLinkGraph(tables));
    expect(comps).toHaveLength(1);
    expect(comps[0].sort()).toEqual(["t1", "t2", "t3", "t4"]);
  });
});

describe("classifyClusters (end-to-end)", () => {
  test("classifies CRM cluster from 5-table 4-link chain by majority vote", async () => {
    const tables = [
      table("t1", "Contacts", ["t2"]),
      table("t2", "Companies", ["t3"]),
      table("t3", "Deals", ["t4"]),
      table("t4", "Notes", ["t5"]),
      table("t5", "Tasks"),
    ];
    const { clusters } = await classifyClusters("appBase", {
      fetch: ok(tables),
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "run-crm",
    });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].type).toBe("crm");
    expect(clusters[0].table_ids.sort()).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    expect(["t1", "t2", "t3"]).toContain(clusters[0].dominant_table);
  });

  test("classifies two disjoint clusters separately (crm + project)", async () => {
    const tables = [
      table("t1", "Contacts", ["t2"]),
      table("t2", "Companies"),
      table("t3", "Projects", ["t4"]),
      table("t4", "Tasks"),
    ];
    const { clusters } = await classifyClusters("appBase", {
      fetch: ok(tables),
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "run-disjoint",
    });
    expect(clusters).toHaveLength(2);
    const types = clusters.map((c) => c.type).sort();
    expect(types).toEqual(["crm", "project"]);
  });

  test("classifies fully-linked OKR cluster", async () => {
    const tables = [
      table("t1", "Objectives", ["t2", "t3"]),
      table("t2", "Key Results", ["t3"]),
      table("t3", "OKRs"),
    ];
    const { clusters } = await classifyClusters("appBase", {
      fetch: ok(tables),
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "run-okr",
    });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].type).toBe("okr");
    expect(clusters[0].table_ids).toHaveLength(3);
  });

  test("single-table no-link cluster is orphan", async () => {
    const tables = [table("t1", "Random Stuff")];
    const { clusters } = await classifyClusters("appBase", {
      fetch: ok(tables),
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "run-orphan",
    });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].type).toBe("orphan");
    expect(clusters[0].dominant_table).toBe("t1");
  });

  test("cluster with no name signal is orphan even when multi-table", async () => {
    const tables = [
      table("t1", "Foo", ["t2"]),
      table("t2", "Bar"),
    ];
    const { clusters } = await classifyClusters("appBase", {
      fetch: ok(tables),
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "run-orphan-multi",
    });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].type).toBe("orphan");
  });

  test("dominant_table picks highest-degree matching table", async () => {
    const tables = [
      table("t1", "Contacts", ["t2", "t3", "t4"]),
      table("t2", "Companies", ["t3"]),
      table("t3", "Deals"),
      table("t4", "Customers"),
    ];
    const { clusters } = await classifyClusters("appBase", {
      fetch: ok(tables),
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "run-dominant",
    });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].dominant_table).toBe("t1");
  });

  test("writes clusters-<base-id>.json to cache dir under run-id", async () => {
    const tables = [table("t1", "Contacts", ["t2"]), table("t2", "Deals")];
    const { cachePath } = await classifyClusters("appBaseXYZ", {
      fetch: ok(tables),
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "run-cache",
    });
    const expected = join(tmp, "run-cache", "clusters-appBaseXYZ.json");
    expect(cachePath).toBe(expected);
    expect(existsSync(expected)).toBe(true);
    const cached = JSON.parse(readFileSync(expected, "utf8"));
    expect(cached).toHaveLength(1);
    expect(cached[0].type).toBe("crm");
  });

  test("decision and knowledge-note types resolve correctly", async () => {
    const tables = [
      table("t1", "Decisions", ["t2"]),
      table("t2", "ADR Log"),
      table("t3", "Notes", ["t4"]),
      table("t4", "Wiki Articles"),
    ];
    const { clusters } = await classifyClusters("appBase", {
      fetch: ok(tables),
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "run-misc",
    });
    expect(clusters).toHaveLength(2);
    const types = clusters.map((c) => c.type).sort();
    expect(types).toEqual(["decision", "knowledge-note"]);
  });

  test("requires base-id and threads bearer token through Meta API URL", async () => {
    let capturedUrl = "";
    let capturedAuth = "";
    await classifyClusters("appBaseToken", {
      fetch: async (url: string | URL, init?: RequestInit) => {
        capturedUrl = String(url);
        capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
        return new Response(JSON.stringify({ tables: [] }), { status: 200 });
      },
      env: { AIRTABLE_API_KEY: "patFake.token" },
      cacheDir: tmp,
      runId: "run-token",
    });
    expect(capturedUrl).toBe(
      "https://api.airtable.com/v0/meta/bases/appBaseToken/tables",
    );
    expect(capturedAuth).toBe("Bearer patFake.token");
  });

  test("throws when Meta API returns non-2xx", async () => {
    await expect(
      classifyClusters("appBase", {
        fetch: async () =>
          new Response(JSON.stringify({ error: "denied" }), { status: 403 }),
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "run-403",
      }),
    ).rejects.toThrow(/Airtable.*403/);
  });

  test("throws when no token can be resolved", async () => {
    await expect(
      classifyClusters("appBase", {
        fetch: ok([]),
        env: {},
        configPath: join(tmp, "no-such.json"),
        cacheDir: tmp,
        runId: "run-no-token",
      }),
    ).rejects.toThrow(/AIRTABLE_API_KEY/);
  });
});
