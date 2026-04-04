#!/usr/bin/env python3
"""Generate a summary of self-learn progress across all phases for a given book.

Usage:
  python3 summary.py <vault_path>
  python3 summary.py <vault_path>/knowledge/raw/<book-slug>
  python3 summary.py <vault_path> --phase3   # Phase 3 only
  python3 summary.py <vault_path> --status   # Quick status
"""

import os
import sys
import json


def extract_note(filepath):
    """Extract title, key insight, tags, and chapter from a note."""
    content = open(filepath).read()
    title = os.path.basename(filepath).replace('.md', '').replace('-', ' ').title()
    key_insight = ''
    tags = ''
    chapter = ''

    for line in content.split('\n'):
        if line.startswith('# '):
            title = line[2:].strip()
        if line.startswith('tags:'):
            tags = line.replace('tags:', '').strip().strip('[]')
        if line.startswith('chapter:'):
            chapter = line.replace('chapter:', '').strip()

    in_insight = False
    for line in content.split('\n'):
        if '## Key Insight' in line:
            in_insight = True
            continue
        if in_insight and line.strip() and not line.startswith('#'):
            key_insight = line.strip()
            break

    return {
        'title': title,
        'key_insight': key_insight,
        'tags': tags,
        'chapter': chapter,
        'path': filepath,
    }


def get_all_notes(base):
    """Scan vault and return notes grouped by category."""
    categories = {}
    for root, dirs, files in os.walk(base):
        # Skip _validation folder
        if '_validation' in root:
            continue
        for f in sorted(files):
            if f.endswith('.md'):
                cat = os.path.basename(root)
                note = extract_note(os.path.join(root, f))
                if cat not in categories:
                    categories[cat] = []
                categories[cat].append(note)
    return categories


def get_validation_scores(base):
    """Read validation scores if available."""
    val_dir = os.path.join(base, '_validation')
    if not os.path.exists(val_dir):
        return None

    # Try round 2 first, then round 1
    for fname in ['scores-round2.jsonl', 'scores-round1.jsonl']:
        fpath = os.path.join(val_dir, fname)
        if os.path.exists(fpath):
            scores = []
            with open(fpath) as f:
                for line in f:
                    scores.append(json.loads(line))
            return scores, fname
    return None, None


def print_status(base):
    """Quick status overview."""
    categories = get_all_notes(base)
    total = sum(len(notes) for notes in categories.values())
    book_name = os.path.basename(base).replace('-', ' ').title()

    # Count original vs Phase 3 notes
    original_cats = ['thinking-disciplines', 'business-operations', 'decision-making',
                     'leadership', 'mindset', 'strategy']
    phase3_cats = ['synthesis', 'applied']
    original_count = sum(len(categories.get(c, [])) for c in original_cats)
    phase3_count = sum(len(categories.get(c, [])) for c in phase3_cats)

    # Phase 3 breakdown
    synthesis_3a = []
    research_3c = []
    for note in categories.get('synthesis', []):
        if 'research' in note['tags']:
            research_3c.append(note)
        else:
            synthesis_3a.append(note)
    applied_count = len(categories.get('applied', []))

    print(f"Book: {book_name}")
    print(f"Total notes: {total}")
    print()
    print(f"Phase 1 (original): {original_count} notes")
    for cat in original_cats:
        if cat in categories:
            print(f"  {cat}: {len(categories[cat])}")
    print()
    print(f"Phase 3 (extension): {phase3_count} notes")
    print(f"  3a synthesis:  {len(synthesis_3a)}")
    print(f"  3b applied:    {applied_count}")
    print(f"  3c research:   {len(research_3c)}")

    # Validation score — find latest complete round + any fix rounds
    val_dir = os.path.join(base, '_validation')

    # Collect all score files in order
    score_files = sorted([
        f for f in os.listdir(val_dir) if f.startswith('scores-') and f.endswith('.jsonl')
    ]) if os.path.exists(val_dir) else []

    if score_files:
        # Build final state: start with round 1 (full set), overlay later rounds
        final_scores = {}  # id -> {score, pass}

        for sf in score_files:
            with open(os.path.join(val_dir, sf)) as f:
                for line in f:
                    d = json.loads(line)
                    qid = d.get('id')
                    passed = d.get('pass', d.get('score', 0) >= 95)
                    final_scores[qid] = {'score': d.get('score', 0), 'pass': passed}

        total = len(final_scores)
        passed = sum(1 for v in final_scores.values() if v['pass'])
        failed = total - passed
        avg = sum(v['score'] for v in final_scores.values()) / total if total else 0
        conceptual = sum(1 for v in final_scores.values() if not v['pass'] and v['score'] == 0)

        print()
        print(f"Phase 2 (validation): {len(score_files)} rounds")
        print(f"  Final: {passed}/{total} passed ({passed*100//total}%)")
        print(f"  Average score: {avg:.1f}")
        if failed > 0:
            print(f"  Still failing: {failed}")
        if conceptual > 0:
            print(f"  CONCEPTUAL ERRORS: {conceptual}")
        if passed == total:
            print(f"  REVIEW GATE: PASSED — ready for /ingest")


def print_phase3(base):
    """Detailed Phase 3 summary."""
    categories = get_all_notes(base)

    synthesis_3a = []
    research_3c = []
    applied = []

    for note in categories.get('synthesis', []):
        if 'research' in note['tags']:
            research_3c.append(note)
        else:
            synthesis_3a.append(note)

    applied = categories.get('applied', [])

    print("=" * 70)
    print("PHASE 3 SUMMARY: Beyond the Book")
    print("=" * 70)

    sections = [
        ("3a. SYNTHESIS WITH ADJACENT THINKERS", synthesis_3a),
        ("3b. APPLIED TO NEW DOMAINS", applied),
        ("3c. CURRENT RESEARCH & DEVELOPMENTS", research_3c),
    ]

    for heading, notes in sections:
        print(f"\n{'─' * 70}")
        print(f"{heading} ({len(notes)} notes)")
        print(f"{'─' * 70}\n")
        for n in notes:
            print(f"  ■ {n['title']}")
            if n['key_insight']:
                print(f"    → {n['key_insight']}")
            print()

    total_p3 = len(synthesis_3a) + len(applied) + len(research_3c)
    total_all = sum(len(notes) for notes in categories.values())
    original = total_all - total_p3

    print(f"{'─' * 70}")
    print(f"TOTALS: {total_p3} Phase 3 notes | {original} original | {total_all} total")
    print(f"{'─' * 70}")


def print_full(base):
    """Full summary across all phases."""
    print_status(base)
    print()
    print_phase3(base)


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: summary.py <vault_path> [--status | --phase3]")
        sys.exit(1)

    base = sys.argv[1]
    if not os.path.exists(base):
        print(f"Error: {base} not found")
        sys.exit(1)

    if '--status' in sys.argv:
        print_status(base)
    elif '--phase3' in sys.argv:
        print_phase3(base)
    else:
        print_full(base)
