"""Issues Study Lab — Flask broker between the browser UI and Vertex AI.

Endpoints:
  GET  /                    - index.html
  GET  /<file>              - static asset (script.js, styles.css, etc.)
  GET  /api/questions       - list of MVP questions
  POST /api/readings        - {question_id} -> readings + dialectic blurb
  POST /api/chat            - {question_id, message, history} -> model reply
  POST /api/feedback        - {question_id, draft_text} -> rubric grading

Auth: shares the service-account JSON used by the ai-image MCP server.
Bills against GCP project `gen-lang-client-0274569601` in us-central1.
"""

from __future__ import annotations

import html as html_module
import io
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any

import fitz
from flask import Flask, Response, jsonify, request, send_from_directory
from flask_cors import CORS
from google import genai
from google.genai import types

# ── Configuration ──────────────────────────────────────────────────────────
LAB_DIR = Path(__file__).resolve().parent
SA_JSON_PATH = Path.home() / ".mcp-servers" / "ai-image" / "service-account.json"
GCP_PROJECT_ID = "gen-lang-client-0274569601"
GCP_LOCATION = "us-central1"
MODEL = "gemini-2.5-pro"

CACHE_HANDLES = json.loads((LAB_DIR / "cache_handles.json").read_text(encoding="utf-8"))
PACK_META = json.loads((LAB_DIR / "pack_metadata.json").read_text(encoding="utf-8"))

EXTRACTED = LAB_DIR / "extracted_docx"
RUBRIC_TEXT = (EXTRACTED / "assessment_advice.txt").read_text(encoding="utf-8")
SUBJECT_OUTLINE = (EXTRACTED / "subject_outline.txt").read_text(encoding="utf-8")
TASK_SHEET = (EXTRACTED / "task_sheet.txt").read_text(encoding="utf-8")
EXEMPLAR_A = (EXTRACTED / "exemplar_a_minus.txt").read_text(encoding="utf-8")
EXEMPLAR_B = (EXTRACTED / "exemplar_b.txt").read_text(encoding="utf-8")
EXEMPLAR_C = (EXTRACTED / "exemplar_c_plus.txt").read_text(encoding="utf-8")

# Map question domain → which SACE-supplied exemplar best demonstrates the
# argumentative pattern the student should aim for.
EXEMPLAR_FOR_DOMAIN = {
    "ethics": ("A-", EXEMPLAR_A),
    "metaphysics": ("A-", EXEMPLAR_A),
    "epistemology": ("A-", EXEMPLAR_A),
    "political": ("A-", EXEMPLAR_A),
    "mind_tech": ("B", EXEMPLAR_B),  # Same question as Q5 (phil zombies)
    "religion": ("C+", EXEMPLAR_C),  # Same question (God)
    "aesthetics": ("A-", EXEMPLAR_A),
    "hybrid": ("A-", EXEMPLAR_A),
}

# ── Auth ───────────────────────────────────────────────────────────────────
# Local dev: read the SA JSON from disk and point GOOGLE_APPLICATION_CREDENTIALS at it.
# Cloud Run / GCE: no JSON on disk; the runtime binds the SA via the metadata
# server, and the google-genai client picks up Application Default Credentials
# automatically. Skip the file check in that case.
_ON_CLOUD_RUN = bool(
    os.environ.get("K_SERVICE")
    or os.environ.get("CLOUD_RUN_JOB")
    or os.environ.get("K_CONFIGURATION")
)
if SA_JSON_PATH.exists():
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = str(SA_JSON_PATH)
elif not _ON_CLOUD_RUN:
    raise SystemExit(
        f"service-account.json not found at {SA_JSON_PATH} (and not running on Cloud Run)"
    )

vertex_client = genai.Client(
    vertexai=True,
    project=GCP_PROJECT_ID,
    location=GCP_LOCATION,
)

# ── Logging ────────────────────────────────────────────────────────────────
LOG_PATH = LAB_DIR / "server.log"
logger = logging.getLogger("lab")
logger.setLevel(logging.INFO)
_handler = logging.FileHandler(LOG_PATH, encoding="utf-8")
_handler.setFormatter(logging.Formatter("%(message)s"))
logger.addHandler(_handler)


