// Sends via Gmail SMTP (an app password, not the account password — see GMAIL_APP_PASSWORD
// below) rather than a transactional provider like Resend. That was the original choice, but
// Resend's shared sending domain can only deliver to the account owner's own signup email
// until a custom domain is verified — and every free path to a verifiable domain hit a real
// wall (FreeDNS was down; eu.org refuses to send its own validation email to a Gmail contact
// address, which is what this project's owner has). Gmail SMTP has no such restriction and
// costs nothing, at the cost of a small ongoing risk: Vercel's serverless functions have
// rotating outbound IPs, and Gmail's abuse detection can occasionally flag a sign-in from an
// unfamiliar IP, which would silently pause sending until the account owner confirms "was
// this you?" in their Google account security settings. Worth knowing if notifications ever
// seem to stop without an obvious cause.
const nodemailer = require('nodemailer');

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

// The display name on the "From" line — platform brand by default, but every call site that's
// actually about one specific family's own activity (a post, a request, an approval inside
// their own space) passes that family's own name instead via `fromName`, so members feel the
// email as personal to their own family rather than as generic platform mail. Only genuinely
// platform-level mail (a brand-new family's own creation request/approval, before or outside
// of it having its own identity here yet) uses this default.
const PLATFORM_BRAND = 'Africa Family Trees';

let transporter = null;
function getTransporter(){
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
  }
  return transporter;
}

// Every call site now awaits this before sending its own HTTP response (see routes.js),
// rather than the old "respond first, email after" pattern — a Vercel serverless invocation
// isn't guaranteed to stay alive for work still pending after the response has already gone
// out, which was silently losing notifications with no error anywhere to point at. Bounded
// with a hard timeout here so one slow/hung SMTP connection can't in turn make the *user's*
// own request hang or hit the platform's own function-timeout — a failed or slow email must
// never be able to fail the action that triggered it.
const SEND_TIMEOUT_MS = 8000;
function withTimeout(promise, ms){
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (err) => { clearTimeout(timer); resolve({ ok: false, error: err }); }
    );
  });
}

async function sendEmail({ to, subject, html, text, fromName, replyTo, attachments }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) return { skipped: true, reason: 'no recipients' };
  const t = getTransporter();
  if (!t) {
    console.warn('[email] GMAIL_USER/GMAIL_APP_PASSWORD not set — skipping send:', subject, '->', recipients.join(', '));
    return { skipped: true, reason: 'no credentials' };
  }
  const result = await withTimeout(
    t.sendMail(Object.assign(
      { from: `${fromName || PLATFORM_BRAND} <${GMAIL_USER}>`, to: recipients.join(', '), subject, html },
      text ? { text } : {},
      replyTo ? { replyTo } : {},
      attachments && attachments.length ? { attachments } : {}
    ))
      .then(info => ({ ok: true, info })),
    attachments && attachments.length ? SEND_TIMEOUT_MS * 3 : SEND_TIMEOUT_MS
  );
  if (result.ok) {
    console.log('[email] sent', result.info.messageId || '', '->', recipients.join(', '), '-', subject);
    return { ok: true };
  }
  if (result.reason === 'timeout') {
    console.error('[email] send timed out after', SEND_TIMEOUT_MS, 'ms ->', recipients.join(', '), '-', subject);
  } else {
    console.error('[email] send error', (result.error && result.error.message) || result.error, '->', recipients.join(', '), '-', subject);
  }
  return { ok: false };
}

module.exports = { sendEmail, PLATFORM_BRAND };
