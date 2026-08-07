const { MongoClient, ObjectId } = require('mongodb');

if (!process.env.MONGODB_URI) {
  console.warn('[db] MONGODB_URI is not set. See README for MongoDB Atlas setup.');
}

let client = null;
let _db = null;

async function getDB() {
  if (_db) return _db;
  client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  _db = client.db('kishorkannaarts');
  return _db;
}

// ---------- Setting helpers ----------
async function getSetting(key) {
  const db = await getDB();
  const row = await db.collection('settings').findOne({ key });
  return row ? row.value : null;
}

async function setSetting(key, value) {
  const db = await getDB();
  await db.collection('settings').updateOne({ key }, { $set: { key, value } }, { upsert: true });
}

async function getAllSettings() {
  const db = await getDB();
  const rows = await db.collection('settings').find({}).toArray();
  const out = {};
  rows.forEach(r => out[r.key] = r.value);
  return out;
}

// ---------- Art Types & Sizes (admin-managed taxonomy) ----------
const DEFAULT_ART_TYPES = ['Pencil Art', 'Pen Art', 'Blood Art', 'Colour Art', 'Canvas Art'];
const DEFAULT_SIZES = ['A5', 'A4', 'A3', 'A2', 'Custom'];

async function getArtTypes() {
  const raw = await getSetting('art_types');
  if (raw) {
    try { const arr = JSON.parse(raw); if (Array.isArray(arr) && arr.length) return arr; } catch { /* fall through */ }
  }
  return DEFAULT_ART_TYPES.slice();
}

async function saveArtTypes(list) {
  await setSetting('art_types', JSON.stringify(list));
}

async function getSizes() {
  const raw = await getSetting('sizes');
  if (raw) {
    try { const arr = JSON.parse(raw); if (Array.isArray(arr) && arr.length) return arr; } catch { /* fall through */ }
  }
  return DEFAULT_SIZES.slice();
}

async function saveSizes(list) {
  await setSetting('sizes', JSON.stringify(list));
}

// ---------- Gift Occasions grid (homepage, admin-managed) ----------
// Stored as flat numbered settings (occ1_name/occ1_emoji ... occ8_name/occ8_emoji)
// so the existing generic /admin/settings/save handler (which just loops over
// req.body and calls setSetting) can save this with no extra code — the same
// convention already used for the "Why Choose Us" boxes.
const DEFAULT_OCCASIONS = [
  { name: 'Birthday',        emoji: '🎂' },
  { name: 'Anniversary',     emoji: '💞' },
  { name: 'Wedding',         emoji: '💍' },
  { name: 'Family',          emoji: '👨‍👩‍👧‍👦' },
  { name: 'Baby',            emoji: '👶' },
  { name: 'Pet',             emoji: '🐾' },
  { name: 'Graduation',      emoji: '🎓' },
  { name: 'Corporate Gifts', emoji: '🎁' }
];

async function getOccasions() {
  const settings = await getAllSettings();
  return DEFAULT_OCCASIONS.map(function (def, idx) {
    const i = idx + 1;
    const name = (settings['occ' + i + '_name'] || '').trim();
    const emoji = (settings['occ' + i + '_emoji'] || '').trim();
    return { name: name || def.name, emoji: emoji || def.emoji };
  });
}

// ---------- How It Works steps (homepage, admin-managed) ----------
// Stored as flat numbered settings (step1_title/step1_text ... step5_title/step5_text)
// for the same reason as above.
const DEFAULT_HOW_IT_WORKS = [
  { title: 'Upload Your Photo',              text: 'Pick your art type, size, and upload the photo you love.' },
  { title: 'Choose Art Style & Size',        text: 'Select your favorite style and the size that fits your space.' },
  { title: 'Our Artist Creates Your Portrait', text: 'Our artist hand-draws or paints your portrait with care.' },
  { title: 'Approve Your Artwork',           text: 'Preview the finished piece and request changes if needed.' },
  { title: 'Delivered to Your Doorstep',     text: 'Safely packed and shipped straight to your door.' }
];

async function getHowItWorks() {
  const settings = await getAllSettings();
  return DEFAULT_HOW_IT_WORKS.map(function (def, idx) {
    const i = idx + 1;
    const title = (settings['step' + i + '_title'] || '').trim();
    const text = (settings['step' + i + '_text'] || '').trim();
    return { title: title || def.title, text: text || def.text };
  });
}

