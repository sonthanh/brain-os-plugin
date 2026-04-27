import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mixConcat } from "./mix-concat";

let workDir: string;
let inputDir: string;
let outputDir: string;

const SR = 44100;

function genSine(path: string, durationSec: number, freqHz: number): void {
  const result = spawnSync(
    "ffmpeg",
    [
      "-y", "-f", "lavfi",
      "-i", `sine=frequency=${freqHz}:duration=${durationSec}:sample_rate=${SR}`,
      "-c:a", "libmp3lame", "-b:a", "128k", path,
    ],
    { stdio: "ignore" },
  );
  if (result.status !== 0) throw new Error(`ffmpeg gen failed for ${path}`);
}

function probeDurationSec(path: string): number {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`ffprobe failed for ${path}`);
  return Number.parseFloat(result.stdout.trim());
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "mix-concat-"));
  inputDir = join(workDir, "in");
  outputDir = join(workDir, "out");
  // mkdir handled by mixConcat; create input dir for fixtures
  spawnSync("mkdir", ["-p", inputDir, outputDir]);
  genSine(join(inputDir, "01-alpha.mp3"), 6, 440);
  genSine(join(inputDir, "02-beta.mp3"), 6, 523);
  genSine(join(inputDir, "03-gamma.mp3"), 6, 659);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("mixConcat — 3 tracks", () => {
  test("produces mix mp3 + tracklist.txt at expected paths (tracer)", async () => {
    const mixPath = join(outputDir, "mix.mp3");
    const tracklistPath = join(outputDir, "mix.tracklist.txt");
    await mixConcat({ inputDir, outputPath: mixPath, tracklistPath, crossfadeSec: 5 });
    expect(existsSync(mixPath)).toBe(true);
    expect(existsSync(tracklistPath)).toBe(true);
  });

  test("mix duration ≈ Σ(input_durations) − 5s × (N−1)", async () => {
    const mixPath = join(outputDir, "mix2.mp3");
    const tracklistPath = join(outputDir, "mix2.tracklist.txt");
    await mixConcat({ inputDir, outputPath: mixPath, tracklistPath, crossfadeSec: 5 });
    // 3 × 6s = 18s − 5s × 2 = 8s expected
    const actual = probeDurationSec(mixPath);
    expect(actual).toBeGreaterThanOrEqual(7);
    expect(actual).toBeLessThanOrEqual(9);
  });

  test("tracklist has 3 lines, MM:SS - <title> format with cumulative crossfade-aware timestamps", async () => {
    const mixPath = join(outputDir, "mix3.mp3");
    const tracklistPath = join(outputDir, "mix3.tracklist.txt");
    await mixConcat({ inputDir, outputPath: mixPath, tracklistPath, crossfadeSec: 5 });
    const lines = readFileSync(tracklistPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(3);
    // Format: MM:SS - <title>
    for (const line of lines) {
      expect(line).toMatch(/^\d{2}:\d{2} - .+/);
    }
    // Track 1 starts at 00:00, track 2 at 00:01 (6s − 5s crossfade), track 3 at 00:02 (12 − 10 = 2)
    expect(lines[0]).toMatch(/^00:00 - 01-alpha/);
    expect(lines[1]).toMatch(/^00:01 - 02-beta/);
    expect(lines[2]).toMatch(/^00:02 - 03-gamma/);
  });

  test("idempotent: re-running overwrites existing output", async () => {
    const mixPath = join(outputDir, "mix4.mp3");
    const tracklistPath = join(outputDir, "mix4.tracklist.txt");
    await mixConcat({ inputDir, outputPath: mixPath, tracklistPath, crossfadeSec: 5 });
    writeFileSync(tracklistPath, "STALE_CONTENT");
    await mixConcat({ inputDir, outputPath: mixPath, tracklistPath, crossfadeSec: 5 });
    const content = readFileSync(tracklistPath, "utf8");
    expect(content).not.toContain("STALE_CONTENT");
  });
});

describe("mixConcat — edge cases", () => {
  test("single-track input: mix mp3 produced without crossfade error", async () => {
    const singleDir = join(workDir, "single-in");
    spawnSync("mkdir", ["-p", singleDir]);
    genSine(join(singleDir, "only.mp3"), 4, 440);
    const mixPath = join(outputDir, "mix-single.mp3");
    const tracklistPath = join(outputDir, "mix-single.tracklist.txt");
    await mixConcat({ inputDir: singleDir, outputPath: mixPath, tracklistPath, crossfadeSec: 5 });
    expect(existsSync(mixPath)).toBe(true);
    const dur = probeDurationSec(mixPath);
    expect(dur).toBeGreaterThanOrEqual(3.5);
    expect(dur).toBeLessThanOrEqual(4.5);
    const lines = readFileSync(tracklistPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/^00:00 - only/);
  });

  test("empty input dir: throws", async () => {
    const emptyDir = join(workDir, "empty-in");
    spawnSync("mkdir", ["-p", emptyDir]);
    const mixPath = join(outputDir, "mix-empty.mp3");
    const tracklistPath = join(outputDir, "mix-empty.tracklist.txt");
    await expect(
      mixConcat({ inputDir: emptyDir, outputPath: mixPath, tracklistPath, crossfadeSec: 5 }),
    ).rejects.toThrow(/no mp3/i);
  });
});
