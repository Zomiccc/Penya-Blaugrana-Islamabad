/* ==========================================================================
   FC BARCELONA FIXTURE SERVICE
   The ONLY piece of the codebase that talks to Football-Data.org.

   Responsibilities:
     - Authenticate to Football-Data.org using the API key from .env
     - Download FC Barcelona fixtures
     - Normalise the raw API payload into our own shape
     - Resolve venues (Football-Data v4 doesn't include venue on matches,
       so we fetch team records and cache them in the fixture cache)
     - Return cached data to the rest of the app

   IMPORTANT: The API key lives ONLY here (read from process.env) and is
   never exposed to the browser. The frontend only ever hits our own
   /api/fixtures endpoints, which read from the cache file.
   ========================================================================== */
const fs = require('fs');
const path = require('path');

const FOOTBALL_DATA_BASE = 'https://api.football-data.org/v4';
const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY || '';
const BARCA_TEAM_ID = 81; // FC Barcelona in Football-Data's registry

const CACHE_PATH = path.join(__dirname, '..', '..', 'data', 'fixtures.json');

function defaultCache() {
  return {
    lastSync: null,
    nextSync: null,
    apiStatus: 'ok', // 'ok' | 'error'
    lastError: null,
    matches: [],
    venueCache: {}, // { [teamId]: { venue, city } }
    homeVenue: { venue: 'Spotify Camp Nou', city: 'Barcelona' },
  };
}

function ensureCacheFile() {
  if (!fs.existsSync(CACHE_PATH)) {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(defaultCache(), null, 2));
  }
}

function readCache() {
  ensureCacheFile();
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf-8');
    const c = JSON.parse(raw);
    // Backfill fields so older cache files don't break
    if (!c.venueCache) c.venueCache = {};
    if (!c.homeVenue) c.homeVenue = defaultCache().homeVenue;
    if (!c.apiStatus) c.apiStatus = 'ok';
    return c;
  } catch {
    return defaultCache();
  }
}

function writeCache(cache) {
  ensureCacheFile();
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

/* ---------------------------- Football-Data API client ---------------------------- */
async function footballDataFetch(pathname) {
  if (!FOOTBALL_DATA_API_KEY) {
    const err = new Error('FOOTBALL_DATA_API_KEY is not set in .env — cannot fetch fixtures from Football-Data.org.');
    err.code = 'NO_API_KEY';
    throw err;
  }
  const res = await fetch(`${FOOTBALL_DATA_BASE}${pathname}`, {
    headers: { 'X-Auth-Token': FOOTBALL_DATA_API_KEY },
  });

  if (res.status === 429) {
    const err = new Error('Football-Data.org rate limit exceeded (429)');
    err.code = 'RATE_LIMITED';
    throw err;
  }
  if (res.status === 403) {
    const err = new Error('Football-Data.org rejected the API key (403) — check FOOTBALL_DATA_API_KEY');
    err.code = 'UNAUTHORIZED';
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`Football-Data.org returned HTTP ${res.status}`);
    err.code = 'HTTP_ERROR';
    throw err;
  }
  return res.json();
}

/** Fetch Barcelona's own team record (gives us the home venue). */
async function fetchBarcaTeam() {
  const data = await footballDataFetch(`/teams/${BARCA_TEAM_ID}`);
  return {
    venue: data.venue || null,
    city: (data.address && String(data.address).split('\n')[0]) || null,
  };
}

/** Fetch an opponent's team record for their venue (used for away fixtures). */
async function fetchTeamVenue(teamId) {
  const data = await footballDataFetch(`/teams/${teamId}`);
  return {
    venue: data.venue || null,
    city: (data.address && String(data.address).split('\n')[0]) || null,
  };
}

