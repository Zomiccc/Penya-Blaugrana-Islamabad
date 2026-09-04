/* ==========================================================================
   PREDICTOR LEAGUE — rules engine
   All the league's rules live here so they are enforced in exactly one place:

   1. WINDOW      Members predict one competition's round at a time — the next
                  10 upcoming fixtures for a league (La Liga), or every
                  fixture in the round for a cup/group competition (Champions
                  League) — whichever competition is soonest up next.
   2. DEADLINE    The whole set locks when the FIRST of those matches kicks off.
   3. IMMUTABLE   A prediction, once stored, is never changed by anyone. This
                  module never returns an "update" path, and the only write in
                  the app rejects duplicates. Admin has no edit route at all.
   4. PRIVACY     Another member's prediction is only ever exposed after that
                  match has kicked off. Filtering happens server-side.
   5. POINTS      Exact score = 3, correct result (W/D/L) = 1, wrong = 0.
   ========================================================================== */

const PREDICTION_WINDOW_SIZE = 10;

// Competitions that get every fixture in their current round shown, instead
// of being capped at PREDICTION_WINDOW_SIZE. A Champions League matchday can
// have far more simultaneous fixtures than a league round does (up to 18 in
// the current 36-team format), so capping it would arbitrarily hide most of
// the round.
const UNCAPPED_COMPETITION_CODES = new Set(['CL']);

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
 * The prediction set members currently see: fixtures from exactly ONE
 * competition at a time — whichever competition has the soonest upcoming
 * fixture. Right now that's La Liga; once La Liga's round finishes and the
 * next Champions League round becomes the soonest thing on the calendar, the
 * set switches over to it automatically. Competitions never mix in one set.
 *
 * League competitions (e.g. La Liga) use a rolling window of the next `size`
 * upcoming fixtures. Cup/group competitions in UNCAPPED_COMPETITION_CODES
 * (e.g. the Champions League) instead show every fixture in the current
 * matchday, uncapped.
 */
function getPredictionWindow(matches, now = new Date(), size = PREDICTION_WINDOW_SIZE) {
  const upcoming = (matches || [])
    .filter((m) => isPlayable(m) && !hasKickedOff(m, now))
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));

  if (!upcoming.length) return [];

  const soonest = upcoming[0];
  const competitionKey = soonest.competitionId || soonest.competition;
  // `upcoming` is already sorted soonest-first, and .filter() preserves
  // relative order, so no re-sort is needed after this.
  const sameCompetition = upcoming.filter((m) => (m.competitionId || m.competition) === competitionKey);

  if (UNCAPPED_COMPETITION_CODES.has(soonest.competitionCode)) {
    return sameCompetition.filter((m) => m.matchday === soonest.matchday);
  }

  return sameCompetition.slice(0, size);
}

/** Time wasted here = 2 Hours! If u are a dev and encountring this english guy just to let yk u will receive a fucking ton of changes for no fucking reason
 * The submission deadline: kickoff of the soonest upcoming match. Once this
 * passes, the current set is closed (a new set — and a new deadline — opens as
 * the window rolls forward).
 */
function getDeadline(matches, now = new Date()) {
  const window = getPredictionWindow(matches, now);
  return window.length ? new Date(window[0].utcDate) : null;
}

/** 'HOME' | 'AWAY' | 'DRAW' for any home/away goal pair. */
function outcome(homeGoals, awayGoals) {
  if (homeGoals > awayGoals) return 'HOME';
  if (homeGoals < awayGoals) return 'AWAY';
  return 'DRAW';
}

function hasFinalScore(match) {
  if (
    match &&
    match.status === 'FINISHED' &&
    Number.isInteger(match.score?.home) &&
    Number.isInteger(match.score?.away)
  ) {
    return true;
  }
  // Belt-and-braces: if the API gave us a bogus status but the match
  // kicked off long ago and we have integer scores, treat it as finished.
  // The 3-hour window covers extra time + penalties + slight API delays.
  if (
    match &&
    match.utcDate &&
    Number.isInteger(match.score?.home) &&
    Number.isInteger(match.score?.away) &&
    !['SCHEDULED', 'TIMED', 'POSTPONED', 'CANCELLED', 'SUSPENDED'].includes(match.status)
  ) {
    const kickoff = new Date(match.utcDate).getTime();
    if (kickoff + 3 * 60 * 60 * 1000 <= Date.now()) return true;
  }
  return false;
}

/**
 * Points for a single prediction against a finished match.
 * Returns 0 for matches that aren't finished yet (nothing to score).
 */
function scorePrediction(prediction, match) {
  if (!hasFinalScore(match)) return 0;
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

/** Human-readable label for how a prediction scored — used in the UI. */
function scoreLabel(points) {
  if (points === POINTS.EXACT_SCORE) return 'Exact score';
  if (points === POINTS.CORRECT_RESULT) return 'Correct result';
  return 'Wrong result';
}

/**
 * Build the league table. One row per member who has ever predicted, sorted by
 * total points (then exact-score count, then name) so ties break sensibly.
 */
function buildLeaderboard(predictions, members, matches) {
  const matchById = new Map((matches || []).map((m) => [String(m.id), m]));
  const memberById = new Map((members || []).map((m) => [m.id, m]));
  const rows = new Map();

  for (const p of predictions || []) {
    const member = memberById.get(p.memberId);
    if (!member) continue; // member record removed — skip rather than crash

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

    const match = matchById.get(String(p.fixtureId));
    if (!hasFinalScore(match)) continue;

    const pts = scorePrediction(p, match);
    row.points += pts;
    row.played += 1;
    if (pts === POINTS.EXACT_SCORE) row.exact += 1;
    else if (pts === POINTS.CORRECT_RESULT) row.correctResult += 1;
  }

  return [...rows.values()]
    .sort((a, b) => b.points - a.points || b.exact - a.exact || a.name.localeCompare(b.name))
    .map((row, i) => ({ ...row, rank: i + 1 }));
}

module.exports = {
  PREDICTION_WINDOW_SIZE,
  POINTS,
  hasKickedOff,
  isPlayable,
  getPredictionWindow,
  getDeadline,
  outcome,
  hasFinalScore,
  scorePrediction,
  scoreLabel,
  buildLeaderboard,
};
