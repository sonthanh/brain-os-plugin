#!/usr/bin/env bun
// Transcribe a YouTube / audio URL to clean verbatim text.
// See ../skills/transcribe-video/SKILL.md for usage contract.

import { $ } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

interface Args {
  url: string;
  out: string;
  whisper: boolean;
  model: string;
  prompt: string;
  keepVtt: boolean;
  slug?: string;
}

interface Metadata {
  url: string;
  title: string;
  voice?: string;
  method: "auto-subs" | "whisper" | "spliced";
  word_count: number;
  duration_seconds?: number;
  repetition_zones: number;
  whisper_model?: string;
  whisper_prompt?: string;
  runtime_seconds: number;
  captured_at: string;
}

const WHISPER_MODELS_DIR = join(homedir(), ".cache", "whisper-models");
const DEFAULT_WHISPER_MODEL = "ggml-large-v3-turbo.bin";
const DEFAULT_VAD_MODEL = "ggml-silero-v5.1.2.bin";
const WHISPER_MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const VAD_MODEL_URL = "https://huggingface.co/ggml-org/whisper-vad/resolve/main";

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { whisper: false, keepVtt: false, model: DEFAULT_WHISPER_MODEL, prompt: "" };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--whisper") args.whisper = true;
    else if (a === "--keep-vtt") args.keepVtt = true;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--prompt") args.prompt = argv[++i];
    else if (a === "--slug") args.slug = argv[++i];
    else if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 1) throw new Error("expected exactly one URL positional arg");
  args.url = positional[0];
  if (!args.out) throw new Error("--out <dir> is required");
  return args as Args;
}

async function checkDeps(needWhisper: boolean): Promise<void> {
  const required = needWhisper
    ? ["yt-dlp", "ffmpeg", "whisper-cli"]
    : ["yt-dlp"];
  const missing: string[] = [];
  for (const bin of required) {
    const r = await $`which ${bin}`.nothrow().quiet();
    if (r.exitCode !== 0) missing.push(bin);
  }
  if (missing.length > 0) {
    const installCmd = missing.includes("whisper-cli") || missing.includes("ffmpeg") || missing.includes("yt-dlp")
      ? `brew install ${missing.map(m => m === "whisper-cli" ? "whisper-cpp" : m).join(" ")}`
      : `install ${missing.join(", ")}`;
    console.error(`missing dependencies: ${missing.join(", ")}`);
    console.error(`install: ${installCmd}`);
    process.exit(2);
  }
}

async function ensureWhisperModels(modelName: string): Promise<{ model: string; vad: string }> {
  if (!existsSync(WHISPER_MODELS_DIR)) mkdirSync(WHISPER_MODELS_DIR, { recursive: true });
  const modelPath = join(WHISPER_MODELS_DIR, modelName);
  const vadPath = join(WHISPER_MODELS_DIR, DEFAULT_VAD_MODEL);
  if (!existsSync(modelPath)) {
    console.error(`downloading whisper model ${modelName} (~1.6GB, one-time)…`);
    const r = await $`curl -L --fail --progress-bar -o ${modelPath} ${WHISPER_MODEL_URL}/${modelName}`.nothrow();
    if (r.exitCode !== 0) {
      console.error("whisper model download failed");
      process.exit(2);
    }
  }
  if (!existsSync(vadPath)) {
    console.error(`downloading silero VAD (~900KB, one-time)…`);
    const r = await $`curl -L --fail --progress-bar -o ${vadPath} ${VAD_MODEL_URL}/${DEFAULT_VAD_MODEL}`.nothrow();
    if (r.exitCode !== 0) {
      console.error("VAD model download failed");
      process.exit(2);
    }
  }
  return { model: modelPath, vad: vadPath };
}

async function fetchVideoMetadata(url: string): Promise<{ title: string; duration: number; uploader: string }> {
  const fmt = "%(title)s|%(duration)d|%(uploader)s";
  const r = await $`yt-dlp --no-warnings --print ${fmt} --no-download ${url}`.quiet();
  const line = r.stdout.toString().trim();
  const [title, duration, uploader] = line.split("|");
  return { title, duration: parseInt(duration, 10), uploader };
}

async function downloadAutoSubs(url: string, workDir: string): Promise<string | null> {
  const subsBase = join(workDir, "subs");
  const langs = "en.*,en";
  const subFmt = "vtt/best";
  const outTpl = `${subsBase}.%(ext)s`;
  const r = await $`yt-dlp --no-warnings --skip-download --write-auto-subs --write-subs --sub-langs ${langs} --sub-format ${subFmt} -o ${outTpl} ${url}`.nothrow().quiet();
  if (r.exitCode !== 0) return null;
  const candidates = [`${subsBase}.en.vtt`, `${subsBase}.en-orig.vtt`];
  for (const c of candidates) if (existsSync(c)) return c;
  // glob any en*.vtt
  const ls = await $`ls ${workDir}`.quiet();
  for (const f of ls.stdout.toString().split("\n")) {
    if (f.startsWith("subs.en") && f.endsWith(".vtt")) return join(workDir, f);
  }
  return null;
}

