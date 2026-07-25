// Reserved for future front-end enhancements (e.g. image lightbox, form validation).

// Scroll reveal animation — cards in the same grid stagger in slightly rather than
// popping in all at once, so sections feel choreographed instead of mechanical.
document.addEventListener('DOMContentLoaded', () => {
  const revealEls = document.querySelectorAll('.reveal');
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const grid = entry.target.closest('.grid');
        const siblings = grid ? Array.from(grid.children) : [entry.target];
        const index = siblings.indexOf(entry.target);
        const delay = index >= 0 ? Math.min(index, 5) * 80 : 0;
        entry.target.style.transitionDelay = delay + 'ms';
        entry.target.classList.add('in-view');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15 });
  revealEls.forEach(el => observer.observe(el));

  // Animated count-up for trust-bar style stats (e.g. "1000+ Portraits
  // Delivered") — counts from 0 once the stat scrolls into view. Small
  // touch, but it's the kind of thing that makes numbers feel earned
  // rather than just printed on the page.
  const countEls = document.querySelectorAll('.count-up');
  if (countEls.length && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const countObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        const target = parseFloat(el.dataset.countTo);
        const decimals = parseInt(el.dataset.decimals || '0', 10);
        const suffix = el.dataset.suffix || '';
        if (isNaN(target)) return;
        const duration = 1200;
        const start = performance.now();
        function tick(now) {
          const progress = Math.min((now - start) / duration, 1);
          const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
          el.textContent = (target * eased).toFixed(decimals) + suffix;
          if (progress < 1) requestAnimationFrame(tick);
          else el.textContent = target.toFixed(decimals) + suffix;
        }
        requestAnimationFrame(tick);
        countObserver.unobserve(el);
      });
    }, { threshold: 0.4 });
    countEls.forEach(el => countObserver.observe(el));
  } else if (countEls.length) {
    // Reduced-motion: just show the final numbers straight away.
    countEls.forEach(el => {
      const target = parseFloat(el.dataset.countTo);
      const decimals = parseInt(el.dataset.decimals || '0', 10);
      if (!isNaN(target)) el.textContent = target.toFixed(decimals) + (el.dataset.suffix || '');
    });
  }

  // Dark mode toggle (button with id="theme-toggle")
  const themeToggle = document.getElementById('theme-toggle');
  const savedTheme = localStorage.getItem('kka-theme');
  if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('kka-theme', next);
    });
  }
});
