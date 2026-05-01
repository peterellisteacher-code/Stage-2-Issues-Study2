#!/usr/bin/env python3
"""
Enrich data/readings.json with a `pages` field for every reading entry.

Why: chat.js estimates per-PDF token cost. The current `size_bytes * 0.2`
heuristic over-estimates by 3-5x on image-heavy PDFs, causing single
medium-size PDFs (e.g. Macintyre Ch 15 at 1.75 MB / 65 pages) to be
silently dropped on every chat call. Anthropic's actual PDF token cost
is ~1500-2500 tokens per page, so pages * 2000 is a much better proxy.

After this script runs, chat.js prefers `pages * 2000` over the byte
heuristic when `pages` is present in the reading entry.

Usage:
    pip install pymupdf
    python tools/add_page_counts.py
"""

import json
import sys
from pathlib import Path

try:
    import fitz  # pymupdf
except ImportError:
    print("ERROR: pip install pymupdf", file=sys.stderr)
    sys.exit(1)


REPO_ROOT = Path(__file__).resolve().parent.parent
READINGS_DIR = REPO_ROOT / "readings"
READINGS_JSON = REPO_ROOT / "data" / "readings.json"


def page_count(filename: str) -> int:
    path = READINGS_DIR / filename
    if not path.is_file():
        return 0
    try:
        with fitz.open(str(path)) as doc:
            return doc.page_count
    except Exception as e:
        print(f"  WARN cannot read pages for {filename}: {e}")
        return 0


def main() -> int:
    if not READINGS_JSON.exists():
        print(f"ERROR: {READINGS_JSON} not found", file=sys.stderr)
        return 1

    with open(READINGS_JSON, "r", encoding="utf-8") as f:
        data = json.load(f)

    page_cache: dict = {}
    enriched = 0
    missing_files = set()

    for qid, q in data.items():
        for r in q.get("readings", []):
            name = r.get("filename")
            if not name:
                continue
            if name not in page_cache:
                pc = page_count(name)
                page_cache[name] = pc
                if pc == 0:
                    missing_files.add(name)
            r["pages"] = page_cache[name]
            enriched += 1

    with open(READINGS_JSON, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"Enriched {enriched} reading entries across {len(data)} questions.")
    print(f"Unique files inspected: {len(page_cache)}")
    if missing_files:
        print(f"Files with 0 pages (missing or unreadable): {len(missing_files)}")
        for n in sorted(missing_files):
            print(f"  - {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
