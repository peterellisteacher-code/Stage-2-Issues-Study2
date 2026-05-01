"""Build the static /data/*.json bundles consumed by the (now backend-less) UI.

After Vertex AI access ended (April 2026) the lab moved to a fully static
delivery model: all questions, readings, rubric and exemplar text are
shipped as JSON the browser fetches directly. The Chamber and Feedback
panels build prompts client-side and hand them off to the student's own
AI tool.

Run:
    python build_static_data.py

Inputs (committed):  pack_metadata.json, cache_handles.json, extracted_docx/
Outputs (committed): data/questions.json, data/readings.json, data/rubric.json
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)

PACK_META = json.loads((ROOT / "pack_metadata.json").read_text(encoding="utf-8"))
CACHE_HANDLES = json.loads((ROOT / "cache_handles.json").read_text(encoding="utf-8"))
EXTRACTED = ROOT / "extracted_docx"

DOMAIN_ORDER = {
    "ethics": 1, "metaphysics": 2, "epistemology": 3, "political": 4,
    "religion": 5, "mind_tech": 6, "aesthetics": 7, "hybrid": 8,
}

# Which SACE-supplied exemplar best models the target dialectical pattern
# for each domain. Carried over from server.py (FEEDBACK_TEMPLATE rationale).
EXEMPLAR_FOR_DOMAIN = {
    "ethics": "A-", "metaphysics": "A-", "epistemology": "A-",
    "political": "A-", "aesthetics": "A-", "hybrid": "A-",
    "mind_tech": "B",  # Same prompt as the original Q5 (philosophical zombies)
    "religion": "C+",  # Same prompt (existence of God)
}


def build_questions() -> list[dict]:
    items = []
    for qid, info in CACHE_HANDLES["questions"].items():
        items.append({
            "id": qid,
            "domain": info["domain"],
            "subdomain": info.get("subdomain") or "",
            "cluster_pack": info.get("cluster_pack"),
            "cluster_display_name": info.get("cluster_display_name") or "",
            "text": info["question_text"],
        })
    items.sort(key=lambda q: (DOMAIN_ORDER.get(q["domain"], 99), q["text"]))
    return items


def build_readings() -> dict[str, dict]:
    """Per-question readings + dialectic. Keyed by question id.

    Each reading's `download_url` points at /readings/<basename>; the Netlify
    redirect rewrites that to the GCS bucket so PDFs continue to work.
    """
    out: dict[str, dict] = {}
    for qid, meta in PACK_META.items():
        readings = []
        for r in meta.get("readings", []):
            readings.append({
                "filename": r["filename"],
                "folder": r.get("folder", ""),
                "why": r.get("why", ""),
                "tier": r.get("tier", "primary"),
                "download_url": f"/readings/{r['readings_basename']}",
                "size_bytes": r.get("size_bytes", 0),
                "text_extracted": r.get("text_extracted", False),
            })
        out[qid] = {
            "question_id": qid,
            "question_text": meta["question_text"],
            "domain": meta["domain"],
            "subdomain": meta.get("subdomain") or "",
            "cluster_pack": meta.get("cluster_pack"),
            "cluster_display_name": meta.get("cluster_display_name"),
            "dialectic": meta.get("dialectic", ""),
            "readings": readings,
        }
    return out


def build_rubric() -> dict:
    return {
        "task_sheet": (EXTRACTED / "task_sheet.txt").read_text(encoding="utf-8"),
        "rubric": (EXTRACTED / "assessment_advice.txt").read_text(encoding="utf-8"),
        "subject_outline": (EXTRACTED / "subject_outline.txt").read_text(encoding="utf-8"),
        "exemplars": {
            "A-": (EXTRACTED / "exemplar_a_minus.txt").read_text(encoding="utf-8"),
            "B":  (EXTRACTED / "exemplar_b.txt").read_text(encoding="utf-8"),
            "C+": (EXTRACTED / "exemplar_c_plus.txt").read_text(encoding="utf-8"),
        },
        "exemplar_for_domain": EXEMPLAR_FOR_DOMAIN,
    }


def main() -> None:
    questions = build_questions()
    readings = build_readings()
    rubric = build_rubric()

    (DATA / "questions.json").write_text(
        json.dumps(questions, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (DATA / "readings.json").write_text(
        json.dumps(readings, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (DATA / "rubric.json").write_text(
        json.dumps(rubric, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    print(f"questions.json  {len(questions)} items")
    print(f"readings.json   {len(readings)} questions")
    print(f"rubric.json     {len(rubric['exemplars'])} exemplars + rubric + task sheet")


if __name__ == "__main__":
    main()
