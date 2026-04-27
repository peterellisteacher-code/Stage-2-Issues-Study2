// Issues Study Lab — vanilla JS frontend.

const state = {
  questionId: null,
  history: [], // [{role, text}]
  feedbackMd: "", // last feedback as raw markdown (for PDF export + restore)
  exemplarUsed: null,
};

const $ = (id) => document.getElementById(id);

const els = {
  status: $("status"),
  studentName: $("student-name"),
  questionSelect: $("question-select"),
  questionCard: $("question-card"),
  questionDomain: $("question-domain"),
  questionText: $("question-text"),
  questionPhilosophers: $("question-philosophers"),
  readingsList: $("readings-list"),
  chatWindow: $("chat-window"),
  chatEmpty: $("chat-empty"),
  chatForm: $("chat-form"),
  chatInput: $("chat-input"),
  chatSend: $("chat-send"),
  chatMeta: $("chat-meta"),
  draftInput: $("draft-input"),
  draftCounter: $("draft-counter"),
  feedbackBtn: $("feedback-btn"),
  feedbackOutput: $("feedback-output"),
  exportBtn: $("export-pdf-btn"),
  autosave: $("autosave-indicator"),
  dialecticWrap: $("dialectic-wrap"),
  dialecticCard: $("dialectic-card"),
};

// ── Persistence (localStorage) ──────────────────────────────────────────
const NAME_KEY = "lab_student_name";
const stateKey = (qid) => `lab_state_${qid}`;

function getStudentName() {
  return (els.studentName.value || "").trim();
}
function saveStudentName() {
  const name = getStudentName();
  if (name) localStorage.setItem(NAME_KEY, name);
  else localStorage.removeItem(NAME_KEY);
  refreshExportEnabled();
}
function loadStudentName() {
  els.studentName.value = localStorage.getItem(NAME_KEY) || "";
}

let saveDebounce = null;
function persistCurrent({ flushDebounce = false } = {}) {
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
  if (flushDebounce && saveDebounce) {
    clearTimeout(saveDebounce);
    saveDebounce = null;
    write();
  } else if (flushDebounce) {
    write();
  } else {
    if (saveDebounce) clearTimeout(saveDebounce);
    saveDebounce = setTimeout(write, 600);
  }
}

function loadSavedStateFor(qid) {
  try {
    const raw = localStorage.getItem(stateKey(qid));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function refreshExportEnabled() {
  const ready = !!state.questionId && getStudentName().length > 0;
  if (els.exportBtn) els.exportBtn.disabled = !ready;
}

// ── Tiny markdown renderer ──────────────────────────────────────────────
// Handles: headings (## ###), **bold**, *italic*, code spans, paragraphs,
// unordered + ordered lists, blockquotes. Newline-separated.
function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
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
  const out = [];
  let buf = []; // paragraph buffer
  let listType = null;
  let listItems = [];
  const flushPara = () => {
    if (buf.length) {
      out.push("<p>" + renderInline(buf.join(" ").trim()) + "</p>");
      buf = [];
    }
  };
  const flushList = () => {
    if (listType) {
      out.push(`<${listType}>` + listItems.map((i) => `<li>${renderInline(i)}</li>`).join("") + `</${listType}>`);
      listType = null;
      listItems = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flushPara(); flushList();
      const level = Math.min(6, m[1].length + 1); // ## -> h3 etc.
      out.push(`<h${level}>${renderInline(m[2])}</h${level}>`);
      continue;
    }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      flushPara();
      if (listType !== "ul") { flushList(); listType = "ul"; }
      listItems.push(m[1]);
      continue;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara();
      if (listType !== "ol") { flushList(); listType = "ol"; }
      listItems.push(m[1]);
      continue;
    }
    if ((m = line.match(/^>\s?(.*)$/))) {
      flushPara(); flushList();
      out.push(`<blockquote>${renderInline(m[1])}</blockquote>`);
      continue;
    }
    buf.push(line);
  }
  flushPara();
  flushList();
  return out.join("\n");
}

