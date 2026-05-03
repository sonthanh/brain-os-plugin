import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeBases,
  parseAllowlist,
  ARCHIVE_REGEX,
  COPY_REGEX,
  TEST_REGEX,
} from "../scripts/active-bases.mts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "active-bases-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const FIXED_NOW = () => new Date("2026-06-15T12:00:00Z");
const CUTOFF_ISO = "2026-01-01T00:00:00Z";
const FRESH = "2026-04-10T08:00:00Z"; // ≥ cutoff
const STALE = "2025-08-12T08:00:00Z"; // < cutoff

// ---------------- regex branch tests ----------------

describe("ARCHIVE_REGEX", () => {
  test("matches 'Archive 2024'", () => {
    expect(ARCHIVE_REGEX.test("Archive 2024")).toBe(true);
  });
  test("matches 'Old Archive'", () => {
    expect(ARCHIVE_REGEX.test("Old Archive")).toBe(true);
  });
  test("matches 'archived 2024 quarter'", () => {
    // Per SSOT regex: 'archived?\s+\d{4}' branch hits "archived 2024..."
    expect(ARCHIVE_REGEX.test("archived 2024 quarter")).toBe(true);
  });
  test("matches 'Archived Projects' (no year suffix)", () => {
    // Per SSOT regex: '\barchived?\b' branch — fixes prior bug where bare 'archived' didn't hit
    expect(ARCHIVE_REGEX.test("Archived Projects")).toBe(true);
  });
  test("does not match 'Architecture Plans'", () => {
    expect(ARCHIVE_REGEX.test("Architecture Plans")).toBe(false);
  });
  test("does not match 'Active CRM'", () => {
    expect(ARCHIVE_REGEX.test("Active CRM")).toBe(false);
  });
});

describe("COPY_REGEX", () => {
  test("matches 'CRM (Copy)'", () => {
    expect(COPY_REGEX.test("CRM (Copy)")).toBe(true);
  });
  test("matches 'Imported Base'", () => {
    expect(COPY_REGEX.test("Imported Base")).toBe(true);
  });
  test("matches 'Customer duplicate'", () => {
    expect(COPY_REGEX.test("Customer duplicate")).toBe(true);
  });
  test("matches 'Grid view'", () => {
    expect(COPY_REGEX.test("Grid view")).toBe(true);
  });
  test("matches 'Backup 2025'", () => {
    expect(COPY_REGEX.test("Backup 2025")).toBe(true);
  });
  test("does not match 'Copywriting Plans'", () => {
    expect(COPY_REGEX.test("Copywriting Plans")).toBe(false);
  });
  test("does not match 'Imports tracker' (no exact 'imported')", () => {
    expect(COPY_REGEX.test("Imports tracker")).toBe(false);
  });
});

describe("TEST_REGEX", () => {
  test("matches 'Test base'", () => {
    expect(TEST_REGEX.test("Test base")).toBe(true);
  });
  test("matches 'Question 5 - Tracker'", () => {
    expect(TEST_REGEX.test("Question 5 - Tracker")).toBe(true);
  });
  test("matches 'Intern Tasks'", () => {
    expect(TEST_REGEX.test("Intern Tasks")).toBe(true);
  });
  test("matches 'Required Assignment 3'", () => {
    expect(TEST_REGEX.test("Required Assignment 3")).toBe(true);
  });
  test("matches 'MCO intern practice'", () => {
    expect(TEST_REGEX.test("MCO intern practice")).toBe(true);
  });
  test("matches 'HR practice'", () => {
    expect(TEST_REGEX.test("HR practice")).toBe(true);
  });
  test("matches 'HR admin'", () => {
    expect(TEST_REGEX.test("HR admin")).toBe(true);
  });
  test("does not match 'Testing Lab' would normally hit but only standalone 'test'", () => {
    // \btest\b matches 'test' standalone - so 'Testing' doesn't match because 'test' is followed by 'ing'
    expect(TEST_REGEX.test("Testing Lab")).toBe(false);
  });
  test("does not match 'Production CRM'", () => {
    expect(TEST_REGEX.test("Production CRM")).toBe(false);
  });
});

// ---------------- allowlist parsing tests ----------------

