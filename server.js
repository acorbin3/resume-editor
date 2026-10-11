import express from "express";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import Anthropic from "@anthropic-ai/sdk";
import { diffLines, diffWords } from "diff";
import { compileTex, checkTools, pdfToText, parseSynctex } from "./lib/latex.js";
import { BACKEND, MODEL, checkClaudeCli, textIsUsable, convertPdf, editTex, analyzeTex, tailorTex, applyReplacements, fixCompileRequest, fitPageRequest } from "./lib/claude.js";
import { atsCheck, repeatEmployers, fetchJobPosting, pageWordCounts } from "./lib/ats.js";
import { screenPrompt } from "./lib/texguard.js";
import { scoreKeywords } from "./public/keywords.js";
import * as store from "./lib/store.js";
import { signupOpen, requireAuth, currentUser, login, signup, logout, authInfo, googleStart, googleCallback } from "./lib/auth.js";
import { analyticsEnabled, posthogHost, track, trackError, shutdownAnalytics } from "./lib/analytics.js";
import { compileLane, claudeLane, queueStats } from "./lib/queue.js";
import { createJob, recordEvent, getJob, activeJob, publicJob } from "./lib/jobs.js";
import { plans, setPlans, gate } from "./lib/plans.js";
import { loadPrivate } from "./lib/private.js";
import { db } from "./lib/db.js";

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
// Billing or other private additions, if present (see lib/private.js). Registered before
// the body parser so a webhook can read the raw body.
await loadPrivate(app, { express, db, store, requireAuth, track, setPlans, backend: BACKEND });
app.use(express.json({ limit: "2mb" }));
// Unauthenticated health check for uptime monitors.
app.get("/healthz", async (_req, res) => {
  const missing = await checkTools();
  if (!(await checkClaudeCli())) missing.push(BACKEND === "bridge" ? `claude bridge at ${process.env.CLAUDE_BRIDGE_URL} (run \`npm run bridge\` on the host)` : "claude (set ANTHROPIC_API_KEY or install the Claude Code CLI)");
  res.status(missing.length ? 503 : 200).json({ ok: !missing.length, missingTools: missing, queue: queueStats() });
});
app.get("/api/build", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ id: currentBuildId() });
});
app.get("/api/auth", authInfo);
app.post("/api/login", login);
app.post("/api/signup", signup);
app.get("/api/auth/google", googleStart);
app.get("/api/auth/google/callback", googleCallback);
// Public landing page for visitors; signed-in users go straight to the app.
app.get("/", (req, res, next) => (currentUser(req) ? next() : servePage("landing.html")(req, res)));
app.get("/welcome", servePage("landing.html"));
app.use("/screenshots", express.static("docs/screenshots", { maxAge: "1d" }));
app.get("/api/public", (_req, res) => res.json({ signupOpen, pricing: plans.pricing || null }));
app.use(requireAuth);
app.post("/api/logout", logout);
// Cache strategy that survives CDN defaults (Cloudflare rewrites no-cache to a 4h browser TTL):
// HTML is never cached, and it references scripts/styles with ?v=<build id>, so each deploy
// gets fresh URLs. Versioned assets are cached for a year; unversioned requests revalidate.
// Outside production the id is recomputed per request so edited files show up without a
// restart; in production (Docker) it's fixed at startup.
let BUILD_ID = buildId();
const currentBuildId = () => (process.env.NODE_ENV === "production" ? BUILD_ID : (BUILD_ID = buildId()));
function buildId() {
  const h = createHash("sha1");
  for (const f of ["public/app.js", "public/styles.css", "public/syncmap.js", "public/index.html", "public/login.html", "public/vendor/editor.js"]) {
    try {
      h.update(readFileSync(f));
    } catch {}
  }
  return h.digest("hex").slice(0, 10);
}
function servePage(file) {
  return (_req, res) => {
    let html = readFileSync(path.join("public", file), "utf8");
    const id = currentBuildId();
    html = html.replace(/(src|href)="(\/?(?:app\.js|styles\.css|syncmap\.js|vendor\/[^"]+))"/g, `$1="$2?v=${id}"`);
    html = html.replace(/from "\/(vendor\/[^"]+|syncmap\.js)"/g, `from "/$1?v=${id}"`);
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(html);
  };
}
app.get(["/", "/index.html"], servePage("index.html"));
app.get("/login.html", servePage("login.html"));
const assetCache = {
  etag: true,
  maxAge: 0,
  setHeaders: (res, filePath) => {
    // Versioned requests (?v=) are immutable; anything else must revalidate.
    const versioned = res.req.query?.v === currentBuildId();
    res.setHeader("Cache-Control", versioned ? "public, max-age=31536000, immutable" : "no-cache");
  },
};
app.use(express.static("public", { ...assetCache, index: false }));
app.use("/vendor/pdfjs", express.static("node_modules/pdfjs-dist/build", assetCache));
app.use("/vendor/pdfjs-web", express.static("node_modules/pdfjs-dist/web", assetCache));
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } });

