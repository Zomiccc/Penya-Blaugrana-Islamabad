document.addEventListener('DOMContentLoaded', () => {
  const burger = document.querySelector('.hamburger');
  const nav = document.querySelector('.main-nav');
  if (burger && nav) {
    // Create backdrop element
    const backdrop = document.createElement('div');
    backdrop.className = 'nav-backdrop';
    backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9998;opacity:0;visibility:hidden;transition:opacity 0.3s ease,visibility 0.3s ease;pointer-events:none;';
    document.body.appendChild(backdrop);

    const setMenu = (open) => {
      nav.classList.toggle('open', open);
      burger.classList.toggle('open', open);
      burger.setAttribute('aria-expanded', String(open));
      burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      
      // Toggle backdrop
      if (open) {
        backdrop.style.opacity = '1';
        backdrop.style.visibility = 'visible';
        backdrop.style.pointerEvents = 'auto';
        document.body.style.overflow = 'hidden';
      } else {
        backdrop.style.opacity = '0';
        backdrop.style.visibility = 'hidden';
        backdrop.style.pointerEvents = 'none';
        document.body.style.overflow = '';
      }
    };
    setMenu(false);
    
    // Close menu when clicking backdrop
    backdrop.addEventListener('click', () => setMenu(false));
    
    burger.addEventListener('click', () => setMenu(!nav.classList.contains('open')));
    burger.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setMenu(!nav.classList.contains('open')); }
    });
    nav.querySelectorAll('a').forEach(a => a.addEventListener('click', () => setMenu(false)));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
  }

  const countdownEl = document.getElementById('countdown');
  const scrollEl = document.getElementById('fixtureScroll');
  const nextStripEl = document.getElementById('nextMatchStrip');
  const venueLineEl = document.getElementById('venueLine');
  if (countdownEl || scrollEl) {
    initLiveFixtures({ countdownEl, scrollEl, nextStripEl, venueLineEl });
  }

  // Fixtures page (fixtures.html) — render the full list
  const fixturesListEl = document.getElementById('fixturesList');
  if (fixturesListEl) {
    initFixturesPage(fixturesListEl);
  }

  // Join flyer vertical scroller (index.html)
  const flyerList = document.getElementById('flyerList');
  if (flyerList) {
    initFlyerScroll(flyerList);
  }
});

/* ==========================================================================
   JOIN FLYER — one name at a time, 60s per name
   Only ONE row is ever visible. A name fades in, stays for 60 seconds,
   then fades out and the next name fades in. Never two names at once.
   ========================================================================== */
function initFlyerScroll(listEl) {
  const baseItems = Array.from(listEl.children);
  if (!baseItems.length) return;

  const messages = baseItems.map((el) => el.textContent.trim()).filter(Boolean);
  if (!messages.length) return;

  listEl.innerHTML = '';
  listEl.removeAttribute('style');

  const track = document.createElement('div');
  track.className = 'flyer-track';
  listEl.appendChild(track);

  // Repeat the names so the rotation cycles longer before repeating
  const pool = [];
  for (let i = 0; i < 5; i++) pool.push(...messages);

  let idx = 0;

  function fadeIn(row) {
    row.style.opacity = '0';
    row.style.transform = 'translateY(12px)';
    row.style.transition = 'opacity .5s ease, transform .5s ease';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        row.style.opacity = '1';
        row.style.transform = 'translateY(0)';
      });
    });
  }

  function fadeOut(row, cb) {
    row.style.opacity = '0';
    row.style.transform = 'translateY(-12px)';
    setTimeout(cb, 500);
  }

  function showNext() {
    const msg = pool[idx % pool.length];
    idx++;

    const newRow = document.createElement('li');
    newRow.className = 'flyer-row';
    newRow.textContent = msg;
    track.appendChild(newRow);

    const oldRow = track.querySelector('.flyer-row:not(:last-child)');
    if (oldRow) {
      fadeOut(oldRow, () => oldRow.remove());
    }
    fadeIn(newRow);
  }

  showNext();
  setInterval(showNext, 60000);
}

/* ==========================================================================
   MOBILE TICKER — one phrase at a time on narrow screens
   On screens < 768px the CSS disables the horizontal marquee and positions
   all spans stacked (opacity:0). The first span is visible by default via
   CSS. This function cycles through unique phrases every 60s by toggling
   the .ticker-active class (opacity:1). Desktop is untouched.
   ========================================================================== */