describe("parseAllowlist", () => {
  test("parses plain base ID lines", () => {
    const r = parseAllowlist("appAAAAAAAAAAAAAA\nappBBBBBBBBBBBBBB\n");
    expect(r.ids.has("appAAAAAAAAAAAAAA")).toBe(true);
    expect(r.ids.has("appBBBBBBBBBBBBBB")).toBe(true);
    expect(r.regexes).toHaveLength(0);
    expect(r.overrides.size).toBe(0);
  });

  test("parses ~regex lines", () => {
    const r = parseAllowlist("~^Primary\\b\n~CRM$\n");
    expect(r.regexes).toHaveLength(2);
    expect(r.regexes[0].test("Primary CRM")).toBe(true);
    expect(r.regexes[1].test("Customer CRM")).toBe(true);
  });

  test("parses !override lines", () => {
    const r = parseAllowlist("!appOVERRIDEABCDEFG\n");
    expect(r.overrides.has("appOVERRIDEABCDEFG")).toBe(true);
    // Override also implies inclusion.
    expect(r.ids.has("appOVERRIDEABCDEFG")).toBe(true);
  });

  test("ignores # comment lines", () => {
    const r = parseAllowlist("# this is a comment\nappAAAAAAAAAAAAAA\n# trailing\n");
    expect(r.ids.size).toBe(1);
  });

  test("ignores blank lines", () => {
    const r = parseAllowlist("\n\nappAAAAAAAAAAAAAA\n\n\n");
    expect(r.ids.size).toBe(1);
  });

  test("strips inline # comments", () => {
    const r = parseAllowlist("appAAAAAAAAAAAAAA  # primary CRM\n");
    expect(r.ids.has("appAAAAAAAAAAAAAA")).toBe(true);
  });

  test("ignores invalid regex lines (does not throw)", () => {
    const r = parseAllowlist("~[unclosed\nappAAAAAAAAAAAAAA\n");
    // Invalid regex skipped, valid id still parsed
    expect(r.ids.has("appAAAAAAAAAAAAAA")).toBe(true);
  });
});

// ---------------- helper to build mock fetch for activity probe ----------------

interface MockTable {
  id: string;
  name: string;
}

interface MockBaseProbe {
  // tables endpoint returns these
  tables: MockTable[];
  // for each tableId, the createdTime to return on records call
  createdTimes: Record<string, string | null>;
  // optional: throw on the tables endpoint
  tablesError?: number;
}

function buildMockFetch(probes: Record<string, MockBaseProbe>) {
  let inFlight = 0;
  let maxInFlight = 0;
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL, _init?: RequestInit) => {
    inFlight += 1;
    if (inFlight > maxInFlight) maxInFlight = inFlight;
    try {
      const url = String(input);
      calls.push(url);
      // Match /v0/meta/bases/<baseId>/tables
      const tablesMatch = url.match(/\/v0\/meta\/bases\/([^/?]+)\/tables(?:\?|$)/);
      if (tablesMatch) {
        const baseId = tablesMatch[1];
        const probe = probes[baseId];
        if (!probe) {
          return new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404 });
        }
        if (probe.tablesError) {
          return new Response(JSON.stringify({ error: "ERR" }), { status: probe.tablesError });
        }
        return new Response(JSON.stringify({ tables: probe.tables }), { status: 200 });
      }
      // Match records endpoint: /v0/<baseId>/<tableId>?...
      const recMatch = url.match(/\/v0\/([^/?]+)\/([^/?]+)\?/);
      if (recMatch) {
        const baseId = recMatch[1];
        const tableId = recMatch[2];
        const probe = probes[baseId];
        const ct = probe?.createdTimes[tableId];
        if (ct === undefined) {
          return new Response(JSON.stringify({ records: [] }), { status: 200 });
        }
        if (ct === null) {
          return new Response(JSON.stringify({ records: [] }), { status: 200 });
        }
        return new Response(
          JSON.stringify({ records: [{ id: "rec1", createdTime: ct, fields: {} }] }),
          { status: 200 },
        );
      }
      return new Response("not mocked", { status: 500 });
    } finally {
      inFlight -= 1;
    }
  };
  return { fetchImpl, calls: () => calls, maxInFlight: () => maxInFlight };
}

// ---------------- core algorithm tests ----------------