function vttToText(vtt: string): string {
  const lines = vtt.split("\n");
  const out: string[] = [];
  let last = "";
  for (const raw of lines) {
    if (
      !raw.trim() ||
      raw.startsWith("WEBVTT") ||
      raw.startsWith("Kind:") ||
      raw.startsWith("Language:") ||
      raw.includes("-->") ||
      /^\d+$/.test(raw.trim())
    ) continue;
    const stripped = raw.replace(/<[^>]*>/g, "").trim();
    if (!stripped || stripped === last) continue;
    out.push(stripped);
    last = stripped;
  }
  return out.join("\n");
}

function reflowToParagraphs(text: string): string {
  // Join lines: if next line starts lowercase / punctuation, it continues. Capital letter starts new para.
  let result = text.replace(/\n(?=[a-z,;:\)\]])/g, " ");
  result = result.replace(/\n(?=[A-Z])/g, "\n\n");
  result = result.replace(/  +/g, " ");
  result = result.replace(/&gt;&gt;/g, ">>");
  return result;
}

// Scope hierarchy: a topic inherits all rules from its ancestors.
// e.g. topic "karpathy" inherits "ai" rules; "ai" inherits "global" rules.
const SCOPE_PARENTS: Record<string, string[]> = {
  karpathy: ["ai", "global"],
  ai: ["global"],
  global: [],
};

function scopeMatches(ruleScope: string | undefined, topicTag: string | null): boolean {
  if (!ruleScope || ruleScope === "global") return true;
  if (!topicTag) return false;
  if (ruleScope === topicTag) return true;
  const parents = SCOPE_PARENTS[topicTag] ?? [];
  return parents.includes(ruleScope);
}

async function applyTypoFixes(text: string, topicTag: string | null = null): Promise<string> {
  const refsPath = join(import.meta.dirname, "..", "skills", "transcribe-video", "references", "typo-fixes.json");
  if (!existsSync(refsPath)) return text;
  const refs = JSON.parse(await readFile(refsPath, "utf8"));
  let out = text;
  for (const rule of refs.rules) {
    if (!scopeMatches(rule.scope, topicTag)) continue;
    out = out.replace(new RegExp(rule.from, "g"), rule.to);
  }
  return out;
}

function detectRepetitionZones(text: string): { zones: number; markers: string[] } {
  // Look for any 4-word phrase that repeats 5+ times consecutively or near-consecutively.
  const sentences = text.split(/[.!?]\s+/);
  const markers: string[] = [];
  let zones = 0;
  let inZone = false;
  let lastFingerprint = "";
  let runCount = 0;
  for (const s of sentences) {
    const words = s.trim().split(/\s+/).slice(0, 4).join(" ").toLowerCase();
    if (words === lastFingerprint && words.length > 0) {
      runCount++;
      if (runCount >= 4 && !inZone) {
        zones++;
        inZone = true;
        markers.push(words);
      }
    } else {
      runCount = 0;
      inZone = false;
    }
    lastFingerprint = words;
  }
  return { zones, markers };
}

async function transcribeWhisper(
  url: string,
  workDir: string,
  modelPath: string,
  vadPath: string,
  prompt: string
): Promise<string> {
  const audioMp3 = join(workDir, "audio.mp3");
  const audioWav = join(workDir, "audio.wav");
  const outBase = join(workDir, "whisper-out");

  console.error("downloading audio…");
  const audioOutTpl = audioMp3.replace(/\.mp3$/, ".%(ext)s");
  await $`yt-dlp -x --audio-format mp3 --audio-quality 0 -o ${audioOutTpl} ${url}`.quiet();

  console.error("converting to 16kHz wav…");
  await $`ffmpeg -y -i ${audioMp3} -ar 16000 -ac 1 -c:a pcm_s16le ${audioWav}`.quiet();

  console.error("running whisper-cli with VAD + initial prompt…");
  const args = [
    "-m", modelPath,
    "-f", audioWav,
    "--vad",
    "-vm", vadPath,
    "-otxt",
    "-of", outBase,
    "-nt",
    "-t", "8",
    "--temperature", "0",
    "--temperature-inc", "0.2",
  ];
  if (prompt) args.push("--prompt", prompt);
  await $`whisper-cli ${args}`.quiet();
  return await readFile(`${outBase}.txt`, "utf8");
}

