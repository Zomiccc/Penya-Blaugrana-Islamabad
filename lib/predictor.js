/* ==========================================================================
   PREDICTOR LEAGUE — rules engine
   All the league's rules live here so they are enforced in exactly one place:

   1. WINDOW      Members predict one competition's round (matchday) at a
                  time — every fixture in that round, whichever competition
                  has the soonest upcoming fixture. Never mixes two rounds or
                  two competitions in one set, even if the current round is
                  down to its last unplayed fixture.
   2. DEADLINE    The whole set locks when the FIRST of those matches kicks off.
   3. IMMUTABLE   A prediction, once stored, is never changed by anyone. This
                  module never returns an "update" path, and the only write in
                  the app rejects duplicates. Admin has no edit route at all.
   4. PRIVACY     Another member's prediction is only ever exposed after that
                  match has kicked off. Filtering happens server-side.
   5. POINTS      Exact score = 3, correct result (W/D/L) = 1, wrong = 0.
   ========================================================================== */

const POINTS = {
  EXACT_SCORE: 3,
  CORRECT_RESULT: 1,
  WRONG: 0,
};

// A match is no longer predictable once it has kicked off, whatever the API
// status says (status can lag behind real kickoff time by a few minutes).
function hasKickedOff(match, now = new Date()) {
  return new Date(match.utcDate) <= now;
}

function isPlayable(match) {
  return !['POSTPONED', 'CANCELLED', 'SUSPENDED'].includes(match.status);
}

/**
 * The prediction set for one competition: every upcoming fixture in that
 * competition's CURRENT round (the matchday of its soonest upcoming fixture).
 * As those fixtures kick off one by one the set shrinks to whatever is left
 * in the round; once the whole round has started, it rolls on to the next
 * matchday.
 *
 * La Liga and the Champions League run concurrently, and the club scores
 * them as two separate competitions, so the caller says which one it wants.
 * Deliberately never mixes two rounds or two competitions into one set, and
 * never backfills with fixtures from a different round to pad the set out.
 *
 * @param {string} [competitionCode] e.g. 'PD' (La Liga) or 'CL' (Champions
 *   League). Omit to auto-pick whichever competition has the soonest
 *   upcoming fixture.
 */
function getPredictionWindow(matches, now = new Date(), competitionCode) {
  const upcoming = (matches || [])
    .filter((m) => isPlayable(m) && !hasKickedOff(m, now))
    .filter((m) => !competitionCode || m.competitionCode === competitionCode)
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));

  if (!upcoming.length) return [];

  const soonest = upcoming[0];
  const competitionKey = soonest.competitionId || soonest.competition;
  // `upcoming` is already sorted soonest-first, and .filter() preserves
  // relative order, so no re-sort is needed after this.
  return upcoming.filter(
    (m) => (m.competitionId || m.competition) === competitionKey && m.matchday === soonest.matchday,
  );
}

/** Time wasted here = 2 Hours! If u are a dev and encountring this english guy just to let yk u will receive a fucking ton of changes for no fucking reason
 * The submission deadline: kickoff of the soonest upcoming match. Once this
 * passes, the current set is closed (a new set — and a new deadline — opens as
 * the window rolls forward).
 */
function getDeadline(matches, now = new Date(), competitionCode) {
  const window = getPredictionWindow(matches, now, competitionCode);
  return window.length ? new Date(window[0].utcDate) : null;
}

/**
 * Which round and season a competition's tables should currently describe.
 *
 * Prefers the open prediction round, so the weekly table tracks the same
 * match week members are predicting and starts from zero when that rolls
 * over. Between rounds (or once the season's fixtures are exhausted) there
 * is no open window, so it falls back to the most recent round that has
 * actually been played — otherwise the weekly table would go blank.
 */
function getCurrentRound(matches, now = new Date(), competitionCode) {
  const inCompetition = (matches || []).filter(
    (m) => !competitionCode || m.competitionCode === competitionCode,
  );
  if (!inCompetition.length) return { matchday: null, seasonId: null };

  // "Current week" is the round open for predictions. As soon as one week
  // ends and the next opens, the table moves on and lists everyone who has
  // predicted at 0 points / 0 exact — it shows WHO has entered, without
  // giving away WHAT they picked. The scorelines stay sealed until kickoff;
  // that's enforced per match in the results endpoint, not here.
  // Earlier weeks remain readable through the week picker.
  const window = getPredictionWindow(inCompetition, now, competitionCode);
  if (window.length) {
    return { matchday: window[0].matchday ?? null, seasonId: window[0].season?.id ?? null };
  }

  // No round open (end of season) — fall back to the one most recently played.
  const lastStarted = inCompetition
    .filter((m) => hasKickedOff(m, now))
    .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))[0];
  if (lastStarted) {
    return { matchday: lastStarted.matchday ?? null, seasonId: lastStarted.season?.id ?? null };
  }
  return { matchday: null, seasonId: inCompetition[0].season?.id ?? null };
}

