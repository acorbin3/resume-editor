import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

// SQLite holds everything that isn't the document itself: users, sessions, resumes,
// the version index, and the chat log. The LaTeX lives in a git repo per resume
// (lib/repo.js) and binary artifacts in the blob store (lib/blobs.js). Swapping this
// for Postgres later means reimplementing the handful of queries in lib/store.js
// and lib/auth.js; nothing else touches the database.
export const DATA_DIR = path.resolve(process.env.DATA_DIR || "data");
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, "app.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS resumes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  filename    TEXT NOT NULL,
  source_pdf  TEXT NOT NULL,        -- blob key of the uploaded PDF
  source_text TEXT NOT NULL DEFAULT '',
  current     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS resumes_user ON resumes(user_id, updated_at);

CREATE TABLE IF NOT EXISTS versions (
  resume_id  TEXT NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  n          INTEGER NOT NULL,
  commit_sha TEXT NOT NULL,          -- git commit holding resume.tex
  pdf        TEXT NOT NULL,          -- blob key
  synctex    TEXT,                   -- blob key, nullable
  pages      INTEGER,
  label      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (resume_id, n)
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  resume_id  TEXT NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  version    INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS messages_resume ON messages(resume_id, id);

CREATE TABLE IF NOT EXISTS usage (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  resume_id  TEXT,
  kind       TEXT NOT NULL,          -- convert, edit, analyze, fix, fit
  backend    TEXT NOT NULL,          -- api or cli
  model      TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  ms         INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`);

export const now = () => new Date().toISOString();
