// Issues Study Lab — wizard SPA, vanilla JS.
// Data is served as static JSON; chat + feedback go through Netlify
// Functions (/api/chat, /api/feedback) which call Claude Haiku 4.5.

const PAGES = ["welcome", "task", "bank", "readings", "chamber", "drafting"];
const DEFAULT_PAGE = "welcome";
const NEEDS_QUESTION = new Set(["readings", "chamber", "drafting"]);

const DOMAIN_LABELS = {
  ethics: "Ethics",
  metaphysics: "Metaphysics",
  epistemology: "Epistemology",
  political: "Political philosophy",
  religion: "Philosophy of religion",
  mind_tech: "Philosophy of mind & technology",
  aesthetics: "Aesthetics",
  hybrid: "Hybrid / other",
};

const state = {
  questions: [],          // [{id, domain, text, ...}]
  readingsByQid: {},      // { Q001: {dialectic, readings, ...}, ... }
  questionId: null,
  question: null,
  history: [],            // [{role: "user"|"model", text}]
  feedbackMd: "",
  exemplarUsed: null,
};

const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"),
  pages: {
    welcome: $("page-welcome"),
    task: $("page-task"),
    bank: $("page-bank"),
    readings: $("page-readings"),
    chamber: $("page-chamber"),
    drafting: $("page-drafting"),
  },
  navLinks: document.querySelectorAll(".topnav a"),
  studentName: $("student-name"),
  beginBtn: $("begin-btn"),

  // Bank
  domainFilter: $("domain-filter"),
  bankCount: $("bank-count"),
  questionList: $("question-list"),

  // Readings
  selectedQReadings: $("selected-q-readings"),
  dialecticBlock: $("dialectic-block"),
  readingsPrimary: $("readings-primary"),
  readingsSecondary: $("readings-secondary"),

  // Chamber (live chat)
  selectedQChamber: $("selected-q-chamber"),
  chatWindow: $("chat-window"),
  chatEmpty: $("chat-empty"),
  chatForm: $("chat-form"),
  chatInput: $("chat-input"),
  chatSend: $("chat-send"),
  chatMeta: $("chat-meta"),

  // Chamber (handoff fallback)
  chamberCopy: $("chamber-copy"),
  chamberPrompt: $("chamber-prompt"),
  chamberPromptMeta: $("chamber-prompt-meta"),

  // Drafting
  selectedQDrafting: $("selected-q-drafting"),
  draftInput: $("draft-input"),
  draftCounter: $("draft-counter"),
  feedbackBtn: $("feedback-btn"),
  exportBtn: $("export-pdf-btn"),
  feedbackOutput: $("feedback-output"),
  autosave: $("autosave-indicator"),

  // Feedback handoff
  feedbackCopy: $("feedback-copy"),
  feedbackPrompt: $("feedback-prompt"),
  feedbackPromptMeta: $("feedback-prompt-meta"),

  printView: $("print-view"),
};

// ── Persistence ────────────────────────────────────────────────
const NAME_KEY = "lab_student_name";
const QID_KEY = "lab_current_qid";
const stateKey = (qid) => `lab_state_${qid}`;

function getStudentName() { return (els.studentName.value || "").trim(); }
function saveStudentName() {
  const n = getStudentName();
  if (n) localStorage.setItem(NAME_KEY, n); else localStorage.removeItem(NAME_KEY);
  refreshControls();
}
function loadStudentName() { els.studentName.value = localStorage.getItem(NAME_KEY) || ""; }

