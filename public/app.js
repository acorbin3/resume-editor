// Imports carry the same ?v= build id as this file so a deploy refreshes everything together.
const V = new URL(import.meta.url).searchParams.get("v") || "";
const q = V ? `?v=${V}` : "";
const [pdfjsLib, { createEditor }, { buildSyncMap, lineAtPoint, boxForLine }, { scoreKeywords }] = await Promise.all([
  import(`/vendor/pdfjs/pdf.min.mjs${q}`),
  import(`/vendor/editor.js${q}`),
  import(`/syncmap.js${q}`),
  import(`/keywords.js${q}`),
]);

pdfjsLib.GlobalWorkerOptions.workerSrc = `/vendor/pdfjs/pdf.worker.min.mjs${q}`;

const $ = (id) => document.getElementById(id);

// Send the user to the login page if their session expires mid-use.
const rawFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await rawFetch(...args);
  if (res.status === 401) location.replace("/login.html");
  return res;
};

let state = null; // { id, name, current, versions, messages }
// Pending highlight comments: { page, quote, note, rects: [{x,y,w,h} as fractions of the page] }
let comments = [];
let commentsVersion = null; // version the highlights were drawn on
let pendingSelection = null;
let renderToken = 0;
let renderedSrc = null;
let savedTex = ""; // LaTeX of the version being shown
let dirty = false; // editor has changes not yet recompiled
let syncCache = { key: null, map: null };
let pdfRendered = Promise.resolve();
let review = null; // { version, summary, suggestions: [{..., state: "pending"|"accepted"|"skipped", edited }] }

const editor = createEditor({
  parent: $("editorHost"),
  onSave: () => recompile(),
  onChange: () => setDirty(editor.getValue() !== savedTex),
  onDoubleClick: (line) => syncToPdf(line),
});

function setDirty(on) {
  dirty = on;
  $("recompileBtn").disabled = busy || !on;
  $("texStatus").textContent = on ? "Unsaved changes · ⌘S to recompile" : "⌘S to recompile · double-click to find it in the PDF";
  $("texStatus").classList.toggle("tex-status-dirty", on);
}

function confirmDiscard() {
  return !dirty || window.confirm("Discard your unsaved LaTeX edits?");
}
let busy = false;
let timerHandle = null;

// ---------- Helpers ----------

// Toasts: start/finish confirmations that are visible from any panel. A "working" toast
// stays until replaced or dismissed; others fade after a few seconds.
function toast(text, kind = "done", ms = 3500) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  const ico = `<span class="t-ico">${kind === "error" ? "⚠️" : "✅"}</span>`;
  el.innerHTML = `${ico}<span></span>`;
  el.lastChild.textContent = text;
  $("toasts").append(el);
  const remove = () => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 300);
  };
  setTimeout(remove, ms);
  if (navigator.vibrate) navigator.vibrate(kind === "error" ? [40, 60, 40] : 25);
  return remove;
}

// Every long action shows: the progress bar, a live bubble in the chat, the overlay on
// the document, and a spinner on the button that started it (btn).
let busyBtn = null;
function setBusy(on, text = "Working…", btn = null) {
  busy = on;
  $("busy").hidden = !on;
  $("progress").hidden = !on;
  $("sendBtn").disabled = on;
  $("analyzeBtn").disabled = on;
  $("tailorGo").disabled = on;
  $("applyBtn").disabled = on || !review?.suggestions.some((x) => x.state === "accepted");
  $("recompileBtn").disabled = on || !dirty;
  document.querySelectorAll("#chips button").forEach((b) => (b.disabled = on));
  if (!on && updatePending) setTimeout(() => location.reload(), 1500);
  if (!on && planShown) refreshPlan();
  busyBtn?.classList.remove("btn-busy");
  busyBtn = on ? btn : null;
  busyBtn?.classList.add("btn-busy");
  $("suggestions").classList.toggle("working", on && btn === $("applyBtn"));
  if (on && btn === $("applyBtn")) $("suggestions").dataset.working = text;
  clearInterval(timerHandle);
  clearInterval(glyphTimer);
  pending?.remove();
  pending = null;
  if (on) {
    pending = document.createElement("div");
    pending.className = "msg assistant pending";
    pending.innerHTML = `<span class="cc-glyph">✻</span><span class="cc-text"></span><span class="cc-dots"><i>.</i><i>.</i><i>.</i></span><span class="cc-time">0s</span>`;
    $("messages").append(pending);
    $("messages").scrollTop = $("messages").scrollHeight;
    const start = Date.now();
    $("busyTimer").textContent = "";
    timerHandle = setInterval(() => {
      const secs = Math.round((Date.now() - start) / 1000);
      $("busyTimer").textContent = `${secs}s`;
      if (pending) pending.querySelector(".cc-time").textContent = `${secs}s`;
    }, 1000);
    // The glyph cycles like Claude Code's spinner.
    let g = 0;
    glyphTimer = setInterval(() => {
      if (pending) pending.querySelector(".cc-glyph").textContent = GLYPHS[g++ % GLYPHS.length];
    }, 140);
    startPhrases();
  } else {
    clearInterval(phraseTimer);
    clearInterval(scrambleTimer);
  }
  setBusyText(text);
}
const GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
let glyphTimer = null;
let pending = null;

// New status text "decodes" into place: characters start as noise and resolve left to
// right. Trailing dots are dropped (the breathing ellipsis replaces them).
const NOISE = "!<>-_\\/[]{}=+*^?#%&@~░▒▓";
let scrambleTimer = null;
function decodeInto(el, text) {
  clearInterval(scrambleTimer);
  const target = text.replace(/[…\.]+$/, "");
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.textContent = target;
    return;
  }
  const frames = 14;
  let frame = 0;
  scrambleTimer = setInterval(() => {
    frame++;
    let html = "";
    for (let i = 0; i < target.length; i++) {
      const settleAt = (i / target.length) * frames * 0.75;
      if (target[i] === " " || frame > settleAt + 2) html += escapeHtml(target[i]);
      else html += `<span class="scr">${escapeHtml(NOISE[Math.floor(Math.random() * NOISE.length)])}</span>`;
    }
    el.innerHTML = html;
    if (frame >= frames) {
      clearInterval(scrambleTimer);
      el.textContent = target;
    }
  }, 36);
}

const PHRASES = ["Thinking…", "Cooking…", "Reading between the lines…", "Weighing every bullet…", "Hunting for orphan words…", "Polishing…", "Counting the metrics…", "Tightening the wording…", "Typesetting…", "Almost there…"];
let lastStatusAt = 0;
let phraseTimer = null;
function setBusyText(text, fromServer = true) {
  if (fromServer) lastStatusAt = Date.now();
  $("busyText").textContent = text;
  if (pending) {
    const t = pending.querySelector(".cc-text");
    if (t.dataset.text !== text) {
      t.dataset.text = text;
      decodeInto(t, text);
      $("messages").scrollTop = $("messages").scrollHeight;
    }
  }
  if ($("suggestions").classList.contains("working")) $("suggestions").dataset.working = text;
}
// When no real status has arrived for a while, cycle through friendlier phrases.
function startPhrases() {
  clearInterval(phraseTimer);
  let i = Math.floor(Math.random() * PHRASES.length);
  phraseTimer = setInterval(() => {
    if (!busy) return clearInterval(phraseTimer);
    if (Date.now() - lastStatusAt < 7000) return;
    setBusyText(PHRASES[i++ % PHRASES.length], false);
  }, 3500);
}

function showView(name) {
  $("uploadView").hidden = name !== "upload";
  $("editorView").hidden = name !== "editor";
  syncMobileNav();
}

// Read a newline-delimited JSON stream, calling onEvent for each event.
// Run a long action. Events stream in; if the connection drops (phone locked, app
// switched), the job keeps running on the server and we poll it to completion. The job id
// is remembered so a reload can pick the job up again.
const STALL_MS = 25_000; // the server pings every 10s; silence this long means the stream is dead
async function runJob(url, init, onEvent, memoryKey) {
  let jobId = null;
  let finished = false;
  const ctrl = new AbortController();
  let watchdog = null;
  const kick = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => ctrl.abort(new TypeError("stalled")), STALL_MS);
  };
  const handle = (evt) => {
    kick();
    if (evt.type === "job") {
      jobId = evt.id;
      remember(memoryKey, jobId);
      return;
    }
    if (evt.type === "ping") return;
    if (evt.type === "done" || evt.type === "error") {
      finished = true;
      forget(memoryKey);
    }
    onEvent(evt);
  };
  try {
    kick();
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    await streamJson(res, handle);
  } catch (err) {
    if (finished) return;
    if (!jobId || !(isNetworkError(err) || err.name === "AbortError" || ctrl.signal.aborted)) throw err;
    setBusyText("Reconnecting…");
    await pollJob(jobId, handle);
  } finally {
    clearTimeout(watchdog);
  }
}

