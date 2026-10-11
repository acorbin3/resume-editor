// Outbound email. Two providers, picked by which env vars are set; otherwise the message
// is printed to the server log, which is enough for local use and tests.
//
//   RESEND_API_KEY   from https://resend.com; MAIL_FROM must be on a domain verified there
//   SMTP_USER / SMTP_PASS   any SMTP account. For Gmail: your address and an App Password
//                    (Google Account > Security > 2-Step Verification > App passwords);
//                    SMTP_HOST defaults to smtp.gmail.com:465
//   MAIL_FROM        e.g. "Resume Editor <hello@adamcorbin.com>"

const KEY = process.env.RESEND_API_KEY || "";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const FROM = process.env.MAIL_FROM || (SMTP_USER ? `Resume Editor <${SMTP_USER}>` : "Resume Editor <onboarding@resend.dev>");

export const mailEnabled = Boolean(KEY || (SMTP_USER && SMTP_PASS));

let smtp = null;
async function viaSmtp({ to, subject, text, replyTo }) {
  if (!smtp) {
    const { createTransport } = await import("nodemailer");
    smtp = createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: Number(process.env.SMTP_PORT || 465),
      secure: (process.env.SMTP_PORT || "465") === "465",
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return smtp.sendMail({ from: FROM, to, subject, text, replyTo });
}

export async function sendMail({ to, subject, text, replyTo }) {
  if (!KEY && SMTP_USER && SMTP_PASS) return viaSmtp({ to, subject, text, replyTo });
  if (!KEY) {
    console.log(`[mail] (not sent, RESEND_API_KEY unset) to=${to} subject=${JSON.stringify(subject)}\n${text}`);
    return { logged: true };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], subject, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Email failed: ${body.message || res.status}`);
  }
  return res.json();
}