def log_event(event: dict[str, Any]) -> None:
    event["ts"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    logger.info(json.dumps(event, ensure_ascii=False, default=str))


def estimate_cost_usd(usage: Any, *, cached: bool) -> float:
    """Rough Gemini 2.5 Pro cost. Source: Vertex AI pricing as of 2026-04."""
    if not usage:
        return 0.0
    prompt_tokens = getattr(usage, "prompt_token_count", 0) or 0
    cached_tokens = getattr(usage, "cached_content_token_count", 0) or 0
    output_tokens = getattr(usage, "candidates_token_count", 0) or 0
    # Pro: input $1.25/M, cached input $0.31/M, output $10.00/M
    non_cached_input = max(0, prompt_tokens - cached_tokens)
    cost = (
        non_cached_input * 1.25 / 1_000_000
        + cached_tokens * 0.31 / 1_000_000
        + output_tokens * 10.00 / 1_000_000
    )
    return round(cost, 6)


# ── Flask app ──────────────────────────────────────────────────────────────
app = Flask(__name__, static_folder=None)

# CORS allowlist. Locally allows the broker's own origins; in production
# (Netlify -> Cloud Run) reads CORS_ORIGINS as a comma-separated list.
_DEFAULT_ORIGINS = ["http://localhost:5050", "http://127.0.0.1:5050"]
_extra = os.environ.get("CORS_ORIGINS", "")
_origins = _DEFAULT_ORIGINS + [o.strip() for o in _extra.split(",") if o.strip()]
CORS(app, resources={r"/api/*": {"origins": _origins}})


# ── Static ────────────────────────────────────────────────────────────────
@app.route("/")
def root():
    return send_from_directory(str(LAB_DIR), "index.html")


@app.route("/<path:filename>")
def static_files(filename: str):
    """Serve only whitelisted static assets — no traversal into JSON / logs."""
    allowed = {"index.html", "script.js", "styles.css", "favicon.ico"}
    # Allow screenshots subfolder for preview from the test harness
    if filename in allowed:
        return send_from_directory(str(LAB_DIR), filename)
    return ("Not found", 404)


# ── /api/questions ────────────────────────────────────────────────────────
@app.route("/api/questions", methods=["GET", "POST"])
def api_questions():
    questions = []
    for qid, info in CACHE_HANDLES["questions"].items():
        questions.append({
            "id": qid,
            "domain": info["domain"],
            "subdomain": info.get("subdomain") or "",
            "cluster_pack": info.get("cluster_pack"),
            "cluster_display_name": info.get("cluster_display_name") or "",
            "text": info["question_text"],
        })
    domain_order = {"ethics": 1, "metaphysics": 2, "epistemology": 3, "political": 4, "religion": 5, "mind_tech": 6, "aesthetics": 7, "hybrid": 8}
    questions.sort(key=lambda q: (domain_order.get(q["domain"], 99), q["text"]))
    log_event({"endpoint": "/api/questions", "count": len(questions)})
    return jsonify({"questions": questions})


# ── /api/readings ─────────────────────────────────────────────────────────
@app.route("/api/readings", methods=["POST"])
def api_readings():
    body = request.get_json(force=True)
    qid = body.get("question_id")
    if qid not in PACK_META:
        return jsonify({"error": f"unknown question_id: {qid}"}), 400

    meta = PACK_META[qid]
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

    log_event({
        "endpoint": "/api/readings",
        "question_id": qid,
        "count": len(readings),
    })
    return jsonify({
        "question_id": qid,
        "question_text": meta["question_text"],
        "domain": meta["domain"],
        "subdomain": meta.get("subdomain") or "",
        "cluster_pack": meta.get("cluster_pack"),
        "cluster_display_name": meta.get("cluster_display_name"),
        "dialectic": meta.get("dialectic", ""),
        "readings": readings,
    })


# ── GET /readings/<filename> ── source PDF download ──────────────────────
@app.route("/readings/<path:filename>")
def serve_reading(filename: str):
    """Download a curated reading from readings/. Path-traversal safe."""
    readings_dir = LAB_DIR / "readings"
    safe = re.sub(r"[\\/]", "", filename)
    target = readings_dir / safe
    if not target.is_file():
        return ("Not found", 404)
    return send_from_directory(str(readings_dir), safe, as_attachment=False)


# ── /api/chat ─────────────────────────────────────────────────────────────
def _to_contents(history: list[dict], message: str) -> list[types.Content]:
    contents: list[types.Content] = []
    for turn in history or []:
        role = turn.get("role", "user")
        text = turn.get("text") or ""
        if not text and "parts" in turn:
            parts = turn["parts"]
            if parts and isinstance(parts, list):
                text = parts[0].get("text", "")
        if not text:
            continue
        contents.append(types.Content(role=role, parts=[types.Part.from_text(text=text)]))
    contents.append(types.Content(role="user", parts=[types.Part.from_text(text=message)]))
    return contents


@app.route("/api/chat", methods=["POST"])
def api_chat():
    body = request.get_json(force=True)
    qid = body.get("question_id")
    message = body.get("message", "").strip()
    history = body.get("history", [])

    if qid not in CACHE_HANDLES["questions"]:
        return jsonify({"error": f"unknown question_id: {qid}"}), 400
    if not message:
        return jsonify({"error": "message is required"}), 400

    cache_name = CACHE_HANDLES["questions"][qid]["cache_name"]
    contents = _to_contents(history, message)

    started = time.time()
    try:
        response = vertex_client.models.generate_content(
            model=MODEL,
            contents=contents,
            config=types.GenerateContentConfig(
                cached_content=cache_name,
                max_output_tokens=2048,
                temperature=0.4,
            ),
        )
    except Exception as e:
        log_event({
            "endpoint": "/api/chat",
            "question_id": qid,
            "error": str(e),
            "duration_ms": int((time.time() - started) * 1000),
        })
        return jsonify({"error": "model call failed", "detail": str(e)}), 500

    duration_ms = int((time.time() - started) * 1000)
    text = getattr(response, "text", None) or ""
    if not text:
        # Defensive: walk candidates
        try:
            text = "".join(
                p.text or "" for c in response.candidates or [] for p in (c.content.parts or [])
            )
        except Exception:
            text = ""
    usage = getattr(response, "usage_metadata", None)
    cost = estimate_cost_usd(usage, cached=True)

    log_event({
        "endpoint": "/api/chat",
        "question_id": qid,
        "message_chars": len(message),
        "history_turns": len(history),
        "duration_ms": duration_ms,
        "usage": {
            "prompt_tokens": getattr(usage, "prompt_token_count", None),
            "cached_tokens": getattr(usage, "cached_content_token_count", None),
            "output_tokens": getattr(usage, "candidates_token_count", None),
            "total_tokens": getattr(usage, "total_token_count", None),
        } if usage else None,
        "estimated_cost_usd": cost,
    })

    return jsonify({
        "question_id": qid,
        "text": text,
        "duration_ms": duration_ms,
        "estimated_cost_usd": cost,
    })


# ── /api/feedback ─────────────────────────────────────────────────────────
FEEDBACK_TEMPLATE = """You are a SACE Stage 2 Philosophy moderator giving criterion-referenced feedback on a student's draft Issues Study response. The Issues Study is graded against the standard SACE Stage 2 Philosophy rubric (KU1-2, RA1-3, CA1, C1-2).

THE STUDENT'S QUESTION:
{question_text}

THE TASK SHEET (what students must address):
{task_sheet}

THE SACE ASSESSMENT ADVICE (rubric guidance):
{rubric_text}

REFERENCE EXEMPLAR — graded {exemplar_grade} by SACE moderators:
\"\"\"
{exemplar_text}
\"\"\"

THE STUDENT'S DRAFT:
\"\"\"
{draft_text}
\"\"\"

Provide concrete, criterion-referenced feedback structured as Markdown with the following sections (use exactly these headings):

## KU1 (philosophical issue)
- Observation: [1-2 sentences quoting or paraphrasing the draft]
- Improvement: [specific, actionable]

## KU2 (positions and reasoning)
- Observation:
- Improvement:

## RA1 (philosophical nature)
- Observation:
- Improvement:

## RA2 (logic and evidence)
- Observation:
- Improvement:

## RA3 (own position formulation)
- Observation:
- Improvement:

## CA1 (critical analysis)
- Observation:
- Improvement:

## C1-C2 (communication)
- Observation:
- Improvement:

## Predicted grade band
[E / D / C / B / A — single letter only, then a sentence justifying it. Be honest; do not be generous.]

## Top 3 priorities for revision
1. [most important]
2.
3.

Be specific. Reference passages from the draft. Predict the band SACE would actually award — not the band the student would prefer.
"""


@app.route("/api/feedback", methods=["POST"])
def api_feedback():
    body = request.get_json(force=True)
    qid = body.get("question_id")
    draft_text = (body.get("draft_text") or "").strip()

    if qid not in CACHE_HANDLES["questions"]:
        return jsonify({"error": f"unknown question_id: {qid}"}), 400
    if not draft_text:
        return jsonify({"error": "draft_text is required"}), 400
    if len(draft_text) < 200:
        return jsonify({"error": "draft is too short for meaningful feedback (min 200 chars)"}), 400

    info = CACHE_HANDLES["questions"][qid]
    domain = info["domain"]
    exemplar_grade, exemplar_text = EXEMPLAR_FOR_DOMAIN.get(domain, ("A-", EXEMPLAR_A))

    prompt = FEEDBACK_TEMPLATE.format(
        question_text=info["question_text"],
        task_sheet=TASK_SHEET,
        rubric_text=RUBRIC_TEXT,
        exemplar_grade=exemplar_grade,
        exemplar_text=exemplar_text,
        draft_text=draft_text,
    )

    started = time.time()
    try:
        response = vertex_client.models.generate_content(
            model=MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                temperature=0.2,
                max_output_tokens=4096,
            ),
        )
    except Exception as e:
        log_event({
            "endpoint": "/api/feedback",
            "question_id": qid,
            "error": str(e),
            "duration_ms": int((time.time() - started) * 1000),
        })
        return jsonify({"error": "model call failed", "detail": str(e)}), 500

    duration_ms = int((time.time() - started) * 1000)
    text = getattr(response, "text", None) or ""
    if not text:
        try:
            text = "".join(
                p.text or "" for c in response.candidates or [] for p in (c.content.parts or [])
            )
        except Exception:
            text = ""

    usage = getattr(response, "usage_metadata", None)
    cost = estimate_cost_usd(usage, cached=False)

    log_event({
        "endpoint": "/api/feedback",
        "question_id": qid,
        "draft_chars": len(draft_text),
        "exemplar_used": exemplar_grade,
        "duration_ms": duration_ms,
        "usage": {
            "prompt_tokens": getattr(usage, "prompt_token_count", None),
            "output_tokens": getattr(usage, "candidates_token_count", None),
            "total_tokens": getattr(usage, "total_token_count", None),
        } if usage else None,
        "estimated_cost_usd": cost,
    })

    return jsonify({
        "question_id": qid,
        "exemplar_used": exemplar_grade,
        "feedback_markdown": text,
        "duration_ms": duration_ms,
        "estimated_cost_usd": cost,
    })