/* ---------------------------- Normalisation ---------------------------- */
function normalizeMatches(rawMatches) {
  return rawMatches
    .map((m) => {
      const isHome = m.homeTeam.id === BARCA_TEAM_ID;
      return {
        id: m.id,
        competition: m.competition ? m.competition.name : 'Match',
        competitionCode: m.competition ? m.competition.code : '',
        competitionEmblem: m.competition ? m.competition.emblem : null,
        matchday: m.matchday ?? null,
        stage: m.stage || null,
        isHome,
        homeTeam: m.homeTeam.name,
        awayTeam: m.awayTeam.name,
        homeCrest: m.homeTeam.crest || null,
        awayCrest: m.awayTeam.crest || null,
        opponent: isHome ? m.awayTeam.name : m.homeTeam.name,
        opponentShort: isHome ? (m.awayTeam.shortName || m.awayTeam.name) : (m.homeTeam.shortName || m.homeTeam.name),
        opponentId: isHome ? m.awayTeam.id : m.homeTeam.id,
        utcDate: m.utcDate,
        kickoff: m.utcDate, // ISO string, keep name simple for the frontend
        status: m.status, // SCHEDULED | TIMED | LIVE | FINISHED | ...
        venue: null, // resolved below
        city: null,
        score: {
          home: m.score && m.score.fullTime ? m.score.fullTime.home : null,
          away: m.score && m.score.fullTime ? m.score.fullTime.away : null,
        },
        lastUpdated: m.lastUpdated || null,
      };
    })
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));
}

/** Attach resolved venues to matches using the venue cache (home matches use Camp Nou). */
function attachVenues(matches, cache) {
  return matches.map((m) => {
    if (m.isHome) {
      m.venue = cache.homeVenue.venue || 'Spotify Camp Nou';
      m.city = cache.homeVenue.city || 'Barcelona';
    } else {
      const v = cache.venueCache[m.opponentId];
      if (v) {
        m.venue = v.venue || 'Venue TBC';
        m.city = v.city || '';
      } else {
        m.venue = 'Venue TBC';
        m.city = '';
      }
    }
    return m;
  });
}

/* ---------------------------- Main sync ---------------------------- */
/**
 * Pull the latest Barcelona fixtures from Football-Data.org, then merge in
 * any newly-seen opponents' venues. Writes the result to data/fixtures.json.
 *
 * Kept robust: if Football-Data is unreachable we keep the previous cache
 * untouched and record apiStatus = 'error' so the admin panel can show it.
 */
async function syncFixtures() {
  const cache = readCache();

  try {
    const [matchesData, barcaTeam] = await Promise.all([
      footballDataFetch(`/teams/${BARCA_TEAM_ID}/matches?status=SCHEDULED`),
      fetchBarcaTeam(),
    ]);

    if (barcaTeam.venue) cache.homeVenue = barcaTeam;

    // Resolve venues for any opponents we haven't seen yet.
    // Football-Data v4 doesn't include venue on matches, so we fetch the
    // opponent team records ONCE and cache them forever afterwards.
    const matches = normalizeMatches(matchesData.matches || []);
    const unseenOpponentIds = [
      ...new Set(matches.filter((m) => !m.isHome).map((m) => m.opponentId)),
    ].filter((id) => !cache.venueCache[id]);

    // Pace the team-record requests so we stay inside the free tier's
    // per-minute rate limit (10 req/min). Typical first sync: 1 (matches) +
    // 1 (barca) + ~14 opponents ≈ 16 requests; we space venue lookups ~1.2s
    // apart so they spread across the minute window.
    for (const id of unseenOpponentIds) {
      try {
        const v = await fetchTeamVenue(id);
        cache.venueCache[id] = v;
      } catch (err) {
        if (err.code === 'RATE_LIMITED') break; // stop trying — next sync will retry
        console.error('[fixtures] failed to resolve venue for team', id, err.message);
      }
      await new Promise((r) => setTimeout(r, 1200));
    }

    const withVenues = attachVenues(matches, cache);

    cache.matches = withVenues;
    cache.lastSync = new Date().toISOString();
    cache.apiStatus = 'ok';
    cache.lastError = null;

    writeCache(cache);
    return cache;
  } catch (err) {
    console.error('[fixtures] sync failed:', err.message);
    cache.apiStatus = 'error';
    cache.lastError = err.message;
    cache.lastSync = cache.lastSync || null;
    writeCache(cache);
    throw err;
  }
}

/* ---------------------------- Cache access (no API calls) ---------------------------- */
function getCachedFixtures() {
  const cache = readCache();
  return {
    lastSync: cache.lastSync,
    nextSync: cache.nextSync,
    apiStatus: cache.apiStatus,
    lastError: cache.lastError,
    matches: cache.matches,
  };
}

function clearFixturesCache() {
  const fresh = defaultCache();
  writeCache(fresh);
  return fresh;
}

function updateNextSync(isoString) {
  const cache = readCache();
  cache.nextSync = isoString;
  writeCache(cache);
}

module.exports = {
  syncFixtures,
  getCachedFixtures,
  clearFixturesCache,
  updateNextSync,
  CACHE_PATH,
  BARCA_TEAM_ID,
};