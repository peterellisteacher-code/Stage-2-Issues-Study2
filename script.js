// Issues Study Lab — wizard SPA, vanilla JS.

// ── Cross-origin Cloud Run base ─────────────────────────────────
// On Netlify the /api/* edge proxy times out at 30s, killing chat calls.
// So we hit Cloud Run directly. CORS allows the Netlify origin.
const API_BASE = (location.hostname.endsWith(".netlify.app") || location.hostname.endsWith(".netlify.com"))
  ? "https://issues-study-lab-167911956198.us-central1.run.app"
  : "";

const PAGES = ["welcome", "task", "bank", "readings", "chamber", "drafting"];
const DEFAULT_PAGE = "welcome";
// Pages that need a question selected before they're useful
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
  questions: [],            // [{id, domain, text, cluster_pack, ...}]
  questionId: null,         // currently picked question id
  question: null,           // resolved question object
  readings: null,           // {readings, dialectic, ...} — cached per question
  history: [],              // chat turns
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
  // bank
  domainFilter: $("domain-filter"),
  bankCount: $("bank-count"),
  questionList: $("question-list"),
  // readings
  selectedQReadings: $("selected-q-readings"),
  dialecticBlock: $("dialectic-block"),
  readingsPrimary: $("readings-primary"),
  readingsSecondary: $("readings-secondary"),
  // chamber
  selectedQChamber: $("selected-q-chamber"),
  chatWindow: $("chat-window"),
  chatEmpty: $("chat-empty"),
  chatForm: $("chat-form"),
  chatInput: $("chat-input"),
  chatSend: $("chat-send"),
  chatMeta: $("chat-meta"),
  // drafting
  selectedQDrafting: $("selected-q-drafting"),
  draftInput: $("draft-input"),
  draftCounter: $("draft-counter"),
  feedbackBtn: $("feedback-btn"),
  exportBtn: $("export-pdf-btn"),
  feedbackOutput: $("feedback-output"),
  autosave: $("autosave-indicator"),
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
  if (flush && saveDebounce) { clearTimeout(saveDebounce); saveDebounce = null; write(); }
  else if (flush) write();
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

// ── API helper ─────────────────────────────────────────────────
async function api(path, body) {
  const opts = { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API_BASE + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.detail || `HTTP ${res.status}`);
  return data;
}

function setStatus(text, cls = "") { els.status.textContent = text; els.status.className = "status " + cls; }

// ── Router ─────────────────────────────────────────────────────
function navigate(page, push = true) {
  if (!PAGES.includes(page)) page = DEFAULT_PAGE;
  // Lock pages that need a question
  if (NEEDS_QUESTION.has(page) && !state.questionId) {
    page = "bank";
    setStatus("pick a question first", "error");
  } else if (page !== "welcome" && !getStudentName()) {
    // Force name first
    page = "welcome";
    setStatus("enter your name to begin", "error");
  } else {
    setStatus("");
  }

  for (const [name, el] of Object.entries(els.pages)) {
    el.classList.toggle("active", name === page);
  }
  els.navLinks.forEach(a => {
    a.classList.toggle("active", a.dataset.page === page);
    a.classList.toggle("locked", NEEDS_QUESTION.has(a.dataset.page) && !state.questionId);
  });

  if (push && location.hash !== "#" + page) {
    history.replaceState(null, "", "#" + page);
  }
  window.scrollTo(0, 0);

  // Page-specific entry hooks
  if (page === "bank" && state.questions.length === 0) loadQuestions();
  if (page === "readings" && state.questionId && !state.readings) loadReadings(state.questionId);
}

function refreshControls() {
  const hasName = getStudentName().length > 0;
  const hasQ = !!state.questionId;
  els.beginBtn.disabled = !hasName;
  // Chamber controls
  els.chatInput.disabled = !hasQ;
  els.chatSend.disabled = !hasQ;
  // Drafting controls
  els.draftInput.disabled = !hasQ;
  const draftLen = els.draftInput.value.length;
  els.feedbackBtn.disabled = !hasQ || draftLen < 200;
  els.exportBtn.disabled = !hasQ || !hasName;
  // Re-evaluate locked nav links
  els.navLinks.forEach(a => {
    a.classList.toggle("locked", NEEDS_QUESTION.has(a.dataset.page) && !state.questionId);
  });
}

// ── Bank ───────────────────────────────────────────────────────
async function loadQuestions() {
  setStatus("loading questions…");
  try {
    const data = await api("/api/questions");
    state.questions = data.questions || [];
    setStatus(`${state.questions.length} questions loaded`, "ready");
    renderBank();
  } catch (e) {
    setStatus(`failed: ${e.message}`, "error");
  }
}

