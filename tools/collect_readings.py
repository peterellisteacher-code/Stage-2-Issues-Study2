"""Collect the 98 small reading PDFs out of your Philosophy Texts library
into ./readings/, ready to commit.

Usage (Windows PowerShell or Mac/Linux shell):
    python tools/collect_readings.py "C:/Users/Peter Ellis/OneDrive/Teaching/Philosophy/Philosophy Texts"

The argument is the root folder where your readings live; the script walks
it recursively to find each PDF by basename. Files already in ./readings/
are not overwritten unless you pass --force. A report at the end shows any
files it could not find.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="Path to your Philosophy Texts library root")
    parser.add_argument("--force", action="store_true", help="Overwrite existing files in ./readings/")
    args = parser.parse_args()

    src_root = Path(args.source).expanduser()
    if not src_root.is_dir():
        sys.stderr.write(f"ERROR: source folder not found: {src_root}\n")
        return 2

    dst = ROOT / "readings"
    dst.mkdir(exist_ok=True)

    # Build the list of small PDFs (text_extracted=False) from pack_metadata.
    pack_meta = json.loads((ROOT / "pack_metadata.json").read_text(encoding="utf-8"))
    needed: set[str] = set()
    for q in pack_meta.values():
        for r in q.get("readings", []):
            if not r.get("text_extracted"):
                needed.add(r["readings_basename"])

    print(f"Looking for {len(needed)} small PDFs under {src_root} ...")
    print(f"  (recursive scan; first match wins if duplicates exist)")
    print()

    # Pre-walk the source tree once and build a basename → path index.
    print("Indexing source tree ...", flush=True)
    index: dict[str, Path] = {}
    for p in src_root.rglob("*.pdf"):
        # First match wins; later duplicates ignored.
        index.setdefault(p.name, p)
    print(f"  {len(index):,} PDFs found in source tree.")
    print()

    copied = 0
    skipped_existing = 0
    missing: list[str] = []

    for name in sorted(needed):
        target = dst / name
        if target.exists() and not args.force:
            skipped_existing += 1
            continue
        src = index.get(name)
        if not src:
            missing.append(name)
            continue
        shutil.copy2(src, target)
        copied += 1

    total_bytes = sum((dst / n).stat().st_size for n in needed if (dst / n).exists())
    print(f"Copied:  {copied}")
    print(f"Already in ./readings/ (skipped): {skipped_existing}")
    print(f"Total in ./readings/: {sum(1 for n in needed if (dst/n).exists())}/{len(needed)}  "
          f"({total_bytes/1_000_000:.1f} MB)")
    if missing:
        print()
        print(f"Missing ({len(missing)}) — these basenames weren't found anywhere under {src_root}:")
        for m in missing:
            print(f"  - {m}")
        print()
        print("Either copy them into ./readings/ manually, or rerun the script "
              "with a different source path that contains them.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