async function pollJob(jobId, onEvent) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    let job;
    try {
      const res = await fetch(`/api/jobs/${jobId}`);
      if (res.status === 404) throw new Error("The server lost track of that job (it may have restarted). Reload to see where things stand.");
      job = await res.json();
    } catch (err) {
      if (isNetworkError(err)) continue; // still offline; keep trying
      throw err;
    }
    if (job.status === "running") {
      if (job.lastStatus) setBusyText(job.lastStatus);
      continue;
    }
    onEvent(job.result);
    return;
  }
}

const isNetworkError = (err) => err instanceof TypeError || /load failed|failed to fetch|network/i.test(err?.message || "");
const remember = (key, id) => { try { if (key) sessionStorage.setItem(key, id); } catch {} };
const forget = (key) => { try { if (key) sessionStorage.removeItem(key); } catch {} };

// After a reload: if a job was running for this resume, reattach to it.
async function resumePendingJob(resumeId) {
  const key = `job:${resumeId}`;
  let jobId = null;
  try { jobId = sessionStorage.getItem(key); } catch {}
  if (!jobId) {
    const active = await fetch(`/api/jobs/active?resume=${resumeId}`).then((r) => r.json()).catch(() => null);
    jobId = active?.id || null;
  }
  if (!jobId) return;
  const job = await fetch(`/api/jobs/${jobId}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!job) return forget(key);
  if (job.status !== "running") {
    forget(key);
    // A finished edit is already in the version list; a finished analysis is restored from the saved review.
    return;
  }
  setBusy(true, job.lastStatus || "Picking up where it left off…");
  try {
    await pollJob(jobId, (evt) => {
      forget(key);
      if (evt.type === "done") applyJobResult(job.kind, evt);
      if (evt.type === "error") addMessage("error", evt.message, null, true, evt.log);
    });
  } catch (err) {
    addMessage("error", explainError(err));
  } finally {
    setBusy(false);
  }
}

function applyJobResult(kind, evt) {
  if (kind === "analyze" || kind === "tailor") {
    review = makeReview(evt);
    renderReview();
    locateSuggestions();
    if (kind === "tailor" && evt.messages) for (const m of evt.messages) addMessage(m.role, m.text, m.version);
  } else if (evt.state) {
    state = evt.state;
    render(evt.tex);
    if (isMobile()) setPanel("pdf");
  }
}

async function streamJson(res, onEvent) {
  if (!res.ok && !res.headers.get("content-type")?.includes("ndjson")) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Request failed (${res.status})`);
    if (res.status === 402) {
      err.upgrade = true;
      showPlan(body.plan);
    }
    throw err;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
}

// fetch() rejects with a bare "Load failed" (Safari) or "Failed to fetch" (Chrome) when the
// connection drops, which on a phone usually means the screen locked or the app was
// switched away mid-request. The server keeps working; a reload shows the result.
function explainError(err) {
  if (err.upgrade) {
    toast(err.message, "error", 6000);
    return `${err.message} Use the Upgrade link above the quick actions.`;
  }
  if (err instanceof TypeError || /load failed|failed to fetch|network/i.test(err.message || "")) {
    return "The connection dropped before Claude finished (this happens on phones when the screen locks or you switch apps). The work usually completes on the server anyway: tap Reload to check.";
  }
  return err.message || String(err);
}

function progressHandler(evt) {
  if (evt.type === "status") setBusyText(evt.message);
  if (evt.type === "writing") setBusyText(`Claude is writing… (${evt.chars.toLocaleString()} chars)`);
}

// ---------- Rendering ----------

function render(tex) {
  if (!state) return;
  history.replaceState(null, "", `#${state.id}`);
  const v = state.current;
  const ver = state.versions.find((x) => x.n === v);

  $("downloads").hidden = !v;
  $("renameBtn").hidden = !state.id;
  if (v) {
    const base = `/api/resumes/${state.id}/v/${v}`;
    $("dlPdf").href = `${base}/resume.pdf?download=1`;
    $("dlTex").href = `${base}/resume.tex`;
    const src = `${base}/resume.pdf`;
    if (renderedSrc !== src) {
      renderedSrc = src;
      if (commentsVersion !== v) setComments([]);
      renderPdf(src);
    }
    const pages = ver?.pages;
    $("pageInfo").textContent = `Version ${v}${pages ? ` · ${pages} page${pages > 1 ? "s" : ""}` : ""}`;
    $("pageInfo").classList.toggle("warn", pages > 1);
    $("fitBtn").classList.toggle("chip-warn", pages > 1);
    $("fitBtn").textContent = pages > 1 ? `Fit to one page (${pages} now)` : "Fit to one page";
    refreshAtsBadge();
  }
  if (tex !== undefined) {
    savedTex = tex;
    editor.setValue(tex);
    setDirty(false);
  }
  if (review && review.version !== v) closeReview();
  fillDiffSelectors();
  if (currentView() === "diff") loadDiff();

  const msgs = $("messages");
  msgs.innerHTML = "";
  for (const m of state.messages) addMessage(m.role, m.text, m.version, false);
  msgs.scrollTop = msgs.scrollHeight;

  for (const list of [$("versionList"), $("sheetVersions")]) {
    list.innerHTML = "";
    for (const x of [...state.versions].reverse()) {
      const li = document.createElement("li");
      li.className = x.n === v ? "current" : "";
      const b = document.createElement("button");
      b.textContent = `v${x.n} · ${x.label}`;
      b.title = x.n === v ? x.label : `Restore v${x.n} as a new version`;
      b.onclick = () => {
        closeSheet();
        selectVersion(x.n);
      };
      li.append(b);
      list.append(li);
    }
  }
  syncMenu();
}

function addMessage(role, text, version, scroll = true, log) {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.textContent = text;
  if (version) {
    const tag = document.createElement("span");
    tag.className = "ver";
    tag.textContent = `→ version ${version}`;
    el.append(tag);
  }
  if (log) {
    const pre = document.createElement("pre");
    pre.textContent = log;
    el.append(pre);
  }
  if (role === "error" && /tap Reload/.test(text)) {
    const b = document.createElement("button");
    b.className = "btn small";
    b.textContent = "Reload";
    b.style.marginTop = "6px";
    b.onclick = () => location.reload();
    el.append(document.createElement("br"), b);
  }
  $("messages").append(el);
  if (scroll) $("messages").scrollTop = $("messages").scrollHeight;
}

async function refreshPicker(selectedId) {
  const list = await fetch("/api/resumes").then((r) => r.json());
  const picker = $("resumePicker");
  picker.innerHTML = "";
  picker.append(new Option("+ New resume", ""));
  for (const r of list) picker.append(new Option(r.name, r.id));
  picker.value = selectedId || "";
}

// ---------- Actions ----------

async function openResume(id) {
  const res = await fetch(`/api/resumes/${id}`);
  if (!res.ok) return newResume();
  const data = await res.json();
  state = data;
  showView("editor");
  render(data.tex);
  if (!data.versions.length) {
    addMessage("error", "This resume never finished converting. Upload the PDF again.");
  }
  resumePendingJob(id);
  if (data.versions.length && data.versions.length <= 2) showNextSteps();
  // Bring back an analysis that finished after the connection dropped (or from last time).
  if (data.review?.suggestions?.length || data.review?.keywords?.length) {
    review = makeReview(data.review);
    renderReview();
    locateSuggestions();
  }
}

// Review state from an analyze or tailor result (fresh, saved, or from a resumed job).
function makeReview(data) {
  return {
    kind: data.kind || "analyze",
    version: data.version,
    summary: data.summary,
    job: data.job || null,
    keywords: data.keywords || null,
    before: data.before || null,
    suggestions: (data.suggestions || []).map((sg) => ({ ...sg, state: "pending", edited: null })),
  };
}

// A conversion started before a reload (or while the phone was away) keeps running on
// the server; find it and follow it to the new resume.
async function resumePendingConvert() {
  const active = await fetch("/api/jobs/active").then((r) => r.json()).catch(() => null);
  if (!active || active.kind !== "convert") return;
  state = { id: active.resumeId, name: "", current: 0, versions: [], messages: [] };
  showView("editor");
  $("messages").innerHTML = "";
  addMessage("user", "Your upload is still converting");
  setBusy(true, active.lastStatus || "Picking up where it left off…");
  try {
    await pollJob(active.id, (evt) => {
      if (evt.type === "done") {
        state = evt.state;
        render(evt.tex);
        toast("Converted.");
        refreshPicker(state.id);
        if (isMobile()) setPanel("pdf");
      }
      if (evt.type === "error") addMessage("error", evt.message, null, true, evt.log);
    });
  } catch (err) {
    addMessage("error", explainError(err));
  } finally {
    setBusy(false);
  }
}

