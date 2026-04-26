"""Filter the Reading Map's 120 questions against the 3 already-taught
units, then cluster the survivors by subdomain and dedupe readings.

Excluded units (already taught BEFORE Issues Study):
  - Issues Analysis 1: Epistemology unit ("Ways of Knowing")
  - Issues Analysis 2: Theory of the Good Life (= Happiness folder, not
    applied ethics)
  - Issues Analysis 3: Mind and Body

Outputs:
  filter_report.json       - per-question keep/drop decision + reason
  surviving_questions.json - the kept question list
  cluster_plan.json        - clusters keyed by subdomain, each with the
                             member questions + the deduped union of
                             their primary readings + token / size estimates
"""
from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(r"C:\Users\Peter Ellis\OneDrive\Teaching\2026\12PHIL - 2026\Issues Study")
RM = ROOT / "reading-map"
LAB = ROOT / "lab"
LIB = Path(r"C:\Users\Peter Ellis\OneDrive\Teaching\Philosophy\Philosophy Texts")

# ── Exclusion rules ─────────────────────────────────────────────────────
# A question is EXCLUDED if its text OR any primary reading's filename
# matches the regex for an already-taught topic.

EXCLUDE_PATTERNS = {
    "epistemology_unit": re.compile(
        r"\b("
        r"common[- ]sense.*ideology|"
        r"ideology.*common[- ]sense|"
        r"group membership.*knowers?|"
        r"systematically unreliable knowers?|"
        r"emotional awareness reveals truths?|"
        r"emotions to interpret|"
        r"perception provide reliable knowledge|"
        r"paradigm-bound|"
        r"scientific knowledge.*objective|"
        r"^.{0,80}\bideology\b"
        r")",
        re.IGNORECASE,
    ),
    "good_life_unit": re.compile(
        r"\b("
        r"hedonis(m|t|tic)|"
        r"eudaimoni|"
        r"experience machine|"
        r"pleasure.*ultimate goal|"
        r"pleasure.*meaning of life|"
        r"strive to live a happy|"
        r"nature of happiness|"
        r"happiness is the meaning|"
        r"happiness important|"
        r"more to life than happiness|"
        r"truly happy|"
        r"good life|"
        r"stoicism"
        r")",
        re.IGNORECASE,
    ),
    "mind_and_body_unit": re.compile(
        r"\b("
        r"philosophical zombies?|"
        r"qualia|"
        r"epiphenomenal|"
        r"functionalism|"
        r"identity theory|"
        r"physical body that only experiences|"
        r"biochemical interactions in the brain|"
        r"mind.body problem"
        r")",
        re.IGNORECASE,
    ),
}

# A reading file primarily associated with a taught unit (used to confirm
# the topic flag — if a question has no exclusion-match in its text but
# its primary readings are entirely excluded thinkers, that's a strong
# signal too).
EXCLUDED_READING_KEYWORDS = re.compile(
    r"("
    r"Zizek|Žižek|"
    r"How Propaganda Works|Stanley.*Propaganda|"
    r"Charles Mills|Sandra Harding|White Ignorance|Standpoint|"
    r"Susanna Siegel|Rationality of Perception|"
    r"Martha Nussbaum|"
    r"Haidt|Moral Foundations|MFT|"
    r"Ishmael|Daniel Quinn|"
    r"Plato.*Cave|Allegory of the Cave|"
    r"Frank Jackson|Mary.*Knew|Epiphenomenal Qualia|"
    r"Chalmers.*Conscious|"
    r"Princess Elisabeth|"
    r"Ravenscroft|"
    r"Predictive Processing|"
    r"Nozick.*Experience Machine|"
    r"Parfit.*Best|"
    r"Brave New World"
    r")",
    re.IGNORECASE,
)

