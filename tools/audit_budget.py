#!/usr/bin/env python3
"""Replicate buildDocumentBlocks from netlify/functions/chat.js exactly,
then audit how often readings get silently dropped across all 102 questions."""

import json
import os
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TOKEN_BUDGET = 160_000
PER_BOOK_BUDGET = 70_000
TOKENS_PER_PAGE = 2000
TOKENS_PER_PDF_BYTE = 0.2
TOKENS_PER_TEXT_CHAR = 0.25


def load(path):
    with open(os.path.join(ROOT, path)) as f:
        return json.load(f)


def simulate(entry, file_ids, readings_text, book_chapters):
    """Mirror buildDocumentBlocks. Returns (attached, missing, miss_reasons)
    where miss_reasons[name] in {too_big_pdf, book_chapters_full,
    book_no_chapters_no_text, no_record}."""
    used = 0
    attached = []
    missing = []
    miss_reasons = {}

    readings = list(entry.get("readings") or [])
    # Stable sort: primary first.
    readings.sort(key=lambda r: 0 if (r and r.get("tier") == "primary") else 1)

    for r in readings:
        name = r.get("filename") or ""
        if not name:
            continue

        # 1. Chapter-split book?
        chapters = book_chapters.get(name)
        if isinstance(chapters, list) and any(c and c.get("file_id") for c in chapters):
            book_used = 0
            attached_any = False
            for ch in chapters:
                if not ch or not ch.get("file_id"):
                    continue
                cost = (ch.get("pages") or 0) * TOKENS_PER_PAGE
                if book_used + cost > PER_BOOK_BUDGET:
                    break
                if used + cost > TOKEN_BUDGET:
                    break
                book_used += cost
                used += cost
                attached_any = True
            if attached_any:
                attached.append(name)
            elif name in readings_text and readings_text[name].get("text"):
                text = readings_text[name]["text"]
                cost = len(text) * TOKENS_PER_TEXT_CHAR
                if used + cost <= TOKEN_BUDGET:
                    used += cost
                    attached.append(name)
                else:
                    missing.append(name)
                    miss_reasons[name] = "book_chapters_full"
            else:
                missing.append(name)
                miss_reasons[name] = "book_chapters_full"
            continue

        # 2. Single Files-API PDF?
        if name in file_ids:
            cost = (r.get("size_bytes") or 0) * TOKENS_PER_PDF_BYTE
            if used + cost > TOKEN_BUDGET:
                missing.append(name)
                # Subdivide: is the PDF alone over budget, or is it the cumulative load?
                if cost > TOKEN_BUDGET:
                    miss_reasons[name] = "pdf_alone_over_budget"
                else:
                    miss_reasons[name] = "budget_exhausted_by_earlier"
                continue
            used += cost
            attached.append(name)
            continue

        # 3. Text excerpt?
        if name in readings_text and readings_text[name].get("text"):
            text = readings_text[name]["text"]
            cost = len(text) * TOKENS_PER_TEXT_CHAR
            if used + cost > TOKEN_BUDGET:
                missing.append(name)
                miss_reasons[name] = "too_big_text"
                continue
            used += cost
            attached.append(name)
            continue

        # 4. Nothing. Distinguish: book listing with no chapters/text, or no record.
        if name in book_chapters:
            # Has an entry but no usable chapters and no text excerpt.
            missing.append(name)
            miss_reasons[name] = "book_no_chapters_no_text"
        else:
            missing.append(name)
            miss_reasons[name] = "no_record"

    return attached, missing, miss_reasons, used


