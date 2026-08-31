document.addEventListener("DOMContentLoaded", () => {
  let fixturesListElement = null;
  const burger = document.querySelector(".hamburger");
  const nav = document.querySelector(".main-nav");
  if (burger && nav) {
    // Create backdrop element
    const backdrop = document.createElement("div");
    backdrop.className = "nav-backdrop";
    backdrop.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9998;opacity:0;visibility:hidden;transition:opacity 0.3s ease,visibility 0.3s ease;pointer-events:none;";
    document.body.appendChild(backdrop);

    const setMenu = (open) => {
      nav.classList.toggle("open", open);
      burger.classList.toggle("open", open);
      burger.setAttribute("aria-expanded", String(open));
      burger.setAttribute("aria-label", open ? "Close menu" : "Open menu");

      // Toggle backdrop
      if (open) {
        backdrop.style.opacity = "1";
        backdrop.style.visibility = "visible";
        backdrop.style.pointerEvents = "auto";
        document.body.style.overflow = "hidden";
      } else {
        backdrop.style.opacity = "0";
        backdrop.style.visibility = "hidden";
        backdrop.style.pointerEvents = "none";
        document.body.style.overflow = "";
      }
    };
    setMenu(false);

    // Close menu when clicking backdrop
    backdrop.addEventListener("click", () => setMenu(false));

    burger.addEventListener("click", () =>
      setMenu(!nav.classList.contains("open")),
    );
    burger.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setMenu(!nav.classList.contains("open"));
      }
    });
    nav
      .querySelectorAll("a")
      .forEach((a) => a.addEventListener("click", () => setMenu(false)));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") setMenu(false);
    });
  }

  const countdownEl = document.getElementById("countdown");
  const scrollEl = document.getElementById("fixtureScroll");
  const nextStripEl = document.getElementById("nextMatchStrip");
  const venueLineEl = document.getElementById("venueLine");
  if (countdownEl || scrollEl) {
    initLiveFixtures({ countdownEl, scrollEl, nextStripEl, venueLineEl });
  }

  // Fixtures page (fixtures.html) — render the full list
  const fixturesListEl = document.getElementById("fixturesList");
  if (fixturesListEl) {
    initFixturesPage(fixturesListEl);
  }

  // Join flyer vertical scroller (index.html)
  const flyerList = document.getElementById("flyerList");
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

  listEl.innerHTML = "";
  listEl.removeAttribute("style");

  const track = document.createElement("div");
  track.className = "flyer-track";
  listEl.appendChild(track);

  // Repeat the names so the rotation cycles longer before repeating
  const pool = [];
  for (let i = 0; i < 5; i++) pool.push(...messages);

  let idx = 0;

  function fadeIn(row) {
    row.style.opacity = "0";
    row.style.transform = "translateY(12px)";
    row.style.transition = "opacity .5s ease, transform .5s ease";
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        row.style.opacity = "1";
        row.style.transform = "translateY(0)";
      });
    });
  }

  function fadeOut(row, cb) {
    row.style.opacity = "0";
    row.style.transform = "translateY(-12px)";
    setTimeout(cb, 500);
  }

  function showNext() {
    const msg = pool[idx % pool.length];
    idx++;

    const newRow = document.createElement("li");
    newRow.className = "flyer-row";
    newRow.textContent = msg;
    track.appendChild(newRow);

    const oldRow = track.querySelector(".flyer-row:not(:last-child)");
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
    const spans = Array.from(trackEl.querySelectorAll("span"));
    if (!spans.length) return;

    // Collect unique phrases (track has duplicates for desktop marquee)
    const phrases = [];
    const seen = new Set();
    spans.forEach((s) => {
      const text = s.textContent.trim();
      if (text && !seen.has(text)) {
        seen.add(text);
        phrases.push(s);
      }
    });
    if (!phrases.length) return;

    // If only one phrase, CSS already shows it — nothing to cycle
    if (phrases.length <= 1) return;

    // Mark the track as JS-controlled so CSS overrides the first-child fallback
    trackEl.classList.add("ticker-js");

    let i = 0;
    function show() {
      spans.forEach((s) => s.classList.remove("ticker-active"));
      phrases[i].classList.add("ticker-active");
      i = (i + 1) % phrases.length;
    }
    show();
    if (trackEl._tickerInterval) clearInterval(trackEl._tickerInterval);
    trackEl._tickerInterval = setInterval(show, 60000);
  }

  check();
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (window.innerWidth >= 768) {
        // Desktop: remove JS control, let CSS marquee run
        trackEl.classList.remove("ticker-js");
        trackEl
          .querySelectorAll("span")
          .forEach((s) => s.classList.remove("ticker-active"));
        if (trackEl._tickerInterval) {
          clearInterval(trackEl._tickerInterval);
          trackEl._tickerInterval = null;
        }
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
    const res = await fetch("/api/fixtures/next");
    const data = await res.json();
    const nextEvent = data.next;
    if (!nextEvent) throw new Error("No upcoming event returned");

    renderCountdown(refs, nextEvent);
    renderNextStrip(refs, nextEvent);
    renderVenueLine(refs, nextEvent);
    renderFixtureCard(refs, nextEvent);
  } catch (err) {
    console.warn("Live fixture fetch failed, showing fallback state:", err);
    renderFallback(refs);
  }
}

