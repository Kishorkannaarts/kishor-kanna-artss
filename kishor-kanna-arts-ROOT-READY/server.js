require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cloudinary = require('cloudinary').v2;
const compression = require('compression');
const helmet = require('helmet');
const db = require('./db');
const mailer = require('./mailer');
const notify = require('./notify');
const referral = require('./referral');
const razorpay = require('./razorpay');
const chatbot = require('./chatbot');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Gzip/Brotli-style compression for every response — meaningful win for
// Lighthouse/Core Web Vitals with near-zero code cost.
app.use(compression());

// Security headers. CSP is relaxed for the specific third parties this site
// actually uses (Google Fonts, Cloudinary images, embedded YouTube videos) —
// a default-deny CSP would silently break the hero fonts and video embeds.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://www.googletagmanager.com', 'https://connect.facebook.net'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      // Google Maps (contact page embed) and Google Drive (video embeds) need
      // their own domains here too — without these the browser silently
      // blocks the iframe and it just shows blank.
      frameSrc: ["'self'", 'https://www.youtube.com', 'https://player.vimeo.com', 'https://www.google.com', 'https://maps.google.com', 'https://drive.google.com'],
      connectSrc: ["'self'", 'https://www.google-analytics.com', 'https://www.facebook.com']
    }
  },
  crossOriginEmbedderPolicy: false
}));
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const cloudinaryTransform = require('./cloudinary-transform');
// ---------- Basic setup ----------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
// The `verify` hook stashes the exact raw bytes of every JSON request body
// on req.rawBody. Razorpay's webhook signature is computed over those exact
// raw bytes, not the re-serialized object — capturing it here (once,
// globally) is simpler than giving the webhook route its own body parser.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use('/public', express.static(path.join(__dirname, 'public'), {
  // CSS/JS here are versionless (no content-hash in the filename), so a long
  // cache without validation would strand visitors on stale assets after a
  // deploy. maxAge gives fast repeat-visit loads, etag lets the browser
  // revalidate cheaply (304) when a file actually changes.
  maxAge: '7d',
  etag: true
}));

// Sessions now live in MongoDB (see app.use(session(...)) below) instead of
// local disk, so they survive restarts/redeploys on hosts with ephemeral
// filesystems (e.g. Render free/starter tier) instead of randomly
// invalidating mid-login with a CSRF/session-expired error.

// If this is a production deploy and no SESSION_SECRET env var has been set,
// sessions would be signed with the public fallback string below — anyone
// who can read this source (e.g. a public GitHub repo) could forge a valid
// admin/customer session cookie. This doesn't stop the server (some hosts
// don't let you set env vars before first boot), but it makes the risk loud
// and impossible to miss in the logs instead of failing silently.
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.warn('\n*** SECURITY WARNING: SESSION_SECRET is not set. Set a long random ' +
    'SESSION_SECRET environment variable in your hosting platform now — without it, ' +
    'sessions are signed with a public fallback value and can be forged. ***\n');
}

const sessionStore = MongoStore.create({
  mongoUrl: process.env.MONGODB_URI,
  dbName: 'kishorkannaarts',
  collectionName: 'sessions',
  ttl: 60 * 60 * 8 // 8 hours, matches cookie maxAge below
});
sessionStore.on('error', (err) => {
  console.error('SESSION STORE ERROR:', err);
});

app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'insecure_dev_secret_change_me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 8,
    httpOnly: true,
    sameSite: 'lax',
    // Only require HTTPS for the cookie in production — keeps local dev
    // (plain http://localhost) working without needing a cert.
    secure: process.env.NODE_ENV === 'production'
  }
}));

// Make site settings available to every view
app.use(async (req, res, next) => {
  try {
    res.locals.settings = await db.getAllSettings();
    res.locals.isAdmin = !!(req.session && req.session.isAdmin);
    res.locals.isCustomer = !!(req.session && req.session.customerId);
    res.locals.customerName = (req.session && req.session.customerName) || '';
    res.locals.unreadNotifCount = res.locals.isCustomer
      ? await db.count('notifications', { customer_id: req.session.customerId, read: false })
      : 0;
    // Wallet balance from referral rewards — available on every page so the
    // order form can offer "use my wallet balance" without a separate lookup.
    res.locals.walletBalance = 0;
    if (res.locals.isCustomer) {
      const _c = await db.findById('customers', req.session.customerId);
      res.locals.walletBalance = (_c && _c.wallet_balance) || 0;
    }
    res.locals.popupOffer = await db.findOne('offers', { active: true }, { created_at: -1 });
    res.locals.artTypes = await db.getArtTypes();
    res.locals.sizes = await db.getSizes();
    res.locals.priceForSize = priceForSize;
    res.locals.siteUrl = (process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    res.locals.currentPath = req.originalUrl.split('?')[0];
    res.locals.statusBadgeClass = function (status) {
      if (status === 'Delivered' || status === 'Customer Confirmed') return 'badge-ok';
      if (status === 'Cancelled') return 'badge-danger';
      if (status === 'In Progress' || status === 'Artwork Sent - Awaiting Confirmation') return 'badge-progress';
      return 'badge-new'; // Received, Confirmed, Completed
    };
    // Injects Cloudinary's automatic format (WebP/AVIF where supported) and
    // automatic quality into a delivery URL, plus an optional resize, without
    // re-uploading or touching the original asset. Cuts payload size a lot
    // for the same visual quality. Usage in views: <%= cld(a.image, 'w_800') %>
    // Safe no-op on anything that isn't a Cloudinary URL (e.g. placehold.co
    // fallbacks), so it can wrap every <img src> unconditionally.
    res.locals.cld = function (url, resize) {
      if (!url || url.indexOf('res.cloudinary.com') === -1 || url.indexOf('/upload/') === -1) return url;
      const transform = resize ? `f_auto,q_auto,${resize}` : 'f_auto,q_auto';
      return url.replace('/upload/', `/upload/${transform}/`);
    };
    next();
  } catch (err) { next(err); }
});

// ---------- Rate limiting ----------
// A gentle global limit so no single visitor/bot can hammer the site, plus a
// much stricter limit on the two login forms specifically, since those are
// the routes brute-force attempts actually target.
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(generalLimiter);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many login attempts. Please wait 15 minutes and try again.'
});

// ---------- CSRF protection ----------
// Synchronizer token pattern: one random token per logged-in session, echoed
// back by every form as a hidden "_csrf" field and checked on every
// state-changing request. res.locals.csrfToken makes it available to every
// EJS view automatically.
//
// Multipart (file-upload) forms are skipped in this global check because
// multer hasn't parsed req.body yet at this point in the middleware chain —
// those specific routes call csrfCheck() themselves, right after their
// multer middleware runs (see the routes below that accept file uploads).
const CSRF_EXEMPT_PATHS = ['/webhooks/razorpay', '/api/chat', '/coupon/validate', '/order/save-progress'];

app.use((req, res, next) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
});

// ---------- Spam protection (honeypot) ----------
// A hidden field named "website" that's invisible to real visitors (and
// meaningless to autofill) but that bots reliably fill in because they
// blindly complete every field on a form. No CAPTCHA, no external API keys,
// no friction for real customers.
function isSpamBot(req) {
  return !!(req.body && req.body.website);
}

function csrfCheck(req, res, next) {
  const sent = (req.body && req.body._csrf) || req.headers['x-csrf-token'];
  if (!sent || sent !== req.session.csrfToken) {
    return res.status(403).send('Your session expired or the form was submitted incorrectly. Please go back, refresh the page, and try again.');
  }
  next();
}

app.use((req, res, next) => {
  const isStateChanging = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  const isExempt = CSRF_EXEMPT_PATHS.includes(req.path);
  const isMultipart = (req.headers['content-type'] || '').includes('multipart/form-data');
  if (!isStateChanging || isExempt || isMultipart) return next();
  csrfCheck(req, res, next);
});

// ---------- Image uploads via Cloudinary ----------
// fileFilter keeps this to real images only — the order form's client-side
// compression already downsizes photos before they reach the server, so this
// limit is a safety net, not something customers should normally hit.
const memoryUpload = multer({
  storage: multer.memoryStorage(),
  // fieldSize covers the base64 "compressed_image_data" hidden field (order
  // form's fallback for when the raw file upload goes stale) — multer's
  // 1MB default is too small for a base64-encoded photo.
  limits: { fileSize: 15 * 1024 * 1024, fieldSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) return cb(null, true);
    cb(new Error('INVALID_FILE_TYPE'));
  }
});

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

// Same as uploadImage, but for when the browser already sent a ready-made
// base64 data URI (the order form's fallback for when the raw <input
// type=file> handle goes stale — see ERR_UPLOAD_FILE_CHANGED on some
// Android Chrome versions with camera-captured photos).
async function uploadImageDataUri(dataUri, folder) {
  if (!dataUri || !dataUri.startsWith('data:image/')) return null;
  if (!process.env.CLOUDINARY_CLOUD_NAME) {
    console.log('[uploads] Cloudinary not configured - image not saved. See README.');
    return null;
  }
  const result = await cloudinary.uploader.upload(dataUri, { folder: `kishor-kanna-arts/${folder}` });
  return result.secure_url;
}

// ---------- Helpers ----------
// Turns a pasted YouTube or Google Drive link into an embeddable iframe URL.
// Used for both the homepage "Video Showcase" section and video reviews —
// factored out so both stay consistent instead of duplicating the same regex.
function videoEmbedUrl(url) {
  if (!url) return null;
  let m = url.match(/youtu\.be\/([A-Za-z0-9_-]+)/) || url.match(/[?&]v=([A-Za-z0-9_-]+)/) || url.match(/youtube\.com\/shorts\/([A-Za-z0-9_-]+)/);
  if (m) return `https://www.youtube.com/embed/${m[1]}?loop=1&playlist=${m[1]}`;
  m = url.match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)/);
  if (m) return `https://drive.google.com/file/d/${m[1]}/preview`;
  return null;
}

function genOrderCode() {
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return 'KKA-' + Date.now().toString().slice(-6) + '-' + rand;
}

// Map a size name to the old fixed column name, so services saved before
// the dynamic sizes/art-types feature still display correctly.
function legacyPriceKey(size) {
  const s = String(size || '').toLowerCase();
  if (s === 'a5') return 'price_a5';
  if (s === 'a4') return 'price_a4';
  if (s === 'a3') return 'price_a3';
  if (s === 'a2') return 'price_a2';
  if (s === 'custom') return 'price_custom';
  return null;
}

function priceForSize(service, size) {
  if (!service) return '';
  if (service.prices && service.prices[size]) return service.prices[size];
  const lk = legacyPriceKey(size);
  if (lk && service[lk]) return service[lk];
  return '';
}

// Shared fetch for the full services/art-types list, used across the
// homepage, portfolio, order form, chatbot, and admin services page —
// previously duplicated inline as db.find('services', ...) 7 times.
async function getAllServices() {
  return db.normalize(await db.find('services', {}, { created_at: -1 }));
}

// Multipart form bodies (parsed by multer) don't auto-nest bracket-style
// field names the way express.urlencoded (qs) does, so pull `prices[X]`
// fields out of req.body manually.
function extractPrices(body) {
  if (body.prices && typeof body.prices === 'object') return body.prices; // already nested (non-multipart submit)
  const prices = {};
  for (const key of Object.keys(body)) {
    const m = key.match(/^prices\[(.+)\]$/);
    if (m) prices[m[1]] = body[key];
  }
  return prices;
}

function slugify(str) {
  const base = String(str || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'post';
}

// Escapes text before it's dropped into an HTML email body. Every {{field}}
// substituted by renderTemplate ultimately comes from customer-submitted
// input (order name/notes, contact form message, review text, etc.) — without
// this, a customer could put HTML/script markup in their name or notes and
// have it render as live markup inside the confirmation email sent to them,
// or inside the notification email sent to NOTIFY_EMAIL.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderTemplate(str, data) {
  return (str || '').replace(/{{\s*(\w+)\s*}}/g, (m, key) =>
    (data[key] !== undefined && data[key] !== null) ? escapeHtml(data[key]) : '');
}

// ---------- Abandoned order recovery scheduler ----------
// Same SITE_URL-or-request-host pattern used per-request in res.locals.siteUrl
// above, but this runs outside any request, so it falls back to just the env
// var (no req.protocol/req.get('host') to read from).
function jobsSiteUrl() {
  return (process.env.SITE_URL || '').replace(/\/$/, '');
}

// Sends one reminder for a single saved order_progress row and marks it sent.
// Shared by the scheduler loop and the admin "Send Now" button.
async function sendAbandonedReminder(p, settings) {
  const continueUrl = `${jobsSiteUrl()}/order?` + new URLSearchParams({
    name: p.name || '', phone: p.phone || '', email: p.email || '',
    art_type: p.art_type || '', size: p.size || ''
  }).toString();
  const data = { name: p.name || 'there', art_type: p.art_type || 'your artwork', continue_url: continueUrl, site_name: settings.site_name };

  if (p.email) {
    await mailer.sendMail({
      to: p.email,
      subject: renderTemplate(settings.tmpl_abandoned_recovery_subject, data),
      html: renderTemplate(settings.tmpl_abandoned_recovery_body, data).replace(/\n/g, '<br>')
    });
  }
  const mdb = await db.getDB();
  await mdb.collection('order_progress').updateOne(
    { _id: p._id },
    { $set: { reminder_sent: true, reminder_sent_at: new Date().toISOString() } }
  );
}

// Runs periodically: finds everyone who saved progress, never converted to a
// real order, and has gone quiet past the configured delay — then reminds
// them once. Best-effort and self-contained; a failure here never touches
// the request/response cycle of the live site.
async function runAbandonedRecoveryJob() {
  try {
    const settings = await db.getAllSettings();
    if (settings.abandoned_recovery_enabled !== '1') return;
    const delayHours = parseFloat(settings.abandoned_recovery_delay_hours) || 2;
    const cutoff = new Date(Date.now() - delayHours * 60 * 60 * 1000).toISOString();

    const mdb = await db.getDB();
    const pending = await mdb.collection('order_progress').find({
      converted: false,
      reminder_sent: false,
      updated_at: { $lte: cutoff }
    }).toArray();

    for (const p of pending) {
      await sendAbandonedReminder(p, settings).catch(err =>
        console.error(`[abandoned-recovery] reminder failed for ${p.email}:`, err.message));
    }
  } catch (err) {
    console.error('[abandoned-recovery] job run failed:', err.message);
  }
}

