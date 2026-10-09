import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Single shared password from APP_PASSWORD. A successful login sets a signed,
// expiring cookie. With no APP_PASSWORD set, auth is off (local use only).
const PASSWORD = process.env.APP_PASSWORD || "";
const SECRET = process.env.SESSION_SECRET || randomBytes(32).toString("hex");
const COOKIE = "re_session";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const PUBLIC_PATHS = new Set(["/login.html", "/styles.css", "/api/login", "/favicon.ico"]);

export const authEnabled = Boolean(PASSWORD);

const sign = (value) => createHmac("sha256", SECRET).update(value).digest("base64url");

function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function validSession(req) {
  const value = readCookie(req, COOKIE);
  if (!value) return false;
  const [exp, sig] = value.split(".");
  return Boolean(sig) && safeEqual(sig, sign(exp)) && Number(exp) > Date.now();
}

const isHttps = (req) =>
  req.secure || req.headers["x-forwarded-proto"] === "https" || (req.headers["cf-visitor"] || "").includes("https");

const clientIp = (req) => req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "?";

export function requireAuth(req, res, next) {
  if (!authEnabled || PUBLIC_PATHS.has(req.path) || validSession(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Sign in required." });
  res.redirect("/login.html");
}

// Max 10 failed attempts per IP per 15 minutes.
const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;

export function login(req, res) {
  const ip = clientIp(req);
  const now = Date.now();
  const recent = (failures.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= 10) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });

  if (!authEnabled || !safeEqual(String(req.body?.password || ""), PASSWORD)) {
    failures.set(ip, [...recent, now]);
    return res.status(401).json({ error: "Wrong password." });
  }
  failures.delete(ip);
  const exp = String(now + MAX_AGE_MS);
  res.cookie(COOKIE, `${exp}.${sign(exp)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: isHttps(req),
    maxAge: MAX_AGE_MS,
  });
  res.json({ ok: true });
}

export function logout(_req, res) {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
}
