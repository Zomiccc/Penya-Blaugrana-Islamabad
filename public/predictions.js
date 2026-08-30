/* ==========================================================================
   PREDICTOR LEAGUE (predictions.html)

   The server is the source of truth for every rule — this file only renders
   what it is given. In particular it never decides who may see what: the API
   simply doesn't return other members' unstarted predictions.
   ========================================================================== */
(() => {
  const KARACHI = 'Asia/Karachi';
  let deadlineTimer = null;

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
  function renderWindow(data) {
    const list = $('predList');
    const bar = $('submitBar');
    const fixtures = data.fixtures || [];

    if (!fixtures.length) {
      list.innerHTML = '<p class="empty-note">No upcoming Barça fixtures to predict right now. Check back once the next round is scheduled.</p>';
      bar.hidden = true;
      startDeadlineClock(null);
      return;
    }

    const closed = data.deadline && new Date(data.deadline) <= new Date();

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
            ${escapeHtml(fmtKickoff(f.utcDate))}
            ${f.locked ? '<span class="pred-locked-tag">Locked</span>' : ''}
          </div>
        </div>
      `;
    }).join('');

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
      if (home === '' || away === '') {
        return flash(msg, 'Fill in a score for every open match before submitting.');
      }
      const h = Number(home);
      const a = Number(away);
      if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0 || h > 20 || a > 20) {
        return flash(msg, 'Scores must be whole numbers between 0 and 20.');
      }
      payload.push({ fixtureId: row.dataset.fixtureId, homeGoals: h, awayGoals: a });
    }

    if (!payload.length) return flash(msg, 'Nothing new to submit — your predictions are already locked in.');

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
      await Promise.all([loadWindow(), loadMine(), loadLeaderboard()]);
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
  function renderLeaderboard(data) {
    const el = $('leaderboard');
    const rows = data.leaderboard || [];
    if (!rows.length) {
      el.innerHTML = '<p class="empty-note">No predictions in the league yet. Be the first.</p>';
      return;
    }
    el.innerHTML = `
      <table class="lt-table">
        <thead>
          <tr><th>#</th><th>Member</th><th class="num">Exact</th><th class="num">Total</th></tr>
        </thead>
        <tbody>
          ${rows.map((r) => `
            <tr class="${r.isMe ? 'me' : ''}">
              <td class="lt-rank">${r.rank}</td>
              <td>${escapeHtml(r.name)}${r.isMe ? ' (you)' : ''}</td>
              <td class="num">${r.exact}</td>
              <td class="num lt-total">${r.points}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
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

  /* ---------------------------- loaders ---------------------------- */
  async function loadWindow() {
    try {
      renderWindow(await api('/api/predictions/window'));
    } catch (err) {
      $('predList').innerHTML = `<p class="empty-note">${escapeHtml(err.message)}</p>`;
    }
  }
  async function loadMine() {
    try {
      renderMine(await api('/api/predictions/me'));
    } catch { /* sidebar is non-critical */ }
  }
  async function loadLeaderboard() {
    try {
      renderLeaderboard(await api('/api/predictions/leaderboard'));
    } catch (err) {
      $('leaderboard').innerHTML = `<p class="empty-note">${escapeHtml(err.message)}</p>`;
    }
  }
  async function loadReveal() {
    try {
      renderReveal(await api('/api/predictions/all'));
    } catch (err) {
      $('revealList').innerHTML = `<p class="empty-note">${escapeHtml(err.message)}</p>`;
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

    await Promise.all([loadWindow(), loadMine(), loadLeaderboard(), loadReveal()]);
  }

  document.addEventListener('DOMContentLoaded', () => {
    initGate();
    $('submitBtn').addEventListener('click', submitPredictions);
    boot();
  });
})();
