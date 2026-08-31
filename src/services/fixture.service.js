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
    overrides: {}, // { [fixtureId]: { status, homeScore, awayScore } } — manual fixes that survive syncs
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
    if (!c.overrides) c.overrides = {};
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
      "FOOTBALL_DATA_API_KEY is not set in .env — cannot fetch fixtures from Football-Data.org."
    );

    err.code = "NO_API_KEY";

    throw err;
  }

  const res = await fetch(
    `${FOOTBALL_DATA_BASE}${pathname}`,
    {
      headers: {
        "X-Auth-Token": FOOTBALL_DATA_API_KEY,
        "X-Unfold-Goals": "true",
        Accept: "application/json",
      },
    }
  );

  if (res.status === 429) {
    const err = new Error(
      "Football-Data.org rate limit exceeded (429)"
    );

    err.code = "RATE_LIMITED";

    throw err;
  }

  if (res.status === 403) {
    const err = new Error(
      "Football-Data.org rejected the API key (403) — check FOOTBALL_DATA_API_KEY"
    );

    err.code = "UNAUTHORIZED";

    throw err;
  }

  if (!res.ok) {
    const err = new Error(
      `Football-Data.org returned HTTP ${res.status}`
    );

    err.code = "HTTP_ERROR";

    throw err;
  }

  return res.json();
}