let saveDebounce = null;
function persistCurrent({ flush = false } = {}) {
  if (!state.questionId) return;
  const payload = {
    history: state.history,
    draft: els.draftInput.value || "",
    feedback: state.feedbackMd || "",
    exemplar: state.exemplarUsed || null,
    savedAt: new Date().toISOString(),
  };
  const write = () => {
    try {
      localStorage.setItem(stateKey(state.questionId), JSON.stringify(payload));
      els.autosave.textContent = `saved · ${new Date().toLocaleTimeString()}`;
      els.autosave.classList.add("saved");
    } catch (e) {
      els.autosave.textContent = `save failed: ${e.message}`;
      els.autosave.classList.remove("saved");
    }
  };
  if (flush) { if (saveDebounce) { clearTimeout(saveDebounce); saveDebounce = null; } write(); }
  else { if (saveDebounce) clearTimeout(saveDebounce); saveDebounce = setTimeout(write, 600); }
}
function loadSavedStateFor(qid) {
  try { const raw = localStorage.getItem(stateKey(qid)); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

// ── Markdown ───────────────────────────────────────────────────
function escapeHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function renderInline(s) {
  s = escapeHtml(s);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  return s;
}
function renderMarkdown(md) {
  if (!md) return "";
  const lines = md.split(/\r?\n/);
  const out = []; let buf = []; let listType = null; let listItems = [];
  const flushPara = () => { if (buf.length) { out.push("<p>" + renderInline(buf.join(" ").trim()) + "</p>"); buf = []; } };
  const flushList = () => { if (listType) { out.push(`<${listType}>` + listItems.map(i => `<li>${renderInline(i)}</li>`).join("") + `</${listType}>`); listType = null; listItems = []; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { flushPara(); flushList(); continue; }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flushPara(); flushList(); const lvl = Math.min(6, m[1].length + 1); out.push(`<h${lvl}>${renderInline(m[2])}</h${lvl}>`); continue; }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { flushPara(); if (listType !== "ul") { flushList(); listType = "ul"; } listItems.push(m[1]); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flushPara(); if (listType !== "ol") { flushList(); listType = "ol"; } listItems.push(m[1]); continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); flushList(); out.push(`<blockquote>${renderInline(m[1])}</blockquote>`); continue; }
    buf.push(line);
  }
  flushPara(); flushList();
  return out.join("\n");
}

// ── API helpers ────────────────────────────────────────────────
// Handles both:
//   - Plain JSON responses (static /data/*.json, error responses)
//   - SSE streaming responses from /api/* (heartbeat comments + a final
//     `event: result\ndata: <json>` event). The SSE stream defeats Akamai's
//     30s idle-timeout while we wait on Anthropic for a heavy first turn.
async function fetchJson(url, body) {
  const opts = body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : { method: "GET" };
  const res = await fetch(url, opts);

  const ctype = (res.headers.get("Content-Type") || "").toLowerCase();
  if (!ctype.startsWith("text/event-stream")) {
    // Plain JSON path (static files or short-circuit error)
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // SSE path: read until we see `event: result\ndata: <json>\n\n`.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      // Ignore comment lines (heartbeats) and unrelated events
      if (!block || block.startsWith(":")) continue;
      const lines = block.split("\n");
      let eventName = "message";
      let dataLine = null;
      for (const line of lines) {
        if (line.startsWith("event: ")) eventName = line.slice(7).trim();
        else if (line.startsWith("data: ")) dataLine = line.slice(6);
      }
      if (eventName === "result" && dataLine != null) {
        let payload;
        try { payload = JSON.parse(dataLine); }
        catch (e) { throw new Error(`Bad SSE payload: ${e.message}`); }
        if (payload && payload.error) throw new Error(payload.error);
        return payload;
      }
    }
  }
  throw new Error("Stream closed without a result event");
}

function setStatus(text, cls = "") { els.status.textContent = text; els.status.className = "status " + cls; }

// ── Router ─────────────────────────────────────────────────────
function navigate(page, push = true) {
  if (!PAGES.includes(page)) page = DEFAULT_PAGE;
  if (NEEDS_QUESTION.has(page) && !state.questionId) {
    page = "bank";
    setStatus("pick a question first", "error");
  } else if (page !== "welcome" && !getStudentName()) {
    page = "welcome";
    setStatus("enter your name to begin", "error");
  } else {
    setStatus("");
  }

  for (const [name, el] of Object.entries(els.pages)) {
    if (el) el.classList.toggle("active", name === page);
  }
  els.navLinks.forEach(a => {
    a.classList.toggle("active", a.dataset.page === page);
    a.classList.toggle("locked", NEEDS_QUESTION.has(a.dataset.page) && !state.questionId);
  });

  if (push && location.hash !== "#" + page) {
    history.replaceState(null, "", "#" + page);
  }
  window.scrollTo(0, 0);

  if (page === "readings" && state.questionId) renderReadingsForCurrent();
  if (page === "chamber" && state.questionId) updateChamberPrompt();
}