// ---------- Generic collection helpers ----------
// projection is optional (e.g. { status: 1, created_at: 1 }) — pass it when
// a caller only needs a handful of fields from otherwise-heavy documents
// (like orders, which also carry reference images, notes, and addresses).
// Existing callers that don't pass one are unaffected.
async function find(col, filter = {}, sort = { created_at: -1 }, limit = 0, projection = null) {
  const db = await getDB();
  let q = db.collection(col).find(filter, projection ? { projection } : undefined).sort(sort);
  if (limit) q = q.limit(limit);
  return q.toArray();
}

async function findOne(col, filter, sort) {
  const db = await getDB();
  if (sort) {
    const arr = await db.collection(col).find(filter).sort(sort).limit(1).toArray();
    return arr[0] || null;
  }
  return db.collection(col).findOne(filter);
}

async function findById(col, id) {
  const db = await getDB();
  try { return db.collection(col).findOne({ _id: new ObjectId(id) }); }
  catch { return null; }
}

async function insertOne(col, doc) {
  const db = await getDB();
  doc.created_at = new Date().toISOString();
  const result = await db.collection(col).insertOne(doc);
  return { ...doc, _id: result.insertedId, id: result.insertedId.toString() };
}

async function updateById(col, id, update) {
  const db = await getDB();
  try {
    await db.collection(col).updateOne({ _id: new ObjectId(id) }, { $set: update });
  } catch { /* invalid id, ignore */ }
}

async function deleteById(col, id) {
  const db = await getDB();
  try { await db.collection(col).deleteOne({ _id: new ObjectId(id) }); }
  catch { /* invalid id, ignore */ }
}

async function count(col, filter = {}) {
  const db = await getDB();
  return db.collection(col).countDocuments(filter);
}