function inferTopicTag(metadata: { title: string; uploader: string }, prompt: string): string | null {
  const haystack = `${metadata.title} ${metadata.uploader} ${prompt}`.toLowerCase();
  if (haystack.includes("karpathy")) return "karpathy";
  if (haystack.includes("ai") || haystack.includes("llm") || haystack.includes("agent") || haystack.includes("coding")) return "ai";
  return null;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const args = parseArgs(process.argv.slice(2));
  await checkDeps(args.whisper);

  const outDir = resolve(args.out);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const workDir = join("/tmp", `transcribe-video-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });

  console.error(`fetching video metadata…`);
  const meta = await fetchVideoMetadata(args.url);
  const topicTag = inferTopicTag(meta, args.prompt);

  let text: string;
  let method: Metadata["method"];
  let repetitionZones = 0;
  let repetitionMarkers: string[] = [];

  if (args.whisper) {
    const { model, vad } = await ensureWhisperModels(args.model);
    const promptText = args.prompt || `${meta.uploader}. ${meta.title}.`;
    const raw = await transcribeWhisper(args.url, workDir, model, vad, promptText);
    text = await applyTypoFixes(raw, topicTag);
    const det = detectRepetitionZones(text);
    repetitionZones = det.zones;
    repetitionMarkers = det.markers;
    method = repetitionZones > 0 ? "spliced" : "whisper";
    if (repetitionZones > 0) {
      console.error(`whisper hit ${repetitionZones} repetition zone(s); auto-splicing from auto-subs…`);
      const vtt = await downloadAutoSubs(args.url, workDir);
      if (vtt) {
        const auto = await applyTypoFixes(reflowToParagraphs(vttToText(await readFile(vtt, "utf8"))), topicTag);
        // Naive splice: prefer whisper text, but if a whole paragraph is in repetition, replace with same-position auto-sub paragraph.
        // For now, append auto-sub coverage as fallback section so reader has both.
        text = text + "\n\n---\n\n## Auto-caption fallback (full coverage, lower quality on proper nouns)\n\n" + auto;
      }
    }
  } else {
    const vtt = await downloadAutoSubs(args.url, workDir);
    if (!vtt) {
      console.error("auto-subs not available; falling back to whisper");
      const { model, vad } = await ensureWhisperModels(args.model);
      const promptText = args.prompt || `${meta.uploader}. ${meta.title}.`;
      const raw = await transcribeWhisper(args.url, workDir, model, vad, promptText);
      text = await applyTypoFixes(raw, topicTag);
      method = "whisper";
    } else {
      const reflowed = reflowToParagraphs(vttToText(await readFile(vtt, "utf8")));
      text = await applyTypoFixes(reflowed, topicTag);
      method = "auto-subs";
    }
  }

  const wordCount = text.trim().split(/\s+/).length;

  const verbatim = `---
source: "${args.url}"
title: "${meta.title.replace(/"/g, '\\"')}"
voice: "${meta.uploader}"
captured: ${new Date().toISOString().slice(0, 10)}
method: "${method}"
word_count: ${wordCount}
${args.whisper ? `whisper_model: "${args.model}"\nwhisper_prompt: ${JSON.stringify(args.prompt)}\n` : ""}---

# Verbatim Transcript — ${meta.title}

> Captured ${new Date().toISOString().slice(0, 10)} via ${method === "auto-subs" ? "yt-dlp auto-subs (en) → reflow → typo-fix" : method === "whisper" ? "whisper-cpp + Silero VAD" : "whisper-cpp + auto-sub fallback"}. ${repetitionZones > 0 ? `**Note:** whisper hit ${repetitionZones} repetition zone(s); auto-sub fallback appended at end for full coverage.` : ""}

---

${text.trim()}
`;

  const verbatimPath = join(outDir, "_transcript-verbatim.md");
  await writeFile(verbatimPath, verbatim);
  console.error(`wrote ${verbatimPath} (${wordCount} words, method=${method})`);

  const metadata: Metadata = {
    url: args.url,
    title: meta.title,
    voice: meta.uploader,
    method,
    word_count: wordCount,
    duration_seconds: meta.duration,
    repetition_zones: repetitionZones,
    whisper_model: args.whisper ? args.model : undefined,
    whisper_prompt: args.whisper ? args.prompt : undefined,
    runtime_seconds: Math.round((Date.now() - t0) / 1000),
    captured_at: new Date().toISOString(),
  };
  await writeFile(join(outDir, "_transcription-metadata.json"), JSON.stringify(metadata, null, 2));

  if (!args.keepVtt) {
    await $`rm -rf ${workDir}`.nothrow().quiet();
  }
}

main().catch(err => {
  console.error("transcribe-video failed:", err.message ?? err);
  process.exit(1);
});