// Long-running calls stream newline-delimited JSON progress events, ending in "done" or "error".
// Events go to the client and into the job record, so a dropped connection can be
// resumed by polling. A ping every 10s keeps proxies and mobile browsers from timing out.
function ndjson(res, job) {
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();
  const write = (evt) => {
    if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(evt) + "\n");
  };
  write({ type: "job", id: job.id });
  const ping = setInterval(() => write({ type: "ping" }), 10_000);
  res.on("close", () => clearInterval(ping));
  return (evt) => {
    recordEvent(job, evt);
    write(evt);
    if (evt.type === "done" || evt.type === "error") clearInterval(ping);
  };
}

function errorMessage(err) {
  if (/authentication method/i.test(err.message || "")) return "No Anthropic API key found. Set ANTHROPIC_API_KEY in .env and restart the server.";
  if (err instanceof Anthropic.AuthenticationError) return "Anthropic API key is missing or invalid. Set ANTHROPIC_API_KEY in .env.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Anthropic API. Wait a moment and try again.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Anthropic API.";
  if (err instanceof Anthropic.APIError) return `Anthropic API error: ${err.message}`;
  return err.message || String(err);
}

// Owner-scoped lookup that answers 404 itself; for routes that stream afterwards.
function lookup(req, res) {
  try {
    return store.getMeta(req.user.id, req.params.id);
  } catch (err) {
    res.status(err.status || 500).json({ error: errorMessage(err) });
    return null;
  }
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
app.get("/api/me", async (req, res) =>
  res.json({ id: req.user.id, email: req.user.email, analytics: analyticsEnabled ? { key: process.env.POSTHOG_KEY, host: posthogHost } : null, plan: await plans.status(req.user) })
);

// Account data removal. Both are permanent; the client confirms before calling.
app.delete("/api/me/resumes", async (req, res) => {
  try {
    const deleted = await store.deleteAllResumes(req.user.id);
    track(req.user.id, "resumes_deleted_all", { count: deleted });
    res.json({ ok: true, deleted });
  } catch (err) {
    res.status(err.status || 500).json({ error: errorMessage(err) });
  }
});
app.delete("/api/me", async (req, res) => {
  try {
    if (req.body?.confirm !== req.user.email) return res.status(400).json({ error: "Type your email address to confirm." });
    await plans.onDeleteUser(req.user);
    await store.deleteUser(req.user.id);
    track(req.user.id, "account_deleted");
    logout(req, res);
  } catch (err) {
    res.status(err.status || 500).json({ error: errorMessage(err) });
  }
});

// One row per AI action, for plan limits and cost tracking. Token counts are only known
// on the API backend; the CLI and bridge report time only.
const metered = (req, kind, startedAt, resumeId) => store.recordUsage({ userId: req.user.id, resumeId, kind, backend: BACKEND, model: MODEL, ms: Date.now() - startedAt });

app.patch("/api/resumes/:id", (req, res) => {
  try {
    res.json({ name: store.renameResume(req.user.id, req.params.id, req.body.name) });
  } catch (err) {
    res.status(err.status || 500).json({ error: errorMessage(err) });
  }
});

app.delete("/api/resumes/:id", async (req, res) => {
  try {
    if (!(await store.deleteResume(req.user.id, req.params.id))) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: errorMessage(err) });
  }
});

