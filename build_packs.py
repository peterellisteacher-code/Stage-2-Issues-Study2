"""Assemble per-cluster text bundles for the Anthropic-cached Chamber.

Inputs (committed once the readings are pushed):
  - readings/<basename>.pdf      The 98 small PDFs.
  - text_packs/<basename>.txt    Pre-extracted text for the 39 big readings.
  - pack_metadata.json           Per-question reading lists (source of truth).
  - cluster_plan.json            Cluster → primary_filenames map.

Output:
  - data/packs/<cluster_pack>.txt  One text file per cluster, prefixed with a
    deterministic "=== filename ===" header per reading. Loaded by
    netlify/functions/_shared/lab.js at request time and cached as the
    system-prompt prefix on Anthropic's side.

What this script tries to do:
  1. For each cluster_pack referenced in pack_metadata, gather the unique
     basenames of its primary readings.
  2. For each basename, prefer text_packs/<basename>.txt; fall back to
     extracting text from readings/<basename>.pdf via PyMuPDF.
  3. Concatenate with stable headers.
  4. Warn (don't fail) when a basename is missing from both sources.

Run:
    pip install pymupdf
    python build_packs.py

Re-runs are idempotent. Outputs are committed under data/packs/.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
READINGS_DIR = ROOT / "readings"
TEXT_PACKS_DIR = ROOT / "text_packs"
PACKS_OUT = ROOT / "data" / "packs"
PACK_META = json.loads((ROOT / "pack_metadata.json").read_text(encoding="utf-8"))
CLUSTER_PLAN = json.loads((ROOT / "cluster_plan.json").read_text(encoding="utf-8"))

PACKS_OUT.mkdir(parents=True, exist_ok=True)


def basename_for_cluster(cluster_display_name: str) -> set[str]:
    """The set of unique reading basenames whose questions live in this cluster."""
    seen: set[str] = set()
    for meta in PACK_META.values():
        if meta.get("cluster_display_name") == cluster_display_name:
            for r in meta.get("readings", []):
                seen.add(r["readings_basename"])
    return seen


def load_text(basename: str) -> tuple[str | None, str | None]:
    """Return (text, source_label) or (None, None) if neither found."""
    txt_path = TEXT_PACKS_DIR / f"{Path(basename).stem}.txt"
    if txt_path.exists():
        return txt_path.read_text(encoding="utf-8", errors="ignore"), "text_packs/"
    pdf_path = READINGS_DIR / basename
    if pdf_path.exists():
        try:
            import fitz  # PyMuPDF
        except ImportError:
            sys.stderr.write(
                "ERROR: pymupdf (fitz) is required to extract from PDFs. "
                "Install with: pip install pymupdf\n"
            )
            sys.exit(2)
        doc = fitz.open(str(pdf_path))
        chunks = []
        for page in doc:
            chunks.append(page.get_text("text"))
        doc.close()
        return "\n".join(chunks), "readings/ (PDF→text)"
    return None, None


def normalize(text: str) -> str:
    """Cheap whitespace squash; preserves paragraphs."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    # Collapse runs of 3+ blank lines into 2
    text = re.sub(r"\n{3,}", "\n\n", text)
    # Strip leading/trailing whitespace per line
    text = "\n".join(line.rstrip() for line in text.split("\n"))
    return text.strip()


def cluster_pack_id(plan_key: str) -> str:
    """`Applied & normative ethics` -> `lab_applied_normative_ethics`.

    The cluster_pack IDs in pack_metadata.json follow this pattern.
    """
    seed = "lab_" + re.sub(r"[^a-z0-9]+", "_", plan_key.lower()).strip("_")
    return seed


def main() -> None:
    issues = []
    summary = []
    for plan_key, plan in CLUSTER_PLAN["clusters"].items():
        # Find the cluster_pack id by scanning a question that maps here
        cp_id = None
        for meta in PACK_META.values():
            if meta.get("cluster_display_name") == plan_key:
                cp_id = meta.get("cluster_pack")
                break
        if cp_id is None:
            cp_id = cluster_pack_id(plan_key)

        basenames = basename_for_cluster(plan_key) or set(plan.get("primary_filenames", []))

        out_lines: list[str] = []
        out_lines.append(f"# Cluster pack: {plan_key}")
        out_lines.append(f"# Pack id: {cp_id}")
        out_lines.append(f"# Source readings: {len(basenames)}")
        out_lines.append("")

        loaded = 0
        missing: list[str] = []
        total_chars = 0
        for b in sorted(basenames):
            text, source = load_text(b)
            if text is None:
                missing.append(b)
                continue
            text = normalize(text)
            total_chars += len(text)
            out_lines.append(f"=== {b} ({source}) ===")
            out_lines.append("")
            out_lines.append(text)
            out_lines.append("")
            out_lines.append("")
            loaded += 1

        out_path = PACKS_OUT / f"{cp_id}.txt"
        out_path.write_text("\n".join(out_lines).strip() + "\n", encoding="utf-8")
        approx_tokens = total_chars // 4  # rough
        summary.append(
            f"  {cp_id}: {loaded}/{len(basenames)} readings, ~{approx_tokens:,} tokens "
            f"({out_path.stat().st_size/1024:.1f} KB)"
        )
        if missing:
            issues.append((cp_id, missing))

    print("Cluster packs:")
    for s in summary:
        print(s)
    if issues:
        print("\nMissing readings (push these or accept the gap):")
        for cp_id, miss in issues:
            print(f"  {cp_id}: {len(miss)} missing")
            for m in miss:
                print(f"    - {m}")


if __name__ == "__main__":
    main()
