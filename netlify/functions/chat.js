// netlify/functions/chat.js
// POST /api/chat -> Claude Haiku 4.5 with prompt caching.
// Body: { question_id, history: [{role, text}], message }
// Returns: { text, duration_ms, estimated_cost_usd, usage }

const path = require("path");
const fs = require("fs");

const MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 1024;
const MAX_HISTORY_TURNS = 30;

let _readings = null;
function loadReadings() {
  if (_readings) return _readings;
  const candidates = [
    path.join(__dirname, "..", "..", "data", "readings.json"),
    path.join(process.cwd(), "data", "readings.json"),
  ];
  let lastErr;
  for (const p of candidates) {
    try {
      _readings = JSON.parse(fs.readFileSync(p, "utf8"));
      return _readings;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Could not load data/readings.json: ${lastErr && lastErr.message}`);
}

const SYSTEM_PROMPT = `You are the Library — a Socratic interlocutor in the Issues Study Lab, a workspace for SACE Stage 2 Philosophy students working on their Issues Study assessment (AT3). The student must investigate one philosophical question, present multiple positions on it with their reasoning, raise objections, and defend their own answer.

Your role is to push the student's thinking, not to do the work for them. Specifically:

1. Steel-man positions the student dismisses. If the student says "X is obviously wrong", articulate the strongest version of X they're missing.
2. Press for reasons, not just claims. If the student asserts something, ask what would justify it. If they invoke a philosopher, ask what argument that philosopher actually makes.
3. Surface objections. For any position the student is leaning toward, name the most damaging objection in the literature and ask how they would respond.
4. Refuse to write paragraphs. If a student asks "write me a paragraph on X" or "draft my essay's introduction", decline kindly and instead help them think through what should go in such a paragraph.
5. Reference the curated readings by name when relevant. The student has access to the reading list shown to you in the question context. Recommend which to consult first when the dialogue calls for it.
6. Be brief. Keep replies under 200 words unless the student asks for more depth. A good Socratic interlocutor asks a question, not a lecture.
7. At least once early in the dialogue, ask the student why they think this question is genuinely philosophical (rather than empirical or merely semantic) — they are graded on RA1 for recognising the philosophical nature of the issue.

Tone: warm, precise, intellectually serious. You are a senior reader who has thought hard about this question and respects the student enough to push them. You write in clean Australian or British English.`;

function buildQuestionContext(entry) {
  const readings = Array.isArray(entry.readings) ? entry.readings : [];
  const readingsLines = readings.length
    ? readings.map(r => {
        const tier = r.tier === "primary" ? "[primary]" : "[secondary]";
        const why = r.why ? ` — ${r.why}` : "";
        const title = (r.filename || "").replace(/\.pdf$/i, "") || "(untitled)";
        return `- ${tier} ${title}${why}`;
      }).join("\n")
    : "(no curated readings on file)";

  const subdomain = entry.subdomain ? ` · ${entry.subdomain}` : "";
  const dialectic = entry.dialectic || "(no dialectic blurb on file)";

  return `# The student's question
${entry.question_text}

Domain: ${entry.domain}${subdomain}

# The dialectic landscape
${dialectic}

# The curated readings the student has been given
${readingsLines}

You may reference these readings by author or title. You don't have the full text, so don't quote them — but you can describe their broad arguments based on their titles and the dialectic above. Recommend which readings to consult when the dialogue calls for it.`;
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

// Haiku 4.5 pricing (USD per million tokens) — sept 2025.
function estimateCost(u) {
  if (!u) return 0;
  return (
    (u.input_tokens || 0) * 1.0 +
    (u.output_tokens || 0) * 5.0 +
    (u.cache_creation_input_tokens || 0) * 1.25 +
    (u.cache_read_input_tokens || 0) * 0.1
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

  const { question_id, history, message } = payload;
  const userMessage = typeof message === "string" ? message.trim() : "";
  if (!question_id || !userMessage) {
    return { statusCode: 400, body: JSON.stringify({ error: "question_id and non-empty message required" }) };
  }

  let entry;
  try {
    entry = loadReadings()[question_id];
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
  if (!entry) {
    return { statusCode: 404, body: JSON.stringify({ error: `Unknown question ${question_id}` }) };
  }

  const system = [
    { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    { type: "text", text: buildQuestionContext(entry), cache_control: { type: "ephemeral" } },
  ];

  // Map prior turns to API format. Skip any empty-text turns defensively
  // — empty text content blocks are rejected by the API.
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

  let data;
  try {
    data = await callAnthropic({ system, messages });
  } catch (e) {
    return {
      statusCode: e.status && e.status >= 400 && e.status < 500 ? e.status : 502,
      body: JSON.stringify({ error: e.message }),
    };
  }

  const text = (data.content || [])
    .filter(b => b && b.type === "text" && typeof b.text === "string")
    .map(b => b.text)
    .join("\n")
    .trim();

  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: text || "(no reply)",
      duration_ms: Date.now() - startedAt,
      estimated_cost_usd: estimateCost(data.usage),
      usage: data.usage || null,
    }),
  };
};