// ── API helpers ─────────────────────────────────────────────────────────
// On Netlify the /api/* path is proxied to Cloud Run, but the proxy has a
// 30 s edge timeout that kills /api/chat (often 60-90 s on a cold pack).
// So when running on netlify.app we hit Cloud Run directly. CORS on the
// Cloud Run service already allows the Netlify origin.
const API_BASE = (location.hostname.endsWith(".netlify.app") || location.hostname.endsWith(".netlify.com"))
  ? "https://issues-study-lab-167911956198.us-central1.run.app"
  : "";   // same-origin (local dev or Cloud Run-served page)

async function api(path, body) {
  const opts = {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API_BASE + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || data.detail || `HTTP ${res.status}`);
  }
  return data;
}

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

// ── Init ────────────────────────────────────────────────────────────────
async function init() {
  setStatus("loading questions…");
  try {
    const { questions } = await api("/api/questions");
    // Group by domain into <optgroup>
    const grouped = {};
    for (const q of questions) {
      (grouped[q.domain] ||= []).push(q);
    }
    // Stable domain order matches the server's
    const order = ["ethics", "metaphysics", "epistemology", "political", "religion", "mind_tech", "aesthetics", "hybrid"];
    for (const dom of order) {
      const list = grouped[dom];
      if (!list) continue;
      const grp = document.createElement("optgroup");
      grp.label = DOMAIN_LABELS[dom] || dom;
      for (const q of list) {
        const opt = document.createElement("option");
        opt.value = q.id;
        opt.textContent = q.text;
        opt.dataset.domain = q.domain;
        opt.dataset.subdomain = q.subdomain || "";
        opt.dataset.cluster = q.cluster_display_name || "";
        opt.dataset.text = q.text;
        grp.appendChild(opt);
      }
      els.questionSelect.appendChild(grp);
    }
    setStatus(`ready · ${questions.length} questions across ${Object.keys(grouped).length} domains`, "ready");
  } catch (e) {
    setStatus(`server error: ${e.message}`, "error");
  }

  els.questionSelect.addEventListener("change", onQuestionChange);
  els.chatForm.addEventListener("submit", onChatSubmit);
  els.draftInput.addEventListener("input", () => {
    const n = els.draftInput.value.length;
    els.draftCounter.textContent = `${n.toLocaleString()} chars`;
    els.feedbackBtn.disabled = !state.questionId || n < 200;
    persistCurrent();
  });
  els.feedbackBtn.addEventListener("click", onFeedbackClick);
  els.exportBtn.addEventListener("click", onExportClick);

  // Student name: load on init, save on every keystroke (debounced via input event)
  loadStudentName();
  els.studentName.addEventListener("input", saveStudentName);
  // Save before unload as a final safety net
  window.addEventListener("beforeunload", () => persistCurrent({ flushDebounce: true }));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persistCurrent({ flushDebounce: true });
  });

  // Auto-select from URL hash (used by the headless screenshot harness):
  // navigating to /#lab_q003 selects that question on load.
  const hash = window.location.hash.replace(/^#/, "");
  if (hash && Array.from(els.questionSelect.options).some((o) => o.value === hash)) {
    els.questionSelect.value = hash;
    await onQuestionChange();
  }
  refreshExportEnabled();
}

function setStatus(text, cls = "") {
  els.status.textContent = text;
  els.status.className = "status " + cls;
}