/**
 * Match weeks that can be shown in the week picker, newest first — the
 * current round plus every earlier round of this season that has been
 * played. Future rounds are excluded: nobody has predicted them yet and
 * listing them would just be empty tables.
 */
function getSelectableWeeks(matches, now = new Date(), competitionCode) {
  const { matchday: current, seasonId } = getCurrentRound(matches, now, competitionCode);
  const weeks = new Set();
  if (Number.isInteger(current)) weeks.add(current);

  for (const m of matches || []) {
    if (competitionCode && m.competitionCode !== competitionCode) continue;
    if (seasonId != null && (m.season?.id ?? null) !== seasonId) continue;
    if (!Number.isInteger(m.matchday)) continue;
    if (hasKickedOff(m, now)) weeks.add(m.matchday);
  }
  return [...weeks].sort((a, b) => b - a);
}

/** 'HOME' | 'AWAY' | 'DRAW' for any home/away goal pair. */
function outcome(homeGoals, awayGoals) {
  if (homeGoals > awayGoals) return 'HOME';
  if (homeGoals < awayGoals) return 'AWAY';
  return 'DRAW';
}

/**
 * @param {object} match
 * @param {string|null} [lastSyncIso] ISO timestamp of the last successful
 *   fixture sync (data/fixtures.json's `lastSync`). Required to safely use
 *   the bogus-status fallback below — see its comment for why.
 */
function hasFinalScore(match, lastSyncIso) {
  if (
    match &&
    match.status === 'FINISHED' &&
    Number.isInteger(match.score?.home) &&
    Number.isInteger(match.score?.away)
  ) {
    return true;
  }
  // Belt-and-braces: if the API gave us a bogus status but the match kicked
  // off long ago and we have integer scores, treat it as finished. The
  // 3-hour window covers extra time + penalties + slight API delays.
  //
  // This is ONLY safe if we've actually re-synced with Football-Data.org
  // some time after that 3-hour mark. Without that check, a match whose
  // cache simply hasn't refreshed in a while (a missed sync, the host being
  // asleep, a rate limit) would have its LAST KNOWN score — which could be
  // a mid-match snapshot, e.g. the halftime score — wrongly locked in as the
  // final result, scoring every prediction against a scoreline the match
  // never actually ended on.
  if (
    match &&
    match.utcDate &&
    Number.isInteger(match.score?.home) &&
    Number.isInteger(match.score?.away) &&
    !['SCHEDULED', 'TIMED', 'POSTPONED', 'CANCELLED', 'SUSPENDED'].includes(match.status)
  ) {
    const presumedFinishTime = new Date(match.utcDate).getTime() + 3 * 60 * 60 * 1000;
    if (presumedFinishTime > Date.now()) return false;
    if (!lastSyncIso) return false;
    return new Date(lastSyncIso).getTime() >= presumedFinishTime;
  }
  return false;
}

/**
 * Points for a single prediction against a finished match.
 * Returns 0 for matches that aren't finished yet (nothing to score).
 */
function scorePrediction(prediction, match, lastSyncIso) {
  if (!hasFinalScore(match, lastSyncIso)) return 0;
  const actualHome = match.score.home;
  const actualAway = match.score.away;

  if (prediction.homeGoals === actualHome && prediction.awayGoals === actualAway) {
    return POINTS.EXACT_SCORE;
  }
  if (outcome(prediction.homeGoals, prediction.awayGoals) === outcome(actualHome, actualAway)) {
    return POINTS.CORRECT_RESULT;
  }
  return POINTS.WRONG;
}

/**
 * How far a prediction was from the real score — lower is closer.
 *
 * Squared distance on each team, summed. Deliberately NOT the plain sum of
 * differences: for an actual 4-0, a 3-1 and a 2-0 guess are both "2 goals
 * out" in total, but 3-1 is closer on both teams at once and is the one the
 * club counts as nearer. Squaring makes being badly wrong on one team cost
 * more than being slightly wrong on both, which matches that.
 */
function predictionDistance(prediction, match) {
  const dh = match.score.home - prediction.homeGoals;
  const da = match.score.away - prediction.awayGoals;
  return dh * dh + da * da;
}

/**
 * The single closest prediction for a finished match.
 *
 * @returns {{memberId: string, name: string, distance: number}|null} null if
 *   the match has no final score yet or nobody predicted it.
 */
