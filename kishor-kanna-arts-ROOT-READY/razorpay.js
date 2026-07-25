// razorpay.js
// Auto-creates Razorpay Payment Links via the REST API using plain fetch
// with Basic Auth (key_id:key_secret) — no SDK dependency, same pattern as
// mailer.js's Brevo integration. This replaces the old workflow where the
// admin had to hand-create a link in the Razorpay dashboard and paste it
// in every time.
//
// SETUP (see README "Payments Setup" for the full walkthrough):
// 1. Create a Razorpay account and complete KYC (required before you can
//    accept live payments; test mode works immediately without it).
// 2. Get your Key ID + Key Secret from Dashboard > Settings > API Keys.
//    Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env.
// 3. For payments to be marked "paid" automatically (instead of the admin
//    manually clicking "Mark Paid"), set up a webhook: Dashboard > Settings
//    > Webhooks > Add New Webhook, URL = https://yourdomain.com/webhooks/razorpay,
//    active event = "payment_link.paid". Set the webhook's secret as
//    RAZORPAY_WEBHOOK_SECRET in .env.

function isConfigured() {
  return !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

// amount is a rupee value (e.g. "800" or 800), converted to paise for the API.
async function createPaymentLink({ amount, description, name, phone, email, referenceId, callbackUrl }) {
  if (!isConfigured()) return null;
  const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const rupees = parseFloat(String(amount).replace(/[^0-9.]/g, ''));
  if (!rupees || rupees <= 0) throw new Error('Invalid amount for payment link');

  const body = {
    amount: Math.round(rupees * 100),
    currency: 'INR',
    description,
    customer: { name, contact: phone, email: email || undefined },
    notify: { sms: true, email: !!email },
    reference_id: referenceId,
    callback_url: callbackUrl,
    callback_method: 'get'
  };

  const res = await fetch('https://api.razorpay.com/v1/payment_links', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Razorpay API error (${res.status}): ${errText}`);
  }
  return res.json(); // { id, short_url, ... }
}

// Verifies the x-razorpay-signature header on incoming webhooks per
// Razorpay's docs: HMAC-SHA256 of the raw request body, using the webhook
// secret as the key. `rawBody` must be the exact unparsed bytes/string
// Razorpay signed — a re-serialized JSON object will NOT produce a match.
function verifyWebhookSignature(rawBody, signature) {
  const crypto = require('crypto');
  if (!process.env.RAZORPAY_WEBHOOK_SECRET || !signature || !rawBody) return false;
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false; // length mismatch etc. => definitely not a match
  }
}

module.exports = { isConfigured, createPaymentLink, verifyWebhookSignature };
