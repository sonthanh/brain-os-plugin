#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

export interface MixConcatOptions {
  inputDir: string;
  outputPath: string;
  tracklistPath: string;
  crossfadeSec: number;
}

export interface MixConcatResult {
  mixPath: string;
  tracklistPath: string;
  totalDurationSec: number;
}

export async function mixConcat(opts: MixConcatOptions): Promise<MixConcatResult> {
  const { inputDir, outputPath, tracklistPath, crossfadeSec } = opts;
  const tracks = readdirSync(inputDir)
    .filter((f) => f.toLowerCase().endsWith(".mp3"))
    .sort()
    .map((f) => join(inputDir, f));
  if (tracks.length === 0) throw new Error(`no mp3 files in ${inputDir}`);

  mkdirSync(dirname(outputPath), { recursive: true });
  mkdirSync(dirname(tracklistPath), { recursive: true });

  const durations = tracks.map(probeDurationSec);
  await runFfmpegCrossfade(tracks, outputPath, crossfadeSec);

  const lines: string[] = [];
  let cursorSec = 0;
  for (let i = 0; i < tracks.length; i++) {
    const title = basename(tracks[i], extname(tracks[i]));
    lines.push(`${formatMmSs(cursorSec)} - ${title}`);
    cursorSec += durations[i];
    if (i < tracks.length - 1) cursorSec -= crossfadeSec;
  }
  // Overwrite (idempotent).
  writeFileSync(tracklistPath, lines.join("\n") + "\n");

  const totalDurationSec = cursorSec;
  return { mixPath: outputPath, tracklistPath, totalDurationSec };
}

function probeDurationSec(path: string): number {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`ffprobe failed for ${path}: ${result.stderr}`);
  return Number.parseFloat(result.stdout.trim());
}

function formatMmSs(totalSec: number): string {
  const total = Math.floor(totalSec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

async function runFfmpegCrossfade(
  tracks: string[],
  outputPath: string,
  crossfadeSec: number,
): Promise<void> {
  const args: string[] = ["-y"];
  for (const t of tracks) args.push("-i", t);

  if (tracks.length === 1) {
    args.push("-c:a", "libmp3lame", "-b:a", "192k", outputPath);
  } else {
    // Chain acrossfade: [0][1]→[a1]; [a1][2]→[a2]; ...
    const filterParts: string[] = [];
    let prev = "[0:a]";
    for (let i = 1; i < tracks.length; i++) {
      const out = i === tracks.length - 1 ? "[out]" : `[a${i}]`;
      filterParts.push(`${prev}[${i}:a]acrossfade=d=${crossfadeSec}:c1=tri:c2=tri${out}`);
      prev = out;
    }
    args.push(
      "-filter_complex", filterParts.join(";"),
      "-map", "[out]",
      "-c:a", "libmp3lame", "-b:a", "192k",
      outputPath,
    );
  }

  await new Promise<void>((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.split("\n").slice(-10).join("\n")}`));
    });
  });
}

// CLI
if (import.meta.main) {
  const args = process.argv.slice(2);
  let style = "";
  let inputDir = "./songs/accepted";
  let outputDir = "./mixes";
  let crossfadeSec = 5;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--style") style = args[++i];
    else if (a === "--input") inputDir = args[++i];
    else if (a === "--output") outputDir = args[++i];
    else if (a === "--crossfade") crossfadeSec = Number.parseInt(args[++i], 10);
  }
  if (!style) {
    console.error("usage: mix-concat.ts --style <slug> [--input <dir>] [--output <dir>] [--crossfade <sec>]");
    process.exit(1);
  }
  const date = new Date().toISOString().slice(0, 10);
  const outputPath = join(outputDir, `${date}-${style}.mp3`);
  const tracklistPath = join(outputDir, `${date}-${style}.tracklist.txt`);
  const result = await mixConcat({ inputDir, outputPath, tracklistPath, crossfadeSec });
  console.log(`mix:       ${result.mixPath}`);
  console.log(`tracklist: ${result.tracklistPath}`);
  console.log(`duration:  ${result.totalDurationSec.toFixed(1)}s`);
}