function renderBank() {
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

    const dom = document.createElement("span");
    dom.className = "q-domain";
    dom.textContent = DOMAIN_LABELS[q.domain] || q.domain;

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
    li.appendChild(dom);
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
  state.question = state.questions.find(q => q.id === qid);
  state.readings = null;
  state.history = [];
  state.feedbackMd = "";
  state.exemplarUsed = null;
  els.draftInput.value = "";
  els.feedbackOutput.innerHTML = "";
  els.chatWindow.innerHTML = "";
  els.chatWindow.appendChild(els.chatEmpty);
  els.autosave.textContent = "not saved";
  els.autosave.classList.remove("saved");
  els.draftCounter.textContent = "0 / ~2000 words";
  localStorage.setItem(QID_KEY, qid);
  paintSelectedBanners();

  // Restore saved state if any
  const saved = loadSavedStateFor(qid);
  if (saved) {
    state.history = saved.history || [];
    state.feedbackMd = saved.feedback || "";
    state.exemplarUsed = saved.exemplar || null;
    els.draftInput.value = saved.draft || "";
    updateWordCount();
    if (state.history.length) {
      els.chatWindow.innerHTML = "";
      for (const t of state.history) appendMessage(t.role, t.text);
    }
    if (state.feedbackMd) {
      const tag = state.exemplarUsed
        ? `<p class="chat-meta">Restored from autosave · compared to SACE exemplar: ${state.exemplarUsed}</p>`
        : `<p class="chat-meta">Restored from autosave</p>`;
      els.feedbackOutput.innerHTML = tag + renderMarkdown(state.feedbackMd);
    }
    if (saved.savedAt) {
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
    ? `<div class="q-domain-tag">${(DOMAIN_LABELS[q.domain] || q.domain).toUpperCase()}${q.cluster_display_name ? " · cluster: " + q.cluster_display_name : ""}</div>${escapeHtml(q.text)}`
    : "<em>Pick a question first.</em>";
  els.selectedQReadings.innerHTML = html;
  els.selectedQChamber.innerHTML = html;
  els.selectedQDrafting.innerHTML = html;
}

// ── Readings ───────────────────────────────────────────────────
async function loadReadings(qid) {
  setStatus("loading readings…");
  try {
    const data = await api("/api/readings", { question_id: qid });
    state.readings = data;
    renderReadings(data);
    setStatus(`${data.readings.length} readings loaded`, "ready");
  } catch (e) {
    setStatus(`failed: ${e.message}`, "error");
  }
}
function renderReadings(data) {
  // Dialectic
  els.dialecticBlock.innerHTML = data.dialectic ? renderMarkdown(data.dialectic) : "";

  const grouped = { primary: [], secondary: [] };
  for (const r of data.readings) (grouped[r.tier] || grouped.primary).push(r);
  els.readingsPrimary.innerHTML = "";
  els.readingsSecondary.innerHTML = "";
  for (const tier of ["primary", "secondary"]) {
    const ul = tier === "primary" ? els.readingsPrimary : els.readingsSecondary;
    if (!grouped[tier].length) {
      ul.innerHTML = `<li><em>No ${tier} readings curated.</em></li>`;
      continue;
    }
    for (const r of grouped[tier]) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.className = "reading-title";
      a.href = (API_BASE ? "" : "") + r.download_url;  // /readings/* (handled by Netlify redirect to GCS)
      // when running on Netlify, /readings/* is rewritten by netlify.toml to GCS bucket; the relative path works
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = r.filename.replace(/\.pdf$/i, "");
      a.title = `Open / download (${(r.size_bytes / 1_000_000).toFixed(1)} MB)`;
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

// ── Chamber ────────────────────────────────────────────────────
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
  els.chatMeta.innerHTML = `<span class="spinner"></span>thinking… (first call may take 60-90s while the library warms up)`;
  try {
    const data = await api("/api/chat", {
      question_id: state.questionId,
      message,
      history: state.history.slice(0, -1).map(t => ({ role: t.role, text: t.text })),
    });
    appendMessage("model", data.text || "(no reply)");
    state.history.push({ role: "model", text: data.text || "" });
    els.chatMeta.textContent = `${data.duration_ms} ms · ~$${(data.estimated_cost_usd || 0).toFixed(4)}`;
    persistCurrent({ flush: true });
  } catch (err) {
    appendMessage("error", `Request failed: ${err.message}`);
    els.chatMeta.textContent = "";
  } finally {
    els.chatInput.disabled = false;
    els.chatSend.disabled = false;
    els.chatInput.focus();
  }
}

// ── Drafting ───────────────────────────────────────────────────
function updateWordCount() {
  const text = els.draftInput.value;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  els.draftCounter.textContent = `${words.toLocaleString()} / ~2000 words`;
}

async function onFeedbackClick() {
  const draft = els.draftInput.value.trim();
  if (!state.questionId || draft.length < 200) return;
  els.feedbackBtn.disabled = true;
  const original = els.feedbackBtn.textContent;
  els.feedbackBtn.innerHTML = `<span class="spinner"></span>Generating feedback…`;
  els.feedbackOutput.innerHTML = `<p><em>The model is reading your draft against the rubric and the closest exemplar. Usually 15–30 seconds.</em></p>`;
  try {
    const data = await api("/api/feedback", { question_id: state.questionId, draft_text: draft });
    state.feedbackMd = data.feedback_markdown || "";
    state.exemplarUsed = data.exemplar_used || null;
    els.feedbackOutput.innerHTML =
      `<p class="chat-meta">Compared to SACE exemplar: ${data.exemplar_used} · ${data.duration_ms} ms · ~$${(data.estimated_cost_usd || 0).toFixed(4)}</p>`
      + renderMarkdown(state.feedbackMd);
    persistCurrent({ flush: true });
  } catch (err) {
    els.feedbackOutput.innerHTML = `<p class="message error">Feedback failed: ${err.message}</p>`;
  } finally {
    els.feedbackBtn.textContent = original;
    refreshControls();
  }
}

async function onExportClick() {
  const studentName = getStudentName();
  if (!studentName) {
    setStatus("enter your name first", "error");
    navigate("welcome");
    setTimeout(() => els.studentName.focus(), 200);
    return;
  }
  if (!state.questionId) return;
  const original = els.exportBtn.textContent;
  els.exportBtn.disabled = true;
  els.exportBtn.innerHTML = `<span class="spinner"></span>Building PDF…`;
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
      let detail; try { detail = (await res.json()).error; } catch { detail = `HTTP ${res.status}`; }
      throw new Error(detail);
    }
    const blob = await res.blob();
    const cd = res.headers.get("Content-Disposition") || "";
    const m = cd.match(/filename="([^"]+)"/);
    const filename = m ? m[1] : `issues_study_${state.questionId}.pdf`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    setStatus(`PDF downloaded: ${filename}`, "ready");
  } catch (err) {
    setStatus(`PDF export failed: ${err.message}`, "error");
  } finally {
    els.exportBtn.textContent = original;
    refreshControls();
  }
}

