// Shared helpers for the Issues Study Lab Netlify Functions.
// - Loads question metadata + per-cluster corpus packs from data/.
// - Builds the Chamber and Feedback prompts.
// - In-memory per-IP rate limit (best effort; Netlify Functions are short-lived).

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve the project root reliably whether the function is bundled or unbundled.
function resolveRoot() {
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, "data", "questions.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, "..", "..", "..");
}

const ROOT = resolveRoot();
const DATA = path.join(ROOT, "data");
const PACKS = path.join(DATA, "packs");

// ── Static data, loaded once per cold start ─────────────────────────────
let _questionsByQid = null;
let _readingsByQid = null;
let _rubricBundle = null;

function loadQuestions() {
  if (_questionsByQid) return _questionsByQid;
  const list = JSON.parse(fs.readFileSync(path.join(DATA, "questions.json"), "utf8"));
  _questionsByQid = Object.fromEntries(list.map((q) => [q.id, q]));
  return _questionsByQid;
}

function loadReadings() {
  if (_readingsByQid) return _readingsByQid;
  _readingsByQid = JSON.parse(fs.readFileSync(path.join(DATA, "readings.json"), "utf8"));
  return _readingsByQid;
}

function loadRubric() {
  if (_rubricBundle) return _rubricBundle;
  _rubricBundle = JSON.parse(fs.readFileSync(path.join(DATA, "rubric.json"), "utf8"));
  return _rubricBundle;
}

const _packCache = new Map();

export function loadClusterPack(clusterPack) {
  if (!clusterPack) throw new Error("missing cluster_pack on question");
  if (_packCache.has(clusterPack)) return _packCache.get(clusterPack);
  const file = path.join(PACKS, `${clusterPack}.txt`);
  if (!fs.existsSync(file)) {
    const err = new Error(
      `corpus pack not built: data/packs/${clusterPack}.txt is missing. ` +
        `Run build_packs.py once the source readings have been pushed.`,
    );
    err.statusCode = 503;
    err.code = "pack_missing";
    throw err;
  }
  const text = fs.readFileSync(file, "utf8");
  _packCache.set(clusterPack, text);
  return text;
}

export function getQuestion(qid) {
  const q = loadQuestions()[qid];
  if (!q) {
    const err = new Error(`unknown question_id: ${qid}`);
    err.statusCode = 400;
    throw err;
  }
  return q;
}

export function getReadingsForQid(qid) {
  return loadReadings()[qid] || null;
}

export function getRubric() {
  return loadRubric();
}

// ── Prompt construction ─────────────────────────────────────────────────

const CHAMBER_SYSTEM_INSTRUCTIONS = `You are the Chamber — a Socratic philosophical interlocutor for a senior secondary student preparing their SACE Stage 2 Philosophy Issues Study (Assessment Type 3 — Investigation, AT3).

Your role:
- Push back on weak reasoning. Steel-man strong arguments. Surface the most damaging objection to whatever the student is leaning toward.
- Ground every claim in the curated readings provided below. Cite philosophers and texts by name. When you quote, quote exactly and brief, with the source filename in parentheses.
- Ask probing questions before offering conclusions. Treat the student as a thinker, not a recipient.
- Identify the deeper philosophical move underneath what the student is saying — what assumption is doing the work, what alternative is being foreclosed.
- Use language a Year 12 student can follow without being patronising. Plain English. Short paragraphs.

Hard rules:
- DO NOT write the student's essay or any paragraph of it for them. If they ask you to, refuse and ask them what they would write — then critique it.
- DO NOT moralise about effort or academic integrity. Just engage.
- DO NOT invent quotes or sources. If a reading doesn't address something, say so and suggest an angle they could research themselves.
- Keep replies under ~400 words unless the student explicitly asks for length. The student's word count is theirs to spend, not yours.

The curated readings for this question's cluster follow. Treat them as your only library.`;

export function buildChamberMessages({ question, history, message, clusterCorpus }) {
  const trimmedHistory = (history || []).slice(-12); // last 6 user/model pairs

  const messages = [];
  messages.push({
    role: "user",
    content: `My SACE Issues Study question is:\n\n> ${question.text}\n\n(Domain: ${question.domain}${
      question.subdomain ? ` — ${question.subdomain}` : ""
    }.) Begin when ready; I'll lead with my first thought below.`,
  });
  messages.push({
    role: "assistant",
    content: "Understood. What's on your mind?",
  });
  for (const turn of trimmedHistory) {
    const role = turn.role === "model" ? "assistant" : "user";
    const text = turn.text || "";
    if (!text) continue;
    messages.push({ role, content: text });
  }
  messages.push({ role: "user", content: message });

  const system = [
    { type: "text", text: CHAMBER_SYSTEM_INSTRUCTIONS },
    {
      type: "text",
      text: `--- CURATED READINGS (cluster: ${question.cluster_display_name || question.cluster_pack}) ---\n\n${clusterCorpus}`,
      cache_control: { type: "ephemeral" },
    },
  ];

  return { system, messages };
}