function toDate(event) {
  return new Date(event.utcDate || event.kickoff);
}

function formatPKT(date) {
  return (
    new Intl.DateTimeFormat("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Karachi",
    }).format(date) + " PKT"
  );
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
    refs.countdownEl.querySelector(".d").textContent = String(d).padStart(
      2,
      "0",
    );
    refs.countdownEl.querySelector(".h").textContent = String(h).padStart(
      2,
      "0",
    );
    refs.countdownEl.querySelector(".m").textContent = String(m).padStart(
      2,
      "0",
    );
    refs.countdownEl.querySelector(".s").textContent = String(s).padStart(
      2,
      "0",
    );
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
  refs.nextStripEl.innerHTML = `Next up: FC Barcelona ${isHome ? "host" : "travel to"} <b>${opponent}</b>, ${formatPKT(toDate(event))}`;
}

function renderVenueLine(refs, event) {
  if (!refs.venueLineEl) return;
  const venue = event.venue || "Venue to be confirmed";
  const city = event.city ? `, ${event.city}` : "";
  refs.venueLineEl.innerHTML = `Match venue: <span>${venue}${city}</span> · ${event.competition || ""}`;
}

function renderFixtureCard(refs, event) {
  if (!refs.scrollEl) return;
  const kickoff = toDate(event);
  const card = document.createElement("div");
  card.className = "fixture-card";
  card.innerHTML = `
    <div class="teams">
      <img src="${event.homeCrest || fallbackBadge(event.homeTeam)}" alt="${event.homeTeam}">
      <span class="vs">VS</span>
      <img src="${event.awayCrest || fallbackBadge(event.awayTeam)}" alt="${event.awayTeam}">
    </div>
    <div class="names"><span>${event.homeTeam}</span><span>${event.awayTeam}</span></div>
    <div class="meta">${formatPKT(kickoff)}</div>
    <div class="meta comp">${event.competition || "Match"}</div>
    <div class="meta venue-tag">${event.venue || "Venue TBC"}${event.city ? ", " + event.city : ""}</div>
    <span class="mini-countdown" data-target="${kickoff.toISOString()}">Loading…</span>
  `;
  refs.scrollEl.innerHTML = "";
  refs.scrollEl.appendChild(card);

  const miniEl = card.querySelector(".mini-countdown");
  function tickMini() {
    const diff = Math.max(0, kickoff - new Date());
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    miniEl.textContent = diff > 0 ? `Kicks off in ${d}d ${h}h` : "Match day!";
  }
  tickMini();
  setInterval(tickMini, 60000);
}

function fallbackBadge(teamName) {
  const initials = encodeURIComponent(
    (teamName || "?").slice(0, 3).toUpperCase(),
  );
  return `https://placehold.co/64x64/004D98/ffffff?text=${initials}`;
}

