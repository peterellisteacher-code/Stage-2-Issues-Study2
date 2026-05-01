#!/usr/bin/env python3
"""
Extract plain text from EVERY PDF in `readings/` (not just the over-cap ones).

Why: sending PDFs as Anthropic document blocks invokes per-page image-token
charges (~1500-2500 tok/page including image rendering). For pure-text academic
articles this is ~4x more expensive than the equivalent extracted text and the
cost can balloon unexpectedly on image-heavy PDFs. Sending extracted text
instead gives predictable, much cheaper grounding.

This script SUPERSEDES `extract_long_readings.py` — it extracts every reading,
not only those over Anthropic's Files API caps. The output file
`data/readings_text.json` is keyed by filename and contains the full text
(or a per-file cap when a reading is huge).

Usage:
    pip install pymupdf
    python tools/extract_all_readings.py

Per-file cap: TEXT_CAP_DEFAULT chars unless the PDF is short enough to fit in
full. Uncapped extraction would risk individual readings dominating chat-call
budgets; we trim from the end (after the front matter) so the introduction +
opening chapters survive.
"""

import json
import os
import sys
from pathlib import Path

try:
    import fitz  # pymupdf
except ImportError:
    print("ERROR: pip install pymupdf", file=sys.stderr)
    sys.exit(1)


REPO_ROOT = Path(__file__).resolve().parent.parent
READINGS_DIR = REPO_ROOT / "readings"
OUTPUT_PATH = REPO_ROOT / "data" / "readings_text.json"

# Per-file character cap. ~80K chars ~= 20K tokens — comfortably fits multiple
# readings in a single chat call. Books that exceed this get truncated.
TEXT_CAP_DEFAULT = 80_000


def extract(path: Path, cap: int = TEXT_CAP_DEFAULT) -> dict:
    try:
        doc = fitz.open(str(path))
    except Exception as e:
        return {"pages": 0, "size_bytes": path.stat().st_size, "extracted_chars": 0, "text": "", "error": str(e)}
    pages = doc.page_count
    size = path.stat().st_size
    chunks = []
    running = 0
    truncated_pages = 0
    for i, page in enumerate(doc):
        t = page.get_text("text") or ""
        if running + len(t) > cap and i > 5:
            truncated_pages = pages - i
            chunks.append(
                f"\n\n[…{truncated_pages} pages truncated for context-budget reasons. "
                f"Full PDF in /readings/{path.name}]"
            )
            break
        chunks.append(t)
        running += len(t)
    body = "".join(chunks).strip()
    doc.close()
    return {
        "pages": pages,
        "size_bytes": size,
        "extracted_chars": len(body),
        "truncated": truncated_pages > 0,
        "text": body,
    }


def main() -> int:
    if not READINGS_DIR.is_dir():
        print(f"ERROR: {READINGS_DIR} not found", file=sys.stderr)
        return 1
    pdfs = sorted(READINGS_DIR.glob("*.pdf"))
    print(f"Extracting text from {len(pdfs)} PDFs...\n")

    out: dict = {}
    failed = 0
    truncated = 0
    empty = 0
    for path in pdfs:
        rec = extract(path)
        out[path.name] = rec
        marker = ""
        if rec.get("error"):
            failed += 1
            marker = f" FAIL ({rec['error']})"
        elif rec["extracted_chars"] == 0:
            empty += 1
            marker = " EMPTY (likely scanned/image-only)"
        elif rec.get("truncated"):
            truncated += 1
            marker = f" truncated"
        print(f"  {rec['pages']:>4}p  {rec['extracted_chars']/1000:>6.1f}k chars  {path.name}{marker}")

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    total_chars = sum(r["extracted_chars"] for r in out.values())
    print(
        f"\nWrote {OUTPUT_PATH}: {len(out)} files, "
        f"{total_chars/1e6:.1f}M chars total, "
        f"{OUTPUT_PATH.stat().st_size/1e6:.1f} MB on disk"
    )
    print(f"Truncated (over {TEXT_CAP_DEFAULT} chars): {truncated}")
    print(f"Empty extractions (image-only): {empty}")
    print(f"Failures: {failed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
