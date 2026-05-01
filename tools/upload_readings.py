#!/usr/bin/env python3
"""
Upload reading PDFs to Anthropic's Files API in two passes:

  1. Top-level `readings/*.pdf` — the 114 small standalone PDFs (the
     ones that fit Anthropic's caps of 32 MB and 100 pages). The mapping
     filename -> file_id lives in `data/file_ids.json`.

  2. `readings/_chapters/<book>/*.pdf` — chapter pieces produced by
     `tools/split_long_readings.py` from the 23 over-cap books.
     Each piece's file_id is written into `data/book_chapters.json`
     alongside its title and page range.

Both outputs are written incrementally after each upload so Ctrl-C
doesn't lose progress. Re-running the script skips anything already
uploaded.

Usage:
    pip install anthropic pymupdf
    export ANTHROPIC_API_KEY=sk-ant-...
    python tools/upload_readings.py
"""

import os
import json
import sys
from pathlib import Path

try:
    import fitz  # pymupdf
except ImportError:
    print("ERROR: pip install pymupdf", file=sys.stderr)
    sys.exit(1)

try:
    import anthropic
except ImportError:
    print("ERROR: pip install anthropic", file=sys.stderr)
    sys.exit(1)


REPO_ROOT = Path(__file__).resolve().parent.parent
READINGS_DIR = REPO_ROOT / "readings"
CHAPTERS_DIR = READINGS_DIR / "_chapters"
FILE_IDS_PATH = REPO_ROOT / "data" / "file_ids.json"
BOOK_CHAPTERS_PATH = REPO_ROOT / "data" / "book_chapters.json"

MAX_BYTES = 32 * 1024 * 1024
MAX_PAGES = 100


def load_json(path: Path, default):
    if path.exists():
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return default


def save_json(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2, sort_keys=isinstance(obj, dict) and all(not isinstance(v, list) for v in obj.values()))


def page_count(path: Path) -> int:
    try:
        with fitz.open(str(path)) as doc:
            return doc.page_count
    except Exception:
        return -1


def upload_one(client, path: Path, label: str) -> str | None:
    try:
        with open(path, "rb") as fh:
            result = client.beta.files.upload(
                file=(path.name, fh, "application/pdf"),
            )
        print(f"  OK    [{result.id}]  {label}")
        return result.id
    except Exception as e:
        print(f"  FAIL  ({e}): {label}")
        return None


def upload_top_level(client) -> tuple[int, int, int, int]:
    """Returns (uploaded, skip_size, skip_pages, failed)."""
    file_ids = load_json(FILE_IDS_PATH, {})
    pdfs = sorted(READINGS_DIR.glob("*.pdf"))
    print(f"=== Top-level readings ({len(pdfs)} found, {len(file_ids)} already uploaded) ===")

    uploaded = skipped_size = skipped_pages = failed = 0
    for path in pdfs:
        name = path.name
        if name in file_ids:
            continue
        size = path.stat().st_size
        if size > MAX_BYTES:
            print(f"  SKIP (too large, {size/1e6:.1f} MB > 32 MB): {name}")
            skipped_size += 1
            continue
        pages = page_count(path)
        if pages > MAX_PAGES:
            print(f"  SKIP (too many pages, {pages} > 100): {name}")
            skipped_pages += 1
            continue
        fid = upload_one(client, path, name)
        if fid:
            file_ids[name] = fid
            save_json(FILE_IDS_PATH, file_ids)
            uploaded += 1
        else:
            failed += 1
    return uploaded, skipped_size, skipped_pages, failed


def upload_chapters(client) -> tuple[int, int]:
    """Returns (uploaded, failed)."""
    if not BOOK_CHAPTERS_PATH.exists():
        print(f"=== Chapters: {BOOK_CHAPTERS_PATH} not found, skipping. Run tools/split_long_readings.py first. ===")
        return 0, 0
    book_chapters = load_json(BOOK_CHAPTERS_PATH, {})
    total = sum(len(v) for v in book_chapters.values())
    already = sum(1 for v in book_chapters.values() for r in v if r.get("file_id"))
    print(f"\n=== Chapter pieces ({total} found, {already} already uploaded) ===")

    uploaded = failed = 0
    for book_name, pieces in book_chapters.items():
        for piece in pieces:
            if piece.get("file_id"):
                continue
            rel = piece.get("rel_path") or ""
            piece_path = REPO_ROOT / rel
            if not piece_path.is_file():
                print(f"  MISSING: {rel}")
                failed += 1
                continue
            label = f"{book_name} :: {piece.get('title', rel)}"
            fid = upload_one(client, piece_path, label)
            if fid:
                piece["file_id"] = fid
                save_json(BOOK_CHAPTERS_PATH, book_chapters)
                uploaded += 1
            else:
                failed += 1
    return uploaded, failed


def main() -> int:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ERROR: ANTHROPIC_API_KEY env var is not set", file=sys.stderr)
        return 1
    if not READINGS_DIR.is_dir():
        print(f"ERROR: {READINGS_DIR} not found. Run from repo root.", file=sys.stderr)
        return 1

    client = anthropic.Anthropic()

    top_up, top_size, top_pages, top_fail = upload_top_level(client)
    ch_up, ch_fail = upload_chapters(client)

    print()
    print("=== Summary ===")
    print(f"Top-level uploaded:  {top_up}")
    print(f"Top-level skipped (too large): {top_size}")
    print(f"Top-level skipped (too many pages): {top_pages}")
    print(f"Top-level failed:    {top_fail}")
    print(f"Chapters uploaded:   {ch_up}")
    print(f"Chapters failed:     {ch_fail}")
    return 0 if (top_fail + ch_fail) == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