/** Fetch Barcelona's own team record (gives us the home venue). */
async function fetchBarcaTeam() {
  const data = await footballDataFetch(
    `/teams/${BARCA_TEAM_ID}`
  );

  return {
    id: data.id ?? BARCA_TEAM_ID,

    name: data.name || "FC Barcelona",

    venue: data.venue || null,

    city:
      (data.address &&
        String(data.address).split("\n")[0]) ||
      null,

    runningCompetitions:
      Array.isArray(data.runningCompetitions)
        ? data.runningCompetitions
        : [],
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

async function fetchCompetition(
  competitionCode
) {
  return footballDataFetch(
    `/competitions/${encodeURIComponent(
      competitionCode
    )}`
  );
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
function normalizeMatches(matches) {
  return matches
    .map((match) => {
      const homeTeam = match.homeTeam || {};
      const awayTeam = match.awayTeam || {};
      const fullTime = match.score?.fullTime || {};

      const isBarcaHome =
        Number(homeTeam.id) === Number(BARCA_TEAM_ID);

      const isBarcaAway =
        Number(awayTeam.id) === Number(BARCA_TEAM_ID);

      const goals = Array.isArray(match.goals)
        ? match.goals.map((goal) => ({
            minute: Number.isInteger(goal.minute)
              ? goal.minute
              : null,

            injuryTime:
              Number.isInteger(goal.injuryTime)
                ? goal.injuryTime
                : null,

            scorer:
              goal.scorer?.name ||
              "Unknown scorer",

            teamId:
              goal.team?.id ??
              null,

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

        minute: match.minute ?? null,

        injuryTime:
          match.injuryTime ?? null,

        competitionId:
          match.competition?.id ??
          null,

        competition:
          match.competition?.name ??
          null,

        competitionCode:
          match.competition?.code ??
          null,

        competitionEmblem:
          match.competition?.emblem ??
          null,

        season:
          match.season ??
          null,

        matchday:
          match.matchday ??
          null,

        stage:
          match.stage ??
          null,

        group:
          match.group ??
          null,

        venue:
          match.venue ??
          null,

        city:
          match.city ??
          null,

        homeTeamId:
          homeTeam.id ??
          null,

        homeTeam:
          homeTeam.name ||
          "Home Team",

        homeCrest:
          homeTeam.crest ||
          null,

        awayTeamId:
          awayTeam.id ??
          null,

        awayTeam:
          awayTeam.name ||
          "Away Team",

        awayCrest:
          awayTeam.crest ||
          null,

        isHome:
          isBarcaHome,

        isAway:
          isBarcaAway,

        isBarcaMatch:
          isBarcaHome ||
          isBarcaAway,

        score: {
          home:
            Number.isInteger(fullTime.home)
              ? fullTime.home
              : null,

          away:
            Number.isInteger(fullTime.away)
              ? fullTime.away
              : null,
        },

        goals,
      };
    })
    .filter(
      (match) =>
        match.homeTeamId != null &&
        match.awayTeamId != null
    );
}

/** Attach resolved venues to matches using the venue cache (home matches use Camp Nou). */
function attachVenues(matches, cache) {
  return matches.map((match) => {
    /*
     * Best source:
     * the venue supplied directly by the match.
     */
    if (match.venue) {
      return match;
    }

    /*
     * Barcelona home fallback.
     */
    if (
      Number(match.homeTeamId) ===
      Number(BARCA_TEAM_ID)
    ) {
      return {
        ...match,
        venue:
          cache.homeVenue?.venue ||
          "Spotify Camp Nou",

        city:
          cache.homeVenue?.city ||
          "Barcelona",
      };
    }

    /*
     * For all other matches, the home team's
     * cached venue is the correct venue.
     */
    const homeVenue =
      cache.venueCache?.[match.homeTeamId];

    if (homeVenue) {
      return {
        ...match,
        venue:
          homeVenue.venue ||
          "Venue TBC",

        city:
          homeVenue.city ||
          "",
      };
    }

    return {
      ...match,
      venue: "Venue TBC",
      city: "",
    };
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
    /*
     * 1. Load Barcelona (gives us the home venue + running competitions).
     */
    const barcaTeam =
      await fetchBarcaTeam();

    if (barcaTeam.venue) {
      cache.homeVenue = {
        venue:
          barcaTeam.venue,

        city:
          barcaTeam.city ||
          "Barcelona",
      };
    }

    /*
     * 2. Fetch ALL Barcelona matches across every competition
     *    (La Liga, Champions League, Copa del Rey, Supercopa, etc.)
     *    in a single API call.
     */
    const matchesData =
      await footballDataFetch(
        `/teams/${BARCA_TEAM_ID}/matches?limit=100`
      );

    const barcaMatches =
      (matchesData.matches || []).filter(
        (match) => {
          const homeTeamId =
            Number(match.homeTeam?.id);

          const awayTeamId =
            Number(match.awayTeam?.id);

          return (
            homeTeamId ===
              Number(BARCA_TEAM_ID) ||
            awayTeamId ===
              Number(BARCA_TEAM_ID)
          );
        }
      );

    /*
     * 2b. Fetch ALL matches from each competition Barça is in
     *     (not just Barça's) so the predictor can cover every match
     *     in the gameweek. We use each competition's current season
     *     and a date window from now to ~4 months ahead.
     *
     *     If the API is rate-limited, we keep the existing non-Barça
     *     matches from the cache so the predictor still has them.
     */
    const now = new Date();
    // Look back 7 days so recently FINISHED matches get their final scores
    // updated in the cache (otherwise they stay stale as IN_PLAY/TIMED).
    const dateFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const dateTo = new Date(now.getTime() + 120 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const competitions = (barcaTeam.runningCompetitions || []);
    const allCompMatches = [];
    let nonBarcaFetchFailed = false;

    for (const comp of competitions) {
      if (!comp.code) continue;
      try {
        // Get the competition's current season start year
        const compData = await footballDataFetch(
          `/competitions/${encodeURIComponent(comp.code)}`
        );
        const seasonYear = compData?.currentSeason?.startDate
          ? Number(String(compData.currentSeason.startDate).slice(0, 4))
          : null;

        let url = `/competitions/${encodeURIComponent(comp.code)}/matches`;
        const params = [];
        if (seasonYear) params.push(`season=${seasonYear}`);
        params.push(`dateFrom=${dateFrom}`);
        params.push(`dateTo=${dateTo}`);
        url += `?${params.join("&")}`;

        const compMatchesData = await footballDataFetch(url);
        const compMatches = (compMatchesData.matches || []).filter((m) => {
          const hid = Number(m.homeTeam?.id);
          const aid = Number(m.awayTeam?.id);
          // Skip Barça matches — already fetched above
          return hid !== Number(BARCA_TEAM_ID) && aid !== Number(BARCA_TEAM_ID);
        });
        allCompMatches.push(...compMatches);
        console.log(`[fixtures] fetched ${compMatches.length} non-Barça matches from ${comp.code} (season ${seasonYear})`);
      } catch (err) {
        nonBarcaFetchFailed = true;
        console.warn(`[fixtures] could not fetch all matches for ${comp.code} (non-fatal):`, err.message);
      }
    }

    /*
     * Combine fresh Barça matches + whatever non-Barça matches we managed
     * to fetch (may be partial if rate-limited). The merge below fills in
     * any gaps from the existing cache.
     */
    const finalRawMatches = [...barcaMatches, ...allCompMatches];

    /*
     * 3. Normalize all matches (Barça + other competitions).
     *    Always merge with existing non-Barça matches from the cache so
     *    that finished matches (which aren't in the date-filtered fetch)
     *    are preserved for the predictor reveal + scoring.
     *
     *    Fresh matches take priority over cached ones (so scores/status
     *    get updated). Cached matches that aren't in the fresh fetch are
     *    kept as-is.
     */
    let matches;
    {
      const freshNormalized = normalizeMatches(finalRawMatches);
      const freshIds = new Set(freshNormalized.map((m) => m.id));
      // Keep existing non-Barça matches that aren't in the fresh fetch
      // (e.g. finished matches older than the 7-day lookback window).
      const existingKept = (cache.matches || [])
        .filter((m) => !m.isBarcaMatch && !freshIds.has(m.id));
      matches = [...freshNormalized, ...existingKept];
      if (nonBarcaFetchFailed && existingKept.length) {
        console.log(`[fixtures] rate-limited — kept ${existingKept.length} existing non-Barça matches from cache`);
      }
    }

    /*
     * 4. Update the cache competition field from the league
     *    (for backwards compat with admin dashboard).
     */
    const league =
      Array.isArray(
        barcaTeam.runningCompetitions
      )
        ? barcaTeam.runningCompetitions.find(
            (competition) =>
              String(
                competition.type || ""
              ).toUpperCase() ===
              "LEAGUE"
          )
        : null;

    if (league?.code) {
      try {
        const competitionData =
          await footballDataFetch(
            `/competitions/${encodeURIComponent(
              league.code
            )}`
          );

        const currentSeason =
          competitionData?.currentSeason;

        if (currentSeason?.startDate) {
          cache.competition = {
            id:
              competitionData.id ??
              league.id ??
              null,

            code:
              competitionData.code ||
              league.code,

            name:
              competitionData.name ||
              league.name ||
              "League",

            type:
              competitionData.type ||
              league.type ||
              "LEAGUE",

            emblem:
              competitionData.emblem ||
              league.emblem ||
              null,

            season: {
              id:
                currentSeason.id ??
                null,

              startDate:
                currentSeason.startDate,

              endDate:
                currentSeason.endDate,

              currentMatchday:
                currentSeason.currentMatchday ??
                null,
            },
          };
        }
      } catch (err) {
        console.warn(
          "[fixtures] could not fetch league competition details (non-fatal):",
          err.message
        );
      }
    }

    /*
     * 5. Venue resolution for away matches missing a venue.
     */

    const teamIdsNeedingVenue = [
      ...new Set(
        matches
          .filter(
            (match) =>
              !match.venue
          )
          .map(
            (match) =>
              match.homeTeamId
          )
          .filter(Boolean)
      ),
    ].filter(
      (teamId) =>
        !cache.venueCache?.[teamId]
    );

    for (
      const teamId of
        teamIdsNeedingVenue
    ) {
      try {
        const venue =
          await fetchTeamVenue(
            teamId
          );

        if (venue) {
          cache.venueCache[
            teamId
          ] = venue;
        }
      } catch (err) {
        if (
          err.code ===
          "RATE_LIMITED"
        ) {
          console.warn(
            "[fixtures] venue lookup rate limited; stopping venue resolution"
          );

          break;
        }

        console.error(
          "[fixtures] failed to resolve venue for team",
          teamId,
          err.message
        );
      }

      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            1200
          )
      );
    }

    /*
     * 9. Attach venues.
     */
    const withVenues =
      attachVenues(
        matches,
        cache
      );

    /*
     * 10. Save ALL matches, then re-apply any manual overrides so they
     *     survive syncs (the API sometimes returns wrong/stale data).
     */
    cache.matches = withVenues;
    applyOverrides(cache);

    cache.lastSync =
      new Date().toISOString();

    cache.apiStatus =
      "ok";

    cache.lastError =
      null;

    writeCache(cache);

    console.log(
      `[fixtures] synced ${cache.matches.length} Barcelona matches across all competitions`
    );

    return cache;

  } catch (err) {
    console.error(
      "[fixtures] sync failed:",
      err.message
    );

    cache.apiStatus =
      "error";

    cache.lastError =
      err.message;

    cache.lastSync =
      cache.lastSync ||
      null;

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
 * Apply stored overrides to the matches in cache (in-place).
 * Called after every sync so manual fixes survive API refreshes.
 */
function applyOverrides(cache) {
  const overrides = cache.overrides || {};
  if (!Object.keys(overrides).length) return;
  let applied = 0;
  for (const match of cache.matches || []) {
    const ov = overrides[String(match.id)];
    if (!ov) continue;
    match.status = ov.status;
    if (Number.isInteger(ov.homeScore) && Number.isInteger(ov.awayScore)) {
      match.score = { home: ov.homeScore, away: ov.awayScore };
    }
    applied++;
  }
  if (applied) console.log(`[fixtures] re-applied ${applied} manual override(s)`);
}

/**
 * Manually override a match's status and score in the cache.
 * Used when the API returns wrong/stale data (e.g. FINISHED match showing TIMED).
 * The override is stored persistently and re-applied after every sync.
 * Returns the updated match or null if not found.
 */
function overrideMatchResult(fixtureId, status, homeScore, awayScore) {
  const cache = readCache();
  const match = (cache.matches || []).find((m) => String(m.id) === String(fixtureId));
  if (!match) return null;
  match.status = status;
  if (Number.isInteger(homeScore) && Number.isInteger(awayScore)) {
    match.score = { home: homeScore, away: awayScore };
  }
  // Store in overrides so it survives future syncs
  if (!cache.overrides) cache.overrides = {};
  cache.overrides[String(fixtureId)] = { status, homeScore, awayScore };
  writeCache(cache);
  console.log(`[fixtures] override saved for match ${fixtureId}: ${status} ${homeScore}-${awayScore}`);
  return match;
}

module.exports = {
  syncFixtures,
  getCachedFixtures,
  clearFixturesCache,
  updateNextSync,
  getFixtureResult,
  overrideMatchResult,
  CACHE_PATH,
  BARCA_TEAM_ID,
};
async function getFixtureResult(
  fixtureId
) {
  const data =
    await footballDataFetch(
      `/matches/${encodeURIComponent(
        fixtureId
      )}`
    );

  const fullTime =
    data.score?.fullTime ||
    {};

  const goals =
    Array.isArray(data.goals)
      ? data.goals.map(
          (goal) => ({
            minute:
              Number.isInteger(
                goal.minute
              )
                ? goal.minute
                : null,

            injuryTime:
              Number.isInteger(
                goal.injuryTime
              )
                ? goal.injuryTime
                : null,

            scorer:
              goal.scorer
                ?.name ||
              "Unknown scorer",

            teamId:
              goal.team?.id ??
              null,

            teamName:
              goal.team?.name ||
              "",
          })
        )
      : [];

  return {
    id: data.id,

    status:
      data.status,

    score: {
      home:
        Number.isInteger(
          fullTime.home
        )
          ? fullTime.home
          : null,

      away:
        Number.isInteger(
          fullTime.away
        )
          ? fullTime.away
          : null,
    },

    goals,
  };
}