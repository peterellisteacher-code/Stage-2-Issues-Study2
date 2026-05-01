#!/usr/bin/env python3
"""
Upload the small reading PDFs (≤32 MB AND ≤100 pages) to Anthropic's Files API.

Big books are handled separately by `tools/extract_long_readings.py`, which
produces `data/readings_text.json` with truncated text excerpts.

Usage:
    pip install anthropic pymupdf
    export ANTHROPIC_API_KEY=sk-ant-...
    python tools/upload_readings.py

Outputs:
    data/file_ids.json   { "filename.pdf": "file_abc123", ... }

The script is idempotent: it reads the existing data/file_ids.json (if any)
and skips files already uploaded. Re-run after adding new PDFs to readings/.
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

try:
    import anthropic
except ImportError:
    print("ERROR: pip install anthropic", file=sys.stderr)
    sys.exit(1)


REPO_ROOT = Path(__file__).resolve().parent.parent
READINGS_DIR = REPO_ROOT / "readings"
FILE_IDS_PATH = REPO_ROOT / "data" / "file_ids.json"

# Anthropic Files API limits as of Sept 2025
MAX_BYTES = 32 * 1024 * 1024
MAX_PAGES = 100


def load_existing() -> dict:
    if FILE_IDS_PATH.exists():
        with open(FILE_IDS_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save(file_ids: dict) -> None:
    FILE_IDS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(FILE_IDS_PATH, "w", encoding="utf-8") as f:
        json.dump(file_ids, f, ensure_ascii=False, indent=2, sort_keys=True)


def page_count(path: Path) -> int:
    try:
        doc = fitz.open(str(path))
        n = doc.page_count
        doc.close()
        return n
    except Exception:
        return -1


def main() -> int:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ERROR: ANTHROPIC_API_KEY env var is not set", file=sys.stderr)
        return 1

    if not READINGS_DIR.is_dir():
        print(f"ERROR: {READINGS_DIR} not found. Run from repo root.", file=sys.stderr)
        return 1

    client = anthropic.Anthropic()
    file_ids = load_existing()

    pdfs = sorted(READINGS_DIR.glob("*.pdf"))
    print(f"Found {len(pdfs)} PDFs in {READINGS_DIR}")
    print(f"Already uploaded: {len(file_ids)}")
    print()

    uploaded = 0
    skipped_size = 0
    skipped_pages = 0
    failed = 0

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

        try:
            with open(path, "rb") as fh:
                result = client.beta.files.upload(
                    file=(name, fh, "application/pdf"),
                )
            file_ids[name] = result.id
            uploaded += 1
            print(f"  OK    [{result.id}]  {name}")
            # Save after every upload so we don't lose progress on Ctrl-C
            save(file_ids)
        except Exception as e:
            failed += 1
            print(f"  FAIL  ({e}): {name}")

    print()
    print(f"Uploaded this run: {uploaded}")
    print(f"Skipped (too large): {skipped_size}")
    print(f"Skipped (too many pages): {skipped_pages}")
    print(f"Failed: {failed}")
    print(f"Total in {FILE_IDS_PATH}: {len(file_ids)}")
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