describe("activeBases - inclusion / exclusion", () => {
  test("drops bases excluded by archive regex (excluded_by=archive)", async () => {
    const { fetchImpl } = buildMockFetch({
      appKEEP: {
        tables: [{ id: "tbl1", name: "Contacts" }],
        createdTimes: { tbl1: FRESH },
      },
    });
    const result = await activeBases({
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "r1",
      allowlistPath: join(tmp, "no-allowlist.txt"),
      now: FIXED_NOW,
      fetch: async (url, init) => {
        const u = String(url);
        if (u === "https://api.airtable.com/v0/meta/bases") {
          return new Response(
            JSON.stringify({
              bases: [
                { id: "appARCH", name: "Archive 2024", permissionLevel: "read" },
                { id: "appKEEP", name: "Active CRM", permissionLevel: "create" },
              ],
            }),
            { status: 200 },
          );
        }
        return fetchImpl(url, init);
      },
    });

    expect(result.activeIds).toEqual(["appKEEP"]);
    const arch = result.trace.find((b) => b.id === "appARCH");
    expect(arch?.included).toBe(false);
    expect(arch?.excluded_by).toBe("archive");
  });

  test("drops bases excluded by copy regex", async () => {
    const { fetchImpl } = buildMockFetch({
      appKEEP: {
        tables: [{ id: "tbl1", name: "Contacts" }],
        createdTimes: { tbl1: FRESH },
      },
    });
    const result = await activeBases({
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "r2",
      allowlistPath: join(tmp, "no-allowlist.txt"),
      now: FIXED_NOW,
      fetch: async (url, init) => {
        const u = String(url);
        if (u === "https://api.airtable.com/v0/meta/bases") {
          return new Response(
            JSON.stringify({
              bases: [
                { id: "appCOPY", name: "Imported Base", permissionLevel: "read" },
                { id: "appKEEP", name: "Active CRM", permissionLevel: "create" },
              ],
            }),
            { status: 200 },
          );
        }
        return fetchImpl(url, init);
      },
    });

    expect(result.activeIds).toEqual(["appKEEP"]);
    const cp = result.trace.find((b) => b.id === "appCOPY");
    expect(cp?.excluded_by).toBe("copy");
  });

  test("drops bases excluded by test regex", async () => {
    const { fetchImpl } = buildMockFetch({
      appKEEP: {
        tables: [{ id: "tbl1", name: "Contacts" }],
        createdTimes: { tbl1: FRESH },
      },
    });
    const result = await activeBases({
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "r3",
      allowlistPath: join(tmp, "no-allowlist.txt"),
      now: FIXED_NOW,
      fetch: async (url, init) => {
        const u = String(url);
        if (u === "https://api.airtable.com/v0/meta/bases") {
          return new Response(
            JSON.stringify({
              bases: [
                { id: "appTEST", name: "Question 3 - Tracker", permissionLevel: "read" },
                { id: "appKEEP", name: "Active CRM", permissionLevel: "create" },
              ],
            }),
            { status: 200 },
          );
        }
        return fetchImpl(url, init);
      },
    });

    expect(result.activeIds).toEqual(["appKEEP"]);
    const t = result.trace.find((b) => b.id === "appTEST");
    expect(t?.excluded_by).toBe("test");
  });

  test("drops base when activity probe returns only stale createdTime (excluded_by=inactive)", async () => {
    const { fetchImpl } = buildMockFetch({
      appOLD: {
        tables: [{ id: "tbl1", name: "Contacts" }],
        createdTimes: { tbl1: STALE },
      },
    });
    const result = await activeBases({
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "r4",
      allowlistPath: join(tmp, "no-allowlist.txt"),
      now: FIXED_NOW,
      fetch: async (url, init) => {
        const u = String(url);
        if (u === "https://api.airtable.com/v0/meta/bases") {
          return new Response(
            JSON.stringify({
              bases: [{ id: "appOLD", name: "Old CRM", permissionLevel: "read" }],
            }),
            { status: 200 },
          );
        }
        return fetchImpl(url, init);
      },
    });

    expect(result.activeIds).toEqual([]);
    const old = result.trace.find((b) => b.id === "appOLD");
    expect(old?.excluded_by).toBe("inactive");
    expect(old?.last_activity).toBe(STALE);
    expect(old?.table_count).toBe(1);
  });

  test("keeps base when at least one table has createdTime ≥ cutoff (max wins)", async () => {
    const { fetchImpl } = buildMockFetch({
      appMIX: {
        tables: [
          { id: "tbl1", name: "Old" },
          { id: "tbl2", name: "Fresh" },
        ],
        createdTimes: { tbl1: STALE, tbl2: FRESH },
      },
    });
    const result = await activeBases({
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "r5",
      allowlistPath: join(tmp, "no-allowlist.txt"),
      now: FIXED_NOW,
      fetch: async (url, init) => {
        const u = String(url);
        if (u === "https://api.airtable.com/v0/meta/bases") {
          return new Response(
            JSON.stringify({
              bases: [{ id: "appMIX", name: "Mixed Base", permissionLevel: "read" }],
            }),
            { status: 200 },
          );
        }
        return fetchImpl(url, init);
      },
    });

    expect(result.activeIds).toEqual(["appMIX"]);
    const mix = result.trace.find((b) => b.id === "appMIX");
    expect(mix?.included).toBe(true);
    expect(mix?.excluded_by).toBeNull();
    expect(mix?.last_activity).toBe(FRESH);
    expect(mix?.table_count).toBe(2);
  });

  test("uses AIRTABLE_ACTIVITY_CUTOFF env override when provided", async () => {
    // Cutoff overridden to 2025-01-01 so STALE (2025-08-12) is now ≥ cutoff
    const { fetchImpl } = buildMockFetch({
      appMID: {
        tables: [{ id: "tbl1", name: "Contacts" }],
        createdTimes: { tbl1: STALE },
      },
    });
    const result = await activeBases({
      env: {
        AIRTABLE_API_KEY: "patFake",
        AIRTABLE_ACTIVITY_CUTOFF: "2025-01-01T00:00:00Z",
      },
      cacheDir: tmp,
      runId: "r6",
      allowlistPath: join(tmp, "no-allowlist.txt"),
      now: FIXED_NOW,
      fetch: async (url, init) => {
        const u = String(url);
        if (u === "https://api.airtable.com/v0/meta/bases") {
          return new Response(
            JSON.stringify({
              bases: [{ id: "appMID", name: "Mid CRM", permissionLevel: "read" }],
            }),
            { status: 200 },
          );
        }
        return fetchImpl(url, init);
      },
    });

    expect(result.activeIds).toEqual(["appMID"]);
  });
});

