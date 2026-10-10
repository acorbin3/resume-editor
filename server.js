import express from "express";
import multer from "multer";
import Anthropic from "@anthropic-ai/sdk";
import { diffLines, diffWords } from "diff";
import { compileTex, checkTools, pdfToText, parseSynctex } from "./lib/latex.js";
import { BACKEND, checkClaudeCli, textIsUsable, convertPdf, editTex, analyzeTex, applyReplacements, fixCompileRequest, fitPageRequest } from "./lib/claude.js";
import * as store from "./lib/store.js";
import { signupOpen, requireAuth, login, signup, logout, authInfo, googleStart, googleCallback } from "./lib/auth.js";
import { analyticsEnabled, posthogHost, track, trackError, shutdownAnalytics } from "./lib/analytics.js";
import { compileLane, claudeLane, queueStats } from "./lib/queue.js";

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const MAX_FIX_ATTEMPTS = 2;

const app = express();
app.disable("x-powered-by");
// Behind a proxy, send plain-http visitors to https: sessions use Secure cookies and
// Google sign-in needs the https callback URL. Local (no proxy) traffic is untouched.
app.use((req, res, next) => {
  if (req.headers["x-forwarded-proto"] === "http") return res.redirect(301, `https://${req.headers["x-forwarded-host"] || req.headers.host}${req.originalUrl}`);
  next();
});
app.use(express.json({ limit: "2mb" }));
// Unauthenticated health check for uptime monitors.
app.get("/healthz", async (_req, res) => {
  const missing = await checkTools();
  if (!(await checkClaudeCli())) missing.push(BACKEND === "bridge" ? `claude bridge at ${process.env.CLAUDE_BRIDGE_URL} (run \`npm run bridge\` on the host)` : "claude (set ANTHROPIC_API_KEY or install the Claude Code CLI)");
  res.status(missing.length ? 503 : 200).json({ ok: !missing.length, missingTools: missing, queue: queueStats() });
});
app.get("/api/auth", authInfo);
app.post("/api/login", login);
app.post("/api/signup", signup);
app.get("/api/auth/google", googleStart);
app.get("/api/auth/google/callback", googleCallback);
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
    const result = await compileLane.run(() => compileTex(tex), (pos) => send({ type: "status", message: `Waiting for a compile slot (${pos} ahead)…` }));
    if (!result.ok) {
      if (attempt >= MAX_FIX_ATTEMPTS) {
        const err = new Error("LaTeX failed to compile.");
        err.log = result.log;
        throw err;
      }
      send({ type: "status", message: "Compile error, asking Claude to fix it…" });
      ({ tex } = await claudeLane.run(() => editTex(tex, fixCompileRequest(result.log), { history, onProgress: send })));
      continue;
    }
    if (fitOnePage && result.pages > 1 && !fitTried) {
      fitTried = true;
      send({ type: "status", message: `Spilled to ${result.pages} pages, tightening to one…` });
      ({ tex } = await claudeLane.run(() => editTex(tex, fitPageRequest(result.pages), { history, source, onProgress: send })));
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
    auth: true,
    queue: queueStats(),
  });
});

app.get("/api/resumes", (req, res) => res.json(store.listResumes(req.user.id)));
app.get("/api/me", (req, res) =>
  res.json({ id: req.user.id, email: req.user.email, analytics: analyticsEnabled ? { key: process.env.POSTHOG_KEY, host: posthogHost } : null })
);

app.patch("/api/resumes/:id", (req, res) => {
  try {
    res.json({ name: store.renameResume(req.user.id, req.params.id, req.body.name) });
  } catch (err) {
    res.status(err.status || 500).json({ error: errorMessage(err) });
  }
});

app.delete("/api/resumes/:id", async (req, res) => {
  try {
    await store.deleteResume(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: errorMessage(err) });
  }
});

