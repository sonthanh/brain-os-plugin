import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyClusterShapes,
  classifyShape,
  type ClusterShape,
} from "../scripts/cluster-classifier.mts";
import type { AirtableTable } from "../scripts/classify-clusters.mts";

interface FixtureEntry {
  name: string;
  expected_shape: ClusterShape;
  expected_size: number;
  tables: AirtableTable[];
}

const fixturesPath = join(
  import.meta.dir,
  "fixtures",
  "cluster-shapes-synthetic.json",
);
const fixtureFile: { fixtures: FixtureEntry[] } = JSON.parse(
  readFileSync(fixturesPath, "utf8"),
);

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cluster-classifier-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function ok(tables: AirtableTable[]) {
  return async () =>
    new Response(JSON.stringify({ tables }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

describe("classifyShape — pure function over (size, edges, degrees)", () => {
  test("orphan: single isolated node", () => {
    expect(classifyShape({ size: 1, edges: 0, maxDegree: 0 })).toBe("orphan");
  });

  test("pair: two nodes with one edge", () => {
    expect(classifyShape({ size: 2, edges: 1, maxDegree: 1 })).toBe("pair");
  });

  test("chain: 5-node path graph (max degree 2)", () => {
    expect(classifyShape({ size: 5, edges: 4, maxDegree: 2 })).toBe("chain");
  });

  test("hub-spoke: 5-node star (max degree N-1)", () => {
    expect(classifyShape({ size: 5, edges: 4, maxDegree: 4 })).toBe(
      "hub-spoke",
    );
  });

  test("tree: 6-node Y-shape (max degree 3, but not N-1=5)", () => {
    expect(classifyShape({ size: 6, edges: 5, maxDegree: 3 })).toBe("tree");
  });

  test("graph: 4-cycle (E > N - 1)", () => {
    expect(classifyShape({ size: 4, edges: 4, maxDegree: 2 })).toBe("graph");
  });

  test("graph: dense — all-to-all 4 nodes (K4)", () => {
    expect(classifyShape({ size: 4, edges: 6, maxDegree: 3 })).toBe("graph");
  });

  test("3-node tree resolves to hub-spoke (path and star are isomorphic at N=3; middle is the natural anchor)", () => {
    // Both A-B-C (path) and A-B, A-C (star) have size=3, edges=2, maxDegree=2.
    // maxDegree == N-1, so hub-spoke wins — matches the empirical research
    // baseline (Staronline Finance, 3-table component, called "hub-spoke").
    expect(classifyShape({ size: 3, edges: 2, maxDegree: 2 })).toBe(
      "hub-spoke",
    );
  });
});

describe("classifyClusterShapes — fixture-driven (one per shape)", () => {
  for (const fx of fixtureFile.fixtures) {
    test(`fixture "${fx.name}" → shape=${fx.expected_shape}, size=${fx.expected_size}`, async () => {
      const { components } = await classifyClusterShapes("appBase", {
        fetch: ok(fx.tables),
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: `run-${fx.name}`,
      });
      expect(components).toHaveLength(1);
      expect(components[0].shape).toBe(fx.expected_shape);
      expect(components[0].size).toBe(fx.expected_size);
      expect(components[0].tables.sort()).toEqual(
        fx.tables.map((t) => t.id).sort(),
      );
    });
  }
});

describe("classifyClusterShapes — multi-component bases", () => {
  test("orphan + pair + chain coexist as three separate components", async () => {
    const tables: AirtableTable[] = [
      // orphan: tX
      { id: "tX", name: "Lone", fields: [] },
      // pair: tP1—tP2
      {
        id: "tP1",
        name: "P1",
        fields: [
          {
            id: "fP",
            name: "to",
            type: "multipleRecordLinks",
            options: { linkedTableId: "tP2" },
          },
        ],
      },
      { id: "tP2", name: "P2", fields: [] },
      // chain: tC1-tC2-tC3-tC4 (N=4 path; N>=4 needed since N=3 trees are
      // hub-spoke per the algorithm's N=3-degenerate handling).
      {
        id: "tC1",
        name: "C1",
        fields: [
          {
            id: "fC1",
            name: "to",
            type: "multipleRecordLinks",
            options: { linkedTableId: "tC2" },
          },
        ],
      },
      {
        id: "tC2",
        name: "C2",
        fields: [
          {
            id: "fC2",
            name: "to",
            type: "multipleRecordLinks",
            options: { linkedTableId: "tC3" },
          },
        ],
      },
      {
        id: "tC3",
        name: "C3",
        fields: [
          {
            id: "fC3",
            name: "to",
            type: "multipleRecordLinks",
            options: { linkedTableId: "tC4" },
          },
        ],
      },
      { id: "tC4", name: "C4", fields: [] },
    ];

    const { components } = await classifyClusterShapes("appBase", {
      fetch: ok(tables),
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "run-mixed",
    });

    const shapesBySize = components
      .map((c) => ({ size: c.size, shape: c.shape }))
      .sort((a, b) => a.size - b.size);
    expect(shapesBySize).toEqual([
      { size: 1, shape: "orphan" },
      { size: 2, shape: "pair" },
      { size: 4, shape: "chain" },
    ]);
  });

  test("operates on FULL graph regardless of Stage 0 type (no entity/interaction filter)", async () => {
    // Mix an "interaction-named" table with entity-named ones — classifier must
    // include them all in the component analysis (per AC#3).
    const tables: AirtableTable[] = [
      {
        id: "tCust",
        name: "Customers",
        fields: [
          {
            id: "fCP",
            name: "payments",
            type: "multipleRecordLinks",
            options: { linkedTableId: "tPay" },
          },
        ],
      },
      // "Payments" is an interaction table per Stage 0 — classifier ignores type
      { id: "tPay", name: "Payments", fields: [] },
    ];

    const { components } = await classifyClusterShapes("appBase", {
      fetch: ok(tables),
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "run-full-graph",
    });
    expect(components).toHaveLength(1);
    expect(components[0].size).toBe(2);
    expect(components[0].shape).toBe("pair");
    expect(components[0].tables.sort()).toEqual(["tCust", "tPay"]);
  });
});

describe("classifyClusterShapes — output shape + persistence", () => {
  test("output items have { component_id, tables, shape, size }", async () => {
    const tables: AirtableTable[] = [
      { id: "tA", name: "A", fields: [] },
      { id: "tB", name: "B", fields: [] },
    ];
    const { components } = await classifyClusterShapes("appBase", {
      fetch: ok(tables),
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "run-shape",
    });
    expect(components).toHaveLength(2);
    for (const c of components) {
      expect(c).toHaveProperty("component_id");
      expect(c).toHaveProperty("tables");
      expect(c).toHaveProperty("shape");
      expect(c).toHaveProperty("size");
      expect(typeof c.component_id).toBe("string");
      expect(Array.isArray(c.tables)).toBe(true);
      expect(typeof c.shape).toBe("string");
      expect(c.size).toBe(c.tables.length);
    }
  });

  test("writes cluster-shapes-<base-id>.json under run-id cache dir", async () => {
    const tables: AirtableTable[] = [
      { id: "tA", name: "A", fields: [] },
    ];
    const { cachePath } = await classifyClusterShapes("appBaseXYZ", {
      fetch: ok(tables),
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "run-cache",
    });
    const expected = join(tmp, "run-cache", "cluster-shapes-appBaseXYZ.json");
    expect(cachePath).toBe(expected);
    expect(existsSync(expected)).toBe(true);
    const cached = JSON.parse(readFileSync(expected, "utf8"));
    expect(cached).toHaveLength(1);
    expect(cached[0].shape).toBe("orphan");
    expect(cached[0].component_id).toBeDefined();
  });
});

/**
 * Live API smoke for AC#6 ("for the 5 tested bases"). Asserts the per-base
 * shape histogram matches the empirical baseline established in the parent
 * story's research report (vault path:
 * `knowledge/research/reports/2026-05-03-airtable-schema-driven-extraction-
 * dispatch.md`). Gate: `AIRTABLE_CLUSTER_CLASSIFIER_LIVE=1` AND a valid
 * `AIRTABLE_API_KEY` (or `AIRTABLE_TOKEN`). Skipped silently in CI / when
 * the token is absent — matches the gating pattern in `tests/integration.test.ts`.
 *
 * Bases referenced by ID only — names live in the private vault. If a base's
 * schema drifts (Airtable allows users to add/remove tables ad-hoc), update
 * the expected histogram here AND the research report so the baseline stays
 * in sync. Drift is signal, not noise.
 */
const LIVE_GATE =
  process.env.AIRTABLE_CLUSTER_CLASSIFIER_LIVE === "1" &&
  Boolean(process.env.AIRTABLE_API_KEY ?? process.env.AIRTABLE_TOKEN);

const LIVE_BASES: Array<{
  id: string;
  expectedShapes: Record<ClusterShape, number>;
  expectedTotalTables: number;
}> = [
  {
    id: "appUV3hAWcRzrGjqK",
    expectedShapes: { "hub-spoke": 1, orphan: 0, pair: 0, chain: 0, tree: 0, graph: 0 },
    expectedTotalTables: 3,
  },
  {
    id: "appnnIAYi5uKAbcAl",
    expectedShapes: { graph: 1, orphan: 3, pair: 1, "hub-spoke": 0, chain: 0, tree: 0 },
    expectedTotalTables: 24,
  },
  {
    id: "appOc2kWtEk4g1EPO",
    expectedShapes: { graph: 1, orphan: 12, pair: 1, "hub-spoke": 0, chain: 0, tree: 0 },
    expectedTotalTables: 43,
  },
  {
    id: "appYz4hd2utmyJjUm",
    expectedShapes: { orphan: 4, "hub-spoke": 0, pair: 0, chain: 0, tree: 0, graph: 0 },
    expectedTotalTables: 4,
  },
  {
    id: "apptXjS5cu6l3F3Oh",
    expectedShapes: { orphan: 5, "hub-spoke": 0, pair: 0, chain: 0, tree: 0, graph: 0 },
    expectedTotalTables: 5,
  },
];

describe("classifyClusterShapes — live API on the 5 tested bases (AC#6)", () => {
  if (!LIVE_GATE) {
    test.skip("[live AC#6 smoke] SKIPPED: set AIRTABLE_CLUSTER_CLASSIFIER_LIVE=1 + AIRTABLE_API_KEY to run.", () => {});
    return;
  }

  for (const base of LIVE_BASES) {
    test(`base ${base.id} shape histogram matches research baseline`, async () => {
      const { components } = await classifyClusterShapes(base.id, {
        cacheDir: tmp,
        runId: `live-${base.id}`,
      });
      const totalTables = components.reduce((s, c) => s + c.size, 0);
      expect(totalTables).toBe(base.expectedTotalTables);

      const histogram: Record<ClusterShape, number> = {
        orphan: 0, pair: 0, chain: 0, tree: 0, "hub-spoke": 0, graph: 0,
      };
      for (const c of components) histogram[c.shape]++;
      expect(histogram).toEqual(base.expectedShapes);
    }, 30_000);
  }
});

describe("classifyClusterShapes — error paths", () => {
  test("throws on Meta API non-2xx", async () => {
    await expect(
      classifyClusterShapes("appBase", {
        fetch: async () =>
          new Response(JSON.stringify({ error: "denied" }), { status: 403 }),
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "run-403",
      }),
    ).rejects.toThrow(/Airtable.*403/);
  });

  test("throws when no AIRTABLE_API_KEY can be resolved", async () => {
    await expect(
      classifyClusterShapes("appBase", {
        fetch: ok([]),
        env: {},
        configPath: join(tmp, "no-such.json"),
        cacheDir: tmp,
        runId: "run-no-token",
      }),
    ).rejects.toThrow(/AIRTABLE_API_KEY/);
  });
});
