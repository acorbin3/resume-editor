import { randomBytes } from "node:crypto";

// "Sign in with Google" via OpenID Connect, no SDK. Set GOOGLE_CLIENT_ID and
// GOOGLE_CLIENT_SECRET (Google Cloud Console > APIs & Services > Credentials >
// OAuth client ID, type "Web application") with this redirect URI authorized:
//   <APP_URL>/api/auth/google/callback
export const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

const STATE_COOKIE = "re_oauth_state";
const pending = new Map(); // state -> expiry, so a callback can't be replayed

function appUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  return `${proto}://${req.headers["x-forwarded-host"] || req.headers.host}`;
}

export function startGoogle(req, res) {
  if (!googleEnabled) return res.status(404).json({ error: "Google sign-in is not configured." });
  const state = randomBytes(24).toString("base64url");
  pending.set(state, Date.now() + 10 * 60 * 1000);
  res.cookie(STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", maxAge: 10 * 60 * 1000 });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${appUrl(req)}/api/auth/google/callback`,
    response_type: "code",
    scope: "openid email",
    state,
    prompt: "select_account",
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

// Exchanges the code for an ID token and returns { sub, email } or throws.
export async function finishGoogle(req) {
  const { code, state, error } = req.query;
  if (error) throw new Error(`Google sign-in was cancelled (${error}).`);
  const cookieState = (req.headers.cookie || "").match(/(?:^|;\s*)re_oauth_state=([^;]+)/)?.[1];
  const exp = pending.get(state);
  pending.delete(state);
  if (!code || !state || state !== cookieState || !exp || exp < Date.now()) throw new Error("Sign-in state didn't match. Try again.");

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${appUrl(req)}/api/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) throw new Error("Google rejected the sign-in code.");
  const { id_token } = await tokenRes.json();

  // Google's tokeninfo endpoint validates the signature, audience, and expiry for us.
  const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(id_token)}`);
  if (!infoRes.ok) throw new Error("Couldn't verify the Google sign-in.");
  const info = await infoRes.json();
  if (info.aud !== process.env.GOOGLE_CLIENT_ID || info.email_verified !== "true") throw new Error("Google account couldn't be verified.");
  return { sub: info.sub, email: info.email };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of pending) if (exp < now) pending.delete(k);
}, 60 * 1000).unref();