app.get("/api/resumes/:id", async (req, res) => {
  try {
    const meta = await store.getMeta(req.user.id, req.params.id);
    res.json({ ...publicState(meta), tex: meta.current ? await store.getTex(meta, meta.current) : "" });
  } catch (err) {
    res.status(err.status || 500).json({ error: errorMessage(err) });
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
    meta = await store.createResume(req.user.id, req.file.buffer, req.file.originalname, text);
    send({ type: "created", id: meta.id });
    const source = { text, pdf: req.file.buffer };
    send({ type: "status", message: textIsUsable(text) ? "Claude is converting the resume text…" : "No usable text in the PDF, Claude is reading the PDF itself…" });
    const converted = await claudeLane.run(() => convertPdf(source, instructions, send), (pos) => send({ type: "status", message: `Waiting for Claude (${pos} ahead)…` }));
    const built = await compileWithRepair(converted.tex, { send, history: [], source, fitOnePage });
    store.addMessages(meta, [
      { role: "user", text: instructions ? `Uploaded ${meta.filename}: ${instructions}` : `Uploaded ${meta.filename}` },
      { role: "assistant", text: converted.summary, version: meta.versions.length + 1 }
    ]);
    await store.addVersion(meta, { tex: built.tex, pdf: built.pdf, synctex: built.synctex, pages: built.pages, label: "Converted from PDF" });
    track(req.user.id, "resume_converted", { pages: built.pages, backend: BACKEND, usedText: textIsUsable(text) });
    send({ type: "done", state: publicState(meta), tex: built.tex });
  } catch (err) {
    console.error(err);
    if (meta && !meta.versions.length) await store.deleteResume(req.user.id, meta.id);
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
    const meta = await store.getMeta(req.user.id, req.params.id);
    const tex = await store.getTex(meta, meta.current);
    const history = meta.messages.filter((m) => m.role === "user").map((m) => m.text).slice(-8);
    const source = await store.getSource(meta);
    send({ type: "status", message: "Claude is editing…" });
    const edited = await claudeLane.run(() => editTex(tex, prompt, { history, source, onProgress: send }), (pos) => send({ type: "status", message: `Waiting for Claude (${pos} ahead)…` }));
    const built = await compileWithRepair(edited.tex, { send, history, source, fitOnePage: false });
    store.addMessages(meta, [{ role: "user", text: prompt }, { role: "assistant", text: edited.summary, version: meta.versions.length + 1 }]);
    await store.addVersion(meta, { tex: built.tex, pdf: built.pdf, synctex: built.synctex, pages: built.pages, label: prompt.slice(0, 80) });
    track(req.user.id, "resume_edited", { pages: built.pages, backend: BACKEND });
    send({ type: "done", state: publicState(meta), tex: built.tex });
  } catch (err) {
    console.error(err);
    trackError(req.user.id, req.path, err);
    send({ type: "error", message: errorMessage(err), log: err.log });
  }
  res.end();
});

// Review the current version and return suggestions for the user to accept or skip.
app.post("/api/resumes/:id/analyze", async (req, res) => {
  const send = ndjson(res);
  try {
    const meta = await store.getMeta(req.user.id, req.params.id);
    if (!meta.current) throw new Error("Nothing to analyze yet.");
    const tex = await store.getTex(meta, meta.current);
    const source = await store.getSource(meta);
    send({ type: "status", message: "Claude is reviewing the resume…" });
    const result = await claudeLane.run(() => analyzeTex(tex, { focus: (req.body.focus || "").trim(), source, onProgress: send }), (pos) => send({ type: "status", message: `Waiting for Claude (${pos} ahead)…` }));
    track(req.user.id, "resume_analyzed", { suggestions: result.suggestions.length, dropped: result.dropped, backend: BACKEND });
    send({ type: "done", version: meta.current, ...result });
  } catch (err) {
    console.error(err);
    trackError(req.user.id, req.path, err);
    send({ type: "error", message: errorMessage(err) });
  }
  res.end();
});

// Apply accepted suggestions (find/replace pairs, possibly user-edited) as one new version.
app.post("/api/resumes/:id/apply", async (req, res) => {
  const accepted = Array.isArray(req.body.replacements) ? req.body.replacements : [];
  if (!accepted.length) return res.status(400).json({ error: "No suggestions selected." });
  const send = ndjson(res);
  try {
    const meta = await store.getMeta(req.user.id, req.params.id);
    if (req.body.version && Number(req.body.version) !== meta.current) {
      throw new Error("The resume changed since this review. Run the analysis again.");
    }
    const tex = await store.getTex(meta, meta.current);
    const { tex: edited, failed } = applyReplacements(
      tex,
      accepted.map((r) => ({ find: String(r.find), replace: String(r.replace), title: String(r.title || "") }))
    );
    if (failed.length === accepted.length) throw new Error("None of the suggestions matched the current document.");
    const history = meta.messages.filter((m) => m.role === "user").map((m) => m.text).slice(-8);
    const source = await store.getSource(meta);
    const built = await compileWithRepair(edited, { send, history, source, fitOnePage: false });
    const titles = accepted.filter((r) => !failed.includes(r)).map((r) => r.title || "suggestion");
    const n = accepted.length - failed.length;
    store.addMessages(meta, [
      { role: "user", text: `Accepted ${n} suggestion${n === 1 ? "" : "s"}:\n${titles.map((t) => `- ${t}`).join("\n")}` },
      {
        role: "assistant",
        text: failed.length ? `Applied ${n}. ${failed.length} no longer matched the document and were skipped.` : `Applied ${n} suggestion${n === 1 ? "" : "s"}.`,
        version: meta.versions.length + 1,
      }
    ]);
    await store.addVersion(meta, { tex: built.tex, pdf: built.pdf, synctex: built.synctex, pages: built.pages, label: `Applied ${n} suggestion${n === 1 ? "" : "s"}` });
    track(req.user.id, "suggestions_applied", { accepted: n, skipped: failed.length });
    send({ type: "done", state: publicState(meta), tex: built.tex, skipped: failed.length });
  } catch (err) {
    console.error(err);
    trackError(req.user.id, req.path, err);
    send({ type: "error", message: errorMessage(err), log: err.log });
  }
  res.end();
});

