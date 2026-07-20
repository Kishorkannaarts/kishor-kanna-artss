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

// ---------- Generic collection helpers ----------
async function find(col, filter = {}, sort = { created_at: -1 }, limit = 0) {
  const db = await getDB();
  let q = db.collection(col).find(filter).sort(sort);
  if (limit) q = q.limit(limit);
  return q.toArray();
}

async function findOne(col, filter) {
  const db = await getDB();
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
  normalize, ObjectId, initSchema
};