# ── /api/export_pdf ───────────────────────────────────────────────────────
def _md_to_html(md: str) -> str:
    """Tiny markdown -> HTML for the PDF story.

    Handles ## / ### headings, **bold**, *italic*, `code`, blockquotes, and
    unordered/ordered lists. Paragraphs are blank-line separated.
    """
    if not md:
        return ""
    out: list[str] = []
    buf: list[str] = []
    list_open: str | None = None
    list_items: list[str] = []

    def esc(s: str) -> str:
        return html_module.escape(s)

    def render_inline(s: str) -> str:
        s = esc(s)
        s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
        s = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", s)
        s = re.sub(r"(?<!\*)\*([^*]+)\*", r"<i>\1</i>", s)
        return s

    def flush_para() -> None:
        if buf:
            out.append("<p>" + render_inline(" ".join(buf).strip()) + "</p>")
            buf.clear()

    def flush_list() -> None:
        nonlocal list_open
        if list_open and list_items:
            out.append(
                f"<{list_open}>"
                + "".join(f"<li>{render_inline(i)}</li>" for i in list_items)
                + f"</{list_open}>"
            )
        list_open = None
        list_items.clear()

    for raw in md.splitlines():
        line = raw.rstrip()
        if not line.strip():
            flush_para()
            flush_list()
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            flush_para()
            flush_list()
            level = min(6, len(m.group(1)) + 1)
            out.append(f"<h{level}>{render_inline(m.group(2))}</h{level}>")
            continue
        m = re.match(r"^\s*[-*]\s+(.*)$", line)
        if m:
            flush_para()
            if list_open != "ul":
                flush_list()
                list_open = "ul"
            list_items.append(m.group(1))
            continue
        m = re.match(r"^\s*\d+[.)]\s+(.*)$", line)
        if m:
            flush_para()
            if list_open != "ol":
                flush_list()
                list_open = "ol"
            list_items.append(m.group(1))
            continue
        m = re.match(r"^>\s?(.*)$", line)
        if m:
            flush_para()
            flush_list()
            out.append(f"<blockquote>{render_inline(m.group(1))}</blockquote>")
            continue
        buf.append(line)
    flush_para()
    flush_list()
    return "\n".join(out)


