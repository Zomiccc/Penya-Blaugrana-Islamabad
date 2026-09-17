/* ==========================================================================
   PREDICTOR LEAGUE — rules engine
   All the league's rules live here so they are enforced in exactly one place:

   1. WINDOW      Members predict one competition's round (matchday) at a
                  time — every fixture in that round, whichever competition
                  opens soonest. Never mixes two rounds or two competitions
                  in one set.
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

/* A round is sometimes scattered: leagues move one fixture weeks away from
   the rest of its matchday (La Liga played a matchday-6 game on 3 September,
   twelve days before the other nine). Split a matchday wherever consecutive
   kickoffs are more than a week apart and keep the largest cluster — that is
   the round as the club actually plays it. Without this, one displaced game
   would set the whole round's deadline and close it before anybody could
   predict. */
const ROUND_GAP_MS = 7 * 24 * 60 * 60 * 1000;

/** Every round of a competition, each trimmed to its main block of fixtures. */
function roundBlocks(matches, competitionCode) {
  const groups = new Map();
  for (const m of (matches || []).filter((x) => isPlayable(x))) {
    if (competitionCode && m.competitionCode !== competitionCode) continue;
    const key = `${m.competitionId || m.competition}:${m.matchday ?? 0}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  return [...groups.values()].map(roundBlock);
}

function roundBlock(group) {
  const sorted = [...group].sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));
  const clusters = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const gap = new Date(sorted[i].utcDate) - new Date(sorted[i - 1].utcDate);
    if (gap > ROUND_GAP_MS) clusters.push([]);
    clusters[clusters.length - 1].push(sorted[i]);
  }
  return clusters.sort(
    (a, b) => b.length - a.length || new Date(a[0].utcDate) - new Date(b[0].utcDate),
  )[0];
}

/**
 * The prediction set for one competition: every fixture in the next round of
 * that competition that has NOT yet started.
 *
 * A round is offered whole and closes whole. The moment its first match
 * kicks off the entire round stops accepting predictions and the next round
 * opens in its place — rule 2 above. The set never shrinks match by match:
 * letting members keep entering the rest of a round after it had begun meant
 * someone arriving on the Sunday could still predict the last game with nine
 * of the ten results already known, and the countdown on the page said
 * "closed" while the boxes were still live.
 *
 * La Liga and the Champions League run concurrently, and the club scores
 * them as two separate competitions, so the caller says which one it wants.
 * Deliberately never mixes two rounds or two competitions into one set, and
 * never backfills with fixtures from a different round to pad the set out.
 *
 * @param {string} [competitionCode] e.g. 'PD' (La Liga) or 'CL' (Champions
 *   League). Omit to auto-pick whichever competition's round opens soonest.
 */
function getPredictionWindow(matches, now = new Date(), competitionCode) {
  // Pick the round by when MOST of it is played, not by its single earliest
  // fixture. Leagues reschedule individual games weeks out of order, and
  // keying on the earliest fixture let one displaced game drag the whole
  // window forward, offering matchday 6 while 4 and 5 were still to come.
  const medianTime = (block) =>
    new Date(block[Math.floor(block.length / 2)].utcDate).getTime();

  const open = roundBlocks(matches, competitionCode)
    // A round whose first match has kicked off is shut, for everyone, for good.
    .filter((block) => !hasKickedOff(block[0], now))
    .sort((a, b) => medianTime(a) - medianTime(b));

  return open.length ? open[0] : [];
}

/** Time wasted here = 2 Hours! If u are a dev and encountring this english guy just to let yk u will receive a fucking ton of changes for no fucking reason
 * The submission deadline: kickoff of the FIRST match of the open round.
 * Once it passes the whole round is shut and the next one opens in its
 * place, with its own deadline.
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

  // While a round is being played it IS the current week, and the table stays
  // on it so members can follow this week's scoring as the results land.
  // Predictions have already moved on by then — a round closes at its first
  // kickoff — but the table must not move with them, or the club would be
  // staring at an empty next-week table all weekend while games are on.
  // The club sets the changeover at the LAST kickoff of the round: the week
  // on the table turns over the moment its final match starts, not when that
  // match ends and not when the next week opens for entry. Predictions run
  // ahead of the table by design — the next round is already open — but its
  // table stays hidden until this one has finished being handed out.
  const inPlay = roundBlocks(inCompetition, competitionCode)
    .filter((block) => hasKickedOff(block[0], now))
    .filter((block) => !hasKickedOff(block[block.length - 1], now))
    .sort((a, b) => new Date(b[0].utcDate) - new Date(a[0].utcDate))[0];
  if (inPlay) {
    return { matchday: inPlay[0].matchday ?? null, seasonId: inPlay[0].season?.id ?? null };
  }

  // Nothing in play — show the round that is open for predictions, listing
  // everyone who has entered at 0 points / 0 exact. It shows WHO has entered
  // without giving away WHAT they picked; the scorelines stay sealed until
  // kickoff, enforced per match in the results endpoint rather than here.
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
  const {
    matchday = null,
    seasonId = null,
    seasonRankByMemberId = null,
    // Last-resort name lookup for a member whose record has been deleted —
    // see the comment in the loop below.
    resolveName = () => '',
  } = opts;
  const matchById = new Map((matches || []).map((m) => [String(m.id), m]));
  const memberById = new Map((members || []).map((m) => [m.id, m]));
  const rows = new Map();

  for (const p of predictions || []) {
    // Deleting a member used to erase their results from every past week,
    // silently rewriting who won it. Anyone whose name we still know stays
    // in the table: from their member record, the name snapshotted on the
    // prediction, or one the admin re-attached. Only entries with no name
    // at all are dropped, so no "Former member" rows appear.
    const member = memberById.get(p.memberId);
    const name = member
      ? `${member.firstName} ${member.lastName}`.trim()
      : (p.memberName || resolveName(p.memberId) || '');
    if (!name) continue;

    const match = matchById.get(String(p.fixtureId));
    if (competitionCode && match?.competitionCode !== competitionCode) continue;
    if (matchday !== null && match?.matchday !== matchday) continue;
    if (seasonId !== null && (match?.season?.id ?? null) !== seasonId) continue;

    if (!rows.has(p.memberId)) {
      rows.set(p.memberId, {
        memberId: p.memberId,
        name,
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
