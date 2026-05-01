// POST /api/feedback → Haiku critique against rubric + closest exemplar.
// Single-shot, no caching — the prefix here is too short and too varied to
// benefit from prompt caching.

import Anthropic from "@anthropic-ai/sdk";
import {
  buildFeedbackPrompt,
  errorResponse,
  estimateCostUsd,
  getQuestion,
  jsonResponse,
  parseJsonBody,
  rateLimitOk,
} from "./_shared/lab.js";

const MODEL = "claude-haiku-4-5";
const MAX_OUTPUT_TOKENS = 1500;
const MIN_DRAFT_CHARS = 200;
const MAX_DRAFT_CHARS = 14_000; // ~2000 words with slack

const client = new Anthropic();

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return errorResponse(405, "method not allowed");
  }

  const rl = rateLimitOk(event);
  if (!rl.ok) {
    return errorResponse(429, `rate limit exceeded (${rl.count}/${rl.max} per hour)`);
  }

  let body;
  try {
    body = parseJsonBody(event);
  } catch (e) {
    return errorResponse(e.statusCode || 400, e.message);
  }

  const qid = body.question_id;
  const draft = (body.draft_text || "").trim();
  if (!qid) return errorResponse(400, "question_id is required");
  if (!draft) return errorResponse(400, "draft_text is required");
  if (draft.length < MIN_DRAFT_CHARS) {
    return errorResponse(400, `draft is too short for meaningful feedback (min ${MIN_DRAFT_CHARS} chars)`);
  }
  if (draft.length > MAX_DRAFT_CHARS) {
    return errorResponse(400, `draft is too long (max ${MAX_DRAFT_CHARS} chars)`);
  }

  let question;
  try {
    question = getQuestion(qid);
  } catch (e) {
    return errorResponse(e.statusCode || 400, e.message);
  }

  const { prompt, exemplarGrade } = buildFeedbackPrompt({ question, draft });

  const started = Date.now();
  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [{ role: "user", content: prompt }],
    });
  } catch (e) {
    const status = e.status || 500;
    const detail = e.message || String(e);
    console.error("[feedback] Anthropic error", { status, detail });
    return errorResponse(status, "model call failed", { detail });
  }

  const text =
    response.content
      ?.filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("") || "";

  const usage = response.usage || {};
  const durationMs = Date.now() - started;
  const costUsd = estimateCostUsd(usage);

  console.log("[feedback]", {
    qid,
    exemplar_used: exemplarGrade,
    duration_ms: durationMs,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    estimated_cost_usd: costUsd,
  });

  return jsonResponse(200, {
    question_id: qid,
    exemplar_used: exemplarGrade,
    feedback_markdown: text,
    duration_ms: durationMs,
    estimated_cost_usd: costUsd,
    usage,
  });
}
