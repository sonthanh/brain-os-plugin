#!/usr/bin/env bun
// Extract the audio of a YouTube (or yt-dlp-supported) URL to an mp3.
//
// Implements ai-brain#166. The issue asked for a ≤30-line bash wrapper, but the
// global scripting rule (TS+bun, no new bash beyond thin shebang/env wrappers)
// and the existing music tooling (mix-concat.ts) make TS the right home. Title
// sanitization + idempotency are *logic*, which the rule keeps out of bash.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ExtractOptions {
  url: string;
  inputDir: string; // where the mp3 lands, e.g. "./songs/in"
  // Test seams: default to the real yt-dlp-backed implementations. Underscore
  // prefix marks them internal — production callers never pass these.
  _fetchTitle?: (url: string) => string;
  _download?: (url: string, outPath: string) => void;
}

export interface ExtractResult {
  path: string; // absolute path to the mp3
  skipped: boolean; // true when the file already existed (no-op re-run)
}

/**
 * Turn a video title into a filesystem-safe basename. Keeps Unicode letters
 * (Vietnamese diacritics matter for retrieval) and only strips path-unsafe and
 * control characters, collapsing whitespace/separators to single hyphens.
 */
export function sanitizeTitle(title: string): string {
  const cleaned = title
    .normalize("NFC")
    .replace(/[\/\\:*?"<>|\x00-\x1f]+/g, "-") // path-unsafe + control chars
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "untitled";
}

/** Deterministic absolute path the mp3 will be written to for a given title. */
export function targetPath(inputDir: string, title: string): string {
  return resolve(join(inputDir, `${sanitizeTitle(title)}.mp3`));
}

function fetchTitle(url: string): string {
  const result = spawnSync(
    "yt-dlp",
    ["--no-playlist", "--skip-download", "--print", "%(title)s", url],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`yt-dlp could not read title for ${url}: ${(result.stderr || "").trim()}`);
  }
  // A URL can resolve to multiple lines if a playlist slips through; take the first.
  return result.stdout.split("\n")[0].trim();
}

function download(url: string, outPath: string): void {
  const result = spawnSync(
    "yt-dlp",
    [
      "--no-playlist",
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "0",
      // Force 44.1 kHz so downstream mixing has a uniform sample rate.
      "--postprocessor-args",
      "ffmpeg:-ar 44100",
      "-o",
      outPath,
      url,
    ],
    { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`yt-dlp failed for ${url}: ${(result.stderr || "").trim().split("\n").slice(-5).join("\n")}`);
  }
}

/**
 * Download `url`'s audio to `<inputDir>/<sanitized-title>.mp3` (44.1 kHz).
 * Idempotent: if the target already exists, no download happens.
 */
export async function extractSourceMp3(opts: ExtractOptions): Promise<ExtractResult> {
  const titleOf = opts._fetchTitle ?? fetchTitle;
  const downloadTo = opts._download ?? download;

  const title = titleOf(opts.url);
  const out = targetPath(opts.inputDir, title);

  if (existsSync(out)) return { path: out, skipped: true };

  mkdirSync(resolve(opts.inputDir), { recursive: true });
  downloadTo(opts.url, out);

  if (!existsSync(out)) {
    throw new Error(`yt-dlp reported success but ${out} is missing`);
  }
  return { path: out, skipped: false };
}

// CLI
if (import.meta.main) {
  const url = process.argv[2];
  let inputDir = "./songs/in";
  for (let i = 3; i < process.argv.length; i++) {
    if (process.argv[i] === "--input") inputDir = process.argv[++i];
  }
  if (!url) {
    console.error("usage: extract-source-mp3.ts <YT_URL> [--input <dir>]");
    process.exit(1);
  }
  try {
    const { path, skipped } = await extractSourceMp3({ url, inputDir });
    if (skipped) console.error(`skip (exists): ${path}`);
    console.log(path); // stdout = absolute mp3 path, scriptable
    process.exit(0);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