// ── Question change ─────────────────────────────────────────────────────
async function onQuestionChange() {
  // Flush any in-flight save for the question we're leaving
  if (saveDebounce) {
    clearTimeout(saveDebounce);
    saveDebounce = null;
  }

  const qid = els.questionSelect.value;
  state.questionId = qid || null;
  state.history = [];
  state.feedbackMd = "";
  state.exemplarUsed = null;
  els.chatWindow.innerHTML = "";
  els.feedbackOutput.innerHTML = "";
  els.draftInput.value = "";
  els.draftCounter.textContent = "0 chars";
  els.autosave.textContent = "not saved";
  els.autosave.classList.remove("saved");

  if (!qid) {
    els.questionCard.classList.add("hidden");
    els.readingsList.innerHTML = "";
    els.chatInput.disabled = true;
    els.chatSend.disabled = true;
    els.draftInput.disabled = true;
    els.feedbackBtn.disabled = true;
    refreshExportEnabled();
    return;
  }

  // Show empty placeholder again
  if (els.chatEmpty.parentNode !== els.chatWindow) els.chatWindow.appendChild(els.chatEmpty);

  const opt = els.questionSelect.options[els.questionSelect.selectedIndex];
  const domain = opt.dataset.domain;
  const cluster = opt.dataset.cluster || "";
  els.questionCard.classList.remove("hidden");
  els.questionDomain.dataset.domain = domain;
  els.questionDomain.textContent = (DOMAIN_LABELS[domain] || domain).toUpperCase();
  els.questionText.textContent = opt.dataset.text || opt.textContent;
  els.questionPhilosophers.textContent = cluster || "";

  els.chatInput.disabled = false;
  els.chatSend.disabled = false;
  els.draftInput.disabled = false;
  els.feedbackBtn.disabled = els.draftInput.value.length < 200;

  setStatus("loading readings…");
  try {
    const data = await api("/api/readings", { question_id: qid });
    renderReadings(data.readings || [], data.dialectic || "");
    const tag = data.cluster_display_name ? ` · cluster: ${data.cluster_display_name}` : "";
    setStatus(`ready · ${data.readings.length} readings${tag}`, "ready");
  } catch (e) {
    setStatus(`failed to load readings: ${e.message}`, "error");
  }

  // Restore any saved work for this question
  const saved = loadSavedStateFor(qid);
  if (saved) {
    state.history = saved.history || [];
    state.feedbackMd = saved.feedback || "";
    state.exemplarUsed = saved.exemplar || null;
    els.draftInput.value = saved.draft || "";
    els.draftCounter.textContent = `${els.draftInput.value.length.toLocaleString()} chars`;
    els.feedbackBtn.disabled = els.draftInput.value.length < 200;
    // Re-render chat
    if (state.history.length) {
      els.chatWindow.innerHTML = "";
      for (const turn of state.history) appendMessage(turn.role, turn.text);
    }
    // Re-render feedback
    if (state.feedbackMd) {
      const tag = state.exemplarUsed
        ? `<p style="font-size:13px;color:#8a8378;font-family:ui-monospace,monospace;">Restored from autosave · compared to SACE exemplar: ${state.exemplarUsed}</p>`
        : `<p style="font-size:13px;color:#8a8378;font-family:ui-monospace,monospace;">Restored from autosave</p>`;
      els.feedbackOutput.innerHTML = tag + renderMarkdown(state.feedbackMd);
    }
    if (saved.savedAt) {
      els.autosave.textContent = `restored · saved ${new Date(saved.savedAt).toLocaleString()}`;
      els.autosave.classList.add("saved");
    }
  }
  refreshExportEnabled();
}

function renderReadings(readings, dialecticMd = "") {
  // Dialectic lives in its own collapsible block above the UL
  if (dialecticMd) {
    els.dialecticCard.innerHTML = renderMarkdown(dialecticMd);
    els.dialecticWrap.style.display = "";
  } else {
    els.dialecticCard.innerHTML = "";
    els.dialecticWrap.style.display = "none";
  }

  els.readingsList.innerHTML = "";
  // Group primary first, then secondary
  const grouped = {primary: [], secondary: []};
  for (const r of readings) (grouped[r.tier] || grouped.primary).push(r);
  for (const tier of ["primary", "secondary"]) {
    if (!grouped[tier].length) continue;
    const header = document.createElement("li");
    header.className = "tier-header";
    header.textContent = tier === "primary" ? "Primary readings" : "Secondary readings";
    els.readingsList.appendChild(header);
    for (const r of grouped[tier]) {
      const li = document.createElement("li");
      li.className = `reading reading-${tier}`;

      const link = document.createElement("a");
      link.className = "reading-title";
      link.href = r.download_url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = r.filename.replace(/\.pdf$/i, "");
      link.title = `Click to open / download (${(r.size_bytes/1_000_000).toFixed(1)} MB)`;

      const folder = document.createElement("span");
      folder.className = "reading-folder";
      folder.textContent = r.folder || "";

      const why = document.createElement("span");
      why.className = "reading-why";
      why.textContent = r.why || "";

      li.appendChild(link);
      if (folder.textContent) li.appendChild(folder);
      if (why.textContent) li.appendChild(why);
      els.readingsList.appendChild(li);
    }
  }
}

