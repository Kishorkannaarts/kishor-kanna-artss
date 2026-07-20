require('dotenv').config();
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cloudinary = require('cloudinary').v2;
const db = require('./db');
const mailer = require('./mailer');

const app = express();
const PORT = process.env.PORT || 3000;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ---------- Basic setup ----------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));

const sessionsDir = path.join(__dirname, 'data', 'sessions');
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

app.use(session({
  store: new FileStore({ path: sessionsDir, logFn: () => {} }),
  secret: process.env.SESSION_SECRET || 'insecure_dev_secret_change_me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 }
}));

// Make site settings available to every view
app.use(async (req, res, next) => {
  try {
    res.locals.settings = await db.getAllSettings();
    res.locals.isAdmin = !!(req.session && req.session.isAdmin);
    res.locals.popupOffer = await db.findOne('offers', { active: true });
    next();
  } catch (err) { next(err); }
});

// ---------- Image uploads via Cloudinary ----------
const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

async function uploadImage(file, folder) {
  if (!file) return null;
  if (!process.env.CLOUDINARY_CLOUD_NAME) {
    console.log('[uploads] Cloudinary not configured - image not saved. See README.');
    return null;
  }
  const b64 = file.buffer.toString('base64');
  const dataURI = `data:${file.mimetype};base64,${b64}`;
  const result = await cloudinary.uploader.upload(dataURI, { folder: `kishor-kanna-arts/${folder}` });
  return result.secure_url;
}

// ---------- Helpers ----------
function genOrderCode() {
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return 'KKA-' + Date.now().toString().slice(-6) + '-' + rand;
}

function slugify(str) {
  const base = String(str || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'post';
}

function renderTemplate(str, data) {
  return (str || '').replace(/{{\s*(\w+)\s*}}/g, (m, key) =>
    (data[key] !== undefined && data[key] !== null) ? data[key] : '');
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect('/admin/login');
}

function ah(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// =========================================================
// PUBLIC ROUTES
// =========================================================

app.get('/', ah(async (req, res) => {
  const featured  = db.normalize(await db.find('artworks', { featured: true }, { created_at: -1 }, 8));
  const testimonials = db.normalize(await db.find('testimonials', { approved: true }, { created_at: -1 }, 6));
  const videos    = db.normalize(await db.find('videos', {}, { created_at: -1 }, 12)).map(v => {
  let embed = null;
  let m = v.video_url.match(/youtu\.be\/([A-Za-z0-9_-]+)/) || v.video_url.match(/[?&]v=([A-Za-z0-9_-]+)/) || v.video_url.match(/youtube\.com\/shorts\/([A-Za-z0-9_-]+)/);
  if (m) embed = `https://www.youtube.com/embed/${m[1]}?autoplay=1&mute=1&loop=1&playlist=${m[1]}`;
  else { m = v.video_url.match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)/); if (m) embed = `https://drive.google.com/file/d/${m[1]}/preview`; }
  return { ...v, embed_url: embed };
});
  const services  = db.normalize(await db.find('services', {}, { created_at: -1 }));
  const offers    = db.normalize(await db.find('offers', { active: true }, { created_at: -1 }));
  const blocks    = db.normalize(await db.find('blocks', {}, { created_at: 1 }));
  const recentPosts = db.normalize(await db.find('posts', { published: true }, { created_at: -1 }, 3));
  res.render('index', { featured, testimonials, videos, services, offers, blocks, recentPosts });
}));

app.get('/portfolio', ah(async (req, res) => {
  const category = req.query.category || null;
  const filter = category ? { category } : {};
  const artworks = db.normalize(await db.find('artworks', filter, { created_at: -1 }));
  const categories = ['Pencil Art', 'Pen Art', 'Blood Art', 'Colour Art', 'Canvas Art'];
  res.render('portfolio', { artworks, categories, activeCategory: category });
}));

app.get('/portfolio/:id', ah(async (req, res) => {
  const artwork = db.normalize(await db.findById('artworks', req.params.id));
  if (!artwork) return res.status(404).send('Artwork not found');
  res.render('artwork-detail', { artwork });
}));

app.get('/services', ah(async (req, res) => {
  const services = db.normalize(await db.find('services', {}, { created_at: -1 }));
  res.render('services', { services });
}));

