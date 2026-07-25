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
