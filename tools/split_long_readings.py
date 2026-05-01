#!/usr/bin/env python3
"""
Split each over-cap PDF in `readings/` into per-chapter PDFs in
`readings/_chapters/<book_name>/`. The chat function attaches these
chapter PDFs (via Anthropic Files API) instead of the whole book,
so the AI can quickly find the chapter it needs and quote verbatim.

Strategy:
  1. If the PDF has a usable table of contents (depth-1 with >=3 entries,
     else depth-2), split by chapter boundaries.
  2. Else chunk every CHUNK_PAGES pages with generic "Pages X–Y" titles.
  3. Any resulting piece >MAX_PAGES_PER_PIECE pages gets recursively
     halved so each piece fits Anthropic's Files API cap.

Outputs:
  readings/_chapters/<book>/<NN>-<slug>.pdf
  data/book_chapters.json:
    { "Singer - Practical ethics.pdf": [
        { "title": "...", "start_page": ..., "end_page": ..., "rel_path": "_chapters/Singer.../01-...pdf", "size_bytes": ... },
        ...
      ], ... }

Usage:
    pip install pymupdf
    python tools/split_long_readings.py
"""

import os
import sys
import json
import re
from pathlib import Path

try:
    import fitz  # pymupdf
except ImportError:
    print("ERROR: pip install pymupdf", file=sys.stderr)
    sys.exit(1)


REPO_ROOT = Path(__file__).resolve().parent.parent
READINGS_DIR = REPO_ROOT / "readings"
CHAPTERS_DIR = READINGS_DIR / "_chapters"
OUTPUT_PATH = REPO_ROOT / "data" / "book_chapters.json"

# Anthropic Files API caps
MAX_BYTES = 32 * 1024 * 1024
MAX_PAGES_PER_PIECE = 90      # leave 10p margin under 100p cap

# Page-chunking fallback when no usable TOC
CHUNK_PAGES = 30
MIN_CHAPTERS_TOP_LEVEL = 3    # below this, fall back to depth-2 TOC


def slugify(s: str) -> str:
    s = re.sub(r"[^\w\s-]", "", s, flags=re.UNICODE).strip().lower()
    s = re.sub(r"[-\s]+", "-", s)
    return s[:60] or "untitled"


def needs_split(path: Path) -> bool:
    size = path.stat().st_size
    try:
        with fitz.open(str(path)) as doc:
            pages = doc.page_count
    except Exception:
        return False
    return pages > 100 or size > MAX_BYTES


def usable_toc_chapters(doc):
    """Return [(title, start_page, end_page), ...] (1-indexed, inclusive)
    based on the deepest level that gives at least MIN_CHAPTERS_TOP_LEVEL
    entries. Falls back to None if no usable TOC."""
    toc = doc.get_toc()
    if not toc:
        return None
    # Try depth 1 first, then 2, then 3
    for level in (1, 2, 3):
        entries = [(t, p) for (lvl, t, p) in toc if lvl == level and p > 0]
        if len(entries) >= MIN_CHAPTERS_TOP_LEVEL:
            chapters = []
            for i, (title, p) in enumerate(entries):
                start = max(1, p)
                end = (entries[i + 1][1] - 1) if i + 1 < len(entries) else doc.page_count
                end = max(start, end)
                if end - start + 1 < 1:
                    continue
                chapters.append((title.strip() or f"Section {i+1}", start, end))
            if chapters:
                return chapters
    return None


def chunk_by_pages(doc):
    """Fallback: split every CHUNK_PAGES pages."""
    n = doc.page_count
    chapters = []
    for start in range(1, n + 1, CHUNK_PAGES):
        end = min(start + CHUNK_PAGES - 1, n)
        chapters.append((f"Pages {start}–{end}", start, end))
    return chapters


def halve_oversized(chapters):
    """Recursively split any piece with > MAX_PAGES_PER_PIECE pages."""
    out = []
    for title, start, end in chapters:
        size = end - start + 1
        if size <= MAX_PAGES_PER_PIECE:
            out.append((title, start, end))
            continue
        # Halve until each piece fits
        mid = start + size // 2 - 1
        out.extend(halve_oversized([
            (f"{title} (part 1)", start, mid),
            (f"{title} (part 2)", mid + 1, end),
        ]))
    return out


def write_chapter_pdf(src_doc, start, end, dest: Path):
    """Write pages start..end (1-indexed inclusive) from src_doc to dest."""
    out = fitz.open()
    out.insert_pdf(src_doc, from_page=start - 1, to_page=end - 1)
    dest.parent.mkdir(parents=True, exist_ok=True)
    out.save(str(dest), garbage=4, deflate=True)
    out.close()


def main():
    if not READINGS_DIR.is_dir():
        print(f"ERROR: {READINGS_DIR} not found.", file=sys.stderr)
        return 1

    pdfs = sorted([p for p in READINGS_DIR.glob("*.pdf") if needs_split(p)])
    print(f"Splitting {len(pdfs)} over-cap PDFs into chapter pieces.\n")

    out: dict = {}
    for pdf_path in pdfs:
        name = pdf_path.name
        try:
            doc = fitz.open(str(pdf_path))
        except Exception as e:
            print(f"  SKIP (cannot open): {name}: {e}")
            continue

        chapters = usable_toc_chapters(doc)
        method = "TOC"
        if not chapters:
            chapters = chunk_by_pages(doc)
            method = "page-chunk"
        chapters = halve_oversized(chapters)

        book_dir = CHAPTERS_DIR / pdf_path.stem
        # Wipe stale chapter files so re-runs stay clean
        if book_dir.exists():
            for f in book_dir.glob("*.pdf"):
                f.unlink()

        records = []
        for i, (title, start, end) in enumerate(chapters, start=1):
            slug = slugify(title)
            piece_name = f"{i:02d}-{slug}.pdf"
            dest = book_dir / piece_name
            try:
                write_chapter_pdf(doc, start, end, dest)
            except Exception as e:
                print(f"    FAIL writing piece {i} of {name}: {e}")
                continue
            sz = dest.stat().st_size
            if sz > MAX_BYTES:
                # Image-heavy short PDFs can stay over-cap even after page
                # splitting. Drop them; readings_text.json picks them up.
                print(f"    DROP oversized piece ({sz/1e6:.1f} MB > 32 MB): {piece_name}")
                dest.unlink(missing_ok=True)
                continue
            records.append({
                "title": title,
                "start_page": start,
                "end_page": end,
                "pages": end - start + 1,
                "rel_path": str(dest.relative_to(REPO_ROOT)).replace(os.sep, "/"),
                "size_bytes": sz,
            })

        if not records:
            print(f"  SKIP (no usable pieces): {name}")
            # Remove now-empty dir
            if book_dir.exists() and not any(book_dir.iterdir()):
                book_dir.rmdir()
            doc.close()
            continue

        out[name] = records
        print(f"  {method:10s} {len(records):3d} pieces  {name}")
        doc.close()

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    total_pieces = sum(len(v) for v in out.values())
    total_bytes = sum(r["size_bytes"] for v in out.values() for r in v)
    print(f"\nWrote {OUTPUT_PATH}: {len(out)} books, {total_pieces} pieces, {total_bytes/1e6:.1f} MB on disk")
    return 0


if __name__ == "__main__":
    sys.exit(main())
