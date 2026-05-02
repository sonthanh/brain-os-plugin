---
name: transcribe-video
description: "Transcribe YouTube/podcast/audio URL ra clean text. Auto-captions trước, fallback whisper-cpp + Silero VAD. Use trước khi /research video/audio source, hoặc user nói 'transcribe'/'get the transcript'/'get raw quotes from'."
context: fork
---

# /transcribe-video URL [--out PATH] [--whisper] [--model MODEL] [--prompt TEXT] [--keep-vtt]

## When to invoke

**Always before any research/finding extraction from a video or audio source.** Aggregator articles and same-cycle summaries hallucinate quotes — they conflate quotes from different talks by the same person. The verbatim transcript is the only trustable primary source.

Trigger conditions:
- `/research` is given a YouTube / podcast URL as the source
- User says "transcribe this," "get the transcript," "show me what they actually said"
- User pushes back on an aggregator-sourced report ("did they really say that?")
- A finding cites a video URL but quote provenance is `[paraphrase]` or `[aggregator]`

Skip conditions:
- Source is text (article, blog, gist) — go straight to WebFetch
- A `_transcript-verbatim.md` already exists for this URL in the findings folder

## Output contract

The script writes two files:

| File | Content |
|------|---------|
| `<out>/_transcript-verbatim.md` | Cleaned, paragraph-reflowed transcript with frontmatter (source URL, voice, method, capture date) |
| `<out>/_transcription-metadata.json` | Build metadata: word count, method used, repetition zones detected, model + prompt, runtime |

The verbatim file is the source-of-truth artifact. Findings, reports, and content angles cite **only** quotes that grep into this file. Everything else is paraphrase and must be source-tagged.

## Two transcription paths

### Path A — auto-captions (default)

`yt-dlp --write-auto-subs --sub-langs en` → fetch VTT → strip karaoke tags → dedupe consecutive lines → reflow into paragraphs.

- **Speed:** ~5 seconds for a 30-min video
- **Cost:** zero (no model)
- **Coverage:** complete (every spoken phrase)
- **Quality:** auto-caption typos on proper nouns (Claude Code → "lot code," OpenCode → "open claw," vibe coding → "vivibe coding," ChatGPT → "ChachiPT," etc.)
- **Mitigation:** the script applies a known-typo replacement table (`references/typo-fixes.json`); maintain it as new patterns surface

### Path B — whisper-cpp (`--whisper` flag)

Download audio via yt-dlp → convert to 16kHz mono wav → run whisper-cli with Silero VAD + topic-seeded initial prompt.

- **Speed:** ~3-4 minutes for a 30-min talk on Apple Silicon (large-v3-turbo)
- **Cost:** zero (local model, ~1.6GB on disk)
- **Coverage:** can drop into degenerate repetition loops on certain content (whisper.cpp known issue)
- **Quality:** much better proper-noun recognition; Opus 4.7 / Codex 5.4 / Claude Code captured directly
- **Mitigation:** the script detects repetition loops (5+ identical consecutive phrases) and falls back to the auto-caption text in those zones, splicing the two sources by timestamp

When to use whisper:
- Auto-caption typos make quotes unusable for direct citation
- The video has accents / multiple speakers / technical jargon the auto-caption mangles
- User explicitly asks for "best quality transcript"

When NOT to use whisper:
- 30-second clip — auto-subs are fine
- User just wants a quick read of "what was said" — auto-subs more than enough

### Recommended decision

Default to auto-subs. Re-run with `--whisper` if a finding's verbatim quote contains a typo'd proper noun the user will want to cite.

## Initial prompt for whisper

`--prompt` seeds whisper's context with topic-relevant proper nouns. Without a prompt, whisper hallucinates novel spellings ("OpenClaw" / "CORTCO" / "JSON things"). Pull the prompt from:
1. `--prompt "..."` flag if user provided
2. The video title + description (yt-dlp `--get-title --get-description`)
3. Topic terms from the surrounding `/research` context

Always include in the prompt: speaker name(s), event name, and 5–10 likely proper nouns / acronyms.

## Storage convention

Default output path: `{vault}/knowledge/research/findings/{slug}/`. Where `slug` is derived from `--slug` flag, the calling skill's findings dir, or `<voice>-<topic>` from yt-dlp metadata.

If the calling skill is `/research`, write to `{vault}/knowledge/research/findings/{research-slug}/_transcript-verbatim.md` so subsequent finding files in the same folder can `[[wiki-link]]` it.

## Wiring into /research

When `/research` is invoked with a URL that's a YouTube watch link, podcast RSS item, or other audio/video source:

1. Run `/transcribe-video` first, write to the research's findings folder
2. Then proceed with normal research flow, but constrain quote-extraction to the verbatim file (NOT same-cycle aggregator articles)
3. Source-tag findings as `[primary — verbatim]` not `[paraphrase]` or `[aggregator]`
4. Aggregator articles can still inform structure (which topics matter) but never source quotes

## Script

`${CLAUDE_PLUGIN_ROOT}/scripts/transcribe-video.ts` — TS+bun per global rule.

Direct invoke:
```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/transcribe-video.ts <URL> --out <DIR> [--whisper] [--prompt "...."]
```

## Setup (one-time)

The script requires:
- `yt-dlp` (`brew install yt-dlp`)
- `ffmpeg` (`brew install ffmpeg`)
- For whisper path: `whisper-cli` (`brew install whisper-cpp`) + model files (auto-downloaded to `~/.cache/whisper-models/` on first whisper run)

If a dependency is missing, the script prints a single-line install command and exits with code 2. Don't try to auto-install — let the user run it.

## Examples

```bash
# default — auto-subs, save to current research findings dir
bun scripts/transcribe-video.ts https://www.youtube.com/watch?v=96jN2OCOfLs --out knowledge/research/findings/karpathy-vibe-to-agentic

# high quality with whisper, with topic-seeded prompt
bun scripts/transcribe-video.ts https://www.youtube.com/watch?v=96jN2OCOfLs \
  --out knowledge/research/findings/karpathy-vibe-to-agentic \
  --whisper \
  --prompt "Andrej Karpathy at Sequoia AI Ascent 2026. Topics: vibe coding, agentic engineering, Software 1.0/2.0/3.0, Claude Code, OpenCode, Codex, NanoGPT, jaggedness, verifiability, Menugen, Nano Banana."
```

## Failure modes & mitigations

| Failure | Cause | Mitigation |
|---------|-------|------------|
| Repetition loop in whisper output | Beam search degenerate state on long silence / repeated content | Script detects + splices auto-sub text into repetition zone |
| Auto-subs unavailable | Channel disabled subs / region-locked | Auto-fall back to whisper |
| URL is not YouTube | Generic audio file | Skip yt-dlp subs path, go straight to ffmpeg + whisper |
| Whisper missing model | First run | Auto-download `large-v3-turbo` (1.6GB) + Silero VAD (885KB) — happens once, ~30 sec on fast network |
| Wrong proper nouns in auto-subs | Caption upload defaults | Apply `references/typo-fixes.json` post-process; user can extend the file |

## Maintenance

`references/typo-fixes.json` — keep current. When a transcript has a new misheard proper noun, add it. The file is sorted by precedence (longer phrases first to avoid partial-match collisions).

When whisper-cli or yt-dlp behavior shifts (e.g. a new flag default), update the script. Keep the SKILL.md decision rules stable — those are the contract with calling skills.
