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
const fs = require("fs");
const path = require("path");

const FOOTBALL_DATA_BASE = "https://api.football-data.org/v4";
const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY || "";
const BARCA_TEAM_ID = 81; // FC Barcelona in Football-Data's registry

const CACHE_PATH = path.join(__dirname, "..", "..", "data", "fixtures.json");

function defaultCache() {
  return {
    lastSync: null,
    nextSync: null,
    apiStatus: "ok", // 'ok' | 'error'
    lastError: null,
    matches: [],
    venueCache: {}, // { [teamId]: { venue, city } }
    homeVenue: { venue: "Spotify Camp Nou", city: "Barcelona" },
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
    const raw = fs.readFileSync(CACHE_PATH, "utf-8");
    const c = JSON.parse(raw);
    // Backfill fields so older cache files don't break
    if (!c.venueCache) c.venueCache = {};
    if (!c.homeVenue) c.homeVenue = defaultCache().homeVenue;
    if (!c.apiStatus) c.apiStatus = "ok";
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
    const err = new Error(
      "FOOTBALL_DATA_API_KEY is not set in .env — cannot fetch fixtures from Football-Data.org.",
    );
    err.code = "NO_API_KEY";
    throw err;
  }
  const res = await fetch(`${FOOTBALL_DATA_BASE}${pathname}`, {
    headers: {
      "X-Auth-Token": FOOTBALL_DATA_API_KEY,
      "X-Unfold-Goals": "true",
    },
  });

  if (res.status === 429) {
    const err = new Error("Football-Data.org rate limit exceeded (429)");
    err.code = "RATE_LIMITED";
    throw err;
  }
  if (res.status === 403) {
    const err = new Error(
      "Football-Data.org rejected the API key (403) — check FOOTBALL_DATA_API_KEY",
    );
    err.code = "UNAUTHORIZED";
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`Football-Data.org returned HTTP ${res.status}`);
    err.code = "HTTP_ERROR";
    throw err;
  }
  return res.json();
}

/** Fetch Barcelona's own team record (gives us the home venue). */
async function fetchBarcaTeam() {
  const data = await footballDataFetch(`/teams/${BARCA_TEAM_ID}`);
  return {
    venue: data.venue || null,
    city: (data.address && String(data.address).split("\n")[0]) || null,
  };
}

function getLeagueSeasonYear(competition) {
  /*
   * Football-Data.org returns the current season like:
   *
   * {
   *   id: 759,
   *   startDate: "2026-08-01",
   *   endDate: "2027-05-31"
   * }
   *
   * The API's season filter expects the starting year:
   *
   * 2026
   */

  const startDate =
    competition?.currentSeason?.startDate;

  if (!startDate) {
    throw new Error(
      "League competition does not contain currentSeason.startDate."
    );
  }

  const seasonYear =
    Number(
      String(startDate).slice(0, 4)
    );

  if (
    !Number.isInteger(seasonYear)
  ) {
    throw new Error(
      `Invalid league season start date: ${startDate}`
    );
  }

  return seasonYear;
}

/**
 * Fetch the competition record for Barcelona's current league.
 *
 * Football-Data.org returns currentSeason on the competition resource.
 *
 * Example:
 * currentSeason.startDate = "2026-08-01..."
 * -> season year = 2026
 */
async function fetchCompetitionSeason(competitionCode) {
  const data = await footballDataFetch(
    `/competitions/${encodeURIComponent(
      competitionCode
    )}`
  );

  if (!data?.currentSeason) {
    throw new Error(
      `Could not determine current season for competition ${competitionCode}`
    );
  }

  const season =
    data.currentSeason;

  const startDate =
    season.startDate;

  if (!startDate) {
    throw new Error(
      `Competition ${competitionCode} has no currentSeason.startDate`
    );
  }

  const seasonYear =
    Number(
      String(startDate).slice(0, 4)
    );

  if (
    !Number.isInteger(seasonYear)
  ) {
    throw new Error(
      `Invalid current season start date for ${competitionCode}: ${startDate}`
    );
  }

  return {
    id:
      season.id ??
      null,

    startDate:
      season.startDate ??
      null,

    endDate:
      season.endDate ??
      null,

    currentMatchday:
      season.currentMatchday ??
      null,

    winner:
      season.winner ??
      null,

    stages:
      Array.isArray(season.stages)
        ? season.stages
        : [],

    /*
     * Football-Data's ?season filter uses
     * the starting year, e.g. 2026 for 2026/27.
     */
    year:
      seasonYear,
  };
}

