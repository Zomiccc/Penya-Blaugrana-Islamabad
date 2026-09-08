/* ==========================================================================
   PREDICTOR LEAGUE (predictions.html)

   The server is the source of truth for every rule — this file only renders
   what it is given. In particular it never decides who may see what: the API
   simply doesn't return other members' unstarted predictions.
   ========================================================================== */
(() => {
  const KARACHI = 'Asia/Karachi';
  let deadlineTimer = null;

  // Which competition the whole page is showing. 'PD' = La Liga, 'CL' =
  // Champions League. They run concurrently and are scored separately.
  const COMPETITION_LABELS = { PD: 'Penya LaLiga', CL: 'Penya UEFA Champions League' };
  let selectedCompetition = 'PD';

  /* ---------------------------- helpers ---------------------------- */
  const $ = (id) => document.getElementById(id);

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Something went wrong. Please try again.');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function flash(el, text, ok = false) {
    if (!el) return;
    el.textContent = text;
    el.className = `msg ${ok ? 'ok' : 'err'}`;
  }
  function clearFlash(el) {
    if (!el) return;
    el.textContent = '';
    el.className = 'msg';
  }

  function fmtKickoff(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: KARACHI, weekday: 'short', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  }

  function crest(url, name) {
    const src = url || `https://ui-avatars.com/api/?name=${encodeURIComponent(name || '?')}&background=0A1024&color=EDBB00&size=64`;
    return `<img src="${escapeHtml(src)}" alt="" loading="lazy">`;
  }

  function compTag(f) {
    const name = (f.competition || '').toLowerCase();
    const code = f.competitionCode || '';
    let tag;
    if (name.includes('primera') || name.includes('liga') || code === 'PD') tag = 'LALIGA';
    else if (name.includes('champions') || code === 'CL') tag = 'UCL';
    else if (name.includes('europa') || code === 'EL') tag = 'UEL';
    else if (name.includes('conference') || code === 'ECL') tag = 'UECL';
    else if (name.includes('super') || code === 'SC') tag = 'SUPERCUP';
    else if (name.includes('club world') || code === 'CWC') tag = 'CWC';
    else if (name.includes('copa') || name.includes('rey') || code === 'CDR') tag = 'COPA';
    else if (code) tag = code;
    else tag = (f.competition || 'MATCH').split(' ')[0].toUpperCase();
    return `<span class="pred-comp-tag">${escapeHtml(tag)}</span>`;
  }

  /* ---------------------------- gate (auth) ---------------------------- */
  function showTab(tab) {
    document.querySelectorAll('.gate-tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    $('loginForm').hidden = tab !== 'login';
    $('setupForm').hidden = tab !== 'setup';
    clearFlash($('gateMsg'));
  }

  function initGate() {
    document.querySelectorAll('.gate-tab').forEach((btn) => {
      btn.addEventListener('click', () => showTab(btn.dataset.tab));
    });
    document.querySelectorAll('[data-tab-link]').forEach((link) => {
      link.addEventListener('click', () => showTab(link.dataset.tabLink));
    });

    // Show/hide password toggles
    document.querySelectorAll('.pwd-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = document.getElementById(btn.dataset.target);
        if (!input) return;
        const isPwd = input.type === 'password';
        input.type = isPwd ? 'text' : 'password';
        btn.textContent = isPwd ? 'Hide' : 'Show';
      });
    });

    $('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('gateMsg');
      clearFlash(msg);
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await api('/api/member/login', {
          method: 'POST',
          body: JSON.stringify({
            email: $('loginEmail').value.trim(),
            password: $('loginPassword').value,
          }),
        });
        await boot();
      } catch (err) {
        flash(msg, err.message);
        // No password set yet → nudge them straight to the setup tab.
        if (err.data?.needsPassword) {
          $('setupEmail').value = $('loginEmail').value.trim();
          showTab('setup');
          flash($('gateMsg'), err.message);
        }
      } finally {
        btn.disabled = false;
      }
    });

    $('requestCodeBtn').addEventListener('click', async () => {
      const msg = $('gateMsg');
      clearFlash(msg);
      const email = $('setupEmail').value.trim();
      if (!email) return flash(msg, 'Enter the email on your membership first.');
      const btn = $('requestCodeBtn');
      btn.disabled = true;
      try {
        const data = await api('/api/member/request-code', {
          method: 'POST',
          body: JSON.stringify({ email }),
        });
        flash(msg, data.message || 'Code sent — check your email.', true);
      } catch (err) {
        flash(msg, err.message);
      } finally {
        btn.disabled = false;
      }
    });

    $('setupForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('gateMsg');
      clearFlash(msg);
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await api('/api/member/set-password', {
          method: 'POST',
          body: JSON.stringify({
            email: $('setupEmail').value.trim(),
            code: $('setupCode').value.trim(),
            password: $('setupPassword').value,
          }),
        });
        await boot();
      } catch (err) {
        flash(msg, err.message);
      } finally {
        btn.disabled = false;
      }
    });

    $('logoutBtn').addEventListener('click', async () => {
      await api('/api/member/logout', { method: 'POST' }).catch(() => {});
      window.location.reload();
    });
  }

  /* ---------------------------- deadline clock ---------------------------- */
  function startDeadlineClock(iso) {
    const row = $('deadlineRow');
    const clock = $('deadlineClock');
    if (deadlineTimer) clearInterval(deadlineTimer);
    if (!iso) { row.hidden = true; return; }
    row.hidden = false;

    const target = new Date(iso).getTime();
    const tick = () => {
      const diff = target - Date.now();
      if (diff <= 0) {
        clock.innerHTML = '<span class="unit"><span class="num">—</span><span class="lbl">closed</span></span>';
        clearInterval(deadlineTimer);
        return;
      }
      const s = Math.floor(diff / 1000);
      const units = [
        ['days', Math.floor(s / 86400)],
        ['hrs', Math.floor((s % 86400) / 3600)],
        ['mins', Math.floor((s % 3600) / 60)],
        ['secs', s % 60],
      ];
      clock.innerHTML = units
        .map(([lbl, n]) => `<span class="unit"><span class="num">${String(n).padStart(2, '0')}</span><span class="lbl">${lbl}</span></span>`)
        .join('');
    };
    tick();
    deadlineTimer = setInterval(tick, 1000);
  }

  /* ---------------------------- prediction table ---------------------------- */
  /**
   * Scores typed in but not yet submitted live only in the DOM, and the
   * background refresh rebuilds this whole list every 60s — which used to
   * wipe them mid-entry. Worst on a Champions League round: 18 fixtures is
   * 36 boxes, so anyone filling them in carefully lost the lot. Snapshot the
   * unsaved values (and the caret) before re-rendering, put them back after.
   */
  function captureDraft() {
    const draft = {};
    document.querySelectorAll('.pred-row').forEach((row) => {
      const home = row.querySelector('.pred-home');
      const away = row.querySelector('.pred-away');
      if (!home || !away) return;
      if (home.disabled && away.disabled) return; // locked — the server owns it
      if (home.value === '' && away.value === '') return;
      draft[row.dataset.fixtureId] = { home: home.value, away: away.value };
    });

    let focus = null;
    const active = document.activeElement;
    if (active && (active.classList?.contains('pred-home') || active.classList?.contains('pred-away'))) {
      const row = active.closest('.pred-row');
      if (row) {
        focus = {
          id: row.dataset.fixtureId,
          side: active.classList.contains('pred-home') ? 'home' : 'away',
        };
      }
    }
    return { draft, focus };
  }

  function restoreDraft({ draft, focus }) {
    for (const [fixtureId, values] of Object.entries(draft)) {
      const row = document.querySelector(`.pred-row[data-fixture-id="${fixtureId}"]`);
      if (!row) continue; // fixture dropped out of the round
      const home = row.querySelector('.pred-home');
      const away = row.querySelector('.pred-away');
      if (home && !home.disabled && values.home !== '') home.value = values.home;
      if (away && !away.disabled && values.away !== '') away.value = values.away;
    }
    if (!focus) return;
    const row = document.querySelector(`.pred-row[data-fixture-id="${focus.id}"]`);
    const input = row && row.querySelector(focus.side === 'home' ? '.pred-home' : '.pred-away');
    if (input && !input.disabled) {
      input.focus();
      // Not supported on number inputs in every browser.
      try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* ignore */ }
    }
  }

  function renderWindow(data) {
    const list = $('predList');
    const bar = $('submitBar');
    const fixtures = data.fixtures || [];
    const pending = captureDraft();

    if (!fixtures.length) {
      list.innerHTML = '<p class="empty-note">No upcoming Barça fixtures to predict right now. Check back once the next round is scheduled.</p>';
      bar.hidden = true;
      startDeadlineClock(null);
      return;
    }

    const closed = data.deadline && new Date(data.deadline) <= new Date();

    // Title: shows the round members are predicting (the most common
    // matchday in the set). The set is always a single competition, so once
    // La Liga's rounds give way to the Champions League, this switches from
    // "Match Week N" to "UEFA Champions League Match Day N" automatically.
    const weekTitle = $('weekTitle');
    if (weekTitle) {
      const isUCL = fixtures.some((f) => f.competitionCode === 'CL');
      const matchdays = fixtures.map((f) => f.matchday).filter(Number.isInteger);
      if (matchdays.length) {
        const counts = {};
        for (const m of matchdays) counts[m] = (counts[m] || 0) + 1;
        const md = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
        weekTitle.textContent = isUCL ? `UEFA Champions League Match Day ${md}` : `Match Week ${md}`;
      } else {
        weekTitle.textContent = isUCL ? 'UEFA Champions League' : 'Match Week';
      }
    }

    list.innerHTML = fixtures.map((f) => {
      const disabled = f.locked || closed ? 'disabled' : '';
      const home = f.myPrediction ? f.myPrediction.homeGoals : '';
      const away = f.myPrediction ? f.myPrediction.awayGoals : '';
      return `
        <div class="pred-row" data-fixture-id="${escapeHtml(f.id)}">
          <div class="pred-team">
            ${crest(f.homeCrest, f.homeTeam)}
            <span>${escapeHtml(f.homeTeam)}</span>
          </div>
          <div class="score-input">
            <input type="number" min="0" max="20" inputmode="numeric"
              class="pred-home" value="${home}" ${disabled}
              aria-label="${escapeHtml(f.homeTeam)} goals">
            <span class="dash">–</span>
            <input type="number" min="0" max="20" inputmode="numeric"
              class="pred-away" value="${away}" ${disabled}
              aria-label="${escapeHtml(f.awayTeam)} goals">
          </div>
          <div class="pred-team away">
            ${crest(f.awayCrest, f.awayTeam)}
            <span>${escapeHtml(f.awayTeam)}</span>
          </div>
          <div class="pred-when">
            ${compTag(f)}
            ${escapeHtml(fmtKickoff(f.utcDate))}
            ${f.locked ? '<span class="pred-locked-tag">Locked</span>' : ''}
          </div>
        </div>
      `;
    }).join('');

    restoreDraft(pending);

    const openCount = fixtures.filter((f) => !f.locked).length;
    bar.hidden = openCount === 0 || closed;
    if (closed && openCount > 0) {
      flash($('predMsg'), 'Predictions for this set are closed — the first match has kicked off.');
    }
    startDeadlineClock(data.deadline);
  }

  async function submitPredictions() {
    const msg = $('predMsg');
    clearFlash(msg);
    const btn = $('submitBtn');

    const rows = [...document.querySelectorAll('.pred-row')];
    const payload = [];
    for (const row of rows) {
      const homeEl = row.querySelector('.pred-home');
      const awayEl = row.querySelector('.pred-away');
      if (homeEl.disabled || awayEl.disabled) continue; // already locked

      const home = homeEl.value.trim();
      const away = awayEl.value.trim();
      // Skip empty rows — members can predict anywhere from 1 to all matches.
      if (home === '' && away === '') continue;
      if (home === '' || away === '') {
        return flash(msg, 'Fill in both scores for each match you want to predict, or leave both blank.');
      }
      const h = Number(home);
      const a = Number(away);
      if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0 || h > 20 || a > 20) {
        return flash(msg, 'Scores must be whole numbers between 0 and 20.');
      }
      payload.push({ fixtureId: row.dataset.fixtureId, homeGoals: h, awayGoals: a });
    }

    if (!payload.length) return flash(msg, 'Enter at least one score before submitting.');

    const summary = payload.length === 1 ? 'this prediction' : `these ${payload.length} predictions`;
    if (!confirm(`Submit ${summary}?\n\nOnce submitted they are permanent — they cannot be edited or deleted by anyone, including admins.`)) {
      return;
    }

    btn.disabled = true;
    try {
      const data = await api('/api/predictions', {
        method: 'POST',
        body: JSON.stringify({ predictions: payload }),
      });
      flash(msg, `Locked in ${data.saved} prediction${data.saved === 1 ? '' : 's'}. Good luck!`, true);
      await Promise.all([loadWindow(), loadMine(), loadLeaderboard(), loadSeasonLeaderboard()]);
    } catch (err) {
      flash(msg, err.message);
      await loadWindow();
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------------------------- my points ---------------------------- */
  function renderMine(data) {
    $('myTotal').textContent = data.totalPoints ?? 0;
    const list = $('myList');
    const preds = data.predictions || [];
    if (!preds.length) {
      list.innerHTML = '<p class="empty-note">No predictions yet — pick your scorelines above.</p>';
      return;
    }
    // Newest first reads better in a sidebar.
    list.innerHTML = [...preds].reverse().map((p) => {
      const cls = p.points === 3 ? 'p3' : p.points === 1 ? 'p1' : 'p0';
      const right = p.actual
        ? `<span class="rr-pts ${cls}">${p.points} pt${p.points === 1 ? '' : 's'}</span>`
        : '<span class="rr-pts p0">pending</span>';
      return `
        <div class="reveal-row">
          <span>${escapeHtml(p.homeTeam)} v ${escapeHtml(p.awayTeam)}</span>
          <span class="rr-pred">${p.homeGoals}–${p.awayGoals}${p.actual ? ` <span style="color:var(--muted);font-size:.8rem">(${p.actual.home}–${p.actual.away})</span>` : ''}</span>
          ${right}
        </div>
      `;
    }).join('');
  }

  /* ---------------------------- league table ---------------------------- */
  const CROWN_SVG = '<svg class="lt-crown %CLASS%" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2 8.5 5.5 12 9 5l3 6 3-6 3.5 7L22 8.5 20 19H4L2 8.5Z"/></svg>';
  const PODIUM = ['gold', 'silver', 'bronze'];

  function crownFor(rank) {
    const tier = PODIUM[rank - 1];
    if (!tier) return '';
    return CROWN_SVG.replace('%CLASS%', tier);
  }

  /**
   * @param {string} containerId
   * @param {object} data
   * @param {boolean} withCrowns Season standings get a gold/silver/bronze
   *   crown on the top three; the weekly table does not.
   */
  function renderLeaderboardInto(containerId, data, withCrowns) {
    const el = $(containerId);
    if (!el) return;
    const rows = data.leaderboard || [];
    if (!rows.length) {
      el.innerHTML = '<p class="empty-note">No points on the board yet.</p>';
      return;
    }
    el.innerHTML = `
      <table class="lt-table">
        <thead>
          <tr><th>#</th><th>Member</th><th class="num">Exact</th><th class="num">Total</th></tr>
        </thead>
        <tbody>
          ${rows.map((r) => {
            const podium = withCrowns && r.rank <= 3 ? ` podium podium-${r.rank}` : '';
            return `
            <tr class="${r.isMe ? 'me' : ''}${podium}">
              <td class="lt-rank">${r.rank}</td>
              <td>${withCrowns ? crownFor(r.rank) : ''}${escapeHtml(r.name)}${r.isMe ? ' (you)' : ''}</td>
              <td class="num">${r.exact}</td>
              <td class="num lt-total">${r.points}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  function renderLeaderboard(data) {
    const el = $('leaderboard');
    const rows = data.leaderboard || [];

    // Label what the weekly table is showing, so a table full of zeros
    // right after a rollover isn't mistaken for lost points.
    const note = $('leaderboardNote');
    if (note) {
      if (data.scope === 'week' && Number.isInteger(data.matchday)) {
        note.textContent = `Match week ${data.matchday} only — this table starts from zero every week. Your all-time total is under "My points".`;
        note.hidden = false;
      } else {
        note.hidden = true;
      }
    }

    if (!rows.length) {
      el.innerHTML = '<p class="empty-note">No points on the board for this week yet.</p>';
      return;
    }
    renderLeaderboardInto('leaderboard', data, false);
  }

  function renderSeasonLeaderboard(data) {
    renderLeaderboardInto('seasonLeaderboard', data, true);
  }

  /* ---------------------------- revealed predictions ---------------------------- */
  function renderReveal(data) {
    const el = $('revealList');
    const matches = data.matches || [];
    if (!matches.length) {
      el.innerHTML = '<p class="empty-note">Nothing revealed yet. Predictions appear here once a match kicks off.</p>';
      return;
    }
    el.innerHTML = matches.map((m) => `
      <div class="reveal-match">
        <div class="reveal-head">
          <span class="rm-teams">${escapeHtml(m.homeTeam)} v ${escapeHtml(m.awayTeam)}</span>
          ${m.actual
            ? `<span class="rm-score">${m.actual.home}–${m.actual.away}</span>`
            : m.live
              ? `<span class="rm-live">● Live</span><span class="rm-score">${m.live.home}–${m.live.away}</span>`
              : '<span class="rm-live">In progress</span>'}
        </div>
        <div class="reveal-body">
          ${m.predictions.map((p) => {
            const cls = p.points === 3 ? 'p3' : p.points === 1 ? 'p1' : 'p0';
            return `
              <div class="reveal-row ${p.isMe ? 'me' : ''}">
                <span>${escapeHtml(p.member)}${p.isMe ? ' (you)' : ''}</span>
                <span class="rr-pred">${p.homeGoals}–${p.awayGoals}</span>
                <span class="rr-pts ${cls}">${
                  p.points === null ? 'pending' : `${p.points} pt${p.points === 1 ? '' : 's'}`
                }</span>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `).join('');
  }

  /* ---------------------------- competition switcher ---------------------------- */
  function setCompetition(code) {
    if (!COMPETITION_LABELS[code] || code === selectedCompetition) return;
    selectedCompetition = code;

    document.querySelectorAll('.comp-tab').forEach((tab) => {
      const active = tab.dataset.competition === code;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    const title = $('leaderboardTitle');
    if (title) title.textContent = `${COMPETITION_LABELS[code]} Table`;

    // Everything on the page is scoped to the chosen competition.
    loadWindow();
    loadMine();
    loadLeaderboard();
    loadSeasonLeaderboard();
    loadReveal();
  }

  function initCompetitionTabs() {
    document.querySelectorAll('.comp-tab').forEach((tab) => {
      tab.addEventListener('click', () => setCompetition(tab.dataset.competition));
    });
  }

  /* ---------------------------- loaders ---------------------------- */
  // Everything on this page — fixtures to predict, results, my points, the
  // league table — is scoped to one competition at a time.
  function competitionQuery() {
    return `?competition=${encodeURIComponent(selectedCompetition)}`;
  }

  async function loadWindow() {
    try {
      renderWindow(await api(`/api/predictions/window${competitionQuery()}`));
    } catch (err) {
      $('predList').innerHTML = `<p class="empty-note">${escapeHtml(err.message)}</p>`;
    }
  }
  async function loadMine() {
    try {
      renderMine(await api(`/api/predictions/me${competitionQuery()}`));
    } catch { /* sidebar is non-critical */ }
  }
  async function loadLeaderboard() {
    // La Liga runs a weekly table that resets each match week; the
    // Champions League keeps the plain running total it always had.
    const scope = selectedCompetition === 'PD' ? '&scope=week' : '';
    try {
      renderLeaderboard(await api(`/api/predictions/leaderboard${competitionQuery()}${scope}`));
    } catch (err) {
      $('leaderboard').innerHTML = `<p class="empty-note">${escapeHtml(err.message)}</p>`;
    }
  }

  // Season standings are a La Liga-only concept — the panel stays hidden
  // for the Champions League.
  async function loadSeasonLeaderboard() {
    const panel = $('seasonPanel');
    if (!panel) return;
    if (selectedCompetition !== 'PD') {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    try {
      renderSeasonLeaderboard(await api(`/api/predictions/leaderboard${competitionQuery()}&scope=season`));
    } catch (err) {
      $('seasonLeaderboard').innerHTML = `<p class="empty-note">${escapeHtml(err.message)}</p>`;
    }
  }
  async function loadReveal() {
    try {
      renderReveal(await api(`/api/predictions/all${competitionQuery()}`));
    } catch (err) {
      $('revealList').innerHTML = `<p class="empty-note">${escapeHtml(err.message)}</p>`;
    }
  }

  /* ---------------------------- broadcasts ---------------------------- */
  async function loadBroadcasts() {
    const panel = $('broadcastPanel');
    const list = $('broadcastsList');
    try {
      const data = await api('/api/chat/broadcasts');
      const bcs = data.broadcasts || [];
      if (!bcs.length) {
        if (panel) panel.hidden = true;
        return;
      }
      list.innerHTML = bcs.map((b) => `
        <div class="broadcast-item">
          ${b.text ? `<div>${escapeHtml(b.text)}</div>` : ''}
          ${b.image ? `
            <a class="broadcast-image" href="${escapeHtml(b.image.dataUrl)}" target="_blank" rel="noopener">
              <img src="${escapeHtml(b.image.dataUrl)}" alt="${escapeHtml(b.image.filename || 'Announcement image')}" loading="lazy">
            </a>
          ` : ''}
          <div class="broadcast-meta">${new Date(b.createdAt).toLocaleString()}</div>
        </div>
      `).join('');
      panel.hidden = false;
    } catch (err) {
      if (panel) panel.hidden = true;
    }
  }

  /* ---------------------------- boot ---------------------------- */
  async function boot() {
    let me = null;
    try {
      me = await api('/api/member/me');
    } catch {
      // Not logged in (or membership not paid) → show the gate.
      $('gate').hidden = false;
      $('league').hidden = true;
      showTab('login');
      return;
    }

    $('gate').hidden = true;
    $('league').hidden = false;
    $('whoName').textContent = `${me.member.firstName} ${me.member.lastName}`.trim();

    await Promise.all([loadWindow(), loadMine(), loadLeaderboard(), loadSeasonLeaderboard(), loadReveal(), loadBroadcasts()]);
    initChat();

    // Keep live scores, the leaderboard, and the prediction window fresh
    // while the page is open — the cache behind these refreshes from
    // Football-Data every 1 min on a match day, so this just keeps the
    // page in step with it without hammering our own API.
    setInterval(() => {
      loadWindow();
      loadLeaderboard();
      loadSeasonLeaderboard();
      loadReveal();
    }, 60000);
  }

    /* ---------------------------- Peyna Assistant Chat ---------------------------- */
  let chatOpen = false;
  let chatPollTimer = null;
  let unreadPollTimer = null;
  let mediaRecorder = null;
  let chatChunks = [];
  let memberReplyToMsgId = null;
  let voiceNoteAudio = null;

  let chatScrollY = 0;
  function setBackgroundScrollLocked(locked) {
    if (locked) {
      chatScrollY = window.scrollY || window.pageYOffset || 0;
      document.body.classList.add('chat-locked');
      document.body.style.top = `-${chatScrollY}px`;
    } else {
      document.body.classList.remove('chat-locked');
      document.body.style.top = '';
      window.scrollTo(0, chatScrollY);
    }
  }

  function initChat() {
    const gate = $('chatGate');
    if (!gate) return;
    gate.hidden = false;

    const fab = $('chatFab');
    const panel = $('chatPanel');
    const closeBtn = $('chatClose');
    const sendBtn = $('chatSend');
    const textInput = $('chatText');
    const attachBtn = $('chatAttach');
    const voiceBtn = $('chatVoice');
    const fileInput = $('chatFileInput');

    fab.addEventListener('click', () => {
      chatOpen = !chatOpen;
      panel.classList.toggle('open', chatOpen);
      setBackgroundScrollLocked(chatOpen);
      if (chatOpen) {
        loadChatMessages();
        startChatPolling();
        textInput.focus();
        $('chatBadge').hidden = true;
      } else {
        stopChatPolling();
        loadUnreadBadge();
      }
    });

    // Keep checking for unread admin replies even while the panel is closed,
    // so the "Talk to Admin" button shows a badge as soon as Admin replies.
    loadUnreadBadge();
    unreadPollTimer = setInterval(loadUnreadBadge, 15000);

    closeBtn.addEventListener('click', () => {
      chatOpen = false;
      panel.classList.remove('open');
      setBackgroundScrollLocked(false);
      stopChatPolling();
    });

    sendBtn.addEventListener('click', sendChatText);
    textInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatText(); }
    });

    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) sendChatFile(fileInput.files[0], false);
      fileInput.value = '';
    });

    voiceBtn.addEventListener('click', toggleVoiceRecord);

    initChatNotifications();
  }

  /* ---------------------------- Phone notifications ----------------------------
     Lets a member get a push notification on their phone when Admin replies,
     even with the site closed. Mirrors the admin-side setup; both share
     /sw.js, which routes the tap using the URL in the push payload. */
  function setBellState(on) {
    const bell = $('chatNotifyBtn');
    if (!bell) return;
    bell.classList.toggle('is-on', on);
    bell.title = on
      ? 'Notifications are on for this device — tap to turn off'
      : 'Get notified on this device when Admin replies';
  }

  async function initChatNotifications() {
    const bell = $('chatNotifyBtn');
    if (!bell) return;
    // Hide entirely where it can't work rather than showing a dead control.
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

    bell.hidden = false;
    bell.addEventListener('click', toggleChatNotifications);
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      setBellState(Boolean(await reg.pushManager.getSubscription()));
    } catch {
      bell.hidden = true;
    }
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function toggleChatNotifications() {
    const bell = $('chatNotifyBtn');
    bell.disabled = true;
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      const existing = await reg.pushManager.getSubscription();

      if (existing) {
        await api('/api/chat/push/unsubscribe', {
          method: 'POST',
          body: JSON.stringify({ endpoint: existing.endpoint }),
        });
        await existing.unsubscribe();
        setBellState(false);
        return;
      }

      if (await Notification.requestPermission() !== 'granted') {
        alert('Notifications were blocked. You can allow them in your browser settings for this site.');
        return;
      }
      const { publicKey } = await api('/api/chat/push/public-key');
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await api('/api/chat/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      setBellState(true);
    } catch (err) {
      alert('Could not change notifications: ' + err.message);
    } finally {
      bell.disabled = false;
    }
  }

  async function sendChatText() {
    const input = $('chatText');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const replyTo = memberReplyToMsgId;
    cancelMemberReply();
    try {
      await api('/api/chat/messages', { method: 'POST', body: JSON.stringify({ text, replyToMessageId: replyTo }) });
      await loadChatMessages();
    } catch (err) {
      input.value = text;
      alert('Failed to send: ' + err.message);
    }
  }

  async function sendChatFile(file, isVoice) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('voiceNote', isVoice ? 'true' : 'false');
    if (memberReplyToMsgId) formData.append('replyToMessageId', memberReplyToMsgId);
    cancelMemberReply();
    try {
      const res = await fetch('/api/chat/upload', {
        method: 'POST',
        credentials: 'same-origin',
        body: formData,
      });
      if (!res.ok) throw new Error(await res.text());
      await loadChatMessages();
    } catch (err) {
      alert('Failed to upload: ' + err.message);
    }
  }

  async function toggleVoiceRecord() {
    const voiceBtn = $('chatVoice');
    const MIC_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
    const STOP_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      voiceBtn.classList.remove('recording');
      voiceBtn.innerHTML = MIC_ICON;
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chatChunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = (e) => { if (e.data.size) chatChunks.push(e.data); };
      mediaRecorder.onstop = () => {
        const blob = new Blob(chatChunks, { type: 'audio/webm' });
        const file = new File([blob], `voice-${Date.now()}.webm`, { type: 'audio/webm' });
        sendChatFile(file, true);
        stream.getTracks().forEach(t => t.stop());
      };
      mediaRecorder.start();
      voiceBtn.classList.add('recording');
      voiceBtn.innerHTML = STOP_ICON;
    } catch (err) {
      alert('Microphone access denied or not available');
    }
  }

  async function loadChatMessages() {
    const body = $('chatBody');
    try {
      const data = await api('/api/chat/messages');
      const msgs = data.messages || [];
      if (!msgs.length) {
        body.innerHTML = '<p class="chat-empty">No messages yet. Start a conversation with Admin!</p>';
        return;
      }
      body.innerHTML = msgs.map(renderChatMsg).join('');
      body.scrollTop = body.scrollHeight;
    } catch (err) {
      body.innerHTML = '<p class="chat-empty">Could not load messages.</p>';
    }
  }

  // Shows how many admin replies the member hasn't read yet on the
  // "Talk to Admin" button, without marking them as read (that only
  // happens when the member actually opens the chat panel).
  async function loadUnreadBadge() {
    if (chatOpen) return;
    try {
      const data = await api('/api/chat/unread-count');
      const badge = $('chatBadge');
      const count = data.unreadCount || 0;
      if (count > 0) {
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.hidden = false;
      } else {
        badge.hidden = true;
      }
    } catch (err) {
      // Non-fatal — badge just won't update this cycle.
    }
  }

  function renderChatMsg(m) {
    let cls, sender;
    if (m.isBroadcast) {
      cls = 'broadcast';
      sender = '📢 Admin Announcement';
    } else if (m.isAdmin) {
      cls = 'admin';
      sender = '🛡️ Admin';
    } else if (m.isMe) {
      cls = 'me';
      sender = 'You';
    } else {
      cls = 'other';
      sender = escapeHtml(m.senderName);
    }
    const time = new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let replyHtml = '';
    if (m.replyTo) {
      replyHtml = `<div class="chat-reply-ref" onclick="scrollToMsg('${m.replyTo.messageId}')">↳ ${escapeHtml(m.replyTo.preview)}</div>`;
    }

    let content = '';
    if (m.text) content += escapeHtml(m.text);

    if (m.attachment && (m.attachment.dataUrl || m.attachment.url)) {
      const src = m.attachment.dataUrl || m.attachment.url;
      if (m.attachment.mimetype && m.attachment.mimetype.startsWith('image/')) {
        content += `<br><img src="${src}" alt="${escapeHtml(m.attachment.filename)}" loading="lazy" style="max-width:200px;border-radius:8px;cursor:pointer" onclick="window.open('${src}','_blank')">`;
      } else if (m.attachment.mimetype && m.attachment.mimetype.startsWith('video/')) {
        content += `<br><video src="${src}" controls style="max-width:200px;border-radius:8px"></video>`;
      } else {
        content += `<br><a href="${src}" target="_blank" download="${escapeHtml(m.attachment.filename)}" style="color:var(--gold)">📎 ${escapeHtml(m.attachment.filename)}</a>`;
      }
    }

    if (m.voiceNote && (m.voiceNote.dataUrl || m.voiceNote.url)) {
      const vsrc = m.voiceNote.dataUrl || m.voiceNote.url;
      const duration = estimateVoiceDuration(m.voiceNote.size);
      const bubbleWidth = Math.min(Math.max(duration * 8, 140), 280);
      content += `<br><div class="voice-bubble" style="width:${bubbleWidth}px">
        <button class="voice-play-btn" onclick="toggleVoiceNote(this, '${vsrc}')">▶</button>
        <div class="voice-waveform">${generateWaveBars(20)}</div>
        <span class="voice-duration">${formatDuration(duration)}</span>
      </div>`;
    }

    const replyBtn = (!m.isBroadcast) ?
      `<div class="chat-msg-actions"><button class="chat-msg-action-btn" onclick="setMemberReplyTo('${m.id}','${escapeHtml(m.text || (m.voiceNote ? 'Voice note' : 'Attachment')).replace(/'/g, "\\'")}')">Reply</button></div>` : '';

    return `<div class="chat-msg ${cls}" id="msg-${m.id}">
      ${replyBtn}
      <div class="chat-sender">${sender}</div>
      ${replyHtml}
      ${content}
      <div class="chat-time">${time}${cls === 'me' ? ' <span class="chat-tick">✓✓</span>' : ''}</div>
    </div>`;
  }

  function estimateVoiceDuration(sizeBytes) {
    return Math.max(1, Math.round(sizeBytes / 2000));
  }
  function formatDuration(secs) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  function generateWaveBars(count) {
    let bars = '';
    for (let i = 0; i < count; i++) {
      const h = Math.floor(Math.random() * 18) + 4;
      bars += `<div class="voice-bar" style="height:${h}px"></div>`;
    }
    return bars;
  }

  window.toggleVoiceNote = function(btn, src) {
    if (voiceNoteAudio && !voiceNoteAudio.paused) {
      voiceNoteAudio.pause();
      document.querySelectorAll('.voice-play-btn').forEach(b => b.textContent = '▶');
      document.querySelectorAll('.voice-bar').forEach(b => b.classList.remove('played'));
      if (voiceNoteAudio.src === src) { voiceNoteAudio = null; return; }
    }
    voiceNoteAudio = new Audio(src);
    const bubble = btn.closest('.voice-bubble');
    const bars = bubble ? bubble.querySelectorAll('.voice-bar') : [];
    const totalBars = bars.length;
    voiceNoteAudio.addEventListener('timeupdate', () => {
      const progress = voiceNoteAudio.currentTime / voiceNoteAudio.duration;
      const playedCount = Math.floor(progress * totalBars);
      bars.forEach((b, i) => { if (i < playedCount) b.classList.add('played'); else b.classList.remove('played'); });
    });
    voiceNoteAudio.addEventListener('ended', () => {
      btn.textContent = '▶';
      bars.forEach(b => b.classList.remove('played'));
      voiceNoteAudio = null;
    });
    voiceNoteAudio.play();
    btn.textContent = '⏸';
  };

  window.setMemberReplyTo = function(msgId, previewText) {
    memberReplyToMsgId = msgId;
    const preview = $('chatReplyPreview');
    const text = $('chatReplyPreviewText');
    text.textContent = previewText.slice(0, 60);
    preview.style.display = 'block';
    $('chatText').focus();
  };

  window.cancelMemberReply = function() {
    memberReplyToMsgId = null;
    $('chatReplyPreview').style.display = 'none';
  };

  window.scrollToMsg = function(msgId) {
    const el = document.getElementById(`msg-${msgId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.style.transition = 'background .3s';
      el.style.background = 'rgba(237,187,0,.15)';
      setTimeout(() => { el.style.background = ''; }, 1500);
    }
  };

  function startChatPolling() {
    stopChatPolling();
    chatPollTimer = setInterval(loadChatMessages, 5000);
  }
  function stopChatPolling() {
    if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
  }

document.addEventListener('DOMContentLoaded', () => {
    initGate();
    $('submitBtn').addEventListener('click', submitPredictions);
    initCompetitionTabs();
    boot();
  });
})();
