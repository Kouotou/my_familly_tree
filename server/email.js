// Minimal Resend wrapper via plain fetch — no SDK dependency, matching this project's existing
// habit of hand-rolling small integrations (see uploadPhoto, buildSinglePageImagePdf) rather
// than pulling in a package for a single HTTP call.
//
// Until RESEND_API_KEY is set in the environment, every send is a no-op that just logs to the
// server console — this lets every other piece (owner tier, admin management, deep links,
// notification trigger points) be built and tested before the API key exists.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.RESEND_FROM || 'Nah Adja Mbethe Family Tree <onboarding@resend.dev>';

async function sendEmail({ to, subject, html }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) return { skipped: true, reason: 'no recipients' };
  if (!RESEND_API_KEY) {
    console.warn('[email] RESEND_API_KEY not set — skipping send:', subject, '->', recipients.join(', '));
    return { skipped: true, reason: 'no api key' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: recipients, subject, html }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[email] send failed', res.status, body);
      return { ok: false };
    }
    const body = await res.json().catch(() => ({}));
    console.log('[email] sent', body.id || '', '->', recipients.join(', '), '-', subject);
    return { ok: true };
  } catch (err) {
    console.error('[email] send error', err && err.message || err);
    return { ok: false };
  }
}

module.exports = { sendEmail };