function renderFallback(refs) {
  if (refs.nextStripEl)
    refs.nextStripEl.textContent =
      "Fixture data temporarily unavailable. Check back shortly.";
  if (refs.venueLineEl) refs.venueLineEl.textContent = "";
  if (refs.scrollEl) {
    refs.scrollEl.innerHTML =
      '<p class="loading-msg">Could not load live fixtures right now. Please refresh, or check FCBarcelona.com for the latest schedule.</p>';
  }
  if (refs.countdownEl) {
    ["d", "h", "m", "s"].forEach((cls) => {
      const el = refs.countdownEl.querySelector("." + cls);
      if (el) el.textContent = "--";
    });
  }
}
function scheduleFixtureRefresh(match) {
  const kickoff = toDate(match);

  if (match.status === "FINISHED") return;

  const RESULT_DELAY = 90 * 60 * 1000;

  const elapsed = Date.now() - kickoff.getTime();

  const delay = Math.max(0, RESULT_DELAY - elapsed);

  setTimeout(async () => {
    try {
      const res = await fetch("/api/fixtures");

      if (!res.ok) return;

      const data = await res.json();

      const updatedMatch = (data.matches || []).find(
        (m) => Number(m.id) === Number(match.id),
      );

      if (!updatedMatch) return;

      const card = document.querySelector(`[data-fixture-id="${match.id}"]`);

      if (!card) return;

      if (updatedMatch.status === "FINISHED") {
        card.outerHTML = fixtureCardHTML(updatedMatch);
      }
    } catch (err) {
      console.warn(
        `[fixtures] post-match refresh failed for ${match.id}:`,
        err.message,
      );
    }
  }, delay);
}
/* ==========================================================================
   FIXTURES PAGE (fixtures.html)
   Two groups, both in chronological (earliest-first) order:
     - Upcoming  -> the existing responsive grid, unchanged.
     - Results   -> a horizontal swipeable rail (see .results-rail in
                    fixtures.html), so finished matches don't push the
                    upcoming ones off the screen.
   ========================================================================== */
async function initFixturesPage(listEl) {
  try {
    fixturesListElement = listEl;

    const res = await fetch("/api/fixtures");

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();

    // Ascending by kickoff: the match that happened earlier comes first.
    const matches = (data.matches || [])
      .slice()
      .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));

    if (!matches.length) {
      listEl.innerHTML =
        '<p class="loading-msg">No league fixtures available right now.</p>';

      return;
    }

    const isResult = (m) =>
      m.status === "FINISHED" &&
      Number.isInteger(m.score?.home) &&
      Number.isInteger(m.score?.away);

    const results = matches.filter(isResult);
    const upcoming = matches.filter((m) => !isResult(m));

    // ---- Upcoming grid (unchanged) ----
    listEl.innerHTML = upcoming.length
      ? upcoming.map((match) => fixtureCardHTML(match)).join("")
      : '<p class="loading-msg">No upcoming fixtures scheduled right now.</p>';

    // ---- Results rail (oldest on left, latest on far right; starts
    //      scrolled to the end so the latest result is shown first) ----
    const railEl = document.getElementById("resultsRail");
    const blockEl = document.getElementById("resultsBlock");
    if (railEl && blockEl) {
      if (results.length) {
        // Chronological: oldest first (left), latest last (right).
        const sorted = [...results].sort(
          (a, b) => new Date(a.utcDate) - new Date(b.utcDate)
        );
        blockEl.hidden = false;
        railEl.innerHTML = sorted.map((match) => fixtureCardHTML(match)).join("");
        initResultsRail(blockEl, railEl);
      } else {
        blockEl.hidden = true;
      }
    }

    // Countdowns + post-match refresh only apply to matches still to be played.
    upcoming.forEach((match) => {
      const el = listEl.querySelector(
        `[data-fixture-id="${match.id}"] .fixture-countdown`,
      );

      if (el) {
        startCardCountdown(el, toDate(match));
      }

      scheduleFixtureRefresh(match);
    });
  } catch (err) {
    console.warn("Fixtures page failed:", err);

    listEl.innerHTML =
      '<p class="loading-msg">Could not load league fixtures right now. Please refresh.</p>';
  }
}

/* --------------------------------------------------------------------------
   RESULTS RAIL — arrow controls for the horizontal results carousel.
   Swiping/dragging is handled natively by CSS overflow scrolling; this only
   wires up the desktop arrows and keeps their disabled state in sync.
   -------------------------------------------------------------------------- */
