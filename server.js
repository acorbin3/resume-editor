import express from "express";
import multer from "multer";
import Anthropic from "@anthropic-ai/sdk";
import { compileTex, checkTools, pdfToText, parseSynctex } from "./lib/latex.js";
import { BACKEND, textIsUsable, convertPdf, editTex, fixCompileRequest, fitPageRequest } from "./lib/claude.js";
import * as store from "./lib/store.js";
import { authEnabled, requireAuth, login, logout } from "./lib/auth.js";

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const MAX_FIX_ATTEMPTS = 2;

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.post("/api/login", login);
app.use(requireAuth);
app.post("/api/logout", logout);
app.use(express.static("public"));
app.use("/vendor/pdfjs", express.static("node_modules/pdfjs-dist/build"));
app.use("/vendor/pdfjs-web", express.static("node_modules/pdfjs-dist/web"));
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } });

// Long-running calls stream newline-delimited JSON progress events, ending in "done" or "error".
function ndjson(res) {
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();
  return (evt) => res.write(JSON.stringify(evt) + "\n");
}

function errorMessage(err) {
  if (/authentication method/i.test(err.message || "")) return "No Anthropic API key found. Set ANTHROPIC_API_KEY in .env and restart the server.";
  if (err instanceof Anthropic.AuthenticationError) return "Anthropic API key is missing or invalid. Set ANTHROPIC_API_KEY in .env.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Anthropic API. Wait a moment and try again.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Anthropic API.";
  if (err instanceof Anthropic.APIError) return `Anthropic API error: ${err.message}`;
  return err.message || String(err);
}

function publicState(meta) {
  return { id: meta.id, name: meta.name, current: meta.current, versions: meta.versions, messages: meta.messages };
}

// Compile, letting Claude repair compile errors and (optionally) trim to one page.
async function compileWithRepair(tex, { send, history, source, fitOnePage }) {
  let fitTried = false;
  for (let attempt = 0; ; attempt++) {
    send({ type: "status", message: "Compiling PDF…" });
    const result = await compileTex(tex);
    if (!result.ok) {
      if (attempt >= MAX_FIX_ATTEMPTS) {
        const err = new Error("LaTeX failed to compile.");
        err.log = result.log;
        throw err;
      }
      send({ type: "status", message: "Compile error, asking Claude to fix it…" });
      ({ tex } = await editTex(tex, fixCompileRequest(result.log), { history, onProgress: send }));
      continue;
    }
    if (fitOnePage && result.pages > 1 && !fitTried) {
      fitTried = true;
      send({ type: "status", message: `Spilled to ${result.pages} pages, tightening to one…` });
      ({ tex } = await editTex(tex, fitPageRequest(result.pages), { history, source, onProgress: send }));
      attempt = -1; // fresh compile-fix budget for the tightened version
      continue;
    }
    return { tex, ...result };
  }
}

app.get("/api/health", async (_req, res) => {
  res.json({
    missingTools: await checkTools(),
    backend: BACKEND,
    auth: authEnabled,
  });
});

app.get("/api/resumes", async (_req, res) => res.json(await store.listResumes()));

app.get("/api/resumes/:id", async (req, res) => {
  try {
    const meta = await store.getMeta(req.params.id);
    res.json({ ...publicState(meta), tex: meta.current ? await store.getTex(meta.id, meta.current) : "" });
  } catch {
    res.status(404).json({ error: "Not found" });
  }
});

// Upload a PDF and convert it to the template.
app.post("/api/resumes", upload.single("pdf"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Attach a PDF." });
  if (!req.file.originalname.toLowerCase().endsWith(".pdf")) return res.status(400).json({ error: "Only PDF files are supported." });
  const send = ndjson(res);
  const instructions = (req.body.instructions || "").trim();
  const fitOnePage = req.body.onePage !== "false";
  let meta;
  try {
    const text = await pdfToText(req.file.buffer);
    meta = await store.createResume(req.file.buffer, req.file.originalname, text);
    send({ type: "created", id: meta.id });
    const source = { text, pdf: req.file.buffer };
    send({ type: "status", message: textIsUsable(text) ? "Claude is converting the resume text…" : "No usable text in the PDF, Claude is reading the PDF itself…" });
    const converted = await convertPdf(source, instructions, send);
    const built = await compileWithRepair(converted.tex, { send, history: [], source, fitOnePage });
    meta.messages.push(
      { role: "user", text: instructions ? `Uploaded ${meta.filename}: ${instructions}` : `Uploaded ${meta.filename}` },
      { role: "assistant", text: converted.summary, version: meta.versions.length + 1 }
    );
    await store.addVersion(meta, { tex: built.tex, pdf: built.pdf, synctex: built.synctex, pages: built.pages, label: "Converted from PDF" });
    send({ type: "done", state: publicState(meta), tex: built.tex });
  } catch (err) {
    console.error(err);
    if (meta && !meta.versions.length) await store.deleteResume(meta.id);
    send({ type: "error", message: errorMessage(err), log: err.log });
  }
  res.end();
});

