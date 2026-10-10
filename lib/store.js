import { randomUUID } from "node:crypto";
import { db, now } from "./db.js";
import * as blobs from "./blobs.js";
import * as repo from "./repo.js";

// Resume storage: metadata in SQLite, LaTeX in a git repo per resume (one commit per
// saved version, made automatically), binaries in the blob store. Every lookup is
// scoped to the owning userId so a resume is only ever visible to its owner.

const q = {
  insertResume: db.prepare(
    "INSERT INTO resumes (id, user_id, name, filename, source_pdf, source_text) VALUES (?, ?, ?, ?, ?, ?)"
  ),
  getResume: db.prepare("SELECT * FROM resumes WHERE id = ? AND user_id = ?"),
  listResumes: db.prepare(
    "SELECT r.id, r.name, r.created_at, r.updated_at, (SELECT COUNT(*) FROM versions v WHERE v.resume_id = r.id) AS versions FROM resumes r WHERE r.user_id = ? ORDER BY r.updated_at DESC"
  ),
  versions: db.prepare("SELECT n, pages, label, created_at FROM versions WHERE resume_id = ? ORDER BY n"),
  version: db.prepare("SELECT * FROM versions WHERE resume_id = ? AND n = ?"),
  insertVersion: db.prepare(
    "INSERT INTO versions (resume_id, n, commit_sha, pdf, synctex, pages, label) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ),
  setSynctex: db.prepare("UPDATE versions SET synctex = ? WHERE resume_id = ? AND n = ?"),
  setCurrent: db.prepare("UPDATE resumes SET current = ?, updated_at = ? WHERE id = ?"),
  rename: db.prepare("UPDATE resumes SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?"),
  messages: db.prepare("SELECT role, text, version FROM messages WHERE resume_id = ? ORDER BY id"),
  insertMessage: db.prepare("INSERT INTO messages (resume_id, role, text, version) VALUES (?, ?, ?, ?)"),
  deleteResume: db.prepare("DELETE FROM resumes WHERE id = ? AND user_id = ?"),
  insertUsage: db.prepare(
    "INSERT INTO usage (user_id, resume_id, kind, backend, model, input_tokens, output_tokens, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ),
};

// The shape the API and UI work with.
function toMeta(row) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    filename: row.filename,
    createdAt: row.created_at,
    current: row.current,
    versions: q.versions.all(row.id).map((v) => ({ n: v.n, label: v.label, pages: v.pages, createdAt: v.created_at })),
    messages: q.messages.all(row.id),
  };
}

export async function createResume(userId, sourcePdf, filename, sourceText = "") {
  const id = randomUUID();
  const pdfKey = await blobs.put(sourcePdf);
  await repo.init(id);
  q.insertResume.run(id, userId, filename.replace(/\.pdf$/i, ""), filename, pdfKey, sourceText);
  return getMeta(userId, id);
}

export function getMeta(userId, id) {
  const row = q.getResume.get(id, userId);
  if (!row) {
    const err = new Error("Not found");
    err.status = 404;
    throw err;
  }
  return toMeta(row);
}

export function addMessages(meta, messages) {
  for (const m of messages) q.insertMessage.run(meta.id, m.role, m.text, m.version ?? null);
  meta.messages.push(...messages);
}

export function setCurrent(meta, n) {
  q.setCurrent.run(n, now(), meta.id);
  meta.current = n;
}

export function renameResume(userId, id, name) {
  const clean = String(name || "").replace(/[\/\\:*?"<>|]/g, "").trim().slice(0, 120);
  if (!clean) {
    const err = new Error("Enter a name.");
    err.status = 400;
    throw err;
  }
  const r = q.rename.run(clean, now(), id, userId);
  if (!r.changes) {
    const err = new Error("Not found");
    err.status = 404;
    throw err;
  }
  return clean;
}

// Returns true if a resume was deleted (false when it doesn't exist or isn't the user's).
export async function deleteResume(userId, id) {
  const r = q.deleteResume.run(id, userId);
  if (r.changes) await repo.remove(id);
  return r.changes > 0;
}

export async function getSource(meta) {
  const row = q.getResume.get(meta.id, meta.userId);
  return { text: row.source_text, pdf: await blobs.get(row.source_pdf) };
}

// Saves a version: commits the .tex, stores the PDF and SyncTeX, and makes it current.
export async function addVersion(meta, { tex, pdf, synctex, pages, label }) {
  const n = meta.versions.length + 1;
  const sha = await repo.commit(meta.id, tex, `v${n}: ${label}`);
  const pdfKey = await blobs.put(pdf);
  const synctexKey = synctex ? await blobs.put(synctex) : null;
  q.insertVersion.run(meta.id, n, sha, pdfKey, synctexKey, pages ?? null, label);
  meta.versions.push({ n, label, pages, createdAt: now() });
  setCurrent(meta, n);
  return n;
}

function versionRow(meta, n) {
  const v = q.version.get(meta.id, n);
  if (!v) {
    const err = new Error("No such version.");
    err.status = 404;
    throw err;
  }
  return v;
}

export const getTex = (meta, n) => repo.read(meta.id, versionRow(meta, n).commit_sha);
export const pdfPath = (meta, n) => blobs.pathFor(versionRow(meta, n).pdf);

export async function getSynctex(meta, n) {
  const key = versionRow(meta, n).synctex;
  return key ? blobs.get(key) : null;
}

export async function saveSynctex(meta, n, synctex) {
  q.setSynctex.run(await blobs.put(synctex), meta.id, n);
}

export function listResumes(userId) {
  return q.listResumes.all(userId).map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, versions: r.versions }));
}

export function recordUsage({ userId, resumeId, kind, backend, model, inputTokens, outputTokens, ms }) {
  q.insertUsage.run(userId ?? null, resumeId ?? null, kind, backend, model ?? null, inputTokens ?? null, outputTokens ?? null, ms ?? null);
}
