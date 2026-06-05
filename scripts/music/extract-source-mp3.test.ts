import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractSourceMp3, sanitizeTitle, targetPath } from "./extract-source-mp3";

describe("sanitizeTitle", () => {
  test("strips path-unsafe characters", () => {
    expect(sanitizeTitle('a/b\\c:d*e?f"g<h>i|j')).toBe("a-b-c-d-e-f-g-h-i-j");
  });

  test("collapses whitespace and hyphen runs, trims edges", () => {
    expect(sanitizeTitle("  Hello   World  ")).toBe("Hello-World");
    expect(sanitizeTitle("a -- b")).toBe("a-b");
  });

  test("keeps Vietnamese diacritics (retrieval-critical)", () => {
    expect(sanitizeTitle("Mộng Phồn Hoa")).toBe("Mộng-Phồn-Hoa");
  });

  test("empty / all-unsafe title falls back to 'untitled'", () => {
    expect(sanitizeTitle("")).toBe("untitled");
    expect(sanitizeTitle("///")).toBe("untitled");
  });
});

describe("targetPath", () => {
  test("is absolute and ends with sanitized <title>.mp3", () => {
    const p = targetPath("./songs/in", "My Song");
    expect(p.startsWith("/")).toBe(true);
    expect(p.endsWith("/songs/in/My-Song.mp3")).toBe(true);
  });
});

describe("extractSourceMp3 — idempotency + download branch (offline via seams)", () => {
  let inputDir: string;

  beforeEach(() => {
    inputDir = mkdtempSync(join(tmpdir(), "extract-src-"));
  });
  afterEach(() => {
    rmSync(inputDir, { recursive: true, force: true });
  });

  test("downloads when the target is absent, returns absolute path", async () => {
    let downloaded = "";
    const res = await extractSourceMp3({
      url: "https://example/watch?v=abc",
      inputDir,
      _fetchTitle: () => "Track One",
      _download: (_url, out) => {
        downloaded = out;
        writeFileSync(out, "FAKE_MP3"); // simulate yt-dlp writing the file
      },
    });
    expect(res.skipped).toBe(false);
    expect(res.path).toBe(resolve(join(inputDir, "Track-One.mp3")));
    expect(downloaded).toBe(res.path);
    expect(existsSync(res.path)).toBe(true);
  });

  test("re-run on the same URL is a no-op (file exists → download not called)", async () => {
    // Pre-create the file the title resolves to.
    writeFileSync(join(inputDir, "Track-One.mp3"), "ALREADY_HERE");
    let downloadCalls = 0;
    const res = await extractSourceMp3({
      url: "https://example/watch?v=abc",
      inputDir,
      _fetchTitle: () => "Track One",
      _download: () => {
        downloadCalls++;
      },
    });
    expect(res.skipped).toBe(true);
    expect(downloadCalls).toBe(0);
    expect(res.path).toBe(resolve(join(inputDir, "Track-One.mp3")));
  });

  test("throws if downloader reports success but no file lands", async () => {
    await expect(
      extractSourceMp3({
        url: "https://example/watch?v=abc",
        inputDir,
        _fetchTitle: () => "Ghost",
        _download: () => {
          /* writes nothing */
        },
      }),
    ).rejects.toThrow(/missing/i);
  });
});
