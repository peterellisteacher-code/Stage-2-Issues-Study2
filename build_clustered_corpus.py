"""Turn cluster_plan.json into:

  - readings/<filename>.pdf       deduped originals for student download
  - text_packs/<slug>.text.pdf    text-extracted versions of big PDFs (for caching)
  - lab_corpus.json               cluster pack definitions consumed by cache_unit_pack

Per cluster the script picks the smallest representation of each file
that lets the whole cluster fit under PER_PACK_BUDGET_BYTES, so the
inline createCachedContent call doesn't trip the ~8 MB Vertex limit.
"""
from __future__ import annotations

import json
import re
import shutil
from collections import defaultdict
from pathlib import Path

import fitz

ROOT = Path(r"C:\Users\Peter Ellis\OneDrive\Teaching\2026\12PHIL - 2026\Issues Study")
LAB = ROOT / "Issues_Study_Lab"
RM = ROOT / "reading-map"
LIB = Path(r"C:\Users\Peter Ellis\OneDrive\Teaching\Philosophy\Philosophy Texts")
TEXT_PACKS = LAB / "text_packs"
READINGS = LAB / "readings"
TEXT_PACKS.mkdir(exist_ok=True)
READINGS.mkdir(exist_ok=True)

PER_PACK_BUDGET_BYTES = 6 * 1024 * 1024
LARGE_FILE_BYTES = 2 * 1024 * 1024


def slugify(s: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]+", "_", s).strip("_").lower()[:80]


def find_in_library(filename: str) -> Path | None:
    for hit in LIB.rglob(filename):
        return hit
    return None


def text_extract(src: Path, dst: Path) -> int:
    """Copy text out of `src` into a fresh small PDF at `dst`. Returns dst size."""
    if dst.exists():
        return dst.stat().st_size
    src_doc = fitz.open(str(src))
    text_pages = [p.get_text("text") for p in src_doc]
    src_doc.close()
    text = "\n\n----- page break -----\n\n".join(text_pages)

    dst_doc = fitz.open()
    page_size = fitz.paper_rect("a4")
    margin = 50
    rect = fitz.Rect(margin, margin, page_size.x1 - margin, page_size.y1 - margin)
    chunk_size = 3500
    chunks = [text[i : i + chunk_size] for i in range(0, len(text), chunk_size)] or [""]
    for chunk in chunks:
        page = dst_doc.new_page(width=page_size.width, height=page_size.height)
        page.insert_textbox(rect, chunk, fontsize=9, fontname="helv")
    dst_doc.save(str(dst), deflate=True, clean=True)
    dst_doc.close()
    return dst.stat().st_size


def collect_file(filename: str, file_index: dict) -> dict | None:
    """Resolve filename in library, optionally text-extract, and copy original to readings/.

    Returns a record:
      {
        "filename": original filename,
        "abs_path_for_cache": text-extracted version if large else original,
        "size_for_cache": bytes,
        "abs_path_for_download": original library path (for /readings download),
        "readings_basename": filename used in readings/,
        "text_extracted": bool,
      }
    Memoised in `file_index`.
    """
    if filename in file_index:
        return file_index[filename]

    src = find_in_library(filename)
    if not src:
        file_index[filename] = None
        return None

    orig_size = src.stat().st_size

    # Always copy original to readings/ (deduped by filename); used for student download
    readings_dst = READINGS / filename
    if not readings_dst.exists():
        try:
            shutil.copy2(src, readings_dst)
        except Exception as e:
            # Path issues w/ exotic chars — fall back to slug
            readings_dst = READINGS / (slugify(Path(filename).stem) + Path(filename).suffix)
            if not readings_dst.exists():
                shutil.copy2(src, readings_dst)

    if orig_size > LARGE_FILE_BYTES:
        slug = slugify(Path(filename).stem) + ".text.pdf"
        tx_dst = TEXT_PACKS / slug
        try:
            tx_size = text_extract(src, tx_dst)
        except Exception as e:
            print(f"  text extract failed for {filename}: {e}; using original")
            tx_dst = src
            tx_size = orig_size
        rec = {
            "filename": filename,
            "abs_path_for_cache": str(tx_dst),
            "size_for_cache": tx_size,
            "abs_path_for_download": str(src),
            "readings_basename": readings_dst.name,
            "text_extracted": True,
            "original_size": orig_size,
        }
    else:
        rec = {
            "filename": filename,
            "abs_path_for_cache": str(src),
            "size_for_cache": orig_size,
            "abs_path_for_download": str(src),
            "readings_basename": readings_dst.name,
            "text_extracted": False,
            "original_size": orig_size,
        }
    file_index[filename] = rec
    return rec