// ---------- Gift reminders (birthday / anniversary / wedding) ----------
// The customer picks a date once; for a recurring occasion we always store
// the *next* upcoming occurrence (rolling the year forward as needed) so the
// scheduler's query never has to reason about "which year" itself.
function nextOccurrence(dateStr, recurring) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return dateStr;
  if (!recurring) return dateStr; // one-time event — keep the exact date the customer chose
  const today = new Date(new Date().toDateString());
  const thisYear = new Date(d);
  thisYear.setFullYear(today.getFullYear());
  if (thisYear < today) thisYear.setFullYear(today.getFullYear() + 1);
  return thisYear.toISOString().slice(0, 10);
}

// Shared by the daily job and the admin "Send Now" button.
async function sendGiftReminder(r, settings) {
  const orderUrl = `${jobsSiteUrl()}/order`;
  const data = {
    name: r.name || 'there', recipient_name: r.recipient_name, occasion: r.occasion,
    event_date: r.event_date, order_url: orderUrl, site_name: settings.site_name
  };

  if (r.email) {
    await mailer.sendMail({
      to: r.email,
      subject: renderTemplate(settings.tmpl_gift_reminder_subject, data),
      html: renderTemplate(settings.tmpl_gift_reminder_body, data).replace(/\n/g, '<br>')
    });
  }
  const mdb = await db.getDB();
  if (r.recurring) {
    // Roll straight to next year and re-arm — a recurring reminder should
    // never need the customer to re-add it.
    const next = new Date(r.event_date + 'T00:00:00');
    next.setFullYear(next.getFullYear() + 1);
    await mdb.collection('gift_reminders').updateOne(
      { _id: r._id },
      { $set: { event_date: next.toISOString().slice(0, 10), reminder_sent: false } }
    );
  } else {
    await mdb.collection('gift_reminders').updateOne(
      { _id: r._id },
      { $set: { reminder_sent: true, reminder_sent_at: new Date().toISOString() } }
    );
  }
}

// Runs a few times a day rather than exactly at midnight — good enough for
// a "days before" reminder window and avoids relying on server timezone.
async function runGiftReminderJob() {
  try {
    const settings = await db.getAllSettings();
    const mdb = await db.getDB();
    const today = new Date(new Date().toDateString());
    const candidates = await mdb.collection('gift_reminders').find({ reminder_sent: false }).toArray();

    for (const r of candidates) {
      const eventDate = new Date(r.event_date + 'T00:00:00');
      if (isNaN(eventDate.getTime())) continue;
      const remindFrom = new Date(eventDate);
      remindFrom.setDate(remindFrom.getDate() - (r.remind_days_before || 7));
      if (today < remindFrom) continue;
      await sendGiftReminder(r, settings).catch(err =>
        console.error(`[gift-reminder] reminder failed for ${r.email}:`, err.message));
    }
  } catch (err) {
    console.error('[gift-reminder] job run failed:', err.message);
  }
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect('/admin/login');
}

function requireCustomer(req, res, next) {
  if (req.session && req.session.customerId) return next();
  return res.redirect('/account/login?next=' + encodeURIComponent(req.originalUrl));
}

function ah(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// =========================================================
// PUBLIC ROUTES
// =========================================================

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    `User-agent: *\n` +
    `Disallow: /admin\n` +
    `Disallow: /track-order\n` +
    `Allow: /\n\n` +
    `Sitemap: ${res.locals.siteUrl}/sitemap.xml\n`
  );
});

