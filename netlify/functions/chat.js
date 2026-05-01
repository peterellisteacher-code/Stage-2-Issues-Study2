// netlify/functions/chat.js
// POST /api/chat -> Claude Haiku 4.5 with prompt caching.
// Body: { question_id, history: [{role, text}], message }
// Returns: { text, duration_ms, estimated_cost_usd, usage }
//
// Grounding strategy:
//   - data/readings.json gives the question's curated readings list.
//   - data/file_ids.json maps reading filenames -> Anthropic Files API IDs.
//     Readings ≤32 MB AND ≤100 pages are uploaded once via tools/upload_readings.py
//     and referenced as document blocks (file source).
//   - data/readings_text.json holds extracted plain text (capped at ~80K chars)
//     for big book-length sources that exceed the Files API caps. Inlined as
//     document blocks (text source).
//   - Whatever can't be grounded falls back to title + dialectic only.

const path = require("path");
const fs = require("fs");

const MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 1024;
const MAX_HISTORY_TURNS = 30;

function loadJsonOnce(filename, cacheRef) {
  if (cacheRef.value) return cacheRef.value;
  const candidates = [
    path.join(__dirname, "..", "..", "data", filename),
    path.join(process.cwd(), "data", filename),
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
  throw new Error(`Could not load data/${filename}: ${lastErr && lastErr.message}`);
}
const _readingsCache = { value: null };
const _fileIdsCache = { value: null };
const _readingsTextCache = { value: null };
const loadReadings = () => loadJsonOnce("readings.json", _readingsCache);
const loadFileIds = () => {
  try { return loadJsonOnce("file_ids.json", _fileIdsCache); }
  catch { _fileIdsCache.value = {}; return _fileIdsCache.value; }
};
const loadReadingsText = () => {
  try { return loadJsonOnce("readings_text.json", _readingsTextCache); }
  catch { _readingsTextCache.value = {}; return _readingsTextCache.value; }
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

// Build document content blocks (file sources + inline text excerpts) for the question's readings.
// Caps the total estimated token cost of attached docs so we don't blow Claude's 200K context.
//   PDF estimate:  ~50 tokens/KB (Anthropic charges PDF pages ~1500-2500 tokens each).
//   Text estimate: ~0.25 tokens/char (4 chars/token).
// Primary-tier readings are attached first; anything that would push us over budget
// goes into `missing` so the AI knows the title but is told not to invent quotes.
function buildDocumentBlocks(entry, fileIds, readingsText) {
  const TOKEN_BUDGET = 120_000;        // leaves ~80K for system + history + output
  const TOKENS_PER_PDF_BYTE = 1 / 20;  // ~50 tokens/KB
  const TOKENS_PER_TEXT_CHAR = 0.25;   // 4 chars/token

  const docs = [];
  const attached = [];
  const missing = [];
  let used = 0;

  // Primary readings first, then secondary.
  const ordered = [...(entry.readings || [])].sort((a, b) => {
    const ta = (a && a.tier) === "primary" ? 0 : 1;
    const tb = (b && b.tier) === "primary" ? 0 : 1;
    return ta - tb;
  });

  for (const r of ordered) {
    const name = r.filename || "";
    if (!name) continue;

    if (fileIds[name]) {
      const cost = (r.size_bytes || 0) * TOKENS_PER_PDF_BYTE;
      if (used + cost > TOKEN_BUDGET) {
        missing.push(name);
        continue;
      }
      docs.push({
        type: "document",
        source: { type: "file", file_id: fileIds[name] },
        title: name.replace(/\.pdf$/i, ""),
        context: r.why || undefined,
      });
      attached.push(name);
      used += cost;
    } else if (readingsText[name] && readingsText[name].text) {
      const text = readingsText[name].text;
      const cost = text.length * TOKENS_PER_TEXT_CHAR;
      if (used + cost > TOKEN_BUDGET) {
        missing.push(name);
        continue;
      }
      docs.push({
        type: "document",
        source: { type: "text", media_type: "text/plain", data: text },
        title: name.replace(/\.pdf$/i, ""),
        context: r.why || undefined,
      });
      attached.push(name);
      used += cost;
    } else {
      missing.push(name);
    }
  }

  // Cache breakpoint on the last doc so the whole reading set caches as one prefix.
  if (docs.length > 0) {
    docs[docs.length - 1].cache_control = { type: "ephemeral" };
  }
  return { docs, attached, missing };
}

async function callAnthropic({ system, messages, useFilesBeta }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY env var is not set");
  const headers = {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  if (useFilesBeta) {
    headers["anthropic-beta"] = "files-api-2025-04-14";
  }
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers,
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

  let entry, fileIds, readingsText;
  try {
    entry = loadReadings()[question_id];
    fileIds = loadFileIds();
    readingsText = loadReadingsText();
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
  if (!entry) {
    return { statusCode: 404, body: JSON.stringify({ error: `Unknown question ${question_id}` }) };
  }

  const { docs, attached, missing } = buildDocumentBlocks(entry, fileIds, readingsText);
  const usingFiles = docs.some(d => d.source && d.source.type === "file");

  const system = [
    { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    { type: "text", text: buildQuestionContext(entry, attached, missing), cache_control: { type: "ephemeral" } },
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

  // Attach document blocks to the FIRST user message of the conversation.
  // They stay there across turns (Anthropic cache reads them on every
  // subsequent call within ~5 min for cheap grounding).
  if (docs.length > 0) {
    const firstUserIdx = messages.findIndex(m => m.role === "user");
    if (firstUserIdx >= 0) {
      const firstText = typeof messages[firstUserIdx].content === "string"
        ? messages[firstUserIdx].content
        : "";
      messages[firstUserIdx] = {
        role: "user",
        content: [
          ...docs,
          { type: "text", text: firstText },
        ],
      };
    }
  }

  let data;
  try {
    data = await callAnthropic({ system, messages, useFilesBeta: usingFiles });
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
      grounded: { attached, missing },
    }),
  };
};
