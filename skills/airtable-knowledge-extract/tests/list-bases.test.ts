import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listBases } from "../scripts/list-bases.mts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "list-bases-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const okFetch = (body: unknown) =>
  async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

describe("listBases", () => {
  test("returns bases array from Airtable Meta API", async () => {
    const result = await listBases({
      fetch: okFetch({
        bases: [
          { id: "appA", name: "Alpha", permissionLevel: "create" },
          { id: "appB", name: "Beta", permissionLevel: "read" },
        ],
      }),
      env: { AIRTABLE_API_KEY: "patFake.token" },
      cacheDir: tmp,
      runId: "run-1",
    });
    expect(result.bases).toEqual([
      { id: "appA", name: "Alpha", permissionLevel: "create" },
      { id: "appB", name: "Beta", permissionLevel: "read" },
    ]);
  });

  test("writes bases.json to cache dir under run-id", async () => {
    await listBases({
      fetch: okFetch({
        bases: [{ id: "appA", name: "Alpha", permissionLevel: "create" }],
      }),
      env: { AIRTABLE_API_KEY: "patFake.token" },
      cacheDir: tmp,
      runId: "run-2",
    });
    const cachePath = join(tmp, "run-2", "bases.json");
    expect(existsSync(cachePath)).toBe(true);
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    expect(cached).toEqual([{ id: "appA", name: "Alpha", permissionLevel: "create" }]);
  });

  test("calls Meta API with bearer auth header", async () => {
    let capturedUrl = "";
    let capturedAuth = "";
    await listBases({
      fetch: async (url: string | URL, init?: RequestInit) => {
        capturedUrl = String(url);
        capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
        return new Response(JSON.stringify({ bases: [] }), { status: 200 });
      },
      env: { AIRTABLE_API_KEY: "patFake.token" },
      cacheDir: tmp,
      runId: "run-3",
    });
    expect(capturedUrl).toBe("https://api.airtable.com/v0/meta/bases");
    expect(capturedAuth).toBe("Bearer patFake.token");
  });

  test("falls back to AIRTABLE_TOKEN when AIRTABLE_API_KEY missing", async () => {
    let capturedAuth = "";
    await listBases({
      fetch: async (_url, init) => {
        capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
        return new Response(JSON.stringify({ bases: [] }), { status: 200 });
      },
      env: { AIRTABLE_TOKEN: "patFromZsh" },
      cacheDir: tmp,
      runId: "run-4",
    });
    expect(capturedAuth).toBe("Bearer patFromZsh");
  });

  test("falls back to ~/.claude.json mcpServers.airtable.env.AIRTABLE_API_KEY", async () => {
    const claudeJson = join(tmp, "claude.json");
    writeFileSync(
      claudeJson,
      JSON.stringify({
        mcpServers: {
          airtable: {
            env: { AIRTABLE_API_KEY: "patFromClaudeJson" },
          },
        },
      }),
    );
    let capturedAuth = "";
    await listBases({
      fetch: async (_url, init) => {
        capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
        return new Response(JSON.stringify({ bases: [] }), { status: 200 });
      },
      env: {},
      configPath: claudeJson,
      cacheDir: tmp,
      runId: "run-5",
    });
    expect(capturedAuth).toBe("Bearer patFromClaudeJson");
  });

  test("throws clear error when no token can be resolved", async () => {
    await expect(
      listBases({
        fetch: okFetch({ bases: [] }),
        env: {},
        configPath: join(tmp, "missing.json"),
        cacheDir: tmp,
        runId: "run-6",
      }),
    ).rejects.toThrow(/AIRTABLE_API_KEY/);
  });

  test("throws when Airtable returns non-2xx", async () => {
    await expect(
      listBases({
        fetch: async () =>
          new Response(JSON.stringify({ error: { type: "AUTHENTICATION_REQUIRED" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
        env: { AIRTABLE_API_KEY: "patFake.token" },
        cacheDir: tmp,
        runId: "run-7",
      }),
    ).rejects.toThrow(/Airtable.*401/);
  });

  test("paginates via offset until all bases collected", async () => {
    const pages = [
      {
        bases: [{ id: "appA", name: "Alpha", permissionLevel: "read" }],
        offset: "page2",
      },
      {
        bases: [{ id: "appB", name: "Beta", permissionLevel: "read" }],
      },
    ];
    let i = 0;
    const result = await listBases({
      fetch: async () =>
        new Response(JSON.stringify(pages[i++]), { status: 200 }),
      env: { AIRTABLE_API_KEY: "patFake.token" },
      cacheDir: tmp,
      runId: "run-8",
    });
    expect(result.bases.map((b) => b.id)).toEqual(["appA", "appB"]);
  });
});