app.get('/sitemap.xml', ah(async (req, res) => {
  const base = res.locals.siteUrl;
  const today = new Date().toISOString().split('T')[0];
  const staticUrls = [
    { loc: '/', priority: '1.0', changefreq: 'daily' },
    { loc: '/portfolio', priority: '0.9', changefreq: 'daily' },
    { loc: '/order', priority: '0.8', changefreq: 'monthly' },
    { loc: '/about', priority: '0.7', changefreq: 'monthly' },
    { loc: '/blog', priority: '0.7', changefreq: 'weekly' },
    { loc: '/contact', priority: '0.6', changefreq: 'monthly' },
    { loc: '/privacy-policy', priority: '0.3', changefreq: 'yearly' },
    { loc: '/shipping-policy', priority: '0.3', changefreq: 'yearly' },
    { loc: '/refund-policy', priority: '0.3', changefreq: 'yearly' },
    { loc: '/cancellation-policy', priority: '0.3', changefreq: 'yearly' },
    { loc: '/terms', priority: '0.3', changefreq: 'yearly' }
  ];
  if (res.locals.settings.courses_enabled) staticUrls.push({ loc: '/courses', priority: '0.6', changefreq: 'weekly' });

  const artworks = db.normalize(await db.find('artworks', {}, { created_at: -1 }));
  const posts = db.normalize(await db.find('posts', { published: true }, { created_at: -1 }));

  const urlEntries = [
    ...staticUrls.map(u => ({ loc: base + u.loc, priority: u.priority, changefreq: u.changefreq, lastmod: today })),
    ...artworks.map(a => ({ loc: `${base}/portfolio/${a.id}`, priority: '0.6', changefreq: 'monthly', lastmod: (a.created_at ? new Date(a.created_at).toISOString().split('T')[0] : today) })),
    ...posts.map(p => ({ loc: `${base}/blog/${p.slug}`, priority: '0.5', changefreq: 'monthly', lastmod: (p.created_at ? new Date(p.created_at).toISOString().split('T')[0] : today) }))
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urlEntries.map(u =>
      `  <url><loc>${u.loc}</loc><lastmod>${u.lastmod}</lastmod><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`
    ).join('\n') +
    `\n</urlset>`;

  res.type('application/xml').send(xml);
}));

app.get('/', ah(async (req, res) => {
  // All of these reads are independent of each other, so running them in
  // parallel with Promise.all cuts total DB wait time on this (highest
  // traffic) page down to roughly the slowest single query instead of the
  // sum of ~14 sequential round-trips.
  const [
    featuredRaw, testimonialsRaw, videosRaw, services, offers, blocks,
    recentPosts, beforeAfterRaw, galleryPhotosRaw, instagramPhotosRaw,
    artTypes, categoryCardsRaw, faqsRaw, occasions, howItWorks
  ] = await Promise.all([
    db.find('artworks', { featured: true }, { created_at: -1 }, 8),
    db.find('testimonials', { approved: true }, { created_at: -1 }, 6),
    db.find('videos', {}, { created_at: -1 }, 12),
    getAllServices(),
    db.find('offers', { active: true }, { created_at: -1 }),
    db.find('blocks', {}, { created_at: 1 }),
    db.find('posts', { published: true }, { created_at: -1 }, 3),
    db.find('artworks', { before_image: { $exists: true, $ne: null } }, { created_at: -1 }, 6),
    db.find('gallery_photos', { approved: true }, { created_at: -1 }, 8),
    db.find('instagram_gallery', {}, { created_at: -1 }, 8),
    db.getArtTypes(),
    db.find('category_cards', {}),
    db.find('faqs', {}, { created_at: 1 }, 6),
    db.getOccasions(),
    db.getHowItWorks()
  ]);

  const featured = db.normalize(featuredRaw);
  const testimonials = db.normalize(testimonialsRaw).map(t => ({ ...t, embed_url: videoEmbedUrl(t.video_url) }));
  const videos = db.normalize(videosRaw).map(v => ({ ...v, embed_url: videoEmbedUrl(v.video_url) }));
  const recentPostsNorm = db.normalize(recentPosts);
  const beforeAfter = db.normalize(beforeAfterRaw).filter(a => a.image && a.before_image);
  const galleryPhotos = db.normalize(galleryPhotosRaw);
  const instagramPhotos = db.normalize(instagramPhotosRaw);
  const faqs = db.normalize(faqsRaw);

  // "Shop by Art Style" tiles — image, description, starting price and
  // button now come from the admin-managed category_cards collection
  // (see /admin/taxonomy). If admin hasn't set a card yet for a given art
  // type, we fall back to a sample artwork image so the section never
  // looks broken/empty while it's being filled in.
  const categoryCards = db.normalize(categoryCardsRaw);
  const categoryCardMap = {};
  categoryCards.forEach(function (c) { categoryCardMap[c.art_type] = c; });

  // The fallback artwork lookups (only run for categories missing an admin
  // image) are independent of each other too, so they're parallelized as
  // a second batch rather than looped with a sequential await inside.
  const topArtTypes = artTypes.slice(0, 8);
  const fallbackSamples = await Promise.all(topArtTypes.map(function (cat) {
    const card = categoryCardMap[cat];
    if (card && card.image) return null; // admin already set an image — no lookup needed
    return db.find('artworks', { category: cat }, { created_at: -1 }, 1);
  }));

  const categoryPreviews = topArtTypes.map(function (cat, i) {
    const card = categoryCardMap[cat];
    let image = card && card.image ? card.image : null;
    if (!image) {
      const sampleRaw = fallbackSamples[i];
      const sample = sampleRaw ? db.normalize(sampleRaw)[0] : null;
      image = sample ? sample.image : null;
    }
    return {
      name: cat,
      image: image,
      description: (card && card.description) || '',
      starting_price: (card && card.starting_price) || '',
      button_text: (card && card.button_text) || 'View Collection',
      button_link: (card && card.button_link) || ('/portfolio?category=' + encodeURIComponent(cat))
    };
  });

  res.render('index', { featured, testimonials, videos, services, offers, blocks, recentPosts: recentPostsNorm, beforeAfter, galleryPhotos, instagramPhotos, categoryPreviews, faqs, occasions, howItWorks });
}));

app.get('/portfolio', ah(async (req, res) => {
  // req.query.category must be a plain string before it goes into a DB
  // filter — Express parses bracket-style query strings like
  // ?category[$ne]=x into a nested object, which would otherwise let a
  // visitor inject a raw Mongo operator ($ne, $regex, etc.) into the query.
  const category = (typeof req.query.category === 'string' && req.query.category) || null;
  const search = (typeof req.query.search === 'string' ? req.query.search : '').trim();
  const filter = category ? { category } : {};
  let artworks = db.normalize(await db.find('artworks', filter, { created_at: -1 }));

  if (search) {
    const q = search.toLowerCase();
    artworks = artworks.filter(a =>
      (a.title || '').toLowerCase().includes(q) ||
      (a.description || '').toLowerCase().includes(q) ||
      (a.category || '').toLowerCase().includes(q)
    );
  }

  const categories = await db.getArtTypes();
  // Only look up wishlist state for logged-in customers — keeps the page fast
  // and avoids an unnecessary query for anonymous visitors.
  let wishlistIds = [];
  if (req.session && req.session.customerId) {
    const wishRows = await db.find('wishlist', { customer_id: req.session.customerId });
    wishlistIds = wishRows.map(w => w.artwork_id);
  }
  res.render('portfolio', { artworks, categories, activeCategory: category, searchQuery: search, wishlistIds });
}));

app.get('/portfolio/:id', ah(async (req, res) => {
  const artwork = db.normalize(await db.findById('artworks', req.params.id));
  if (!artwork) return res.status(404).send('Artwork not found');
// Best-effort match: a Service titled the same as this artwork's category
  // (e.g. "Pencil Art") carries the real per-size price table.
  const allServices = await getAllServices();
  const matchedService = allServices.find(s => (s.title || '').toLowerCase() === (artwork.category || '').toLowerCase()) || null;
  // "You Might Also Like" — other pieces in the same category first (most
  // relevant to someone already looking at this style), topped up with the
  // most recent artworks overall if the category doesn't have enough on its
  // own, so the section never looks sparse on a small catalog.
  let related = db.normalize(await db.find(
    'artworks',
    { category: artwork.category, _id: { $ne: new db.ObjectId(artwork.id) } },
    { created_at: -1 },
    4
  ));
  if (related.length < 4) {
    const excludeIds = [artwork.id, ...related.map(a => a.id)].map(id => new db.ObjectId(id));
    const fillers = db.normalize(await db.find(
      'artworks',
      { _id: { $nin: excludeIds } },
      { created_at: -1 },
      4 - related.length
    ));
    related = related.concat(fillers);
  }

  let isWishlisted = false;
  if (req.session && req.session.customerId) {
    isWishlisted = !!(await db.findOne('wishlist', { customer_id: req.session.customerId, artwork_id: artwork.id }));
  }

  const artworkReviews = db.normalize(await db.find('testimonials', { artwork_id: artwork.id, approved: true }, { created_at: -1 }))
    .map(t => ({ ...t, embed_url: videoEmbedUrl(t.video_url) }));

  res.render('artwork-detail', { artwork, related, isWishlisted, matchedService, artworkReviews });
}));

// Retired as a separate page — Services and the Shop/Portfolio catalog were
// two parallel systems (a hand-managed "services" list vs. the real product
// catalog), which is why the mega-menu links here felt broken: this page
// never showed actual, buyable pieces. Shop is now the single catalog.
// 301 keeps old bookmarks/search-engine links alive.
app.get('/services', (req, res) => res.redirect(301, '/portfolio'));

app.get('/about', ah(async (req, res) => {
  let testimonials = db.normalize(await db.find('testimonials', { approved: true }, { created_at: -1 }))
    .map(t => ({ ...t, embed_url: videoEmbedUrl(t.video_url) }));

  const reviewFilter = req.query.type || null; // 'video' | 'photo' | 'text'
  if (reviewFilter === 'video') testimonials = testimonials.filter(t => t.embed_url);
  else if (reviewFilter === 'photo') testimonials = testimonials.filter(t => t.photo_url && !t.embed_url);
  else if (reviewFilter === 'text') testimonials = testimonials.filter(t => !t.embed_url && !t.photo_url);

  const faqs = db.normalize(await db.find('faqs', {}, { created_at: 1 }));
  const studioPhotos = db.normalize(await db.find('studio_photos', {}, { created_at: 1 }));
  const awards = db.normalize(await db.find('awards', {}, { created_at: 1 }));
  const timeline = db.normalize(await db.find('timeline_milestones', {}, { created_at: 1 }));
  const videos = db.normalize(await db.find('videos', {}, { created_at: -1 })).slice(0, 6)
    .map(v => ({ ...v, embed_url: videoEmbedUrl(v.video_url) })).filter(v => v.embed_url);
  res.render('about', { testimonials, faqs, reviewFilter, studioPhotos, awards, timeline, videos });
}));

// Reserved for the future course platform (live classes, recorded courses,
// student dashboard). For now it's a waitlist page — this keeps the URL and
// nav slot stable so the real platform can slot in later without a redesign.
app.get('/courses', (req, res) => res.render('courses', { submitted: false }));

app.post('/courses/waitlist', ah(async (req, res) => {
  if (isSpamBot(req)) return res.render('courses', { submitted: true }); // silently drop, no tell for bots
  const { name, email } = req.body;
  if (name && email) {
    const mdb = await db.getDB();
    await mdb.collection('course_waitlist').updateOne(
      { email: String(email).toLowerCase().trim() },
      { $set: { name, email: String(email).toLowerCase().trim() }, $setOnInsert: { created_at: new Date().toISOString() } },
      { upsert: true }
    );
  }
  res.render('courses', { submitted: true });
}));

app.get('/contact', (req, res) => res.render('contact', { sent: false }));

app.post('/contact', ah(async (req, res) => {
  if (isSpamBot(req)) return res.render('contact', { sent: true }); // silently drop, no tell for bots
  const { name, email, phone, subject, message } = req.body;
  await db.insertOne('messages', { name, email, phone, subject, message, read: false });
  if (process.env.NOTIFY_EMAIL) {
    const s = res.locals.settings;
    const data = { name, email: email || '-', phone: phone || '-', subject: subject || '(no subject)', message, site_name: s.site_name };
    mailer.sendMail({ to: process.env.NOTIFY_EMAIL, subject: renderTemplate(s.tmpl_contact_form_admin_subject, data), html: renderTemplate(s.tmpl_contact_form_admin_body, data).replace(/\n/g, '<br>') });
  }
  res.render('contact', { sent: true });
}));

// Chat widget backend. Conversation history lives in the session (capped
// to the last few turns) so the model has short-term memory without a DB
// table. Failures never surface a raw error to the visitor — just a plain
// fallback message pointing them at Contact/WhatsApp instead.
app.post('/api/chat', ah(async (req, res) => {
  const userMessage = String((req.body && req.body.message) || '').trim();
  if (!userMessage) return res.status(400).json({ error: 'Message is required.' });
  if (userMessage.length > 800) return res.status(400).json({ error: 'Message is too long.' });

  if (!req.session.chatHistory) req.session.chatHistory = [];
  req.session.chatHistory.push({ role: 'user', content: userMessage });
  req.session.chatHistory = req.session.chatHistory.slice(-12);

if (!chatbot.isConfigured()) {
    return res.json({ reply: "Chat isn't set up on this site yet — please reach out via the Contact page or WhatsApp instead." });
  }

  try {
    const [artTypes, sizes, services] = await Promise.all([
      db.getArtTypes(),
      db.getSizes(),
      getAllServices()
    ]);
    const reply = await chatbot.chat(req.session.chatHistory, { artTypes, sizes, services, siteUrl: res.locals.siteUrl });
    req.session.chatHistory.push({ role: 'assistant', content: reply });
    req.session.chatHistory = req.session.chatHistory.slice(-12);
    res.json({ reply });
  } catch (err) {
    console.error('[chatbot] reply failed:', err.message);
    res.json({ reply: "Sorry, I'm having trouble replying right now — please reach us via the Contact page or WhatsApp instead." });
  }
}));
app.post('/newsletter', ah(async (req, res) => {
  if (isSpamBot(req)) return res.redirect(req.get('Referrer') || '/'); // silently drop, no tell for bots
  try { await db.insertOne('newsletter', { email: req.body.email }); } catch (e) {}
  res.redirect(req.get('Referrer') || '/');
}));

app.get('/order', ah(async (req, res) => {
  const blocked = await db.find('blocked_dates', {}, { date: 1 });
  const services = await getAllServices();
  const activeOffer = await db.findOne('offers', { active: true });
  const offerDiscount = activeOffer ? (activeOffer.discount_percent || 0) : 0;
  const old = {};
  if (req.query.art_type) old.art_type = req.query.art_type;
  if (req.query.size) old.size = req.query.size;
  if (req.query.frame) old.frame = req.query.frame;
  if (req.query.occasion) old.occasion = req.query.occasion;
  // Prefill contact + delivery address fields when they arrive as query params —
  // this is how "Use for New Order" on a saved address links here.
  ['name', 'phone', 'email', 'address_line', 'city', 'state', 'pincode'].forEach(f => {
    if (req.query[f]) old[f] = req.query[f];
  });
  // If nothing was passed in and the customer is logged in, quietly prefill
  // their contact details from their account so returning customers don't
  // have to retype their name/phone/email every single order.
  if (req.session && req.session.customerId) {
    const loggedInCustomer = await db.findById('customers', req.session.customerId);
    if (loggedInCustomer) {
      if (!old.name) old.name = loggedInCustomer.name;
      if (!old.phone && loggedInCustomer.phone) old.phone = loggedInCustomer.phone;
      if (!old.email && loggedInCustomer.email) old.email = loggedInCustomer.email;
    }
  }
  const presetPrice = req.query.price || '';
  res.render('order', { success: null, error: null, blockedDates: blocked.map(r => r.date), old, services, offerDiscount, presetPrice });
}));

 app.post('/order', (req, res, next) => {
  memoryUpload.single('reference_image')(req, res, (err) => {
    if (!err) return next();
    // Upload-specific failures (bad file type, too large) get a friendly,
    // in-context message instead of falling through to the generic 500 page —
    // the customer is mid-checkout and shouldn't lose their progress.
    (async () => {
      const blocked = await db.find('blocked_dates', {}, { date: 1 });
      const services = await getAllServices();
      const activeOffer = await db.findOne('offers', { active: true });
      const offerDiscount = activeOffer ? (activeOffer.discount_percent || 0) : 0;
      const message = err.message === 'INVALID_FILE_TYPE'
        ? 'That file doesn\'t look like a photo. Please upload a JPG or PNG image.'
        : 'That photo is too large to upload. Please choose a smaller photo (under 15MB).';
      res.render('order', { success: null, error: message, blockedDates: blocked.map(r => r.date), old: req.body, services, offerDiscount, presetPrice: req.body.preset_price || '' });
    })().catch(next);
  });
}, csrfCheck, ah(async (req, res) => {
  const { name, phone, email, art_type, size, delivery_date, estimated_price, address_line, city, state, pincode, coupon_code, frame, occasion } = req.body;
  // Fold the optional Frame Selection / Occasion (from the product page and
  // gift-occasion tiles) into the free-text notes field, so they show up
  // everywhere notes already do — admin, emails, tracking — with no schema change.
  const extraNoteParts = [];
  if (frame && frame !== 'No Frame') extraNoteParts.push(`Frame: ${frame}`);
  if (occasion) extraNoteParts.push(`Occasion: ${occasion}`);
  const notes = [extraNoteParts.join(' · '), req.body.notes].filter(Boolean).join(' — ');
  const blocked = await db.find('blocked_dates', {}, { date: 1 });
  const blockedDates = blocked.map(r => r.date);
  const services = await getAllServices();
  const activeOffer = await db.findOne('offers', { active: true });
  const offerDiscount = activeOffer ? (activeOffer.discount_percent || 0) : 0;

  if (delivery_date && blockedDates.includes(delivery_date)) {
    return res.render('order', { success: null, error: 'Sorry, that delivery date is not available. Please choose a different date.', blockedDates, old: req.body, services, offerDiscount, presetPrice: req.body.preset_price || '' });
  }
  if (!address_line || !city || !state || !pincode) {
    return res.render('order', { success: null, error: 'Please fill in your full delivery address.', blockedDates, old: req.body, services, offerDiscount, presetPrice: req.body.preset_price || '' });
  }

  // Referred-friend discount: if this customer signed up via someone's
  // referral link and hasn't placed an order yet, they get an automatic
  // first-order discount (percent set in Settings).
  let loggedInCustomer = null;
  let referralDiscount = 0;
  if (req.session && req.session.customerId) {
    loggedInCustomer = db.normalize(await db.findById('customers', req.session.customerId));
    referralDiscount = await referral.getFirstOrderDiscountPercent(loggedInCustomer);
  }

  // Re-check the coupon on the server — the client-side discount is only a
  // preview and must never be trusted for the final price or usage count.
  // Precedence: an actively-entered coupon always wins (matches the client
  // preview); otherwise the better of the referral discount or the passive
  // site-wide offer applies.
  let discount_percent_applied = Math.max(offerDiscount, referralDiscount);
  let appliedCouponCode = null;
  if (coupon_code) {
    const couponResult = await checkCoupon(coupon_code);
    if (couponResult.valid) {
      discount_percent_applied = couponResult.coupon.discount_percent;
      appliedCouponCode = couponResult.coupon.code;
    }
  }
  // Recompute the true base price server-side from the services list — never
  // trust the client-submitted estimated_price/discount_percent_applied,
  // since those are just hidden form fields anyone can edit before submitting.
  const matchedService = services.find(sv => sv.title === art_type);
  const verifiedBasePrice = parseFloat(String(priceForSize(matchedService, size) || '').replace(/[^0-9.]/g, '')) || null;
  const priceAfterDiscount = verifiedBasePrice
    ? (verifiedBasePrice - (verifiedBasePrice * discount_percent_applied / 100))
    : null; // Custom size (or unrecognised art type) — price to be confirmed manually, same as before

  // Wallet redemption — never trust a client-submitted amount, only whether
  // they ticked the box; the actual rupee value is capped server-side.
  const walletUsed = referral.calcWalletRedemption(loggedInCustomer, priceAfterDiscount, req.body.use_wallet === '1');
  const finalPrice = priceAfterDiscount !== null ? (priceAfterDiscount - walletUsed) : null;

  const order_code = genOrderCode();
  // Prefer the pre-compressed base64 image sent as a hidden field — the raw
  // <input type=file> handle can go stale on some Android Chrome versions
  // (ERR_UPLOAD_FILE_CHANGED), which was silently failing the whole order.
  const refImage = req.body.compressed_image_data
    ? await uploadImageDataUri(req.body.compressed_image_data, 'orders')
    : await uploadImage(req.file, 'orders');
  const newOrder = await db.insertOne('orders', { order_code, name, phone, email, art_type, size, reference_image: refImage, delivery_date, notes, estimated_price: finalPrice ? finalPrice.toFixed(0) : null, discount_percent_applied, coupon_code: appliedCouponCode, wallet_used: walletUsed || 0, address_line, city, state, pincode, status: 'Received', advance_amount: null, advance_payment_link: null, advance_paid: false, balance_amount: null, balance_payment_link: null, balance_paid: false, customer_id: (req.session && req.session.customerId) || null });
  if (appliedCouponCode) {
    const mdb = await db.getDB();
    await mdb.collection('coupons').updateOne({ code: appliedCouponCode }, { $inc: { used_count: 1 } });
  }
  if (walletUsed > 0 && loggedInCustomer) {
    await db.updateById('customers', loggedInCustomer.id, { wallet_balance: (loggedInCustomer.wallet_balance || 0) - walletUsed });
  }
  // They finished the order — don't send them an "you forgot something" reminder later.
  if (email) {
    const mdb = await db.getDB();
    await mdb.collection('order_progress').updateOne({ email: email.trim().toLowerCase() }, { $set: { converted: true } });
  }

  const s = res.locals.settings;
  const trackUrl = `${req.protocol}://${req.get('host')}/track-order`;
  const data = { name, order_code, art_type, size, notes, track_url: trackUrl, site_name: s.site_name };

  if (process.env.NOTIFY_EMAIL) {
    const addressLine = [address_line, city, state, pincode].filter(Boolean).join(', ');
    mailer.sendMail({ to: process.env.NOTIFY_EMAIL, subject: `New Order Received - ${order_code}`,
      html: `<h2>New Order</h2><p><b>ID:</b> ${escapeHtml(order_code)}</p><p><b>Name:</b> ${escapeHtml(name)}</p><p><b>Phone:</b> ${escapeHtml(phone)}</p><p><b>Email:</b> ${email ? escapeHtml(email) : '-'}</p><p><b>Type:</b> ${escapeHtml(art_type)} / ${escapeHtml(size)}</p><p><b>Coupon:</b> ${appliedCouponCode ? escapeHtml(appliedCouponCode) : '-'}</p><p><b>Delivery Address:</b> ${addressLine ? escapeHtml(addressLine) : '-'}</p><p><b>Date:</b> ${delivery_date ? escapeHtml(delivery_date) : '-'}</p><p><b>Notes:</b> ${notes ? escapeHtml(notes) : '-'}</p>` });
  }
  if (email) {
    mailer.sendMail({ to: email, subject: renderTemplate(s.tmpl_order_received_subject, data), html: renderTemplate(s.tmpl_order_received_body, data).replace(/\n/g, '<br>') });
  }
  notify.notifyOrder('order_received', { phone, order_code, customer_id: (req.session && req.session.customerId) || null }, data);

  // Online payment at checkout: only for orders with a real, server-verified
  // price (never a guessed/custom price) and only if the customer didn't
  // click "Pay Later". A Razorpay hiccup here must never lose the order that
  // was already saved above — fall through to the normal success screen.
  const skippedPayment = req.body.pay_now === '0';
  const checkoutPercent = parseFloat(s.checkout_advance_percent);
  const effectivePercent = isNaN(checkoutPercent) ? 100 : checkoutPercent;
  if (finalPrice && !skippedPayment && effectivePercent > 0 && razorpay.isConfigured()) {
    try {
      const payAmount = (finalPrice * effectivePercent / 100).toFixed(0);
      const link = await razorpay.createPaymentLink({
        amount: payAmount,
        description: `${effectivePercent >= 100 ? 'Payment' : 'Advance payment'} - ${order_code}`,
        name, phone, email,
        referenceId: `${order_code}-checkout-${Date.now()}`,
        callbackUrl: `${trackUrl}?order_code=${encodeURIComponent(order_code)}`
      });
      if (link) {
        await db.updateById('orders', newOrder.id, { status: 'Confirmed', advance_amount: payAmount, advance_payment_link: link.short_url, advance_payment_link_id: link.id, advance_paid: false });
        return res.redirect(link.short_url);
      }
    } catch (err) {
      console.error('[order] checkout payment link failed, falling back to pay-later:', err.message);
    }
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

// =========================================================
// Payment Webhooks
// =========================================================
// Razorpay calls this the instant a payment link is paid, so an order flips
// to "paid" automatically instead of waiting for the admin to notice and
// click the manual "Mark Paid" button. Configure this URL
// (https://yourdomain.com/webhooks/razorpay) under Razorpay Dashboard >
// Settings > Webhooks, subscribed to the "payment_link.paid" event, and put
// that webhook's secret in RAZORPAY_WEBHOOK_SECRET. See README "Payments Setup".
app.post('/webhooks/razorpay', ah(async (req, res) => {
  const signature = req.get('x-razorpay-signature');
  if (!razorpay.verifyWebhookSignature(req.rawBody, signature)) {
    console.warn('[webhooks/razorpay] Invalid or missing signature - ignoring');
    return res.status(400).send('Invalid signature');
  }

  if (req.body.event !== 'payment_link.paid') return res.json({ ok: true }); // not an event we act on

  const link = req.body.payload && req.body.payload.payment_link && req.body.payload.payment_link.entity;
  if (!link) return res.json({ ok: true });

  // We stored Razorpay's payment_link id on the order when we created it, so
  // we can match this webhook back to the right order and the right stage
  // (advance vs balance) without guessing from the amount alone.
  let order = db.normalize(await db.findOne('orders', { advance_payment_link_id: link.id }));
  let stage = 'advance';
  if (!order) {
    order = db.normalize(await db.findOne('orders', { balance_payment_link_id: link.id }));
    stage = 'balance';
  }
  if (!order) return res.json({ ok: true }); // not one of ours

  const s = res.locals.settings;
  const trackUrl = `${res.locals.siteUrl}/track-order`;

  if (stage === 'advance' && !order.advance_paid) {
    await db.updateById('orders', order.id, { advance_paid: true, status: 'In Progress' });
    const data = { name: order.name, order_code: order.order_code, status: 'In Progress', amount: order.advance_amount, track_url: trackUrl, site_name: s.site_name };
    if (order.email) await mailer.sendMail({ to: order.email, subject: renderTemplate(s.tmpl_status_update_subject, data), html: renderTemplate(s.tmpl_status_update_body, data).replace(/\n/g, '<br>') });
    if (process.env.NOTIFY_EMAIL) mailer.sendMail({ to: process.env.NOTIFY_EMAIL, subject: renderTemplate(s.tmpl_advance_paid_admin_subject, data), html: renderTemplate(s.tmpl_advance_paid_admin_body, data).replace(/\n/g, '<br>') });
    notify.notifyOrder('advance_paid', order, data);
  } else if (stage === 'balance' && !order.balance_paid) {
    await db.updateById('orders', order.id, { balance_paid: true });
    const data = { name: order.name, order_code: order.order_code, amount: order.balance_amount, site_name: s.site_name };
    if (process.env.NOTIFY_EMAIL) mailer.sendMail({ to: process.env.NOTIFY_EMAIL, subject: renderTemplate(s.tmpl_balance_paid_admin_subject, data), html: renderTemplate(s.tmpl_balance_paid_admin_body, data).replace(/\n/g, '<br>') });
    notify.notifyOrder('balance_paid', order, data);
  }

  res.json({ ok: true });
}));

// =========================================================
// Customer Accounts
// =========================================================
app.get('/account/signup', (req, res) => {
  if (req.session && req.session.customerId) return res.redirect('/account/dashboard');
  res.render('account/signup', { error: null, old: {}, refCode: req.query.ref || '' });
});

app.post('/account/signup', ah(async (req, res) => {
  const { name, email, phone, password, ref_code } = req.body;
  if (!name || !email || !password || password.length < 6) {
    return res.render('account/signup', { error: 'Please fill all fields. Password must be at least 6 characters.', old: req.body, refCode: ref_code || '' });
  }
  const existing = await db.findOne('customers', { email: email.toLowerCase().trim() });
  if (existing) {
    return res.render('account/signup', { error: 'An account with this email already exists. Please log in instead.', old: req.body, refCode: ref_code || '' });
  }
  const password_hash = bcrypt.hashSync(password, 10);
  const referral_code = await referral.generateUniqueReferralCode(name);
  const customer = await db.insertOne('customers', { name, email: email.toLowerCase().trim(), phone: phone || '', password_hash, referral_code, referred_by: null, wallet_balance: 0 });
  if (ref_code) await referral.linkReferralIfAny(customer, ref_code);
  req.session.customerId = customer.id;
  req.session.customerName = customer.name;
  res.redirect(req.query.next || '/account/dashboard');
}));

app.get('/account/login', (req, res) => {
  if (req.session && req.session.customerId) return res.redirect('/account/dashboard');
  res.render('account/login', { error: null, oldEmail: '' });
});

app.post('/account/login', loginLimiter, ah(async (req, res) => {
  const { email, password } = req.body;
  const customer = await db.findOne('customers', { email: (email || '').toLowerCase().trim() });
  if (!customer || !bcrypt.compareSync(password || '', customer.password_hash)) {
    return res.render('account/login', { error: 'Incorrect email or password.', oldEmail: email || '' });
  }
  req.session.customerId = customer._id.toString();
  req.session.customerName = customer.name;
  res.redirect(req.query.next || req.body.next || '/account/dashboard');
}));

app.post('/account/logout', (req, res) => {
  req.session.customerId = null;
  req.session.customerName = null;
  res.redirect('/');
});

app.get('/account/dashboard', requireCustomer, ah(async (req, res) => {
  const customer = db.normalize(await db.findById('customers', req.session.customerId));
  const orders = db.normalize(await db.find('orders', { customer_id: req.session.customerId }, { created_at: -1 }));
  res.render('account/dashboard', { customer, orders });
}));

app.get('/account/referrals', requireCustomer, ah(async (req, res) => {
  let customer = db.normalize(await db.findById('customers', req.session.customerId));
  // Older accounts created before this feature existed won't have a code yet —
  // generate one on first visit so nobody is left without a shareable link.
  if (!customer.referral_code) {
    const code = await referral.generateUniqueReferralCode(customer.name);
    await db.updateById('customers', customer.id, { referral_code: code });
    customer = db.normalize(await db.findById('customers', req.session.customerId));
  }
  const { rewardAmount, discountPercent } = await referral.getReferralSettings();
  const referrals = db.normalize(await db.find('referrals', { referrer_id: customer.id }, { created_at: -1 }));
  res.render('account/referrals', { customer, referrals, rewardAmount, discountPercent });
}));

// ---------- Profile ----------
app.get('/account/profile', requireCustomer, ah(async (req, res) => {
  const customer = db.normalize(await db.findById('customers', req.session.customerId));
  res.render('account/profile', {
    customer,
    profileSuccess: req.query.saved === '1',
    profileError: null,
    passwordSuccess: req.query.pw === '1',
    passwordError: null
  });
}));

app.post('/account/profile', requireCustomer, ah(async (req, res) => {
  const { name, phone } = req.body;
  if (!name || !name.trim()) {
    const customer = db.normalize(await db.findById('customers', req.session.customerId));
    return res.render('account/profile', { customer, profileSuccess: false, profileError: 'Name is required.', passwordSuccess: false, passwordError: null });
  }
  await db.updateById('customers', req.session.customerId, { name: name.trim(), phone: (phone || '').trim() });
  req.session.customerName = name.trim();
  res.redirect('/account/profile?saved=1');
}));

app.post('/account/password', requireCustomer, ah(async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  const customer = await db.findById('customers', req.session.customerId);
  const renderErr = (msg) => res.render('account/profile', {
    customer: db.normalize(customer), profileSuccess: false, profileError: null, passwordSuccess: false, passwordError: msg
  });

  if (!bcrypt.compareSync(current_password || '', customer.password_hash)) {
    return renderErr('Your current password is incorrect.');
  }
  if (!new_password || new_password.length < 6) {
    return renderErr('New password must be at least 6 characters.');
  }
  if (new_password !== confirm_password) {
    return renderErr('New password and confirmation do not match.');
  }
  const password_hash = bcrypt.hashSync(new_password, 10);
  await db.updateById('customers', req.session.customerId, { password_hash });
  res.redirect('/account/profile?pw=1');
}));

// ---------- Saved Addresses ----------
app.get('/account/addresses', requireCustomer, ah(async (req, res) => {
  const customer = db.normalize(await db.findById('customers', req.session.customerId));
  const addresses = db.normalize(await db.find('addresses', { customer_id: req.session.customerId }, { created_at: -1 }));
  res.render('account/addresses', { customer, addresses, addressError: null });
}));

app.post('/account/addresses', requireCustomer, ah(async (req, res) => {
  const { label, name, phone, address_line, city, state, pincode } = req.body;
  if (!name || !address_line || !city || !state || !pincode) {
    const customer = db.normalize(await db.findById('customers', req.session.customerId));
    const addresses = db.normalize(await db.find('addresses', { customer_id: req.session.customerId }, { created_at: -1 }));
    return res.render('account/addresses', { customer, addresses, addressError: 'Please fill in all the required address fields.' });
  }
  const isDefault = req.body.is_default === '1';
  // Only one address can be marked default — clear the flag on the rest
  // first so we never end up with two "defaults" showing at once.
  if (isDefault) {
    await db.getDB().then(d => d.collection('addresses').updateMany({ customer_id: req.session.customerId }, { $set: { is_default: false } }));
  }
  const existingCount = await db.count('addresses', { customer_id: req.session.customerId });
  await db.insertOne('addresses', {
    customer_id: req.session.customerId,
    label: (label || '').trim() || 'Address',
    name: name.trim(),
    phone: (phone || '').trim(),
    address_line: address_line.trim(),
    city: city.trim(),
    state: state.trim(),
    pincode: pincode.trim(),
    is_default: isDefault || existingCount === 0 // first saved address defaults automatically
  });
  res.redirect('/account/addresses');
}));

app.post('/account/addresses/:id/default', requireCustomer, ah(async (req, res) => {
  const db_ = await db.getDB();
  await db_.collection('addresses').updateMany({ customer_id: req.session.customerId }, { $set: { is_default: false } });
  await db.updateById('addresses', req.params.id, { is_default: true });
  res.redirect('/account/addresses');
}));

app.post('/account/addresses/:id/delete', requireCustomer, ah(async (req, res) => {
  // Ownership check — a customer can only ever delete their own saved address,
  // never one belonging to someone else even if they guess the id.
  const address = await db.findById('addresses', req.params.id);
  if (address && address.customer_id === req.session.customerId) {
    await db.deleteById('addresses', req.params.id);
  }
  res.redirect('/account/addresses');
}));

// ---------- Gift Reminders ----------
app.get('/account/gift-reminders', requireCustomer, ah(async (req, res) => {
  const customer = db.normalize(await db.findById('customers', req.session.customerId));
  const reminders = db.normalize(await db.find('gift_reminders', { customer_id: req.session.customerId }, { event_date: 1 }));
  res.render('account/gift-reminders-account', { customer, reminders, reminderError: null });
}));

app.post('/account/gift-reminders', requireCustomer, ah(async (req, res) => {
  const { recipient_name, occasion, event_date, remind_days_before, phone } = req.body;
  const isRecurring = req.body.recurring === '1';
  if (!recipient_name || !occasion || !event_date) {
    const customer = db.normalize(await db.findById('customers', req.session.customerId));
    const reminders = db.normalize(await db.find('gift_reminders', { customer_id: req.session.customerId }, { event_date: 1 }));
    return res.render('account/gift-reminders-account', { customer, reminders, reminderError: 'Please fill in the recipient, occasion and date.' });
  }
  const customer = await db.findById('customers', req.session.customerId);
  await db.insertOne('gift_reminders', {
    customer_id: req.session.customerId,
    name: customer.name,
    email: customer.email,
    phone: (phone || customer.phone || '').trim(),
    recipient_name: recipient_name.trim(),
    occasion: occasion.trim(),
    event_date: nextOccurrence(event_date, isRecurring),
    recurring: isRecurring,
    remind_days_before: Math.max(1, parseInt(remind_days_before, 10) || 7),
    reminder_sent: false
  });
  res.redirect('/account/gift-reminders');
}));

app.post('/account/gift-reminders/:id/delete', requireCustomer, ah(async (req, res) => {
  const reminder = await db.findById('gift_reminders', req.params.id);
  if (reminder && reminder.customer_id === req.session.customerId) {
    await db.deleteById('gift_reminders', req.params.id);
  }
  res.redirect('/account/gift-reminders');
}));

// ---------- Wishlist ----------
app.post('/wishlist/:artworkId/toggle', requireCustomer, ah(async (req, res) => {
  const existing = await db.findOne('wishlist', { customer_id: req.session.customerId, artwork_id: req.params.artworkId });
  if (existing) {
    await db.deleteById('wishlist', existing._id.toString());
  } else {
    await db.insertOne('wishlist', { customer_id: req.session.customerId, artwork_id: req.params.artworkId });
  }
  // Send the visitor back to wherever they clicked the heart from (portfolio
  // grid, artwork detail page, or the wishlist page itself when removing).
  res.redirect(req.body.redirect_to || req.get('Referer') || '/portfolio');
}));

app.get('/account/wishlist', requireCustomer, ah(async (req, res) => {
  const customer = db.normalize(await db.findById('customers', req.session.customerId));
  const wishRows = await db.find('wishlist', { customer_id: req.session.customerId }, { created_at: -1 });
  const artworkIds = wishRows.map(w => w.artwork_id).filter(Boolean);
  let artworks = [];
  if (artworkIds.length) {
    const db_ = await db.getDB();
    const validIds = artworkIds.filter(id => { try { new db.ObjectId(id); return true; } catch { return false; } });
    artworks = db.normalize(await db_.collection('artworks').find({ _id: { $in: validIds.map(id => new db.ObjectId(id)) } }).toArray());
    // Preserve most-recently-wished-first order rather than whatever order Mongo returns
    const orderIndex = artworkIds.reduce((acc, id, i) => { acc[id] = i; return acc; }, {});
    artworks.sort((a, b) => (orderIndex[a.id] ?? 999) - (orderIndex[b.id] ?? 999));
  }
  res.render('account/wishlist', { customer, artworks });
}));

// ---------- Notifications ----------
app.get('/account/notifications', requireCustomer, ah(async (req, res) => {
  const customer = db.normalize(await db.findById('customers', req.session.customerId));
  const notifications = db.normalize(await db.find('notifications', { customer_id: req.session.customerId }, { created_at: -1 }));
  // Viewing the page marks everything read — the bell badge clears next request.
  const mdb = await db.getDB();
  await mdb.collection('notifications').updateMany({ customer_id: req.session.customerId, read: false }, { $set: { read: true } });
  res.render('account/notifications', { customer, notifications });
}));

// ---------- Invoice ----------
app.get('/account/invoice/:id', requireCustomer, ah(async (req, res) => {
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (!order || order.customer_id !== req.session.customerId) {
    return res.status(404).send('Invoice not found.');
  }
  res.render('account/invoice', { order });
}));

app.post('/testimonials', memoryUpload.single('photo'), csrfCheck, ah(async (req, res) => {
  if (isSpamBot(req)) return res.redirect('/about?thanks=1'); // silently drop, no tell for bots
  const { name, message, rating, video_url, artwork_id, redirect_to } = req.body;
  const photoUrl = await uploadImage(req.file, 'reviews');
  // Only accept a video link if we can actually turn it into an embeddable
  // player — a broken/unsupported link is worse than no video at all.
  const validVideoUrl = videoEmbedUrl(video_url) ? video_url.trim() : null;
  // A review submitted while logged in is tied to a real customer account,
  // so it's fair to mark it verified automatically. Anonymous submissions
  // still need a human to confirm before they earn the badge.
  const isVerifiedCustomer = !!(req.session && req.session.customerId);
  // Only trust a same-site relative path here — never redirect off-domain.
  const safeRedirect = (redirect_to && redirect_to.startsWith('/')) ? redirect_to : '/about?thanks=1';
  await db.insertOne('testimonials', {
    name, message, rating: parseInt(rating) || 5, approved: false,
    photo_url: photoUrl || null,
    video_url: validVideoUrl,
    verified: isVerifiedCustomer,
    customer_id: (req.session && req.session.customerId) || null,
    artwork_id: artwork_id || null
  });
  if (process.env.NOTIFY_EMAIL) {
    const s = res.locals.settings;
    const data = { name, message, rating: parseInt(rating) || 5, site_name: s.site_name };
    mailer.sendMail({ to: process.env.NOTIFY_EMAIL, subject: renderTemplate(s.tmpl_new_review_admin_subject, data), html: renderTemplate(s.tmpl_new_review_admin_body, data).replace(/\n/g, '<br>') });
  }
  res.redirect(safeRedirect.includes('?') ? safeRedirect + '&thanks=1' : safeRedirect + '?thanks=1');
}));

// ---------- Customer Gallery ----------
// Distinct from Reviews above: this is a pure photo wall of buyers' framed
// portraits in their homes — no rating or review text required, just proof
// the finished piece looks great in real life. Same moderation pattern
// (submit unapproved, admin approves before it goes public).
const GALLERY_PAGE_SIZE = 24;
app.get('/gallery', ah(async (req, res) => {
  const allPhotos = db.normalize(await db.find('gallery_photos', { approved: true }, { created_at: -1 }));
  const photos = allPhotos.slice(0, GALLERY_PAGE_SIZE);
  res.render('gallery-public', { photos, submitted: req.query.thanks === '1', hasMore: allPhotos.length > GALLERY_PAGE_SIZE, pageSize: GALLERY_PAGE_SIZE });
}));

// Infinite-scroll pagination for the gallery masonry grid.
app.get('/gallery/photos.json', ah(async (req, res) => {
  const skip = Math.max(0, parseInt(req.query.skip) || 0);
  const allPhotos = db.normalize(await db.find('gallery_photos', { approved: true }, { created_at: -1 }));
  const page = allPhotos.slice(skip, skip + GALLERY_PAGE_SIZE);
  res.json({ photos: page, hasMore: skip + GALLERY_PAGE_SIZE < allPhotos.length });
}));

app.post('/gallery/submit', memoryUpload.single('photo'), csrfCheck, ah(async (req, res) => {
  if (isSpamBot(req)) return res.redirect('/gallery'); // silently drop, no tell for bots
  if (!req.file) {
    const allPhotos = db.normalize(await db.find('gallery_photos', { approved: true }, { created_at: -1 }));
    const photos = allPhotos.slice(0, GALLERY_PAGE_SIZE);
    return res.render('gallery-public', { photos, submitted: false, submitError: 'Please choose a photo to upload.', hasMore: allPhotos.length > GALLERY_PAGE_SIZE, pageSize: GALLERY_PAGE_SIZE });
  }
  const { name, caption } = req.body;
  const photoUrl = await uploadImage(req.file, 'customer-gallery');
  await db.insertOne('gallery_photos', {
    name: (name || '').trim() || 'A Happy Customer',
    caption: (caption || '').trim(),
    photo_url: photoUrl,
    approved: false,
    customer_id: (req.session && req.session.customerId) || null
  });
  res.redirect('/gallery?thanks=1');
}));

app.get('/blog', ah(async (req, res) => {
  const category = (typeof req.query.category === 'string' && req.query.category) || null;
  const filter = { published: true };
  if (category) filter.category = category;
  const posts = db.normalize(await db.find('posts', filter, { created_at: -1 }));
  const allPosts = category ? db.normalize(await db.find('posts', { published: true }, { created_at: -1 })) : posts;
  const categories = [...new Set(allPosts.map(p => p.category).filter(Boolean))];
  res.render('blog_list', { posts, categories, activeCategory: category });
}));

app.get('/blog/:slug', ah(async (req, res) => {
  const post = db.normalize(await db.findOne('posts', { slug: req.params.slug, published: true }));
  if (!post) return res.status(404).send('Post not found');
  res.render('blog_post', { post });
}));

app.get('/privacy-policy', (req, res) => res.render('privacy-policy'));
app.get('/shipping-policy', (req, res) => res.render('shipping-policy'));
app.get('/refund-policy', (req, res) => res.render('refund-policy'));
app.get('/cancellation-policy', (req, res) => res.render('cancellation-policy'));
app.get('/terms', (req, res) => res.render('terms'));

// =========================================================
// ADMIN ROUTES
// =========================================================

app.get('/admin/login', (req, res) => {
  if (req.session && req.session.isAdmin) return res.redirect('/admin/dashboard');
  res.render('admin/login', { error: null });
});

app.post('/admin/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  const validUser = username === process.env.ADMIN_USERNAME;
  const storedPass = process.env.ADMIN_PASSWORD || '';
  let validPass = storedPass.startsWith('$2') ? bcrypt.compareSync(password, storedPass) : password === storedPass;
  if (validUser && validPass) {
    // Regenerate the session on login (session fixation protection) — a
    // fresh session ID is issued now that the user has escalated to admin,
    // instead of reusing whatever pre-login session ID the browser had.
    return req.session.regenerate((err) => {
      if (err) {
        console.error('[admin login] session regenerate failed:', err);
        return res.render('admin/login', { error: 'Login failed, please try again.' });
      }
      req.session.isAdmin = true;
      res.redirect('/admin/dashboard');
    });
  }
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

  // Order status breakdown (for the dashboard bar chart)
  const statusList = ['Received','Confirmed','In Progress','Completed','Artwork Sent - Awaiting Confirmation','Customer Confirmed','Delivered','Cancelled'];
  const statusCounts = statusList
    .map(s => ({ status: s, count: allOrders.filter(o => o.status === s).length }))
    .filter(s => s.count > 0);
  const maxStatusCount = Math.max(1, ...statusCounts.map(s => s.count));

  // Orders placed per day, last 14 days
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const count = allOrders.filter(o => String(o.created_at || '').slice(0, 10) === key).length;
    days.push({ label: d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }), count });
  }
  const maxDayCount = Math.max(1, ...days.map(d => d.count));

  // Orders needing admin follow-up
  const now = new Date();
  const soon = new Date(now.getTime() + 3 * 86400000);
  const needsAttention = allOrders.filter(o => {
    if (o.status === 'Delivered' || o.status === 'Cancelled') return false;
    if (o.advance_amount && !o.advance_paid) return true;
    if (o.balance_amount && !o.balance_paid) return true;
    if (o.final_artwork_image && !o.customer_confirmed) return true;
    if (o.delivery_date) { const dd = new Date(o.delivery_date); if (dd >= now && dd <= soon) return true; }
    return false;
  }).slice(0, 8).map(o => {
    let reason = 'Delivery date coming up';
    if (o.advance_amount && !o.advance_paid) reason = 'Advance payment pending';
    else if (o.balance_amount && !o.balance_paid) reason = 'Balance payment pending';
    else if (o.final_artwork_image && !o.customer_confirmed) reason = 'Awaiting customer confirmation';
    return { ...o, reason };
  });

  res.render('admin/dashboard', { counts, recentOrders, finance, statusCounts, maxStatusCount, days, maxDayCount, needsAttention });
}));