function initMobileTicker(trackEl) {
  function check() {
    if (window.innerWidth >= 768) return;
    const spans = Array.from(trackEl.querySelectorAll('span'));
    if (!spans.length) return;

    // Collect unique phrases (track has duplicates for desktop marquee)
    const phrases = [];
    const seen = new Set();
    spans.forEach((s) => {
      const text = s.textContent.trim();
      if (text && !seen.has(text)) { seen.add(text); phrases.push(s); }
    });
    if (!phrases.length) return;

    // If only one phrase, CSS already shows it — nothing to cycle
    if (phrases.length <= 1) return;

    // Mark the track as JS-controlled so CSS overrides the first-child fallback
    trackEl.classList.add('ticker-js');

    let i = 0;
    function show() {
      spans.forEach((s) => s.classList.remove('ticker-active'));
      phrases[i].classList.add('ticker-active');
      i = (i + 1) % phrases.length;
    }
    show();
    if (trackEl._tickerInterval) clearInterval(trackEl._tickerInterval);
    trackEl._tickerInterval = setInterval(show, 60000);
  }

  check();
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (window.innerWidth >= 768) {
        // Desktop: remove JS control, let CSS marquee run
        trackEl.classList.remove('ticker-js');
        trackEl.querySelectorAll('span').forEach((s) => s.classList.remove('ticker-active'));
        if (trackEl._tickerInterval) { clearInterval(trackEl._tickerInterval); trackEl._tickerInterval = null; }
      } else {
        check();
      }
    }, 200);
  });
}

/* ==========================================================================
   LIVE FC BARCELONA FIXTURES
   Data source: our OWN backend (GET /api/fixtures), which is populated by a
   scheduler that talks to Football-Data.org. The browser NEVER calls
   Football-Data.org directly — it only reads the cached JSON from our server.
   ========================================================================== */

let countdownTimer = null;

async function initLiveFixtures(refs) {
  try {
    const res = await fetch('/api/fixtures/next');
    const data = await res.json();
    const nextEvent = data.next;
    if (!nextEvent) throw new Error('No upcoming event returned');

    renderCountdown(refs, nextEvent);
    renderNextStrip(refs, nextEvent);
    renderVenueLine(refs, nextEvent);
    renderFixtureCard(refs, nextEvent);
  } catch (err) {
    console.warn('Live fixture fetch failed, showing fallback state:', err);
    renderFallback(refs);
  }
}

function toDate(event) {
  return new Date(event.utcDate || event.kickoff);
}

function formatPKT(date) {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Asia/Karachi',
  }).format(date) + ' PKT';
}

function renderCountdown(refs, event) {
  if (!refs.countdownEl) return;
  const target = toDate(event);

  function tick() {
    const now = new Date();
    let diff = Math.max(0, target - now);
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    refs.countdownEl.querySelector('.d').textContent = String(d).padStart(2, '0');
    refs.countdownEl.querySelector('.h').textContent = String(h).padStart(2, '0');
    refs.countdownEl.querySelector('.m').textContent = String(m).padStart(2, '0');
    refs.countdownEl.querySelector('.s').textContent = String(s).padStart(2, '0');
    if (diff <= 0 && countdownTimer) clearInterval(countdownTimer);
  }
  tick();
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(tick, 1000);
}

function renderNextStrip(refs, event) {
  if (!refs.nextStripEl) return;
  const isHome = event.isHome;
  const opponent = event.opponent;
  refs.nextStripEl.innerHTML =
    `Next up: FC Barcelona ${isHome ? 'host' : 'travel to'} <b>${opponent}</b>, ${formatPKT(toDate(event))}`;
}

function renderVenueLine(refs, event) {
  if (!refs.venueLineEl) return;
  const venue = event.venue || 'Venue to be confirmed';
  const city = event.city ? `, ${event.city}` : '';
  refs.venueLineEl.innerHTML = `Match venue: <span>${venue}${city}</span> · ${event.competition || ''}`;
}