function refreshControls() {
  const hasName = getStudentName().length > 0;
  const hasQ = !!state.questionId;
  if (els.beginBtn) els.beginBtn.disabled = !hasName;

  if (els.chatInput) els.chatInput.disabled = !hasQ;
  if (els.chatSend) els.chatSend.disabled = !hasQ;
  if (els.chatInput) {
    els.chatInput.placeholder = hasQ
      ? "Say what you're thinking. Cmd/Ctrl+Enter to send."
      : "Pick a question first.";
  }

  if (els.draftInput) els.draftInput.disabled = !hasQ;
  const draftLen = els.draftInput ? els.draftInput.value.length : 0;
  if (els.feedbackBtn) els.feedbackBtn.disabled = !hasQ || draftLen < 200;
  if (els.feedbackCopy) els.feedbackCopy.disabled = !hasQ || draftLen < 200;
  if (els.exportBtn) els.exportBtn.disabled = !hasQ || !hasName;
  if (els.chamberCopy) els.chamberCopy.disabled = !hasQ;

  els.navLinks.forEach(a => {
    a.classList.toggle("locked", NEEDS_QUESTION.has(a.dataset.page) && !state.questionId);
  });
}

// ── Static data loaders ────────────────────────────────────────
async function loadStaticData() {
  setStatus("loading…");
  try {
    const [qs, rd] = await Promise.all([
      fetchJson("/data/questions.json"),
      fetchJson("/data/readings.json"),
    ]);
    state.questions = Array.isArray(qs) ? qs : (qs.questions || []);
    state.readingsByQid = rd || {};
    setStatus(`${state.questions.length} questions loaded`, "ready");
    renderBank();
  } catch (e) {
    setStatus(`failed to load lab data: ${e.message}`, "error");
  }
}

// ── Bank ───────────────────────────────────────────────────────
function renderBank() {
  if (!els.questionList) return;
  const dom = els.domainFilter.value;
  const filtered = state.questions.filter(q => !dom || q.domain === dom);
  els.bankCount.textContent = `${filtered.length} ${filtered.length === 1 ? "question" : "questions"}`;
  els.questionList.innerHTML = "";
  for (const q of filtered) {
    const li = document.createElement("li");
    li.dataset.qid = q.id;

    const text = document.createElement("span");
    text.className = "q-text";
    text.textContent = q.text;

    const dEl = document.createElement("span");
    dEl.className = "q-domain";
    dEl.textContent = DOMAIN_LABELS[q.domain] || q.domain;

    const cluster = document.createElement("span");
    cluster.className = "q-cluster";
    cluster.textContent = q.cluster_display_name ? `cluster: ${q.cluster_display_name}` : "";

    const actions = document.createElement("span");
    actions.className = "q-actions";
    const pick = document.createElement("button");
    pick.className = "primary-btn";
    pick.textContent = "Pick this question →";
    pick.addEventListener("click", (e) => { e.stopPropagation(); pickQuestion(q.id); });
    actions.appendChild(pick);

    li.appendChild(text);
    li.appendChild(dEl);
    if (cluster.textContent) li.appendChild(cluster);
    li.appendChild(actions);
    li.addEventListener("click", () => {
      els.questionList.querySelectorAll("li").forEach(x => x.classList.toggle("expanded", x === li));
    });
    if (state.questionId === q.id) li.classList.add("expanded");
    els.questionList.appendChild(li);
  }
}

