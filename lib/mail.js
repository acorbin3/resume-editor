// Outbound email. Uses Resend over plain fetch when RESEND_API_KEY is set; otherwise the
// message is printed to the server log, which is enough for local use and tests.
//
//   RESEND_API_KEY   from https://resend.com (free tier covers a small site)
//   MAIL_FROM        e.g. "Resume Editor <hello@adamcorbin.com>", a verified domain in Resend

const KEY = process.env.RESEND_API_KEY || "";
const FROM = process.env.MAIL_FROM || "Resume Editor <onboarding@resend.dev>";

export const mailEnabled = Boolean(KEY);

export async function sendMail({ to, subject, text }) {
  if (!KEY) {
    console.log(`[mail] (not sent, RESEND_API_KEY unset) to=${to} subject=${JSON.stringify(subject)}\n${text}`);
    return { logged: true };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], subject, text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Email failed: ${body.message || res.status}`);
  }
  return res.json();
}