function renderFixtureCard(refs, event) {
  if (!refs.scrollEl) return;
  const kickoff = toDate(event);
  const card = document.createElement('div');
  card.className = 'fixture-card';
  card.innerHTML = `
    <div class="teams">
      <img src="${event.homeCrest || fallbackBadge(event.homeTeam)}" alt="${event.homeTeam}">
      <span class="vs">VS</span>
      <img src="${event.awayCrest || fallbackBadge(event.awayTeam)}" alt="${event.awayTeam}">
    </div>
    <div class="names"><span>${event.homeTeam}</span><span>${event.awayTeam}</span></div>
    <div class="meta">${formatPKT(kickoff)}</div>
    <div class="meta comp">${event.competition || 'Match'}</div>
    <div class="meta venue-tag">${event.venue || 'Venue TBC'}${event.city ? ', ' + event.city : ''}</div>
    <span class="mini-countdown" data-target="${kickoff.toISOString()}">Loading…</span>
  `;
  refs.scrollEl.innerHTML = '';
  refs.scrollEl.appendChild(card);

  const miniEl = card.querySelector('.mini-countdown');
  function tickMini() {
    const diff = Math.max(0, kickoff - new Date());
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    miniEl.textContent = diff > 0 ? `Kicks off in ${d}d ${h}h` : 'Match day!';
  }
  tickMini();
  setInterval(tickMini, 60000);
}

function fallbackBadge(teamName) {
  const initials = encodeURIComponent((teamName || '?').slice(0, 3).toUpperCase());
  return `https://placehold.co/64x64/004D98/ffffff?text=${initials}`;
}

function renderFallback(refs) {
  if (refs.nextStripEl) refs.nextStripEl.textContent = 'Fixture data temporarily unavailable. Check back shortly.';
  if (refs.venueLineEl) refs.venueLineEl.textContent = '';
  if (refs.scrollEl) {
    refs.scrollEl.innerHTML = '<p class="loading-msg">Could not load live fixtures right now. Please refresh, or check FCBarcelona.com for the latest schedule.</p>';
  }
  if (refs.countdownEl) {
    ['d', 'h', 'm', 's'].forEach(cls => {
      const el = refs.countdownEl.querySelector('.' + cls);
      if (el) el.textContent = '--';
    });
  }
}

/* ==========================================================================
   FIXTURES PAGE (fixtures.html)
   Renders at least the next 10 fixtures as premium cards with live countdowns.
   ========================================================================== */
async function initFixturesPage(listEl) {
  try {
    const res = await fetch('/api/fixtures');
    const data = await res.json();
    const matches = (data.matches || []).slice(0, 10);
    if (!matches.length) {
      listEl.innerHTML = '<p class="loading-msg">No upcoming fixtures right now. Check back soon.</p>';
      return;
    }
    listEl.innerHTML = matches.map((m) => fixtureCardHTML(m)).join('');
    // Start live countdowns on each card
    matches.forEach((m) => {
      const el = listEl.querySelector(`[data-fixture-id="${m.id}"] .fixture-countdown`);
      if (el) startCardCountdown(el, toDate(m));
    });
  } catch (err) {
    console.warn('Fixtures page failed:', err);
    listEl.innerHTML = '<p class="loading-msg">Could not load fixtures right now. Please refresh.</p>';
  }
}

function fixtureCardHTML(m) {
  const kickoff = toDate(m);
  const isHome = m.isHome;
  return `
    <article class="fixture-card premium" data-fixture-id="${m.id}">
      <div class="fixture-top">
        <span class="fixture-comp">${m.competitionEmblem ? `<img src="${m.competitionEmblem}" alt="">` : ''}${m.competition || 'Match'}</span>
        <span class="fixture-haw">${isHome ? 'HOME' : 'AWAY'}</span>
      </div>
      <div class="teams">
        <div class="team">
          <img src="${m.homeCrest || fallbackBadge(m.homeTeam)}" alt="${m.homeTeam}">
          <span>${m.homeTeam}</span>
        </div>
        <span class="vs">VS</span>
        <div class="team">
          <img src="${m.awayCrest || fallbackBadge(m.awayTeam)}" alt="${m.awayTeam}">
          <span>${m.awayTeam}</span>
        </div>
      </div>
      <div class="fixture-meta">
        <div class="meta">${formatPKT(kickoff)}</div>
        <div class="meta venue-tag">${m.venue || 'Venue TBC'}${m.city ? ', ' + m.city : ''}</div>
        ${m.matchday ? `<div class="meta">Matchday ${m.matchday}</div>` : ''}
      </div>
      <div class="fixture-countdown" data-target="${kickoff.toISOString()}">Loading…</div>
    </article>
  `;
}

function startCardCountdown(el, target) {
  function tick() {
    const diff = Math.max(0, target - new Date());
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    el.innerHTML = `${d} Days · ${h} Hours · ${m} Minutes · ${s} Seconds`;
    if (diff <= 0) { el.textContent = 'Match day!'; clearInterval(timer); }
  }
  tick();
  const timer = setInterval(tick, 1000);
}