def main():
    plan = json.loads((LAB / "cluster_plan.json").read_text(encoding="utf-8"))
    surviving = json.loads((LAB / "surviving_questions.json").read_text(encoding="utf-8"))

    # question_id -> domain (for the readings panel)
    q_meta = {q["id"]: q for q in surviving}

    file_index: dict[str, dict | None] = {}

    # Build packs (one per cluster) and the question -> cluster map
    packs: dict[str, dict] = {}
    pack_meta: dict[str, dict] = {}
    question_to_cluster: dict[str, str] = {}
    overall_skipped: list[dict] = []

    for sub, cluster in plan["clusters"].items():
        pack_key = "lab_" + slugify(sub)
        files = []
        skipped = []
        total = 0
        for filename in cluster["primary_filenames"]:
            rec = collect_file(filename, file_index)
            if not rec:
                skipped.append({"file": filename, "reason": "not found in library"})
                continue
            files.append(rec)
            total += rec["size_for_cache"]

        # If over budget, drop largest until we fit
        files.sort(key=lambda r: -r["size_for_cache"])
        while total > PER_PACK_BUDGET_BYTES and files:
            dropped = files.pop(0)
            total -= dropped["size_for_cache"]
            skipped.append({"file": dropped["filename"], "reason": f"pack budget; dropped ({dropped['size_for_cache']} bytes)"})

        # Sort back to deterministic order
        files.sort(key=lambda r: r["filename"])

        packs[pack_key] = {
            "display_name": sub,
            "system_instruction": (
                f"You are a Socratic study partner for a SACE Stage 2 Philosophy student "
                f"investigating a question in the '{sub}' area for their Issues Study (AT3). "
                f"Always cite the cached texts when you make a claim about a thinker. "
                f"If asked about something the cached texts don't support, say so explicitly "
                f"rather than invent. Year 12 reading level, philosophical terminology with "
                f"accessible explanations."
            ),
            "files": [r["abs_path_for_cache"] for r in files],
        }
        pack_meta[pack_key] = {
            "cluster_subdomain": sub,
            "questions": cluster["questions"],
            "files": files,
            "skipped": skipped,
            "total_bytes": total,
        }
        for qid in cluster["questions"]:
            question_to_cluster[qid] = pack_key
        if skipped:
            overall_skipped.extend([{"cluster": sub, **s} for s in skipped])

    # Single corpus
    corpus = {
        "_documentation": "Cluster-level pack definitions for the Issues Study Lab. Each pack groups questions sharing a thematic subdomain so storage cost stays low.",
        "_built_from": "cluster_plan.json (output of filter_and_cluster.py)",
        "default_model": "gemini-2.5-pro",
        "default_ttl_seconds": 6048000,
        "default_system_instruction": (
            "You are a Socratic study partner for a SACE Stage 2 Philosophy student "
            "working on the Issues Study (AT3 Investigation). Always cite the cached "
            "texts when making a claim about a thinker."
        ),
        "packs": packs,
    }
    (LAB / "lab_corpus.json").write_text(json.dumps(corpus, indent=2, ensure_ascii=False), encoding="utf-8")

    # pack_metadata used by /api/readings (per-question readings list)
    # Reshape: question_id -> {readings, cluster_pack, ...}
    pack_metadata_by_question: dict[str, dict] = {}
    for qid, q in q_meta.items():
        pack_key = question_to_cluster.get(qid)
        if not pack_key:
            continue
        cluster_meta = pack_meta[pack_key]
        # Find each primary reading for THIS question (Reading Map's per-question primary list)
        q_entry_path = RM / "entries" / f"{qid}.json"
        try:
            q_entry = json.loads(q_entry_path.read_text(encoding="utf-8"))
        except Exception:
            q_entry = {}
        per_q_readings = []
        for r in (q_entry.get("primary") or []) + (q_entry.get("secondary") or []):
            fn = r.get("filename")
            rec = file_index.get(fn)
            if not rec:
                continue
            per_q_readings.append({
                "filename": fn,
                "folder": r.get("folder", ""),
                "why": r.get("why") or r.get("why_original") or "",
                "tier": "primary" if r in (q_entry.get("primary") or []) else "secondary",
                "readings_basename": rec["readings_basename"],
                "size_bytes": rec["original_size"],
                "text_extracted": rec["text_extracted"],
            })
        pack_metadata_by_question[qid] = {
            "question_id": qid,
            "question_text": q["text"],
            "domain": q["domain"],
            "subdomain": q.get("subdomain") or "",
            "cluster_pack": pack_key,
            "cluster_display_name": pack_meta[pack_key]["cluster_subdomain"],
            "readings": per_q_readings,
            "dialectic": q_entry.get("dialectic_humanized") or q_entry.get("dialectic") or "",
        }

    (LAB / "pack_metadata.json").write_text(json.dumps(pack_metadata_by_question, indent=2, ensure_ascii=False), encoding="utf-8")

    # question_to_cluster map
    (LAB / "question_to_cluster.json").write_text(json.dumps(question_to_cluster, indent=2), encoding="utf-8")

    # report
    print("=== Cluster build summary ===")
    for pack_key, p in packs.items():
        files_n = len(p["files"])
        bytes_n = pack_meta[pack_key]["total_bytes"]
        print(f"  {pack_key}: {files_n} files, {bytes_n/1_000_000:.2f} MB")
    if overall_skipped:
        print()
        print("Skipped:")
        for s in overall_skipped:
            print(f"  [{s['cluster']}] {s['file']} -- {s['reason']}")
    print()
    print(f"Wrote lab_corpus.json ({len(packs)} packs)")
    print(f"Wrote pack_metadata.json ({len(pack_metadata_by_question)} questions)")
    print(f"Wrote question_to_cluster.json")
    print(f"Readings dir: {len(list(READINGS.iterdir()))} files copied")


if __name__ == "__main__":
    main()
