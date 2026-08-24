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

async function sendEmail({ to, subject, html }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) return { skipped: true, reason: 'no recipients' };
  const t = getTransporter();
  if (!t) {
    console.warn('[email] GMAIL_USER/GMAIL_APP_PASSWORD not set — skipping send:', subject, '->', recipients.join(', '));
    return { skipped: true, reason: 'no credentials' };
  }
  try {
    const info = await t.sendMail({
      from: `Nah Adja Mbethe Family Tree <${GMAIL_USER}>`,
      to: recipients.join(', '),
      subject,
      html,
    });
    console.log('[email] sent', info.messageId || '', '->', recipients.join(', '), '-', subject);
    return { ok: true };
  } catch (err) {
    console.error('[email] send error', err && err.message || err);
    return { ok: false };
  }
}

module.exports = { sendEmail };