// Manual LaTeX edit from the source editor. No auto-repair: report errors to the user.
app.put("/api/resumes/:id/tex", async (req, res) => {
  try {
    const meta = await store.getMeta(req.user.id, req.params.id);
    const tex = String(req.body.tex || "");
    const result = await compileLane.run(() => compileTex(tex));
    if (!result.ok) return res.status(422).json({ error: "LaTeX failed to compile.", log: result.log });
    store.addMessages(meta, [{ role: "user", text: "Edited the LaTeX by hand" }, { role: "assistant", text: "Recompiled.", version: meta.versions.length + 1 }]);
    await store.addVersion(meta, { tex, pdf: result.pdf, synctex: result.synctex, pages: result.pages, label: "Manual LaTeX edit" });
    res.json({ state: publicState(meta), tex });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// Point "current" at an earlier version.
app.post("/api/resumes/:id/current", async (req, res) => {
  try {
    const meta = await store.getMeta(req.user.id, req.params.id);
    const n = Number(req.body.version);
    if (!meta.versions.some((v) => v.n === n)) return res.status(400).json({ error: "No such version." });
    store.setCurrent(meta, n);
    res.json({ state: publicState(meta), tex: await store.getTex(meta, n) });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

app.get("/api/resumes/:id/v/:n/resume.pdf", async (req, res) => {
  try {
    const meta = await store.getMeta(req.user.id, req.params.id);
    const n = Number(req.params.n);
    if (!meta.versions.some((v) => v.n === n)) return res.status(404).end();
    if (req.query.download) {
      res.attachment(`${meta.name}.pdf`);
      track(req.user.id, "pdf_downloaded");
    }
    res.type("application/pdf").sendFile(store.pdfPath(meta, n));
  } catch {
    res.status(404).end();
  }
});

// Source <-> PDF position map for double-click sync. Versions made before SyncTeX
// was saved get it by recompiling their .tex once.
// Line diff between two versions, with word-level detail for changed line groups.
app.get("/api/resumes/:id/diff", async (req, res) => {
  try {
    const meta = await store.getMeta(req.user.id, req.params.id);
    const to = Number(req.query.to) || meta.current;
    const from = Number(req.query.from) || Math.max(1, to - 1);
    if (![from, to].every((n) => meta.versions.some((v) => v.n === n))) return res.status(404).json({ error: "No such version." });
    const [a, b] = await Promise.all([store.getTex(meta, from), store.getTex(meta, to)]);
    const parts = diffLines(a, b);
    // Pair each removed block with the added block that follows it so the UI can show
    // word-level changes inside modified lines.
    const hunks = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.removed && parts[i + 1]?.added) {
        hunks.push({ type: "changed", old: p.value, new: parts[i + 1].value, words: diffWords(p.value, parts[i + 1].value) });
        i++;
      } else if (p.removed) hunks.push({ type: "removed", old: p.value });
      else if (p.added) hunks.push({ type: "added", new: p.value });
      else hunks.push({ type: "same", value: p.value });
    }
    res.json({ from, to, hunks });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

app.get("/api/resumes/:id/v/:n/synctex", async (req, res) => {
  try {
    const meta = await store.getMeta(req.user.id, req.params.id);
    const n = Number(req.params.n);
    if (!meta.versions.some((v) => v.n === n)) return res.status(404).end();
    let gz = await store.getSynctex(meta, n);
    if (!gz) {
      const result = await compileLane.run(async () => compileTex(await store.getTex(meta, n)));
      if (!result.ok || !result.synctex) return res.status(500).json({ error: "Couldn't build the sync map." });
      gz = result.synctex;
      await store.saveSynctex(meta, n, gz);
    }
    res.json(parseSynctex(gz));
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

app.get("/api/resumes/:id/v/:n/resume.tex", async (req, res) => {
  try {
    const meta = await store.getMeta(req.user.id, req.params.id);
    const tex = await store.getTex(meta, Number(req.params.n));
    res.attachment(`${meta.name}.tex`).type("application/x-tex").send(tex);
  } catch {
    res.status(404).end();
  }
});

for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, async () => { await shutdownAnalytics(); process.exit(0); });

app.listen(PORT, HOST, async () => {
  console.log(`Resume editor running at http://${HOST}:${PORT}`);
  console.log(signupOpen ? "Accounts: sign-up is open" + (process.env.SIGNUP_CODE ? " (invite code required)." : ".") : "Accounts: sign-up is closed.");
  console.log(`Google sign-in: ${process.env.GOOGLE_CLIENT_ID ? "on" : "off"}. PostHog: ${analyticsEnabled ? "on" : "off"}.`);
  const missing = await checkTools();
  if (missing.length) console.warn(`Missing tools: ${missing.join(", ")} (brew install tectonic poppler)`);
  console.log({ api: "Using the Anthropic API.", bridge: `Using the Claude bridge at ${process.env.CLAUDE_BRIDGE_URL}.`, cli: "No ANTHROPIC_API_KEY: using `claude -p` (Claude Code login)." }[BACKEND]);
  if (!(await checkClaudeCli())) console.error(BACKEND === "bridge" ? "WARNING: the Claude bridge isn't reachable yet. Run `npm run bridge` on the host." : "ERROR: no ANTHROPIC_API_KEY and no `claude` CLI on PATH. Conversions will fail until one is set.");
});
