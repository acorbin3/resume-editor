// Per-IP rate limits for the routes that cost money or can be brute-forced. In memory,
// so they are per process; Cloudflare in front adds a second layer (see README).
//
// Behind Cloudflare the real client address is cf-connecting-ip; x-forwarded-for is the
// fallback for other proxies, and the socket address for local use.

export const clientIp = (req) =>
  req.headers["cf-connecting-ip"] || (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";

const buckets = new Map(); // `${name}:${ip}` -> [timestamps]

export function rateLimit(name, { max, windowMs, message }) {
  return (req, res, next) => {
    const key = `${name}:${clientIp(req)}`;
    const now = Date.now();
    const recent = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      const retry = Math.ceil((windowMs - (now - recent[0])) / 1000);
      res.setHeader("Retry-After", String(retry));
      return res.status(429).json({ error: message || `Too many requests. Try again in ${Math.ceil(retry / 60)} minutes.` });
    }
    recent.push(now);
    buckets.set(key, recent);
    next();
  };
}

// Drop stale buckets so the map doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of buckets) if (!ts.some((t) => now - t < 60 * 60 * 1000)) buckets.delete(key);
}, 10 * 60 * 1000).unref();
