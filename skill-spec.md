# Brain OS Skill Specification

Canonical spec for skills inside `brain-os-plugin/skills/`. Each numbered section defines one cross-cutting convention that all skills inherit.

Sections §1–§10 are reserved for conventions documented elsewhere as they are formalized (frontmatter, usage block, phase protocol, eval format, source repo field, etc.).

---

## § 11 — Outcome logging

Every skill appends one line per run to `{vault}/daily/skill-outcomes/{skill}.log`. These logs feed `/improve` for pattern detection and skill learning.

### Format

Pipe-delimited, 7 required fields + optional trailing key=value pairs:

```
{date} | {skill} | {action} | {source_repo} | {output_path} | commit:{hash} | {result} [| key=value ...]
```

| Field | Description |
|-------|-------------|
| `date` | `YYYY-MM-DD` |
| `skill` | Skill name (e.g., `grill`, `self-learn`) |
| `action` | Skill-specific action (e.g., `triage`, `extract`, `audit`) |
| `source_repo` | Path to the source repo (e.g., `~/work/brain-os-plugin`) |
| `output_path` | Vault-relative path to main output artifact |
| `commit:{hash}` | Git commit hash of output, or `commit:N/A` if no commit |
| `result` | `pass`, `partial`, or `fail` |

### Optional trailing fields

- `corrections=N` — number of user corrections needed (higher = stronger failure signal)
- `args="..."` — original input/topic (replayed as eval case by `/improve`)
- `score=N.N` — rubric score from evaluator (correlate with result for severity)
- `interrupt="..."` — user-stated reason for stopping (explicit failure reason)

Unknown keys are ignored (forward-compat). Missing trailing fields are fine (backwards-compat).

### Result criteria

Each skill defines its own pass/partial/fail logic in its `## Outcome log` section. General guidance:

- `pass` — skill completed successfully, output accepted
- `partial` — completed but with corrections, gaps, or user modifications
- `fail` — errored, blocked, or output rejected

### Rules

- Append-only. Never overwrite or rotate log files.
- Log AFTER the skill completes its work (not before).
- Use vault-relative paths for `output_path` (e.g., `daily/journal/2026-04-13-journey.md`).
- Skills that produce no artifact (e.g., `/status`) use `output_path=N/A`.
- Skills with multiple phases log once at the end, not per-phase.

---

## § 12 — Skill trace capture

Every skill invocation is automatically traced by the `trace-capture.sh` PostToolUse hook (registered in `hooks/hooks.json`, fires on all tools). The hook writes one JSON line per tool call to `{vault}/daily/skill-traces/{skill}.jsonl`. This trace layer sits underneath the existing outcome logs (`daily/skill-outcomes/{skill}.log`) and feeds `/improve` Phase 1 signal collection.

Skills do not need to emit traces manually. Do not write to `daily/skill-traces/` from inside a skill — the hook owns that path.

### Boundary protocol

A skill "run" begins when the `Skill` tool is invoked and ends when either (a) another `Skill` tool is invoked or (b) the session ends. The boundary is tracked via a state file at `${TMPDIR}/claude-trace/{session_id}.skill` containing the currently-active skill name. `session-end.sh` clears this file so concurrent sessions don't leak state.

Nested skill invocations collapse to the most recent one — whichever skill was invoked last owns subsequent tool calls until it's replaced or the session ends. This is a deliberate simplification; if nesting semantics matter later, add a stack.

### JSONL schema

Two event types. Every line is a single JSON object with these common fields:

- `ts` — ISO 8601 UTC timestamp (`date -u +%Y-%m-%dT%H:%M:%SZ`)
- `event` — `"skill_start"` or `"tool_call"`
- `skill` — sanitized skill name (plugin prefix stripped: `brain-os:grill` → `grill`)
- `session` — Claude Code session ID (for correlating lines from the same run)

**`skill_start`** additionally contains:
- `args` — the `args` field passed to the `Skill` tool (may be empty string)

**`tool_call`** additionally contains:
- `tool` — the tool name (`Read`, `Edit`, `Bash`, `Grep`, etc.)
- `input` — a minimal summary object (never the full `tool_input`, to avoid content bloat and leakage):
  - `Read`/`Edit`/`Write` → `{file: <path>}`
  - `Glob` → `{path: <path>}`
  - `Grep` → `{pattern, glob, type}`
  - `Bash` → `{command: <first 120 chars>}`
  - `WebFetch`/`WebSearch` → `{url}` / `{query: <first 120 chars>}`
  - `Skill` (internal reinvocation) → `{skill: <raw>}`
  - Agent/Task → `{description: <first 80 chars>}`
  - Other → `{}`

Never record `tool_response`. The goal is a cheap signal for pattern mining, not a full replay log.

### File naming & rotation

- One file per skill: `daily/skill-traces/{skill}.jsonl`
- Append-only. No rotation yet — `/vault-lint` will handle pruning when file size becomes a concern.
- Gitignored in `brain/.gitignore` (`daily/skill-traces/`). Traces are local telemetry, not committed vault content.

### Consumer contract

`/improve` Phase 1 (parser upgrade is a separate task) reads these JSONL files to extract behavioral patterns per skill: what tools are called, in what order, how often a skill corrects itself mid-run. The parser should tolerate unknown fields so this schema can grow without breaking older lines.

### Failure mode

The hook always exits 0. Trace capture must never block tool execution, even when `jq` is missing, the vault path can't be resolved, or the trace directory is unwritable. Silent drop is the correct behavior — a missing trace is strictly better than a blocked user action.
