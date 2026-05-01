// POST /api/chat → Anthropic Haiku, with the cluster corpus cached at the
// system-prompt boundary so a class period of chat sits on a warm cache.
//
// Body: { question_id, message, history: [{role: "user"|"model", text}] }

import Anthropic from "@anthropic-ai/sdk";
import {
  buildChamberMessages,
  errorResponse,
  estimateCostUsd,
  getQuestion,
  jsonResponse,
  loadClusterPack,
  parseJsonBody,
  rateLimitOk,
} from "./_shared/lab.js";

const MODEL = "claude-haiku-4-5";
const MAX_OUTPUT_TOKENS = 800;

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
  const message = (body.message || "").trim();
  const history = Array.isArray(body.history) ? body.history : [];

  if (!qid) return errorResponse(400, "question_id is required");
  if (!message) return errorResponse(400, "message is required");
  if (message.length > 4000) return errorResponse(400, "message too long (max 4000 chars)");

  let question;
  try {
    question = getQuestion(qid);
  } catch (e) {
    return errorResponse(e.statusCode || 400, e.message);
  }

  let clusterCorpus;
  try {
    clusterCorpus = loadClusterPack(question.cluster_pack);
  } catch (e) {
    return errorResponse(e.statusCode || 500, e.message, {
      detail:
        "The Chamber isn't ready yet — the curated corpus for this cluster has not been built. " +
        "If you're a teacher seeing this, it means data/packs/<cluster>.txt needs to be generated " +
        "from the source readings.",
      code: e.code,
    });
  }

  const { system, messages } = buildChamberMessages({
    question,
    history,
    message,
    clusterCorpus,
  });

  const started = Date.now();
  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      messages,
    });
  } catch (e) {
    const status = e.status || 500;
    const detail = e.message || String(e);
    console.error("[chat] Anthropic error", { status, detail });
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

  console.log("[chat]", {
    qid,
    cluster: question.cluster_pack,
    duration_ms: durationMs,
    input_tokens: usage.input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    output_tokens: usage.output_tokens,
    estimated_cost_usd: costUsd,
  });

  return jsonResponse(200, {
    question_id: qid,
    text,
    duration_ms: durationMs,
    estimated_cost_usd: costUsd,
    usage,
  });
}