// ---- Analytics ----
// Deeper trends than the Dashboard's snapshot: revenue and customer growth
// over time, and top-performing art types. All computed from existing
// collections — no new schema. Google Analytics traffic itself can't be
// embedded here without Google API/OAuth credentials, so this just surfaces
// whether GA is connected (via the Measurement ID already in Site Settings)
// and links out to the real GA dashboard.
app.get('/admin/analytics', requireAdmin, ah(async (req, res) => {
  const allOrders = db.normalize(await db.find('orders', {}, { created_at: -1 }));
  const allCustomers = db.normalize(await db.find('customers', {}, { created_at: -1 }));

  // Last 6 months, oldest to newest
  const monthKeys = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - i);
    monthKeys.push({ key: d.toISOString().slice(0, 7), label: d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }) });
  }

  const revenueByMonth = monthKeys.map(m => {
    let total = 0;
    allOrders.forEach(o => {
      const monthKey = String(o.created_at || '').slice(0, 7);
      if (monthKey !== m.key) return;
      if (o.advance_amount && o.advance_paid) total += parseFloat(o.advance_amount) || 0;
      if (o.balance_amount && o.balance_paid) total += parseFloat(o.balance_amount) || 0;
    });
    return { label: m.label, total };
  });
  const maxMonthRevenue = Math.max(1, ...revenueByMonth.map(m => m.total));

  const customersByMonth = monthKeys.map(m => ({
    label: m.label,
    count: allCustomers.filter(c => String(c.created_at || '').slice(0, 7) === m.key).length
  }));
  const maxMonthCustomers = Math.max(1, ...customersByMonth.map(m => m.count));

  // Top art types by order count
  const typeCounts = {};
  allOrders.forEach(o => {
    if (!o.art_type) return;
    typeCounts[o.art_type] = (typeCounts[o.art_type] || 0) + 1;
  });
  const topArtTypes = Object.entries(typeCounts)
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  const maxTypeCount = Math.max(1, ...topArtTypes.map(t => t.count));

  const nonCancelled = allOrders.filter(o => o.status !== 'Cancelled');
  const pricedOrders = nonCancelled.filter(o => o.estimated_price);
  const avgOrderValue = pricedOrders.length
    ? pricedOrders.reduce((sum, o) => sum + (parseFloat(o.estimated_price) || 0), 0) / pricedOrders.length
    : 0;

  res.render('admin/analytics', {
    revenueByMonth, maxMonthRevenue,
    customersByMonth, maxMonthCustomers,
    topArtTypes, maxTypeCount,
    avgOrderValue,
    totalOrders: nonCancelled.length,
    totalCustomers: allCustomers.length
  });
}));