app.get('/about', ah(async (req, res) => {
  const testimonials = db.normalize(await db.find('testimonials', { approved: true }, { created_at: -1 }));
  const faqs = db.normalize(await db.find('faqs', {}, { created_at: 1 }));
  res.render('about', { testimonials, faqs });
}));

app.get('/contact', (req, res) => res.render('contact', { sent: false }));

app.post('/contact', ah(async (req, res) => {
  const { name, email, phone, subject, message } = req.body;
  await db.insertOne('messages', { name, email, phone, subject, message, read: false });
  res.render('contact', { sent: true });
}));

app.post('/newsletter', ah(async (req, res) => {
  try { await db.insertOne('newsletter', { email: req.body.email }); } catch (e) {}
  res.redirect(req.get('Referrer') || '/');
}));

app.get('/order', ah(async (req, res) => {
  const blocked = await db.find('blocked_dates', {}, { date: 1 });
  const services = db.normalize(await db.find('services', {}, { created_at: -1 }));
  const activeOffer = await db.findOne('offers', { active: true });
  const offerDiscount = activeOffer ? (activeOffer.discount_percent || 0) : 0;
  const old = {};
  if (req.query.art_type) old.art_type = req.query.art_type;
  if (req.query.size) old.size = req.query.size;
  const presetPrice = req.query.price || '';
  res.render('order', { success: null, error: null, blockedDates: blocked.map(r => r.date), old, services, offerDiscount, presetPrice });
}));

app.post('/order', memoryUpload.single('reference_image'), ah(async (req, res) => {
  const { name, phone, email, art_type, size, delivery_date, notes, estimated_price, discount_percent_applied } = req.body;
  const blocked = await db.find('blocked_dates', {}, { date: 1 });
  const blockedDates = blocked.map(r => r.date);
  const services = db.normalize(await db.find('services', {}, { created_at: -1 }));
  const activeOffer = await db.findOne('offers', { active: true });
  const offerDiscount = activeOffer ? (activeOffer.discount_percent || 0) : 0;

  if (delivery_date && blockedDates.includes(delivery_date)) {
    return res.render('order', { success: null, error: 'Sorry, that delivery date is not available. Please choose a different date.', blockedDates, old: req.body, services, offerDiscount, presetPrice: req.body.preset_price || '' });
  }

  const order_code = genOrderCode();
  const refImage = await uploadImage(req.file, 'orders');
  await db.insertOne('orders', { order_code, name, phone, email, art_type, size, reference_image: refImage, delivery_date, notes, estimated_price: estimated_price || null, discount_percent_applied: discount_percent_applied || 0, status: 'Received', advance_amount: null, advance_payment_link: null, advance_paid: false, balance_amount: null, balance_payment_link: null, balance_paid: false });

  const s = res.locals.settings;
  const trackUrl = `${req.protocol}://${req.get('host')}/track-order`;
  const data = { name, order_code, art_type, size, notes, track_url: trackUrl, site_name: s.site_name };

  if (process.env.NOTIFY_EMAIL) {
    mailer.sendMail({ to: process.env.NOTIFY_EMAIL, subject: `New Order Received - ${order_code}`,
      html: `<h2>New Order</h2><p><b>ID:</b> ${order_code}</p><p><b>Name:</b> ${name}</p><p><b>Phone:</b> ${phone}</p><p><b>Email:</b> ${email||'-'}</p><p><b>Type:</b> ${art_type} / ${size}</p><p><b>Date:</b> ${delivery_date||'-'}</p><p><b>Notes:</b> ${notes||'-'}</p>` });
  }
  if (email) {
    mailer.sendMail({ to: email, subject: renderTemplate(s.tmpl_order_received_subject, data), html: renderTemplate(s.tmpl_order_received_body, data).replace(/\n/g, '<br>') });
  }

  res.render('order', { success: order_code, error: null, blockedDates, old: {}, services, offerDiscount, presetPrice: '' });
}));

app.get('/track-order', (req, res) => res.render('track-order', { order: null, searched: false, presetOrderCode: req.query.order_code || '' }));

app.post('/track-order', ah(async (req, res) => {
  const { order_code, phone } = req.body;
  const order = db.normalize(await db.findOne('orders', { order_code, phone }));
  res.render('track-order', { order: order || undefined, searched: true, presetOrderCode: order_code || '' });
}));