function pickMatchWinner(predictions, match, lastSyncIso, nameFor = () => '') {
  if (!hasFinalScore(match, lastSyncIso)) return null;

  const entries = (predictions || [])
    .filter((p) => String(p.fixtureId) === String(match.id))
    .map((p) => ({
      memberId: p.memberId,
      name: p.memberName || nameFor(p.memberId) || '',
      distance: predictionDistance(p, match),
    }));
  if (!entries.length) return null;

  // Closest first; an exact tie goes to whoever comes first alphabetically.
  entries.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
  return entries[0];
}

/** Human-readable label for how a prediction scored — used in the UI. */
function scoreLabel(points) {
  if (points === POINTS.EXACT_SCORE) return 'Exact score';
  if (points === POINTS.CORRECT_RESULT) return 'Correct result';
  return 'Wrong result';
}

/**
 * Build the league table. One row per member who has predicted at least one
 * match IN THIS COMPETITION.
 *
 * Ordering, in the club's stated priority:
 *   1. points
 *   2. exact correct scores
 *   3. position in the season standings
 *   4. name, alphabetically
 *
 * Step 3 only applies when `seasonRankByMemberId` is supplied — it's what
 * separates two members level on points and exacts in a weekly table, by
 * whoever is doing better over the season. The season table itself can't use
 * it (it would be ranking by itself), so there it falls straight to name.
 *
 * @param {string} [competitionCode] Restrict to one competition (e.g. 'PD'
 *   for La Liga, 'CL' for the Champions League) — the club runs a separate
 *   table per competition, so a member's Champions League picks never affect
 *   their La Liga standing or vice versa. Omit to combine every competition
 *   into one table (kept for callers that still want that).
 * @param {object} [opts]
 * @param {number|null} [opts.matchday] Only count this round — used for the
 *   weekly table, which starts from zero again every match week.
 * @param {number|null} [opts.seasonId] Only count this season — used for the
 *   season standings, so last season's points never carry over.
 * @param {Map<string,number>|null} [opts.seasonRankByMemberId] Season
 *   position per member, used as the third tiebreak.
 */
function buildLeaderboard(predictions, members, matches, lastSyncIso, competitionCode, opts = {}) {
  const { matchday = null, seasonId = null, seasonRankByMemberId = null } = opts;
  const matchById = new Map((matches || []).map((m) => [String(m.id), m]));
  const memberById = new Map((members || []).map((m) => [m.id, m]));
  const rows = new Map();

  for (const p of predictions || []) {
    const member = memberById.get(p.memberId);
    if (!member) continue; // member record removed — skip rather than crash

    const match = matchById.get(String(p.fixtureId));
    if (competitionCode && match?.competitionCode !== competitionCode) continue;
    if (matchday !== null && match?.matchday !== matchday) continue;
    if (seasonId !== null && (match?.season?.id ?? null) !== seasonId) continue;

    if (!rows.has(p.memberId)) {
      rows.set(p.memberId, {
        memberId: p.memberId,
        name: `${member.firstName} ${member.lastName}`.trim(),
        points: 0,
        played: 0,
        exact: 0,
        correctResult: 0,
        predictionsMade: 0,
      });
    }
    const row = rows.get(p.memberId);
    row.predictionsMade += 1;

    if (!hasFinalScore(match, lastSyncIso)) continue;

    const pts = scorePrediction(p, match, lastSyncIso);
    row.points += pts;
    row.played += 1;
    if (pts === POINTS.EXACT_SCORE) row.exact += 1;
    else if (pts === POINTS.CORRECT_RESULT) row.correctResult += 1;
  }

  return [...rows.values()]
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.exact !== a.exact) return b.exact - a.exact;
      if (seasonRankByMemberId) {
        // Better season position first. Anyone missing from the season table
        // sorts last rather than jumping the queue.
        const ra = seasonRankByMemberId.get(a.memberId) ?? Number.MAX_SAFE_INTEGER;
        const rb = seasonRankByMemberId.get(b.memberId) ?? Number.MAX_SAFE_INTEGER;
        if (ra !== rb) return ra - rb;
      }
      return a.name.localeCompare(b.name);
    })
    .map((row, i) => ({ ...row, rank: i + 1 }));
}

module.exports = {
  POINTS,
  hasKickedOff,
  isPlayable,
  getPredictionWindow,
  getDeadline,
  getCurrentRound,
  getSelectableWeeks,
  outcome,
  hasFinalScore,
  predictionDistance,
  pickMatchWinner,
  scorePrediction,
  scoreLabel,
  buildLeaderboard,
};
