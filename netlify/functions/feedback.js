// netlify/functions/feedback.js
// POST /api/feedback -> Claude Haiku 4.5, criterion-referenced grading.
// Body: { question_id, draft_text }
//
// Streaming response (same SSE shape as chat.js): heartbeats while waiting on
// Anthropic; final SSE `result` event carries the JSON payload. Same Akamai-
// timeout fix.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Don't shadow the auto-injected __filename/__dirname Netlify's bundler adds.
const HERE_DIR = path.dirname(fileURLToPath(import.meta.url));

const MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 2048;
const MIN_DRAFT_LEN = 200;
const HEARTBEAT_MS = 5000;
const WORK_TIMEOUT_MS = 50_000;

function loadJsonOnce(name, cacheRef) {
  if (cacheRef.value) return cacheRef.value;
  const candidates = [
    path.join(HERE_DIR, "..", "..", "data", name),
    path.join(process.cwd(), "data", name),
  ];
  let lastErr;
  for (const p of candidates) {
    try {
      cacheRef.value = JSON.parse(fs.readFileSync(p, "utf8"));
      return cacheRef.value;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`Could not load data/${name}: ${lastErr && lastErr.message}`);
}
const _readingsCache = { value: null };
const _rubricCache = { value: null };
const _fileIdsCache = { value: null };
const _readingsTextCache = { value: null };
const _bookChaptersCache = { value: null };
const loadReadings = () => loadJsonOnce("readings.json", _readingsCache);
const loadRubric = () => loadJsonOnce("rubric.json", _rubricCache);
const loadFileIds = () => {
  try { return loadJsonOnce("file_ids.json", _fileIdsCache); }
  catch { _fileIdsCache.value = {}; return _fileIdsCache.value; }
};
const loadReadingsText = () => {
  try { return loadJsonOnce("readings_text.json", _readingsTextCache); }
  catch { _readingsTextCache.value = {}; return _readingsTextCache.value; }
};
const loadBookChapters = () => {
  try { return loadJsonOnce("book_chapters.json", _bookChaptersCache); }
  catch { _bookChaptersCache.value = {}; return _bookChaptersCache.value; }
};

const SYSTEM_PROMPT = `You are a SACE Stage 2 Philosophy moderator giving formative feedback on a student's Issues Study (AT3) draft. The student must investigate one philosophical issue, present multiple positions with their reasoning, raise objections, and defend their own answer.

You will be given:
1. The full SACE rubric and assessment design criteria.
2. A grade-banded exemplar at a specific level, for calibration.
3. The student's question and current draft.
4. The curated readings the student has been given access to, attached as documents.

Your job is to return structured, criterion-referenced feedback in markdown. Be honest, concrete, and constructive. The student needs to know what's working, what's missing, and what to do next.

When the student attributes a position or quotation to a philosopher, check it against the attached readings. If the attribution is inaccurate (for example, treating a critic of a view as one of its defenders, or quoting a passage the philosopher did not write), flag it under **KU2** and quote the relevant passage from the actual reading. Do not use the readings to evaluate prose style, structure, or referencing — those are matters for C1/C2 and the rubric. Use the readings only to verify philosophers' positions, arguments, and quotations.

Return EXACTLY this structure:

## Predicted band
A single letter grade (A+, A, A-, B+, B, B-, C+, C, C-, D, E) based on the rubric, with one sentence explaining why.

## Strengths
2–4 bullets naming what the draft is genuinely doing well, with specific phrases or moves quoted from the draft.

## Per-criterion feedback
A short paragraph for each of: **KU1**, **KU2**, **RA1**, **RA2**, **RA3**, **CA1**, **C1/C2**. For each, name what's there, what's missing, and the single most useful revision. Under **RA2**: if the draft does not present arguments in *standard form* (numbered premises → conclusion), name this explicitly — per the 2025 SACE Assessment Advice it is the single most-impactful AT3 move. Don't gesture at "premises and inference" without naming the form.

## Top three revisions
A numbered list of the three most leverage-positive things to change. Concrete, specific, actionable. **Describe each move and what it would do for the draft. Do NOT write a model sentence the student could paste in.** The student must do the writing themselves; your job is to point at the move, not perform it. If you find yourself starting a revision with a phrase the student could lift verbatim, rewrite it as a description of the move instead.

## What the exemplar does that this draft doesn't yet
2–3 bullets pointing to specific moves in the exemplar the student could borrow. Reference the exemplar by name.

Tone: honest senior reader, never sycophantic. If the draft is weak, say so kindly but plainly. If it's strong, name precisely why so the student can repeat the move.`;

function buildRubricBlock(rubric) {
  const parts = [];
  if (rubric.task_sheet) parts.push(`# TASK SHEET\n\n${rubric.task_sheet}`);
  if (rubric.subject_outline) parts.push(`# ASSESSMENT DESIGN CRITERIA\n\n${rubric.subject_outline}`);
  if (rubric.rubric) parts.push(`# SACE PHILOSOPHY ASSESSMENT ADVICE\n\n${rubric.rubric}`);
  return parts.join("\n\n");
}

// Mirror of chat.js buildDocumentBlocks with a tighter total budget — feedback
// only needs enough text to fact-check attributions (e.g. catch a student
// claiming Williams supports a view he attacks). Doesn't need full corpus
// coverage, so we keep cost bounded.
function buildDocumentBlocks(entry, fileIds, readingsText, bookChapters) {
  const TOKEN_BUDGET = 80_000;
  const PER_BOOK_BUDGET = 35_000;
  const TOKENS_PER_PAGE = 2000;
  const TOKENS_PER_PDF_BYTE = 0.2;
  const TOKENS_PER_TEXT_CHAR = 0.25;

  const docs = [];
  const attached = [];
  const missing = [];
  let used = 0;

  const ordered = [...(entry.readings || [])].sort((a, b) => {
    const ta = (a && a.tier) === "primary" ? 0 : 1;
    const tb = (b && b.tier) === "primary" ? 0 : 1;
    return ta - tb;
  });

  for (const r of ordered) {
    const name = r.filename || "";
    if (!name) continue;
    const titleBase = name.replace(/\.pdf$/i, "");

    const chapters = Array.isArray(bookChapters[name]) ? bookChapters[name] : null;
    if (chapters && chapters.some(c => c && c.file_id)) {
      let bookUsed = 0;
      let attachedAny = false;
      for (const ch of chapters) {
        if (!ch || !ch.file_id) continue;
        const cost = (ch.pages || 0) * TOKENS_PER_PAGE;
        if (bookUsed + cost > PER_BOOK_BUDGET) break;
        if (used + cost > TOKEN_BUDGET) break;
        docs.push({
          type: "document",
          source: { type: "file", file_id: ch.file_id },
          title: `${titleBase} — ${ch.title}`,
        });
        bookUsed += cost; used += cost; attachedAny = true;
      }
      if (attachedAny) {
        attached.push(name);
      } else if (readingsText[name] && readingsText[name].text) {
        const text = readingsText[name].text;
        const cost = text.length * TOKENS_PER_TEXT_CHAR;
        if (used + cost <= TOKEN_BUDGET) {
          docs.push({ type: "document", source: { type: "text", media_type: "text/plain", data: text }, title: titleBase });
          used += cost; attached.push(name);
        } else { missing.push(name); }
      } else { missing.push(name); }
      continue;
    }

    if (fileIds[name]) {
      const cost = (r.pages && r.pages > 0)
        ? r.pages * TOKENS_PER_PAGE
        : (r.size_bytes || 0) * TOKENS_PER_PDF_BYTE;
      if (used + cost > TOKEN_BUDGET) { missing.push(name); continue; }
      docs.push({ type: "document", source: { type: "file", file_id: fileIds[name] }, title: titleBase });
      attached.push(name); used += cost;
      continue;
    }

    if (readingsText[name] && readingsText[name].text) {
      const text = readingsText[name].text;
      const cost = text.length * TOKENS_PER_TEXT_CHAR;
      if (used + cost > TOKEN_BUDGET) { missing.push(name); continue; }
      docs.push({ type: "document", source: { type: "text", media_type: "text/plain", data: text }, title: titleBase });
      attached.push(name); used += cost;
      continue;
    }

    missing.push(name);
  }

  if (docs.length > 0) {
    docs[docs.length - 1].cache_control = { type: "ephemeral" };
  }
  return { docs, attached, missing };
}

function pickExemplar(rubric, domain) {
  const map = rubric.exemplar_for_domain || {};
  const tier = map[domain] || "A-";
  const exemplars = rubric.exemplars || {};
  const text = exemplars[tier];
  if (!text) {
    const fallbackTier = Object.keys(exemplars)[0];
    return { tier: fallbackTier || "unknown", text: exemplars[fallbackTier] || "" };
  }
  return { tier, text };
}

async function callAnthropic({ system, messages, useFilesBeta, signal }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY env var is not set");
  const headers = {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  // Without this header, file-source document blocks return HTTP 400.
  if (useFilesBeta) headers["anthropic-beta"] = "files-api-2025-04-14";
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system, messages }),
    signal,
  });
  const rawBody = await res.text();
  let data = {};
  try { data = JSON.parse(rawBody); } catch { /* leave as {} */ }
  if (!res.ok) {
    const msg = (data && data.error && data.error.message)
      || (rawBody ? rawBody.slice(0, 200) : `HTTP ${res.status}`);
    const err = new Error(`Anthropic API: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function estimateCost(u) {
  if (!u) return 0;
  return ((u.input_tokens || 0) * 1.0
        + (u.output_tokens || 0) * 5.0
        + (u.cache_creation_input_tokens || 0) * 1.25
        + (u.cache_read_input_tokens || 0) * 0.1) / 1_000_000;
}

function streamingResponse(workFn) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let interval = null;
      let timeoutId = null;
      const safeEnqueue = (s) => { try { controller.enqueue(encoder.encode(s)); } catch (_) {} };
      const writeEvent = (name, payload) =>
        safeEnqueue(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);

      safeEnqueue(": waking\n\n");
      interval = setInterval(() => safeEnqueue(": heartbeat\n\n"), HEARTBEAT_MS);

      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Upstream call exceeded ${WORK_TIMEOUT_MS}ms`)),
          WORK_TIMEOUT_MS,
        );
      });

      try {
        const payload = await Promise.race([workFn(), timeoutPromise]);
        writeEvent("result", payload);
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        writeEvent("result", { error: msg });
      } finally {
        if (interval) clearInterval(interval);
        if (timeoutId) clearTimeout(timeoutId);
        try { controller.close(); } catch (_) {}
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export default async (req) => {
  const startedAt = Date.now();
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), {
      status: 405, headers: { "Content-Type": "application/json" },
    });
  }
  let payload;
  try { payload = await req.json(); }
  catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { "Content-Type": "application/json" } }); }

  const { question_id, draft_text } = payload || {};
  const draft = typeof draft_text === "string" ? draft_text.trim() : "";
  if (!question_id || draft.length < MIN_DRAFT_LEN) {
    return new Response(
      JSON.stringify({ error: `question_id and a draft of at least ${MIN_DRAFT_LEN} characters are required` }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  let entry, rubric, fileIds, readingsText, bookChapters;
  try {
    entry = loadReadings()[question_id];
    rubric = loadRubric();
    fileIds = loadFileIds();
    readingsText = loadReadingsText();
    bookChapters = loadBookChapters();
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
  if (!entry) {
    return new Response(JSON.stringify({ error: `Unknown question ${question_id}` }), { status: 404, headers: { "Content-Type": "application/json" } });
  }

  const exemplar = pickExemplar(rubric, entry.domain);
  const rubricBlock = buildRubricBlock(rubric);
  const { docs, attached, missing } = buildDocumentBlocks(entry, fileIds, readingsText, bookChapters);
  const usingFiles = docs.some(d => d.source && d.source.type === "file");

  const system = [
    { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    { type: "text", text: rubricBlock, cache_control: { type: "ephemeral" } },
    {
      type: "text",
      text: `# CALIBRATION EXEMPLAR — graded ${exemplar.tier}\n\n${exemplar.text}`,
      cache_control: { type: "ephemeral" },
    },
  ];

  const userText = `# The student's question
${entry.question_text}

Domain: ${entry.domain}${entry.subdomain ? " · " + entry.subdomain : ""}

# The student's draft

${draft}

Now produce the feedback in the exact structure described in your instructions.`;

  // Documents go in the user message (same pattern as chat.js). Cache_control
  // on the last doc lets the prefix cache hit if the same draft is resubmitted
  // within ~5 min (rare but cheap when it happens).
  const userContent = docs.length > 0
    ? [...docs, { type: "text", text: userText }]
    : userText;

  return streamingResponse(async () => {
    const data = await callAnthropic({
      system,
      messages: [{ role: "user", content: userContent }],
      useFilesBeta: usingFiles,
      signal: req.signal,
    });
    const feedbackMd = (data.content || [])
      .filter(b => b && b.type === "text" && typeof b.text === "string")
      .map(b => b.text)
      .join("\n")
      .trim();
    return {
      feedback_markdown: feedbackMd || "(no feedback returned)",
      exemplar_used: exemplar.tier,
      duration_ms: Date.now() - startedAt,
      estimated_cost_usd: estimateCost(data.usage),
      usage: data.usage || null,
      grounded: { attached, missing },
    };
  });
};