app.post('/track-order/confirm', ah(async (req, res) => {
  const { order_code, phone } = req.body;
  const order = db.normalize(await db.findOne('orders', { order_code, phone }));
  if (order && order.final_artwork_image && !order.customer_confirmed) {
    await db.updateById('orders', order.id, {
      customer_confirmed: true,
      customer_confirmed_at: new Date().toISOString(),
      status: 'Customer Confirmed'
    });
    if (process.env.NOTIFY_EMAIL) {
      const s = res.locals.settings;
      const data = { name: order.name, order_code: order.order_code, site_name: s.site_name };
      mailer.sendMail({ to: process.env.NOTIFY_EMAIL, subject: renderTemplate(s.tmpl_customer_confirmed_subject, data), html: renderTemplate(s.tmpl_customer_confirmed_body, data).replace(/\n/g, '<br>') });
    }
  }
  const refreshed = db.normalize(await db.findOne('orders', { order_code, phone }));
  res.render('track-order', { order: refreshed || undefined, searched: true, presetOrderCode: order_code || '' });
}));

app.post('/testimonials', ah(async (req, res) => {
  const { name, message, rating } = req.body;
  await db.insertOne('testimonials', { name, message, rating: parseInt(rating) || 5, approved: false });
  res.redirect('/about?thanks=1');
}));

app.get('/blog', ah(async (req, res) => {
  const posts = db.normalize(await db.find('posts', { published: true }, { created_at: -1 }));
  res.render('blog_list', { posts });
}));

app.get('/blog/:slug', ah(async (req, res) => {
  const post = db.normalize(await db.findOne('posts', { slug: req.params.slug, published: true }));
  if (!post) return res.status(404).send('Post not found');
  res.render('blog_post', { post });
}));

app.get('/privacy-policy', (req, res) => res.render('privacy-policy'));
app.get('/terms', (req, res) => res.render('terms'));

// =========================================================
// ADMIN ROUTES
// =========================================================

app.get('/admin/login', (req, res) => {
  if (req.session && req.session.isAdmin) return res.redirect('/admin/dashboard');
  res.render('admin/login', { error: null });
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  const validUser = username === process.env.ADMIN_USERNAME;
  const storedPass = process.env.ADMIN_PASSWORD || '';
  let validPass = storedPass.startsWith('$2') ? bcrypt.compareSync(password, storedPass) : password === storedPass;
  if (validUser && validPass) { req.session.isAdmin = true; return res.redirect('/admin/dashboard'); }
  res.render('admin/login', { error: 'Invalid username or password' });
});

app.post('/admin/logout', requireAdmin, (req, res) => req.session.destroy(() => res.redirect('/admin/login')));

app.get('/admin/dashboard', requireAdmin, ah(async (req, res) => {
  const counts = {
    artworks:     await db.count('artworks'),
    orders:       await db.count('orders'),
    newOrders:    await db.count('orders', { status: 'Received' }),
    messages:     await db.count('messages', { read: false }),
    testimonials: await db.count('testimonials', { approved: false }),
    subscribers:  await db.count('newsletter')
  };
  const recentOrders = db.normalize(await db.find('orders', {}, { created_at: -1 }, 5));

  const allOrders = db.normalize(await db.find('orders', {}, { created_at: -1 }));
  let totalReceived = 0, totalPending = 0, totalExpenses = 0;
  allOrders.forEach(o => {
    const adv = parseFloat(o.advance_amount) || 0;
    const bal = parseFloat(o.balance_amount) || 0;
    const exp = parseFloat(o.expenses) || 0;
    if (o.advance_amount) { if (o.advance_paid) totalReceived += adv; else totalPending += adv; }
    if (o.balance_amount) { if (o.balance_paid) totalReceived += bal; else totalPending += bal; }
    totalExpenses += exp;
  });
  const finance = { totalReceived, totalPending, totalExpenses, totalProfit: totalReceived - totalExpenses };

  res.render('admin/dashboard', { counts, recentOrders, finance });
}));

// ---- Artworks ----
app.get('/admin/artworks', requireAdmin, ah(async (req, res) => {
  res.render('admin/artworks', { artworks: db.normalize(await db.find('artworks', {}, { created_at: -1 })) });
}));

