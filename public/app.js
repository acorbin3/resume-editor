import * as pdfjsLib from "/vendor/pdfjs/pdf.min.mjs";
import { createEditor } from "/vendor/editor.js";
import { buildSyncMap, lineAtPoint, boxForLine } from "/syncmap.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";

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

function setBusy(on, text = "Working…") {
  busy = on;
  $("busy").hidden = !on;
  $("busyText").textContent = text;
  $("sendBtn").disabled = on;
  $("recompileBtn").disabled = on || !dirty;
  clearInterval(timerHandle);
  if (on) {
    const start = Date.now();
    $("busyTimer").textContent = "";
    timerHandle = setInterval(() => {
      $("busyTimer").textContent = `${Math.round((Date.now() - start) / 1000)}s`;
    }, 1000);
  }
}

function showView(name) {
  $("uploadView").hidden = name !== "upload";
  $("editorView").hidden = name !== "editor";
}

// Read a newline-delimited JSON stream, calling onEvent for each event.
async function streamJson(res, onEvent) {
  if (!res.ok && !res.headers.get("content-type")?.includes("ndjson")) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
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

function progressHandler(evt) {
  if (evt.type === "status") $("busyText").textContent = evt.message;
  if (evt.type === "writing") $("busyText").textContent = `Claude is writing… (${evt.chars.toLocaleString()} chars)`;
}

// ---------- Rendering ----------

function render(tex) {
  if (!state) return;
  history.replaceState(null, "", `#${state.id}`);
  const v = state.current;
  const ver = state.versions.find((x) => x.n === v);

  $("downloads").hidden = !v;
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
  }
  if (tex !== undefined) {
    savedTex = tex;
    editor.setValue(tex);
    setDirty(false);
  }

  const msgs = $("messages");
  msgs.innerHTML = "";
  for (const m of state.messages) addMessage(m.role, m.text, m.version, false);
  msgs.scrollTop = msgs.scrollHeight;

  const list = $("versionList");
  list.innerHTML = "";
  for (const x of [...state.versions].reverse()) {
    const li = document.createElement("li");
    li.className = x.n === v ? "current" : "";
    const b = document.createElement("button");
    b.textContent = `v${x.n} · ${x.label}`;
    b.title = x.label;
    b.onclick = () => selectVersion(x.n);
    li.append(b);
    list.append(li);
  }
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
}

function newResume() {
  state = null;
  history.replaceState(null, "", location.pathname);
  $("resumePicker").value = "";
  $("downloads").hidden = true;
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
  $("pdfViewer").innerHTML = "";
  renderedSrc = null;
  setComments([]);
  $("pageInfo").textContent = "";
  $("versionList").innerHTML = "";
  showView("editor");
  addMessage("user", `Uploaded ${file.name}`);
  setBusy(true, "Uploading…");

  try {
    const res = await fetch("/api/resumes", { method: "POST", body: form });
    await streamJson(res, (evt) => {
      progressHandler(evt);
      if (evt.type === "created") {
        state.id = evt.id;
        history.replaceState(null, "", `#${evt.id}`);
      }
      if (evt.type === "done") {
        state = evt.state;
        render(evt.tex);
      }
      if (evt.type === "error") {
        addMessage("error", `${evt.message}\nPick “+ New resume” above to try again.`, null, true, evt.log);
        state.id = null;
        history.replaceState(null, "", location.pathname);
      }
    });
  } catch (err) {
    addMessage("error", err.message);
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

async function applyPrompt(typed) {
  if (busy || !state?.id || !state.current) return;
  if (dirty) {
    addMessage("error", "You have unsaved LaTeX edits. Recompile them (⌘S) first so Claude works from your latest version.");
    return;
  }
  const prompt = composePrompt(typed);
  if (!prompt) return;
  addMessage("user", prompt);
  $("promptInput").value = "";
  const sentComments = comments;
  setComments([]);
  setBusy(true, "Claude is editing…");
  try {
    const res = await fetch(`/api/resumes/${state.id}/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    await streamJson(res, (evt) => {
      progressHandler(evt);
      if (evt.type === "done") {
        state = evt.state;
        render(evt.tex);
      }
      if (evt.type === "error") {
        addMessage("error", evt.message, null, true, evt.log);
        setComments(sentComments); // keep them so the user can retry
      }
    });
  } catch (err) {
    addMessage("error", err.message);
    setComments(sentComments);
  } finally {
    setBusy(false);
  }
}

async function recompile() {
  if (busy || !state?.id || !dirty) return;
  setBusy(true, "Compiling…");
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
}

const currentView = () => $("panes").className.match(/view-(\w+)/)?.[1] || "pdf";

function initView() {
  let saved = null;
  try {
    saved = localStorage.getItem("view");
    const split = localStorage.getItem("split");
    if (split) $("panes").style.setProperty("--split", split);
  } catch {}
  setView(saved || (window.innerWidth >= 1200 ? "split" : "pdf"));
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
  if (currentView() === "pdf") setView("split");
  const refined = refineLine(line, word);
  editor.goToLine(refined, word && editor.getValue().split("\n")[refined - 1]?.includes(word) ? word : null);
}

// Double-click in the editor: flash the matching spot on the PDF.
async function syncToPdf(line) {
  const map = await getSyncMap();
  const target = map && boxForLine(map, line);
  if (!target) return;
  if (currentView() === "tex") setView("split");
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

function renderPdf(src) {
  pdfRendered = doRenderPdf(src);
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
  if (!w || Math.abs(w - lastWidth) < 8) return;
  lastWidth = w;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => renderedSrc && renderPdf(renderedSrc), 150);
}).observe($("pdfViewer"));

function drawHighlights() {
  document.querySelectorAll(".hl-layer").forEach((l) => (l.innerHTML = ""));
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
  $("sendBtn").textContent = comments.length ? `Apply with ${comments.length} comment${comments.length > 1 ? "s" : ""}` : "Apply";
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
};
$("promptInput").onkeydown = (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("promptForm").requestSubmit();
};
$("chips").onclick = (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.prompt) applyPrompt(b.dataset.prompt);
  if (b.dataset.fill) {
    $("promptInput").value = b.dataset.fill;
    $("promptInput").focus();
  }
};
document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => setView(t.dataset.view)));
$("recompileBtn").onclick = recompile;
$("resumePicker").onchange = (e) => {
  if (!confirmDiscard()) {
    e.target.value = state?.id || "";
    return;
  }
  e.target.value ? openResume(e.target.value) : newResume();
};
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
    $("logoutBtn").hidden = false;
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
  else newResume();
})();