function initResultsRail(blockEl, railEl) {
  const prev = document.getElementById("resultsPrev");
  const next = document.getElementById("resultsNext");
  if (!prev || !next) return;

  // Scroll by one card (plus the gap) per click.
  const step = () => {
    const card = railEl.querySelector(".fixture-card");
    if (!card) return railEl.clientWidth * 0.8;
    const gap = parseFloat(getComputedStyle(railEl).columnGap || "22") || 22;
    return card.getBoundingClientRect().width + gap;
  };

  const sync = () => {
    const max = railEl.scrollWidth - railEl.clientWidth - 1;
    prev.disabled = railEl.scrollLeft <= 0;
    next.disabled = railEl.scrollLeft >= max;
  };

  prev.addEventListener("click", () => railEl.scrollBy({ left: -step(), behavior: "smooth" }));
  next.addEventListener("click", () => railEl.scrollBy({ left: step(), behavior: "smooth" }));
  railEl.addEventListener("scroll", sync, { passive: true });
  window.addEventListener("resize", sync);

  // Start at the far right (latest result) so the most recent match
  // is visible on load. Swipe/scroll left to see older matches.
  railEl.scrollLeft = railEl.scrollWidth;
  sync();
}

/* Short competition tag: "Primera Division" -> "LALIGA", etc.
   Falls back to the competitionCode or the first word of the name. */
function competitionTag(m) {
  const name = (m.competition || "").toLowerCase();
  const code = m.competitionCode || "";
  if (name.includes("primera") || name.includes("liga") || code === "PD") return "LALIGA";
  if (name.includes("champions") || code === "CL") return "UCL";
  if (name.includes("europa") || code === "EL") return "UEL";
  if (name.includes("conference") || code === "ECL") return "UECL";
  if (name.includes("super") || code === "SC") return "SUPERCUP";
  if (name.includes("club world") || code === "CWC") return "CWC";
  if (name.includes("copa") || name.includes("rey") || code === "CDR") return "COPA";
  if (code) return code;
  return (m.competition || "MATCH").split(" ")[0].toUpperCase();
}

function fixtureCardHTML(m) {
  const kickoff = toDate(m);
  const isHome = m.isHome;

  const isFinished = m.status === "FINISHED";

  const hasScore =
    Number.isInteger(m.score?.home) && Number.isInteger(m.score?.away);

  return `
    <article
      class="fixture-card premium"
      data-fixture-id="${m.id}"
    >

      <div class="fixture-top">

        <span class="fixture-comp">
          ${
            m.competitionEmblem
              ? `<img
                   src="${m.competitionEmblem}"
                   alt=""
                 >`
              : ""
          }

          ${m.competition || "Match"}
        </span>
        <span class="fixture-haw">
          ${m.isHome ? "BARÇA HOME" : m.isAway ? "BARÇA AWAY" : "LEAGUE"}
        </span>

      </div>

      <span class="fixture-tag">${competitionTag(m)}</span>

      <div class="teams">

        <div class="team">
          <img
            src="${m.homeCrest || fallbackBadge(m.homeTeam)}"
            alt="${m.homeTeam}"
          >

          <span>${m.homeTeam}</span>
        </div>

        <span class="vs">
          ${isFinished && hasScore ? `${m.score.home} – ${m.score.away}` : "VS"}
        </span>

        <div class="team">
          <img
            src="${m.awayCrest || fallbackBadge(m.awayTeam)}"
            alt="${m.awayTeam}"
          >

          <span>${m.awayTeam}</span>
        </div>

      </div>

      <div class="fixture-meta">

        <div class="meta">
          ${formatPKT(kickoff)}
        </div>

        <div class="meta venue-tag">
          ${m.venue || "Venue TBC"}

          ${m.city ? ", " + m.city : ""}
        </div>

        ${
          m.matchday
            ? `
              <div class="meta">
                Matchday ${m.matchday}
              </div>
            `
            : ""
        }

      </div>

      ${
        isFinished && hasScore
          ? finishedMatchHTML(m)
          : `
              <div
                class="fixture-countdown"
                data-target="${kickoff.toISOString()}"
              >
                Loading…
              </div>
            `
      }

    </article>
  `;
}