app.get('/admin/artworks/new', requireAdmin, (req, res) => res.render('admin/artwork-form', { artwork: null }));

app.get('/admin/artworks/:id/edit', requireAdmin, ah(async (req, res) => {
  const artwork = db.normalize(await db.findById('artworks', req.params.id));
  if (!artwork) return res.redirect('/admin/artworks');
  res.render('admin/artwork-form', { artwork });
}));

app.post('/admin/artworks/save', requireAdmin, memoryUpload.single('image'), ah(async (req, res) => {
  const { id, title, category, description, story, size, price, featured } = req.body;
  const uploadedUrl = await uploadImage(req.file, 'artworks');
  const featuredVal = !!featured;
  if (id) {
    const existing = await db.findById('artworks', id);
    const image = uploadedUrl || (existing ? existing.image : null);
    await db.updateById('artworks', id, { title, category, description, story, size, price, image, featured: featuredVal });
  } else {
    await db.insertOne('artworks', { title, category, description, story, size, price, image: uploadedUrl, featured: featuredVal });
  }
  res.redirect('/admin/artworks');
}));

app.post('/admin/artworks/:id/delete', requireAdmin, ah(async (req, res) => {
  await db.deleteById('artworks', req.params.id);
  res.redirect('/admin/artworks');
}));

// ---- Services ----
app.get('/admin/services', requireAdmin, ah(async (req, res) => {
  res.render('admin/services', { services: db.normalize(await db.find('services', {}, { created_at: -1 })) });
}));

app.post('/admin/services/save', requireAdmin, memoryUpload.single('image'), ah(async (req, res) => {
  const { id, title, description, price_a5, price_a4, price_a3, price_a2, price_custom } = req.body;
  const uploadedUrl = await uploadImage(req.file, 'services');
  if (id) {
    const existing = await db.findById('services', id);
    const image = uploadedUrl || (existing ? existing.image : null);
    await db.updateById('services', id, { title, description, image, price_a5, price_a4, price_a3, price_a2, price_custom });
  } else {
    await db.insertOne('services', { title, description, image: uploadedUrl, price_a5, price_a4, price_a3, price_a2, price_custom });
  }
  res.redirect('/admin/services');
}));

app.post('/admin/services/:id/delete', requireAdmin, ah(async (req, res) => {
  await db.deleteById('services', req.params.id);
  res.redirect('/admin/services');
}));

// ---- Videos ----
app.get('/admin/videos', requireAdmin, ah(async (req, res) => {
  res.render('admin/videos', { videos: db.normalize(await db.find('videos', {}, { created_at: -1 })) });
}));

app.post('/admin/videos/save', requireAdmin, ah(async (req, res) => {
  await db.insertOne('videos', { title: req.body.title, video_url: req.body.video_url });
  res.redirect('/admin/videos');
}));

app.post('/admin/videos/:id/delete', requireAdmin, ah(async (req, res) => {
  await db.deleteById('videos', req.params.id);
  res.redirect('/admin/videos');
}));

// ---- Orders ----
app.get('/admin/orders', requireAdmin, ah(async (req, res) => {
  res.render('admin/orders', { orders: db.normalize(await db.find('orders', {}, { created_at: -1 })) });
}));

app.post('/admin/orders/:id/status', requireAdmin, ah(async (req, res) => {
  await db.updateById('orders', req.params.id, { status: req.body.status });
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (order && order.email) {
    const s = res.locals.settings;
    const trackUrl = `${req.protocol}://${req.get('host')}/track-order`;
    const data = { name: order.name, order_code: order.order_code, status: order.status, track_url: trackUrl, site_name: s.site_name };
    mailer.sendMail({ to: order.email, subject: renderTemplate(s.tmpl_status_update_subject, data), html: renderTemplate(s.tmpl_status_update_body, data).replace(/\n/g, '<br>') });
  }
  res.redirect('/admin/orders');
}));

app.get('/admin/orders/:id/advance', requireAdmin, ah(async (req, res) => {
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (!order) return res.redirect('/admin/orders');
  res.render('admin/order-action', { order, actionType: 'advance', title: 'Request Advance Payment', actionUrl: `/admin/orders/${order.id}/advance`, defaultLink: res.locals.settings.default_payment_link, suggestedAmount: null });
}));