function pickQuestion(qid) {
  state.questionId = qid;
  state.question = state.questions.find(q => q.id === qid) || null;
  state.history = [];
  state.feedbackMd = "";
  state.exemplarUsed = null;
  if (els.draftInput) els.draftInput.value = "";
  if (els.feedbackOutput) els.feedbackOutput.innerHTML = "";
  resetChatWindow();
  if (els.autosave) {
    els.autosave.textContent = "not saved";
    els.autosave.classList.remove("saved");
  }
  if (els.draftCounter) els.draftCounter.textContent = "0 / ~2000 words";
  localStorage.setItem(QID_KEY, qid);
  paintSelectedBanners();

  const saved = loadSavedStateFor(qid);
  if (saved) {
    state.history = saved.history || [];
    state.feedbackMd = saved.feedback || "";
    state.exemplarUsed = saved.exemplar || null;
    if (els.draftInput) els.draftInput.value = saved.draft || "";
    updateWordCount();
    if (state.history.length) {
      resetChatWindow();
      els.chatWindow.removeChild(els.chatEmpty);
      for (const t of state.history) appendMessage(t.role, t.text);
    }
    if (state.feedbackMd && els.feedbackOutput) {
      const tag = state.exemplarUsed
        ? `<p class="chat-meta">Restored from autosave · compared to SACE exemplar: ${escapeHtml(state.exemplarUsed)}</p>`
        : `<p class="chat-meta">Restored from autosave</p>`;
      els.feedbackOutput.innerHTML = tag + renderMarkdown(state.feedbackMd);
    }
    if (saved.savedAt && els.autosave) {
      els.autosave.textContent = `restored · saved ${new Date(saved.savedAt).toLocaleString()}`;
      els.autosave.classList.add("saved");
    }
  }

  refreshControls();
  navigate("readings");
}

function paintSelectedBanners() {
  const q = state.question;
  const html = q
    ? `<div class="q-domain-tag">${(DOMAIN_LABELS[q.domain] || q.domain).toUpperCase()}${q.cluster_display_name ? " · cluster: " + escapeHtml(q.cluster_display_name) : ""}</div>${escapeHtml(q.text)}`
    : "<em>Pick a question first.</em>";
  if (els.selectedQReadings) els.selectedQReadings.innerHTML = html;
  if (els.selectedQChamber) els.selectedQChamber.innerHTML = html;
  if (els.selectedQDrafting) els.selectedQDrafting.innerHTML = html;
}

// ── Readings ───────────────────────────────────────────────────
function renderReadingsForCurrent() {
  if (!state.questionId) return;
  const data = state.readingsByQid[state.questionId];
  if (!data) {
    els.dialecticBlock.innerHTML = "";
    els.readingsPrimary.innerHTML = "<li><em>No readings on file for this question.</em></li>";
    els.readingsSecondary.innerHTML = "";
    return;
  }
  els.dialecticBlock.innerHTML = data.dialectic ? renderMarkdown(data.dialectic) : "";

  const grouped = { primary: [], secondary: [] };
  for (const r of (data.readings || [])) (grouped[r.tier] || grouped.primary).push(r);
  for (const tier of ["primary", "secondary"]) {
    const ul = tier === "primary" ? els.readingsPrimary : els.readingsSecondary;
    ul.innerHTML = "";
    if (!grouped[tier].length) {
      ul.innerHTML = `<li><em>No ${tier} readings curated.</em></li>`;
      continue;
    }
    for (const r of grouped[tier]) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.className = "reading-title";
      a.href = r.download_url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = (r.filename || "").replace(/\.pdf$/i, "");
      a.title = `Open / download${r.size_bytes ? ` (${(r.size_bytes / 1_000_000).toFixed(1)} MB)` : ""}`;
      li.appendChild(a);
      if (r.folder) {
        const f = document.createElement("span");
        f.className = "reading-folder";
        f.textContent = r.folder;
        li.appendChild(f);
      }
      if (r.why) {
        const w = document.createElement("span");
        w.className = "reading-why";
        w.textContent = r.why;
        li.appendChild(w);
      }
      ul.appendChild(li);
    }
  }
}

// ── Chamber (live chat) ────────────────────────────────────────
function resetChatWindow() {
  if (!els.chatWindow) return;
  els.chatWindow.innerHTML = "";
  if (els.chatEmpty) els.chatWindow.appendChild(els.chatEmpty);
}