// Prompt-driven tweak.
app.post("/api/resumes/:id/edit", async (req, res) => {
  const prompt = (req.body.prompt || "").trim();
  if (!prompt) return res.status(400).json({ error: "Enter a change to make." });
  const send = ndjson(res);
  try {
    const meta = await store.getMeta(req.params.id);
    const tex = await store.getTex(meta.id, meta.current);
    const history = meta.messages.filter((m) => m.role === "user").map((m) => m.text).slice(-8);
    const source = await store.getSource(meta.id);
    send({ type: "status", message: "Claude is editing…" });
    const edited = await editTex(tex, prompt, { history, source, onProgress: send });
    const built = await compileWithRepair(edited.tex, { send, history, source, fitOnePage: false });
    meta.messages.push({ role: "user", text: prompt }, { role: "assistant", text: edited.summary, version: meta.versions.length + 1 });
    await store.addVersion(meta, { tex: built.tex, pdf: built.pdf, synctex: built.synctex, pages: built.pages, label: prompt.slice(0, 80) });
    send({ type: "done", state: publicState(meta), tex: built.tex });
  } catch (err) {
    console.error(err);
    send({ type: "error", message: errorMessage(err), log: err.log });
  }
  res.end();
});

// Manual LaTeX edit from the source editor. No auto-repair: report errors to the user.
app.put("/api/resumes/:id/tex", async (req, res) => {
  try {
    const meta = await store.getMeta(req.params.id);
    const tex = String(req.body.tex || "");
    const result = await compileTex(tex);
    if (!result.ok) return res.status(422).json({ error: "LaTeX failed to compile.", log: result.log });
    meta.messages.push({ role: "user", text: "Edited the LaTeX by hand" }, { role: "assistant", text: "Recompiled.", version: meta.versions.length + 1 });
    await store.addVersion(meta, { tex, pdf: result.pdf, synctex: result.synctex, pages: result.pages, label: "Manual LaTeX edit" });
    res.json({ state: publicState(meta), tex });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// Point "current" at an earlier version.
app.post("/api/resumes/:id/current", async (req, res) => {
  try {
    const meta = await store.getMeta(req.params.id);
    const n = Number(req.body.version);
    if (!meta.versions.some((v) => v.n === n)) return res.status(400).json({ error: "No such version." });
    meta.current = n;
    await store.saveMeta(meta);
    res.json({ state: publicState(meta), tex: await store.getTex(meta.id, n) });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

app.get("/api/resumes/:id/v/:n/resume.pdf", async (req, res) => {
  try {
    const meta = await store.getMeta(req.params.id);
    const n = Number(req.params.n);
    if (!meta.versions.some((v) => v.n === n)) return res.status(404).end();
    if (req.query.download) res.attachment(`${meta.name}.pdf`);
    res.sendFile(store.pdfPath(meta.id, n));
  } catch {
    res.status(404).end();
  }
});

// Source <-> PDF position map for double-click sync. Versions made before SyncTeX
// was saved get it by recompiling their .tex once.
app.get("/api/resumes/:id/v/:n/synctex", async (req, res) => {
  try {
    const meta = await store.getMeta(req.params.id);
    const n = Number(req.params.n);
    if (!meta.versions.some((v) => v.n === n)) return res.status(404).end();
    let gz = await store.getSynctex(meta.id, n);
    if (!gz) {
      const result = await compileTex(await store.getTex(meta.id, n));
      if (!result.ok || !result.synctex) return res.status(500).json({ error: "Couldn't build the sync map." });
      gz = result.synctex;
      await store.saveSynctex(meta.id, n, gz);
    }
    res.json(parseSynctex(gz));
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

app.get("/api/resumes/:id/v/:n/resume.tex", async (req, res) => {
  try {
    const meta = await store.getMeta(req.params.id);
    const tex = await store.getTex(meta.id, Number(req.params.n));
    res.attachment(`${meta.name}.tex`).type("application/x-tex").send(tex);
  } catch {
    res.status(404).end();
  }
});

app.listen(PORT, HOST, async () => {
  console.log(`Resume editor running at http://${HOST}:${PORT}`);
  console.log(authEnabled ? "Password login is on." : "APP_PASSWORD not set: no login required. Don't expose this publicly.");
  const missing = await checkTools();
  if (missing.length) console.warn(`Missing tools: ${missing.join(", ")} (brew install tectonic poppler)`);
  console.log(BACKEND === "api" ? "Using the Anthropic API." : "No ANTHROPIC_API_KEY: using `claude -p` (Claude Code login).");
});