function newResume() {
  state = null;
  history.replaceState(null, "", location.pathname);
  $("resumePicker").value = "";
  $("downloads").hidden = true;
  $("renameBtn").hidden = true;
  syncMenu();
  showView("upload");
}

async function selectVersion(n) {
  if (busy || !state || !confirmDiscard()) return;
  const res = await fetch(`/api/resumes/${state.id}/current`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: n }),
  });
  const data = await res.json();
  if (!res.ok) return addMessage("error", data.error);
  state = data.state;
  render(data.tex);
}

async function convert(file) {
  const form = new FormData();
  form.append("pdf", file);
  form.append("instructions", $("instructions").value);
  form.append("onePage", $("onePage").checked ? "true" : "false");

  state = { id: null, name: file.name, current: 0, versions: [], messages: [] };
  $("messages").innerHTML = "";
  savedTex = "";
  editor.setValue("");
  setDirty(false);
  closeReview();
  $("pdfViewer").innerHTML = "";
  renderedSrc = null;
  setComments([]);
  $("pageInfo").textContent = "";
  $("versionList").innerHTML = "";
  showView("editor");
  addMessage("user", `Uploaded ${file.name}`);
  setBusy(true, "Uploading…", $("convertBtn"));

  try {
    await runJob("/api/resumes", { method: "POST", body: form }, (evt) => {
      progressHandler(evt);
      if (evt.type === "created") {
        state.id = evt.id;
        history.replaceState(null, "", `#${evt.id}`);
      }
      if (evt.type === "done") {
        state = evt.state;
        render(evt.tex);
        const pages = evt.state.versions.at(-1)?.pages || 1;
        toast(`Converted. ${pages} page${pages > 1 ? "s" : ""}.`);
        showNextSteps();
        if (isMobile()) setPanel("pdf");
      }
      if (evt.type === "error") {
        toast(evt.message, "error", 6000);
        addMessage("error", `${evt.message}\nPick “+ New resume” above to try again.`, null, true, evt.log);
        state.id = null;
        history.replaceState(null, "", location.pathname);
      }
    });
  } catch (err) {
    addMessage("error", explainError(err));
  } finally {
    setBusy(false);
    refreshPicker(state?.id);
  }
}

function composePrompt(typed) {
  if (!comments.length) return typed;
  const lines = comments.map(
    (c, i) => `${i + 1}. Highlighted on page ${c.page}: "${c.quote}"\n   Change: ${c.note}`
  );
  const head = typed ? `${typed}\n\n` : "";
  return `${head}Comments on highlighted text in the PDF. Find the matching text in the LaTeX source (it may differ slightly because of escaping or line breaks) and apply each change:\n${lines.join("\n")}`;
}

let promptSourceBtn = null;
async function applyPrompt(typed, sourceBtn = null) {
  promptSourceBtn = sourceBtn;
  if (busy || !state?.id || !state.current) return;
  if (dirty) {
    toast("Recompile your LaTeX edits first (⌘S) so Claude works from the latest version.", "error", 5000);
    addMessage("error", "You have unsaved LaTeX edits. Recompile them (⌘S) first so Claude works from your latest version.");
    return;
  }
  const prompt = composePrompt(typed);
  if (!prompt) return;
  addMessage("user", prompt);
  $("promptInput").value = "";
  autoGrow();
  const sentComments = comments;
  setComments([]);
  setBusy(true, "Claude is editing…", promptSourceBtn || $("sendBtn"));
  try {
    await runJob(`/api/resumes/${state.id}/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    }, (evt) => {
      progressHandler(evt);
      if (evt.type === "done") {
        state = evt.state;
        render(evt.tex);
        toast(`Done. Now on version ${evt.state.current}.`);
        if (isMobile()) setPanel("pdf");
      }
      if (evt.type === "error") {
        toast(evt.message, "error", 6000);
        addMessage("error", evt.message, null, true, evt.log);
        setComments(sentComments); // keep them so the user can retry
      }
    }, `job:${state.id}`);
  } catch (err) {
    addMessage("error", explainError(err));
    setComments(sentComments);
  } finally {
    setBusy(false);
  }
}

async function recompile() {
  if (busy || !state?.id || !dirty) return;
  setBusy(true, "Compiling…", $("recompileBtn"));
  try {
    const res = await fetch(`/api/resumes/${state.id}/tex`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tex: editor.getValue() }),
    });
    const data = await res.json();
    if (!res.ok) {
      // tectonic reports "error: resume.tex:<line>: <message>"
      const m = (data.log || "").match(/resume\.tex:(\d+):\s*(.*)/);
      if (m) editor.setError(Number(m[1]), m[2]);
      addMessage("error", m ? `LaTeX error on line ${m[1]}: ${m[2]}` : data.error, null, true, m ? null : data.log);
    } else {
      state = data.state;
      render(data.tex);
      toast(`Recompiled. Now on version ${data.state.current}.`);
      if (isMobile()) setPanel("pdf");
    }
  } finally {
    setBusy(false);
  }
}

// ---------- Views: preview, split, LaTeX ----------

function setView(name) {
  $("panes").className = `panes view-${name}`;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  try {
    localStorage.setItem("view", name);
  } catch {}
  if (name !== "pdf") editor.view.requestMeasure();
  if (name === "diff") loadDiff();
  // The PDF pane may have been hidden when the document loaded; render it now if so.
  if ((name === "pdf" || name === "split") && renderedSrc && !$("pdfViewer").querySelector(".pdf-page")) {
    setTimeout(() => renderPdf(renderedSrc), 50);
  }
  ph?.capture("view_changed", { view: name });
}

const currentView = () => $("panes").className.match(/view-(\w+)/)?.[1] || "pdf";

function initView() {
  let saved = null;
  try {
    saved = localStorage.getItem("view");
    const split = localStorage.getItem("split");
    if (split) $("panes").style.setProperty("--split", split);
  } catch {}
  setView(isMobile() ? "pdf" : saved || (window.innerWidth >= 1200 ? "split" : "pdf"));
  syncMobileNav();
}

// Drag the divider to resize the split.
$("divider").addEventListener("pointerdown", (e) => {
  const panes = $("panes");
  const box = panes.getBoundingClientRect();
  $("divider").classList.add("dragging");
  $("divider").setPointerCapture(e.pointerId);
  const move = (ev) => {
    const pct = Math.min(80, Math.max(20, ((ev.clientX - box.left) / box.width) * 100));
    panes.style.setProperty("--split", `${pct.toFixed(1)}%`);
  };
  const up = () => {
    $("divider").classList.remove("dragging");
    $("divider").removeEventListener("pointermove", move);
    try {
      localStorage.setItem("split", panes.style.getPropertyValue("--split"));
    } catch {}
  };
  $("divider").addEventListener("pointermove", move);
  $("divider").addEventListener("pointerup", up, { once: true });
});

// ---------- Source <-> PDF sync (SyncTeX) ----------

async function getSyncMap() {
  if (!state?.current) return null;
  const key = `${state.id}:${state.current}`;
  if (syncCache.key === key) return syncCache.map;
  const res = await fetch(`/api/resumes/${state.id}/v/${state.current}/synctex`);
  if (!res.ok) return null;
  const records = await res.json();
  const lines = savedTex.split("\n");
  const first = lines.findIndex((l) => l.includes("\\begin{document}")) + 1;
  const last = lines.findIndex((l) => l.includes("\\end{document}")) + 1 || lines.length + 1;
  syncCache = { key, map: buildSyncMap(records, first, last) };
  return syncCache.map;
}

// SyncTeX attributes macro arguments to the last line of the macro call, so the
// clicked word may sit a few lines higher (e.g. the employer in \resumeSubheading).
function refineLine(line, word) {
  if (!word) return line;
  const lines = editor.getValue().split("\n");
  const plain = (t) => t.replace(/\\([$%&#_{}])/g, "$1");
  for (let l = line; l >= Math.max(1, line - 4); l--) {
    if (plain(lines[l - 1] || "").includes(word)) return l;
  }
  return line;
}

// Double-click on the PDF: jump to the source line.
async function syncToSource(pageDiv, clientX, clientY, word) {
  const map = await getSyncMap();
  if (!map) return;
  const box = pageDiv.getBoundingClientRect();
  const scale = Number(pageDiv.dataset.scale);
  const line = lineAtPoint(map, Number(pageDiv.dataset.page), (clientX - box.left) / scale, (clientY - box.top) / scale);
  if (line == null) return;
  if (isMobile()) setPanel("tex");
  else if (currentView() === "pdf") setView("split");
  const refined = refineLine(line, word);
  editor.goToLine(refined, word && editor.getValue().split("\n")[refined - 1]?.includes(word) ? word : null);
}

// Double-click in the editor: flash the matching spot on the PDF.
async function syncToPdf(line) {
  const map = await getSyncMap();
  const target = map && boxForLine(map, line);
  if (!target) return;
  if (isMobile()) setPanel("pdf");
  else if (currentView() === "tex") setView("split");
  // Switching from LaTeX-only re-renders the PDF at the new width; wait for it.
  if (!document.querySelector(`.pdf-page[data-page="${target.page}"]`)) await pdfRendered;
  {
    const pageDiv = document.querySelector(`.pdf-page[data-page="${target.page}"]`);
    if (!pageDiv) return;
    const scale = Number(pageDiv.dataset.scale);
    const flash = document.createElement("div");
    flash.className = "sync-flash";
    const left = Math.max(target.left, 0) - 2;
    Object.assign(flash.style, {
      left: `${left * scale}px`,
      top: `${(target.top - 2) * scale}px`,
      width: `${(Math.min(target.right, pageDiv.offsetWidth / scale) - left + 2) * scale}px`,
      height: `${(target.bottom - target.top + 4) * scale}px`,
    });
    pageDiv.querySelector(".hl-layer").append(flash);
    setTimeout(() => flash.remove(), 1700);
    const viewer = $("pdfViewer");
    const top = pageDiv.offsetTop + target.top * scale - viewer.clientHeight / 2;
    viewer.scrollTo({ top: Math.max(top, 0), behavior: "smooth" });
  }
}

// ---------- PDF viewer ----------

// Renders are serialized: a request during a render re-runs once it finishes, so a
// view switch plus a ResizeObserver tick can't abort each other and leave the pane empty.
let rendering = false;
let renderQueued = false;
function renderPdf(src) {
  renderedSrc = src;
  if (rendering) {
    renderQueued = true;
    return pdfRendered;
  }
  rendering = true;
  pdfRendered = doRenderPdf(src).finally(() => {
    rendering = false;
    if (renderQueued) {
      renderQueued = false;
      renderPdf(renderedSrc);
    }
  });
  return pdfRendered;
}

async function doRenderPdf(src) {
  const token = ++renderToken;
  const viewer = $("pdfViewer");
  let doc;
  try {
    doc = await pdfjsLib.getDocument({ url: src }).promise;
  } catch (err) {
    if (token === renderToken) viewer.textContent = `Couldn't load the PDF: ${err.message}`;
    return;
  }
  if (token !== renderToken) return;
  // Hidden pane (another view is active): skip, the ResizeObserver re-renders when shown.
  if (viewer.clientWidth < 100) return;
  const width = Math.min(viewer.clientWidth - 32, 1100);
  const dpr = window.devicePixelRatio || 1;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const scale = width / page.getViewport({ scale: 1 }).width;
    const viewport = page.getViewport({ scale });

    const pageDiv = document.createElement("div");
    pageDiv.className = "pdf-page";
    pageDiv.dataset.page = i;
    pageDiv.dataset.scale = scale;
    pageDiv.style.width = `${viewport.width}px`;
    pageDiv.style.height = `${viewport.height}px`;
    pageDiv.style.setProperty("--total-scale-factor", scale);
    pageDiv.style.setProperty("--scale-factor", scale);

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    await page.render({
      canvasContext: canvas.getContext("2d"),
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    }).promise;

    const hlLayer = document.createElement("div");
    hlLayer.className = "hl-layer";
    const textLayer = document.createElement("div");
    textLayer.className = "textLayer";
    pageDiv.append(canvas, hlLayer, textLayer);
    await new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent(), container: textLayer, viewport }).render();
    if (token !== renderToken) return;
    pages.push(pageDiv);
  }
  viewer.replaceChildren(...pages);
  drawHighlights();
}