function appendMessage(role, text, meta = "") {
  if (!els.chatWindow) return null;
  if (els.chatEmpty && els.chatEmpty.parentNode === els.chatWindow) {
    els.chatWindow.removeChild(els.chatEmpty);
  }
  const wrap = document.createElement("div");
  wrap.className = `message ${role}`;
  const r = document.createElement("div");
  r.className = "message-role";
  r.textContent = role === "user" ? "You" : role === "model" ? "Library" : "Error";
  const body = document.createElement("div");
  body.className = "message-body";
  body.innerHTML = renderMarkdown(text);
  wrap.appendChild(r);
  wrap.appendChild(body);
  if (meta) {
    const m = document.createElement("div");
    m.className = "chat-meta";
    m.textContent = meta;
    wrap.appendChild(m);
  }
  els.chatWindow.appendChild(wrap);
  els.chatWindow.scrollTop = els.chatWindow.scrollHeight;
  return body;
}

async function onChatSubmit(e) {
  e.preventDefault();
  const message = (els.chatInput.value || "").trim();
  if (!message || !state.questionId) return;
  appendMessage("user", message);
  state.history.push({ role: "user", text: message });
  els.chatInput.value = "";
  els.chatInput.disabled = true;
  els.chatSend.disabled = true;
  els.chatMeta.innerHTML = `<span class="spinner"></span>thinking…`;
  try {
    const data = await fetchJson("/api/chat", {
      question_id: state.questionId,
      message,
      history: state.history.slice(0, -1).map(t => ({ role: t.role, text: t.text })),
    });
    appendMessage("model", data.text || "(no reply)");
    state.history.push({ role: "model", text: data.text || "" });
    const cost = (data.estimated_cost_usd || 0).toFixed(4);
    els.chatMeta.textContent = `${data.duration_ms || 0} ms · ~$${cost}`;
    persistCurrent({ flush: true });
  } catch (err) {
    appendMessage("error", `Request failed: ${err.message}. You can still use the handoff fallback below.`);
    els.chatMeta.textContent = "";
  } finally {
    els.chatInput.disabled = false;
    els.chatSend.disabled = false;
    els.chatInput.focus();
  }
}

function onChatKeydown(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    els.chatForm.requestSubmit();
  }
}

// ── Chamber (handoff prompt builder) ───────────────────────────
function buildChamberPrompt() {
  const q = state.question;
  if (!q) return "";
  const data = state.readingsByQid[q.id] || {};
  const readings = (data.readings || [])
    .map(r => {
      const tier = r.tier === "primary" ? "primary" : "secondary";
      const title = (r.filename || "").replace(/\.pdf$/i, "");
      return `- [${tier}] ${title}${r.why ? " — " + r.why : ""}`;
    }).join("\n");
  const dialectic = data.dialectic || "";

  return `You are the Library — a Socratic interlocutor for a SACE Stage 2 Philosophy student working on their Issues Study (AT3). The student must investigate one philosophical issue, present multiple positions with their reasoning, raise objections, and defend their own answer.

Your role:
1. Steel-man positions the student dismisses.
2. Press for reasons, not just claims.
3. Surface the most damaging objection to whatever position they're leaning toward, and ask how they'd respond.
4. Refuse to write paragraphs of their essay. Push them to think; don't draft for them.
5. Reference the readings by name when relevant — recommend which to consult first.
6. Be brief. Ask questions, don't lecture. Under 200 words per reply unless asked for more depth.
7. Ask early in the dialogue why they think this question is genuinely philosophical (RA1).

Tone: warm, precise, intellectually serious. Clean Australian/British English.

# The student's question
${q.text}

Domain: ${q.domain}${q.subdomain ? " · " + q.subdomain : ""}

# The dialectic landscape
${dialectic}

# The curated readings the student has been given
${readings || "(no curated readings on file)"}

The student will now begin. Push them.`;
}

function updateChamberPrompt() {
  if (!els.chamberPrompt) return;
  const text = buildChamberPrompt();
  els.chamberPrompt.value = text;
  if (els.chamberPromptMeta) {
    els.chamberPromptMeta.textContent = text ? `${text.length.toLocaleString()} chars` : "";
  }
}

async function onChamberCopy() {
  const text = els.chamberPrompt.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    setStatus("chamber prompt copied", "ready");
  } catch (e) {
    els.chamberPrompt.select();
    document.execCommand("copy");
    setStatus("chamber prompt copied", "ready");
  }
}

// ── Drafting ───────────────────────────────────────────────────
function updateWordCount() {
  if (!els.draftInput || !els.draftCounter) return;
  const text = els.draftInput.value;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  els.draftCounter.textContent = `${words.toLocaleString()} / ~2000 words`;
}