_PDF_STYLE = """
<style>
  body { font-family: 'Source Sans 3','Helvetica',sans-serif; color:#1a1a1a; }
  h1 { font-size: 22pt; font-weight: 700; margin-bottom: 4pt; }
  h2 { font-size: 14pt; font-weight: 700; margin-top: 14pt; margin-bottom: 4pt; border-bottom: 1pt solid #aaa; padding-bottom: 2pt; }
  h3 { font-size: 12pt; font-weight: 700; margin-top: 10pt; margin-bottom: 2pt; color: #5a3e2b; }
  p, li { font-size: 10.5pt; line-height: 1.45; }
  .meta { color: #555; font-size: 9pt; margin-bottom: 14pt; }
  .turn { margin-bottom: 8pt; }
  .turn-label { font-size: 9pt; letter-spacing: 1px; color: #777; text-transform: uppercase; margin-bottom: 1pt; }
  .turn-user .turn-body { background: #f1e5cd; padding: 4pt 6pt; border-radius: 3pt; }
  .turn-model .turn-body { padding: 4pt 0; border-left: 3pt solid #8c6a4f; padding-left: 8pt; }
  blockquote { border-left: 3pt solid #aaa; padding: 0 8pt; color: #555; margin: 4pt 0; font-style: italic; }
  code { font-family: 'Consolas','Menlo',monospace; background: #eee; padding: 0 2pt; border-radius: 2pt; font-size: 9.5pt; }
  .draft { white-space: pre-wrap; font-size: 10.5pt; line-height: 1.5; padding: 6pt 8pt; background: #fafafa; border: 1pt solid #ddd; }
  .page-break { page-break-before: always; }
  hr { border: 0; border-top: 1pt dashed #aaa; margin: 8pt 0; }
</style>
"""