// Re-render when the viewer's width changes (window resize, view switch, divider drag).
let resizeTimer;
let lastWidth = 0;
new ResizeObserver(([entry]) => {
  const w = Math.round(entry.contentRect.width);
  if (!w) {
    lastWidth = 0; // hidden; re-render on the next visible width
    return;
  }
  if (Math.abs(w - lastWidth) < 8) return;
  lastWidth = w;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => renderedSrc && renderPdf(renderedSrc), 150);
}).observe($("pdfViewer"));

function drawHighlights() {
  document.querySelectorAll(".hl-layer").forEach((l) => (l.innerHTML = ""));
  // Suggestion boxes (from SyncTeX), numbered S1, S2… and colored by state.
  for (const sg of review?.suggestions || []) {
    if (!sg.box || sg.state === "skipped") continue;
    const pageDiv = document.querySelector(`.pdf-page[data-page="${sg.box.page}"]`);
    if (!pageDiv) continue;
    const scale = Number(pageDiv.dataset.scale);
    const el = document.createElement("div");
    el.className = `hl sg-hl ${sg.state}`;
    el.dataset.sg = sg.id;
    el.title = sg.title;
    const left = Math.max(sg.box.left, 0);
    Object.assign(el.style, {
      left: `${left * scale}px`,
      top: `${(sg.box.top - 1) * scale}px`,
      width: `${(Math.min(sg.box.right, pageDiv.offsetWidth / scale) - left) * scale}px`,
      height: `${(sg.box.bottom - sg.box.top + 2) * scale}px`,
    });
    const n = document.createElement("span");
    n.className = "hl-num sg-num";
    n.textContent = `S${sg.id}`;
    el.append(n);
    pageDiv.querySelector(".hl-layer").append(el);
  }
  comments.forEach((c, i) => {
    const layer = document.querySelector(`.pdf-page[data-page="${c.page}"] .hl-layer`);
    if (!layer) return;
    c.rects.forEach((r, j) => {
      const box = document.createElement("div");
      box.className = "hl";
      Object.assign(box.style, { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });
      if (j === 0) {
        const n = document.createElement("span");
        n.className = "hl-num";
        n.textContent = i + 1;
        box.append(n);
      }
      layer.append(box);
    });
  });
}

// ---------- Highlight comments ----------

function setComments(list) {
  comments = list;
  commentsVersion = list.length ? state?.current ?? null : null;
  const ol = $("commentList");
  ol.innerHTML = "";
  comments.forEach((c, i) => {
    const li = document.createElement("li");
    const quote = document.createElement("div");
    quote.className = "comment-quote";
    quote.textContent = `“${c.quote.length > 90 ? c.quote.slice(0, 90) + "…" : c.quote}”`;
    const note = document.createElement("div");
    note.textContent = c.note;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "link";
    del.textContent = "Remove";
    del.onclick = () => setComments(comments.filter((_, k) => k !== i));
    li.append(quote, note, del);
    ol.append(li);
  });
  $("comments").hidden = !comments.length;
  $("sendBtn").querySelector(".full").textContent = comments.length ? `Apply with ${comments.length} comment${comments.length > 1 ? "s" : ""}` : "Apply";
  $("sendBtn").querySelector(".short").textContent = comments.length ? `↑${comments.length}` : "↑";
  $("sendBtn").title = comments.length ? `Apply with ${comments.length} comment${comments.length > 1 ? "s" : ""}` : "Apply";
  drawHighlights();
}

function captureSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  const pageDiv = startEl?.closest(".pdf-page");
  if (!pageDiv || !$("pdfViewer").contains(pageDiv)) return null;
  const quote = sel.toString().replace(/\s+/g, " ").trim();
  if (!quote) return null;

  const box = pageDiv.getBoundingClientRect();
  const rects = [...range.getClientRects()]
    .filter((r) => r.width > 1 && r.height > 1)
    .map((r) => ({
      x: (r.left - box.left) / box.width,
      y: (r.top - box.top) / box.height,
      w: r.width / box.width,
      h: r.height / box.height,
    }))
    .filter((r) => r.x >= -0.01 && r.y >= -0.01 && r.x <= 1 && r.y <= 1);
  const last = range.getBoundingClientRect();
  return { page: Number(pageDiv.dataset.page), quote, rects, anchor: last };
}

function openPopover(selection) {
  pendingSelection = selection;
  const pop = $("popover");
  const pane = $("pdfPane").getBoundingClientRect();
  $("popoverQuote").textContent = `“${selection.quote.length > 140 ? selection.quote.slice(0, 140) + "…" : selection.quote}”`;
  $("popoverNote").value = "";
  pop.hidden = false;
  const popW = pop.offsetWidth;
  const left = Math.min(Math.max(selection.anchor.left - pane.left, 8), pane.width - popW - 8);
  let top = selection.anchor.bottom - pane.top + 8 + $("pdfPane").offsetTop;
  if (top + pop.offsetHeight > $("pdfPane").offsetTop + pane.height) top = selection.anchor.top - pane.top - pop.offsetHeight - 8 + $("pdfPane").offsetTop;
  pop.style.left = `${left}px`;
  pop.style.top = `${Math.max(top, 8)}px`;
  setTimeout(() => $("popoverNote").focus({ preventScroll: true }), 0);
}

