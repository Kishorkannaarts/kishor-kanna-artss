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

  // Generic horizontal slider behaviour — used by the "Choose Your Perfect
  // Art Style" row (and any future [data-slider] block). Adds working
  // prev/next arrows, mouse drag-to-scroll, and native touch swipe, with
  // smooth animation and arrows that hide themselves once there's nothing
  // left to scroll to.
  document.querySelectorAll('[data-slider]').forEach(function (wrap) {
    var track = wrap.querySelector('[data-slider-track]');
    var prevBtn = wrap.querySelector('[data-slider-prev]');
    var nextBtn = wrap.querySelector('[data-slider-next]');
    if (!track) return;

    function cardWidth() {
      var card = track.querySelector('.style-card');
      return card ? card.getBoundingClientRect().width + 16 : track.clientWidth * 0.8;
    }

    function updateOverflowState() {
      var hasOverflow = track.scrollWidth > track.clientWidth + 4;
      wrap.classList.toggle('has-overflow', hasOverflow);
      if (prevBtn) prevBtn.style.visibility = track.scrollLeft > 8 ? 'visible' : 'hidden';
      if (nextBtn) {
        var atEnd = track.scrollLeft + track.clientWidth >= track.scrollWidth - 8;
        nextBtn.style.visibility = atEnd ? 'hidden' : 'visible';
      }
    }

    if (prevBtn) prevBtn.addEventListener('click', function () {
      track.scrollBy({ left: -cardWidth(), behavior: 'smooth' });
    });
    if (nextBtn) nextBtn.addEventListener('click', function () {
      track.scrollBy({ left: cardWidth(), behavior: 'smooth' });
    });

    // Mouse drag-to-scroll (desktop/trackpad users without a touchscreen).
    var isDown = false, startX = 0, startScroll = 0, dragged = false;
    track.addEventListener('mousedown', function (e) {
      isDown = true; dragged = false;
      startX = e.pageX; startScroll = track.scrollLeft;
      track.style.scrollBehavior = 'auto';
      track.style.cursor = 'grabbing';
    });
    window.addEventListener('mouseup', function () {
      isDown = false;
      track.style.scrollBehavior = '';
      track.style.cursor = '';
    });
    window.addEventListener('mousemove', function (e) {
      if (!isDown) return;
      var delta = e.pageX - startX;
      if (Math.abs(delta) > 4) dragged = true;
      track.scrollLeft = startScroll - delta;
    });
    // Suppress the click-through to a card link right after a drag.
    track.addEventListener('click', function (e) {
      if (dragged) { e.preventDefault(); e.stopPropagation(); dragged = false; }
    }, true);

    track.addEventListener('scroll', updateOverflowState, { passive: true });
    window.addEventListener('resize', updateOverflowState);
    updateOverflowState();
  });

  // Before & After comparison sliders (homepage). The range input sits
  // invisible on top of the images purely to capture drag/click input —
  // this listener is what actually moves the reveal and the handle.
  document.querySelectorAll('[data-ba]').forEach(function (slider) {
    var range = slider.querySelector('.ba-range');
    var before = slider.querySelector('.ba-before');
    var handle = slider.querySelector('.ba-handle');
    if (!range || !before || !handle) return;
    function update() {
      var val = range.value;
      before.style.clipPath = 'inset(0 ' + (100 - val) + '% 0 0)';
      handle.style.left = val + '%';
    }
    range.addEventListener('input', update);
    update();
  });
});