# Domains where the question itself signals a topic that's NOT taught even
# when one or two readings touch unit thinkers. A "free will" question
# isn't excluded just because it cites Hume.
ALWAYS_KEEP_SUBDOMAINS = {
    "Free will & determinism",
    "Forms of government",
    "Civic responsibility, rights, censorship",
    "Aesthetics",
}


def classify(q: dict, entry: dict) -> tuple[bool, str]:
    """Return (keep, reason)."""
    text = q.get("text", "")
    sub = q.get("subdomain", "")

    # Strong text-level matches dominate
    for tag, pat in EXCLUDE_PATTERNS.items():
        if pat.search(text):
            return False, f"exclude: text matches {tag}"

    # Subdomain-level overrides: some are clearly fine
    if sub in ALWAYS_KEEP_SUBDOMAINS:
        return True, "keep: subdomain on always-keep list"

    # Reading-level signal — only excludes if EVERY primary reading is from
    # an excluded unit (otherwise the question can use the readings the
    # student hasn't seen)
    primaries = entry.get("primary", []) or []
    if primaries:
        excluded_count = sum(
            1 for r in primaries
            if EXCLUDED_READING_KEYWORDS.search(r.get("filename", ""))
        )
        if excluded_count == len(primaries) and len(primaries) >= 3:
            return False, "exclude: all primary readings are from a taught unit"

    # Mind-of-mind sub: most are taught. Personal identity is fine (Peter's
    # call). Mind-body problem and consciousness questions are out.
    if sub == "The mind–body problem & consciousness":
        return False, "exclude: mind-body/consciousness covered in Mind and Body unit"

    return True, "keep"


def load_entries() -> dict[str, dict]:
    out: dict[str, dict] = {}
    for p in sorted((RM / "entries").glob("*.json")):
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
            out[d["question_id"]] = d
        except Exception:
            continue
    return out


