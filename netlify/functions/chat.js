// netlify/functions/chat.js
// POST /api/chat -> Claude Haiku 4.5 with prompt caching.
// Body: { question_id, history: [{role, text}], message }
//
// Streaming response (SSE):
//   :heartbeat\n\n           — sent every 5s while waiting on Anthropic, so Akamai's
//                              30s "Inactivity Timeout" never fires (no 504s on
//                              heavy first-turn calls). Clients ignore comment lines.
//   data: {...JSON...}\n\n  — the final result payload (same shape as before).
//
// Three-tier reading source:
//   1. book_chapters.json  — split-and-uploaded chapter PDFs (preferred for big books)
//   2. file_ids.json       — single PDFs uploaded as-is
//   3. readings_text.json  — inline text excerpt fallback

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Don't shadow the auto-injected __filename/__dirname Netlify's bundler adds.
const HERE_DIR = path.dirname(fileURLToPath(import.meta.url));

const MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 1024;
const MAX_HISTORY_TURNS = 30;
const HEARTBEAT_MS = 5000;

function loadJsonOnce(filename, cacheRef) {
  if (cacheRef.value) return cacheRef.value;
  const candidates = [
    path.join(HERE_DIR, "..", "..", "data", filename),
    path.join(process.cwd(), "data", filename),
  ];
  let lastErr;
  for (const p of candidates) {
    try {
      cacheRef.value = JSON.parse(fs.readFileSync(p, "utf8"));
      return cacheRef.value;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`Could not load data/${filename}: ${lastErr && lastErr.message}`);
}
const _readingsCache = { value: null };
const _fileIdsCache = { value: null };
const _readingsTextCache = { value: null };
const _bookChaptersCache = { value: null };
const loadReadings = () => loadJsonOnce("readings.json", _readingsCache);
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

const SYSTEM_PROMPT = `You are the Library — a Socratic interlocutor in the Issues Study Lab, a workspace for SACE Stage 2 Philosophy students working on their Issues Study assessment (AT3). The student must investigate one philosophical question, present multiple positions on it with their reasoning, raise objections, and defend their own answer.

Your role is to push the student's thinking, not to do the work for them. Specifically:

1. Steel-man positions the student dismisses. If the student says "X is obviously wrong", articulate the strongest version of X they're missing.
2. Press for reasons, not just claims. If the student asserts something, ask what would justify it. If they invoke a philosopher, ask what argument that philosopher actually makes.
3. Surface objections. For any position the student is leaning toward, name the most damaging objection in the literature and ask how they would respond.
4. Refuse to write paragraphs. If a student asks "write me a paragraph on X" or "draft my essay's introduction", decline kindly and instead help them think through what should go in such a paragraph.
5. Quote and reference the readings precisely. You have been given the curated readings as document attachments — use them. When citing a passage, quote it briefly and name the source. When a student misrepresents a position, point them to the relevant reading and what it actually says.
6. Be brief. Keep replies under 200 words unless the student asks for more depth. A good Socratic interlocutor asks a question, not a lecture.
7. At least once early in the dialogue, ask the student why they think this question is genuinely philosophical (rather than empirical or merely semantic) — they are graded on RA1 for recognising the philosophical nature of the issue.

Tone: warm, precise, intellectually serious. You are a senior reader who has thought hard about this question and respects the student enough to push them. You write in clean Australian or British English.`;

function buildQuestionContext(entry, attachedNames, missingNames) {
  const subdomain = entry.subdomain ? ` · ${entry.subdomain}` : "";
  const dialectic = entry.dialectic || "(no dialectic blurb on file)";
  let attachedLines = "";
  if (attachedNames.length) {
    attachedLines = "\n\n# Readings attached as documents (you can quote these directly)\n" +
      attachedNames.map(n => `- ${n.replace(/\.pdf$/i, "")}`).join("\n");
  }
  let missingLines = "";
  if (missingNames.length) {
    missingLines = "\n\n# Readings on the student's list but NOT attached (refer to them by title only; do not invent quotes)\n" +
      missingNames.map(n => `- ${n.replace(/\.pdf$/i, "")}`).join("\n");
  }
  return `# The student's question
${entry.question_text}

Domain: ${entry.domain}${subdomain}

# The dialectic landscape
${dialectic}${attachedLines}${missingLines}`;
}

function buildDocumentBlocks(entry, fileIds, readingsText, bookChapters) {
  const TOKEN_BUDGET = 160_000;
  const PER_BOOK_BUDGET = 70_000;
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
          context: r.why || undefined,
        });
        bookUsed += cost; used += cost; attachedAny = true;
      }
      if (attachedAny) {
        attached.push(name);
      } else if (readingsText[name] && readingsText[name].text) {
        const text = readingsText[name].text;
        const cost = text.length * TOKENS_PER_TEXT_CHAR;
        if (used + cost <= TOKEN_BUDGET) {
          docs.push({ type: "document", source: { type: "text", media_type: "text/plain", data: text }, title: titleBase, context: r.why || undefined });
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
      docs.push({ type: "document", source: { type: "file", file_id: fileIds[name] }, title: titleBase, context: r.why || undefined });
      attached.push(name); used += cost;
      continue;
    }

    if (readingsText[name] && readingsText[name].text) {
      const text = readingsText[name].text;
      const cost = text.length * TOKENS_PER_TEXT_CHAR;
      if (used + cost > TOKEN_BUDGET) { missing.push(name); continue; }
      docs.push({ type: "document", source: { type: "text", media_type: "text/plain", data: text }, title: titleBase, context: r.why || undefined });
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

function estimateCost(u) {
  if (!u) return 0;
  return ((u.input_tokens || 0) * 1.0
        + (u.output_tokens || 0) * 5.0
        + (u.cache_creation_input_tokens || 0) * 1.25
        + (u.cache_read_input_tokens || 0) * 0.1) / 1_000_000;
}

// Build a streaming Response: one heartbeat (": ...") every HEARTBEAT_MS while
// the upstream Anthropic call is in flight, then a single SSE `result` event
// with the JSON payload, then close. Heartbeats keep Akamai/Netlify from
// timing out the connection when first-turn cache-creation takes 25-40s.
//
// `clientSignal` (req.signal) is wired into the upstream fetch so a closed
// browser tab cancels the Anthropic call instead of running it to completion
// on our dime. A hard `WORK_TIMEOUT_MS` cap is applied so a hung upstream
// can't burn the function's wall-clock limit silently.
const WORK_TIMEOUT_MS = 50_000;

function streamingResponse(workFn, clientSignal) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let interval = null;
      const safeEnqueue = (s) => { try { controller.enqueue(encoder.encode(s)); } catch (_) {} };
      const writeEvent = (name, payload) =>
        safeEnqueue(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);

      // Initial heartbeat forces the response headers + first byte out
      // immediately so the proxy sees activity before the upstream call starts.
      safeEnqueue(": waking\n\n");
      interval = setInterval(() => safeEnqueue(": heartbeat\n\n"), HEARTBEAT_MS);

      // Hard timeout cap on the unit of work itself.
      let timeoutId;
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
    cancel() {
      // Browser disconnected — nothing else to do; the AbortController on
      // `clientSignal` (passed into `fetch` by the worker) will tear down
      // the upstream Anthropic request.
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

async function callAnthropic({ system, messages, useFilesBeta, signal }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY env var is not set");
  const headers = {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
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

  const { question_id, history, message } = payload || {};
  const userMessage = typeof message === "string" ? message.trim() : "";
  if (!question_id || !userMessage) {
    return new Response(JSON.stringify({ error: "question_id and non-empty message required" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  let entry, fileIds, readingsText, bookChapters;
  try {
    entry = loadReadings()[question_id];
    fileIds = loadFileIds();
    readingsText = loadReadingsText();
    bookChapters = loadBookChapters();
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
  if (!entry) {
    return new Response(JSON.stringify({ error: `Unknown question ${question_id}` }), { status: 404, headers: { "Content-Type": "application/json" } });
  }

  const { docs, attached, missing } = buildDocumentBlocks(entry, fileIds, readingsText, bookChapters);
  const usingFiles = docs.some(d => d.source && d.source.type === "file");
  const system = [
    { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    { type: "text", text: buildQuestionContext(entry, attached, missing), cache_control: { type: "ephemeral" } },
  ];

  const histList = Array.isArray(history) ? history.slice(-MAX_HISTORY_TURNS) : [];
  const messages = [];
  for (const turn of histList) {
    const role =
      turn && turn.role === "model" ? "assistant" :
      turn && turn.role === "assistant" ? "assistant" :
      turn && turn.role === "user" ? "user" : null;
    const text = turn && typeof turn.text === "string" ? turn.text.trim() : "";
    if (!role || !text) continue;
    messages.push({ role, content: text });
  }
  messages.push({ role: "user", content: userMessage });

  if (docs.length > 0) {
    const firstUserIdx = messages.findIndex(m => m.role === "user");
    if (firstUserIdx >= 0) {
      const firstText = typeof messages[firstUserIdx].content === "string" ? messages[firstUserIdx].content : "";
      messages[firstUserIdx] = { role: "user", content: [...docs, { type: "text", text: firstText }] };
    }
  }

  return streamingResponse(async () => {
    const data = await callAnthropic({ system, messages, useFilesBeta: usingFiles, signal: req.signal });
    const text = (data.content || [])
      .filter(b => b && b.type === "text" && typeof b.text === "string")
      .map(b => b.text)
      .join("\n")
      .trim();
    return {
      text: text || "(no reply)",
      duration_ms: Date.now() - startedAt,
      estimated_cost_usd: estimateCost(data.usage),
      usage: data.usage || null,
      grounded: { attached, missing },
    };
  });
};
