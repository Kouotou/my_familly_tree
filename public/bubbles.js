// Public website only: a handful of iridescent soap bubbles drifting up behind the page,
// plus a gentle fade-in of sections as they scroll into view. Purely decorative.
(function(){
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const layer = document.createElement('div');
  layer.className = 'w-bubbles';
  layer.setAttribute('aria-hidden', 'true');

  const count = window.innerWidth < 720 ? 9 : 16;
  for (let i = 0; i < count; i++){
    const size = Math.round(28 + Math.pow(Math.random(), 1.6) * 150); // mostly small, a few large
    const b = document.createElement('div');
    b.className = 'w-bubble';
    b.style.width = size + 'px';
    b.style.height = size + 'px';
    b.style.left = (Math.random() * 96) + '%';
    const duration = 26 + Math.random() * 30 + size / 12; // big bubbles rise slower
    b.style.animationDuration = duration + 's';
    b.style.animationDelay = (-Math.random() * duration) + 's'; // start mid-flight, not all at the bottom
    if (reduced) b.style.bottom = (Math.random() * 90) + '%';

    const inner = document.createElement('div');
    inner.className = 'w-bubble-inner';
    inner.style.animationDuration = (5 + Math.random() * 5) + 's';
    inner.style.animationDelay = (-Math.random() * 6) + 's';
    b.appendChild(inner);
    layer.appendChild(b);
  }
  document.body.insertBefore(layer, document.body.firstChild);

  if (reduced || !('IntersectionObserver' in window)) return;
  const targets = document.querySelectorAll('.w-returning-card, .w-section-head, .w-about-card, .w-how-panel, .w-closing');
  const io = new IntersectionObserver((entries)=>{
    entries.forEach(e=>{ if (e.isIntersecting){ e.target.classList.add('w-in'); io.unobserve(e.target); } });
  }, { threshold: 0.12 });
  targets.forEach((el, i)=>{
    el.classList.add('w-reveal');
    if (el.classList.contains('w-about-card')) el.style.transitionDelay = ((i % 3) * 120) + 'ms';
    io.observe(el);
  });
})();