def estimate_pdf_tokens(filename: str) -> int:
    """Rough — Reading Map's library_catalogue.json has extractable_text_chars."""
    cat = json.loads((RM / "library_catalogue.json").read_text(encoding="utf-8"))
    by_name = {Path(c["path"]).name: c for c in cat}
    c = by_name.get(filename)
    if not c:
        return 50_000  # default guess
    chars = c.get("extractable_text_chars", 0)
    return max(1_000, chars // 4)  # ~4 chars per token


def estimate_pdf_size(filename: str) -> int:
    cat = json.loads((RM / "library_catalogue.json").read_text(encoding="utf-8"))
    by_name = {Path(c["path"]).name: c for c in cat}
    c = by_name.get(filename)
    return c.get("size_bytes", 1_500_000) if c else 1_500_000


def main():
    questions = json.loads((RM / "questions.json").read_text(encoding="utf-8"))
    entries = load_entries()

    kept: list[dict] = []
    dropped: list[dict] = []
    for q in questions:
        entry = entries.get(q["id"])
        if not entry:
            dropped.append({**q, "reason": "no Reading Map entry"})
            continue
        keep, reason = classify(q, entry)
        record = {**q, "reason": reason, "primary_filenames": [r["filename"] for r in entry.get("primary", [])]}
        (kept if keep else dropped).append(record)

    print(f"Total: {len(questions)}   kept: {len(kept)}   dropped: {len(dropped)}")
    print()

    # Cluster kept questions by subdomain. Fall back to a domain-based label
    # when subdomain is null (the Reading Map left some untagged).
    DOMAIN_FALLBACK = {
        "epistemology": "Epistemology -- knowledge & skepticism",
        "religion": "Philosophy of religion",
        "aesthetics": "Aesthetics",
        "hybrid": "Hybrid / other",
        "political": "Political philosophy -- general",
        "metaphysics": "Metaphysics -- general",
        "mind_tech": "Philosophy of mind & technology",
        "ethics": "Ethics -- general",
    }
    clusters: dict[str, dict] = defaultdict(lambda: {
        "questions": [],
        "primary_filenames": set(),
    })
    for q in kept:
        sub = q.get("subdomain") or DOMAIN_FALLBACK.get(q["domain"], "Other")
        clusters[sub]["questions"].append(q["id"])
        clusters[sub]["primary_filenames"].update(q["primary_filenames"])

    # Convert sets and add cost + cache-size estimates.
    # The 8 MB inline cache limit is on raw bytes of the (text-extracted)
    # PDFs sent to Vertex. Approximate post-extraction size as
    # ~0.6 chars/byte of original PDF, but cap at the original size.
    cluster_plan = {}
    total_unique_files: set[str] = set()
    total_token_estimate = 0
    for sub, c in clusters.items():
        files = sorted(c["primary_filenames"])
        tokens = sum(estimate_pdf_tokens(f) for f in files)
        # Crude estimated post-extraction bytes: tokens * 4 chars/token
        # text ~= 1 byte per char in a PyMuPDF text-only PDF.
        est_bytes = tokens * 4
        # Cap at sum of original sizes (text extraction never grows files)
        original_sum = sum(estimate_pdf_size(f) for f in files)
        est_bytes = min(est_bytes, original_sum)
        total_unique_files.update(files)
        total_token_estimate += tokens
        cluster_plan[sub] = {
            "questions": c["questions"],
            "n_questions": len(c["questions"]),
            "primary_filenames": files,
            "n_files": len(files),
            "estimated_tokens": tokens,
            "estimated_post_extract_bytes": est_bytes,
            "fits_inline_8mb": est_bytes < 7_500_000,
            "estimated_storage_per_day_usd": round(tokens * 0.01 * 24 / 1_000_000, 4),
        }

    overall_storage_per_day = round(total_token_estimate * 0.01 * 24 / 1_000_000, 4)

    print(f"Clusters: {len(cluster_plan)}")
    for sub, c in sorted(cluster_plan.items(), key=lambda kv: -kv[1]["n_questions"]):
        fit = "ok" if c["fits_inline_8mb"] else "OVER 8MB"
        print(f"  {sub}: {c['n_questions']}q, {c['n_files']}f, ~{c['estimated_tokens']:,}tk, ~{c['estimated_post_extract_bytes']/1_000_000:.1f}MB [{fit}], ~${c['estimated_storage_per_day_usd']}/day")
    print()
    print(f"Total unique reading files (across all clusters): {len(total_unique_files)}")
    print(f"Total tokens (sum across clusters): {total_token_estimate:,}")
    print(f"Total storage per day: ~${overall_storage_per_day}")

    # Dropped breakdown
    drop_reasons = defaultdict(int)
    for q in dropped:
        drop_reasons[q["reason"]] += 1
    print()
    print("Dropped reasons:")
    for r, n in sorted(drop_reasons.items(), key=lambda kv: -kv[1]):
        print(f"  {n} -- {r}")

    # Save
    (LAB / "filter_report.json").write_text(json.dumps({
        "kept": kept,
        "dropped": dropped,
        "summary": {
            "total": len(questions),
            "kept": len(kept),
            "dropped": len(dropped),
        },
    }, indent=2, ensure_ascii=False), encoding="utf-8")

    (LAB / "surviving_questions.json").write_text(
        json.dumps([{k: v for k, v in q.items() if k not in ("reason", "primary_filenames")} for q in kept], indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    (LAB / "cluster_plan.json").write_text(json.dumps({
        "clusters": cluster_plan,
        "summary": {
            "n_clusters": len(cluster_plan),
            "n_unique_files": len(total_unique_files),
            "total_tokens": total_token_estimate,
            "storage_per_day_usd": overall_storage_per_day,
        },
        "unique_files": sorted(total_unique_files),
    }, indent=2, ensure_ascii=False), encoding="utf-8")

    print()
    print("Wrote filter_report.json, surviving_questions.json, cluster_plan.json")


if __name__ == "__main__":
    main()