/** Fetch an opponent's team record for their venue (used for away fixtures). */
async function fetchTeamVenue(teamId) {
  const data = await footballDataFetch(`/teams/${teamId}`);
  return {
    venue: data.venue || null,
    city: (data.address && String(data.address).split("\n")[0]) || null,
  };
}

/* ---------------------------- Normalisation ---------------------------- */


/** Attach resolved venues to matches using the venue cache (home matches use Camp Nou). */
function attachVenues(matches, cache) {
  return matches.map((m) => {
    if (m.isHome) {
      m.venue = cache.homeVenue.venue || "Spotify Camp Nou";
      m.city = cache.homeVenue.city || "Barcelona";
    } else {
      const v = cache.venueCache[m.opponentId];
      if (v) {
        m.venue = v.venue || "Venue TBC";
        m.city = v.city || "";
      } else {
        m.venue = "Venue TBC";
        m.city = "";
      }
    }
    return m;
  });
}

function getFixtureHistoryStartDate() {
  const date = new Date();

  date.setDate(date.getDate() - 7);

  return date.toISOString().slice(0, 10);
}

function getFixtureHistoryEndDate() {
  const date = new Date();

  date.setDate(date.getDate() + 120);

  return date.toISOString().slice(0, 10);
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
    /*
     * 1. Fetch Barcelona's team information.
     *
     * runningCompetitions tells us which competitions Barcelona
     * is participating in during the current season.
     */
    const barcaTeam = await fetchBarcaTeam();

    if (!barcaTeam) {
      throw new Error("Could not load Barcelona team information");
    }

    if (barcaTeam.venue) {
      cache.homeVenue = barcaTeam;
    }

    /*
     * 2. Dynamically find Barcelona's league.
     *
     * We intentionally do NOT hard-code PD.
     */
    const league = Array.isArray(barcaTeam.runningCompetitions)
      ? barcaTeam.runningCompetitions.find(
          (competition) =>
            String(competition.type).toUpperCase() === "LEAGUE"
        )
      : null;

    if (!league?.code) {
      throw new Error(
        "Could not determine Barcelona's current league competition"
      );
    }

    /*
     * Store competition information in cache.
     */
    cache.competition = {
      id: league.id,
      code: league.code,
      name: league.name,
      type: league.type,
      emblem: league.emblem || null,
    };

    /*
     * 3. Fetch ALL matches from Barcelona's league.
     *
     * IMPORTANT:
     * - limit=500 covers a complete league season such as La Liga.
     * - X-Unfold-Goals: true makes goal events available.
     */
  /*
 * Determine the current season from the
 * league returned for Barcelona.
 */
const seasonYear =
  getLeagueSeasonYear(league);

/*
 * Fetch ALL matches for the league's
 * current season.
 *
 * Example:
 *
 * /competitions/PD/matches?season=2026
 *
 * This includes:
 * - completed matches
 * - currently running matches
 * - future matches
 * - matches where Barcelona is NOT involved
 */
const matchesData =
  await footballDataFetch(
    `/competitions/${encodeURIComponent(
      league.code
    )}/matches?season=${seasonYear}`
  );

    /*
     * 4. Normalize the COMPLETE league.
     */
  function normalizeLeagueMatches(matches, barcaTeam) {
  return matches
    .map((match) => {
      const homeTeam = match.homeTeam || {};
      const awayTeam = match.awayTeam || {};

      const isBarcaHome =
        Number(homeTeam.id) === Number(BARCA_TEAM_ID);

      const isBarcaAway =
        Number(awayTeam.id) === Number(BARCA_TEAM_ID);

      const isBarcaMatch =
        isBarcaHome || isBarcaAway;

      /*
       * football-data v4 score structure:
       *
       * score.fullTime.homeTeam
       * score.fullTime.awayTeam
       */
      const fullTime = match.score?.fullTime || {};

      const hasHomeScore =
        Number.isInteger(fullTime.home);

      const hasAwayScore =
        Number.isInteger(fullTime.away);

      /*
       * Normalize goal events into the format your frontend already
       * expects:
       *
       * {
       *   minute,
       *   injuryTime,
       *   scorer,
       *   teamName
       * }
       */
      const goals = Array.isArray(match.goals)
        ? match.goals.map((goal) => ({
            minute: Number.isInteger(goal.minute)
              ? goal.minute
              : null,

            injuryTime: Number.isInteger(goal.injuryTime)
              ? goal.injuryTime
              : null,

            scorer:
              goal.scorer?.name ||
              "Unknown scorer",

            teamName:
              goal.team?.name ||
              "",

            type:
              goal.type ||
              "REGULAR",
          }))
        : [];

      return {
        id: match.id,

        utcDate: match.utcDate,

        status: match.status,

        /*
         * This is Barcelona-relative.
         *
         * For Barcelona matches:
         *   true  = Barcelona home
         *   false = Barcelona away
         *
         * For other league matches it will be false, but we also expose
         * isBarcaMatch so the frontend knows whether HOME/AWAY should
         * be displayed.
         */
        isHome: isBarcaHome,

        isBarcaMatch,

        homeTeam: homeTeam.name || "Home Team",
        homeTeamId: homeTeam.id || null,
        homeCrest: homeTeam.crest || null,

        awayTeam: awayTeam.name || "Away Team",
        awayTeamId: awayTeam.id || null,
        awayCrest: awayTeam.crest || null,

        competition:
          match.competition?.name ||
          "League",

        competitionCode:
          match.competition?.code ||
          null,

        competitionEmblem:
          match.competition?.emblem ||
          null,

        matchday:
          Number.isInteger(match.matchday)
            ? match.matchday
            : null,

        /*
         * football-data gives the venue directly on the match.
         *
         * If Barcelona is home and venue is missing, use Barcelona's
         * own stadium as fallback.
         */
        venue:
          match.venue ||
          (isBarcaHome ? barcaTeam.venue : null) ||
          null,

        /*
         * football-data's Match object does not reliably expose the
         * city field in the same way your old normalized object did,
         * so leave it null unless your API layer adds it.
         */
        city:
          match.city ||
          null,

        /*
         * Keep score null when it is not available.
         *
         * This preserves your existing "upcoming/current" behavior.
         */
        score:
          hasHomeScore && hasAwayScore
            ? {
                home: fullTime.home,
                away: fullTime.away,
              }
            : null,

        /*
         * Goal events exist for completed matches when
         * X-Unfold-Goals is enabled.
         */
        goals,
      };
    })
    .filter(
      (match) =>
        match.homeTeamId != null &&
        match.awayTeamId != null
    );
}

    /*
     * 5. No need to fetch every opponent's venue.
     *
     * football-data already provides the venue on the match resource.
     * We only use Barcelona's own stadium as a fallback for a Barcelona
     * home match when the match venue is missing.
     */

    cache.matches = matches;
    cache.lastSync = new Date().toISOString();
    cache.apiStatus = "ok";
    cache.lastError = null;

    writeCache(cache);

    return cache;
  } catch (err) {
    console.error("[fixtures] sync failed:", err.message);

    cache.apiStatus = "error";
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
/**
 * Fetch the latest result for one specific fixture.
 *
 * This does NOT change the existing fixture sync behaviour.
 * It only asks Football-Data.org for the requested match when the
 * frontend needs the final score.
 */
async function getFixtureResult(fixtureId) {
  const data = await footballDataFetch(
    `/matches/${encodeURIComponent(fixtureId)}`,
  );

  const fullTime = data.score?.fullTime || {};

  return {
    id: data.id,
    status: data.status,
    score: {
      home: Number.isInteger(fullTime.home) ? fullTime.home : null,

      away: Number.isInteger(fullTime.away) ? fullTime.away : null,
    },
  };
}

module.exports = {
  syncFixtures,
  getCachedFixtures,
  clearFixturesCache,
  updateNextSync,
  getFixtureResult,
  CACHE_PATH,
  BARCA_TEAM_ID,
};