function closePopover() {
  $("popover").hidden = true;
  pendingSelection = null;
}

$("pdfViewer").addEventListener("mouseup", (e) => {
  if (e.detail > 1) return; // double-click is for jumping to the source
  if (busy || (!$("popover").hidden && $("popoverNote").value.trim())) return;
  setTimeout(() => {
    const selection = captureSelection();
    if (selection) openPopover(selection);
  }, 0);
});
$("pdfViewer").addEventListener("click", (e) => {
  const hl = e.target.closest(".sg-hl");
  if (!hl) return;
  const card = document.querySelector(`.sg[data-id="${hl.dataset.sg}"]`);
  if (isMobile()) setPanel("chat");
  card?.scrollIntoView({ behavior: "smooth", block: "center" });
  card?.classList.add("flash");
  setTimeout(() => card?.classList.remove("flash"), 1200);
});
$("pdfViewer").addEventListener("dblclick", (e) => {
  const pageDiv = e.target.closest(".pdf-page");
  if (!pageDiv) return;
  closePopover();
  // The double-click selected the word under the cursor; use it to land precisely.
  const word = (window.getSelection()?.toString() || "").trim().replace(/[.,;:()]+$/, "");
  window.getSelection()?.removeAllRanges();
  syncToSource(pageDiv, e.clientX, e.clientY, word.length >= 2 && !/\s/.test(word) ? word : null);
});
$("popoverCancel").onclick = closePopover;
$("popover").onsubmit = (e) => {
  e.preventDefault();
  const note = $("popoverNote").value.trim();
  if (!note || !pendingSelection) return;
  const { page, quote, rects } = pendingSelection;
  setComments([...comments, { page, quote, rects, note }]);
  ph?.capture("comment_added");
  window.getSelection()?.removeAllRanges();
  closePopover();
  $("hint").hidden = true;
};
$("popoverNote").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("popover").requestSubmit();
  }
  if (e.key === "Escape") closePopover();
};
$("clearComments").onclick = () => setComments([]);

// ---------- Analyze and approve ----------

function escapeHtml(t) {
  return t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

// Word-level diff for short strings (suggestion cards). Simple LCS on word tokens.
function wordDiffHtml(a, b) {
  const A = a.split(/(\s+)/), B = b.split(/(\s+)/);
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  let i = 0, j = 0, out = "";
  const flush = (buf, tag) => (buf.length ? `<${tag}>${escapeHtml(buf.join(""))}</${tag}>` : "");
  let del = [], ins = [];
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      out += flush(del, "del") + flush(ins, "ins"); del = []; ins = [];
      out += escapeHtml(A[i]); i++; j++;
    } else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) { ins.push(B[j]); j++; }
    else { del.push(A[i]); i++; }
  }
  return out + flush(del, "del") + flush(ins, "ins");
}

// Inline word diff for one-line changes; stacked before/after when either side spans lines.
function suggestionDiffHtml(find, replacement) {
  if (!find.includes("\n") && !replacement.includes("\n")) return wordDiffHtml(find, replacement);
  return `<del>${escapeHtml(find.trim())}</del>\n<ins>${escapeHtml(replacement.trim())}</ins>`;
}

async function analyze() {
  if (busy || !state?.id || !state.current) return;
  if (dirty) {
    toast("Recompile your LaTeX edits first (⌘S) so the review covers the latest version.", "error", 5000);
    addMessage("error", "You have unsaved LaTeX edits. Recompile them (⌘S) first so the review covers your latest version.");
    return;
  }
  const focus = $("promptInput").value.trim();
  setBusy(true, "Claude is reviewing the resume…", $("analyzeBtn"));
  try {
    await runJob(`/api/resumes/${state.id}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ focus }),
    }, (evt) => {
      progressHandler(evt);
      if (evt.type === "done") {
        review = makeReview(evt);
        $("promptInput").value = "";
        renderReview();
        locateSuggestions();
        toast(`${evt.suggestions.length} suggestions ready. Accept, edit, or skip each one.`, "done", 5000);
        if (isMobile()) setPanel("chat");
      }
      if (evt.type === "error") {
        toast(evt.message, "error", 6000);
        addMessage("error", evt.message);
      }
    }, `job:${state.id}`);
  } catch (err) {
    addMessage("error", explainError(err));
  } finally {
    setBusy(false);
  }
}

// Map each suggestion's <find> text to a box on the PDF via the SyncTeX map.
async function locateSuggestions() {
  const map = await getSyncMap();
  if (!map || !review) return;
  for (const sg of review.suggestions) {
    const at = savedTex.indexOf(sg.find);
    if (at < 0) continue;
    const first = savedTex.slice(0, at).split("\n").length;
    const last = first + (sg.find.trim().match(/\n/g) || []).length;
    let box = null;
    for (let line = first; line <= last; line++) {
      const b = boxForLine(map, line);
      if (!b) continue;
      if (!box || b.page !== box.page) box = { ...b };
      else {
        box.top = Math.min(box.top, b.top);
        box.bottom = Math.max(box.bottom, b.bottom);
        box.left = Math.min(box.left, b.left);
        box.right = Math.max(box.right, b.right);
      }
    }
    sg.box = box;
  }
  drawHighlights();
}

function renderReview() {
  const panel = $("suggestions");
  if (!review) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const jobName = review.job ? [review.job.company, review.job.title].filter(Boolean).join(" · ") : "";
  $("suggestionsTitle").textContent =
    review.kind === "tailor" ? `Tailored for ${jobName || "the posting"} · v${review.version}` : `${review.suggestions.length} suggestions · version ${review.version}`;
  $("suggestionsSummary").textContent = review.summary;
  renderMatch();
  const list = $("suggestionList");
  list.innerHTML = "";
  for (const sg of review.suggestions) {
    const card = document.createElement("div");
    card.className = `sg ${sg.state}`;
    card.dataset.id = sg.id;
    const replacement = sg.edited ?? sg.replace;
    card.innerHTML = `
      <div class="sg-head"><span class="cat">${escapeHtml(sg.category)}</span><span class="title">${escapeHtml(sg.title)}</span></div>
      <div class="sg-reason">${escapeHtml(sg.reason)}</div>
      <div class="sg-diff">${suggestionDiffHtml(sg.find, replacement)}</div>
      <div class="sg-actions">
        <button type="button" data-act="accept" class="${sg.state === "accepted" ? "on" : ""}">Accept</button>
        <button type="button" data-act="edit">${sg.edited != null ? "Edited" : "Edit"}</button>
        <button type="button" data-act="skip" class="${sg.state === "skipped" ? "on" : ""}">Skip</button>
        <span class="spacer"></span>
        <button type="button" data-act="show" title="Show in the PDF">Show</button>
      </div>`;
    list.append(card);
  }
  drawHighlights();
  const n = review.suggestions.filter((x) => x.state === "accepted").length;
  $("applyBtn").textContent = `Apply ${n}`;
  $("applyBtn").disabled = busy || n === 0;
}

function closeReview() {
  review = null;
  renderReview();
}

// Keyword match meter for a tailoring review. The live score reflects what is accepted
// right now; the ghost segment shows what accepting everything would add.
function renderMatch() {
  const box = $("match");
  if (!review?.keywords?.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const accepted = review.suggestions.filter((x) => x.state === "accepted").map((x) => ({ find: x.find, replace: x.edited ?? x.replace }));
  const all = review.suggestions.filter((x) => x.state !== "skipped").map((x) => ({ find: x.find, replace: x.edited ?? x.replace }));
  const live = scoreKeywords(review.keywords, applyLocal(savedTex, accepted));
  const potential = scoreKeywords(review.keywords, applyLocal(savedTex, all));
  const before = review.before?.pct ?? scoreKeywords(review.keywords, savedTex).pct;
  $("matchPct").innerHTML = `<b>${live.pct}%</b>${potential.pct > live.pct ? ` <span class="muted">→ ${potential.pct}% if you accept the rest</span>` : before !== live.pct ? ` <span class="muted">was ${before}%</span>` : ""}`;
  $("matchFill").style.width = `${live.pct}%`;
  $("matchGhost").style.width = `${Math.max(0, potential.pct - live.pct)}%`;
  $("matchGhost").style.left = `${live.pct}%`;
  const gained = new Set(live.present.filter((k) => !(review.before?.present || []).includes(k)));
  const reachable = new Set(potential.present);
  $("matchWords").innerHTML = review.keywords
    .map((k) => {
      const cls = live.present.includes(k) ? (gained.has(k) ? "kw gained" : "kw present") : reachable.has(k) ? "kw reachable" : "kw missing";
      const tip = cls.endsWith("gained") ? "Added by an accepted suggestion" : cls.endsWith("present") ? "Already in the resume" : cls.endsWith("reachable") ? "Added if you accept the remaining suggestions" : "Not in the resume. Tap to add it, if it's true for you.";
      return `<button type="button" class="${cls}" data-kw="${escapeHtml(k)}" title="${tip}">${escapeHtml(k)}</button>`;
    })
    .join("");
}

// Same find/replace rule as the server, for the live score.
function applyLocal(tex, replacements) {
  let out = tex;
  for (const r of replacements) {
    const first = out.indexOf(r.find);
    if (first >= 0 && out.indexOf(r.find, first + 1) < 0) out = out.slice(0, first) + r.replace + out.slice(first + r.find.length);
  }
  return out;
}

$("matchWords").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-kw]");
  if (!b || !b.classList.contains("missing")) return;
  $("promptInput").value = `If it's true for me, add "${b.dataset.kw}" where it fits best (the Skills section or the most relevant bullet). Don't invent experience.`;
  autoGrow();
  $("promptInput").focus();
});

$("suggestionList").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn || !review) return;
  const card = btn.closest(".sg");
  const sg = review.suggestions.find((x) => x.id === Number(card.dataset.id));
  const act = btn.dataset.act;
  if (act === "accept") sg.state = sg.state === "accepted" ? "pending" : "accepted";
  if (act === "skip") sg.state = sg.state === "skipped" ? "pending" : "skipped";
  if (act === "show") {
    // Jump the PDF to the first line of the text this suggestion changes.
    const line = savedTex.slice(0, savedTex.indexOf(sg.find)).split("\n").length;
    if (isMobile()) setPanel("pdf");
    else if (currentView() === "diff") setView("split");
    syncToPdf(line);
    return;
  }
  if (act === "edit") {
    const existing = card.querySelector("textarea");
    if (existing) {
      sg.edited = existing.value;
      if (sg.edited === sg.replace) sg.edited = null;
      sg.state = "accepted";
    } else {
      const ta = document.createElement("textarea");
      ta.rows = 3;
      ta.value = sg.edited ?? sg.replace;
      card.querySelector(".sg-diff").after(ta);
      btn.textContent = "Save";
      ta.focus();
      return;
    }
  }
  renderReview();
});
$("acceptAll").onclick = () => { review?.suggestions.forEach((x) => (x.state = "accepted")); renderReview(); };
$("skipAll").onclick = () => { review?.suggestions.forEach((x) => (x.state = "skipped")); renderReview(); };
$("closeSuggestions").onclick = closeReview;
$("analyzeBtn").onclick = analyze;

$("applyBtn").onclick = async () => {
  if (busy || !review) return;
  const accepted = review.suggestions.filter((x) => x.state === "accepted");
  if (!accepted.length) return;
  setBusy(true, "Applying suggestions…", $("applyBtn"));
  const snapshot = review;
  try {
    await runJob(`/api/resumes/${state.id}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: review.version,
        replacements: accepted.map((x) => ({ find: x.find, replace: x.edited ?? x.replace, title: x.title })),
      }),
    }, (evt) => {
      progressHandler(evt);
      if (evt.type === "done") {
        closeReview();
        state = evt.state;
        render(evt.tex);
        if (evt.skipped) addMessage("error", `${evt.skipped} suggestion${evt.skipped > 1 ? "s" : ""} no longer matched and were skipped.`);
        const n = accepted.length - (evt.skipped || 0);
        toast(
          evt.keywords
            ? `Applied ${n}. Keyword match is now ${evt.keywords.pct}%. Version ${evt.state.current}.`
            : `Applied ${n} suggestion${n === 1 ? "" : "s"}. Now on version ${evt.state.current}. Showing the changes.`,
          "done",
          5000
        );
        if (isMobile()) setPanel("diff");
        else setView("diff");
      }
      if (evt.type === "error") {
        toast(evt.message, "error", 6000);
        addMessage("error", evt.message, null, true, evt.log);
        review = snapshot;
        renderReview();
      }
    }, `job:${state.id}`);
  } catch (err) {
    addMessage("error", explainError(err));
    review = snapshot;
    renderReview();
  } finally {
    setBusy(false);
  }
};

