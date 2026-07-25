/* ============================================
   KISHOR KANNA ARTS — PREMIUM DESIGN SYSTEM v1
   ============================================ */

@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;600;700;800&family=Inter:wght@400;500;600;700&display=swap');

:root {
  --color-white: #FFFFFF;
  --color-off-white: #FAFAF8;
  --color-charcoal: #1A1A1A;
  --color-charcoal-soft: #2B2B2B;
  --color-gold: #C9A24B;
  --color-gold-light: #E4C878;
  --color-gray: #6B6B6B;
  --color-gray-light: #E5E3DE;
  --color-accent: #7A5C3E;

  --bg-primary: var(--color-white);
  --bg-secondary: var(--color-off-white);
  --text-primary: var(--color-charcoal);
  --text-secondary: var(--color-gray);
  --border-color: var(--color-gray-light);

  --font-display: 'Playfair Display', Georgia, serif;
  --font-body: 'Inter', -apple-system, sans-serif;

  --space-xs: 8px;
  --space-sm: 16px;
  --space-md: 24px;
  --space-lg: 48px;
  --space-xl: 96px;

  --radius-sm: 8px;
  --radius-md: 16px;
  --radius-lg: 24px;
  --shadow-soft: 0 4px 24px rgba(26,26,26,0.06);
  --shadow-medium: 0 8px 40px rgba(26,26,26,0.10);
  --shadow-gold: 0 8px 30px rgba(201,162,75,0.25);

  --transition: 0.35s cubic-bezier(0.16, 1, 0.3, 1);
}

[data-theme="dark"] {
  --bg-primary: #0F0F0F;
  --bg-secondary: #1A1A1A;
  --text-primary: #F5F5F3;
  --text-secondary: #A8A8A8;
  --border-color: #2E2E2E;
}

.glass {
  background: rgba(255,255,255,0.65);
  backdrop-filter: blur(16px) saturate(180%);
  -webkit-backdrop-filter: blur(16px) saturate(180%);
  border: 1px solid rgba(255,255,255,0.3);
  box-shadow: var(--shadow-soft);
}
[data-theme="dark"] .glass {
  background: rgba(26,26,26,0.55);
  border: 1px solid rgba(255,255,255,0.08);
}