// ---- Artworks ----
app.get('/admin/artworks', requireAdmin, ah(async (req, res) => {
  res.render('admin/artworks', { artworks: db.normalize(await db.find('artworks', {}, { created_at: -1 })) });
}));

app.get('/admin/artworks/new', requireAdmin, (req, res) => res.render('admin/artwork-form', { artwork: null, ai: null }));

app.get('/admin/artworks/:id/edit', requireAdmin, ah(async (req, res) => {
  const artwork = db.normalize(await db.findById('artworks', req.params.id));
  if (!artwork) return res.redirect('/admin/artworks');
  res.render('admin/artwork-form', { artwork, ai: req.query.ai || null });
}));

// AI image tools (Cloudinary add-ons) — background removal for artwork
// photos, and AI upscale for blurry reference photos. Both replace the
// artwork's live image with the transformed result and keep the very first
// original around (image_original) so it can be reverted.
app.post('/admin/artworks/:id/remove-bg', requireAdmin, ah(async (req, res) => {
  const artwork = await db.findById('artworks', req.params.id);
  if (!artwork || !artwork.image) return res.redirect('/admin/artworks');
  try {
    const newUrl = await cloudinaryTransform.removeBackground(artwork.image, 'artworks');
    await db.updateById('artworks', req.params.id, {
      image: newUrl,
      image_original: artwork.image_original || artwork.image
    });
    res.redirect(`/admin/artworks/${req.params.id}/edit?ai=bg_ok`);
  } catch (err) {
    console.error('[cloudinary-transform] background removal failed:', err.message);
    res.redirect(`/admin/artworks/${req.params.id}/edit?ai=bg_error`);
  }
}));

app.post('/admin/artworks/:id/upscale', requireAdmin, ah(async (req, res) => {
  const artwork = await db.findById('artworks', req.params.id);
  if (!artwork || !artwork.image) return res.redirect('/admin/artworks');
  try {
    const newUrl = await cloudinaryTransform.upscaleImage(artwork.image, 'artworks');
    await db.updateById('artworks', req.params.id, {
      image: newUrl,
      image_original: artwork.image_original || artwork.image
    });
    res.redirect(`/admin/artworks/${req.params.id}/edit?ai=upscale_ok`);
  } catch (err) {
    console.error('[cloudinary-transform] upscale failed:', err.message);
    res.redirect(`/admin/artworks/${req.params.id}/edit?ai=upscale_error`);
  }
}));

app.post('/admin/artworks/:id/revert-image', requireAdmin, ah(async (req, res) => {
  const artwork = await db.findById('artworks', req.params.id);
  if (!artwork || !artwork.image_original) return res.redirect('/admin/artworks');
  await db.updateById('artworks', req.params.id, { image: artwork.image_original });
  res.redirect(`/admin/artworks/${req.params.id}/edit?ai=revert_ok`);
}));

app.post('/admin/artworks/save', requireAdmin, memoryUpload.fields([{ name: 'image', maxCount: 1 }, { name: 'before_image', maxCount: 1 }]), csrfCheck, ah(async (req, res) => {
  const { id, title, category, description, story, size, price, featured, materials, estimated_creation_time } = req.body;
  const imageFile = req.files && req.files.image && req.files.image[0];
  const beforeFile = req.files && req.files.before_image && req.files.before_image[0];
  const uploadedUrl = await uploadImage(imageFile, 'artworks');
  const uploadedBeforeUrl = await uploadImage(beforeFile, 'artworks');
  const featuredVal = !!featured;
  if (id) {
    const existing = await db.findById('artworks', id);
    const image = uploadedUrl || (existing ? existing.image : null);
    const before_image = uploadedBeforeUrl || (existing ? existing.before_image : null);
    await db.updateById('artworks', id, { title, category, description, story, size, price, image, before_image, featured: featuredVal, materials, estimated_creation_time });
  } else {
    await db.insertOne('artworks', { title, category, description, story, size, price, image: uploadedUrl, before_image: uploadedBeforeUrl || null, featured: featuredVal, materials, estimated_creation_time });
  }
  res.redirect('/admin/artworks');
}));

