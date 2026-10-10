import { PostHog } from "posthog-node";

// Product analytics. Set POSTHOG_KEY (and POSTHOG_HOST for EU/self-hosted) to turn it on;
// with no key every call is a no-op. Users are identified by their account id, never
// by email, and resume content is never sent.
const KEY = process.env.POSTHOG_KEY || "";
export const posthogHost = process.env.POSTHOG_HOST || "https://us.i.posthog.com";
export const analyticsEnabled = Boolean(KEY);

const client = analyticsEnabled ? new PostHog(KEY, { host: posthogHost, flushAt: 5, flushInterval: 10_000 }) : null;

export function track(userId, event, properties = {}) {
  client?.capture({ distinctId: userId || "anonymous", event, properties });
}

export function trackError(userId, where, err) {
  client?.capture({ distinctId: userId || "anonymous", event: "server_error", properties: { where, message: String(err?.message || err).slice(0, 300) } });
}

export async function shutdownAnalytics() {
  await client?.shutdown();
}