async function onFeedbackClick() {
  const draft = (els.draftInput.value || "").trim();
  if (!state.questionId || draft.length < 200) return;
  els.feedbackBtn.disabled = true;
  const original = els.feedbackBtn.textContent;
  els.feedbackBtn.innerHTML = `<span class="spinner"></span>Generating feedback…`;
  els.feedbackOutput.innerHTML = `<p><em>The model is reading your draft against the rubric and the closest exemplar. This usually takes 15--30 seconds.</em></p>`;
  try {
    const data = await fetchJson("/api/feedback", { question_id: state.questionId, draft_text: draft });
    state.feedbackMd = data.feedback_markdown || "";
    state.exemplarUsed = data.exemplar_used || null;
    const cost = (data.estimated_cost_usd || 0).toFixed(4);
    els.feedbackOutput.innerHTML =
      `<p class="chat-meta">Compared to SACE exemplar: ${escapeHtml(state.exemplarUsed || "—")} · ${data.duration_ms || 0} ms · ~$${cost}</p>`
      + renderMarkdown(state.feedbackMd);
    persistCurrent({ flush: true });
  } catch (err) {
    els.feedbackOutput.innerHTML = `<p class="message error">Feedback failed: ${escapeHtml(err.message)}. The handoff fallback below still works.</p>`;
  } finally {
    els.feedbackBtn.textContent = original;
    refreshControls();
  }
}

// ── Feedback handoff prompt builder ────────────────────────────
function buildFeedbackPrompt() {
  const q = state.question;
  const draft = els.draftInput ? (els.draftInput.value || "").trim() : "";
  if (!q || draft.length < 200) return "";
  return `You are a SACE Stage 2 Philosophy moderator giving formative feedback on a student's Issues Study (AT3) draft. The student is graded on seven criteria: KU1, KU2, RA1, RA2, RA3, CA1, C1, C2.

Return structured markdown feedback in EXACTLY this format:

## Predicted band
A single grade (A+/A/A-/B+/B/B-/C+/C/C-/D/E) with one sentence justifying it.

## Strengths
2–4 bullets with specific phrases or moves quoted from the draft.

## Per-criterion feedback
A short paragraph for each of: **KU1**, **KU2**, **RA1**, **RA2**, **RA3**, **CA1**, **C1/C2**. For each: what's there, what's missing, the single most useful revision.

## Top three revisions
Numbered, concrete, specific, actionable.

Tone: honest senior reader. Never sycophantic. If weak, say so kindly. If strong, name precisely why.

# The student's question
${q.text}

Domain: ${q.domain}${q.subdomain ? " · " + q.subdomain : ""}

# The student's draft

${draft}

Now produce the feedback in the exact structure above.`;
}

function updateFeedbackPrompt() {
  if (!els.feedbackPrompt) return;
  const text = buildFeedbackPrompt();
  els.feedbackPrompt.value = text;
  if (els.feedbackPromptMeta) {
    els.feedbackPromptMeta.textContent = text ? `${text.length.toLocaleString()} chars` : "draft must be at least 200 chars";
  }
}

async function onFeedbackCopy() {
  const text = els.feedbackPrompt.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    setStatus("feedback prompt copied", "ready");
  } catch (e) {
    els.feedbackPrompt.select();
    document.execCommand("copy");
    setStatus("feedback prompt copied", "ready");
  }
}

