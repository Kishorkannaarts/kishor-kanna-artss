const nodemailer = require('nodemailer');

// ---------- Option A: Brevo (Sendinblue) HTTP API ----------
// Works on hosts like Render's free tier that block outgoing SMTP ports,
// because it sends over a normal HTTPS web request instead of SMTP.
async function sendViaBrevo({ to, subject, html }) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      sender: {
        name: process.env.MAIL_FROM_NAME || 'Kishor Kanna Arts',
        email: process.env.BREVO_SENDER_EMAIL
      },
      to: [{ email: to }],
      subject,
      htmlContent: html
    })
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Brevo API error (${res.status}): ${errText}`);
  }
  return true;
}

// ---------- Option B: Plain SMTP (works locally, often blocked on free hosts) ----------
let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  return transporter;
}

function isConfigured() {
  return !!process.env.BREVO_API_KEY || !!getTransporter();
}

async function sendMail({ to, subject, html }) {
  // Prefer Brevo if its API key is set - most reliable on free hosting
  if (process.env.BREVO_API_KEY) {
    try {
      await sendViaBrevo({ to, subject, html });
      return { sent: true };
    } catch (err) {
      console.error('[mailer] Brevo send failed:', err.message);
      return { error: err.message };
    }
  }

  // Fall back to SMTP (works locally; may be blocked on some free hosts)
  const t = getTransporter();
  if (!t) {
    console.log('[mailer] Email not configured - skipped email to', to, '-', subject);
    return { skipped: true };
  }
  try {
    await t.sendMail({
      from: `"${process.env.MAIL_FROM_NAME || 'Kishor Kanna Arts'}" <${process.env.SMTP_USER}>`,
      to,
      subject,
      html
    });
    return { sent: true };
  } catch (err) {
    console.error('[mailer] SMTP send failed:', err.message);
    return { error: err.message };
  }
}

module.exports = { sendMail, isConfigured };