app.post('/admin/orders/:id/advance', requireAdmin, ah(async (req, res) => {
  const { amount, payment_link } = req.body;
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (!order) return res.redirect('/admin/orders');
  await db.updateById('orders', req.params.id, { status: 'Confirmed', advance_amount: amount, advance_payment_link: payment_link, advance_paid: false });
  if (order.email) {
    const s = res.locals.settings;
    const trackUrl = `${req.protocol}://${req.get('host')}/track-order`;
    const data = { name: order.name, order_code: order.order_code, art_type: order.art_type, amount, payment_link, track_url: trackUrl, site_name: s.site_name };
    await mailer.sendMail({ to: order.email, subject: renderTemplate(s.tmpl_advance_subject, data), html: renderTemplate(s.tmpl_advance_body, data).replace(/\n/g, '<br>') });
  }
  res.redirect('/admin/orders');
}));

app.post('/admin/orders/:id/advance-paid', requireAdmin, ah(async (req, res) => {
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (!order) return res.redirect('/admin/orders');
  await db.updateById('orders', req.params.id, { advance_paid: true, status: 'In Progress' });
  if (order.email) {
    const s = res.locals.settings;
    const trackUrl = `${req.protocol}://${req.get('host')}/track-order`;
    const data = { name: order.name, order_code: order.order_code, status: 'In Progress', track_url: trackUrl, site_name: s.site_name };
    await mailer.sendMail({ to: order.email, subject: renderTemplate(s.tmpl_status_update_subject, data), html: renderTemplate(s.tmpl_status_update_body, data).replace(/\n/g, '<br>') });
  }
  res.redirect('/admin/orders');
}));

app.get('/admin/orders/:id/reject', requireAdmin, ah(async (req, res) => {
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (!order) return res.redirect('/admin/orders');
  res.render('admin/order-action', { order, actionType: 'reject', title: 'Reject & Ask For a New Date', actionUrl: `/admin/orders/${order.id}/reject`, defaultLink: '', suggestedAmount: null });
}));

app.post('/admin/orders/:id/reject', requireAdmin, ah(async (req, res) => {
  const { reason } = req.body;
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (!order) return res.redirect('/admin/orders');
  await db.updateById('orders', req.params.id, { status: 'Date Rejected - Awaiting Reply' });
  if (order.email) {
    const s = res.locals.settings;
    const trackUrl = `${req.protocol}://${req.get('host')}/track-order`;
    const data = { name: order.name, order_code: order.order_code, reason: reason || 'Requested date unavailable', track_url: trackUrl, site_name: s.site_name };
    await mailer.sendMail({ to: order.email, subject: renderTemplate(s.tmpl_reject_subject, data), html: renderTemplate(s.tmpl_reject_body, data).replace(/\n/g, '<br>') });
  }
  res.redirect('/admin/orders');
}));

app.get('/admin/orders/:id/balance', requireAdmin, ah(async (req, res) => {
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (!order) return res.redirect('/admin/orders');
  let suggestedAmount = null;
  const est = parseFloat(order.estimated_price);
  const adv = parseFloat(order.advance_amount);
  if (est && adv) suggestedAmount = (est - adv).toFixed(0);
  res.render('admin/order-action', { order, actionType: 'balance', title: 'Request Balance (Final) Payment', actionUrl: `/admin/orders/${order.id}/balance`, defaultLink: res.locals.settings.default_payment_link, suggestedAmount });
}));

app.post('/admin/orders/:id/balance', requireAdmin, ah(async (req, res) => {
  const { amount, payment_link } = req.body;
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (!order) return res.redirect('/admin/orders');
  await db.updateById('orders', req.params.id, { status: 'Completed', balance_amount: amount, balance_payment_link: payment_link, balance_paid: false });
  if (order.email) {
    const s = res.locals.settings;
    const trackUrl = `${req.protocol}://${req.get('host')}/track-order`;
    const data = { name: order.name, order_code: order.order_code, amount, payment_link, track_url: trackUrl, site_name: s.site_name };
    await mailer.sendMail({ to: order.email, subject: renderTemplate(s.tmpl_balance_subject, data), html: renderTemplate(s.tmpl_balance_body, data).replace(/\n/g, '<br>') });
  }
  res.redirect('/admin/orders');
}));