// ---------- Schema init: seed default settings if not already there ----------
async function initSchema() {
  const defaults = {
    site_name: 'Kishor Kanna Arts',
    hero_title: 'Handcrafted Art That Tells Your Story',
    hero_subtitle: 'Custom pencil, pen, colour & canvas artworks made with love',
    about_text: 'Kishor Kanna Arts creates custom hand-drawn portraits and artworks for people who want something truly personal. Every piece is made by hand, with care, from your photos and ideas.',
    meta_description: 'Kishor Kanna Arts offers custom pencil art, pen art, blood art, canvas paintings, acrylic paintings and string art in A2, A3, A4 and custom sizes. Perfect for personal gifts, weddings, corporate gifting and business orders. Order handmade art online across India.',
    meta_keywords: 'custom art online, pencil sketch artist, pen art India, blood art portrait, canvas painting online, acrylic painting artist, string art custom, corporate gifting art, personalised portrait gift, handmade art India, custom portrait from photo, A3 A4 canvas art',
    contact_phone: '+91 00000 00000',
    contact_email: 'hello@kishorkannaarts.in',
    contact_address: 'India',
    instagram_url: '',
    facebook_url: '',
    whatsapp_number: '',
    whatsapp_default_message: 'Hi! I\'m interested in getting a custom artwork made. Can you help me?',
    logo_url: '',
    google_maps_embed: '',
    google_business_url: '',
    default_payment_link: '',
    tmpl_order_received_subject: 'Order Received - {{order_code}} | {{site_name}}',
    tmpl_order_received_body: `Hi {{name}},

Thanks for your order! We have received it and will review it shortly.

Your Order ID: {{order_code}}
Art Type: {{art_type}} | Size: {{size}}

Save your Order ID — you will need it with your phone number to track your order:
{{track_url}}

— {{site_name}}`,
    tmpl_status_update_subject: 'Order Update - {{order_code}} is now "{{status}}"',
    tmpl_status_update_body: `Hi {{name}},

Your order {{order_code}} status has been updated to: {{status}}

Track your order anytime: {{track_url}}

— {{site_name}}`,
    tmpl_advance_subject: 'Order Confirmed - Advance Payment Needed for {{order_code}}',
    tmpl_advance_body: `Hi {{name}},

Great news — your order {{order_code}} has been confirmed!

To begin work, please pay the advance amount of {{amount}} using the link below:
{{payment_link}}

Once we receive it, we will start on your {{art_type}}.

— {{site_name}}`,
    tmpl_reject_subject: 'Order {{order_code}} - Please Choose a Different Date',
    tmpl_reject_body: `Hi {{name}},

Unfortunately we are unable to deliver your order {{order_code}} by the date you requested.

Reason: {{reason}}

Could you reply with a new preferred delivery date?

— {{site_name}}`,
    tmpl_balance_subject: 'Order {{order_code}} - Final Payment Due',
    tmpl_balance_body: `Hi {{name}},

Your artwork for order {{order_code}} is complete!

To arrange delivery, please pay the remaining balance of {{amount}} using the link below:
{{payment_link}}

— {{site_name}}`,
    tmpl_shipped_subject: 'Order {{order_code}} is On Its Way!',
    tmpl_shipped_body: `Hi {{name}},

Your order {{order_code}} has been sent out for delivery. We hope you love it!

— {{site_name}}`,
    tmpl_artwork_ready_subject: 'Your Artwork is Ready - {{order_code}} 🎨',
    tmpl_artwork_ready_body: `Hi {{name}},

Great news — your {{art_type}} is complete! Please take a look at the photo of your finished artwork here:

{{artwork_image}}

{{artwork_note}}

Please review it and confirm so we can proceed with packing & delivery:
{{track_url}}

(Enter your Order ID {{order_code}} and your phone number to view and confirm.)

— {{site_name}}`,
    tmpl_customer_confirmed_subject: 'Customer Confirmed Artwork - {{order_code}}',
    tmpl_customer_confirmed_body: `Hi,

{{name}} has reviewed and confirmed the finished artwork for order {{order_code}}. You can proceed with packing & delivery.

— {{site_name}}`,
    tmpl_progress_update_subject: 'A Peek at Your {{art_type}} in Progress - {{order_code}}',
    tmpl_progress_update_body: `Hi {{name}},

Here's a quick progress update on your order {{order_code}}:

{{progress_image}}

{{progress_note}}

— {{site_name}}`,
    tmpl_making_video_subject: 'Watch Your Artwork Being Made - {{order_code}} 🎥',
    tmpl_making_video_body: `Hi {{name}},

We recorded a short video of your {{art_type}} being made — take a look:
{{video_url}}

— {{site_name}}`,
    tmpl_packing_subject: 'Order {{order_code}} is Being Packed 📦',
    tmpl_packing_body: `Hi {{name}},

Your order {{order_code}} has been carefully packed and will be handed to our courier partner shortly.

— {{site_name}}`,
    tmpl_tracking_subject: 'Order {{order_code}} Has Shipped - Tracking Inside',
    tmpl_tracking_body: `Hi {{name}},

Your order {{order_code}} is on its way!

Courier: {{courier_name}}
Tracking Number: {{tracking_number}}
Track your shipment: {{tracking_url}}

— {{site_name}}`,
    tmpl_delivered_subject: 'Order {{order_code}} Delivered! 🎉',
    tmpl_delivered_body: `Hi {{name}},

Your order {{order_code}} has been delivered. We hope you love it!

— {{site_name}}`,
    tmpl_review_request_subject: 'How Did We Do? - {{site_name}}',
    tmpl_review_request_body: `Hi {{name}},

We'd love to hear what you think of your {{art_type}}! Could you spare a minute to leave a review?
{{review_url}}

Thank you for choosing {{site_name}}.

— {{site_name}}`,
    // Admin-side alerts — sent to NOTIFY_EMAIL (see .env), not the customer.
    tmpl_advance_paid_admin_subject: 'Advance Paid - {{order_code}}',
    tmpl_advance_paid_admin_body: `{{name}} has paid the advance ({{amount}}) for order {{order_code}}. Work can begin.`,
    tmpl_balance_paid_admin_subject: 'Final Payment Received - {{order_code}}',
    tmpl_balance_paid_admin_body: `{{name}} has paid the final balance ({{amount}}) for order {{order_code}}. Ready for packing & delivery.`,
    tmpl_contact_form_admin_subject: 'New Contact Form Message - {{site_name}}',
    tmpl_contact_form_admin_body: `New message from the Contact form:

Name: {{name}}
Email: {{email}}
Phone: {{phone}}
Subject: {{subject}}

{{message}}`,
    tmpl_new_review_admin_subject: 'New Review Submitted - {{site_name}}',
    tmpl_new_review_admin_body: `{{name}} submitted a new review ({{rating}}/5):

"{{message}}"

Go to Admin > Reviews to approve or delete it.`,
    // Referral & wallet rewards program (see referral.js)
    referral_reward_amount: '200',
    referral_discount_percent: '10',
    // Abandoned order recovery (see order_progress collection + scheduler in server.js)
    abandoned_recovery_enabled: '1',
    abandoned_recovery_delay_hours: '2',
    tmpl_abandoned_recovery_subject: 'Complete Your Order - {{site_name}}',
    tmpl_abandoned_recovery_body: `Hi {{name}},

We noticed you started designing a {{art_type}} with us but didn't finish placing your order.

Your details are saved — just pick up where you left off:
{{continue_url}}

If you have any questions, just reply to this email or reach us on WhatsApp.

— {{site_name}}`,
    tmpl_gift_reminder_subject: '{{occasion}} for {{recipient_name}} is coming up! - {{site_name}}',
    tmpl_gift_reminder_body: `Hi {{name}},

Just a friendly reminder — {{recipient_name}}'s {{occasion}} is coming up on {{event_date}}!

Give a gift they'll treasure forever — a custom hand-made portrait from {{site_name}}. Order now so it's ready in time:
{{order_url}}

— {{site_name}}`
  };

  const db = await getDB();
  for (const [key, value] of Object.entries(defaults)) {
    await db.collection('settings').updateOne({ key }, { $setOnInsert: { key, value } }, { upsert: true });
  }

  // Indexes for fast lookups
  await db.collection('orders').createIndex({ order_code: 1 }, { unique: true, background: true });
  await db.collection('newsletter').createIndex({ email: 1 }, { unique: true, background: true });
  await db.collection('blocked_dates').createIndex({ date: 1 }, { unique: true, background: true });
  await db.collection('settings').createIndex({ key: 1 }, { unique: true, background: true });
  await db.collection('customers').createIndex({ email: 1 }, { unique: true, background: true });
  // Sparse: only customers that have a referral_code need to be unique on it;
  // older rows created before this feature existed simply won't have one yet.
  await db.collection('customers').createIndex({ referral_code: 1 }, { unique: true, sparse: true, background: true });
  await db.collection('referrals').createIndex({ referrer_id: 1 }, { background: true });
  await db.collection('referrals').createIndex({ referred_id: 1, status: 1 }, { background: true });
  await db.collection('addresses').createIndex({ customer_id: 1 }, { background: true });
  // One wishlist row per customer+artwork — toggling relies on this being unique
  // so we can't ever end up with duplicate hearts on the same piece.
  await db.collection('wishlist').createIndex({ customer_id: 1, artwork_id: 1 }, { unique: true, background: true });
  // Abandoned order recovery: one saved-progress row per email, so a
  // returning visitor's second save just overwrites their first instead of
  // creating duplicates; the scheduler query filters on these same fields.
  await db.collection('order_progress').createIndex({ email: 1 }, { unique: true, background: true });
  await db.collection('order_progress').createIndex({ converted: 1, reminder_sent: 1, updated_at: 1 }, { background: true });
  // Gift reminders: fast lookup of a customer's own reminders, and of
  // everything the scheduler still needs to check on its next run.
  await db.collection('gift_reminders').createIndex({ customer_id: 1 }, { background: true });
  await db.collection('gift_reminders').createIndex({ reminder_sent: 1, event_date: 1 }, { background: true });
  // Customer Gallery: the public page and homepage teaser both query
  // approved-only, newest first.
  await db.collection('gallery_photos').createIndex({ approved: 1, created_at: -1 }, { background: true });
  // Notifications: db.count('notifications', { customer_id, read: false })
  // runs on literally every page view for a logged-in customer (the unread
  // bell-badge count in the global res.locals middleware), so this is the
  // single hottest query in the app — without this index it was a full
  // collection scan on every request. Same compound shape as the actual
  // query for an index-only match.
  await db.collection('notifications').createIndex({ customer_id: 1, read: 1 }, { background: true });
  // Orders: "My Orders" on the customer dashboard filters by customer_id;
  // this was previously unindexed even though orders.order_code was.
  await db.collection('orders').createIndex({ customer_id: 1 }, { background: true });
  // Testimonials: homepage teaser, portfolio reviews, and per-artwork
  // reviews all query approved-only, newest first — same pattern as
  // gallery_photos above, but this collection had no index at all.
  await db.collection('testimonials').createIndex({ approved: 1, created_at: -1 }, { background: true });

  console.log('[db] MongoDB connected and schema ready');
}

// Helper: normalize a MongoDB document so it always has a string `id` field
// alongside `_id`, matching the pattern used in EJS templates
function normalize(doc) {
  if (!doc) return doc;
  if (Array.isArray(doc)) return doc.map(normalize);
  return { ...doc, id: doc._id ? doc._id.toString() : undefined };
}

module.exports = {
  getDB, getSetting, setSetting, getAllSettings,
  find, findOne, findById, insertOne, updateById, deleteById, count,
  normalize, ObjectId, initSchema,
  getArtTypes, saveArtTypes, getSizes, saveSizes,
  getOccasions, getHowItWorks
};
