import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { db } from "./db.js";
import { googleEnabled, startGoogle, finishGoogle } from "./google.js";
import { track } from "./analytics.js";

// Google-only accounts have an empty password_hash and a google_sub.
try {
  db.exec("ALTER TABLE users ADD COLUMN google_sub TEXT");
} catch {}
try {
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_google ON users(google_sub)");
} catch {}

// Email + password accounts with server-side sessions. Passwords are scrypt-hashed.
// Sign-up is open by default for local use; set SIGNUP_CODE to require an invite code,
// or ALLOW_SIGNUP=false to close it once your users exist.
const scrypt = promisify(scryptCb);
const COOKIE = "re_session";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const PUBLIC_PATHS = new Set(["/login.html", "/styles.css", "/api/login", "/api/signup", "/api/auth", "/api/auth/google", "/api/auth/google/callback", "/healthz", "/favicon.ico"]);

export const signupOpen = (process.env.ALLOW_SIGNUP ?? "true") !== "false";
const SIGNUP_CODE = process.env.SIGNUP_CODE || "";

const q = {
  userByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
  insertUser: db.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)"),
  userCount: db.prepare("SELECT COUNT(*) AS c FROM users"),
  userByGoogle: db.prepare("SELECT * FROM users WHERE google_sub = ?"),
  linkGoogle: db.prepare("UPDATE users SET google_sub = ? WHERE id = ?"),
  insertGoogleUser: db.prepare("INSERT INTO users (id, email, password_hash, google_sub) VALUES (?, ?, '', ?)"),
  insertSession: db.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)"),
  session: db.prepare(
    "SELECT s.id, s.expires_at, u.id AS user_id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?"
  ),
  deleteSession: db.prepare("DELETE FROM sessions WHERE id = ?"),
  purgeSessions: db.prepare("DELETE FROM sessions WHERE expires_at < ?"),
};

async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(password, salt, 64);
  return `${salt}:${key.toString("hex")}`;
}

async function verifyPassword(password, stored) {
  const [salt, hex] = stored.split(":");
  const key = await scrypt(password, salt, 64);
  const expected = Buffer.from(hex, "hex");
  return key.length === expected.length && timingSafeEqual(key, expected);
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

const isHttps = (req) => req.secure || req.headers["x-forwarded-proto"] === "https";
const clientIp = (req) => (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";

function startSession(req, res, userId) {
  const id = randomBytes(32).toString("base64url");
  q.insertSession.run(id, userId, Date.now() + SESSION_MS);
  res.cookie(COOKIE, id, { httpOnly: true, sameSite: "lax", secure: isHttps(req), maxAge: SESSION_MS });
}

export function currentUser(req) {
  const id = readCookie(req, COOKIE);
  if (!id) return null;
  const s = q.session.get(id);
  if (!s || s.expires_at < Date.now()) return null;
  return { id: s.user_id, email: s.email };
}

export function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();
  const user = currentUser(req);
  if (user) {
    req.user = user;
    return next();
  }
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Sign in required." });
  res.redirect("/login.html");
}

// Max 10 failed logins per IP per 15 minutes.
const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;
function tooManyFailures(ip) {
  const recent = (failures.get(ip) || []).filter((t) => Date.now() - t < WINDOW_MS);
  failures.set(ip, recent);
  return recent.length >= 10;
}

const validEmail = (e) => typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;

export async function signup(req, res) {
  if (!signupOpen) return res.status(403).json({ error: "Sign-up is closed." });
  const { email, password, code } = req.body || {};
  if (SIGNUP_CODE && code !== SIGNUP_CODE) return res.status(403).json({ error: "Invite code is wrong." });
  if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (typeof password !== "string" || password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  if (q.userByEmail.get(email)) return res.status(409).json({ error: "An account with that email already exists." });
  const id = randomUUID();
  q.insertUser.run(id, email, await hashPassword(password));
  startSession(req, res, id);
  track(id, "signup", { method: "password" });
  res.json({ ok: true, email });
}

export async function login(req, res) {
  const ip = clientIp(req);
  if (tooManyFailures(ip)) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
  const { email, password } = req.body || {};
  const user = validEmail(email) ? q.userByEmail.get(email) : null;
  if (!user || !user.password_hash || !(await verifyPassword(String(password || ""), user.password_hash))) {
    failures.get(ip).push(Date.now());
    return res.status(401).json({ error: "Wrong email or password." });
  }
  failures.delete(ip);
  startSession(req, res, user.id);
  track(user.id, "login", { method: "password" });
  res.json({ ok: true, email: user.email });
}

export function logout(req, res) {
  const id = readCookie(req, COOKIE);
  if (id) q.deleteSession.run(id);
  res.clearCookie(COOKIE);
  res.json({ ok: true });
}

// What the login page needs to know before anyone is signed in.
export function authInfo(_req, res) {
  res.json({ signupOpen, needsCode: Boolean(SIGNUP_CODE), hasUsers: q.userCount.get().c > 0, google: googleEnabled });
}

// Google sign-in: existing account with that Google id, else link by verified email,
// else create one (sign-up policy applies, but the invite code is waived since Google
// verified the address).
export const googleStart = startGoogle;
export async function googleCallback(req, res) {
  try {
    const { sub, email } = await finishGoogle(req);
    let user = q.userByGoogle.get(sub) || q.userByEmail.get(email);
    let method = "google";
    if (user && !user.google_sub) q.linkGoogle.run(sub, user.id);
    if (!user) {
      if (!signupOpen) return res.redirect("/login.html?error=" + encodeURIComponent("Sign-up is closed."));
      user = { id: randomUUID(), email };
      q.insertGoogleUser.run(user.id, email, sub);
      method = "google_signup";
      track(user.id, "signup", { method: "google" });
    }
    startSession(req, res, user.id);
    track(user.id, "login", { method });
    res.redirect("/");
  } catch (err) {
    res.redirect("/login.html?error=" + encodeURIComponent(err.message));
  }
}

setInterval(() => q.purgeSessions.run(Date.now()), 60 * 60 * 1000).unref();
