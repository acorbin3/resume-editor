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
  syncMobileNav();
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
  $("renameBtn").hidden = true;
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
        if (isMobile()) setPanel("pdf");
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
        if (isMobile()) setPanel("pdf");
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
    addMessage("error", "You have unsaved LaTeX edits. Recompile them (⌘S) first so the review covers your latest version.");
    return;
  }
  const focus = $("promptInput").value.trim();
  setBusy(true, "Claude is reviewing the resume…");
  try {
    const res = await fetch(`/api/resumes/${state.id}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ focus }),
    });
    await streamJson(res, (evt) => {
      progressHandler(evt);
      if (evt.type === "done") {
        review = {
          version: evt.version,
          summary: evt.summary,
          suggestions: evt.suggestions.map((sg) => ({ ...sg, state: "pending", edited: null })),
        };
        $("promptInput").value = "";
        renderReview();
        locateSuggestions();
      }
      if (evt.type === "error") addMessage("error", evt.message);
    });
  } catch (err) {
    addMessage("error", err.message);
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
  $("suggestionsTitle").textContent = `${review.suggestions.length} suggestions · version ${review.version}`;
  $("suggestionsSummary").textContent = review.summary;
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
  setBusy(true, "Applying suggestions…");
  const snapshot = review;
  try {
    const res = await fetch(`/api/resumes/${state.id}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: review.version,
        replacements: accepted.map((x) => ({ find: x.find, replace: x.edited ?? x.replace, title: x.title })),
      }),
    });
    await streamJson(res, (evt) => {
      progressHandler(evt);
      if (evt.type === "done") {
        closeReview();
        state = evt.state;
        render(evt.tex);
        if (evt.skipped) addMessage("error", `${evt.skipped} suggestion${evt.skipped > 1 ? "s" : ""} no longer matched and were skipped.`);
        if (isMobile()) setPanel("diff");
        else setView("diff");
      }
      if (evt.type === "error") {
        addMessage("error", evt.message, null, true, evt.log);
        review = snapshot;
        renderReview();
      }
    });
  } catch (err) {
    addMessage("error", err.message);
    review = snapshot;
    renderReview();
  } finally {
    setBusy(false);
  }
};

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
    $("logoutBtn").hidden = false;
    fetch("/api/me").then((r) => r.json()).then((me) => {
      $("logoutBtn").textContent = `Sign out (${me.email})`;
      if (me.analytics) initAnalytics(me.analytics, me.id);
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
  else newResume();
})();
