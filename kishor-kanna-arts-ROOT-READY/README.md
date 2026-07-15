# Kishor Kanna Arts — Website + Admin Panel

This is a complete, working website with:

- **Public site**: Home, Portfolio (with categories), Services, About Us, Contact, Order form (with photo upload), Order Tracking, Newsletter signup, Reviews, Privacy Policy, Terms.
- **Hidden Admin Panel** at `/admin/login` (not linked anywhere on the public site — only you know the URL):
  - Add/edit/delete artworks with photo upload
  - Add/edit/delete services and pricing
  - Add videos (paste a YouTube/Instagram/Drive link)
  - View and update order status (Received → Confirmed → In Progress → Completed → Delivered / Cancelled)
  - Approve or delete customer reviews/comments before they go live
  - Read and delete contact messages
  - View and export newsletter subscribers (CSV)
  - Edit site settings: banner text, About text, phone, email, address, social links

Customers can track their own order anytime at `/track-order` using their **Order ID + phone number** — no customer login needed.

---

## 1. What this is built with

- Node.js + Express (the web server)
- SQLite (a simple built-in database — no separate database server to manage)
- EJS (templates that generate the HTML pages)
- Everything (photos, orders, messages, subscribers) is stored in one file: `data/site.db`

---

## 2. Run it on your own computer first (recommended before going live)

