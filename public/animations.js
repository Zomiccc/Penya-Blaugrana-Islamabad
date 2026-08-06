/* ==========================================================================
   PENYA BLAUGRANA ISLAMABAD — motion engine
   ========================================================================== */

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

document.addEventListener('DOMContentLoaded', () => {
  buildTifoWalls();
  initScrollReveal();
  initScrollProgress();
  initHeaderCondense();
  initCountdownTick();
  initLocalClocks();
});

/* ==========================================================================
   THE TIFO WALL
   A mosaic of cards, like the ones left on every seat at Camp Nou.
   Base pattern: blaugrana vertical bars, with the senyera (Catalan flag)
   banded across the lower third. Cards deal in diagonally on load, then
   light up gold around the pointer — a stand raising their cards as you pass.
   ========================================================================== */
const TIFO_COLORS = {
  blau: '#004D98',
  grana: '#A50044',
  gold: '#EDBB00',
  senyera: '#C60B1E',
  dark: '#0A1024',
};

function buildTifoWalls() {
  document.querySelectorAll('.tifo').forEach(buildTifo);
}

function buildTifo(wall) {
  const host = wall.parentElement;
  const cell = window.innerWidth < 760 ? 26 : 32;
  const gap = 3;

  let cols = 0;
  let rows = 0;
  const cards = [];

  const layout = () => {
    const w = host.offsetWidth;
    const h = host.offsetHeight;
    const nextCols = Math.ceil((w + gap) / (cell + gap));
    const nextRows = Math.ceil((h + gap) / (cell + gap));
    if (nextCols === cols && nextRows === rows) return;

    cols = nextCols;
    rows = nextRows;
    wall.style.gridTemplateColumns = `repeat(${cols}, ${cell}px)`;
    wall.style.gridAutoRows = `${cell}px`;

    wall.innerHTML = '';
    cards.length = 0;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const card = document.createElement('span');
        card.className = 'tifo-card';
        card.style.backgroundColor = tifoColor(c, r, rows);
        card.style.setProperty('--deal', `${(c + r) * 14}ms`);
        wall.appendChild(card);
        cards.push(card);
      }
    }

    // deal the cards in on a diagonal wave
    requestAnimationFrame(() => {
      wall.classList.add('dealt');
      const settle = (cols + rows) * 14 + 700;
      setTimeout(() => wall.classList.add('live'), REDUCED ? 0 : settle);
    });
  };

  layout();
  window.addEventListener('resize', debounce(layout, 250));

  if (REDUCED) return;

  /* ---- pointer response ---- */
  let lit = [];
  let queued = false;
  let px = -999;
  let py = -999;

  const paint = () => {
    queued = false;
    const box = wall.getBoundingClientRect();
    const cx = Math.floor((px - box.left) / (cell + gap));
    const cy = Math.floor((py - box.top) / (cell + gap));

    lit.forEach((el) => el.classList.remove('lit'));
    lit = [];
    if (cx < -2 || cy < -2 || cx > cols + 1 || cy > rows + 1) return;

    // a small diamond of cards around the cursor
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) + Math.abs(dy) > 2) continue;
        const c = cx + dx;
        const r = cy + dy;
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
        const el = cards[r * cols + c];
        if (el) { el.classList.add('lit'); lit.push(el); }
      }
    }
  };

  host.addEventListener('pointermove', (e) => {
    px = e.clientX;
    py = e.clientY;
    if (!queued) { queued = true; requestAnimationFrame(paint); }
  });
  host.addEventListener('pointerleave', () => {
    lit.forEach((el) => el.classList.remove('lit'));
    lit = [];
  });

  /* ---- automatic sweep, so the wall is alive on touch devices too ---- */
  const sweep = () => {
    if (document.hidden || !cards.length) return;
    for (let c = 0; c < cols; c++) {
      setTimeout(() => {
        for (let r = 0; r < rows; r++) {
          const el = cards[r * cols + c];
          if (!el) continue;
          el.classList.add('wave');
          setTimeout(() => el.classList.remove('wave'), 340);
        }
      }, c * 26);
    }
  };
  setTimeout(() => { sweep(); setInterval(sweep, 11000); }, 3200);
}

/* Base colour of a card at (col, row). */
function tifoColor(c, r, rows) {
  // senyera band across the bottom quarter: gold field, four red bars
  const bandStart = Math.floor(rows * 0.74);
  if (r >= bandStart) {
    return (r - bandStart) % 2 === 0 ? TIFO_COLORS.gold : TIFO_COLORS.senyera;
  }
  // blaugrana vertical bars, 3 cards wide
  const bar = Math.floor(c / 3) % 2;
  // fade the top rows toward the night sky so the header sits cleanly
  if (r < 2) return TIFO_COLORS.dark;
  return bar === 0 ? TIFO_COLORS.blau : TIFO_COLORS.grana;
}

/* ==========================================================================
   SCROLL REVEAL
   ========================================================================== */
