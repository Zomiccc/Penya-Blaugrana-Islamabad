/* ==========================================================================
   FIXTURE SYNC SCHEDULER
   Keeps data/fixtures.json fresh without ever touching Football-Data.org
   on a visitor's page load.

   Refresh policy:
     - Normal days .......... every 12 hours
     - Match day ............ every 1 minute
     - Match finished ....... back to 12 hours

   The scheduler is started once from server.js. The interval is re-evaluated
   on every tick based on whether the next scheduled match is today.
   ========================================================================== */
const {
  syncFixtures,
  updateNextSync,
  getCachedFixtures,
  clearFixturesCache,
} = require('../services/fixture.service');

const NORMAL_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours
const MATCHDAY_INTERVAL_MS = 60 * 1000;         // 1 minute

let timer = null;
let syncing = false;
let lastScheduledIntervalMs = NORMAL_INTERVAL_MS;

function nextMatchInfo(cache) {
  const now = new Date();
  const upcoming = (cache.matches || [])
    .filter((m) => new Date(m.utcDate) > now && !['FINISHED', 'POSTPONED', 'CANCELLED'].includes(m.status))
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));
  if (!upcoming.length) return null;
  return upcoming[0];
}

/** Decide the correct refresh interval for right now. */
function desiredIntervalMs(cache) {
  const next = nextMatchInfo(cache);
  if (!next) return NORMAL_INTERVAL_MS;

  const kickoff = new Date(next.utcDate);
  const now = new Date();

  // If the next match is today (same calendar date in UTC), poll every 1 min.
  const sameUtcDay =
    kickoff.getUTCFullYear() === now.getUTCFullYear() &&
    kickoff.getUTCMonth() === now.getUTCMonth() &&
    kickoff.getUTCDate() === now.getUTCDate();

  // If the match is FINISHED (status rolled over), fall back to 12 hours.
  if (next.status === 'FINISHED') return NORMAL_INTERVAL_MS;

  return sameUtcDay ? MATCHDAY_INTERVAL_MS : NORMAL_INTERVAL_MS;
}

async function runSync(reason) {
  if (syncing) return; // don't overlap syncs
  syncing = true;
  try {
    console.log(`[fixtures] sync (${reason})…`);
    const cache = await syncFixtures();
    const interval = desiredIntervalMs(cache);
    const nextSyncAt = new Date(Date.now() + interval).toISOString();
    updateNextSync(nextSyncAt);

    if (interval !== lastScheduledIntervalMs) {
      console.log(`[fixtures] refresh interval changed to ${interval === MATCHDAY_INTERVAL_MS ? '1 min (match day)' : '12 hours (normal)'}`);
      lastScheduledIntervalMs = interval;
      scheduleTimer(interval);
    } else {
      console.log(`[fixtures] next sync at ${nextSyncAt}`);
    }
  } catch (err) {
    // Errors are already recorded in the cache by service.syncFixtures().
    // Keep the timer alive — the retry happens on the next scheduled tick.
    console.error('[fixtures] scheduler error (will retry on next tick):', err.message);
    const nextSyncAt = new Date(Date.now() + NORMAL_INTERVAL_MS).toISOString();
    updateNextSync(nextSyncAt);
  } finally {
    syncing = false;
  }
}

function scheduleTimer(intervalMs) {
  if (timer) clearInterval(timer);
  timer = setInterval(() => runSync('scheduled'), intervalMs);
}

/** Start the scheduler (called once at boot). */
function startFixtureSync() {
  // Fire an immediate sync so the cache is warm before the first visitor.
  runSync('startup');

  const interval = NORMAL_INTERVAL_MS;
  lastScheduledIntervalMs = interval;
  const nextSyncAt = new Date(Date.now() + interval).toISOString();
  updateNextSync(nextSyncAt);
  scheduleTimer(interval);
}

/** Manual "Sync Now" from the admin panel. */
async function syncNow() {
  const cache = await syncFixtures();
  const interval = desiredIntervalMs(cache);
  const nextSyncAt = new Date(Date.now() + interval).toISOString();
  updateNextSync(nextSyncAt);
  return getCachedFixtures();
}

/** Manual "Clear Cache" from the admin panel. */
function clearCache() {
  if (timer) clearInterval(timer);
  clearFixturesCache();
  // Reschedule immediately to refill the cache
  lastScheduledIntervalMs = NORMAL_INTERVAL_MS;
  scheduleTimer(NORMAL_INTERVAL_MS);
  runSync('after-clear');
  return getCachedFixtures();
}

module.exports = { startFixtureSync, syncNow, clearCache };