// ---------------- allowlist precedence tests ----------------

describe("activeBases - allowlist", () => {
  test("when allowlist exists, drops bases not in it (included=false, excluded_by=null)", async () => {
    const allowlist = join(tmp, "allowlist.txt");
    writeFileSync(allowlist, "appINCLUDED\n");
    const { fetchImpl } = buildMockFetch({
      appINCLUDED: {
        tables: [{ id: "tbl1", name: "Contacts" }],
        createdTimes: { tbl1: FRESH },
      },
    });
    const result = await activeBases({
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "r7",
      allowlistPath: allowlist,
      now: FIXED_NOW,
      fetch: async (url, init) => {
        const u = String(url);
        if (u === "https://api.airtable.com/v0/meta/bases") {
          return new Response(
            JSON.stringify({
              bases: [
                { id: "appINCLUDED", name: "Primary CRM", permissionLevel: "create" },
                { id: "appOTHER", name: "Other Workspace", permissionLevel: "read" },
              ],
            }),
            { status: 200 },
          );
        }
        return fetchImpl(url, init);
      },
    });

    expect(result.activeIds).toEqual(["appINCLUDED"]);
    const other = result.trace.find((b) => b.id === "appOTHER");
    expect(other?.included).toBe(false);
    expect(other?.excluded_by).toBeNull();
  });

  test("~regex line in allowlist matches by base name", async () => {
    const allowlist = join(tmp, "allowlist.txt");
    writeFileSync(allowlist, "~^Primary\\b\n");
    const { fetchImpl } = buildMockFetch({
      appPRIMARY: {
        tables: [{ id: "tbl1", name: "Contacts" }],
        createdTimes: { tbl1: FRESH },
      },
    });
    const result = await activeBases({
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "r8",
      allowlistPath: allowlist,
      now: FIXED_NOW,
      fetch: async (url, init) => {
        const u = String(url);
        if (u === "https://api.airtable.com/v0/meta/bases") {
          return new Response(
            JSON.stringify({
              bases: [
                { id: "appPRIMARY", name: "Primary CRM", permissionLevel: "create" },
                { id: "appOTHER", name: "Other Workspace", permissionLevel: "read" },
              ],
            }),
            { status: 200 },
          );
        }
        return fetchImpl(url, init);
      },
    });

    expect(result.activeIds).toEqual(["appPRIMARY"]);
  });

  test("!override beats archive regex (force-include)", async () => {
    const allowlist = join(tmp, "allowlist.txt");
    writeFileSync(allowlist, "!appARCH\n");
    // Override should NOT probe (operator vouched), so we only mock listBases
    const calledTables: string[] = [];
    const result = await activeBases({
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "r9",
      allowlistPath: allowlist,
      now: FIXED_NOW,
      fetch: async (url) => {
        const u = String(url);
        if (u === "https://api.airtable.com/v0/meta/bases") {
          return new Response(
            JSON.stringify({
              bases: [
                { id: "appARCH", name: "Archive 2024", permissionLevel: "read" },
              ],
            }),
            { status: 200 },
          );
        }
        if (u.includes("/tables")) {
          calledTables.push(u);
        }
        return new Response("not mocked", { status: 500 });
      },
    });

    expect(result.activeIds).toEqual(["appARCH"]);
    const arch = result.trace.find((b) => b.id === "appARCH");
    expect(arch?.included).toBe(true);
    expect(arch?.excluded_by).toBeNull();
    // Override skips probe entirely
    expect(calledTables).toHaveLength(0);
  });

  test("missing allowlist file → falls through to inclusion-by-default + exclusion regex", async () => {
    const { fetchImpl } = buildMockFetch({
      appKEEP: {
        tables: [{ id: "tbl1", name: "Contacts" }],
        createdTimes: { tbl1: FRESH },
      },
    });
    const result = await activeBases({
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "r10",
      allowlistPath: join(tmp, "missing.txt"),
      now: FIXED_NOW,
      fetch: async (url, init) => {
        const u = String(url);
        if (u === "https://api.airtable.com/v0/meta/bases") {
          return new Response(
            JSON.stringify({
              bases: [
                { id: "appKEEP", name: "Active CRM", permissionLevel: "create" },
              ],
            }),
            { status: 200 },
          );
        }
        return fetchImpl(url, init);
      },
    });

    expect(result.activeIds).toEqual(["appKEEP"]);
  });
});

