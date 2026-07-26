// notify.js
// Sends short WhatsApp updates alongside the existing email notifications
// in server.js. WhatsApp is best-effort and silently skipped if not
// configured (same pattern as mailer.js) — the site works fine on email
// alone until WhatsApp keys are added.
//
// Email keeps its own templates (editable in Admin > Email Templates)
// because it's the original, always-on channel. WhatsApp copy lives here
// as plain params since it requires pre-approved templates, which isn't a
// good fit for the same free-text editor.

const whatsapp = require('./whatsapp');
const db = require('./db');

// Converts a customer-entered phone number into E.164 format, defaulting to
// India (+91) since that's this business's customer base. Numbers already
// given with a country code (+ prefix) are left as-is. Override the default
// country with DEFAULT_COUNTRY_CODE in .env if needed.
function toE164(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  digits = digits.replace(/^0+/, '');
  const cc = process.env.DEFAULT_COUNTRY_CODE || '91';
  return digits.length ? `+${cc}${digits}` : null;
}

// One entry per order event. `template` must match an approved WhatsApp
// template name exactly (see whatsapp.js setup notes); `params` supplies its
// {{1}}, {{2}}... values in order.
const EVENTS = {
  order_received: {
    template: 'kka_order_received',
    params: d => [d.name, d.order_code],
    inapp: d => `Your order ${d.order_code} has been received.`
  },
  advance_requested: {
    template: 'kka_advance_requested',
    params: d => [d.name, d.order_code, d.amount, d.payment_link],
    inapp: d => `Order ${d.order_code} confirmed — advance payment of ₹${d.amount} requested.`
  },
  advance_paid: {
    template: 'kka_payment_confirmed',
    params: d => [d.name, d.order_code, d.amount],
    inapp: d => `Advance payment received for order ${d.order_code} — work has started!`
  },
  balance_requested: {
    template: 'kka_balance_requested',
    params: d => [d.name, d.order_code, d.amount, d.payment_link],
    inapp: d => `Your artwork for order ${d.order_code} is ready — balance payment of ₹${d.amount} requested.`
  },
  balance_paid: {
    template: 'kka_payment_confirmed',
    params: d => [d.name, d.order_code, d.amount],
    inapp: d => `Final payment received for order ${d.order_code}. Thank you!`
  },
  status_update: {
    template: 'kka_status_update',
    params: d => [d.name, d.order_code, d.status],
    inapp: d => `Order ${d.order_code} status updated: ${d.status}.`
  },
  rejected: {
    template: 'kka_date_rejected',
    params: d => [d.name, d.order_code, d.reason],
    inapp: d => `Order ${d.order_code}: ${d.reason}. Please get in touch with a new preferred date.`
  },
  artwork_ready: {
    template: 'kka_artwork_ready',
    params: d => [d.name, d.order_code],
    inapp: d => `Your artwork for order ${d.order_code} is ready for your review!`
  },
  shipped: {
    template: 'kka_shipped',
    params: d => [d.name, d.order_code],
    inapp: d => `Order ${d.order_code} has been shipped! We hope you love it.`
  },
  progress_update: {
    template: 'kka_progress_update',
    params: d => [d.name, d.order_code],
    inapp: d => `A progress update was shared for order ${d.order_code}.`
  },
  making_video: {
    template: 'kka_making_video',
    params: d => [d.name, d.order_code, d.video_url],
    inapp: d => `A making-of video was shared for order ${d.order_code}.`
  },
  packing: {
    template: 'kka_packing',
    params: d => [d.name, d.order_code],
    inapp: d => `Order ${d.order_code} is being packed.`
  },
  tracking: {
    template: 'kka_tracking',
    params: d => [d.name, d.order_code, d.courier_name, d.tracking_number],
    inapp: d => `Order ${d.order_code} shipped${d.courier_name ? ' via ' + d.courier_name : ''}. Tracking: ${d.tracking_number || d.tracking_url || '—'}`
  },
  delivered: {
    template: 'kka_delivered',
    params: d => [d.name, d.order_code],
    inapp: d => `Order ${d.order_code} has been delivered. We hope you love it!`
  },
  review_request: {
    template: 'kka_review_request',
    params: d => [d.name, d.review_url],
    inapp: d => `We'd love to hear what you think — leave a review!`
  }
};

// Fire-and-forget: never throws, never blocks the request/response that
// triggered it. Failures are logged, not surfaced to the admin/customer —
// email is still the reliable channel of record.
function notifyOrder(event, order, data) {
  const def = EVENTS[event];
  if (!def || !order) return;

  // In-app notification for the customer dashboard bell — independent of
  // phone/WhatsApp, only needs the order to be linked to an account.
  if (order.customer_id && def.inapp) {
    db.insertOne('notifications', {
      customer_id: order.customer_id,
      message: def.inapp(data),
      link: `/track-order?order_code=${encodeURIComponent(order.order_code)}`,
      read: false
    }).catch(err => console.error(`[notify] in-app notification failed (${event}):`, err.message));
  }

  if (!order.phone) return;
  const to = toE164(order.phone);
  if (!to) return;

  if (whatsapp.isConfigured()) {
    whatsapp.sendTemplate({ to, template: def.template, params: def.params(data) })
      .catch(err => console.error(`[notify] WhatsApp send failed (${event}):`, err.message));
  }
}

module.exports = { notifyOrder, toE164 };
