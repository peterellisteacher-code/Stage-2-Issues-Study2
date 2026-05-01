// netlify/functions/feedback.js
// POST /api/feedback -> Claude Haiku 4.5 with prompt caching.
// Body: { question_id, draft_text }
// Returns: { feedback_markdown, exemplar_used, duration_ms, estimated_cost_usd, usage }

const path = require("path");
const fs = require("fs");

// Sonnet 4.6 for feedback: criterion-referenced grading rewards the
// stronger reasoning model. Chat (chamber) stays on Haiku for cost.
const MODEL = "claude-sonnet-4-6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 2048;
const MIN_DRAFT_LEN = 200;

let _readings = null;
let _rubric = null;
function loadJson(name, cacheRef) {
  if (cacheRef.value) return cacheRef.value;
  const candidates = [
    path.join(__dirname, "..", "..", "data", name),
    path.join(process.cwd(), "data", name),
  ];
  let lastErr;
  for (const p of candidates) {
    try {
      cacheRef.value = JSON.parse(fs.readFileSync(p, "utf8"));
      return cacheRef.value;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Could not load data/${name}: ${lastErr && lastErr.message}`);
}
const readingsCache = { value: null };
const rubricCache = { value: null };
const loadReadings = () => loadJson("readings.json", readingsCache);
const loadRubric = () => loadJson("rubric.json", rubricCache);

const SYSTEM_PROMPT = `You are a SACE Stage 2 Philosophy moderator giving formative feedback on a student's Issues Study (AT3) draft. The student must investigate one philosophical issue, present multiple positions with their reasoning, raise objections, and defend their own answer.

You will be given:
1. The full SACE rubric and assessment design criteria.
2. A grade-banded exemplar at a specific level, for calibration.
3. The student's question and current draft.

Your job is to return structured, criterion-referenced feedback in markdown. Be honest, concrete, and constructive. The student needs to know what's working, what's missing, and what to do next.

Return EXACTLY this structure:

## Predicted band
A single letter grade (A+, A, A-, B+, B, B-, C+, C, C-, D, E) based on the rubric, with one sentence explaining why.

## Strengths
2–4 bullets naming what the draft is genuinely doing well, with specific phrases or moves quoted from the draft.

## Per-criterion feedback
A short paragraph for each of: **KU1**, **KU2**, **RA1**, **RA2**, **RA3**, **CA1**, **C1/C2**. For each, name what's there, what's missing, and the single most useful revision.

## Top three revisions
A numbered list of the three most leverage-positive things to change. Concrete, specific, actionable.

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

function pickExemplar(rubric, domain) {
  const map = rubric.exemplar_for_domain || {};
  const tier = map[domain] || "A-";
  const exemplars = rubric.exemplars || {};
  const text = exemplars[tier];
  if (!text) {
    // Fall back to any available exemplar
    const fallbackTier = Object.keys(exemplars)[0];
    return { tier: fallbackTier || "unknown", text: exemplars[fallbackTier] || "" };
  }
  return { tier, text };
}

async function callAnthropic({ system, messages }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY env var is not set");
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `HTTP ${res.status}`;
    const err = new Error(`Anthropic API: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Sonnet 4.6 pricing (USD per million tokens) — sept 2025.
function estimateCost(u) {
  if (!u) return 0;
  return (
    (u.input_tokens || 0) * 3.0 +
    (u.output_tokens || 0) * 15.0 +
    (u.cache_creation_input_tokens || 0) * 3.75 +
    (u.cache_read_input_tokens || 0) * 0.3
  ) / 1_000_000;
}

exports.handler = async (event) => {
  const startedAt = Date.now();
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "POST only" }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { question_id, draft_text } = payload;
  const draft = typeof draft_text === "string" ? draft_text.trim() : "";
  if (!question_id || draft.length < MIN_DRAFT_LEN) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: `question_id and a draft of at least ${MIN_DRAFT_LEN} characters are required` }),
    };
  }

  let entry, rubric;
  try {
    entry = loadReadings()[question_id];
    rubric = loadRubric();
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
  if (!entry) {
    return { statusCode: 404, body: JSON.stringify({ error: `Unknown question ${question_id}` }) };
  }

  const exemplar = pickExemplar(rubric, entry.domain);
  const rubricBlock = buildRubricBlock(rubric);

  const system = [
    { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    { type: "text", text: rubricBlock, cache_control: { type: "ephemeral" } },
    {
      type: "text",
      text: `# CALIBRATION EXEMPLAR — graded ${exemplar.tier}\n\n${exemplar.text}`,
      cache_control: { type: "ephemeral" },
    },
  ];

  const userContent = `# The student's question
${entry.question_text}

Domain: ${entry.domain}${entry.subdomain ? " · " + entry.subdomain : ""}

# The student's draft

${draft}

Now produce the feedback in the exact structure described in your instructions.`;

  let data;
  try {
    data = await callAnthropic({
      system,
      messages: [{ role: "user", content: userContent }],
    });
  } catch (e) {
    return {
      statusCode: e.status && e.status >= 400 && e.status < 500 ? e.status : 502,
      body: JSON.stringify({ error: e.message }),
    };
  }

  const feedbackMd = (data.content || [])
    .filter(b => b && b.type === "text" && typeof b.text === "string")
    .map(b => b.text)
    .join("\n")
    .trim();

  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      feedback_markdown: feedbackMd || "(no feedback returned)",
      exemplar_used: exemplar.tier,
      duration_ms: Date.now() - startedAt,
      estimated_cost_usd: estimateCost(data.usage),
      usage: data.usage || null,
    }),
  };
};