app.post('/admin/orders/:id/balance-paid', requireAdmin, ah(async (req, res) => {
  await db.updateById('orders', req.params.id, { balance_paid: true });
  res.redirect('/admin/orders');
}));

app.post('/admin/orders/:id/expenses', requireAdmin, ah(async (req, res) => {
  await db.updateById('orders', req.params.id, { expenses: req.body.expenses || 0 });
  res.redirect('/admin/orders');
}));

app.post('/admin/orders/:id/shipped', requireAdmin, ah(async (req, res) => {
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (!order) return res.redirect('/admin/orders');
  await db.updateById('orders', req.params.id, { status: 'Delivered' });
  if (order.email) {
    const s = res.locals.settings;
    const trackUrl = `${req.protocol}://${req.get('host')}/track-order`;
    const data = { name: order.name, order_code: order.order_code, track_url: trackUrl, site_name: s.site_name };
    await mailer.sendMail({ to: order.email, subject: renderTemplate(s.tmpl_shipped_subject, data), html: renderTemplate(s.tmpl_shipped_body, data).replace(/\n/g, '<br>') });
  }
  res.redirect('/admin/orders');
}));

// ---- Send Finished Artwork for Customer Confirmation ----
app.get('/admin/orders/:id/send-artwork', requireAdmin, ah(async (req, res) => {
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (!order) return res.redirect('/admin/orders');
  res.render('admin/send-artwork', { order });
}));

app.post('/admin/orders/:id/send-artwork', requireAdmin, memoryUpload.single('artwork_image'), ah(async (req, res) => {
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (!order) return res.redirect('/admin/orders');
  const uploadedUrl = await uploadImage(req.file, 'final-artwork');
  const final_artwork_image = uploadedUrl || order.final_artwork_image || null;
  const update = {
    final_artwork_image,
    final_artwork_note: req.body.note || '',
    status: 'Artwork Sent - Awaiting Confirmation',
    artwork_sent_at: new Date().toISOString(),
    customer_confirmed: false,
    customer_confirmed_at: null
  };
  await db.updateById('orders', req.params.id, update);
  if (order.email && final_artwork_image) {
    const s = res.locals.settings;
    const trackUrl = `${req.protocol}://${req.get('host')}/track-order?order_code=${encodeURIComponent(order.order_code)}`;
    const data = { name: order.name, order_code: order.order_code, art_type: order.art_type, artwork_image: final_artwork_image, artwork_note: req.body.note || '', track_url: trackUrl, site_name: s.site_name };
    await mailer.sendMail({ to: order.email, subject: renderTemplate(s.tmpl_artwork_ready_subject, data), html: renderTemplate(s.tmpl_artwork_ready_body, data).replace(/\n/g, '<br>') });
  }
  res.redirect('/admin/orders');
}));

// ---- Testimonials ----
app.get('/admin/testimonials', requireAdmin, ah(async (req, res) => {
  res.render('admin/testimonials', { testimonials: db.normalize(await db.find('testimonials', {}, { created_at: -1 })) });
}));

app.post('/admin/testimonials/add', requireAdmin, ah(async (req, res) => {
  const { name, message, rating } = req.body;
  await db.insertOne('testimonials', { name, message, rating: parseInt(rating) || 5, approved: true });
  res.redirect('/admin/testimonials');
}));

app.post('/admin/testimonials/:id/approve', requireAdmin, ah(async (req, res) => {
  await db.updateById('testimonials', req.params.id, { approved: true });
  res.redirect('/admin/testimonials');
}));

app.post('/admin/testimonials/:id/delete', requireAdmin, ah(async (req, res) => {
  await db.deleteById('testimonials', req.params.id);
  res.redirect('/admin/testimonials');
}));

// ---- Messages ----
app.get('/admin/messages', requireAdmin, ah(async (req, res) => {
  const mdb = await db.getDB();
  const messages = db.normalize(await db.find('messages', {}, { created_at: -1 }));
  await mdb.collection('messages').updateMany({ read: false }, { $set: { read: true } });
  res.render('admin/messages', { messages });
}));

app.post('/admin/messages/:id/delete', requireAdmin, ah(async (req, res) => {
  await db.deleteById('messages', req.params.id);
  res.redirect('/admin/messages');
}));

// ---- Newsletter ----
app.get('/admin/newsletter', requireAdmin, ah(async (req, res) => {
  res.render('admin/newsletter', { subscribers: db.normalize(await db.find('newsletter', {}, { created_at: -1 })), notice: null });
}));