app.post('/admin/artworks/:id/delete', requireAdmin, ah(async (req, res) => {
  await db.deleteById('artworks', req.params.id);
  res.redirect('/admin/artworks');
}));

// ---- Services ----
app.get('/admin/services', requireAdmin, ah(async (req, res) => {
  res.render('admin/services', { services: await getAllServices() });
}));

app.post('/admin/services/save', requireAdmin, memoryUpload.single('image'), csrfCheck, ah(async (req, res) => {
  const { id, title, description } = req.body;
  const prices = extractPrices(req.body);
  const uploadedUrl = await uploadImage(req.file, 'services');
  if (id) {
    const existing = await db.findById('services', id);
    const image = uploadedUrl || (existing ? existing.image : null);
    await db.updateById('services', id, { title, description, image, prices });
  } else {
    await db.insertOne('services', { title, description, image: uploadedUrl, prices });
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
  const q = (req.query.q || '').trim();
  const status = req.query.status || '';
  const sort = req.query.sort || 'newest';
  const filter = {};
  if (status) filter.status = status;
  if (q) {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ order_code: re }, { name: re }, { phone: re }, { email: re }];
  }
  const sortOpt = sort === 'oldest' ? { created_at: 1 } : { created_at: -1 };
  const orders = db.normalize(await db.find('orders', filter, sortOpt));
  res.render('admin/orders', { orders, q, status, sort });
}));

// ---- Customers (registered accounts, not guest checkouts) ----
app.get('/admin/customers', requireAdmin, ah(async (req, res) => {
  const q = (req.query.q || '').trim();
  const filter = {};
  if (q) {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: re }, { email: re }, { phone: re }];
  }
  const customers = db.normalize(await db.find('customers', filter, { created_at: -1 }));

  // Pull every order placed by any of these customers in one query, then
  // group counts/totals in JS — same lightweight approach used elsewhere in
  // this app rather than a Mongo aggregation pipeline.
  const emails = customers.map(c => (c.email || '').toLowerCase()).filter(Boolean);
  const orders = emails.length ? await db.find('orders', { email: { $in: emails } }, { created_at: -1 }) : [];
  const statsByEmail = {};
  orders.forEach(o => {
    const key = (o.email || '').toLowerCase();
    if (!key) return;
    if (!statsByEmail[key]) statsByEmail[key] = { count: 0, total: 0, lastOrderAt: o.created_at };
    statsByEmail[key].count += 1;
    statsByEmail[key].total += parseFloat(o.estimated_price) || 0;
    // orders were fetched newest-first, so the first one seen per email is the latest
  });

  const customersWithStats = customers.map(c => {
    const stats = statsByEmail[(c.email || '').toLowerCase()] || { count: 0, total: 0, lastOrderAt: null };
    return { ...c, order_count: stats.count, total_spent: stats.total, last_order_at: stats.lastOrderAt };
  });

  res.render('admin/customers', { customers: customersWithStats, q });
}));

app.post('/admin/orders/:id/status', requireAdmin, ah(async (req, res) => {
  await db.updateById('orders', req.params.id, { status: req.body.status });
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (order) {
    const s = res.locals.settings;
    const trackUrl = `${req.protocol}://${req.get('host')}/track-order`;
    const data = { name: order.name, order_code: order.order_code, status: order.status, track_url: trackUrl, site_name: s.site_name };
    if (order.email) {
      mailer.sendMail({ to: order.email, subject: renderTemplate(s.tmpl_status_update_subject, data), html: renderTemplate(s.tmpl_status_update_body, data).replace(/\n/g, '<br>') });
    }
    notify.notifyOrder('status_update', order, data);
    // Referral reward: pays out the referrer's wallet credit the first time
    // the referred friend's order reaches "Delivered".
    if (order.status === 'Delivered' && order.customer_id) {
      referral.rewardIfEligible(order.customer_id).catch(err => console.error('[referral] reward failed:', err.message));
    }
  }
  res.redirect('/admin/orders');
}));

app.get('/admin/orders/:id/advance', requireAdmin, ah(async (req, res) => {
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (!order) return res.redirect('/admin/orders');
  const est = parseFloat(order.estimated_price);
  const suggestedAmount = est ? (est * 0.5).toFixed(0) : null;
  res.render('admin/order-action', { order, actionType: 'advance', title: 'Request Advance Payment', actionUrl: `/admin/orders/${order.id}/advance`, defaultLink: res.locals.settings.default_payment_link, suggestedAmount, error: null });
}));

app.post('/admin/orders/:id/advance', requireAdmin, ah(async (req, res) => {
  const { amount } = req.body;
  let payment_link = (req.body.payment_link || '').trim();
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (!order) return res.redirect('/admin/orders');

  // If the admin left the link blank, auto-generate one via Razorpay instead
  // of requiring a manual paste every time.
  let advance_payment_link_id = null;
  if (!payment_link && razorpay.isConfigured()) {
    const link = await razorpay.createPaymentLink({
      amount,
      description: `Advance payment - ${order.order_code}`,
      name: order.name, phone: order.phone, email: order.email,
      referenceId: `${order.order_code}-advance-${Date.now()}`,
      callbackUrl: `${res.locals.siteUrl}/track-order?order_code=${encodeURIComponent(order.order_code)}`
    });
    if (link) { payment_link = link.short_url; advance_payment_link_id = link.id; }
  }
  if (!payment_link) {
    return res.render('admin/order-action', { order, actionType: 'advance', title: 'Request Advance Payment', actionUrl: `/admin/orders/${order.id}/advance`, defaultLink: res.locals.settings.default_payment_link, suggestedAmount: null, error: 'Enter a payment link, or configure Razorpay (see README) so one is generated automatically.' });
  }

  await db.updateById('orders', req.params.id, { status: 'Confirmed', advance_amount: amount, advance_payment_link: payment_link, advance_payment_link_id, advance_paid: false });
  const s = res.locals.settings;
  const trackUrl = `${req.protocol}://${req.get('host')}/track-order`;
  const data = { name: order.name, order_code: order.order_code, art_type: order.art_type, amount, payment_link, track_url: trackUrl, site_name: s.site_name };
  if (order.email) {
    await mailer.sendMail({ to: order.email, subject: renderTemplate(s.tmpl_advance_subject, data), html: renderTemplate(s.tmpl_advance_body, data).replace(/\n/g, '<br>') });
  }
  notify.notifyOrder('advance_requested', order, data);
  res.redirect('/admin/orders');
}));

app.post('/admin/orders/:id/advance-paid', requireAdmin, ah(async (req, res) => {
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (!order) return res.redirect('/admin/orders');
  await db.updateById('orders', req.params.id, { advance_paid: true, status: 'In Progress' });
  const s = res.locals.settings;
  const trackUrl = `${req.protocol}://${req.get('host')}/track-order`;
  const data = { name: order.name, order_code: order.order_code, status: 'In Progress', amount: order.advance_amount, track_url: trackUrl, site_name: s.site_name };
  if (order.email) {
    await mailer.sendMail({ to: order.email, subject: renderTemplate(s.tmpl_status_update_subject, data), html: renderTemplate(s.tmpl_status_update_body, data).replace(/\n/g, '<br>') });
  }
  if (process.env.NOTIFY_EMAIL) {
    mailer.sendMail({ to: process.env.NOTIFY_EMAIL, subject: renderTemplate(s.tmpl_advance_paid_admin_subject, data), html: renderTemplate(s.tmpl_advance_paid_admin_body, data).replace(/\n/g, '<br>') });
  }
  notify.notifyOrder('advance_paid', order, data);
  res.redirect('/admin/orders');
}));

app.get('/admin/orders/:id/reject', requireAdmin, ah(async (req, res) => {
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (!order) return res.redirect('/admin/orders');
  res.render('admin/order-action', { order, actionType: 'reject', title: 'Reject & Ask For a New Date', actionUrl: `/admin/orders/${order.id}/reject`, defaultLink: '', suggestedAmount: null, error: null });
}));

app.post('/admin/orders/:id/reject', requireAdmin, ah(async (req, res) => {
  const { reason } = req.body;
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (!order) return res.redirect('/admin/orders');
  await db.updateById('orders', req.params.id, { status: 'Date Rejected - Awaiting Reply' });
  const s = res.locals.settings;
  const trackUrl = `${req.protocol}://${req.get('host')}/track-order`;
  const data = { name: order.name, order_code: order.order_code, reason: reason || 'Requested date unavailable', track_url: trackUrl, site_name: s.site_name };
  if (order.email) {
    await mailer.sendMail({ to: order.email, subject: renderTemplate(s.tmpl_reject_subject, data), html: renderTemplate(s.tmpl_reject_body, data).replace(/\n/g, '<br>') });
  }
  notify.notifyOrder('rejected', order, data);
  res.redirect('/admin/orders');
}));

app.get('/admin/orders/:id/balance', requireAdmin, ah(async (req, res) => {
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (!order) return res.redirect('/admin/orders');
  let suggestedAmount = null;
  const est = parseFloat(order.estimated_price);
  const adv = parseFloat(order.advance_amount);
  if (est && adv) suggestedAmount = (est - adv).toFixed(0);
  res.render('admin/order-action', { order, actionType: 'balance', title: 'Request Balance (Final) Payment', actionUrl: `/admin/orders/${order.id}/balance`, defaultLink: res.locals.settings.default_payment_link, suggestedAmount, error: null });
}));

app.post('/admin/orders/:id/balance', requireAdmin, ah(async (req, res) => {
  const { amount } = req.body;
  let payment_link = (req.body.payment_link || '').trim();
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (!order) return res.redirect('/admin/orders');

  let balance_payment_link_id = null;
  if (!payment_link && razorpay.isConfigured()) {
    const link = await razorpay.createPaymentLink({
      amount,
      description: `Balance payment - ${order.order_code}`,
      name: order.name, phone: order.phone, email: order.email,
      referenceId: `${order.order_code}-balance-${Date.now()}`,
      callbackUrl: `${res.locals.siteUrl}/track-order?order_code=${encodeURIComponent(order.order_code)}`
    });
    if (link) { payment_link = link.short_url; balance_payment_link_id = link.id; }
  }
  if (!payment_link) {
    const est = parseFloat(order.estimated_price);
    const adv = parseFloat(order.advance_amount);
    const suggestedAmount = (est && adv) ? (est - adv).toFixed(0) : null;
    return res.render('admin/order-action', { order, actionType: 'balance', title: 'Request Balance (Final) Payment', actionUrl: `/admin/orders/${order.id}/balance`, defaultLink: res.locals.settings.default_payment_link, suggestedAmount, error: 'Enter a payment link, or configure Razorpay (see README) so one is generated automatically.' });
  }

  await db.updateById('orders', req.params.id, { status: 'Completed', balance_amount: amount, balance_payment_link: payment_link, balance_payment_link_id, balance_paid: false });
  const s = res.locals.settings;
  const trackUrl = `${req.protocol}://${req.get('host')}/track-order`;
  const data = { name: order.name, order_code: order.order_code, amount, payment_link, track_url: trackUrl, site_name: s.site_name };
  if (order.email) {
    await mailer.sendMail({ to: order.email, subject: renderTemplate(s.tmpl_balance_subject, data), html: renderTemplate(s.tmpl_balance_body, data).replace(/\n/g, '<br>') });
  }
  notify.notifyOrder('balance_requested', order, data);
  res.redirect('/admin/orders');
}));

app.post('/admin/orders/:id/balance-paid', requireAdmin, ah(async (req, res) => {
  const order = db.normalize(await db.findById('orders', req.params.id));
  await db.updateById('orders', req.params.id, { balance_paid: true });
  if (order) {
    const s = res.locals.settings;
    const data = { name: order.name, order_code: order.order_code, amount: order.balance_amount, site_name: s.site_name };
    if (process.env.NOTIFY_EMAIL) {
      mailer.sendMail({ to: process.env.NOTIFY_EMAIL, subject: renderTemplate(s.tmpl_balance_paid_admin_subject, data), html: renderTemplate(s.tmpl_balance_paid_admin_body, data).replace(/\n/g, '<br>') });
    }
    notify.notifyOrder('balance_paid', order, data);
  }
  res.redirect('/admin/orders');
}));

app.post('/admin/orders/:id/expenses', requireAdmin, ah(async (req, res) => {
  await db.updateById('orders', req.params.id, { expenses: req.body.expenses || 0 });
  res.redirect('/admin/orders');
}));

// ---- Packing ----
app.post('/admin/orders/:id/packing', requireAdmin, ah(async (req, res) => {
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (!order) return res.redirect('/admin/orders');
  await db.updateById('orders', req.params.id, { status: 'Packing' });
  const s = res.locals.settings;
  const data = { name: order.name, order_code: order.order_code, site_name: s.site_name };
  if (order.email) {
    await mailer.sendMail({ to: order.email, subject: renderTemplate(s.tmpl_packing_subject, data), html: renderTemplate(s.tmpl_packing_body, data).replace(/\n/g, '<br>') });
  }
  notify.notifyOrder('packing', order, data);
  res.redirect('/admin/orders');
}));

// ---- Shipped (quick, no tracking details) ----
app.post('/admin/orders/:id/shipped', requireAdmin, ah(async (req, res) => {
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (!order) return res.redirect('/admin/orders');
  await db.updateById('orders', req.params.id, { status: 'Shipped' });
  const s = res.locals.settings;
  const trackUrl = `${req.protocol}://${req.get('host')}/track-order`;
  const data = { name: order.name, order_code: order.order_code, track_url: trackUrl, site_name: s.site_name };
  if (order.email) {
    await mailer.sendMail({ to: order.email, subject: renderTemplate(s.tmpl_shipped_subject, data), html: renderTemplate(s.tmpl_shipped_body, data).replace(/\n/g, '<br>') });
  }
  notify.notifyOrder('shipped', order, data);
  res.redirect('/admin/orders');
}));

// ---- Tracking (adds courier + tracking number, use instead of/after "Mark as Sent") ----
app.get('/admin/orders/:id/tracking', requireAdmin, ah(async (req, res) => {
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (!order) return res.redirect('/admin/orders');
  res.render('admin/tracking', { order, error: null });
}));