// ── PDF export (client-side, via window.print()) ───────────────
function buildPrintView() {
  if (!els.printView) return;
  const name = getStudentName();
  const q = state.question;
  const draft = els.draftInput ? (els.draftInput.value || "") : "";
  const today = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

  const safe = (s) => escapeHtml(s || "");

  const historyHtml = state.history.length
    ? `<h2>Chamber dialogue</h2>` + state.history.map(t => {
        const role = t.role === "user" ? "You" : "Library";
        return `<div class="print-turn"><div class="print-turn-role">${safe(role)}</div><div class="print-turn-body">${renderMarkdown(t.text || "")}</div></div>`;
      }).join("")
    : "";

  const feedbackHtml = state.feedbackMd
    ? `<h2>Feedback</h2>${state.exemplarUsed ? `<p class="print-meta">Compared to SACE exemplar: ${safe(state.exemplarUsed)}</p>` : ""}<div class="print-feedback">${renderMarkdown(state.feedbackMd)}</div>`
    : "";

  els.printView.innerHTML = `
    <header class="print-header">
      <h1>Issues Study Lab — SACE Stage 2 Philosophy</h1>
      <p class="print-meta">${safe(name)} · ${safe(today)}</p>
    </header>
    ${q ? `<section><h2>The question</h2><p class="print-question"><strong>${safe(DOMAIN_LABELS[q.domain] || q.domain)}</strong> — ${safe(q.text)}</p></section>` : ""}
    <section><h2>Draft response</h2><div class="print-draft">${renderMarkdown(draft)}</div></section>
    ${feedbackHtml ? `<section>${feedbackHtml}</section>` : ""}
    ${historyHtml ? `<section>${historyHtml}</section>` : ""}
  `;
}

function onExportClick() {
  const studentName = getStudentName();
  if (!studentName) {
    setStatus("enter your name first", "error");
    navigate("welcome");
    setTimeout(() => els.studentName.focus(), 200);
    return;
  }
  if (!state.questionId) return;
  buildPrintView();
  // Allow the print view to render before the print dialog opens
  setTimeout(() => window.print(), 50);
}

// ── Init ──────────────────────────────────────────────────────
async function init() {
  loadStudentName();

  const savedQid = localStorage.getItem(QID_KEY);
  if (savedQid) state.questionId = savedQid;

  els.studentName.addEventListener("input", saveStudentName);
  $("welcome-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!getStudentName()) return;
    navigate("task");
  });
  els.domainFilter.addEventListener("change", renderBank);
  els.chatForm.addEventListener("submit", onChatSubmit);
  els.chatInput.addEventListener("keydown", onChatKeydown);
  els.draftInput.addEventListener("input", () => {
    updateWordCount();
    updateFeedbackPrompt();
    refreshControls();
    persistCurrent();
  });
  els.feedbackBtn.addEventListener("click", onFeedbackClick);
  els.exportBtn.addEventListener("click", onExportClick);
  if (els.chamberCopy) els.chamberCopy.addEventListener("click", onChamberCopy);
  if (els.feedbackCopy) els.feedbackCopy.addEventListener("click", onFeedbackCopy);

  window.addEventListener("hashchange", () => navigate(location.hash.replace(/^#/, "") || DEFAULT_PAGE, false));
  window.addEventListener("beforeunload", () => persistCurrent({ flush: true }));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persistCurrent({ flush: true });
  });

  await loadStaticData();

  if (state.questionId) {
    state.question = state.questions.find(q => q.id === state.questionId) || null;
    if (state.question) {
      paintSelectedBanners();
      const saved = loadSavedStateFor(state.questionId);
      if (saved) {
        state.history = saved.history || [];
        state.feedbackMd = saved.feedback || "";
        state.exemplarUsed = saved.exemplar || null;
        els.draftInput.value = saved.draft || "";
        updateWordCount();
        if (state.history.length) {
          resetChatWindow();
          els.chatWindow.removeChild(els.chatEmpty);
          for (const t of state.history) appendMessage(t.role, t.text);
        }
        if (state.feedbackMd && els.feedbackOutput) {
          const tag = state.exemplarUsed
            ? `<p class="chat-meta">Restored from autosave · compared to SACE exemplar: ${escapeHtml(state.exemplarUsed)}</p>`
            : `<p class="chat-meta">Restored from autosave</p>`;
          els.feedbackOutput.innerHTML = tag + renderMarkdown(state.feedbackMd);
        }
        if (saved.savedAt) {
          els.autosave.textContent = `restored · saved ${new Date(saved.savedAt).toLocaleString()}`;
          els.autosave.classList.add("saved");
        }
      }
    } else {
      state.questionId = null;
      localStorage.removeItem(QID_KEY);
    }
  }

  updateChamberPrompt();
  updateFeedbackPrompt();
  refreshControls();
  navigate(location.hash.replace(/^#/, "") || DEFAULT_PAGE, false);
}

document.addEventListener("DOMContentLoaded", init);