def _build_export_html(student_name: str, qid: str, info: dict, history: list, draft: str, feedback_md: str) -> str:
    parts: list[str] = [_PDF_STYLE]
    date_str = time.strftime("%Y-%m-%d %H:%M")
    parts.append(
        "<h1>Issues Study Lab -- Session export</h1>"
        f"<div class='meta'>"
        f"<b>Student:</b> {html_module.escape(student_name)}<br/>"
        f"<b>Question ID:</b> {html_module.escape(qid)} ({html_module.escape(info['domain'])})<br/>"
        f"<b>Question:</b> {html_module.escape(info['question_text'])}<br/>"
        f"<b>Exported:</b> {date_str}"
        f"</div>"
    )

    parts.append("<h2>Chat history</h2>")
    if not history:
        parts.append("<p><i>No chat messages saved.</i></p>")
    else:
        for turn in history:
            role = (turn.get("role") or "user").lower()
            label = "Student" if role == "user" else "Library"
            text = turn.get("text") or ""
            klass = "turn-user" if role == "user" else "turn-model"
            parts.append(
                f"<div class='turn {klass}'>"
                f"<div class='turn-label'>{label}</div>"
                f"<div class='turn-body'>{_md_to_html(text)}</div>"
                f"</div>"
            )

    parts.append("<div class='page-break'></div>")
    parts.append("<h2>Draft response</h2>")
    if draft.strip():
        parts.append(f"<div class='draft'>{html_module.escape(draft)}</div>")
    else:
        parts.append("<p><i>No draft saved.</i></p>")

    parts.append("<div class='page-break'></div>")
    parts.append("<h2>Feedback</h2>")
    if feedback_md.strip():
        parts.append(_md_to_html(feedback_md))
    else:
        parts.append("<p><i>No feedback saved. Click <b>Get feedback</b> in the Lab to generate one.</i></p>")

    return "<html><body>" + "".join(parts) + "</body></html>"