.btn-primary {
  background: var(--color-charcoal);
  color: var(--color-white);
}
.btn-primary:hover { box-shadow: var(--shadow-medium); background: #000; }

.btn-gold {
  background: linear-gradient(135deg, var(--color-gold), var(--color-gold-light));
  color: var(--color-charcoal);
  border: none;
}
.btn-gold:hover { box-shadow: var(--shadow-gold); transform: translateY(-2px); }

.hero-eyebrow {
  display: inline-block;
  padding: 6px 16px;
  border-radius: 100px;
  background: rgba(201,162,75,0.12);
  color: var(--color-gold);
  font-weight: 600;
  font-size: 0.8rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  margin-bottom: var(--space-sm);
}
.hero p.lead { font-size: 1.15rem; max-width: 480px; }
.hero-actions { display: flex; gap: 16px; margin-top: var(--space-md); flex-wrap: wrap; }
.hero-content { position: relative; z-index: 2; max-width: 640px; }

.reveal { opacity: 0; transform: translateY(24px); transition: opacity 0.8s ease, transform 0.8s ease; }
.reveal.in-view { opacity: 1; transform: translateY(0); }

.grid-2 { grid-template-columns: repeat(2, 1fr); }
.grid-3 { grid-template-columns: repeat(3, 1fr); }
.grid-4 { grid-template-columns: repeat(4, 1fr); }
@media (max-width: 900px) {
  .grid-3, .grid-4 { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 600px) {
  .grid-2, .grid-3, .grid-4 { grid-template-columns: 1fr; }
}

/* Phase 2 additions */
.trust-bar { padding: var(--space-md) 0; border-bottom: 1px solid var(--border-color); }
.trust-bar-inner {
  display: flex; justify-content: space-between; flex-wrap: wrap; gap: var(--space-md);
}
.trust-stat { display: flex; flex-direction: column; text-align: center; flex: 1; min-width: 120px; }
.trust-stat strong { font-family: var(--font-display); font-size: 1.6rem; color: var(--color-gold); }
.trust-stat span { font-size: 0.85rem; color: var(--text-secondary); }

.offer-banner {
  background: linear-gradient(135deg, #FFF7E5, #FDF0CE);
  border: 1px solid var(--color-gold-light);
  border-radius: var(--radius-sm);
  padding: 14px 20px;
  margin-bottom: 12px;
  text-align: center;
}

.timeline {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--space-md);
}
.timeline-step {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: var(--space-md);
  position: relative;
}
.timeline-num {
  width: 40px; height: 40px; border-radius: 50%;
  background: var(--color-charcoal); color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font-display); font-weight: 700; margin-bottom: 12px;
}
@media (max-width: 900px) { .timeline { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 600px) { .timeline { grid-template-columns: 1fr; } }

/* Phase 3 — nav additions */
.icon-btn {
  background: none; border: none; cursor: pointer; padding: 6px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--ink); border-radius: 50%; transition: background .15s;
}
.icon-btn:hover { background: rgba(0,0,0,0.06); }

.nav-mega-menu {
  position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
  margin-top: 12px; background: #fff; border: 1px solid var(--border-color, var(--border));
  border-radius: var(--radius-md, 12px); box-shadow: 0 20px 50px rgba(0,0,0,0.12);
  min-width: 460px; padding: 16px; display: grid; grid-template-columns: 1fr 1fr; gap: 4px; z-index: 60;
}
.nav-mega-menu a {
  display: flex; flex-direction: column; padding: 10px 12px; border-radius: 8px; gap: 2px;
}
.nav-mega-menu a:hover { background: var(--bg-secondary, var(--paper)); }
.nav-mega-menu a strong { font-size: 0.9rem; }
.nav-mega-menu a span { font-size: 0.78rem; color: var(--text-secondary, #888); }
.nav-mega-menu a::after { display: none; }
.nav-mega-viewall {
  grid-column: 1 / -1; text-align: center; font-weight: 600;
  border-top: 1px solid var(--border-color, var(--border)); margin-top: 6px; padding-top: 12px !important;
}

.search-bar {
  max-height: 0; overflow: hidden; border-bottom: 1px solid transparent;
  transition: max-height .3s ease, border-color .3s ease; background: var(--bg-primary, #fff);
}
.search-bar.open { max-height: 80px; border-bottom-color: var(--border-color, var(--border)); }
.search-bar input {
  flex: 1; padding: 10px 16px; border-radius: 100px; border: 1px solid var(--border-color, var(--border));
  font-family: var(--font-body); font-size: 0.95rem;
}
.search-bar input:focus { outline: none; border-color: var(--color-gold, var(--accent)); }

@media (max-width: 900px) {
  .nav-mega-menu { position: static; transform: none; min-width: auto; grid-template-columns: 1fr; box-shadow: none; border: none; margin-top: 4px; padding-left: 12px; }
}

/* Phase 4 — order wizard */
.wizard-box { max-width: 640px; margin: 0 auto; }
.wizard-progress {
  display: flex; justify-content: space-between; margin-bottom: var(--space-lg, 32px);
  position: relative;
}
.wizard-progress::before {
  content: ''; position: absolute; top: 16px; left: 5%; right: 5%; height: 2px;
  background: var(--border-color, #e5e3de); z-index: 0;
}
.wizard-step-dot {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  position: relative; z-index: 1; flex: 1;
}
.wizard-step-dot span {
  width: 32px; height: 32px; border-radius: 50%; background: #fff;
  border: 2px solid var(--border-color, #e5e3de); display: flex; align-items: center; justify-content: center;
  font-weight: 600; font-size: 0.85rem; color: var(--text-secondary, #888); transition: all .25s;
}
.wizard-step-dot label { font-size: 0.72rem; color: var(--text-secondary, #888); text-align: center; }
.wizard-step-dot.active span { background: var(--color-gold, #C9A24B); border-color: var(--color-gold, #C9A24B); color: #fff; }
.wizard-step-dot.active label { color: var(--text-primary, #1a1a1a); font-weight: 600; }
.wizard-step-dot.done span { background: var(--color-charcoal, #1a1a1a); border-color: var(--color-charcoal, #1a1a1a); color: #fff; }

.wizard-panel { display: none; animation: fadeSlide .35s ease; }
.wizard-panel.active { display: block; }
@keyframes fadeSlide { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

.wizard-nav { display: flex; justify-content: space-between; margin-top: 24px; gap: 12px; }
.upload-preview img { display: block; }

@media (max-width: 500px) {
  .wizard-step-dot label { display: none; }
}

/* Phase 5 — order tracking */
.track-card { margin-bottom: 4px; }
.track-header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.track-percent {
  background: var(--color-gold, #C9A24B); color: #fff; font-weight: 700; font-size: 0.85rem;
  padding: 4px 14px; border-radius: 100px;
}

.progress-line-outer {
  height: 6px; background: var(--border-color, #e5e3de); border-radius: 100px; overflow: hidden; margin-bottom: 24px;
}
.progress-line-inner {
  height: 100%; background: linear-gradient(90deg, var(--color-gold, #C9A24B), var(--color-gold-light, #E4C878));
  border-radius: 100px; transition: width 0.6s ease;
}

.track-details p { margin: 6px 0; font-size: 0.92rem; }

.track-payment-box {
  margin-top: 14px; padding: 16px; border-radius: var(--radius-md, 10px); border: 1px solid;
}
.track-payment-box.paid { background: #e6f4ea; border-color: #b7e0c4; }
.track-payment-box.pending { background: #fff2cc; border-color: #e6cf87; }
.track-payment-box.neutral { background: #eef2f7; border-color: #d5dee8; }

.track-artwork-box {
  margin-top: 20px; padding: 18px; border-radius: var(--radius-md, 10px);
  background: var(--bg-secondary, #f4efe8); border: 1px solid var(--border-color, #e5e3de);
}

/* Phase 6 — breadcrumbs */
.breadcrumbs {
  font-size: 0.82rem; color: var(--text-secondary, #888); margin: 12px 0 4px;
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px;
}
.breadcrumbs a { color: var(--text-secondary, #888); }
.breadcrumbs a:hover { color: var(--color-gold, #C9A24B); }
.crumb-sep { margin: 0 4px; opacity: 0.5; }
.crumb-current { color: var(--text-primary, #1a1a1a); font-weight: 500; }