1. Install [Node.js](https://nodejs.org) (version 18 or higher) if you don't have it.
2. Open a terminal in this project folder.
3. Copy the environment file and edit it:
   ```
   cp .env.example .env
   ```
   Open `.env` and set:
   - `ADMIN_USERNAME` and `ADMIN_PASSWORD` — this is **your** login for `/admin/login`. Change these from the defaults.
   - `SESSION_SECRET` — any long random text.
4. Install the required packages:
   ```
   npm install
   ```
5. Start the site:
   ```
   npm start
   ```
6. Open your browser:
   - Public site: http://localhost:3000
   - Admin panel: http://localhost:3000/admin/login

Log in with the username/password you set in `.env`. Add your artworks, services, and content before going live.

---

## 3. Making it live (Hostinger)

Hostinger's regular "shared hosting" plans are built for PHP/WordPress, not Node.js apps like this one. You have two good options:

### Option A — Hostinger Cloud/VPS with Node.js support (closest to your original plan)
1. In hPanel, choose a **VPS plan** or a hosting plan that lists **"Node.js"** under Auto Installer / Website settings.
2. Use the Node.js app manager to create a new Node.js application, pointing it at this project folder, with `server.js` as the entry file.
3. Upload the project files (everything except `node_modules` and `.env` — you'll set environment variables in the Node.js app panel instead).
4. In the Node.js app's environment variables section, add the same values from `.env.example` (your own `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SESSION_SECRET`, etc).
5. Click "Run npm install", then "Start/Restart" the app.
6. Point your domain `kishorkannaarts.in` to that application (Hostinger's Node.js app panel gives you this option, or you set it up as a subdomain/reverse proxy).

### Option B — A Node-friendly host (simplest, works today, free to start)
If your Hostinger plan turns out to be shared PHP hosting only (most budget plans are), the fastest route is a host built for Node.js apps:
- **Render.com** or **Railway.app** — both let you connect a GitHub repo and deploy a Node app in a few clicks, free tier available.
- Steps: push this project to a GitHub repository → create a new "Web Service" on Render/Railway → set the start command to `npm start` → add the same environment variables from `.env.example` → deploy.
- You can then point your `kishorkannaarts.in` domain (bought from Hostinger) to the Render/Railway app using a CNAME record — Hostinger's domain/DNS settings let you add this even if hosting is elsewhere.

Either way, the code itself doesn't change — only where it runs.

**Important:** Whichever host you use, the `data/` folder (your database) and `public/uploads/` folder (your photos) need to be on **persistent storage** — some free hosting tiers wipe files on restart. If your host mentions "ephemeral filesystem" or "persistent disk," make sure to enable/attach a persistent disk for the `data/` and `public/uploads/` folders.

---

## 3a. IMPORTANT: Why content disappears on Render's free tier (and how to fix it permanently)

**What's happening:** Render's free tier does not keep any files a running app writes — including your SQLite database (all your artworks, orders, settings) and uploaded photos. Free services also automatically go to sleep after ~15 minutes with no visitors, and when they wake back up, they start from a completely blank copy of your code — wiping anything added through the admin panel since the last deploy. This is true of every app on Render's free tier, not something specific to this project.

**The permanent fix — add a persistent disk (Render Starter plan, ~$7/month):**

1. Go to your Render service → **Settings** → scroll to **Disks**
2. Click **Add Disk**
   - Name: `data`
   - Mount Path: `/var/data`
   - Size: 1 GB is plenty to start
3. Render will prompt you to upgrade off the Free plan to attach a disk — choose **Starter**
4. Go to **Environment** tab, add:
   ```
   DATA_DIR=/var/data/db
   UPLOADS_DIR=/var/data/uploads
   ```
5. Save — Render redeploys automatically. From now on, everything you add through admin survives restarts and redeploys permanently.

**If you want to stay on the free tier for now:** the site still works, but treat it as a demo/testing environment — anything added through admin can vanish after periods of inactivity. Re-add your key content (artworks, settings, logo) any time it looks reset. This is fine while you're still setting things up, but isn't reliable for a real live business site taking real orders.

## 3b. Setting up Email (order notifications + newsletter)

Without this, the site still works — orders, tracking, everything — it just won't send emails.

**Important:** Render's free tier (and many free hosts) block outgoing SMTP connections — this is a security measure they apply to all free accounts, not something wrong with your setup. So Gmail SMTP will work if you run the site on your own PC, but will fail with a "Connection timeout" once deployed live on Render's free tier. Use **Brevo** instead — it sends email over a normal web connection, which isn't blocked.

### Setting up Brevo (recommended — works on Render free tier)
1. Go to https://www.brevo.com and sign up for a free account (300 emails/day free — plenty for a small business)
2. Once logged in, go to **Settings → Senders, Domains & Dedicated IPs → Senders** → add your email address as a sender (Brevo will send a verification email to it — click the link)
3. Go to **Settings → SMTP & API → API Keys** → click **Generate a new API key** → copy it
4. In Render → your service → **Environment** tab, add:
   ```
   BREVO_API_KEY=the_key_you_just_copied
   BREVO_SENDER_EMAIL=the_email_you_verified_as_a_sender
   MAIL_FROM_NAME=Kishor Kanna Arts
   NOTIFY_EMAIL=youraddress@gmail.com
   ```
5. Save — Render restarts automatically. Leave the `SMTP_*` variables out entirely (or blank) once Brevo is set up; the site automatically prefers Brevo when its API key is present.

### Alternative: Gmail SMTP (only works if running locally on your own PC)
If you're testing on your own computer (not deployed to Render), Gmail SMTP works fine:
1. Go to https://myaccount.google.com/security → turn on **2-Step Verification**
2. Go to https://myaccount.google.com/apppasswords → create one, copy the 16-character code
3. Set in your local `.env`:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=youraddress@gmail.com
   SMTP_PASS=abcdefghijklmnop        (16-character app password, no spaces)
   NOTIFY_EMAIL=youraddress@gmail.com
   ```

Once either is set, you'll get an email every time someone places an order, and customers get emails at every step: order received, advance payment request, balance payment request, rejection/reschedule, and shipped.

### Sending a newsletter
Go to `/admin/newsletter` — below the subscriber list there's a "Send Newsletter Update" box. Write a subject and message, click send — it goes to everyone who's signed up on the site.

## 3c. Logo and Offers/Updates

- **Logo**: go to `/admin/settings` → upload an image under "Logo" → save. It replaces the text site name in the header everywhere.
- **Offers/Updates banner**: go to `/admin/offers` → add a title + message (e.g. "20% Off This Week"). It appears as a highlighted banner near the top of your homepage. Turn any offer off/on anytime without deleting it.

## 3d. Order Workflow — What Emails Send Automatically, and When

Every email below is fully editable at `/admin/email-templates` — you can rewrite the wording anytime without touching code.

| When | What happens | Email sent to customer |
|---|---|---|
| Customer places an order | Order saved, you get notified at `NOTIFY_EMAIL` | "Order Received" confirmation with their Order ID |
| You click **Request Advance** on an order | You enter an amount + payment link, status becomes "Confirmed" | Advance payment request with your amount + link |
| You click **Reject / New Date** | You enter a reason, status becomes "Date Rejected - Awaiting Reply" | Asks them to reply with a new preferred date |
| You click **Request Balance** | You enter an amount + payment link, status becomes "Completed" | Final payment request with your amount + link |
| You click **Mark as Sent** | Status becomes "Delivered" | "Your order is on its way" notice |
| You manually change the status dropdown | Status updates | Generic "status updated" email |

**Payment links**: this site doesn't process payments itself — you generate a payment link elsewhere (a UPI collect link, a Razorpay/Instamojo Payment Link, a Google Pay link, etc.) and paste it in when you click Request Advance / Request Balance. Set a default one at `/admin/email-templates` so it's pre-filled each time, or type a fresh one per order.

**Tracking payment status**: once you request an advance or balance payment, the amount and a "Pay Now" button automatically show up on the customer's `/track-order` page — clearly marked Pending until you click **Mark Advance Paid** / **Mark Balance Paid** in `/admin/orders` (after you've checked the payment landed in your account), at which point it flips to a green "Paid" confirmation for the customer.

## 3e. Calendar / Availability

Go to `/admin/calendar` to block dates you can't deliver by (e.g. fully booked days, holidays). Customers won't be able to submit the order form with a blocked date selected — they'll be asked to choose another.

## 4. Keeping your site safe

- Change `ADMIN_PASSWORD` in `.env` to something only you know — never share it.
- The admin URL (`/admin/login`) is not linked from any public page, but it's not a secret from someone who guesses it — a strong password is your real protection.
- Back up the `data/site.db` file and `public/uploads/` folder regularly (copy them somewhere safe) — this is your entire website's content.

---

## 6. Complete Admin Panel Reference

| Menu item | What it's for |
|---|---|
| **Dashboard** | Quick overview: counts of artworks, orders, unread messages, pending reviews, subscribers |
| **Portfolio / Artworks** | Add/edit/delete artwork photos shown on your Portfolio and Home pages |
| **Services** | Your service list with A5/A4/A3/Custom pricing |
| **Videos** | Paste YouTube/Instagram links to show on the homepage |
| **Orders** | Every order placed; change status, request advance/balance payments, mark paid, reject/reschedule, mark as sent |
| **Calendar / Availability** | Block specific dates so customers can't select them when ordering |
| **Email Templates** | Edit the exact wording of all 6 automatic emails, and set your default payment link |
| **Reviews / Comments** | Approve or delete customer-submitted reviews; also add reviews directly yourself (e.g. copy one from Google Maps) |
| **Contact Messages** | Messages sent through your Contact page |
| **Offers / Updates** | Promotional banner shown on your homepage (e.g. "20% Off This Week") — turn on/off anytime |
| **Newsletter** | See everyone who's subscribed (via the footer signup form on every page) and send them an email update |
| **Site Settings** | Everything else: site name, banner text, About text, logo, phone/email/address, Google Maps, Google reviews link, social links — this is your general "content" page for text that appears across the site |

### Newsletter — how it actually works
- Customers subscribe themselves using the small email form in your site's **footer** (visible on every page) — no action needed from you for someone to join
- To send an update: go to **Newsletter**, scroll past the subscriber list to **"Send Newsletter Update"**, write a subject and message, click send — it emails everyone on the list at once
- **Newsletter sending requires email to be configured** (Part 3b above) — without it, nothing sends

### "Settings" — what it actually is
This is your general content-editing page — anything written in text across your site that isn't tied to a specific artwork/service/order lives here: your homepage banner wording, About Us paragraph, logo, contact details, and now your Google Maps link and Google reviews link. Whenever you want to reword something on the site that isn't a product/photo, this is where to look first.

## 7. Google Maps and Google Reviews

### Adding a map to your Contact page
1. Open **Google Maps** in your browser, search for your business/location
2. Click **Share** → **Embed a map** tab
3. Copy the link inside `src="..."` from the code shown (just the URL, not the whole `<iframe>` tag)
4. Go to `/admin/settings` → paste it into **Google Maps Embed Link** → Save
5. Your Contact page now shows a live map

### Showing Google reviews
Google doesn't allow pulling live reviews onto your own site without a paid Google Cloud API setup, so instead:
1. Get your Google Business review link: search your business on Google → click **Reviews** → there's usually a "Share" or direct link option — or use https://g.page/r/YOUR-BUSINESS-ID/review (find yours via Google Business Profile settings)
2. Go to `/admin/settings` → paste it into **Google Business Profile / Reviews Link** → Save
3. A **"See All Our Reviews on Google"** button now appears on your About and Contact pages, linking out to your real Google reviews

### Bringing your best Google reviews onto the site itself
Go to `/admin/testimonials` → scroll to **"Add a Review Directly"** → copy the text of a great review from Google Maps, paste the customer's name and their review text, publish. It appears immediately on your About/Home pages alongside reviews submitted through your own site.

## 8. Adding things later

Everything editable — artworks, services, videos, banner text, contact details — is done through the admin panel, no coding needed. If later you want:
- Online payments (UPI/cards)
- Customer accounts / login
- SMS or WhatsApp order notifications
- A booking calendar

...these are all natural next additions on top of this same codebase.