// ---------------- output / cache tests ----------------

describe("activeBases - outputs", () => {
  test("writes trace JSON containing every raw base from listBases", async () => {
    const { fetchImpl } = buildMockFetch({
      appKEEP: {
        tables: [{ id: "tbl1", name: "Contacts" }],
        createdTimes: { tbl1: FRESH },
      },
    });
    const result = await activeBases({
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "r11",
      allowlistPath: join(tmp, "no-allowlist.txt"),
      now: FIXED_NOW,
      fetch: async (url, init) => {
        const u = String(url);
        if (u === "https://api.airtable.com/v0/meta/bases") {
          return new Response(
            JSON.stringify({
              bases: [
                { id: "appARCH", name: "Archive 2024", permissionLevel: "read" },
                { id: "appKEEP", name: "Active CRM", permissionLevel: "create" },
                { id: "appCOPY", name: "Imported Base", permissionLevel: "read" },
              ],
            }),
            { status: 200 },
          );
        }
        return fetchImpl(url, init);
      },
    });

    const tracePath = join(tmp, "r11", "active-bases.json");
    expect(existsSync(tracePath)).toBe(true);
    const persisted = JSON.parse(readFileSync(tracePath, "utf8"));
    expect(persisted).toHaveLength(3);
    const ids = persisted.map((b: { id: string }) => b.id).sort();
    expect(ids).toEqual(["appARCH", "appCOPY", "appKEEP"]);
    // All entries have the required shape
    for (const entry of persisted) {
      expect(typeof entry.id).toBe("string");
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.included).toBe("boolean");
      expect(entry).toHaveProperty("excluded_by");
      expect(entry).toHaveProperty("last_activity");
      expect(entry).toHaveProperty("table_count");
    }
    expect(result.cachePath).toBe(tracePath);
  });

  test("dropped-before-probe bases have table_count=null and last_activity=null", async () => {
    const { fetchImpl } = buildMockFetch({});
    const result = await activeBases({
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "r12",
      allowlistPath: join(tmp, "no-allowlist.txt"),
      now: FIXED_NOW,
      fetch: async (url, init) => {
        const u = String(url);
        if (u === "https://api.airtable.com/v0/meta/bases") {
          return new Response(
            JSON.stringify({
              bases: [{ id: "appARCH", name: "Archive 2024", permissionLevel: "read" }],
            }),
            { status: 200 },
          );
        }
        return fetchImpl(url, init);
      },
    });

    const arch = result.trace.find((b) => b.id === "appARCH");
    expect(arch?.table_count).toBeNull();
    expect(arch?.last_activity).toBeNull();
  });
});