function initScrollReveal() {
  const targets = document.querySelectorAll('.reveal, .reveal-left, .reveal-right, .reveal-scale, .reveal-stagger');
  if (!targets.length) return;

  if (!('IntersectionObserver' in window)) {
    targets.forEach((el) => el.classList.add('is-visible'));
    return;
  }

  // threshold:0 fires as soon as a single pixel is visible — this matters for
  // very tall sections (e.g. the privacy/statutes body, which can be several
  // viewports tall). A higher area-ratio threshold like 0.12 can never be
  // reached for content that tall, so it would stay invisible forever.
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  }, { threshold: 0, rootMargin: '0px 0px -10% 0px' });

  targets.forEach((el) => observer.observe(el));

  // Safety net: if any target is somehow never observed as visible (e.g. an
  // extremely tall or oddly-positioned element), force it visible after a
  // short delay so content can never be stuck invisible.
  setTimeout(() => {
    targets.forEach((el) => el.classList.add('is-visible'));
  }, 2500);
}

/* ==========================================================================
   SHIELD DIVIDERS — strips of tifo cards between sections
   ========================================================================== */
function initShieldDividers() {
  document.querySelectorAll('.shield-divider').forEach((el) => {
    if (el.children.length) return;
    const count = Math.min(60, Math.ceil(window.innerWidth / 22));
    for (let i = 0; i < count; i++) {
      const s = document.createElement('span');
      s.style.animationDelay = `${i * 22}ms`;
      el.appendChild(s);
    }
  });
}

/* ==========================================================================
   SCROLL PROGRESS BAR
   ========================================================================== */
function initScrollProgress() {
  const bar = document.createElement('div');
  bar.className = 'scroll-progress';
  document.body.appendChild(bar);

  let ticking = false;
  const update = () => {
    ticking = false;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const pct = max > 0 ? (window.scrollY / max) * 100 : 0;
    bar.style.width = `${pct}%`;
  };
  window.addEventListener('scroll', () => {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }, { passive: true });
  update();
}

/* ==========================================================================
   HEADER CONDENSE ON SCROLL
   ========================================================================== */
function initHeaderCondense() {
  const header = document.querySelector('header.site-header');
  if (!header) return;
  let ticking = false;
  const update = () => {
    ticking = false;
    header.classList.toggle('condensed', window.scrollY > 60);
  };
  window.addEventListener('scroll', () => {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }, { passive: true });
  update();
}

/* ==========================================================================
   COUNTDOWN TICK
   ========================================================================== */
function initCountdownTick() {
  const countdown = document.getElementById('countdown');
  if (!countdown) return;
  const digits = countdown.querySelectorAll('b');
  const last = new Map();

  setInterval(() => {
    digits.forEach((d) => {
      const val = d.textContent;
      if (last.has(d) && last.get(d) !== val) {
        d.classList.remove('tick');
        void d.offsetWidth;
        d.classList.add('tick');
      }
      last.set(d, val);
    });
  }, 400);
}

/* ==========================================================================
   LOCAL CLOCKS
   The thing every culer in Pakistan knows: kickoff lands in the middle of
   the night here. Show both cities honestly.
   ========================================================================== */
function initLocalClocks() {
  const bcn = document.getElementById('clockBarcelona');
  const isb = document.getElementById('clockIslamabad');
  if (!bcn && !isb) return;

  const fmt = (tz) => new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());

  const tick = () => {
    if (bcn) bcn.textContent = fmt('Europe/Madrid');
    if (isb) isb.textContent = fmt('Asia/Karachi');
  };
  tick();
  setInterval(tick, 1000 * 20);
}

/* ==========================================================================
   CELEBRATION — called only on a completed membership
   ========================================================================== */
function celebrate(x, y) {
  if (REDUCED) return;
  const colors = ['#EDBB00', '#FFD84A', '#A50044', '#004D98', '#ffffff'];
  const originX = x ?? window.innerWidth / 2;
  const originY = y ?? window.innerHeight / 3;

  for (let i = 0; i < 46; i++) {
    const piece = document.createElement('span');
    piece.className = 'confetti-piece';
    piece.style.background = colors[i % colors.length];
    piece.style.left = `${originX}px`;
    piece.style.top = `${originY}px`;
    document.body.appendChild(piece);

    const angle = Math.random() * Math.PI * 2;
    const dist = 90 + Math.random() * 220;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist - 120;

    const anim = piece.animate([
      { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
      { transform: `translate(${dx}px, ${dy + 320}px) rotate(${Math.random() * 900 - 450}deg)`, opacity: 0 },
    ], { duration: 1200 + Math.random() * 700, easing: 'cubic-bezier(.15,.6,.3,1)' });

    anim.onfinish = () => piece.remove();
  }
}
window.pbiCelebrate = celebrate;

/* ---------- utils ---------- */
function debounce(fn, wait) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}