def _render_html_to_pdf_bytes(html_doc: str) -> bytes:
    page_w, page_h = fitz.paper_size("A4")
    margin = 50
    rect = fitz.Rect(margin, margin, page_w - margin, page_h - margin)
    buf = io.BytesIO()
    writer = fitz.DocumentWriter(buf)
    story = fitz.Story(html=html_doc)
    while True:
        device = writer.begin_page(fitz.Rect(0, 0, page_w, page_h))
        more, _filled = story.place(rect)
        story.draw(device, None)
        writer.end_page()
        if not more:
            break
    writer.close()
    return buf.getvalue()


@app.route("/api/export_pdf", methods=["POST"])
def api_export_pdf():
    body = request.get_json(force=True)
    student_name = (body.get("student_name") or "").strip()
    qid = body.get("question_id")
    history = body.get("history") or []
    draft = body.get("draft") or ""
    feedback = body.get("feedback") or ""

    if not student_name:
        return jsonify({"error": "student_name is required"}), 400
    if qid not in CACHE_HANDLES["questions"]:
        return jsonify({"error": f"unknown question_id: {qid}"}), 400

    info = CACHE_HANDLES["questions"][qid]
    started = time.time()
    try:
        html_doc = _build_export_html(student_name, qid, info, history, draft, feedback)
        pdf_bytes = _render_html_to_pdf_bytes(html_doc)
    except Exception as e:
        log_event({
            "endpoint": "/api/export_pdf",
            "question_id": qid,
            "student_name": student_name,
            "error": str(e),
        })
        return jsonify({"error": "PDF render failed", "detail": str(e)}), 500

    duration_ms = int((time.time() - started) * 1000)
    safe = re.sub(r"[^a-zA-Z0-9]+", "_", student_name).strip("_")[:30] or "student"
    filename = f"issues_study_{safe}_{qid}_{time.strftime('%Y%m%d_%H%M')}.pdf"

    log_event({
        "endpoint": "/api/export_pdf",
        "question_id": qid,
        "student_name": student_name,
        "history_turns": len(history),
        "draft_chars": len(draft),
        "feedback_chars": len(feedback),
        "pdf_bytes": len(pdf_bytes),
        "duration_ms": duration_ms,
    })

    return Response(
        pdf_bytes,
        mimetype="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Entrypoint ────────────────────────────────────────────────────────────
if __name__ == "__main__":
    # Cloud Run / containers: PORT is set by the platform, listen on 0.0.0.0.
    # Local dev: defaults to 127.0.0.1:5050.
    port = int(os.environ.get("PORT", "5050"))
    host = os.environ.get("HOST", "0.0.0.0" if "PORT" in os.environ else "127.0.0.1")
    log_event({
        "endpoint": "_startup",
        "lab_dir": str(LAB_DIR),
        "model": MODEL,
        "host": host,
        "port": port,
        "n_questions": len(CACHE_HANDLES["questions"]),
        "n_clusters": len(CACHE_HANDLES.get("clusters", {})),
    })
    app.run(host=host, port=port, debug=False, threaded=True)