// ---------- Tailor to a job ----------

function openTailor() {
  if (busy || !state?.id || !state.current) return;
  $("ats").hidden = true;
  $("tailor").hidden = false;
  $("tailorHint").textContent = "";
  $("jobInput").focus();
}
$("tailorBtn").onclick = openTailor;
$("closeTailor").onclick = () => ($("tailor").hidden = true);
$("jobInput").addEventListener("input", () => {
  const v = $("jobInput").value.trim();
  $("tailorHint").textContent = /^https?:\/\/\S+$/.test(v) ? "Link detected: the posting will be fetched" : v ? `${v.split(/\s+/).length} words` : "";
});
$("tailor").onsubmit = async (e) => {
  e.preventDefault();
  if (busy || !state?.id) return;
  if (dirty) {
    toast("Recompile your LaTeX edits first (⌘S) so the tailoring covers the latest version.", "error", 5000);
    return;
  }
  const v = $("jobInput").value.trim();
  if (!v) return toast("Paste the job description or a link first.", "error", 4000);
  const isUrl = /^https?:\/\/\S+$/.test(v);
  addMessage("user", isUrl ? `Tailor to: ${v}` : `Tailor to a pasted job description (${v.split(/\s+/).length} words)`);
  setBusy(true, isUrl ? "Reading the job posting…" : "Claude is matching the resume to the posting…", $("tailorGo"));
  try {
    await runJob(`/api/resumes/${state.id}/tailor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(isUrl ? { url: v } : { job: v }),
    }, (evt) => {
      progressHandler(evt);
      if (evt.type === "done") {
        $("tailor").hidden = true;
        $("jobInput").value = "";
        review = makeReview(evt);
        // The server appended two chat messages; show them without a reload.
        for (const m of evt.messages || []) addMessage(m.role, m.text, m.version);
        renderReview();
        locateSuggestions();
        toast(`Keyword match ${evt.before.pct}% → up to ${evt.after.pct}%. ${evt.suggestions.length} suggestions ready.`, "done", 6000);
        if (isMobile()) setPanel("chat");
      }
      if (evt.type === "error") {
        toast(evt.message, "error", 7000);
        addMessage("error", evt.message);
      }
    }, `job:${state.id}`);
  } catch (err) {
    addMessage("error", explainError(err));
  } finally {
    setBusy(false);
  }
};

// ---------- Fit to one page ----------

$("fitBtn").onclick = async () => {
  if (busy || !state?.id || !state.current) return;
  if (dirty) return toast("Recompile your LaTeX edits first (⌘S).", "error", 5000);
  addMessage("user", "Fit to one page");
  setBusy(true, "Measuring the overflow…", $("fitBtn"));
  try {
    await runJob(`/api/resumes/${state.id}/fit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, (evt) => {
      progressHandler(evt);
      if (evt.type === "done") {
        if (evt.alreadyFits) {
          $("messages").lastElementChild?.remove();
          toast("Already one page.", "done", 3000);
          return;
        }
        state = evt.state;
        render(evt.tex);
        toast(evt.fits ? `Fits on one page now. Version ${evt.state.current}.` : `Still ${evt.pages} pages after three passes. See the chat for what to cut.`, evt.fits ? "done" : "error", 6000);
        if (isMobile()) setPanel("pdf");
      }
      if (evt.type === "error") {
        toast(evt.message, "error", 6000);
        addMessage("error", evt.message, null, true, evt.log);
      }
    }, `job:${state.id}`);
  } catch (err) {
    addMessage("error", explainError(err));
  } finally {
    setBusy(false);
  }
};

// ---------- ATS check ----------

let atsResult = null; // { version, ...result }
async function fetchAts(version) {
  const res = await fetch(`/api/resumes/${state.id}/v/${version}/ats`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "ATS check failed.");
  return { version, ...(await res.json()) };
}

// The chip shows the score for the version on screen, so problems are visible without opening the panel.
let atsBadgeToken = 0;
async function refreshAtsBadge() {
  const token = ++atsBadgeToken;
  const v = state?.current;
  if (!state?.id || !v) return;
  try {
    const r = atsResult?.version === v && atsResult.resumeId === state.id ? atsResult : { ...(await fetchAts(v)), resumeId: state.id };
    if (token !== atsBadgeToken) return;
    atsResult = r;
    const bad = r.checks.filter((c) => c.status === "fail").length;
    const warn = r.checks.filter((c) => c.status === "warn").length;
    $("atsBtn").textContent = bad ? `ATS ${r.passed}/${r.total} ✗` : warn ? `ATS ${r.passed}/${r.total} ⚠` : `ATS ${r.passed}/${r.total} ✓`;
    $("atsBtn").className = bad ? "chip-bad" : warn ? "chip-warn" : "chip-good";
    if (!$("ats").hidden) renderAts();
  } catch {
    $("atsBtn").textContent = "ATS check";
    $("atsBtn").className = "";
  }
}