// ---------------- cache resume test ----------------

describe("activeBases - cache resume", () => {
  test("re-running with same run-id reads cached trace and skips probing", async () => {
    // Pre-write trace JSON
    const runDir = join(tmp, "r13");
    mkdirSync(runDir, { recursive: true });
    const traceFile = join(runDir, "active-bases.json");
    const cached = [
      {
        id: "appCACHED",
        name: "Cached Base",
        included: true,
        excluded_by: null,
        last_activity: FRESH,
        table_count: 2,
      },
    ];
    writeFileSync(traceFile, JSON.stringify(cached, null, 2));

    let fetchCalls = 0;
    const result = await activeBases({
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "r13",
      allowlistPath: join(tmp, "no-allowlist.txt"),
      now: FIXED_NOW,
      fetch: async () => {
        fetchCalls += 1;
        return new Response("{}", { status: 200 });
      },
    });

    expect(fetchCalls).toBe(0);
    expect(result.activeIds).toEqual(["appCACHED"]);
    expect(result.trace).toEqual(cached);
  });
});

// ---------------- API error path test ----------------

describe("activeBases - error paths", () => {
  test("propagates token resolution failure", async () => {
    await expect(
      activeBases({
        env: {},
        cacheDir: tmp,
        runId: "r14",
        allowlistPath: join(tmp, "no-allowlist.txt"),
        configPath: join(tmp, "missing.json"),
        now: FIXED_NOW,
        fetch: async () => new Response("{}", { status: 200 }),
      }),
    ).rejects.toThrow(/AIRTABLE_API_KEY/);
  });

  test("propagates listBases API error (non-2xx) so caller can exit 1", async () => {
    await expect(
      activeBases({
        env: { AIRTABLE_API_KEY: "patFake" },
        cacheDir: tmp,
        runId: "r15",
        allowlistPath: join(tmp, "no-allowlist.txt"),
        now: FIXED_NOW,
        fetch: async () =>
          new Response(JSON.stringify({ error: { type: "AUTH" } }), { status: 401 }),
      }),
    ).rejects.toThrow(/Airtable.*401/);
  });

  test("per-base probe failure does not abort the run; treats base as inactive", async () => {
    const result = await activeBases({
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "r16",
      allowlistPath: join(tmp, "no-allowlist.txt"),
      now: FIXED_NOW,
      fetch: async (url) => {
        const u = String(url);
        if (u === "https://api.airtable.com/v0/meta/bases") {
          return new Response(
            JSON.stringify({
              bases: [
                { id: "appBAD", name: "Bad Probe", permissionLevel: "read" },
                { id: "appOK", name: "Good CRM", permissionLevel: "create" },
              ],
            }),
            { status: 200 },
          );
        }
        if (u.includes("/v0/meta/bases/appBAD/tables")) {
          return new Response("rate limit", { status: 429 });
        }
        if (u.includes("/v0/meta/bases/appOK/tables")) {
          return new Response(
            JSON.stringify({ tables: [{ id: "tblok", name: "Contacts" }] }),
            { status: 200 },
          );
        }
        if (u.includes("/v0/appOK/tblok")) {
          return new Response(
            JSON.stringify({ records: [{ id: "rec1", createdTime: FRESH, fields: {} }] }),
            { status: 200 },
          );
        }
        return new Response("not mocked", { status: 500 });
      },
    });

    expect(result.activeIds).toEqual(["appOK"]);
    const bad = result.trace.find((b) => b.id === "appBAD");
    expect(bad?.included).toBe(false);
    expect(bad?.excluded_by).toBe("inactive");
  });
});

