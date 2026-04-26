#!/usr/bin/env python3
"""check-trunk-paths.py — match paths from stdin against trunk-paths.txt globs.

Usage:
    cat paths.txt | python3 check-trunk-paths.py <trunk-paths.txt>

Output: tab-separated `<path>\t<matched-pattern>` per matching path.
Exit: 0 = no matches, 1 = matches found, 2 = usage error.

Honors git's `:(glob)` pathspec semantics:
- leading `**/`  → zero or more path components
- other `**`     → any chars including `/`
- `*`            → any chars except `/`
- `?`            → any single non-`/` char

Single source of truth used by:
- hooks/pre-commit-trunk-block.sh (PreToolUse Bash gate on AFK commits)
- skills/slice/SKILL.md           (slice Files: validator step)
"""

import re
import sys


def glob_to_regex(pattern: str) -> re.Pattern:
    out = []
    i = 0
    while i < len(pattern):
        if pattern[i:i + 3] == '**/':
            out.append(r'(?:.+/)?')
            i += 3
        elif pattern[i:i + 2] == '**':
            out.append(r'.*')
            i += 2
        elif pattern[i] == '*':
            out.append(r'[^/]*')
            i += 1
        elif pattern[i] == '?':
            out.append(r'[^/]')
            i += 1
        elif pattern[i] in '.+()[]{}|^$\\':
            out.append('\\' + pattern[i])
            i += 1
        else:
            out.append(pattern[i])
            i += 1
    return re.compile('^' + ''.join(out) + '$')


def main() -> int:
    if len(sys.argv) < 2:
        print('usage: check-trunk-paths.py <trunk-paths.txt>', file=sys.stderr)
        return 2

    patterns_file = sys.argv[1]
    patterns = []
    try:
        with open(patterns_file) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#'):
                    patterns.append(line)
    except OSError as e:
        print(f'check-trunk-paths: {e}', file=sys.stderr)
        return 2

    compiled = [(p, glob_to_regex(p)) for p in patterns]

    hits = []
    for line in sys.stdin:
        path = line.strip()
        if not path:
            continue
        for pat, rx in compiled:
            if rx.match(path):
                hits.append((path, pat))
                break

    for path, pat in hits:
        print(f'{path}\t{pat}')

    return 1 if hits else 0


if __name__ == '__main__':
    sys.exit(main())