function finishedMatchHTML(m) {
  const homeScore = Number.isInteger(m.score?.home) ? m.score.home : "-";

  const awayScore = Number.isInteger(m.score?.away) ? m.score.away : "-";

  const goals = Array.isArray(m.goals) ? m.goals : [];

  const goalRows = goals.length
    ? goals
        .slice()
        .sort((a, b) => {
          const aMinute = Number.isInteger(a.minute) ? a.minute : 999;
          const bMinute = Number.isInteger(b.minute) ? b.minute : 999;

          return aMinute - bMinute;
        })
        .map((goal) => {
          const minute = Number.isInteger(goal.minute)
            ? `${goal.minute}${Number.isInteger(goal.injuryTime) && goal.injuryTime > 0 ? `+${goal.injuryTime}` : ""}'`
            : "—";

          return `
            <div class="goal-row">
              <span class="goal-minute">${minute}</span>
              <span class="goal-scorer">${goal.scorer || "Unknown scorer"}</span>
              <span class="goal-team">${goal.teamName || ""}</span>
            </div>
          `;
        })
        .join("")
    : `
        <div class="no-goals">
          No goal details available.
        </div>
      `;

  return `
    <div class="fixture-result">

      <div class="fixture-result-label">
        FULL TIME
      </div>

      <div class="fixture-result-score">

        <div class="fixture-result-team">
          <img
            src="${m.homeCrest || fallbackBadge(m.homeTeam)}"
            alt="${m.homeTeam}"
          >
          <span>${m.homeTeam}</span>
        </div>

        <div class="fixture-result-numbers">
          <span class="fixture-result-number">${homeScore}</span>
          <span class="fixture-result-separator">–</span>
          <span class="fixture-result-number">${awayScore}</span>
        </div>

        <div class="fixture-result-team">
          <img
            src="${m.awayCrest || fallbackBadge(m.awayTeam)}"
            alt="${m.awayTeam}"
          >
          <span>${m.awayTeam}</span>
        </div>

      </div>

      <div class="fixture-result-status">
        MATCH FINISHED
      </div>

      <div class="goal-events">

        <div class="goal-events-title">
          GOALS
        </div>

        ${goalRows}

      </div>

    </div>
  `;
}

function startCardCountdown(el, target) {
  let timer = null;
  function tick() {
    const diff = Math.max(0, target - new Date());
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    el.innerHTML = `${d} Days · ${h} Hours · ${m} Minutes · ${s} Seconds`;
    if (diff <= 0) {
      el.textContent = "Match day!";
      if (timer) clearInterval(timer);
    }
  }
  tick();
  timer = setInterval(tick, 1000);
}

async function fetchFixtureResultAfterExpectedEnd(card, match) {
  try {
    const res = await fetch(
      `/api/fixtures/${encodeURIComponent(match.id)}/result`,
      {
        headers: {
          Accept: "application/json",
        },
      },
    );

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const result = await res.json();

    const finished =
      result.status === "FINISHED" &&
      result.score &&
      Number.isInteger(result.score.home) &&
      Number.isInteger(result.score.away);

    if (finished) {
      renderFixtureResult(card, match, result);
      return;
    }

    /*
     * The match has not finished yet.
     *
     * This is normally caused by:
     * - delayed kickoff
     * - extra stoppage time
     * - match interruption
     * - unusual game circumstances
     *
     * We now wait another 5 minutes before checking again.
     */
    setTimeout(
      () => {
        fetchFixtureResultAfterExpectedEnd(card, match);
      },
      5 * 60 * 1000,
    );
  } catch (err) {
    console.warn(
      `[fixtures] result lookup failed for ${match.id}:`,
      err.message,
    );

    /*
     * If our own server/API request fails, don't hammer it.
     * Retry after 5 minutes.
     */
    setTimeout(
      () => {
        fetchFixtureResultAfterExpectedEnd(card, match);
      },
      5 * 60 * 1000,
    );
  }
}

function renderFixtureResult(card, match, result) {
  const slot = card.querySelector(".fixture-result-slot");

  if (!slot) return;

  const homeScore = result.score?.home;
  const awayScore = result.score?.away;

  if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore)) {
    return;
  }

  slot.innerHTML = `
    <div class="fixture-result">
      <div class="fixture-result-label">
        Full Time
      </div>

      <div class="fixture-result-score">

        <div class="fixture-result-team">
          <img
            src="${match.homeCrest || fallbackBadge(match.homeTeam)}"
            alt="${match.homeTeam}"
          >
          <span>${match.homeTeam}</span>
        </div>

        <div class="fixture-result-numbers">
          <span class="fixture-result-number">
            ${homeScore}
          </span>

          <span class="fixture-result-separator">
            –
          </span>

          <span class="fixture-result-number">
            ${awayScore}
          </span>
        </div>

        <div class="fixture-result-team">
          <img
            src="${match.awayCrest || fallbackBadge(match.awayTeam)}"
            alt="${match.awayTeam}"
          >
          <span>${match.awayTeam}</span>
        </div>

      </div>

      <div class="fixture-result-status">
        Match Finished
      </div>
    </div>
  `;
}
