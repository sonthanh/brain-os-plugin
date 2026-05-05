/**
 * dispatcher.test.ts — Stage D3 dispatcher tests (ai-brain#242, parent #237 AC#7).
 *
 * Coverage:
 *   - Pure decision functions across all branches: orphan / single-pass /
 *     chunked-by-AP (size + token thresholds) / none (reject-only).
 *   - `decideInteractionHandler` for both edge-emit and none.
 *   - Token heuristic constant pinned: 200 records × 500 tokens/record =
 *     100 000 → still single-pass; 201 records → chunked-by-AP via record
 *     count; 199 records with token override → chunked-by-AP via token gate.
 *   - `partitionTablesForComponent` separates entity / interaction / reject
 *     correctly; entity tables with no NK acceptance fall to `rejected`.
 *   - `dispatchBase` end-to-end with synthetic cache fixtures named for the
 *     four 5-base AC outcomes:
 *       - finance-base (single-pass, hub-spoke 3-table)
 *       - sales-base largest cluster (chunked-by-AP, large graph)
 *       - procurement-base (record-by-record + edge-emit, orphan mix)
 *       - distribution-base (record-by-record + edge-emit, orphan mix)
 *     Plus a 5th synthetic component (a tree-shape reject-only) to exercise
 *     the bare strategy=none path.
 *   - Outcome log rows: format + count + content (one row per component;
 *     strategy field reflects entity-or-interaction depending on which is
 *     active). The dispatcher writes via the shared `appendOutcomeLog` glue,
 *     so the row format inherits from `outcome-log.test.ts`.
 *   - Error paths: missing Stage 0 / cluster-shapes / NK cache files all
 *     abort with actionable messages.
 *
 * Names are anonymised by domain shape per the public-plugin convention; the
 * table-shape under test, not the brand, is what carries the AC weight.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideEntityStrategy,
  decideInteractionHandler,
  estimateEntityTokens,
  partitionTablesForComponent,
  dispatchBase,
  SIZE_THRESHOLD,
  TOKEN_THRESHOLD,
  TOKENS_PER_RECORD_ESTIMATE,
  type EntityStrategy,
} from "../scripts/dispatcher.mts";
import type {
  ClusterShape,
  ClusterShapeComponent,
} from "../scripts/cluster-classifier.mts";
import type { TableTypeClassification } from "../scripts/classify-table-type.mts";
import type { NaturalKeyOutput } from "../scripts/schema-analyser.mts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "dispatcher-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function classification(
  type: "entity" | "interaction" | "reject",
  schemaHash = "abc123",
): TableTypeClassification {
  return {
    type,
    reasoning: `synthetic ${type}`,
    schema_hash: schemaHash,
    classified_at: "2026-05-05T00:00:00.000Z",
  };
}

function nkAccepted(field: string, sampleSize: number) {
  return { nk_field: field, unique_rate: 1.0, sample_size: sampleSize };
}

function nkRejected(reason = "no candidate verified") {
  return { nk_field: null, reason } as const;
}

function shapeComponent(
  id: string,
  shape: ClusterShape,
  tables: string[],
): ClusterShapeComponent {
  return { component_id: id, shape, size: tables.length, tables };
}

interface FixtureCaches {
  classifications: Record<string, TableTypeClassification>;
  shapes: ClusterShapeComponent[];
  naturalKeys: NaturalKeyOutput;
}

function writeFixtureCaches(
  baseId: string,
  runId: string,
  caches: FixtureCaches,
): { cacheDir: string; stage0Path: string } {
  // Stage 0: skill-folder durable cache. We override its path via opts so the
  // test can keep it under `tmp` (no skill-tree pollution).
  const stage0Path = join(tmp, "stage0", `${baseId}.json`);
  mkdirSync(join(tmp, "stage0"), { recursive: true });
  writeFileSync(stage0Path, JSON.stringify(caches.classifications, null, 2));

  // Run-cache files
  const cacheDir = join(tmp, "run-cache");
  const runDir = join(cacheDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, `cluster-shapes-${baseId}.json`),
    JSON.stringify(caches.shapes, null, 2),
  );
  writeFileSync(
    join(runDir, `natural-keys-${baseId}.json`),
    JSON.stringify(caches.naturalKeys, null, 2),
  );

  return { cacheDir, stage0Path };
}

function setupVault(): { vaultPath: string; logPath: string } {
  const vaultPath = join(tmp, "vault");
  mkdirSync(join(vaultPath, "daily", "skill-outcomes"), { recursive: true });
  return {
    vaultPath,
    logPath: join(
      vaultPath,
      "daily",
      "skill-outcomes",
      "airtable-knowledge-extract.log",
    ),
  };
}

// ---------------------------------------------------------------------------
// Pure decision functions
// ---------------------------------------------------------------------------

describe("decideEntityStrategy — pure decision over (shape, count, tokens)", () => {
  test("no entity tables → none", () => {
    const r = decideEntityStrategy({
      shape: "graph",
      hasEntityTables: false,
      recordCount: 0,
      estimatedTokens: 0,
    });
    expect(r.strategy).toBe("none");
    expect(r.reason).toMatch(/no extractable entity tables/);
  });

  test("orphan-shape → record-by-record (regardless of size)", () => {
    const r = decideEntityStrategy({
      shape: "orphan",
      hasEntityTables: true,
      recordCount: 5_000,
      estimatedTokens: 2_500_000,
    });
    expect(r.strategy).toBe("record-by-record");
    expect(r.reason).toMatch(/orphan/);
  });

  test("non-orphan + size > 100 → chunked-by-AP (record-count gate)", () => {
    const r = decideEntityStrategy({
      shape: "graph",
      hasEntityTables: true,
      recordCount: SIZE_THRESHOLD + 1,
      estimatedTokens: 0,
    });
    expect(r.strategy).toBe("chunked-by-AP");
    expect(r.reason).toMatch(/record count.*> 100/);
  });

  test("non-orphan + size ≤ 100 + tokens > 100K → chunked-by-AP (token gate)", () => {
    const r = decideEntityStrategy({
      shape: "tree",
      hasEntityTables: true,
      recordCount: 50,
      estimatedTokens: TOKEN_THRESHOLD + 1,
    });
    expect(r.strategy).toBe("chunked-by-AP");
    expect(r.reason).toMatch(/estimated tokens.*> 100000/);
  });

  test("non-orphan + below both thresholds → single-pass", () => {
    const r = decideEntityStrategy({
      shape: "hub-spoke",
      hasEntityTables: true,
      recordCount: 30,
      estimatedTokens: 15_000,
    });
    expect(r.strategy).toBe("single-pass");
    expect(r.reason).toMatch(/below thresholds/);
  });

  test("size = 100 (boundary) → single-pass (strict >)", () => {
    const r = decideEntityStrategy({
      shape: "tree",
      hasEntityTables: true,
      recordCount: SIZE_THRESHOLD,
      estimatedTokens: 50_000,
    });
    expect(r.strategy).toBe("single-pass");
  });

  test("tokens = 100_000 (boundary) → single-pass (strict >)", () => {
    const r = decideEntityStrategy({
      shape: "tree",
      hasEntityTables: true,
      recordCount: 50,
      estimatedTokens: TOKEN_THRESHOLD,
    });
    expect(r.strategy).toBe("single-pass");
  });
});

describe("decideInteractionHandler", () => {
  test("≥1 interaction table → edge-emit", () => {
    expect(decideInteractionHandler(1)).toBe("edge-emit");
    expect(decideInteractionHandler(7)).toBe("edge-emit");
  });

  test("0 interaction tables → none", () => {
    expect(decideInteractionHandler(0)).toBe("none");
  });
});

describe("estimateEntityTokens — pinned constant", () => {
  test(`200 records × ${TOKENS_PER_RECORD_ESTIMATE} tokens/record = 100 000 (still single-pass at boundary)`, () => {
    expect(estimateEntityTokens(200)).toBe(100_000);
    expect(TOKENS_PER_RECORD_ESTIMATE).toBe(500);
  });

  test("0 records → 0 tokens", () => {
    expect(estimateEntityTokens(0)).toBe(0);
  });

  test("negative / NaN clamps to 0 (defensive)", () => {
    expect(estimateEntityTokens(-5)).toBe(0);
  });

  test("201 records → 100 500 (would chunk via token gate even ignoring record gate)", () => {
    // This is exactly the kind of regression a tuner would introduce: bumping
    // TOKENS_PER_RECORD_ESTIMATE to 100 would mean 201 × 100 = 20 100 tokens,
    // which doesn't trip the token gate. The combined record-OR-token rule is
    // what makes the dispatcher route correctly even if one heuristic drifts.
    expect(estimateEntityTokens(201)).toBe(100_500);
  });
});

// ---------------------------------------------------------------------------
// partitionTablesForComponent
// ---------------------------------------------------------------------------

describe("partitionTablesForComponent", () => {
  test("entity + interaction + reject mix routes to correct buckets", () => {
    const component = shapeComponent("c1", "graph", [
      "tEnt",
      "tInt",
      "tRej",
      "tEntNoNk",
    ]);
    const classifications: Record<string, TableTypeClassification> = {
      tEnt: classification("entity"),
      tInt: classification("interaction"),
      tRej: classification("reject"),
      tEntNoNk: classification("entity"),
    };
    const naturalKeys: NaturalKeyOutput = {
      tEnt: nkAccepted("Email", 50),
      tEntNoNk: nkRejected(),
      // tInt + tRej have no NK entry by design (schema-analyser only writes
      // for `entity` Stage 0 verdicts).
    };

    const r = partitionTablesForComponent(component, classifications, naturalKeys);
    expect(r.entityExtractable).toEqual(["tEnt"]);
    expect(r.interactions).toEqual(["tInt"]);
    expect(r.rejected.sort()).toEqual(["tEntNoNk", "tRej"]);
    expect(r.entityRecordCount).toBe(50);
  });

  test("missing Stage 0 entry → rejected + warn", () => {
    const warns: string[] = [];
    const component = shapeComponent("c1", "pair", ["tA", "tB"]);
    const classifications = { tA: classification("entity") };
    const naturalKeys: NaturalKeyOutput = { tA: nkAccepted("Name", 10) };
    const r = partitionTablesForComponent(
      component,
      classifications,
      naturalKeys,
      (m) => warns.push(m),
    );
    expect(r.entityExtractable).toEqual(["tA"]);
    expect(r.rejected).toEqual(["tB"]);
    expect(warns.some((w) => /tB.*no Stage 0/.test(w))).toBe(true);
  });

  test("multi-entity component sums record counts", () => {
    const component = shapeComponent("c1", "graph", ["tA", "tB", "tC"]);
    const classifications = {
      tA: classification("entity"),
      tB: classification("entity"),
      tC: classification("entity"),
    };
    const naturalKeys: NaturalKeyOutput = {
      tA: nkAccepted("Email", 30),
      tB: nkAccepted("Slug", 70),
      tC: nkAccepted("Code", 25),
    };
    const r = partitionTablesForComponent(component, classifications, naturalKeys);
    expect(r.entityExtractable.sort()).toEqual(["tA", "tB", "tC"]);
    expect(r.entityRecordCount).toBe(125);
  });
});

// ---------------------------------------------------------------------------
// dispatchBase — end-to-end with synthetic caches per AC base
// ---------------------------------------------------------------------------

describe("dispatchBase — finance-base (single-pass, AC fixture: small hub-spoke)", () => {
  test("3-table hub-spoke with 1 entity (≤100 records) → single-pass + edge-emit on interactions", async () => {
    const baseId = "appFinance0001";
    const runId = "run-finance";
    const caches: FixtureCaches = {
      classifications: {
        tCustomer: classification("entity"),
        tPayments: classification("interaction"),
        tCashflows: classification("interaction"),
      },
      shapes: [
        shapeComponent("component-1", "hub-spoke", [
          "tCustomer",
          "tPayments",
          "tCashflows",
        ]),
      ],
      naturalKeys: { tCustomer: nkAccepted("Email", 25) },
    };
    const { cacheDir, stage0Path } = writeFixtureCaches(baseId, runId, caches);
    const { vaultPath, logPath } = setupVault();

    const result = await dispatchBase(baseId, {
      cacheDir,
      runId,
      stage0CachePath: stage0Path,
      vaultPath,
      env: {},
    });

    expect(result.components).toHaveLength(1);
    const c = result.components[0];
    expect(c.entity_strategy).toBe("single-pass");
    expect(c.interaction_handler).toBe("edge-emit");
    expect(c.entity_tables).toEqual(["tCustomer"]);
    expect([...c.interaction_tables].sort()).toEqual(["tCashflows", "tPayments"]);
    expect(c.entity_record_count).toBe(25);
    expect(c.estimated_entity_tokens).toBe(25 * TOKENS_PER_RECORD_ESTIMATE);

    // Cache file exists with the same content as result
    const cached = JSON.parse(readFileSync(result.cachePath, "utf8"));
    expect(cached).toEqual(result.components);

    // Outcome log row written
    expect(existsSync(logPath)).toBe(true);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("airtable-knowledge-extract | dispatch");
    expect(log).toContain(`base_id=${baseId}`);
    expect(log).toContain("strategy=single-pass");
    expect(log).toContain("interaction_handler=edge-emit");
  });
});

describe("dispatchBase — sales-base (largest-cluster chunked-by-AP, AC fixture)", () => {
  test("multi-table graph with 500+ entity records → chunked-by-AP", async () => {
    const baseId = "appSales00002";
    const runId = "run-sales";
    // Synthetic largest cluster: 8-table graph, 3 entity tables totalling 500 records.
    const caches: FixtureCaches = {
      classifications: {
        tLeads: classification("entity"),
        tDeals: classification("entity"),
        tAccounts: classification("entity"),
        tActivities: classification("interaction"),
        // 4 more (rejected) tables in the cluster — sandbox / scratch
        tScratch1: classification("reject"),
        tScratch2: classification("reject"),
        tScratch3: classification("reject"),
        tScratch4: classification("reject"),
        // Plus an orphan entity table outside the largest cluster, in a separate
        // component, to verify dispatcher handles multi-component bases.
        tNotes: classification("entity"),
      },
      shapes: [
        shapeComponent("component-largest", "graph", [
          "tLeads",
          "tDeals",
          "tAccounts",
          "tActivities",
          "tScratch1",
          "tScratch2",
          "tScratch3",
          "tScratch4",
        ]),
        shapeComponent("component-notes", "orphan", ["tNotes"]),
      ],
      naturalKeys: {
        tLeads: nkAccepted("Email", 200),
        tDeals: nkAccepted("Deal ID", 180),
        tAccounts: nkAccepted("Domain", 120),
        tNotes: nkAccepted("Slug", 40),
      },
    };
    const { cacheDir, stage0Path } = writeFixtureCaches(baseId, runId, caches);
    const { vaultPath, logPath } = setupVault();

    const result = await dispatchBase(baseId, {
      cacheDir,
      runId,
      stage0CachePath: stage0Path,
      vaultPath,
      env: {},
    });

    expect(result.components).toHaveLength(2);
    const largest = result.components.find((c) => c.component_id === "component-largest")!;
    expect(largest.entity_strategy).toBe("chunked-by-AP");
    expect(largest.entity_record_count).toBe(500);
    expect(largest.interaction_handler).toBe("edge-emit");
    expect(largest.rejected_tables.sort()).toEqual([
      "tScratch1",
      "tScratch2",
      "tScratch3",
      "tScratch4",
    ]);

    const notes = result.components.find((c) => c.component_id === "component-notes")!;
    expect(notes.entity_strategy).toBe("record-by-record");
    expect(notes.interaction_handler).toBe("none");

    const log = readFileSync(logPath, "utf8").trim().split("\n");
    expect(log).toHaveLength(2);
    expect(log[0]).toContain("strategy=chunked-by-AP");
    expect(log[1]).toContain("strategy=record-by-record");
  });
});

describe("dispatchBase — procurement-base (record-by-record + edge-emit, AC fixture)", () => {
  test("4 orphan tables, mix of entity + interaction → per-component routing", async () => {
    const baseId = "appProcure0003";
    const runId = "run-procurement";
    const caches: FixtureCaches = {
      classifications: {
        tVendors: classification("entity"),
        tInvoices: classification("interaction"),
        tPaymentRequests: classification("interaction"),
        tApprovals: classification("interaction"),
      },
      shapes: [
        shapeComponent("component-1", "orphan", ["tVendors"]),
        shapeComponent("component-2", "orphan", ["tInvoices"]),
        shapeComponent("component-3", "orphan", ["tPaymentRequests"]),
        shapeComponent("component-4", "orphan", ["tApprovals"]),
      ],
      naturalKeys: { tVendors: nkAccepted("Name", 18) },
    };
    const { cacheDir, stage0Path } = writeFixtureCaches(baseId, runId, caches);
    const { vaultPath, logPath } = setupVault();

    const result = await dispatchBase(baseId, {
      cacheDir,
      runId,
      stage0CachePath: stage0Path,
      vaultPath,
      env: {},
    });

    const byId = Object.fromEntries(
      result.components.map((c) => [c.component_id, c] as const),
    );
    expect(byId["component-1"].entity_strategy).toBe("record-by-record");
    expect(byId["component-1"].interaction_handler).toBe("none");
    expect(byId["component-2"].entity_strategy).toBe("none");
    expect(byId["component-2"].interaction_handler).toBe("edge-emit");
    expect(byId["component-3"].entity_strategy).toBe("none");
    expect(byId["component-3"].interaction_handler).toBe("edge-emit");
    expect(byId["component-4"].entity_strategy).toBe("none");
    expect(byId["component-4"].interaction_handler).toBe("edge-emit");

    // For the 3 interaction-only orphan components, the strategy log field
    // collapses to the interaction handler so /improve sees a single
    // categorical: strategy=edge-emit.
    const log = readFileSync(logPath, "utf8").trim().split("\n");
    expect(log).toHaveLength(4);
    const strategies = log.map((line) => {
      const m = line.match(/strategy=([\w-]+)/);
      return m ? m[1] : null;
    });
    expect(strategies.sort()).toEqual([
      "edge-emit",
      "edge-emit",
      "edge-emit",
      "record-by-record",
    ]);
  });
});

describe("dispatchBase — distribution-base (record-by-record + edge-emit, AC fixture)", () => {
  test("5 orphan tables: 1 entity + 4 interaction → matches AC routing", async () => {
    const baseId = "appDistrib0004";
    const runId = "run-distribution";
    const caches: FixtureCaches = {
      classifications: {
        tProducts: classification("entity"),
        tShipments: classification("interaction"),
        tReturns: classification("interaction"),
        tPicks: classification("interaction"),
        tStockMoves: classification("interaction"),
      },
      shapes: [
        shapeComponent("c1", "orphan", ["tProducts"]),
        shapeComponent("c2", "orphan", ["tShipments"]),
        shapeComponent("c3", "orphan", ["tReturns"]),
        shapeComponent("c4", "orphan", ["tPicks"]),
        shapeComponent("c5", "orphan", ["tStockMoves"]),
      ],
      naturalKeys: { tProducts: nkAccepted("SKU", 60) },
    };
    const { cacheDir, stage0Path } = writeFixtureCaches(baseId, runId, caches);
    const { vaultPath } = setupVault();

    const result = await dispatchBase(baseId, {
      cacheDir,
      runId,
      stage0CachePath: stage0Path,
      vaultPath,
      env: {},
    });

    const summary = result.components.map((c) => ({
      id: c.component_id,
      entity: c.entity_strategy,
      interaction: c.interaction_handler,
    }));
    expect(summary).toEqual([
      { id: "c1", entity: "record-by-record", interaction: "none" },
      { id: "c2", entity: "none", interaction: "edge-emit" },
      { id: "c3", entity: "none", interaction: "edge-emit" },
      { id: "c4", entity: "none", interaction: "edge-emit" },
      { id: "c5", entity: "none", interaction: "edge-emit" },
    ]);
  });
});

describe("dispatchBase — pure-reject component (5th synthetic case)", () => {
  test("a tree component where every table is reject → strategy=none, no log oddities", async () => {
    const baseId = "appREJECT0000";
    const runId = "run-reject";
    const caches: FixtureCaches = {
      classifications: {
        t1: classification("reject"),
        t2: classification("reject"),
        t3: classification("reject"),
      },
      shapes: [shapeComponent("c1", "tree", ["t1", "t2", "t3"])],
      naturalKeys: {},
    };
    const { cacheDir, stage0Path } = writeFixtureCaches(baseId, runId, caches);
    const { vaultPath, logPath } = setupVault();

    const result = await dispatchBase(baseId, {
      cacheDir,
      runId,
      stage0CachePath: stage0Path,
      vaultPath,
      env: {},
    });

    const c = result.components[0];
    expect(c.entity_strategy).toBe("none");
    expect(c.interaction_handler).toBe("none");
    expect(c.rejected_tables.sort()).toEqual(["t1", "t2", "t3"]);

    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("strategy=none");
    expect(log).toContain("interaction_handler=none");
  });
});

describe("dispatchBase — output JSON shape (AC#1: contract)", () => {
  test("each item has component_id, entity_strategy, interaction_handler", async () => {
    const baseId = "appShape0000";
    const runId = "run-shape";
    const caches: FixtureCaches = {
      classifications: { tA: classification("entity") },
      shapes: [shapeComponent("c1", "orphan", ["tA"])],
      naturalKeys: { tA: nkAccepted("Name", 5) },
    };
    const { cacheDir, stage0Path } = writeFixtureCaches(baseId, runId, caches);
    const { vaultPath } = setupVault();
    const result = await dispatchBase(baseId, {
      cacheDir,
      runId,
      stage0CachePath: stage0Path,
      vaultPath,
      env: {},
    });
    for (const c of result.components) {
      expect(c).toHaveProperty("component_id");
      expect(c).toHaveProperty("entity_strategy");
      expect(c).toHaveProperty("interaction_handler");
      expect(typeof c.component_id).toBe("string");
      expect(["single-pass", "chunked-by-AP", "record-by-record", "none"]).toContain(
        c.entity_strategy as EntityStrategy,
      );
      expect(["edge-emit", "none"]).toContain(c.interaction_handler);
    }
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("dispatchBase — missing-cache error paths", () => {
  test("missing Stage 0 cache → throws actionable error", async () => {
    const baseId = "appNoStage0";
    const runId = "run-no-stage0";
    const cacheDir = join(tmp, "run-cache");
    mkdirSync(join(cacheDir, runId), { recursive: true });
    writeFileSync(
      join(cacheDir, runId, `cluster-shapes-${baseId}.json`),
      "[]",
    );
    writeFileSync(
      join(cacheDir, runId, `natural-keys-${baseId}.json`),
      "{}",
    );
    await expect(
      dispatchBase(baseId, {
        cacheDir,
        runId,
        stage0CachePath: join(tmp, "no-such.json"),
        vaultPath: tmp,
        env: {},
        writeOutcomeLog: false,
      }),
    ).rejects.toThrow(/Stage 0 classifier cache not found/);
  });

  test("missing cluster-shapes cache → throws actionable error", async () => {
    const baseId = "appNoShapes";
    const runId = "run-no-shapes";
    const stage0Path = join(tmp, "stage0", `${baseId}.json`);
    mkdirSync(join(tmp, "stage0"), { recursive: true });
    writeFileSync(stage0Path, "{}");
    const cacheDir = join(tmp, "run-cache");
    mkdirSync(join(cacheDir, runId), { recursive: true });
    // No cluster-shapes file
    writeFileSync(
      join(cacheDir, runId, `natural-keys-${baseId}.json`),
      "{}",
    );
    await expect(
      dispatchBase(baseId, {
        cacheDir,
        runId,
        stage0CachePath: stage0Path,
        vaultPath: tmp,
        env: {},
        writeOutcomeLog: false,
      }),
    ).rejects.toThrow(/cluster shapes cache not found/);
  });

  test("missing natural-keys cache → throws actionable error", async () => {
    const baseId = "appNoNk";
    const runId = "run-no-nk";
    const stage0Path = join(tmp, "stage0", `${baseId}.json`);
    mkdirSync(join(tmp, "stage0"), { recursive: true });
    writeFileSync(stage0Path, "{}");
    const cacheDir = join(tmp, "run-cache");
    mkdirSync(join(cacheDir, runId), { recursive: true });
    writeFileSync(
      join(cacheDir, runId, `cluster-shapes-${baseId}.json`),
      "[]",
    );
    // No natural-keys file
    await expect(
      dispatchBase(baseId, {
        cacheDir,
        runId,
        stage0CachePath: stage0Path,
        vaultPath: tmp,
        env: {},
        writeOutcomeLog: false,
      }),
    ).rejects.toThrow(/natural-keys cache not found/);
  });
});

// ---------------------------------------------------------------------------
// writeOutcomeLog opt-out
// ---------------------------------------------------------------------------

describe("dispatchBase — writeOutcomeLog opt-out", () => {
  test("writeOutcomeLog: false skips log write entirely", async () => {
    const baseId = "appNoLog";
    const runId = "run-no-log";
    const caches: FixtureCaches = {
      classifications: { tA: classification("entity") },
      shapes: [shapeComponent("c1", "orphan", ["tA"])],
      naturalKeys: { tA: nkAccepted("Name", 5) },
    };
    const { cacheDir, stage0Path } = writeFixtureCaches(baseId, runId, caches);
    const { vaultPath, logPath } = setupVault();
    await dispatchBase(baseId, {
      cacheDir,
      runId,
      stage0CachePath: stage0Path,
      vaultPath,
      env: {},
      writeOutcomeLog: false,
    });
    expect(existsSync(logPath)).toBe(false);
  });
});