app.get('/admin/newsletter/export', requireAdmin, ah(async (req, res) => {
  const subscribers = await db.find('newsletter', {}, { created_at: -1 });
  const csv = 'email,subscribed_at\n' + subscribers.map(s => `${s.email},${s.created_at}`).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=subscribers.csv');
  res.send(csv);
}));

app.post('/admin/newsletter/send', requireAdmin, ah(async (req, res) => {
  const { subject, message } = req.body;
  const subscribers = await db.find('newsletter', {}, { created_at: -1 });
  const siteName = res.locals.settings.site_name;
  let sentCount = 0;
  for (const s of subscribers) {
    const result = await mailer.sendMail({ to: s.email, subject, html: `<div>${message.replace(/\n/g, '<br>')}</div><p style="margin-top:20px;color:#888;font-size:12px;">— ${siteName}</p>` });
    if (result && result.sent) sentCount++;
  }
  res.render('admin/newsletter', {
    subscribers: db.normalize(await db.find('newsletter', {}, { created_at: -1 })),
    notice: mailer.isConfigured() ? `Sent to ${sentCount} of ${subscribers.length} subscribers.` : 'Email not configured yet — nothing was sent.'
  });
}));

// ---- Homepage Content ----
app.get('/admin/homepage-content', requireAdmin, (req, res) => res.render('admin/homepage-content'));

// ---- Blog ----
app.get('/admin/blog', requireAdmin, ah(async (req, res) => {
  res.render('admin/blog', { posts: db.normalize(await db.find('posts', {}, { created_at: -1 })) });
}));

app.get('/admin/blog/new', requireAdmin, (req, res) => res.render('admin/blog-form', { post: null }));

app.get('/admin/blog/:id/edit', requireAdmin, ah(async (req, res) => {
  const post = db.normalize(await db.findById('posts', req.params.id));
  if (!post) return res.redirect('/admin/blog');
  res.render('admin/blog-form', { post });
}));

app.post('/admin/blog/save', requireAdmin, memoryUpload.single('cover_image'), ah(async (req, res) => {
  const { id, title, excerpt, content, published } = req.body;
  const uploadedUrl = await uploadImage(req.file, 'blog');
  if (id) {
    const existing = await db.findById('posts', id);
    const cover_image = uploadedUrl || (existing ? existing.cover_image : null);
    await db.updateById('posts', id, { title, excerpt, content, cover_image, published: !!published });
  } else {
    let slug = slugify(title);
    const clash = await db.findOne('posts', { slug });
    if (clash) slug = slug + '-' + Date.now().toString().slice(-5);
    await db.insertOne('posts', { title, slug, excerpt, content, cover_image: uploadedUrl, published: !!published });
  }
  res.redirect('/admin/blog');
}));

app.post('/admin/blog/:id/publish-toggle', requireAdmin, ah(async (req, res) => {
  const post = await db.findById('posts', req.params.id);
  if (post) await db.updateById('posts', req.params.id, { published: !post.published });
  res.redirect('/admin/blog');
}));

app.post('/admin/blog/:id/delete', requireAdmin, ah(async (req, res) => {
  await db.deleteById('posts', req.params.id);
  res.redirect('/admin/blog');
}));

// ---- Custom Content Blocks (free-form fields, no code needed) ----
app.get('/admin/blocks', requireAdmin, ah(async (req, res) => {
  res.render('admin/blocks', { blocks: db.normalize(await db.find('blocks', {}, { created_at: 1 })) });
}));

app.post('/admin/blocks/save', requireAdmin, ah(async (req, res) => {
  await db.insertOne('blocks', { title: req.body.title, text: req.body.text });
  res.redirect('/admin/blocks');
}));

app.post('/admin/blocks/:id/delete', requireAdmin, ah(async (req, res) => {
  await db.deleteById('blocks', req.params.id);
  res.redirect('/admin/blocks');
}));

// ---- Settings ----
app.get('/admin/settings', requireAdmin, (req, res) => res.render('admin/settings'));

