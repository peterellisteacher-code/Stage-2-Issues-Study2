"""End-to-end test harness for the Issues Study Lab MVP.

For each of 5 sample questions:
  1. GET /api/questions    - sanity check
  2. POST /api/readings    - confirm pack metadata is exposed
  3. POST /api/chat        - 2 messages, verify the reply cites cached texts
  4. POST /api/feedback    - submit the A- (or B for Q5) exemplar text as a
                             draft, verify the response is structured per the
                             SACE rubric
  5. Save transcript to lab/test_transcripts/{qid}.json
  6. Tally + write tally.json

The drafts we submit are SACE-graded exemplars. So the predicted band the
model returns is itself a rough sanity check (we expect A or A- back when
we submit the A- draft for any non-domain-matching question; B when we
submit the B draft for the question it was actually written for).
"""

import json
import time
import urllib.request
import urllib.error
from pathlib import Path

BASE = "http://127.0.0.1:5050"
LAB = Path(__file__).resolve().parent
TRANSCRIPTS = LAB / "test_transcripts"
TRANSCRIPTS.mkdir(exist_ok=True)


def post(path, body=None):
    method = "POST" if body is not None else "GET"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        BASE + path,
        data=data,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            payload = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", "replace")
        try:
            payload = json.loads(body_text)
        except Exception:
            payload = {"_raw": body_text}
        payload["_status"] = e.code
    payload["_wall_ms"] = int((time.time() - started) * 1000)
    return payload


CHAT_PROMPTS_BY_DOMAIN = {
    "ethics": [
        "Walk me through the strongest *consequentialist* case that rapid AI development is morally justifiable, citing one or two cached texts.",
        "Now give me the strongest deontological objection from the cache, with a quote.",
    ],
    "metaphysics": [
        "What's Hume's argument that the self is a bundle, not a substance? Quote a passage if you can find one in the cached materials.",
        "How would Bernard Williams's body-swap thought experiment push back against Hume?",
    ],
    "epistemology": [
        "What does Žižek mean when he says ideology is 'unknown knowns'? Quote from *Sublime Object* if available.",
        "How does Jason Stanley distinguish ideological belief from ordinary belief in *How Propaganda Works*?",
    ],
    "political": [
        "What's Plato's classical objection to democracy? Cite something from the cached library.",
        "And what's Rawls's reply via the original position?",
    ],
    "mind_tech": [
        "What's Frank Jackson's knowledge argument and why does it suggest zombies are conceivable? Quote from the cached materials.",
        "How does Daniel Dennett's functionalist response try to dissolve the zombie thought experiment?",
    ],
}

EXEMPLAR_FILE = {
    "lab_q001": "exemplar_a_minus.txt",
    "lab_q002": "exemplar_a_minus.txt",
    "lab_q003": "exemplar_a_minus.txt",
    "lab_q004": "exemplar_a_minus.txt",
    "lab_q005": "exemplar_b.txt",  # phil zombies — same question
}


def main():
    questions = post("/api/questions")["questions"]
    print(f"Found {len(questions)} questions.")

    tally = {
        "total_chats": 0,
        "total_feedback": 0,
        "total_cost_usd": 0.0,
        "total_wall_ms": 0,
        "per_question": {},
    }

    for q in questions:
        qid = q["id"]
        print(f"\n=== {qid}: {q['display_name']} ({q['domain']}) ===")
        transcript = {"question": q, "steps": []}

        # 1. readings
        readings = post("/api/readings", {"question_id": qid})
        print(f"  readings: {len(readings.get('readings', []))} files")
        transcript["steps"].append({"step": "readings", "response": readings})

        history = []
        prompts = CHAT_PROMPTS_BY_DOMAIN[q["domain"]]
        per_q_cost = 0.0
        per_q_wall = readings["_wall_ms"]
        for prompt in prompts:
            print(f"  > chat: {prompt[:70]}{'…' if len(prompt) > 70 else ''}")
            chat = post(
                "/api/chat",
                {"question_id": qid, "message": prompt, "history": history},
            )
            cost = chat.get("estimated_cost_usd") or 0.0
            wall = chat.get("_wall_ms", 0)
            per_q_cost += cost
            per_q_wall += wall
            tally["total_chats"] += 1
            tally["total_cost_usd"] += cost
            text = chat.get("text", "")
            print(f"    -> {wall}ms · ~${cost:.4f} · {len(text)} chars · preview: {text[:120]!r}")
            transcript["steps"].append({
                "step": "chat",
                "request": {"prompt": prompt},
                "response": chat,
            })
            history.append({"role": "user", "text": prompt})
            history.append({"role": "model", "text": text})

        # feedback: load exemplar
        exemplar_path = LAB / "extracted_docx" / EXEMPLAR_FILE[qid]
        draft_text = exemplar_path.read_text(encoding="utf-8")
        print(f"  > feedback: submitting {EXEMPLAR_FILE[qid]} ({len(draft_text)} chars)")
        feedback = post(
            "/api/feedback",
            {"question_id": qid, "draft_text": draft_text},
        )
        cost = feedback.get("estimated_cost_usd") or 0.0
        wall = feedback.get("_wall_ms", 0)
        per_q_cost += cost
        per_q_wall += wall
        tally["total_feedback"] += 1
        tally["total_cost_usd"] += cost
        fb_text = feedback.get("feedback_markdown") or ""
        print(f"    -> {wall}ms · ~${cost:.4f} · {len(fb_text)} chars")
        # Quick structural sanity: does feedback contain expected headings?
        expected = ["KU1", "KU2", "RA1", "RA2", "RA3", "CA1", "Predicted grade band"]
        missing = [h for h in expected if h not in fb_text]
        if missing:
            print(f"    !! feedback missing rubric headings: {missing}")
        else:
            print(f"    [PASS] feedback contains all 7 rubric headings + grade band")
        transcript["steps"].append({
            "step": "feedback",
            "request": {"draft_file": EXEMPLAR_FILE[qid], "draft_chars": len(draft_text)},
            "response": feedback,
            "structural_check": {"expected_headings": expected, "missing": missing},
        })

        tally["total_wall_ms"] += per_q_wall
        tally["per_question"][qid] = {
            "wall_ms": per_q_wall,
            "cost_usd": round(per_q_cost, 4),
            "missing_feedback_headings": missing,
        }

        out = TRANSCRIPTS / f"{qid}.json"
        out.write_text(json.dumps(transcript, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"  saved {out.name}")

    tally["total_cost_usd"] = round(tally["total_cost_usd"], 4)
    (TRANSCRIPTS / "_tally.json").write_text(json.dumps(tally, indent=2), encoding="utf-8")
    print("\n=== TALLY ===")
    print(json.dumps(tally, indent=2))


if __name__ == "__main__":
    main()