app.post('/admin/orders/:id/tracking', requireAdmin, ah(async (req, res) => {
  const { courier_name, tracking_number, tracking_url } = req.body;
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (!order) return res.redirect('/admin/orders');
  if (!tracking_number && !tracking_url) {
    return res.render('admin/tracking', { order, error: 'Enter a tracking number or a tracking link.' });
  }
  await db.updateById('orders', req.params.id, { status: 'Shipped', courier_name, tracking_number, tracking_url });
  const s = res.locals.settings;
  const data = { name: order.name, order_code: order.order_code, courier_name, tracking_number, tracking_url, site_name: s.site_name };
  if (order.email) {
    await mailer.sendMail({ to: order.email, subject: renderTemplate(s.tmpl_tracking_subject, data), html: renderTemplate(s.tmpl_tracking_body, data).replace(/\n/g, '<br>') });
  }
  notify.notifyOrder('tracking', order, data);
  res.redirect('/admin/orders');
}));

// ---- Delivered (the true final step — separate from "Mark as Sent") ----
app.post('/admin/orders/:id/delivered', requireAdmin, ah(async (req, res) => {
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (!order) return res.redirect('/admin/orders');
  await db.updateById('orders', req.params.id, { status: 'Delivered' });
  const s = res.locals.settings;
  const data = { name: order.name, order_code: order.order_code, site_name: s.site_name };
  if (order.email) {
    await mailer.sendMail({ to: order.email, subject: renderTemplate(s.tmpl_delivered_subject, data), html: renderTemplate(s.tmpl_delivered_body, data).replace(/\n/g, '<br>') });
  }
  notify.notifyOrder('delivered', order, data);
  if (order.customer_id) {
    referral.rewardIfEligible(order.customer_id).catch(err => console.error('[referral] reward failed:', err.message));
  }
  res.redirect('/admin/orders');
}));

// ---- Progress Update (work-in-progress photo) ----
app.get('/admin/orders/:id/progress', requireAdmin, ah(async (req, res) => {
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (!order) return res.redirect('/admin/orders');
  res.render('admin/progress-update', { order });
}));

app.post('/admin/orders/:id/progress', requireAdmin, memoryUpload.single('progress_image'), csrfCheck, ah(async (req, res) => {
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (!order) return res.redirect('/admin/orders');
  const uploadedUrl = await uploadImage(req.file, 'progress');
  const progress_image = uploadedUrl || order.progress_image || null;
  await db.updateById('orders', req.params.id, { progress_image, progress_note: req.body.note || '', progress_sent_at: new Date().toISOString() });
  const s = res.locals.settings;
  const data = { name: order.name, order_code: order.order_code, art_type: order.art_type, progress_image, progress_note: req.body.note || '', site_name: s.site_name };
  if (order.email && progress_image) {
    await mailer.sendMail({ to: order.email, subject: renderTemplate(s.tmpl_progress_update_subject, data), html: renderTemplate(s.tmpl_progress_update_body, data).replace(/\n/g, '<br>') });
  }
  notify.notifyOrder('progress_update', order, data);
  res.redirect('/admin/orders');
}));

// ---- Making Video (link to a short process video) ----
app.get('/admin/orders/:id/making-video', requireAdmin, ah(async (req, res) => {
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (!order) return res.redirect('/admin/orders');
  res.render('admin/making-video', { order, error: null });
}));

app.post('/admin/orders/:id/making-video', requireAdmin, ah(async (req, res) => {
  const { video_url } = req.body;
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (!order) return res.redirect('/admin/orders');
  if (!video_url || !video_url.trim()) {
    return res.render('admin/making-video', { order, error: 'Paste a video link (YouTube, Instagram, or Google Drive).' });
  }
  await db.updateById('orders', req.params.id, { making_video_url: video_url.trim() });
  const s = res.locals.settings;
  const data = { name: order.name, order_code: order.order_code, art_type: order.art_type, video_url: video_url.trim(), site_name: s.site_name };
  if (order.email) {
    await mailer.sendMail({ to: order.email, subject: renderTemplate(s.tmpl_making_video_subject, data), html: renderTemplate(s.tmpl_making_video_body, data).replace(/\n/g, '<br>') });
  }
  notify.notifyOrder('making_video', order, data);
  res.redirect('/admin/orders');
}));

// ---- Review Request (send after delivery) ----
app.post('/admin/orders/:id/review-request', requireAdmin, ah(async (req, res) => {
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (!order) return res.redirect('/admin/orders');
  const s = res.locals.settings;
  const reviewUrl = `${res.locals.siteUrl}/about#leave-review`;
  const data = { name: order.name, order_code: order.order_code, art_type: order.art_type, review_url: reviewUrl, site_name: s.site_name };
  if (order.email) {
    await mailer.sendMail({ to: order.email, subject: renderTemplate(s.tmpl_review_request_subject, data), html: renderTemplate(s.tmpl_review_request_body, data).replace(/\n/g, '<br>') });
  }
  notify.notifyOrder('review_request', order, data);
  res.redirect('/admin/orders');
}));

// ---- Send Finished Artwork for Customer Confirmation ----
app.get('/admin/orders/:id/send-artwork', requireAdmin, ah(async (req, res) => {
  const order = db.normalize(await db.findById('orders', req.params.id));
  if (!order) return res.redirect('/admin/orders');
  res.render('admin/send-artwork', { order });
}));

app.post('/admin/orders/:id/send-artwork', requireAdmin, memoryUpload.single('artwork_image'), csrfCheck, ah(async (req, res) => {
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
  const s = res.locals.settings;
  const trackUrl = `${req.protocol}://${req.get('host')}/track-order?order_code=${encodeURIComponent(order.order_code)}`;
  const data = { name: order.name, order_code: order.order_code, art_type: order.art_type, artwork_image: final_artwork_image, artwork_note: req.body.note || '', track_url: trackUrl, site_name: s.site_name };
  if (order.email && final_artwork_image) {
    await mailer.sendMail({ to: order.email, subject: renderTemplate(s.tmpl_artwork_ready_subject, data), html: renderTemplate(s.tmpl_artwork_ready_body, data).replace(/\n/g, '<br>') });
  }
  notify.notifyOrder('artwork_ready', order, data);
  res.redirect('/admin/orders');
}));

// ---- Testimonials ----
app.get('/admin/testimonials', requireAdmin, ah(async (req, res) => {
  const testimonials = db.normalize(await db.find('testimonials', {}, { created_at: -1 }))
    .map(t => ({ ...t, embed_url: videoEmbedUrl(t.video_url) }));
  const artworks = db.normalize(await db.find('artworks', {}, { created_at: -1 }));
  res.render('admin/testimonials', { testimonials, artworks });
}));

app.post('/admin/testimonials/add', requireAdmin, memoryUpload.single('photo'), csrfCheck, ah(async (req, res) => {
  const { name, message, rating, video_url, artwork_id } = req.body;
  const photoUrl = await uploadImage(req.file, 'reviews');
  const validVideoUrl = videoEmbedUrl(video_url) ? video_url.trim() : null;
  // Reviews the admin adds directly (e.g. copied from Google/WhatsApp) are
  // auto-verified — the admin is vouching for them personally.
  await db.insertOne('testimonials', {
    name, message, rating: parseInt(rating) || 5, approved: true,
    photo_url: photoUrl || null, video_url: validVideoUrl, verified: true,
    artwork_id: artwork_id || null
  });
  res.redirect('/admin/testimonials');
}));

app.post('/admin/testimonials/:id/approve', requireAdmin, ah(async (req, res) => {
  await db.updateById('testimonials', req.params.id, { approved: true });
  res.redirect('/admin/testimonials');
}));

app.post('/admin/testimonials/:id/unapprove', requireAdmin, ah(async (req, res) => {
  await db.updateById('testimonials', req.params.id, { approved: false });
  res.redirect('/admin/testimonials');
}));

app.post('/admin/testimonials/:id/verify', requireAdmin, ah(async (req, res) => {
  const t = await db.findById('testimonials', req.params.id);
  await db.updateById('testimonials', req.params.id, { verified: !(t && t.verified) });
  res.redirect('/admin/testimonials');
}));

app.post('/admin/testimonials/:id/update', requireAdmin, ah(async (req, res) => {
  const { name, message, rating, artwork_id } = req.body;
  await db.updateById('testimonials', req.params.id, { name, message, rating: parseInt(rating) || 5, artwork_id: artwork_id || null });
  res.redirect('/admin/testimonials');
}));

app.post('/admin/testimonials/:id/delete', requireAdmin, ah(async (req, res) => {
  await db.deleteById('testimonials', req.params.id);
  res.redirect('/admin/testimonials');
}));

// ---- About Page Content: Studio Photos, Awards, Journey Timeline ----
// These are deliberately empty until the admin adds real entries — we never
// invent studio history, award names, or dates on the business's behalf.
app.get('/admin/about-content', requireAdmin, ah(async (req, res) => {
  const studioPhotos = db.normalize(await db.find('studio_photos', {}, { created_at: 1 }));
  const awards = db.normalize(await db.find('awards', {}, { created_at: 1 }));
  const timeline = db.normalize(await db.find('timeline_milestones', {}, { created_at: 1 }));
  res.render('admin/about-content', { studioPhotos, awards, timeline });
}));

app.post('/admin/about-content/studio-photo/add', requireAdmin, memoryUpload.single('photo'), csrfCheck, ah(async (req, res) => {
  const url = await uploadImage(req.file, 'studio');
  if (url) await db.insertOne('studio_photos', { image_url: url, caption: req.body.caption || '' });
  res.redirect('/admin/about-content');
}));
app.post('/admin/about-content/studio-photo/:id/delete', requireAdmin, csrfCheck, ah(async (req, res) => {
  await db.deleteById('studio_photos', req.params.id);
  res.redirect('/admin/about-content');
}));

app.post('/admin/about-content/award/add', requireAdmin, csrfCheck, ah(async (req, res) => {
  const { title, year, issuer } = req.body;
  if (title) await db.insertOne('awards', { title, year: year || '', issuer: issuer || '' });
  res.redirect('/admin/about-content');
}));
app.post('/admin/about-content/award/:id/delete', requireAdmin, csrfCheck, ah(async (req, res) => {
  await db.deleteById('awards', req.params.id);
  res.redirect('/admin/about-content');
}));

app.post('/admin/about-content/timeline/add', requireAdmin, csrfCheck, ah(async (req, res) => {
  const { year_label, text } = req.body;
  if (text) await db.insertOne('timeline_milestones', { year_label: year_label || '', text });
  res.redirect('/admin/about-content');
}));
app.post('/admin/about-content/timeline/:id/delete', requireAdmin, csrfCheck, ah(async (req, res) => {
  await db.deleteById('timeline_milestones', req.params.id);
  res.redirect('/admin/about-content');
}));

// ---- Customer Gallery ----
app.get('/admin/customer-gallery', requireAdmin, ah(async (req, res) => {
  const photos = db.normalize(await db.find('gallery_photos', {}, { created_at: -1 }));
  res.render('admin/gallery-admin', { photos });
}));

app.post('/admin/customer-gallery/:id/approve', requireAdmin, ah(async (req, res) => {
  await db.updateById('gallery_photos', req.params.id, { approved: true });
  res.redirect('/admin/customer-gallery');
}));

app.post('/admin/customer-gallery/:id/unapprove', requireAdmin, ah(async (req, res) => {
  await db.updateById('gallery_photos', req.params.id, { approved: false });
  res.redirect('/admin/customer-gallery');
}));

app.post('/admin/customer-gallery/:id/delete', requireAdmin, ah(async (req, res) => {
  await db.deleteById('gallery_photos', req.params.id);
  res.redirect('/admin/customer-gallery');
}));

// ---- Instagram Gallery (admin-managed — no Instagram API/login required) ----
app.get('/admin/instagram-gallery', requireAdmin, ah(async (req, res) => {
  const photos = db.normalize(await db.find('instagram_gallery', {}, { created_at: -1 }));
  res.render('admin/instagram-gallery', { photos });
}));

app.post('/admin/instagram-gallery/save', requireAdmin, memoryUpload.single('image'), csrfCheck, ah(async (req, res) => {
  const uploadedUrl = await uploadImage(req.file, 'instagram-gallery');
  if (!uploadedUrl) return res.redirect('/admin/instagram-gallery');
  await db.insertOne('instagram_gallery', { image_url: uploadedUrl, caption: req.body.caption || '', link_url: req.body.link_url || '' });
  res.redirect('/admin/instagram-gallery');
}));