const FEEDBACK_TEMPLATE = ({
  question_text,
  task_sheet,
  rubric,
  exemplar_grade,
  exemplar_text,
  draft_text,
}) => `You are a SACE Stage 2 Philosophy moderator giving criterion-referenced feedback on a student's draft Issues Study response. The Issues Study is graded against the standard SACE Stage 2 Philosophy rubric (KU1-2, RA1-3, CA1, C1-2).

THE STUDENT'S QUESTION:
${question_text}

THE TASK SHEET (what students must address):
${task_sheet}

THE SACE ASSESSMENT ADVICE (rubric guidance):
${rubric}

REFERENCE EXEMPLAR — graded ${exemplar_grade} by SACE moderators:
"""
${exemplar_text}
"""

THE STUDENT'S DRAFT:
"""
${draft_text}
"""

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

Be specific. Reference passages from the draft. Predict the band SACE would actually award — not the band the student would prefer.`;

export function buildFeedbackPrompt({ question, draft }) {
  const rubric = getRubric();
  const exemplarGrade = rubric.exemplar_for_domain[question.domain] || "A-";
  const exemplarText = rubric.exemplars[exemplarGrade] || rubric.exemplars["A-"];
  return {
    prompt: FEEDBACK_TEMPLATE({
      question_text: question.text,
      task_sheet: rubric.task_sheet,
      rubric: rubric.rubric,
      exemplar_grade: exemplarGrade,
      exemplar_text: exemplarText,
      draft_text: draft,
    }),
    exemplarGrade,
  };
}

// ── Pricing + cost estimate (Haiku 4.5) ─────────────────────────────────
// Source: docs/SKILL — $1/MTok input, $5/MTok output, cache write ~1.25x input,
// cache read ~0.1x input.
const HAIKU_INPUT_PER_MTOK = 1.0;
const HAIKU_OUTPUT_PER_MTOK = 5.0;
const HAIKU_CACHE_WRITE_PER_MTOK = 1.25;
const HAIKU_CACHE_READ_PER_MTOK = 0.10;

export function estimateCostUsd(usage) {
  if (!usage) return 0;
  const ic = usage.input_tokens || 0;
  const cwc = usage.cache_creation_input_tokens || 0;
  const crc = usage.cache_read_input_tokens || 0;
  const oc = usage.output_tokens || 0;
  const cost =
    (ic * HAIKU_INPUT_PER_MTOK) / 1_000_000 +
    (cwc * HAIKU_CACHE_WRITE_PER_MTOK) / 1_000_000 +
    (crc * HAIKU_CACHE_READ_PER_MTOK) / 1_000_000 +
    (oc * HAIKU_OUTPUT_PER_MTOK) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

// ── Per-IP rate limiting (best effort) ──────────────────────────────────
// Functions are short-lived so this is a soft-cap, not a hard one. Effective
// when one warm container handles a burst from a single client; concurrent
// invocations on different containers each track their own counter.

const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_MAX = 30;                    // 30 requests per IP per hour per container
const _ipBuckets = new Map();

function clientIp(event) {
  const h = event.headers || {};
  const fwd = h["x-forwarded-for"] || h["X-Forwarded-For"] || "";
  if (fwd) return fwd.split(",")[0].trim();
  return h["client-ip"] || h["X-NF-Client-Connection-IP"] || "unknown";
}

export function rateLimitOk(event) {
  const ip = clientIp(event);
  const now = Date.now();
  const bucket = _ipBuckets.get(ip) || { count: 0, windowStart: now };
  if (now - bucket.windowStart > RATE_WINDOW_MS) {
    bucket.count = 0;
    bucket.windowStart = now;
  }
  bucket.count += 1;
  _ipBuckets.set(ip, bucket);
  return { ok: bucket.count <= RATE_MAX, ip, count: bucket.count, max: RATE_MAX };
}

// ── HTTP helpers ────────────────────────────────────────────────────────

export function jsonResponse(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

export function errorResponse(statusCode, message, extra = {}) {
  return jsonResponse(statusCode, { error: message, ...extra });
}

export function parseJsonBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    const err = new Error("invalid JSON body");
    err.statusCode = 400;
    throw err;
  }
}