// ── Chat ────────────────────────────────────────────────────────────────
function appendMessage(role, text, meta = "") {
  if (els.chatEmpty.parentNode === els.chatWindow) els.chatWindow.removeChild(els.chatEmpty);
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
  const message = els.chatInput.value.trim();
  if (!message || !state.questionId) return;

  appendMessage("user", message);
  state.history.push({ role: "user", text: message });
  els.chatInput.value = "";
  els.chatInput.disabled = true;
  els.chatSend.disabled = true;
  els.chatMeta.innerHTML = `<span class="spinner"></span>thinking…`;

  try {
    const data = await api("/api/chat", {
      question_id: state.questionId,
      message,
      history: state.history.slice(0, -1).map((t) => ({ role: t.role, text: t.text })),
    });
    appendMessage("model", data.text || "(no reply)");
    state.history.push({ role: "model", text: data.text || "" });
    els.chatMeta.textContent = `${data.duration_ms} ms · ~$${(data.estimated_cost_usd || 0).toFixed(4)}`;
    persistCurrent({ flushDebounce: true });
  } catch (err) {
    appendMessage("error", `Request failed: ${err.message}`);
    els.chatMeta.textContent = "";
  } finally {
    els.chatInput.disabled = false;
    els.chatSend.disabled = false;
    els.chatInput.focus();
  }
}

// ── Feedback ────────────────────────────────────────────────────────────
async function onFeedbackClick() {
  const draft = els.draftInput.value.trim();
  if (!state.questionId || draft.length < 200) return;

  els.feedbackBtn.disabled = true;
  els.feedbackOutput.innerHTML = `<p><span class="spinner"></span>Generating feedback (15-25s)…</p>`;

  try {
    const data = await api("/api/feedback", {
      question_id: state.questionId,
      draft_text: draft,
    });
    state.feedbackMd = data.feedback_markdown || "";
    state.exemplarUsed = data.exemplar_used || null;
    els.feedbackOutput.innerHTML =
      `<p style="font-size:13px;color:#8a8378;font-family:ui-monospace,monospace;">` +
      `Compared to SACE exemplar: ${data.exemplar_used} · ${data.duration_ms} ms · ~$${(data.estimated_cost_usd || 0).toFixed(4)}` +
      `</p>` + renderMarkdown(state.feedbackMd);
    persistCurrent({ flushDebounce: true });
  } catch (err) {
    els.feedbackOutput.innerHTML = `<p class="message error">Feedback failed: ${err.message}</p>`;
  } finally {
    els.feedbackBtn.disabled = els.draftInput.value.length < 200;
  }
}

// ── Save as PDF ─────────────────────────────────────────────────────────
async function onExportClick() {
  const studentName = getStudentName();
  if (!studentName) {
    els.studentName.focus();
    setStatus("enter your name before saving as PDF", "error");
    return;
  }
  if (!state.questionId) return;

  const originalLabel = els.exportBtn.textContent;
  els.exportBtn.disabled = true;
  els.exportBtn.textContent = "Building PDF…";

  try {
    const res = await fetch(API_BASE + "/api/export_pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        student_name: studentName,
        question_id: state.questionId,
        history: state.history,
        draft: els.draftInput.value || "",
        feedback: state.feedbackMd || "",
      }),
    });
    if (!res.ok) {
      let detail;
      try { detail = (await res.json()).error; } catch { detail = `HTTP ${res.status}`; }
      throw new Error(detail);
    }
    const blob = await res.blob();
    const cd = res.headers.get("Content-Disposition") || "";
    const fnMatch = cd.match(/filename="([^"]+)"/);
    const filename = fnMatch ? fnMatch[1] : `issues_study_${state.questionId}.pdf`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    setStatus(`PDF downloaded: ${filename}`, "ready");
  } catch (err) {
    setStatus(`PDF export failed: ${err.message}`, "error");
  } finally {
    els.exportBtn.textContent = originalLabel;
    refreshExportEnabled();
  }
}

document.addEventListener("DOMContentLoaded", init);