app.post('/admin/settings/save', requireAdmin, memoryUpload.fields([{ name: 'logo', maxCount: 1 }, { name: 'hero_image', maxCount: 1 }]), ah(async (req, res) => {
  for (const [key, value] of Object.entries(req.body)) await db.setSetting(key, value);
  const logoFile = req.files && req.files.logo && req.files.logo[0];
  const heroFile = req.files && req.files.hero_image && req.files.hero_image[0];
  const uploadedLogo = await uploadImage(logoFile, 'logo');
  if (uploadedLogo) await db.setSetting('logo_url', uploadedLogo);
  const uploadedHero = await uploadImage(heroFile, 'hero');
  if (uploadedHero) await db.setSetting('hero_image_url', uploadedHero);
  res.redirect('/admin/settings');
}));

// ---- Calendar ----
app.get('/admin/calendar', requireAdmin, ah(async (req, res) => {
  res.render('admin/calendar', { blocked: await db.find('blocked_dates', {}, { date: 1 }) });
}));

app.post('/admin/calendar/block', requireAdmin, ah(async (req, res) => {
  const { date, reason } = req.body;
  if (date) {
    const mdb = await db.getDB();
    await mdb.collection('blocked_dates').updateOne({ date }, { $set: { date, reason: reason || '' } }, { upsert: true });
  }
  res.redirect('/admin/calendar');
}));

app.post('/admin/calendar/unblock', requireAdmin, ah(async (req, res) => {
  const mdb = await db.getDB();
  await mdb.collection('blocked_dates').deleteOne({ date: req.body.date });
  res.redirect('/admin/calendar');
}));

// ---- Email Templates ----
app.get('/admin/email-templates', requireAdmin, (req, res) => res.render('admin/email-templates'));

app.post('/admin/email-templates/save', requireAdmin, ah(async (req, res) => {
  for (const [key, value] of Object.entries(req.body)) {
    if (key.startsWith('tmpl_') || key === 'default_payment_link') await db.setSetting(key, value);
  }
  res.redirect('/admin/email-templates');
}));

// ---- Offers ----
app.get('/admin/offers', requireAdmin, ah(async (req, res) => {
  res.render('admin/offers', { offers: db.normalize(await db.find('offers', {}, { created_at: -1 })) });
}));

app.post('/admin/offers/save', requireAdmin, memoryUpload.single('image'), ah(async (req, res) => {
  const discount = parseFloat(req.body.discount_percent) || 0;
  const uploadedUrl = await uploadImage(req.file, 'offers');
  await db.insertOne('offers', { title: req.body.title, message: req.body.message, discount_percent: discount, image: uploadedUrl, active: true });
  res.redirect('/admin/offers');
}));

app.post('/admin/offers/:id/toggle', requireAdmin, ah(async (req, res) => {
  const offer = await db.findById('offers', req.params.id);
  if (offer) await db.updateById('offers', req.params.id, { active: !offer.active });
  res.redirect('/admin/offers');
}));

app.post('/admin/offers/:id/delete', requireAdmin, ah(async (req, res) => {
  await db.deleteById('offers', req.params.id);
  res.redirect('/admin/offers');
}));
// ---- FAQs ----
app.get('/admin/faqs', requireAdmin, ah(async (req, res) => {
  const faqs = db.normalize(await db.find('faqs', {}, { created_at: 1 }));
  res.render('admin/faqs', { faqs });
}));

app.post('/admin/faqs/add', requireAdmin, ah(async (req, res) => {
  const { question, answer } = req.body;
  await db.insertOne('faqs', { question, answer });
  res.redirect('/admin/faqs');
}));

app.post('/admin/faqs/:id/update', requireAdmin, ah(async (req, res) => {
  const { question, answer } = req.body;
  await db.updateById('faqs', req.params.id, { question, answer });
  res.redirect('/admin/faqs');
}));

app.post('/admin/faqs/:id/delete', requireAdmin, ah(async (req, res) => {
  await db.deleteById('faqs', req.params.id);
  res.redirect('/admin/faqs');
}));

// ---------- 404 + Error handler ----------
app.use((req, res) => res.status(404).send('Page not found'));
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).send('Something went wrong. Please try again.');
});

// ---------- Start ----------
db.initSchema().then(() => {
  app.listen(PORT, () => console.log(`Kishor Kanna Arts running at http://localhost:${PORT}`));
}).catch(err => {
  console.error('Database connection failed:', err.message);
  process.exit(1);
});


