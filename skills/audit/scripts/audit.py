#!/usr/bin/env python3
"""Knowledge audit system: flag management, book discovery, fuzzy matching.

Usage:
  audit.py <vault_root> --status                           Show all books and flags
  audit.py <vault_root> --set-flag <true|false|manual> [fuzzy]  Set flag for a book
  audit.py <vault_root> [fuzzy]                            Run audit on a book
  audit.py <vault_root> --run [fuzzy]                      Same as above
"""

import os
import sys
import json
import glob
from datetime import datetime


VAULT_ROOT = None
FLAG_FILE = "_validation/audit-flag.json"


def discover_books(vault_root):
    """Find all book directories in knowledge/raw/."""
    books = []
    for entry in sorted(os.listdir(vault_root)):
        book_dir = os.path.join(vault_root, entry)
        if not os.path.isdir(book_dir):
            continue
        # Must have notes (not just _validation)
        has_notes = any(
            f.endswith('.md') for f in os.listdir(book_dir)
            if not f.startswith('_') and not f.startswith('.')
        ) or any(
            os.path.isdir(os.path.join(book_dir, d)) and d != '_validation'
            for d in os.listdir(book_dir)
        )
        if has_notes:
            books.append({
                'slug': entry,
                'path': book_dir,
                'flag': read_flag(book_dir),
                'note_count': count_notes(book_dir),
            })
    return books


def count_notes(book_dir):
    """Count .md files excluding _validation."""
    count = 0
    for root, dirs, files in os.walk(book_dir):
        if '_validation' in root:
            continue
        count += sum(1 for f in files if f.endswith('.md'))
    return count


def read_flag(book_dir):
    """Read audit flag for a book. Default: false."""
    flag_path = os.path.join(book_dir, FLAG_FILE)
    if os.path.exists(flag_path):
        try:
            data = json.load(open(flag_path))
            return data
        except (json.JSONDecodeError, KeyError):
            pass
    return {"flag": "false", "last_audit": None, "audit_score": None, "changed_by": "default"}


def write_flag(book_dir, flag, changed_by="user", audit_score=None):
    """Write audit flag for a book."""
    flag_path = os.path.join(book_dir, FLAG_FILE)
    os.makedirs(os.path.dirname(flag_path), exist_ok=True)
    data = {
        "flag": flag,
        "last_audit": datetime.now().isoformat(),
        "audit_score": audit_score or read_flag(book_dir).get("audit_score"),
        "changed_by": changed_by,
    }
    json.dump(data, open(flag_path, 'w'), indent=2)
    return data


def fuzzy_match(books, query):
    """Fuzzy match a book by substring of slug."""
    if not query:
        if len(books) == 1:
            return books[0]
        return None  # ambiguous

    query = query.lower().strip()
    matches = [b for b in books if query in b['slug'].lower()]

    if len(matches) == 1:
        return matches[0]
    elif len(matches) > 1:
        # Try exact prefix match first
        prefix_matches = [b for b in matches if b['slug'].lower().startswith(query)]
        if len(prefix_matches) == 1:
            return prefix_matches[0]
        return None  # ambiguous, caller should list
    return None  # no match


def print_status(vault_root):
    """Show all books and their audit flags."""
    books = discover_books(vault_root)
    if not books:
        print("No books found in", vault_root)
        return

    print(f"{'='*60}")
    print(f"  KNOWLEDGE AUDIT STATUS")
    print(f"{'='*60}")
    print()

    for i, book in enumerate(books, 1):
        flag = book['flag']
        flag_val = flag['flag']
        icon = {"true": "✅", "false": "❌", "manual": "👁️"}.get(flag_val, "?")
        last = flag.get('last_audit', 'never')
        if last and last != 'never':
            last = last[:10]  # just date
        score = flag.get('audit_score', '-')

        print(f"  {i}. {icon} {book['slug']}")
        print(f"     Flag: {flag_val} | Notes: {book['note_count']} | Last audit: {last} | Score: {score}")
        print()

    # Summary
    audited = sum(1 for b in books if b['flag']['flag'] == 'true')
    pending = sum(1 for b in books if b['flag']['flag'] == 'false')
    manual = sum(1 for b in books if b['flag']['flag'] == 'manual')
    print(f"{'─'*60}")
    print(f"  Total: {len(books)} books | ✅ {audited} audited | ❌ {pending} pending | 👁️ {manual} manual")


def prompt_book_selection(books, query=None):
    """Try fuzzy match, or list books for selection."""
    if query:
        match = fuzzy_match(books, query)
        if match:
            return match
        # Partial matches
        query_lower = query.lower()
        partials = [b for b in books if query_lower in b['slug'].lower()]
        if partials:
            print(f"Multiple matches for '{query}':")
            for i, b in enumerate(partials, 1):
                print(f"  {i}. {b['slug']} ({b['flag']['flag']})")
            print(f"\nBe more specific, e.g.: /audit {partials[0]['slug'][:10]}")
            return None
        else:
            print(f"No book matching '{query}'. Available books:")
            for i, b in enumerate(books, 1):
                print(f"  {i}. {b['slug']} ({b['flag']['flag']})")
            return None

    # No query
    if len(books) == 1:
        return books[0]

    print("Which book?")
    for i, b in enumerate(books, 1):
        flag_icon = {"true": "✅", "false": "❌", "manual": "👁️"}.get(b['flag']['flag'], "?")
        print(f"  {i}. {flag_icon} {b['slug']}")
    print("\nSpecify a book name, e.g.: /audit road")
    return None


def main():
    if len(sys.argv) < 2:
        print("Usage: audit.py <vault_root> [--status | --set-flag <flag> [name] | [name]]")
        sys.exit(1)

    vault_root = sys.argv[1]
    if not os.path.exists(vault_root):
        print(f"Error: {vault_root} not found")
        sys.exit(1)

    args = sys.argv[2:]

    if '--status' in args:
        print_status(vault_root)
        return

    if '--set-flag' in args:
        idx = args.index('--set-flag')
        if idx + 1 >= len(args):
            print("Usage: --set-flag <true|false|manual> [book-name]")
            sys.exit(1)
        flag_val = args[idx + 1]
        if flag_val not in ('true', 'false', 'manual'):
            print(f"Invalid flag: {flag_val}. Must be true, false, or manual.")
            sys.exit(1)
        query = args[idx + 2] if idx + 2 < len(args) else None

        books = discover_books(vault_root)
        book = prompt_book_selection(books, query)
        if not book:
            sys.exit(1)

        data = write_flag(book['path'], flag_val, changed_by="user")
        icon = {"true": "✅", "false": "❌", "manual": "👁️"}.get(flag_val)
        print(f"{icon} {book['slug']}: audited → {flag_val}")
        return

    # Default: run audit or select book
    query = args[0] if args and not args[0].startswith('-') else None

    books = discover_books(vault_root)
    book = prompt_book_selection(books, query)
    if not book:
        sys.exit(1)

    print(f"Audit target: {book['slug']} ({book['note_count']} notes)")
    print(f"Current flag: {book['flag']['flag']}")
    print()
    print("To run the full audit (50 fresh questions vs NotebookLM):")
    print(f"  The agent should generate 50 fresh questions, query NotebookLM,")
    print(f"  score at ≥95 threshold, and update the audit flag.")
    print()
    print(f"Book path: {book['path']}")
    print(f"Validation dir: {os.path.join(book['path'], '_validation')}")


if __name__ == '__main__':
    main()
