#!/usr/bin/env python3
"""
For PDFs over Anthropic's Files API caps (>32 MB OR >100 pages), extract
plain text and write to `data/readings_text.json`. The chat function inlines
this text per-question so the AI can quote from book-length sources.

Usage:
    pip install pymupdf
    python tools/extract_long_readings.py

Truncates each book to ~80K chars (~20K tokens) — long enough for a chapter
or two of grounding, short enough to fit alongside ~3 other readings in a
single chat call.
"""

import os
import json
import sys
import glob
from pathlib import Path

try:
    import fitz  # pymupdf
except ImportError:
    print("ERROR: pip install pymupdf", file=sys.stderr)
    sys.exit(1)


REPO_ROOT = Path(__file__).resolve().parent.parent
READINGS_DIR = REPO_ROOT / "readings"
OUTPUT_PATH = REPO_ROOT / "data" / "readings_text.json"

# Files API caps
MAX_BYTES = 32 * 1024 * 1024
MAX_PAGES = 100

# Per-file character cap for extracted text
TEXT_CAP = 80_000


def main() -> int:
    if not READINGS_DIR.is_dir():
        print(f"ERROR: {READINGS_DIR} not found. Run from repo root.", file=sys.stderr)
        return 1

    out: dict = {}
    pdfs = sorted(READINGS_DIR.glob("*.pdf"))

    for path in pdfs:
        size = path.stat().st_size
        try:
            doc = fitz.open(str(path))
            pages = doc.page_count
        except Exception as e:
            print(f"  SKIP (bad PDF): {path.name}: {e}")
            continue

        if pages <= MAX_PAGES and size <= MAX_BYTES:
            doc.close()
            continue  # Files API will handle this one

        chunks = []
        running = 0
        for i, page in enumerate(doc):
            t = page.get_text("text") or ""
            if running + len(t) > TEXT_CAP and i > 5:
                chunks.append(
                    f"\n\n[…remaining {pages - i} pages truncated for context-budget reasons. "
                    f"Full PDF in /readings/{path.name}]"
                )
                break
            chunks.append(t)
            running += len(t)
        body = "".join(chunks).strip()
        doc.close()

        out[path.name] = {
            "pages": pages,
            "size_bytes": size,
            "extracted_chars": len(body),
            "text": body,
        }
        print(f"  EXTRACT  {pages:4}p {len(body)/1000:5.1f}k chars  {path.name}")

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"\nWrote {OUTPUT_PATH}: {len(out)} files, {OUTPUT_PATH.stat().st_size/1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