app.get("/api/resumes/:id", async (req, res) => {
  try {
    const meta = await store.getMeta(req.user.id, req.params.id);
    // Always open on the newest version.
    const latest = meta.versions.at(-1)?.n || 0;
    if (meta.current !== latest) store.setCurrent(meta, latest);
    const review = store.getReview(meta);
    res.json({
      ...publicState(meta),
      tex: meta.current ? await store.getTex(meta, meta.current) : "",
      // A saved analysis is only offered while it still matches the version on screen.
      review: review && review.version === meta.current ? review : null,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: errorMessage(err) });
  }
});

// Upload a PDF and convert it to the template.
app.post("/api/resumes", upload.single("pdf"), gate("convert"), async (req, res) => {
  const startedAt = Date.now();
  if (!req.file) return res.status(400).json({ error: "Attach a PDF." });
  if (!req.file.originalname.toLowerCase().endsWith(".pdf")) return res.status(400).json({ error: "Only PDF files are supported." });
  const job = createJob(req.user.id, null, "convert");
  const send = ndjson(res, job);
  const instructions = (req.body.instructions || "").trim();
  const screened = screenPrompt(instructions, 2000);
  if (screened) return res.status(400).json({ error: screened });
  const fitOnePage = req.body.onePage !== "false";
  let meta;
  try {
    const text = await pdfToText(req.file.buffer);
    meta = await store.createResume(req.user.id, req.file.buffer, req.file.originalname, text);
    job.resumeId = meta.id;
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
    metered(req, "convert", startedAt, meta.id);
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
app.post("/api/resumes/:id/edit", gate("edit"), async (req, res) => {
  const startedAt = Date.now();
  const prompt = (req.body.prompt || "").trim();
  if (!prompt) return res.status(400).json({ error: "Enter a change to make." });
  const screened = screenPrompt(prompt, 6000);
  if (screened) return res.status(400).json({ error: screened });
  const meta = lookup(req, res);
  if (!meta) return;
  const send = ndjson(res, createJob(req.user.id, meta.id, "edit"));
  try {
    const tex = await store.getTex(meta, meta.current);
    const history = meta.messages.filter((m) => m.role === "user").map((m) => m.text).slice(-8);
    const source = await store.getSource(meta);
    send({ type: "status", message: "Claude is editing…" });
    const edited = await claudeLane.run(() => editTex(tex, prompt, { history, source, onProgress: send }), (pos) => send({ type: "status", message: `Waiting for Claude (${pos} ahead)…` }));
    const built = await compileWithRepair(edited.tex, { send, history, source, fitOnePage: false });
    store.addMessages(meta, [{ role: "user", text: prompt }, { role: "assistant", text: edited.summary, version: meta.versions.length + 1 }]);
    await store.addVersion(meta, { tex: built.tex, pdf: built.pdf, synctex: built.synctex, pages: built.pages, label: prompt.slice(0, 80) });
    metered(req, "edit", startedAt, meta.id);
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
app.post("/api/resumes/:id/analyze", gate("analyze"), async (req, res) => {
  const startedAt = Date.now();
  const screened = screenPrompt((req.body.focus || "").trim(), 2000);
  if (screened) return res.status(400).json({ error: screened });
  const meta = lookup(req, res);
  if (!meta) return;
  const send = ndjson(res, createJob(req.user.id, meta.id, "analyze"));
  try {
    if (!meta.current) throw new Error("Nothing to analyze yet.");
    const tex = await store.getTex(meta, meta.current);
    const source = await store.getSource(meta);
    send({ type: "status", message: "Claude is reviewing the resume…" });
    const result = await claudeLane.run(() => analyzeTex(tex, { focus: (req.body.focus || "").trim(), source, onProgress: send }), (pos) => send({ type: "status", message: `Waiting for Claude (${pos} ahead)…` }));
    metered(req, "analyze", startedAt, meta.id);
    track(req.user.id, "resume_analyzed", { suggestions: result.suggestions.length, dropped: result.dropped, backend: BACKEND });
    store.saveReview(meta, meta.current, result);
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
  const meta = lookup(req, res);
  if (!meta) return;
  const send = ndjson(res, createJob(req.user.id, meta.id, "apply"));
  try {
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
    // A tailoring review labels the version after the job and reports the new keyword match.
    const review = store.getReview(meta);
    const tailored = review?.kind === "tailor" && review.version === meta.current ? review : null;
    const jobName = tailored ? [tailored.job?.company, tailored.job?.title].filter(Boolean).join(": ") : "";
    const keywords = tailored?.keywords?.length ? scoreKeywords(tailored.keywords, built.tex) : null;
    const applied = failed.length ? `Applied ${n}. ${failed.length} no longer matched the document and were skipped.` : `Applied ${n} suggestion${n === 1 ? "" : "s"}.`;
    store.addMessages(meta, [
      { role: "user", text: `${tailored ? `Tailored for ${jobName || "the job posting"}. ` : ""}Accepted ${n} suggestion${n === 1 ? "" : "s"}:\n${titles.map((t) => `- ${t}`).join("\n")}` },
      {
        role: "assistant",
        text: keywords ? `${applied} Keyword match is now ${keywords.pct}% (${keywords.present.length} of ${keywords.present.length + keywords.missing.length}).` : applied,
        version: meta.versions.length + 1,
      }
    ]);
    const label = tailored ? `Tailored for ${jobName || "job posting"}`.slice(0, 80) : `Applied ${n} suggestion${n === 1 ? "" : "s"}`;
    await store.addVersion(meta, { tex: built.tex, pdf: built.pdf, synctex: built.synctex, pages: built.pages, label });
    store.clearReview(meta);
    track(req.user.id, tailored ? "tailoring_applied" : "suggestions_applied", { accepted: n, skipped: failed.length, match: keywords?.pct });
    send({ type: "done", state: publicState(meta), tex: built.tex, skipped: failed.length, keywords });
  } catch (err) {
    console.error(err);
    trackError(req.user.id, req.path, err);
    send({ type: "error", message: errorMessage(err), log: err.log });
  }
  res.end();
});

// Tailor to a job posting: pasted text or a link. Produces a keyword match score plus
// suggestions in the same shape as /analyze, so accept/edit/skip/apply is shared.
app.post("/api/resumes/:id/tailor", gate("tailor"), async (req, res) => {
  const startedAt = Date.now();
  const pasted = String(req.body.job || "").trim();
  const url = String(req.body.url || "").trim();
  if (!pasted && !url) return res.status(400).json({ error: "Paste the job description or a link to it." });
  if (pasted.length > 20_000) return res.status(400).json({ error: "That posting is very long; paste just the description and requirements." });
  const meta = lookup(req, res);
  if (!meta) return;
  const send = ndjson(res, createJob(req.user.id, meta.id, "tailor"));
  try {
    if (!meta.current) throw new Error("Nothing to tailor yet.");
    let job = { title: null, company: null, text: pasted.slice(0, 20_000), url: null };
    if (url) {
      send({ type: "status", message: "Reading the job posting…" });
      job = await fetchJobPosting(url);
    } else if (pasted.split(/\s+/).length < 25) {
      throw new Error("That's too short to be a job description. Paste the full posting (or a link to it).");
    }
    const tex = await store.getTex(meta, meta.current);
    const source = await store.getSource(meta);
    send({ type: "status", message: "Claude is matching the resume to the posting…" });
    const result = await claudeLane.run(() => tailorTex(tex, job, { source, onProgress: send }), (pos) => send({ type: "status", message: `Waiting for Claude (${pos} ahead)…` }));
    const before = scoreKeywords(result.keywords, tex);
    const after = scoreKeywords(result.keywords, applyReplacements(tex, result.suggestions).tex);
    const review = { kind: "tailor", summary: result.summary, job: { ...result.job, url: job.url }, keywords: result.keywords, before, after, suggestions: result.suggestions, dropped: result.dropped };
    store.saveReview(meta, meta.current, review);
    store.addMessages(meta, [
      { role: "user", text: `Tailor to: ${[result.job.company, result.job.title].filter(Boolean).join(", ") || job.url || "pasted job description"}` },
      { role: "assistant", text: `${result.summary} Keyword match: ${before.pct}% now, ${after.pct}% with every suggestion accepted.` },
    ]);
    metered(req, "tailor", startedAt, meta.id);
    track(req.user.id, "resume_tailored", { suggestions: result.suggestions.length, keywords: result.keywords.length, before: before.pct, after: after.pct, viaUrl: !!url, backend: BACKEND });
    send({ type: "done", version: meta.current, messages: meta.messages.slice(-2), ...review });
  } catch (err) {
    console.error(err);
    trackError(req.user.id, req.path, err);
    send({ type: "error", message: errorMessage(err) });
  }
  res.end();
});

// Fit to one page: up to three increasingly firm passes, each told how much spilled over.
app.post("/api/resumes/:id/fit", gate("fit"), async (req, res) => {
  const startedAt = Date.now();
  const meta = lookup(req, res);
  if (!meta) return;
  const send = ndjson(res, createJob(req.user.id, meta.id, "fit"));
  try {
    if (!meta.current) throw new Error("Nothing to fit yet.");
    const current = meta.versions.find((v) => v.n === meta.current);
    if (current?.pages === 1) {
      send({ type: "done", state: publicState(meta), tex: await store.getTex(meta, meta.current), alreadyFits: true });
      return res.end();
    }
    let tex = await store.getTex(meta, meta.current);
    let pdf = await readFile(store.pdfPath(meta, meta.current));
    let pages = current?.pages || 2;
    const history = meta.messages.filter((m) => m.role === "user").map((m) => m.text).slice(-8);
    const source = await store.getSource(meta);
    const summaries = [];
    let built = null;
    for (let round = 1; round <= 3 && pages > 1; round++) {
      const counts = await pageWordCounts(pdf, pages);
      const overflow = counts.slice(1).reduce((a, b) => a + b, 0);
      send({ type: "status", message: round === 1 ? `${pages} pages, about ${overflow} words over. Claude is tightening…` : `Still ${pages} pages (${overflow} words over). Pass ${round}, cutting deeper…` });
      const edited = await claudeLane.run(() => editTex(tex, fitPageRequest(pages, overflow, round), { history, source, onProgress: send }), (pos) => send({ type: "status", message: `Waiting for Claude (${pos} ahead)…` }));
      built = await compileWithRepair(edited.tex, { send, history, source, fitOnePage: false });
      summaries.push(edited.summary);
      tex = built.tex;
      pdf = built.pdf;
      pages = built.pages || 1;
    }
    const fits = pages === 1;
    store.addMessages(meta, [
      { role: "user", text: "Fit to one page" },
      { role: "assistant", text: fits ? `Now one page. ${summaries.join(" ")}` : `Still ${pages} pages after three passes. ${summaries.at(-1)} Try removing a role or section by hand, or tell me what can go.`, version: meta.versions.length + 1 },
    ]);
    await store.addVersion(meta, { tex: built.tex, pdf: built.pdf, synctex: built.synctex, pages: built.pages, label: fits ? "Fit to one page" : `Tightened (still ${pages} pages)` });
    metered(req, "fit", startedAt, meta.id);
    track(req.user.id, "fit_one_page", { fits, rounds: summaries.length, backend: BACKEND });
    send({ type: "done", state: publicState(meta), tex: built.tex, fits, pages });
  } catch (err) {
    console.error(err);
    trackError(req.user.id, req.path, err);
    send({ type: "error", message: errorMessage(err), log: err.log });
  }
  res.end();
});

// ATS parse check for a version. Deterministic (pdftotext, pdffonts, pdfimages), so it's
// free and runs on demand; results are cached per version for the process lifetime.
const atsCache = new Map();
app.get("/api/resumes/:id/v/:n/ats", async (req, res) => {
  try {
    const meta = await store.getMeta(req.user.id, req.params.id);
    const n = Number(req.params.n);
    const ver = meta.versions.find((v) => v.n === n);
    if (!ver) return res.status(404).json({ error: "No such version." });
    const key = `${meta.id}:${n}`;
    if (!atsCache.has(key)) {
      const [tex, pdf] = await Promise.all([store.getTex(meta, n), readFile(store.pdfPath(meta, n))]);
      atsCache.set(key, await atsCheck({ tex, pdf, pages: ver.pages || 1 }));
      if (atsCache.size > 500) atsCache.delete(atsCache.keys().next().value);
    }
    res.json(atsCache.get(key));
  } catch (err) {
    res.status(err.status || 500).json({ error: errorMessage(err) });
  }
});

// Deterministic ATS fixes (no Claude unless the result fails to compile).
app.post("/api/resumes/:id/ats-fix", async (req, res) => {
  const fix = String(req.body.fix || "");
  const meta = lookup(req, res);
  if (!meta) return;
  const send = ndjson(res, createJob(req.user.id, meta.id, "ats-fix"));
  try {
    if (fix !== "repeat-employers") throw new Error("Unknown fix.");
    const tex = await store.getTex(meta, meta.current);
    const { tex: fixed, changed } = repeatEmployers(tex);
    if (!changed) throw new Error("No second titles found to fix.");
    const history = meta.messages.filter((m) => m.role === "user").map((m) => m.text).slice(-8);
    const built = await compileWithRepair(fixed, { send, history, source: null, fitOnePage: false });
    store.addMessages(meta, [
      { role: "user", text: "ATS fix: repeat the employer on each role" },
      { role: "assistant", text: `Rewrote ${changed} second title${changed > 1 ? "s" : ""} as full headings with the employer and location, so every role parses with its company.`, version: meta.versions.length + 1 },
    ]);
    await store.addVersion(meta, { tex: built.tex, pdf: built.pdf, synctex: built.synctex, pages: built.pages, label: "ATS: employer on every role" });
    track(req.user.id, "ats_fix_applied", { fix, changed });
    send({ type: "done", state: publicState(meta), tex: built.tex, changed });
  } catch (err) {
    console.error(err);
    trackError(req.user.id, req.path, err);
    send({ type: "error", message: errorMessage(err), log: err.log });
  }
  res.end();
});

// Poll a job whose stream was lost, or find the one still running for a resume.
app.get("/api/jobs/active", (req, res) => {
  const job = activeJob(req.user.id, req.query.resume || null);
  res.json(job ? publicJob(job) : null);
});
app.get("/api/jobs/:id", (req, res) => {
  const job = getJob(req.user.id, req.params.id);
  if (!job) return res.status(404).json({ error: "No such job." });
  res.json(publicJob(job));
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
    res.status(err.status || 500).json({ error: errorMessage(err) });
  }
});

// Go back to an earlier version: it's copied forward as a new version.
app.post("/api/resumes/:id/current", async (req, res) => {
  try {
    const meta = await store.getMeta(req.user.id, req.params.id);
    const n = Number(req.body.version);
    if (!meta.versions.some((v) => v.n === n)) return res.status(400).json({ error: "No such version." });
    if (n !== meta.versions.at(-1).n) {
      await store.restoreVersion(meta, n);
      store.addMessages(meta, [{ role: "user", text: `Restored version ${n}` }, { role: "assistant", text: `Version ${n} is back as the newest version.`, version: meta.current }]);
    }
    res.json({ state: publicState(meta), tex: await store.getTex(meta, meta.current) });
  } catch (err) {
    res.status(err.status || 500).json({ error: errorMessage(err) });
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
    res.status(err.status || 500).json({ error: errorMessage(err) });
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
    res.status(err.status || 500).json({ error: errorMessage(err) });
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