def main():
    readings = load("data/readings.json")
    file_ids = load("data/file_ids.json")
    book_chapters = load("data/book_chapters.json")
    readings_text = load("data/readings_text.json")

    # ---- Run sim ----
    per_q = {}
    for qid, entry in readings.items():
        attached, missing, reasons, used = simulate(
            entry, file_ids, readings_text, book_chapters
        )
        per_q[qid] = {
            "qid": qid,
            "question_text": entry.get("question_text", ""),
            "readings": entry.get("readings", []),
            "attached": attached,
            "missing": missing,
            "reasons": reasons,
            "used_tokens": used,
        }

    # ---- 1. Headline ----
    total_slots = sum(len(d["readings"]) for d in per_q.values())
    total_attached = sum(len(d["attached"]) for d in per_q.values())
    total_missing = sum(len(d["missing"]) for d in per_q.values())
    n_q = len(per_q)
    print("=== 1. HEADLINE ===")
    print(f"questions: {n_q}")
    print(f"total reading-slots: {total_slots}")
    print(f"attached: {total_attached} ({100*total_attached/total_slots:.1f}%)")
    print(f"missing : {total_missing} ({100*total_missing/total_slots:.1f}%)")
    print(f"avg readings attached per question: {total_attached/n_q:.2f}")
    print(f"avg readings listed   per question: {total_slots/n_q:.2f}")

    # ---- 2. Distribution ----
    all_attached = sum(1 for d in per_q.values() if not d["missing"])
    any_missing = sum(1 for d in per_q.values() if d["missing"])
    primary_filenames_per_q = {
        qid: {r["filename"] for r in d["readings"] if r.get("tier") == "primary"}
        for qid, d in per_q.items()
    }
    primary_missing_count_per_q = {
        qid: len(primary_filenames_per_q[qid] & set(d["missing"]))
        for qid, d in per_q.items()
    }
    any_primary_missing = sum(1 for v in primary_missing_count_per_q.values() if v >= 1)
    two_plus_primary_missing = sum(1 for v in primary_missing_count_per_q.values() if v >= 2)
    print("\n=== 2. DISTRIBUTION ===")
    print(f"questions with ALL readings attached: {all_attached}")
    print(f"questions with >=1 missing          : {any_missing}")
    print(f"questions with >=1 PRIMARY missing  : {any_primary_missing}")
    print(f"questions with >=2 PRIMARY missing  : {two_plus_primary_missing}")

    # ---- 3. Top 10 worst-served (lowest attach ratio, >=1 primary missed) ----
    rows = []
    for qid, d in per_q.items():
        total = len(d["readings"])
        if total == 0:
            continue
        attached_n = len(d["attached"])
        ratio = attached_n / total
        prim_missed = primary_missing_count_per_q[qid]
        if prim_missed >= 1:
            rows.append((ratio, qid, attached_n, total, d, prim_missed))
    rows.sort(key=lambda x: (x[0], -x[5], x[1]))
    print("\n=== 3. TOP 10 WORST-SERVED QUESTIONS (>=1 primary dropped) ===")
    for ratio, qid, an, tot, d, prim_missed in rows[:10]:
        qt = d["question_text"][:90].replace("\n", " ")
        print(f"\n{qid} [{an}/{tot} = {ratio:.0%}] primary dropped={prim_missed}")
        print(f"  Q: {qt}")
        for missed_name in d["missing"]:
            why = d["reasons"].get(missed_name, "?")
            tier = next(
                (r.get("tier") for r in d["readings"] if r.get("filename") == missed_name),
                "?",
            )
            print(f"   - DROP [{tier:9s}] [{why}] {missed_name}")

    # ---- 4. Top 10 most-skipped readings ----
    listed = Counter()
    dropped = Counter()
    drop_reasons = defaultdict(Counter)
    sizes = {}
    pages = {}
    for d in per_q.values():
        for r in d["readings"]:
            n = r["filename"]
            listed[n] += 1
            sizes[n] = r.get("size_bytes")
            if n in book_chapters and isinstance(book_chapters[n], list):
                pages[n] = sum((c.get("pages") or 0) for c in book_chapters[n])
        for n in d["missing"]:
            dropped[n] += 1
            drop_reasons[n][d["reasons"][n]] += 1
    multi_listed_skipped = [
        (n, listed[n], dropped[n], dropped[n] / listed[n], drop_reasons[n])
        for n in listed
        if listed[n] >= 2 and dropped[n] >= 1
    ]
    multi_listed_skipped.sort(key=lambda x: (-x[2], -x[3], x[0]))
    print("\n=== 4. TOP 10 MOST-SKIPPED READINGS (>=2 listings, >=1 drop) ===")
    print(f"{'file':70s} {'sz_bytes':>10s} {'listed':>6s} {'drop':>5s} {'drop%':>6s} reasons")
    for n, lst, drp, frac, rsn in multi_listed_skipped[:10]:
        sz = sizes.get(n)
        sz_s = f"{sz}" if sz else "-"
        rsn_s = ", ".join(f"{k}:{v}" for k, v in rsn.most_common())
        print(f"{n[:70]:70s} {sz_s:>10s} {lst:>6d} {drp:>5d} {frac*100:5.0f}% {rsn_s}")

    # Singletons that drop too:
    single_dropped = sorted(
        [(n, dropped[n], drop_reasons[n]) for n in listed if listed[n] == 1 and dropped[n] >= 1],
        key=lambda x: x[0],
    )
    print(f"\n(also: {len(single_dropped)} singleton readings drop on their one question)")

    # ---- 5. Failure-mode breakdown ----
    all_reasons = Counter()
    for d in per_q.values():
        for n in d["missing"]:
            all_reasons[d["reasons"][n]] += 1
    total_missing_events = sum(all_reasons.values())
    print("\n=== 5. FAILURE-MODE BREAKDOWN ===")
    for reason, count in all_reasons.most_common():
        print(f"  {reason:30s} {count:4d}  ({100*count/total_missing_events:5.1f}%)")

    # ---- 6. Concrete fix priorities ----
    # For each unique dropped reading, count distinct questions it would unblock.
    # We approximate "unblock" as: if we removed this drop entirely (assume the
    # reading attaches at zero/low cost), would the question's missing list shrink
    # by one? Yes, by definition. We'll group fixes by REASON and rank by
    # questions touched.
    fix_groups = defaultdict(lambda: defaultdict(set))  # reason -> filename -> qids
    for qid, d in per_q.items():
        for n, why in d["reasons"].items():
            fix_groups[why][n].add(qid)

    print("\n=== 6. CONCRETE FIX PRIORITIES ===")
    # 6a. Books with no chapters and no text (split into chapters or extract text)
    print("\n[A] Books missing both chapter-split AND text fallback:")
    no_ch_no_txt = fix_groups.get("book_no_chapters_no_text", {})
    rows_a = sorted(
        [(n, len(qids)) for n, qids in no_ch_no_txt.items()],
        key=lambda x: -x[1],
    )
    for n, qcount in rows_a:
        sz = sizes.get(n)
        print(f"  +{qcount} questions if fixed: {n} (size={sz})")

    # 6b. PDFs alone over the 160k budget (must be split / text-extracted).
    print("\n[B1] Single PDFs whose ALONE cost > 160k budget (must split/extract):")
    too_big_alone = fix_groups.get("pdf_alone_over_budget", {})
    rows_b1 = sorted(
        [(n, len(qids), sizes.get(n) or 0) for n, qids in too_big_alone.items()],
        key=lambda x: (-x[1], -x[2]),
    )
    for n, qcount, sz in rows_b1:
        cost = sz * TOKENS_PER_PDF_BYTE
        print(f"  +{qcount} qs if split/extracted: {n} (size={sz}, ~{cost:,.0f} tok)")

    # 6b'. Budget exhausted by earlier readings.
    print("\n[B2] PDFs dropped because earlier readings already exhausted the per-call budget:")
    too_big_cum = fix_groups.get("budget_exhausted_by_earlier", {})
    rows_b2 = sorted(
        [(n, len(qids), sizes.get(n) or 0) for n, qids in too_big_cum.items()],
        key=lambda x: -x[1],
    )
    for n, qcount, sz in rows_b2:
        cost = sz * TOKENS_PER_PDF_BYTE
        print(f"  +{qcount} qs if budget freed: {n} (size={sz}, ~{cost:,.0f} tok)")

    # 6c. Books whose per-book budget runs out before all chapters fit:
    print("\n[C] Chapter-books where per-book budget exhausts:")
    bk_full = fix_groups.get("book_chapters_full", {})
    rows_c = sorted(
        [(n, len(qids)) for n, qids in bk_full.items()],
        key=lambda x: -x[1],
    )
    for n, qcount in rows_c:
        pg = pages.get(n)
        print(f"  +{qcount} questions if better-targeted chapters: {n} (total_pages={pg})")

    # 6d. Files with no record at all
    print("\n[D] Readings with no upload, no chapters, no text (fully missing):")
    no_record = fix_groups.get("no_record", {})
    rows_d = sorted(
        [(n, len(qids)) for n, qids in no_record.items()],
        key=lambda x: -x[1],
    )
    for n, qcount in rows_d:
        print(f"  +{qcount} questions if uploaded: {n}")

    # ---- 7. A handful of concrete examples (full text) for the report ----
    print("\n=== 7. THREE CONCRETE EXAMPLES ===")
    for ratio, qid, an, tot, d, prim_missed in rows[:3]:
        print(f"\n{qid}  attached {an}/{tot}  primary-dropped {prim_missed}")
        print(f"  Q: {d['question_text']}")
        for r in d["readings"]:
            n = r["filename"]
            tier = r.get("tier")
            if n in d["missing"]:
                why = d["reasons"][n]
                print(f"   DROP [{tier}] [{why}] {n} (size={r.get('size_bytes')})")
            else:
                print(f"   keep [{tier}] {n}")


if __name__ == "__main__":
    main()