// ── Init ──────────────────────────────────────────────────────
async function init() {
  loadStudentName();

  // Restore last picked question if present
  const savedQid = localStorage.getItem(QID_KEY);
  if (savedQid) {
    // Defer setting state.questionId until after questions load (for state.question)
    state.questionId = savedQid;
  }

  // Wire events
  els.studentName.addEventListener("input", saveStudentName);
  $("welcome-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!getStudentName()) return;
    navigate("task");
  });
  els.domainFilter.addEventListener("change", renderBank);
  els.chatForm.addEventListener("submit", onChatSubmit);
  els.draftInput.addEventListener("input", () => {
    updateWordCount();
    refreshControls();
    persistCurrent();
  });
  els.feedbackBtn.addEventListener("click", onFeedbackClick);
  els.exportBtn.addEventListener("click", onExportClick);

  window.addEventListener("hashchange", () => navigate(location.hash.replace(/^#/, "") || DEFAULT_PAGE, false));
  window.addEventListener("beforeunload", () => persistCurrent({ flush: true }));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persistCurrent({ flush: true });
  });

  // Pre-load questions so the bank is instant when the user navigates there
  await loadQuestions();
  // Resolve saved question
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
          els.chatWindow.innerHTML = "";
          for (const t of state.history) appendMessage(t.role, t.text);
        }
        if (state.feedbackMd) {
          els.feedbackOutput.innerHTML = renderMarkdown(state.feedbackMd);
        }
        if (saved.savedAt) {
          els.autosave.textContent = `restored · saved ${new Date(saved.savedAt).toLocaleString()}`;
          els.autosave.classList.add("saved");
        }
      }
    } else {
      // Saved qid not in current bank — clear it
      state.questionId = null;
      localStorage.removeItem(QID_KEY);
    }
  }

  refreshControls();
  navigate(location.hash.replace(/^#/, "") || DEFAULT_PAGE, false);
}

document.addEventListener("DOMContentLoaded", init);