const ATS_ICON = { pass: "✅", warn: "⚠️", fail: "❌", info: "ℹ️" };
function renderAts() {
  const r = atsResult;
  if (!r) return;
  $("ats").hidden = false;
  $("tailor").hidden = true;
  $("atsTitle").textContent = `ATS check · ${r.passed}/${r.total} · v${r.version}`;
  const fails = r.checks.filter((c) => c.status === "fail").length;
  const warns = r.checks.filter((c) => c.status === "warn").length;
  $("atsSummary").textContent = fails
    ? "A parser would lose part of this resume. Fix the red items first."
    : warns
      ? "Parses, with a few things worth fixing."
      : "Parses cleanly: text, order, contact details, headings, and dates all read the way an applicant tracking system expects.";
  $("atsList").innerHTML = r.checks
    .map(
      (c) => `<li class="ats-${c.status}"><span class="ats-ico">${ATS_ICON[c.status]}</span><div><div class="ats-label">${escapeHtml(c.label)}</div><div class="ats-detail">${escapeHtml(c.detail)}</div>${
        c.fix ? `<button type="button" class="btn small ats-fix" data-fix="${c.fix}">${escapeHtml(c.fixLabel || "Fix")}</button>` : ""
      }</div></li>`
    )
    .join("");
}
$("atsBtn").onclick = async () => {
  if (!state?.id || !state.current) return;
  if (!$("ats").hidden) return ($("ats").hidden = true);
  if (dirty) toast("Checking the last compiled version; recompile (⌘S) to check your edits.", "error", 4000);
  $("atsBtn").classList.add("btn-busy");
  try {
    if (!(atsResult?.version === state.current && atsResult.resumeId === state.id)) atsResult = { ...(await fetchAts(state.current)), resumeId: state.id };
    renderAts();
    $("ats").scrollIntoView({ block: "nearest" });
  } catch (err) {
    toast(err.message, "error", 5000);
  } finally {
    $("atsBtn").classList.remove("btn-busy");
    refreshAtsBadge();
  }
};
$("closeAts").onclick = () => ($("ats").hidden = true);
$("atsList").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-fix]");
  if (!b || busy || !state?.id) return;
  if (dirty) return toast("Recompile your LaTeX edits first (⌘S).", "error", 5000);
  addMessage("user", "ATS fix: repeat the employer on each role");
  setBusy(true, "Rewriting the role headings…", b);
  try {
    await runJob(`/api/resumes/${state.id}/ats-fix`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fix: b.dataset.fix }) }, (evt) => {
      progressHandler(evt);
      if (evt.type === "done") {
        state = evt.state;
        render(evt.tex);
        toast(`Fixed ${evt.changed} role${evt.changed > 1 ? "s" : ""}. Version ${evt.state.current}.`, "done", 5000);
        $("ats").hidden = true;
        if (isMobile()) setPanel("pdf");
      }
      if (evt.type === "error") {
        toast(evt.message, "error", 6000);
        addMessage("error", evt.message, null, true, evt.log);
      }
    }, `job:${state.id}`);
  } catch (err) {
    addMessage("error", explainError(err));
  } finally {
    setBusy(false);
  }
});

// ---------- Changes (diff) view ----------

let diffForVersion = null;
function fillDiffSelectors() {
  if (!state) return;
  const versionChanged = diffForVersion !== state.current;
  diffForVersion = state.current;
  for (const id of ["diffFrom", "diffTo"]) {
    const sel = $(id);
    const prev = sel.value;
    sel.innerHTML = "";
    for (const v of state.versions) sel.append(new Option(`v${v.n} · ${v.label}`, v.n));
    sel.value = prev && state.versions.some((v) => String(v.n) === prev) ? prev : "";
  }
  const cur = state.current;
  $("diffTo").value = String(cur);
  if (versionChanged || !$("diffFrom").value || Number($("diffFrom").value) >= cur) $("diffFrom").value = String(Math.max(1, cur - 1));
}

async function loadDiff() {
  if (!state?.id || !state.current) return;
  const from = Number($("diffFrom").value), to = Number($("diffTo").value);
  const body = $("diffBody");
  if (from === to) {
    body.innerHTML = `<div class="diff-empty">Pick two different versions.</div>`;
    $("diffStats").textContent = "";
    return;
  }
  const res = await fetch(`/api/resumes/${state.id}/diff?from=${from}&to=${to}`);
  const data = await res.json();
  if (!res.ok) {
    body.innerHTML = `<div class="diff-empty">${escapeHtml(data.error || "Couldn't load the diff.")}</div>`;
    return;
  }
  let added = 0, removed = 0, changed = 0, html = "";
  const CONTEXT = 2;
  for (const h of data.hunks) {
    if (h.type === "same") {
      const lines = h.value.replace(/\n$/, "").split("\n");
      if (lines.length <= CONTEXT * 2 + 1) html += `<span class="ctx">${escapeHtml(lines.join("\n"))}\n</span>`;
      else {
        html += `<span class="ctx">${escapeHtml(lines.slice(0, CONTEXT).join("\n"))}\n</span>`;
        html += `<div class="fold">… ${lines.length - CONTEXT * 2} unchanged lines …</div>`;
        html += `<span class="ctx">${escapeHtml(lines.slice(-CONTEXT).join("\n"))}\n</span>`;
      }
    } else if (h.type === "changed") {
      changed++;
      html += `<span class="ch">${h.words.map((w) => (w.added ? `<ins>${escapeHtml(w.value)}</ins>` : w.removed ? `<del>${escapeHtml(w.value)}</del>` : escapeHtml(w.value))).join("")}</span>`;
    } else if (h.type === "removed") {
      removed++;
      html += `<span class="rm">${escapeHtml(h.old)}</span>`;
    } else {
      added++;
      html += `<span class="ad">${escapeHtml(h.new)}</span>`;
    }
  }
  if (!added && !removed && !changed) html = `<div class="diff-empty">No differences between v${from} and v${to}.</div>`;
  body.innerHTML = html;
  $("diffStats").textContent = `${changed} changed · ${added} added · ${removed} removed`;
}
$("diffFrom").onchange = loadDiff;
$("diffTo").onchange = loadDiff;

// ---------- Mobile: one panel at a time ----------

const mobileQuery = window.matchMedia("(max-width: 820px)");
const isMobile = () => mobileQuery.matches;

function setPanel(name) {
  // name: chat | pdf | tex | diff
  $("editorView").classList.toggle("panel-chat", name === "chat");
  document.querySelectorAll("#mobileNav button").forEach((b) => b.classList.toggle("active", b.dataset.panel === name));
  if (name !== "chat") setView(name);
  $("mobileNav").dataset.panel = name;
  closePopover();
}

const currentPanel = () => $("mobileNav").dataset.panel || "chat";

$("mobileNav").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-panel]");
  if (b) setPanel(b.dataset.panel);
});

function syncMobileNav() {
  $("mobileNav").hidden = !isMobile() || $("editorView").hidden;
  if (isMobile()) {
    if (currentView() === "split") setView("pdf");
    if (!$("editorView").classList.contains("panel-chat") && currentPanel() === "chat") setPanel("chat");
  } else {
    $("editorView").classList.add("panel-chat"); // both sections show on desktop; class is harmless there
  }
}
mobileQuery.addEventListener("change", syncMobileNav);

// On a phone, selection happens by touch: open the comment box when a selection settles.
let selTimer;
document.addEventListener("selectionchange", () => {
  if (!isMobile() || busy || currentPanel() !== "pdf") return;
  clearTimeout(selTimer);
  selTimer = setTimeout(() => {
    if (!$("popover").hidden) return;
    const selection = captureSelection();
    if (selection) openPopover(selection);
  }, 600);
});

// ---------- Mobile bottom sheet (actions + versions) ----------

// The menu shows whenever there is something to put in it: resume actions, or Sign out.
let authed = false;
function syncMenu() {
  $("menuBtn").hidden = !(state?.id || authed);
}
function openSheet() {
  const open = Boolean(state.id);
  for (const id of ["sheetPdf", "sheetTex", "sheetRename", "sheetVersionsTitle", "sheetVersions"]) $(id).hidden = !open;
  $("sheetLogout").hidden = !authed;
  $("sheet").hidden = false;
  $("sheetBackdrop").hidden = false;
  $("sheetPdf").onclick = () => { closeSheet(); $("dlPdf").click(); };
  $("sheetTex").onclick = () => { closeSheet(); $("dlTex").click(); };
  $("sheetRename").onclick = () => { closeSheet(); $("renameBtn").click(); };
  $("sheetLogout").onclick = () => { closeSheet(); $("logoutBtn").click(); };
}
function closeSheet() {
  $("sheet").hidden = true;
  $("sheetBackdrop").hidden = true;
}
$("menuBtn").onclick = openSheet;
$("sheetBackdrop").onclick = closeSheet;