// ---------------- concurrency cap test ----------------

describe("activeBases - rate limit", () => {
  test("caps concurrent activity probes at 5 across many bases", async () => {
    // Build 20 bases all needing probes
    const bases = Array.from({ length: 20 }, (_, i) => ({
      id: `app${String(i).padStart(2, "0")}AAAAAAAAAAAA`,
      name: `Base ${i}`,
      permissionLevel: "create",
    }));
    const probes: Record<string, MockBaseProbe> = {};
    for (const b of bases) {
      probes[b.id] = {
        tables: [{ id: "tbl1", name: "Contacts" }],
        createdTimes: { tbl1: FRESH },
      };
    }
    const { fetchImpl, maxInFlight } = buildMockFetch(probes);

    // Add small delay to surface concurrency
    const delayedFetch = async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u === "https://api.airtable.com/v0/meta/bases") {
        return new Response(JSON.stringify({ bases }), { status: 200 });
      }
      // delay 30ms per probe to overlap
      await new Promise((r) => setTimeout(r, 30));
      return fetchImpl(url, init);
    };

    await activeBases({
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "r17",
      allowlistPath: join(tmp, "no-allowlist.txt"),
      now: FIXED_NOW,
      fetch: delayedFetch,
    });

    expect(maxInFlight()).toBeLessThanOrEqual(5);
  });
});

// ---------------- CLI shape (--ids flag) ----------------

describe("activeBases CLI", () => {
  test("default stdout is a JSON array of active IDs", async () => {
    const { fetchImpl } = buildMockFetch({});
    const result = await activeBases({
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "rcli1",
      allowlistPath: join(tmp, "no-allowlist.txt"),
      now: FIXED_NOW,
      fetch: async (url, init) => {
        const u = String(url);
        if (u === "https://api.airtable.com/v0/meta/bases") {
          return new Response(
            JSON.stringify({
              bases: [{ id: "appARCH", name: "Archive 2024", permissionLevel: "read" }],
            }),
            { status: 200 },
          );
        }
        return fetchImpl(url, init);
      },
    });
    // Caller can serialise with JSON.stringify
    const stdout = JSON.stringify(result.activeIds);
    expect(stdout).toBe("[]");
  });
});

// ---------------- integration smoke ----------------

describe("activeBases - integration smoke", () => {
  test("mixed batch produces correct stdout shape and trace shape", async () => {
    const { fetchImpl } = buildMockFetch({
      appKEEP: {
        tables: [{ id: "tbl1", name: "Contacts" }],
        createdTimes: { tbl1: FRESH },
      },
      appOLD: {
        tables: [{ id: "tbl1", name: "Old" }],
        createdTimes: { tbl1: STALE },
      },
    });
    const result = await activeBases({
      env: { AIRTABLE_API_KEY: "patFake" },
      cacheDir: tmp,
      runId: "r18",
      allowlistPath: join(tmp, "no-allowlist.txt"),
      now: FIXED_NOW,
      fetch: async (url, init) => {
        const u = String(url);
        if (u === "https://api.airtable.com/v0/meta/bases") {
          return new Response(
            JSON.stringify({
              bases: [
                { id: "appARCH", name: "Archive 2024", permissionLevel: "read" },
                { id: "appCOPY", name: "Imported Base", permissionLevel: "read" },
                { id: "appTEST", name: "Test Sandbox", permissionLevel: "read" },
                { id: "appKEEP", name: "Active CRM", permissionLevel: "create" },
                { id: "appOLD", name: "Dormant Tracker", permissionLevel: "read" },
              ],
            }),
            { status: 200 },
          );
        }
        return fetchImpl(url, init);
      },
    });

    expect(Array.isArray(result.activeIds)).toBe(true);
    expect(result.activeIds).toEqual(["appKEEP"]);
    expect(result.trace).toHaveLength(5);
    const byId = Object.fromEntries(result.trace.map((b) => [b.id, b]));
    expect(byId.appARCH.excluded_by).toBe("archive");
    expect(byId.appCOPY.excluded_by).toBe("copy");
    expect(byId.appTEST.excluded_by).toBe("test");
    expect(byId.appKEEP.included).toBe(true);
    expect(byId.appKEEP.excluded_by).toBeNull();
    expect(byId.appOLD.excluded_by).toBe("inactive");
  });
});
