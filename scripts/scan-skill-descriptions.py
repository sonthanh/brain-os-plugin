#!/usr/bin/env python3
"""scan-skill-descriptions.py — flag bloated SKILL.md frontmatter descriptions.

Walks source-repo skill directories, extracts each SKILL.md's frontmatter
`description` field, and applies five bloat detectors. Output: a sorted table
ranked by signal count and char length, with per-skill reasons.

Reads source repos only (never installed plugin copies). Default discovery is
`~/work/*/skills/*/SKILL.md`. Override with `--repo PATH` (repeatable).

Used by `/improve descriptions`. Also exposes a `--describe` mode that runs the
detectors against a single description string for eval fixtures.

Detection rules:
  HARD - chars > 300
  HARD - 2+ numbered workflow steps ((1) ... (2) ... or 1. ... 2. ...)
  HARD - 2+ line breaks within description (multi-paragraph)
  SOFT - 2+ distinct invocation flags (--flag) — single flag is a trigger keyword
  SOFT - 2+ distinct technical thresholds (Cut N, ≥N%, max N rounds, N+ words)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

MAX_CHARS = 300
NUMBERED_MIN = 2
LINEBREAK_MIN = 2  # YAML `|` block separates 3 paragraphs with 2 newlines.
FLAG_DISTINCT_MIN = 2
THRESHOLD_DISTINCT_MIN = 2


def default_repos() -> list[Path]:
    """Discover source repos under `~/work/` that contain a `skills/` directory."""
    base = Path.home() / "work"
    if not base.exists():
        return []
    return sorted(p for p in base.glob("*/skills") if p.is_dir())


@dataclass
class Signal:
    name: str
    reason: str


def extract_description(skill_md: Path) -> str | None:
    """Pull the `description:` value out of YAML frontmatter.

    Handles two shapes:
      description: "single line"
      description: |
        block
        scalar
    """
    text = skill_md.read_text(encoding="utf-8")
    m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    if not m:
        return None
    fm = m.group(1)
    dm = re.search(r"^description:\s*(.*)$", fm, re.MULTILINE)
    if not dm:
        return None
    val = dm.group(1).strip()
    if val in ("|", ">"):
        lines = fm.split("\n")
        idx = next(i for i, line in enumerate(lines) if line.startswith("description:"))
        block: list[str] = []
        for line in lines[idx + 1 :]:
            if line.startswith(" ") or line == "":
                block.append(line.strip())
            else:
                break
        if val == "|":
            return "\n".join(block).strip()
        return " ".join(b for b in block if b)
    return val.strip('"').strip("'")


def detect_too_long(desc: str) -> Signal | None:
    if len(desc) > MAX_CHARS:
        return Signal("chars", f">{MAX_CHARS} ({len(desc)})")
    return None


def detect_numbered_steps(desc: str) -> Signal | None:
    paren = re.findall(r"\(\d+\)", desc)
    enum = re.findall(r"(?:^|[\s.])\d+\.\s", desc)
    if len(paren) >= NUMBERED_MIN:
        return Signal("numbered", f"{len(paren)} '(N)' steps")
    if len(enum) >= NUMBERED_MIN:
        return Signal("numbered", f"{len(enum)} 'N.' steps")
    return None


def detect_multi_paragraph(desc: str) -> Signal | None:
    breaks = desc.count("\n")
    if breaks >= LINEBREAK_MIN:
        return Signal("multi-para", f"{breaks} line breaks")
    return None


def detect_invocation_flags(desc: str) -> Signal | None:
    flags = set(re.findall(r"(?<![A-Za-z])--[a-z][a-z0-9-]*", desc))
    if len(flags) >= FLAG_DISTINCT_MIN:
        return Signal("flags", f"{len(flags)} flags: {' '.join(sorted(flags))}")
    return None


THRESHOLD_PATTERNS = [
    (r"\bCut\s+\d+", "Cut N"),
    (r"≥\s*\d+\s*%|>=\s*\d+\s*%", "≥N% gate"),
    (r"\bmax\s+\d+\s+(rounds|tries|attempts|tokens)", "max N rounds"),
    (r"\d{3,}\+?\s*(words|từ|chars|tokens)", "word count"),
    (r"\bscore\s*[<>=]+\s*\d", "score threshold"),
]


def detect_thresholds(desc: str) -> Signal | None:
    hits = [label for pat, label in THRESHOLD_PATTERNS if re.search(pat, desc, re.IGNORECASE)]
    distinct = sorted(set(hits))
    if len(distinct) >= THRESHOLD_DISTINCT_MIN:
        return Signal("thresholds", f"{len(distinct)} thresholds: {', '.join(distinct)}")
    return None


DETECTORS: list[Callable[[str], Signal | None]] = [
    detect_too_long,
    detect_numbered_steps,
    detect_multi_paragraph,
    detect_invocation_flags,
    detect_thresholds,
]


def run_detectors(desc: str) -> list[Signal]:
    return [s for det in DETECTORS if (s := det(desc))]


def trim_token_estimate(chars: int, target: int = 200) -> int:
    """Rough token saving estimate: ~4 chars/token."""
    saved_chars = max(0, chars - target)
    return saved_chars // 4


def scan(repos: list[Path]) -> list[dict]:
    rows: list[dict] = []
    base = Path.home() / "work"
    for repo in repos:
        skills_dir = repo if repo.name == "skills" else repo / "skills"
        if not skills_dir.is_dir():
            continue
        for path in sorted(skills_dir.glob("*/SKILL.md")):
            desc = extract_description(path)
            if not desc:
                continue
            signals = run_detectors(desc)
            if not signals:
                continue
            try:
                rel = path.relative_to(base)
            except ValueError:
                rel = path
            rows.append({
                "path": str(rel),
                "skill": path.parent.name,
                "chars": len(desc),
                "signals": [{"name": s.name, "reason": s.reason} for s in signals],
                "est_token_savings": trim_token_estimate(len(desc)),
            })
    rows.sort(key=lambda r: (-len(r["signals"]), -r["chars"]))
    return rows


def print_table(rows: list[dict]) -> None:
    if not rows:
        print("=== Description bloat scan ===\n\nNo flagged skills. Descriptions are clean.")
        return
    print("=== Description bloat scan ===\n")
    total_savings = 0
    for i, r in enumerate(rows, 1):
        reasons = " | ".join(s["reason"] for s in r["signals"])
        print(f"  [{i}] {r['path']}")
        print(f"      {r['chars']} chars  →  ~{r['est_token_savings']} tokens potential savings")
        print(f"      {reasons}")
        total_savings += r["est_token_savings"]
    print(f"\nTotal: {len(rows)} skill(s) flagged, ~{total_savings} tokens potential savings")


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--repo", action="append", help="Source-repo path (repeatable). Default: ~/work/*/skills/.")
    p.add_argument("--json", action="store_true", help="Emit JSON instead of human-readable table.")
    p.add_argument("--describe", help="Run detectors against a single description string and emit JSON.")
    p.add_argument("--describe-stdin", action="store_true", help="Read description from stdin and emit JSON.")
    args = p.parse_args(argv)

    if args.describe is not None or args.describe_stdin:
        desc = args.describe if args.describe is not None else sys.stdin.read().strip()
        signals = run_detectors(desc)
        out = {
            "chars": len(desc),
            "flagged": bool(signals),
            "signals": [{"name": s.name, "reason": s.reason} for s in signals],
        }
        print(json.dumps(out, ensure_ascii=False))
        return 0

    repos = [Path(r).expanduser() for r in (args.repo or [])] or default_repos()
    rows = scan(repos)
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    else:
        print_table(rows)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