// The composer grows with its content (messaging-app style) up to a few lines.
function autoGrow() {
  const ta = $("promptInput");
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
}
$("promptInput").addEventListener("input", autoGrow);

// ---------- First-run guidance ----------

// A short checklist in the chat after the first conversion, until the person has used the
// main features once (or dismisses it). Stored per browser.
const onboardKey = "re:onboarded";
const onboarded = () => { try { return localStorage.getItem(onboardKey) === "1"; } catch { return true; } };
const markOnboarded = () => { try { localStorage.setItem(onboardKey, "1"); } catch {} document.querySelector(".msg.onboard")?.remove(); };
function showNextSteps() {
  if (onboarded() || document.querySelector(".msg.onboard")) return;
  const el = document.createElement("div");
  el.className = "msg assistant onboard";
  el.innerHTML = `<b>Your resume is rebuilt. Three things worth doing now:</b>
    <ol>
      <li><button type="button" class="link" data-go="ats">Run the ATS check</button> to see how a parser reads this PDF. Free, and any problem has a one-click fix.</li>
      <li><button type="button" class="link" data-go="tailor">Tailor it to a job</button> by pasting a posting. You get a keyword match score and truthful rewording to accept or skip.</li>
      <li><button type="button" class="link" data-go="pdf">Download the PDF</button> or highlight any text on the preview to ask for a change.</li>
    </ol>
    <button type="button" class="link muted" data-go="dismiss">Got it, hide this</button>`;
  el.addEventListener("click", (e) => {
    const go = e.target.closest("button[data-go]")?.dataset.go;
    if (!go) return;
    if (go === "ats") $("atsBtn").click();
    if (go === "tailor") openTailor();
    if (go === "pdf") $("dlPdf").click();
    if (go === "dismiss") markOnboarded();
  });
  $("messages").append(el);
  $("messages").scrollTop = $("messages").scrollHeight;
}
for (const id of ["tailorGo", "dlPdf", "sheetPdf"]) $(id).addEventListener("click", () => { if (!onboarded()) setTimeout(markOnboarded, 500); });

// ---------- Plan and limits (only when the server reports a plan) ----------

let planShown = false;
function showPlan(plan) {
  const bar = $("planBar");
  planShown = Boolean(plan);
  bar.hidden = !plan;
  if (!plan) return;
  const parts = [plan.label || plan.plan];
  if (plan.limit != null) parts.push(`${plan.remaining} of ${plan.limit} AI actions left${plan.resetsAt ? ` until ${new Date(plan.resetsAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}`);
  else if (plan.expiresAt) parts.push(`until ${new Date(plan.expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`);
  $("planText").textContent = parts.join(" · ");
  const link = $("planLink");
  if (plan.upgradeUrl) {
    link.hidden = false;
    link.textContent = plan.remaining === 0 ? "Upgrade to continue" : "Upgrade";
    link.href = plan.upgradeUrl;
    bar.classList.toggle("plan-out", plan.remaining === 0);
  } else if (plan.portalUrl) {
    link.hidden = false;
    link.textContent = "Manage";
    link.href = plan.portalUrl;
    bar.classList.remove("plan-out");
  } else link.hidden = true;
}
async function refreshPlan() {
  try {
    const me = await fetch("/api/me").then((r) => r.json());
    showPlan(me.plan);
  } catch {}
}
if (new URLSearchParams(location.search).get("billing") === "success") {
  history.replaceState(null, "", location.pathname + location.hash);
  toast("Thanks! Your plan is active.", "done", 6000);
}

// ---------- Analytics (PostHog, only when the server has a key) ----------

let ph = null;
function initAnalytics({ key, host }, userId) {
  const s = document.createElement("script");
  s.src = `${host}/static/array.js`;
  s.onload = () => {
    window.posthog.init(key, { api_host: host, person_profiles: "identified_only", capture_pageview: true, autocapture: false });
    window.posthog.identify(userId);
    ph = window.posthog;
  };
  document.head.append(s);
}

// ---------- Wiring ----------

let chosenFile = null;
function chooseFile(file) {
  if (!file || !/\.pdf$/i.test(file.name)) return;
  chosenFile = file;
  $("dropText").textContent = file.name;
  $("dropzone").classList.add("has-file");
  $("convertBtn").disabled = false;
}

$("pdfInput").onchange = (e) => chooseFile(e.target.files[0]);
const dz = $("dropzone");
dz.ondragover = (e) => { e.preventDefault(); dz.classList.add("over"); };
dz.ondragleave = () => dz.classList.remove("over");
dz.ondrop = (e) => {
  e.preventDefault();
  dz.classList.remove("over");
  chooseFile(e.dataTransfer.files[0]);
};
$("uploadForm").onsubmit = (e) => {
  e.preventDefault();
  if (chosenFile) convert(chosenFile);
};

$("promptForm").onsubmit = (e) => {
  e.preventDefault();
  const p = $("promptInput").value.trim();
  if (p || comments.length) applyPrompt(p);
  else toast("Type a change first, or highlight text on the PDF to comment on it.", "error", 4000);
};
$("promptInput").onkeydown = (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("promptForm").requestSubmit();
};
$("chips").onclick = (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.prompt) applyPrompt(b.dataset.prompt, b);
  if (b.dataset.fill) {
    $("promptInput").value = b.dataset.fill;
    $("promptInput").focus();
  }
};
document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => setView(t.dataset.view)));
$("recompileBtn").onclick = recompile;
$("renameBtn").onclick = async () => {
  if (!state?.id || busy) return;
  const name = window.prompt("Rename this resume", state.name);
  if (name == null || name.trim() === state.name) return;
  const res = await fetch(`/api/resumes/${state.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (!res.ok) return addMessage("error", data.error);
  state.name = data.name;
  await refreshPicker(state.id);
  ph?.capture("resume_renamed");
};
$("resumePicker").onchange = (e) => {
  if (!confirmDiscard()) {
    e.target.value = state?.id || "";
    return;
  }
  e.target.value ? openResume(e.target.value) : newResume();
};
// Follow #<id> links and back/forward between resumes.
window.addEventListener("hashchange", () => {
  const id = location.hash.slice(1);
  if (id === (state?.id || "") || busy) return;
  if (!confirmDiscard()) {
    history.replaceState(null, "", state?.id ? `#${state.id}` : location.pathname);
    return;
  }
  $("resumePicker").value = id;
  id ? openResume(id) : newResume();
});
window.addEventListener("beforeunload", (e) => {
  if (dirty) e.preventDefault();
});

// ---------- Boot ----------

(async function boot() {
  initView();
  const health = await fetch("/api/health").then((r) => r.json()).catch(() => null);
  const problems = [];
  if (health?.missingTools?.length) problems.push(`Missing on the server: ${health.missingTools.join(", ")}. Run: brew install tectonic poppler`);
  if (health?.auth) {
    authed = true;
    $("logoutBtn").hidden = false;
    syncMenu();
    fetch("/api/me").then((r) => r.json()).then((me) => {
      $("logoutBtn").textContent = `Sign out (${me.email})`;
      if (me.analytics) initAnalytics(me.analytics, me.id);
      showPlan(me.plan);
      try {
        const want = sessionStorage.getItem("wantPlan");
        if (want && me.plan?.plan === "free") { sessionStorage.removeItem("wantPlan"); location.href = `/api/billing/checkout?plan=${encodeURIComponent(want)}`; }
      } catch {}
    }).catch(() => {});
    $("logoutBtn").onclick = async () => {
      await fetch("/api/logout", { method: "POST" });
      location.replace("/login.html");
    };
  }
  if (problems.length) {
    $("banner").textContent = problems.join(" ");
    $("banner").hidden = false;
  }
  const id = location.hash.slice(1);
  await refreshPicker(id);
  if (id) openResume(id);
  else {
    newResume();
    resumePendingConvert();
  }
  watchForUpdates();
})();

// c. Self-update: when a new build is deployed, reload (after any running job finishes).
let updatePending = false;
function watchForUpdates() {
  if (!V) return;
  const check = async () => {
    try {
      const { id } = await fetch("/api/build", { cache: "no-store" }).then((r) => r.json());
      if (id && id !== V) {
        updatePending = true;
        if (!busy) location.reload();
      }
    } catch {}
  };
  setInterval(check, 60_000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && check());
}