app.post('/admin/instagram-gallery/:id/delete', requireAdmin, ah(async (req, res) => {
  await db.deleteById('instagram_gallery', req.params.id);
  res.redirect('/admin/instagram-gallery');
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

// ---- Course Waitlist (reserved for the future course platform) ----
app.get('/admin/course-waitlist', requireAdmin, ah(async (req, res) => {
  res.render('admin/course-waitlist', { signups: db.normalize(await db.find('course_waitlist', {}, { created_at: -1 })) });
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

// ---- Art Types & Sizes (drives Portfolio categories, the Artwork form,
//      Services pricing, and the Order form) ----
app.get('/admin/taxonomy', requireAdmin, ah(async (req, res) => {
  const artTypesList = await db.getArtTypes();
  const sizesList = await db.getSizes();
  const categoryCardsList = db.normalize(await db.find('category_cards', {}));
  const categoryCardMap = {};
  categoryCardsList.forEach(function (c) { categoryCardMap[c.art_type] = c; });
  res.render('admin/taxonomy', { artTypesList, sizesList, categoryCardMap });
}));

// Homepage "Choose Your Perfect Art Style" cards — one admin-editable record
// per art type (image, description, starting price, button). Lives on the
// same Taxonomy page since it's keyed off the same art-type list.
app.post('/admin/taxonomy/category-card/save', requireAdmin, memoryUpload.single('image'), csrfCheck, ah(async (req, res) => {
  const art_type = (req.body.art_type || '').trim();
  if (!art_type) return res.redirect('/admin/taxonomy');
  const description = req.body.description || '';
  const starting_price = req.body.starting_price || '';
  const button_text = req.body.button_text || '';
  const button_link = req.body.button_link || '';
  const uploadedUrl = await uploadImage(req.file, 'category-cards');
  const existing = db.normalize(await db.findOne('category_cards', { art_type }));
  const image = uploadedUrl || (existing ? existing.image : null);
  const data = { art_type, image, description, starting_price, button_text, button_link };
  if (existing) {
    await db.updateById('category_cards', existing.id, data);
  } else {
    await db.insertOne('category_cards', data);
  }
  res.redirect('/admin/taxonomy');
}));

app.post('/admin/taxonomy/art-types/add', requireAdmin, ah(async (req, res) => {
  const list = await db.getArtTypes();
  const val = (req.body.name || '').trim();
  if (val && !list.includes(val)) list.push(val);
  await db.saveArtTypes(list);
  res.redirect('/admin/taxonomy');
}));

app.post('/admin/taxonomy/art-types/delete', requireAdmin, ah(async (req, res) => {
  const list = (await db.getArtTypes()).filter(v => v !== req.body.value);
  await db.saveArtTypes(list);
  res.redirect('/admin/taxonomy');
}));

app.post('/admin/taxonomy/sizes/add', requireAdmin, ah(async (req, res) => {
  const list = await db.getSizes();
  const val = (req.body.name || '').trim();
  if (val && !list.includes(val)) list.push(val);
  await db.saveSizes(list);
  res.redirect('/admin/taxonomy');
}));

app.post('/admin/taxonomy/sizes/delete', requireAdmin, ah(async (req, res) => {
  const list = (await db.getSizes()).filter(v => v !== req.body.value);
  await db.saveSizes(list);
  res.redirect('/admin/taxonomy');
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

app.post('/admin/blog/save', requireAdmin, memoryUpload.single('cover_image'), csrfCheck, ah(async (req, res) => {
  const { id, title, excerpt, content, published, category } = req.body;
  const uploadedUrl = await uploadImage(req.file, 'blog');
  if (id) {
    const existing = await db.findById('posts', id);
    const cover_image = uploadedUrl || (existing ? existing.cover_image : null);
    await db.updateById('posts', id, { title, excerpt, content, cover_image, category, published: !!published });
  } else {
    let slug = slugify(title);
    const clash = await db.findOne('posts', { slug });
    if (clash) slug = slug + '-' + Date.now().toString().slice(-5);
    await db.insertOne('posts', { title, slug, excerpt, content, cover_image: uploadedUrl, category, published: !!published });
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

// ---- FAQs (shown on the About page) ----
app.get('/admin/faqs', requireAdmin, ah(async (req, res) => {
  res.render('admin/faqs', { faqs: db.normalize(await db.find('faqs', {}, { created_at: 1 })) });
}));

app.post('/admin/faqs/add', requireAdmin, ah(async (req, res) => {
  await db.insertOne('faqs', { question: req.body.question, answer: req.body.answer });
  res.redirect('/admin/faqs');
}));

app.post('/admin/faqs/:id/update', requireAdmin, ah(async (req, res) => {
  await db.updateById('faqs', req.params.id, { question: req.body.question, answer: req.body.answer });
  res.redirect('/admin/faqs');
}));

app.post('/admin/faqs/:id/delete', requireAdmin, ah(async (req, res) => {
  await db.deleteById('faqs', req.params.id);
  res.redirect('/admin/faqs');
}));

// ---- Settings ----
app.get('/admin/settings', requireAdmin, ah(async (req, res) => {
  res.render('admin/settings', {});
}));

app.post('/admin/settings/save', requireAdmin, memoryUpload.fields([{ name: 'logo', maxCount: 1 }, { name: 'hero_image', maxCount: 1 }, { name: 'about_image', maxCount: 1 }]), csrfCheck, ah(async (req, res) => {
  for (const [key, value] of Object.entries(req.body)) await db.setSetting(key, value);
  // Checkboxes are absent from req.body entirely when unchecked, so the generic
  // loop above can turn this ON but can never turn it back OFF. Handle it explicitly.
  await db.setSetting('courses_enabled', req.body.courses_enabled === 'on' ? 'on' : 'off');
  const logoFile = req.files && req.files.logo && req.files.logo[0];
  const heroFile = req.files && req.files.hero_image && req.files.hero_image[0];
  const uploadedLogo = await uploadImage(logoFile, 'logo');
  if (uploadedLogo) await db.setSetting('logo_url', uploadedLogo);
  const uploadedHero = await uploadImage(heroFile, 'hero');
  if (uploadedHero) await db.setSetting('hero_image_url', uploadedHero);
  const aboutFile = req.files && req.files.about_image && req.files.about_image[0];
  const uploadedAbout = await uploadImage(aboutFile, 'about');
  if (uploadedAbout) await db.setSetting('about_image_url', uploadedAbout);
  res.redirect('/admin/settings');
}));

// ---- Per-Page SEO (title/description for key pages, no code changes needed) ----
app.get('/admin/seo', requireAdmin, ah(async (req, res) => {
  res.render('admin/seo', {});
}));

app.post('/admin/seo/save', requireAdmin, ah(async (req, res) => {
  const seoKeys = [
    'seo_home_title', 'seo_home_description',
    'seo_shop_title', 'seo_shop_description',
    'seo_about_title', 'seo_about_description',
    'seo_contact_title', 'seo_contact_description',
    'seo_order_title', 'seo_order_description'
  ];
  for (const key of seoKeys) await db.setSetting(key, req.body[key] || '');
  res.redirect('/admin/seo');
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

app.post('/admin/offers/save', requireAdmin, memoryUpload.single('image'), csrfCheck, ah(async (req, res) => {
  const discount = parseFloat(req.body.discount_percent) || 0;
  const uploadedUrl = await uploadImage(req.file, 'offers');
  // A newly published offer becomes the one live offer, so the popup/banner
  // never end up showing more than one offer at once.
  const mdb = await db.getDB();
  await mdb.collection('offers').updateMany({}, { $set: { active: false } });
  await db.insertOne('offers', { title: req.body.title, message: req.body.message, discount_percent: discount, image: uploadedUrl, active: true });
  res.redirect('/admin/offers');
}));

app.post('/admin/offers/:id/toggle', requireAdmin, ah(async (req, res) => {
  const offer = await db.findById('offers', req.params.id);
  if (offer) {
    if (!offer.active) {
      // Turning one offer on turns every other offer off, so there is only
      // ever one live offer showing in the popup and homepage banner.
      const mdb = await db.getDB();
      await mdb.collection('offers').updateMany({}, { $set: { active: false } });
      await db.updateById('offers', req.params.id, { active: true });
    } else {
      await db.updateById('offers', req.params.id, { active: false });
    }
  }
  res.redirect('/admin/offers');
}));

app.post('/admin/offers/:id/delete', requireAdmin, ah(async (req, res) => {
  await db.deleteById('offers', req.params.id);
  res.redirect('/admin/offers');
}));

// ---- Coupon Codes ----
app.get('/admin/referrals', requireAdmin, ah(async (req, res) => {
  const referrals = db.normalize(await db.find('referrals', {}, { created_at: -1 }));
  // Look up names/emails for display without an N+1 query per row.
  const customerIds = [...new Set(referrals.flatMap(r => [r.referrer_id, r.referred_id]).filter(Boolean))];
  const mdb = await db.getDB();
  const customers = await mdb.collection('customers').find({ _id: { $in: customerIds.map(id => new db.ObjectId(id)) } }).toArray();
  const byId = {};
  customers.forEach(c => { byId[c._id.toString()] = c; });
  const rows = referrals.map(r => ({
    ...r,
    referrer_name: byId[r.referrer_id] ? byId[r.referrer_id].name : '—',
    referrer_email: byId[r.referrer_id] ? byId[r.referrer_id].email : '',
  }));
  const { rewardAmount, discountPercent } = await referral.getReferralSettings();
  res.render('admin/referrals', { referrals: rows, rewardAmount, discountPercent });
}));

app.post('/admin/referrals/settings', requireAdmin, ah(async (req, res) => {
  await db.setSetting('referral_reward_amount', String(parseFloat(req.body.reward_amount) || 200));
  await db.setSetting('referral_discount_percent', String(parseFloat(req.body.discount_percent) || 10));
  res.redirect('/admin/referrals');
}));

app.get('/admin/coupons', requireAdmin, ah(async (req, res) => {
  res.render('admin/coupons', { coupons: db.normalize(await db.find('coupons', {}, { created_at: -1 })) });
}));

app.post('/admin/coupons/save', requireAdmin, ah(async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const discount_percent = parseFloat(req.body.discount_percent) || 0;
  const max_uses = req.body.max_uses ? parseInt(req.body.max_uses) : null;
  const expires_at = req.body.expires_at || null;
  if (code && discount_percent > 0) {
    // Codes are unique — re-creating an existing code replaces its terms rather
    // than silently creating a confusing duplicate.
    const mdb = await db.getDB();
    await mdb.collection('coupons').deleteMany({ code });
    await db.insertOne('coupons', { code, discount_percent, max_uses, used_count: 0, expires_at, active: true });
  }
  res.redirect('/admin/coupons');
}));

app.post('/admin/coupons/:id/toggle', requireAdmin, ah(async (req, res) => {
  const coupon = await db.findById('coupons', req.params.id);
  if (coupon) await db.updateById('coupons', req.params.id, { active: !coupon.active });
  res.redirect('/admin/coupons');
}));

app.post('/admin/coupons/:id/delete', requireAdmin, ah(async (req, res) => {
  await db.deleteById('coupons', req.params.id);
  res.redirect('/admin/coupons');
}));

// Shared validity check used by both the live AJAX check and the final
// server-side re-check on order submission — so a customer can never bypass
// the rules by tampering with the client-side request.
async function checkCoupon(codeRaw) {
  const code = String(codeRaw || '').trim().toUpperCase();
  if (!code) return { valid: false, message: 'Enter a coupon code.' };
  const coupon = await db.findOne('coupons', { code });
  if (!coupon || !coupon.active) return { valid: false, message: 'That coupon code is not valid.' };
  if (coupon.expires_at && new Date(coupon.expires_at) < new Date(new Date().toDateString())) {
    return { valid: false, message: 'That coupon code has expired.' };
  }
  if (coupon.max_uses && (coupon.used_count || 0) >= coupon.max_uses) {
    return { valid: false, message: 'That coupon code has reached its usage limit.' };
  }
  return { valid: true, coupon };
}

app.post('/coupon/validate', express.json(), ah(async (req, res) => {
  const result = await checkCoupon(req.body.code);
  if (!result.valid) return res.json({ valid: false, message: result.message });
  res.json({ valid: true, discount_percent: result.coupon.discount_percent, message: `Coupon applied: ${result.coupon.discount_percent}% off` });
}));

// ---- Abandoned order recovery: silent auto-save while the customer fills the form ----
// Fired on a debounce from order.ejs once an email address is present. Upserts
// on email so re-saving just overwrites the same row instead of piling up
// duplicates. Never blocks or errors visibly to the customer — this is a
// best-effort background save, not part of the actual order submission.
app.post('/order/save-progress', express.json(), ah(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return res.json({ saved: false });
  const { name, phone, art_type, size, delivery_date, notes, address_line, city, state, pincode, estimated_price } = req.body;
  const mdb = await db.getDB();
  await mdb.collection('order_progress').updateOne(
    { email },
    {
      $set: {
        email, name, phone, art_type, size, delivery_date, notes,
        address_line, city, state, pincode, estimated_price,
        customer_id: (req.session && req.session.customerId) || null,
        updated_at: new Date().toISOString(),
        // Re-engaging (editing the form again) earns a fresh reminder window.
        reminder_sent: false
      },
      $setOnInsert: { created_at: new Date().toISOString(), converted: false }
    },
    { upsert: true }
  );
  res.json({ saved: true });
}));
// ---- Abandoned Order Recovery ----
app.get('/admin/abandoned-orders', requireAdmin, ah(async (req, res) => {
  const mdb = await db.getDB();
  const rows = await mdb.collection('order_progress').find({ converted: false }).sort({ updated_at: -1 }).limit(200).toArray();
  res.render('admin/abandoned-orders', { rows: db.normalize(rows) });
}));

app.post('/admin/abandoned-orders/settings', requireAdmin, ah(async (req, res) => {
  await db.setSetting('abandoned_recovery_enabled', req.body.enabled === '1' ? '1' : '0');
  await db.setSetting('abandoned_recovery_delay_hours', String(parseFloat(req.body.delay_hours) || 2));
  res.redirect('/admin/abandoned-orders');
}));

app.post('/admin/abandoned-orders/:id/send-now', requireAdmin, ah(async (req, res) => {
  const mdb = await db.getDB();
  const p = await mdb.collection('order_progress').findOne({ _id: new db.ObjectId(req.params.id) });
  if (p) {
    const settings = await db.getAllSettings();
    await sendAbandonedReminder(p, settings);
  }
  res.redirect('/admin/abandoned-orders');
}));

// ---- Gift Reminders ----
app.get('/admin/gift-reminders', requireAdmin, ah(async (req, res) => {
  const rows = db.normalize(await db.find('gift_reminders', {}, { event_date: 1 }));
  res.render('admin/gift-reminders-admin', { rows });
}));

app.post('/admin/gift-reminders/:id/send-now', requireAdmin, ah(async (req, res) => {
  const r = await db.findById('gift_reminders', req.params.id);
  if (r) {
    const settings = await db.getAllSettings();
    await sendGiftReminder(r, settings);
  }
  res.redirect('/admin/gift-reminders');
}));

app.post('/admin/gift-reminders/:id/delete', requireAdmin, ah(async (req, res) => {
  await db.deleteById('gift_reminders', req.params.id);
  res.redirect('/admin/gift-reminders');
}));

// =========================================================
// 404 — must be the LAST route registered, after everything else
// =========================================================
app.use((req, res) => {
  res.status(404).render('404');
});

// =========================================================
// GLOBAL ERROR HANDLER — catches everything ah() forwards via
// .catch(next), plus any other error passed to next(err).
// Must be registered LAST (after the 404 handler) since Express
// identifies error-handling middleware by its 4-argument signature,
// not by position relative to the 404 route.
// =========================================================
app.use((err, req, res, next) => {
  console.error('[unhandled error]', req.method, req.originalUrl, err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500);
  if (req.accepts('html')) {
    // Reuses the existing 404 view/branding as a graceful fallback so
    // visitors never see a raw stack trace. Swap in a dedicated
    // views/500.ejs later if you want a distinct "something went wrong"
    // message instead of the "page not found" copy.
    return res.render('404');
  }
  res.json({ error: 'Something went wrong. Please try again.' });
});

// =========================================================
// START SERVER
// =========================================================
db.initSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Kishor Kanna Arts running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[db] Failed to initialize database:', err);
    process.exit(1);
  });
