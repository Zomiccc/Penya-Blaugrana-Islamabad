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
  if (res.status === 401) {
    window.location.href = '/admin/login.html';
    throw new Error('Not authenticated');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function flash(el, text, ok) {
  el.style.display = 'block';
  el.textContent = text;
  el.style.background = ok ? 'rgba(0,150,80,.1)' : 'rgba(165,0,68,.1)';
  el.style.color = ok ? '#0a7d43' : '#A50044';
  el.style.border = `1px solid ${ok ? '#0a7d43' : '#A50044'}`;
}

document.addEventListener('DOMContentLoaded', () => {
  init();
});

async function init() {
  try {
    const me = await api('/api/admin/me');
    document.getElementById('whoami').textContent = `Signed in as ${me.username}`;
  } catch {
    return; // already redirected to login by api()
  }

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await api('/api/admin/logout', { method: 'POST' });
    window.location.href = '/admin/login.html';
  });

  await Promise.all([
    loadStats(), loadPricing(), loadMembers(), loadFixtureStatus(),
  ]);

  document.getElementById('pricingForm').addEventListener('submit', savePricing);
  document.getElementById('pwForm').addEventListener('submit', changePassword);
  document.getElementById('addMemberForm').addEventListener('submit', addMember);
  document.getElementById('broadcastForm').addEventListener('submit', sendBroadcast);
  document.getElementById('adminChatSend').addEventListener('click', sendAdminReply);
  document.getElementById('adminChatText').addEventListener('keydown', (e) => {
    // Enter still sends; Shift+Enter now starts a new line, which the
    // single-line input couldn't do.
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAdminReply(); }
  });
  document.getElementById('adminChatText').addEventListener('input', autoGrowAdminChatInput);
  document.getElementById('adminChatAttach').addEventListener('click', () => {
    if (!activeConvId) return;
    document.getElementById('adminChatFile').click();
  });
  document.getElementById('adminChatFile').addEventListener('change', () => {
    const f = document.getElementById('adminChatFile');
    if (f.files[0]) sendAdminReplyWithFile(f.files[0]);
    f.value = '';
  });
  document.getElementById('adminChatVoice').addEventListener('click', toggleAdminVoiceRecord);
  document.getElementById('adminVoiceSend').addEventListener('click', sendAdminPendingVoiceNote);
  document.getElementById('adminVoiceDiscard').addEventListener('click', closeAdminVoiceReview);
  document.getElementById('waBackBtn').addEventListener('click', showChatList);
  document.getElementById('waCleanupBtn').addEventListener('click', cleanupFormerChats);
  document.getElementById('waDeleteBtn').addEventListener('click', () => { if (activeConvId) deleteConversation(activeConvId); });
  document.getElementById('waSearch').addEventListener('input', renderConversationRows);
  document.getElementById('adminResolveBtn').addEventListener('click', toggleResolve);
  document.getElementById('fxSyncBtn').addEventListener('click', syncFixturesNow);
  document.getElementById('fxClearBtn').addEventListener('click', clearFixturesCache);
  document.getElementById('refreshBtn').addEventListener('click', () => { loadStats(); loadMembers(); loadFixtureStatus(); });
  document.getElementById('searchBox').addEventListener('input', debounce(loadMembers, 300));
  document.getElementById('statusFilter').addEventListener('change', loadMembers);
  document.getElementById('typeFilter').addEventListener('change', loadMembers);
  loadBroadcasts();
  loadPredictionResults();
  loadOrphanedPredictions();
  loadAdminConversations();
  setInterval(loadAdminConversations, 5000);

  document.getElementById('pushToggleBtn').addEventListener('click', togglePushSubscription);
  initPushStatus();
}

/* ---------------------------- Phone push notifications ---------------------------- */
function updatePushButton(subscribed) {
  const btn = document.getElementById('pushToggleBtn');
  const status = document.getElementById('pushStatus');
  btn.textContent = subscribed ? '🔕 Disable Phone Notifications' : '🔔 Enable Phone Notifications';
  status.textContent = subscribed ? 'Notifications are on for this device.' : '';
}

// Cached at load so the tap handler never awaits registration — see the
// comment in togglePushSubscription().
let adminSwRegistration = null;

async function initPushStatus() {
  const btn = document.getElementById('pushToggleBtn');
  const status = document.getElementById('pushStatus');
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    btn.disabled = true;
    status.textContent = 'Push notifications are not supported in this browser.';
    return;
  }
  try {
    adminSwRegistration = await navigator.serviceWorker.register('/sw.js', { scope: '/admin/' });
    const sub = await adminSwRegistration.pushManager.getSubscription();
    updatePushButton(Boolean(sub));
  } catch (err) {
    status.textContent = 'Could not set up notifications: ' + err.message;
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

function togglePushSubscription() {
  const btn = document.getElementById('pushToggleBtn');
  const status = document.getElementById('pushStatus');
  const turningOn = !btn.textContent.includes('Disable');
  status.textContent = '';

  if (turningOn) {
    // Ask for permission synchronously, before any await. Awaiting first
    // spends the browser's transient user-activation, so the prompt never
    // appears and the button appears to need several taps.
    if (Notification.permission === 'denied') {
      status.textContent = 'Notifications are blocked for this site — allow them in your browser settings, then tap again.';
      return;
    }
    const permission = Notification.requestPermission();
    btn.disabled = true;
    Promise.resolve(permission)
      .then((result) => {
        if (result !== 'granted') {
          status.textContent = 'Notification permission was not granted.';
          return null;
        }
        return subscribeAdminPush();
      })
      .then((ok) => { if (ok) updatePushButton(true); })
      .catch((err) => { status.textContent = 'Failed: ' + err.message; })
      .finally(() => { btn.disabled = false; });
    return;
  }

  btn.disabled = true;
  unsubscribeAdminPush()
    .then(() => updatePushButton(false))
    .catch((err) => { status.textContent = 'Failed: ' + err.message; })
    .finally(() => { btn.disabled = false; });
}

async function subscribeAdminPush() {
  const reg = adminSwRegistration || (await navigator.serviceWorker.register('/sw.js', { scope: '/admin/' }));
  const existing = await reg.pushManager.getSubscription();
  const sub = existing || (await (async () => {
    const { publicKey } = await api('/api/admin/push/public-key');
    return reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  })());
  await api('/api/admin/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });
  return true;
}

async function unsubscribeAdminPush() {
  const reg = adminSwRegistration || (await navigator.serviceWorker.getRegistration('/admin/'));
  const existing = reg && (await reg.pushManager.getSubscription());
  if (!existing) return;
  await api('/api/admin/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: existing.endpoint }) });
  await existing.unsubscribe();
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function loadStats() {
  try {
    const s = await api('/api/admin/dashboard-stats');
    document.getElementById('statTotal').textContent = s.total;
    document.getElementById('statPaid').textContent = s.paid;
    document.getElementById('statPending').textContent = s.pending;
    document.getElementById('statSplit').textContent = `${s.adults} / ${s.kids}`;
    document.getElementById('statRevenue').textContent = `${s.currency} ${Number(s.revenue).toLocaleString()}`;
  } catch (err) {
    console.error(err);
  }
}

async function loadPricing() {
  const p = await api('/api/pricing');
  document.getElementById('priceAdult').value = p.adult;
  document.getElementById('priceKids').value = p.kids;
  document.getElementById('priceCurrency').value = p.currency;
}

/* ---------------- Fixtures sync ---------------- */
function fmtDate(iso) {
  if (!iso) return 'Never';
  try {
    return new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Karachi' });
  } catch {
    return iso;
  }
}

async function loadFixtureStatus() {
  try {
    const s = await api('/api/admin/fixtures/status');
    document.getElementById('fxCount').textContent = s.count;
    document.getElementById('fxStatus').textContent = s.apiStatus === 'ok' ? 'OK' : 'ERROR';
    document.getElementById('fxStatus').style.color = s.apiStatus === 'ok' ? '#3ddc8a' : '#A50044';
    document.getElementById('fxLastSync').textContent = fmtDate(s.lastSync);
    document.getElementById('fxNextSync').textContent = fmtDate(s.nextSync);
  } catch (err) {
    console.error('Failed to load fixture status:', err);
  }
}

async function syncFixturesNow() {
  const btn = document.getElementById('fxSyncBtn');
  const msg = document.getElementById('fxMsg');
  btn.disabled = true;
  flash(msg, 'Syncing fixtures from Football-Data.org…', true);
  try {
    const data = await api('/api/admin/fixtures/sync', { method: 'POST' });
    flash(msg, `Sync complete — ${(data.matches || []).length} fixtures cached.`, true);
    await loadFixtureStatus();
  } catch (err) {
    flash(msg, err.message, false);
  } finally {
    btn.disabled = false;
  }
}

async function clearFixturesCache() {
  if (!confirm('Clear the cached fixtures? The scheduler will refetch automatically.')) return;
  const msg = document.getElementById('fxMsg');
  try {
    const data = await api('/api/admin/fixtures/clear', { method: 'POST' });
    flash(msg, 'Cache cleared — scheduler is refetching now.', true);
    await loadFixtureStatus();
  } catch (err) {
    flash(msg, err.message, false);
  }
}

async function savePricing(e) {
  e.preventDefault();
  const msg = document.getElementById('pricingMsg');
  try {
    await api('/api/admin/pricing', {
      method: 'PUT',
      body: JSON.stringify({
        adult: document.getElementById('priceAdult').value,
        kids: document.getElementById('priceKids').value,
        currency: document.getElementById('priceCurrency').value,
      }),
    });
    flash(msg, 'Prices updated — the Join Us page will use these immediately.', true);
    loadStats();
  } catch (err) {
    flash(msg, err.message, false);
  }
}

async function changePassword(e) {
  e.preventDefault();
  const msg = document.getElementById('pwMsg');
  try {
    await api('/api/admin/change-password', {
      method: 'POST',
      body: JSON.stringify({
        currentPassword: document.getElementById('pwCurrent').value,
        newPassword: document.getElementById('pwNew').value,
      }),
    });
    flash(msg, 'Password updated.', true);
    document.getElementById('pwForm').reset();
  } catch (err) {
    flash(msg, err.message, false);
  }
}

async function addMember(e) {
  e.preventDefault();
  const msg = document.getElementById('addMemberMsg');
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const data = await api('/api/admin/members/add', {
      method: 'POST',
      body: JSON.stringify({
        firstName: document.getElementById('addFirstName').value.trim(),
        lastName: document.getElementById('addLastName').value.trim(),
        email: document.getElementById('addEmail').value.trim(),
        membershipType: document.getElementById('addType').value,
        password: document.getElementById('addPassword').value,
      }),
    });
    flash(msg, `Added ${data.member.firstName} ${data.member.lastName} — they can now log in to Match Predictions.`, true);
    e.target.reset();
    document.getElementById('addPassword').value = 'penya2026';
    await Promise.all([loadMembers(), loadStats()]);
  } catch (err) {
    flash(msg, err.message, false);
  } finally {
    btn.disabled = false;
  }
}

async function loadMembers() {
  const q = document.getElementById('searchBox').value.trim();
  const status = document.getElementById('statusFilter').value;
  const type = document.getElementById('typeFilter').value;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  if (type) params.set('type', type);

  const tbody = document.getElementById('membersBody');
  try {
    const { members } = await api(`/api/admin/members?${params.toString()}`);
    if (!members.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--muted)">No members match this view.</td></tr>';
      return;
    }
    tbody.innerHTML = members.map((m) => `
      <tr data-id="${m.id}">
        <td>${escapeHtml(m.firstName)} ${escapeHtml(m.lastName)}${m.childName ? `<br><small style="color:var(--muted)">Child: ${escapeHtml(m.childName)}</small>` : ''}</td>
        <td>${escapeHtml(m.email)}</td>
        <td>${escapeHtml(m.contactNumber)}</td>
        <td>${escapeHtml(m.country)}</td>
        <td>${m.membershipType === 'adult' ? 'Adult' : 'Kids'}</td>
        <td>${escapeHtml(m.currency)} ${Number(m.amount).toLocaleString()}</td>
        <td><span class="badge ${m.status}">${m.status}</span></td>
        <td>${new Date(m.createdAt).toLocaleDateString()}</td>
        <td class="row-actions">
          ${m.status !== 'paid' ? `<button class="btn-mark" data-action="mark-paid">Mark Paid</button>` : ''}
          <button class="btn-del" data-action="delete">Delete</button>
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => handleRowAction(btn));
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--grana)">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function handleRowAction(btn) {
  const row = btn.closest('tr');
  const id = row.dataset.id;
  const action = btn.dataset.action;

  if (action === 'delete' && !confirm('Delete this member submission? This cannot be undone.')) return;

  btn.disabled = true;
  try {
    if (action === 'mark-paid') {
      await api(`/api/admin/members/${id}/mark-paid`, { method: 'POST' });
    } else if (action === 'delete') {
      await api(`/api/admin/members/${id}`, { method: 'DELETE' });
    }
    await Promise.all([loadMembers(), loadStats()]);
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
  }
}

/* ---------------------------- Announcements ---------------------------- */
async function sendBroadcast(e) {
  e.preventDefault();
  const msg = document.getElementById('broadcastMsg');
  const textEl = document.getElementById('broadcastText');
  const imageEl = document.getElementById('broadcastImage');
  const text = textEl.value.trim();
  const file = imageEl?.files?.[0] || null;

  if (!text && !file) {
    flash(msg, 'Add a message, an image, or both.', false);
    return;
  }
  if (file && file.size > 5 * 1024 * 1024) {
    flash(msg, 'That image is over the 5MB limit — please use a smaller one.', false);
    return;
  }
  if (!confirm('Send this announcement to all members on the Match Predictions page?')) return;

  try {
    // Sent as multipart when an image is attached — the endpoint accepts
    // either that or plain JSON.
    const formData = new FormData();
    formData.append('text', text);
    if (file) formData.append('image', file);
    const res = await fetch('/api/admin/chat/broadcast', {
      method: 'POST',
      credentials: 'same-origin',
      body: formData,
    });
    if (res.status === 401) { window.location.href = '/admin/login.html'; return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');

    textEl.value = '';
    if (imageEl) imageEl.value = '';
    flash(msg, 'Broadcast sent!', true);
    await loadBroadcasts();
  } catch (err) {
    flash(msg, err.message, false);
  }
}

async function loadBroadcasts() {
  const container = document.getElementById('broadcastHistory');
  if (!container) return;
  try {
    const data = await api('/api/admin/chat/broadcasts');
    const bcs = data.broadcasts || [];
    if (!bcs.length) {
      container.innerHTML = '<p style="color:var(--muted);font-size:.8rem">No broadcasts sent yet.</p>';
      return;
    }
    container.innerHTML = '<h3 style="font-size:.85rem;margin-bottom:10px">Recent Broadcasts</h3>' +
      bcs.map((b) => `
        <div style="background:rgba(237,187,0,.08);border:1px solid rgba(237,187,0,.2);border-radius:4px;padding:10px 14px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
          <div style="flex:1;min-width:0">
            ${b.text ? `<div style="font-size:.8rem;color:var(--chalk);margin-bottom:4px">${escapeHtml(b.text)}</div>` : ''}
            ${b.image ? `<a href="${escapeHtml(b.image.dataUrl)}" target="_blank" rel="noopener" style="display:inline-block;margin-bottom:6px"><img src="${escapeHtml(b.image.dataUrl)}" alt="${escapeHtml(b.image.filename || 'Announcement image')}" style="max-width:180px;max-height:120px;border:1px solid rgba(237,187,0,.3);border-radius:3px;display:block"></a>` : ''}
            <div style="font-size:.65rem;color:var(--muted)">${new Date(b.createdAt).toLocaleString()}</div>
          </div>
          <div class="row-actions" style="flex-shrink:0">
            <button class="btn-del" onclick="deleteBroadcast('${b.id}')">Delete</button>
          </div>
        </div>
      `).join('');
  } catch (err) {
    container.innerHTML = `<p style="color:var(--grana);font-size:.8rem">${escapeHtml(err.message)}</p>`;
  }
}

async function deleteBroadcast(id) {
  if (!confirm('Delete this broadcast? Members will no longer see it on the predictions page.')) return;
  try {
    await api(`/api/admin/chat/broadcast/${id}`, { method: 'DELETE' });
    await loadBroadcasts();
  } catch (err) {
    alert('Failed to delete: ' + err.message);
  }
}

/* ---------------------------- Predictions results visibility ---------------------------- */
async function loadPredictionResults() {
  const container = document.getElementById('predResultsList');
  if (!container) return;
  try {
    const data = await api('/api/admin/predictions/matches');
    const matches = data.matches || [];
    if (!matches.length) {
      container.innerHTML = '<p style="color:var(--muted);font-size:.8rem">No finished matches with predictions yet.</p>';
      return;
    }
    container.innerHTML = matches.map((m) => {
      const dateStr = new Date(m.utcDate).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
      const scoreStr = m.actual ? `${m.actual.home}–${m.actual.away}` : m.status;
      return `
        <div style="border:1px solid var(--line);border-radius:4px;${m.hidden ? 'opacity:.55' : ''}">
          <div style="display:flex;align-items:center;gap:12px;padding:10px 14px">
            <div style="flex:1;min-width:0">
              <div style="font-size:.82rem;color:var(--chalk);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                ${escapeHtml(m.homeTeam)} v ${escapeHtml(m.awayTeam)} <span style="color:var(--gold)">${escapeHtml(scoreStr)}</span>
              </div>
              <div style="font-size:.65rem;color:var(--muted);margin-top:2px">
                ${dateStr} · ${m.predictionsCount} prediction${m.predictionsCount === 1 ? '' : 's'}${m.hidden ? ' · <span style="color:var(--grana-lt)">hidden from members</span>' : ''}
              </div>
            </div>
            <button class="btn" style="padding:7px 12px;font-size:.68rem;flex-shrink:0"
              onclick="togglePredictionEntries('${m.fixtureId}')">Entries</button>
            <button class="btn ${m.hidden ? 'blue' : ''}" style="padding:7px 14px;font-size:.68rem;flex-shrink:0"
              onclick="toggleMatchHidden('${m.fixtureId}', ${!m.hidden})">${m.hidden ? 'Unhide' : 'Hide'}</button>
          </div>
          <div id="entries-${m.fixtureId}" style="display:none;border-top:1px solid var(--line);padding:8px 14px"></div>
        </div>
      `;
    }).join('');
  } catch (err) {
    container.innerHTML = `<p style="color:var(--grana);font-size:.8rem">${escapeHtml(err.message)}</p>`;
  }
}

const predictionEntryLabels = {};

/**
 * Show who predicted what for one match, so a bogus entry (a test account,
 * a duplicate) can be removed. Stored scores are never editable — this only
 * deletes a whole entry, and the server keeps a copy for the audit trail.
 */
async function togglePredictionEntries(fixtureId) {
  const panel = document.getElementById(`entries-${fixtureId}`);
  if (!panel) return;
  if (panel.style.display !== 'none') {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';
  panel.innerHTML = '<p style="color:var(--muted);font-size:.72rem;margin:4px 0">Loading…</p>';
  try {
    const data = await api(`/api/admin/predictions/matches/${fixtureId}/entries`);
    const entries = data.entries || [];
    if (!entries.length) {
      panel.innerHTML = '<p style="color:var(--muted);font-size:.72rem;margin:4px 0">No predictions for this match.</p>';
      return;
    }
    // Keep the labels here rather than trying to escape them into an
    // inline onclick attribute.
    entries.forEach((e) => {
      predictionEntryLabels[e.id] = `${e.member} — predicted ${e.homeGoals}–${e.awayGoals}`;
    });
    panel.innerHTML = entries.map((e) => `
      <div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.06)">
        <span style="flex:1;min-width:0;font-size:.75rem;color:var(--chalk-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(e.member)}</span>
        <span style="font-size:.78rem;color:var(--gold);font-weight:700;flex-shrink:0">${e.homeGoals}–${e.awayGoals}</span>
        <div class="row-actions" style="flex-shrink:0">
          <button class="btn-del" onclick="deletePredictionEntry('${e.id}','${fixtureId}')">Delete</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    panel.innerHTML = `<p style="color:var(--grana);font-size:.72rem;margin:4px 0">${escapeHtml(err.message)}</p>`;
  }
}

async function deletePredictionEntry(predictionId, fixtureId) {
  const label = predictionEntryLabels[predictionId] || 'this prediction';
  if (!confirm(`Permanently remove this prediction?\n\n${label}\n\nIt stops counting toward the league table. A copy is kept in the database audit trail.`)) return;
  try {
    await api(`/api/admin/predictions/entry/${predictionId}`, { method: 'DELETE' });
    await loadPredictionResults();
    // Re-open the same match so the admin can see the result of the removal.
    await togglePredictionEntries(fixtureId);
  } catch (err) {
    alert('Failed to delete: ' + err.message);
  }
}

async function toggleMatchHidden(fixtureId, hide) {
  if (hide && !confirm('Hide this match from the members\' results list? Their predictions and points for it are kept — this only shortens the display.')) return;
  try {
    await api(`/api/admin/predictions/matches/${fixtureId}/${hide ? 'hide' : 'unhide'}`, { method: 'POST' });
    await loadPredictionResults();
  } catch (err) {
    alert('Failed to update: ' + err.message);
  }
}

/* ---------------------------- Orphaned predictions ---------------------------- */
async function loadOrphanedPredictions() {
  const container = document.getElementById('orphanedList');
  if (!container) return;
  try {
    const data = await api('/api/admin/predictions/orphaned');
    const groups = data.groups || [];
    if (!groups.length) {
      container.innerHTML = '<p style="color:var(--muted);font-size:.8rem">None — every prediction currently has a name attached.</p>';
      return;
    }
    container.innerHTML = groups.map((g) => {
      const predList = g.predictions
        .slice()
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .map((p) => {
          const dateStr = p.utcDate
            ? new Date(p.utcDate).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
            : '';
          return `<div style="font-size:.75rem;color:var(--chalk-dim);padding:3px 0">${escapeHtml(p.homeTeam)} v ${escapeHtml(p.awayTeam)} — guessed <b style="color:var(--gold)">${p.homeGoals}–${p.awayGoals}</b>${dateStr ? ` · ${dateStr}` : ''}</div>`;
        })
        .join('');
      const [fn, ...rest] = (g.restoredName || '').split(' ');
      const ln = rest.join(' ');
      return `
        <div style="border:1px solid var(--line);border-radius:4px;padding:12px 14px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
            <span style="font-family:var(--mono);font-size:.62rem;color:var(--muted);word-break:break-all">memberId: ${escapeHtml(g.memberId)}</span>
            ${g.conversationId ? `<button class="btn blue" style="padding:4px 10px;font-size:.6rem" onclick="viewOrphanedChat('${g.conversationId}')">View chat</button>` : ''}
            ${g.restoredName ? `<span style="font-size:.7rem;color:#3ddc8a">Restored as "${escapeHtml(g.restoredName)}"</span>` : ''}
          </div>
          <div style="margin-bottom:10px">${predList}</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input type="text" placeholder="First name" id="orph-fn-${escapeHtml(g.memberId)}" value="${escapeHtml(fn || '')}"
              style="flex:1;min-width:100px;background:rgba(0,0,0,.4);border:1px solid var(--line);color:var(--chalk);padding:7px 10px;border-radius:4px;font-size:.78rem">
            <input type="text" placeholder="Last name" id="orph-ln-${escapeHtml(g.memberId)}" value="${escapeHtml(ln || '')}"
              style="flex:1;min-width:100px;background:rgba(0,0,0,.4);border:1px solid var(--line);color:var(--chalk);padding:7px 10px;border-radius:4px;font-size:.78rem">
            <button class="btn" style="padding:7px 14px;font-size:.68rem" onclick="restoreOrphanedName('${g.memberId}')">${g.restoredName ? 'Update' : 'Save name'}</button>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    container.innerHTML = `<p style="color:var(--grana);font-size:.8rem">${escapeHtml(err.message)}</p>`;
  }
}

async function restoreOrphanedName(memberId) {
  const firstName = document.getElementById(`orph-fn-${memberId}`).value.trim();
  const lastName = document.getElementById(`orph-ln-${memberId}`).value.trim();
  if (!firstName) { alert('First name is required'); return; }
  try {
    await api(`/api/admin/predictions/orphaned/${memberId}/restore`, {
      method: 'POST',
      body: JSON.stringify({ firstName, lastName }),
    });
    await loadOrphanedPredictions();
  } catch (err) {
    alert('Failed to save: ' + err.message);
  }
}

function viewOrphanedChat(conversationId) {
  document.getElementById('adminChatLayout')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  selectConversation(conversationId);
}

/* ---------------------------- Peyna Assistant Admin ---------------------------- */
let activeConvId = null;
let adminReplyToMsgId = null;
const ADMIN_BASE_TITLE = document.title;

function updateAdminUnreadIndicators(totalUnread) {
  const headerBadge = document.getElementById('adminHeaderBadge');
  const headerCount = document.getElementById('adminHeaderBadgeCount');
  if (headerBadge && headerCount) {
    if (totalUnread > 0) {
      headerCount.textContent = totalUnread > 99 ? '99+' : totalUnread;
      headerBadge.hidden = false;
    } else {
      headerBadge.hidden = true;
    }
  }
  document.title = totalUnread > 0 ? `(${totalUnread > 99 ? '99+' : totalUnread}) ${ADMIN_BASE_TITLE}` : ADMIN_BASE_TITLE;
}

async function loadAdminConversations() {
  const listEl = document.getElementById('adminConvItems');
  const badgeEl = document.getElementById('adminUnreadBadge');
  if (!listEl) return;
  try {
    const data = await api('/api/admin/chat/conversations');
    const convs = data.conversations || [];
    const totalUnread = convs.reduce((s, c) => s + (c.adminUnreadCount || 0), 0);
    if (badgeEl) {
      if (totalUnread > 0) { badgeEl.textContent = totalUnread; badgeEl.style.display = 'inline-block'; }
      else { badgeEl.style.display = 'none'; }
    }
    updateAdminUnreadIndicators(totalUnread);
    if (!convs.length) {
      listEl.innerHTML = '<p style="padding:20px;text-align:center;color:var(--muted);font-size:.75rem">No conversations yet.</p>';
      return;
    }
    allConversations = convs;
    renderConversationRows();
  } catch (err) {
    listEl.innerHTML = `<p style="padding:20px;text-align:center;color:var(--grana);font-size:.75rem">${escapeHtml(err.message)}</p>`;
  }
}

/** Grow the reply box to fit what's typed, up to the CSS max-height (after
 *  which it scrolls vertically). Reset to 'auto' first so it shrinks back
 *  when text is deleted. */
function autoGrowAdminChatInput() {
  const el = document.getElementById('adminChatText');
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

/* ---------------------------- Conversation list rendering ---------------------------- */
let allConversations = [];

/** Initials for the avatar circle, e.g. "Ashir Qureshi" -> "AQ". */
function initialsFor(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/** Relative-ish timestamp, like a messenger list. */
function chatListTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function renderConversationRows() {
  const listEl = document.getElementById('adminConvItems');
  if (!listEl) return;
  const term = (document.getElementById('waSearch')?.value || '').trim().toLowerCase();
  const rows = term
    ? allConversations.filter((c) => (c.memberName || '').toLowerCase().includes(term)
        || (c.lastMessagePreview || '').toLowerCase().includes(term))
    : allConversations;

  if (!rows.length) {
    listEl.innerHTML = `<p class="wa-empty">${term ? 'No chats match that search.' : 'No conversations yet.'}</p>`;
    return;
  }

  listEl.innerHTML = rows.map((c) => `
    <div class="wa-row ${c.adminUnreadCount > 0 ? 'unread' : ''} ${c.hasThread ? '' : 'no-thread'}"
      onclick="${c.hasThread ? `selectConversation('${c.id}')` : `startConversationWith('${c.memberId}')`}">
      <div class="wa-avatar ${c.isFormer ? 'former' : ''}">${escapeHtml(initialsFor(c.memberName))}</div>
      <div class="wa-row-main">
        <div class="wa-row-top">
          <span class="wa-row-name">${escapeHtml(c.memberName)}</span>
          <span class="wa-row-time">${escapeHtml(chatListTime(c.lastMessageAt))}</span>
        </div>
        <div class="wa-row-bottom">
          <span class="wa-row-preview">${escapeHtml(c.lastMessagePreview || (c.hasThread ? 'No messages yet' : 'Tap to start a chat'))}</span>
          ${c.isFormer ? '<span class="wa-tag-former">Former</span>' : ''}
          ${c.resolved ? '<span style="font-size:.6rem;color:#3ddc8a;flex-shrink:0">✓</span>' : ''}
          ${c.adminUnreadCount > 0 ? `<span class="wa-row-badge">${c.adminUnreadCount}</span>` : ''}
          ${c.hasThread ? `<button type="button" class="wa-row-del" title="Delete this chat"
            onclick="event.stopPropagation();deleteConversation('${c.id}')">🗑</button>` : ''}
        </div>
      </div>
    </div>
  `).join('');
}

/** Open a chat with a member who has never messaged — the thread is created
 *  on the server the first time it's opened. */
async function startConversationWith(memberId) {
  try {
    const { conversationId } = await api('/api/admin/chat/conversation/ensure', {
      method: 'POST',
      body: JSON.stringify({ memberId }),
    });
    await loadAdminConversations();
    await selectConversation(conversationId);
  } catch (err) {
    alert('Could not open that chat: ' + err.message);
  }
}

/** Swap between the chat list and an open conversation. */
function showChatList() {
  document.getElementById('waChatPane').hidden = true;
  document.getElementById('waListPane').hidden = false;
}
function showChatView() {
  document.getElementById('waListPane').hidden = true;
  document.getElementById('waChatPane').hidden = false;
}

/** Delete every thread whose member no longer exists. */
async function cleanupFormerChats() {
  const former = allConversations.filter((c) => c.isFormer);
  if (!former.length) {
    alert('There are no chats from former members.');
    return;
  }
  if (!confirm(`Delete ${former.length} chat${former.length === 1 ? '' : 's'} from members who no longer exist?\n\nThis cannot be undone.`)) return;
  try {
    const res = await api('/api/admin/chat/conversations/cleanup-former', { method: 'POST' });
    if (activeConvId && former.some((c) => c.id === activeConvId)) clearOpenConversation();
    await loadAdminConversations();
    showChatList();
    alert(`Removed ${res.removedConversations} chat(s).`);
  } catch (err) {
    alert('Cleanup failed: ' + err.message);
  }
}

/** Reset the chat pane back to its empty state. */
function clearOpenConversation() {
  activeConvId = null;
  closeAdminVoiceReview();
  const body = document.getElementById('adminChatBody');
  const nameEl = document.getElementById('adminChatMemberName');
  const emailEl = document.getElementById('adminChatMemberEmail');
  if (body) body.innerHTML = '<p class="wa-empty">Select a member conversation to start chatting.</p>';
  if (nameEl) nameEl.textContent = 'Select a conversation';
  if (emailEl) emailEl.textContent = '';
  const resolveBtn = document.getElementById('adminResolveBtn');
  if (resolveBtn) resolveBtn.style.display = 'none';
}

/** Permanently remove a chat thread — mainly to clear out members who have left. */
async function deleteConversation(convId) {
  if (!confirm('Delete this entire chat and all its messages?\n\nThis cannot be undone.')) return;
  try {
    await api(`/api/admin/chat/conversation/${convId}`, { method: 'DELETE' });
    if (activeConvId === convId) {
      clearOpenConversation();
      showChatList();
    }
    await loadAdminConversations();
  } catch (err) {
    alert('Failed to delete chat: ' + err.message);
  }
}

async function selectConversation(convId) {
  activeConvId = convId;
  adminReplyToMsgId = null;
  cancelAdminReply();
  // Drop any unsent recording — it was meant for the previous member.
  if (adminMediaRecorder && adminMediaRecorder.state === 'recording') adminMediaRecorder.stop();
  closeAdminVoiceReview();
  showChatView();
  await loadAdminMessages(convId);
  await loadAdminConversations(); // refresh list to clear unread
}

async function loadAdminMessages(convId) {
  const body = document.getElementById('adminChatBody');
  const nameEl = document.getElementById('adminChatMemberName');
  const emailEl = document.getElementById('adminChatMemberEmail');
  const resolveBtn = document.getElementById('adminResolveBtn');
  const textInput = document.getElementById('adminChatText');
  const sendBtn = document.getElementById('adminChatSend');
  const attachBtn = document.getElementById('adminChatAttach');
  const voiceBtn = document.getElementById('adminChatVoice');

  if (!convId) {
    body.innerHTML = '<p style="text-align:center;color:var(--muted);font-size:.8rem">Select a member conversation to start chatting.</p>';
    return;
  }

  try {
    const data = await api(`/api/admin/chat/messages/${convId}`);
    const conv = data.conversation;
    const msgs = data.messages || [];

    nameEl.textContent = conv.memberName;
    emailEl.textContent = conv.memberEmail || '';
    const avatar = document.getElementById('waChatAvatar');
    if (avatar) {
      avatar.textContent = initialsFor(conv.memberName);
      avatar.classList.toggle('former', !conv.memberEmail);
    }
    resolveBtn.style.display = 'inline-block';
    resolveBtn.textContent = conv.resolved ? 'Reopen' : 'Resolve';
    resolveBtn.style.color = conv.resolved ? '#0a7d43' : 'var(--gold)';
    // The composer is only reachable with a thread open now, so these are
    // always usable here — no more permanently greyed-out mic button.
    textInput.disabled = false;
    sendBtn.disabled = false;
    attachBtn.disabled = false;
    if (voiceBtn) voiceBtn.disabled = false;

    if (!msgs.length) {
      body.innerHTML = '<p class="wa-empty">No messages in this conversation yet.</p>';
      return;
    }

    body.innerHTML = msgs.map(renderAdminChatMsg).join('');
    body.scrollTop = body.scrollHeight;
  } catch (err) {
    body.innerHTML = `<p style="text-align:center;color:var(--grana);font-size:.8rem">${escapeHtml(err.message)}</p>`;
  }
}

function renderAdminChatMsg(m) {
  const isAdmin = m.isAdmin;
  const align = isAdmin ? 'flex-end' : 'flex-start';
  const bg = isAdmin ? 'linear-gradient(135deg,#1d6fd6,#12457f)' : 'linear-gradient(135deg,#e63946,#b32433)';
  const border = isAdmin ? 'rgba(29,111,214,.6)' : 'rgba(230,57,70,.6)';
  const sender = isAdmin ? '🛡️ Admin' : escapeHtml(m.senderName);
  const time = new Date(m.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  let replyHtml = '';
  if (m.replyTo) {
    replyHtml = `<div style="font-size:.6rem;color:rgba(255,255,255,.75);border-left:2px solid rgba(255,255,255,.4);padding-left:6px;margin-bottom:4px;opacity:.9">
      ↳ ${escapeHtml(m.replyTo.preview)}
    </div>`;
  }

  let content = replyHtml + escapeHtml(m.text || '');
  if (m.attachment && (m.attachment.dataUrl || m.attachment.url)) {
    const src = m.attachment.dataUrl || m.attachment.url;
    if (m.attachment.mimetype && m.attachment.mimetype.startsWith('image/')) {
      content += `<br><img src="${src}" alt="${escapeHtml(m.attachment.filename)}" style="max-width:200px;border-radius:4px;margin-top:4px;cursor:pointer" onclick="window.open('${src}','_blank')">`;
    } else if (m.attachment.mimetype && m.attachment.mimetype.startsWith('video/')) {
      content += `<br><video src="${src}" controls style="max-width:200px;border-radius:4px;margin-top:4px"></video>`;
    } else {
      content += `<br><a href="${src}" target="_blank" download="${escapeHtml(m.attachment.filename)}" style="color:var(--gold)">📎 ${escapeHtml(m.attachment.filename)}</a>`;
    }
  }
  if (m.voiceNote && (m.voiceNote.dataUrl || m.voiceNote.url)) {
    const vsrc = m.voiceNote.dataUrl || m.voiceNote.url;
    const duration = estimateAdminVoiceDuration(m.voiceNote.size);
    const bubbleWidth = Math.min(Math.max(duration * 8, 140), 260);
    content += `<br><div class="admin-voice-bubble" style="display:flex;align-items:center;gap:8px;min-width:140px;width:${bubbleWidth}px;margin-top:6px">
      <button class="admin-voice-play-btn" style="width:28px;height:28px;border-radius:50%;border:none;cursor:pointer;background:rgba(255,255,255,.25);color:#fff;font-size:.8rem;display:flex;align-items:center;justify-content:center;flex-shrink:0" onclick="toggleAdminVoiceNote(this,'${vsrc}')">▶</button>
      <div class="admin-voice-waveform" style="flex:1;height:22px;display:flex;align-items:center;gap:2px">${generateAdminWaveBars(16)}</div>
      <span style="font-size:.58rem;opacity:.75;flex-shrink:0">${formatAdminDuration(duration)}</span>
    </div>`;
  }

  const replyBtn = `<button class="btn" style="padding:2px 8px;font-size:.6rem;margin-top:4px;opacity:.75;background:rgba(0,0,0,.25);border-color:rgba(255,255,255,.3);color:#fff" onclick="setAdminReplyTo('${m.id}','${escapeHtml(m.text || (m.voiceNote ? 'Voice note' : 'Attachment')).replace(/'/g, "\\'")}')">Reply</button>`;

  return `<div style="align-self:${align};max-width:75%;background:${bg};border:1px solid ${border};border-radius:8px;padding:8px 12px;font-size:.8rem;font-family:var(--mono);word-break:break-word;color:#fff">
    <div style="font-size:.6rem;color:rgba(255,255,255,.7);text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px">${sender}</div>
    <div style="color:#fff;line-height:1.4">${content}</div>
    <div style="font-size:.55rem;color:rgba(255,255,255,.65);margin-top:4px;opacity:.9;display:flex;align-items:center;gap:6px">${time} ${replyBtn}</div>
  </div>`;
}

let adminVoiceNoteAudio = null;
function estimateAdminVoiceDuration(sizeBytes) {
  return Math.max(1, Math.round((sizeBytes || 0) / 2000));
}
function formatAdminDuration(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
function generateAdminWaveBars(count) {
  let bars = '';
  for (let i = 0; i < count; i++) {
    const h = Math.floor(Math.random() * 16) + 4;
    bars += `<div class="admin-voice-bar" style="flex:1;background:rgba(255,255,255,.35);border-radius:1px;min-height:4px;height:${h}px"></div>`;
  }
  return bars;
}
window.toggleAdminVoiceNote = function(btn, src) {
  if (adminVoiceNoteAudio && !adminVoiceNoteAudio.paused) {
    adminVoiceNoteAudio.pause();
    document.querySelectorAll('.admin-voice-play-btn').forEach(b => b.textContent = '▶');
    document.querySelectorAll('.admin-voice-bar').forEach(b => b.style.background = 'rgba(255,255,255,.35)');
    if (adminVoiceNoteAudio.src === src) { adminVoiceNoteAudio = null; return; }
  }
  adminVoiceNoteAudio = new Audio(src);
  const bubble = btn.closest('.admin-voice-bubble');
  const bars = bubble ? bubble.querySelectorAll('.admin-voice-bar') : [];
  adminVoiceNoteAudio.addEventListener('timeupdate', () => {
    const progress = adminVoiceNoteAudio.currentTime / adminVoiceNoteAudio.duration;
    const playedCount = Math.floor(progress * bars.length);
    bars.forEach((b, i) => { b.style.background = i < playedCount ? '#EDBB00' : 'rgba(255,255,255,.35)'; });
  });
  adminVoiceNoteAudio.addEventListener('ended', () => {
    btn.textContent = '▶';
    bars.forEach(b => b.style.background = 'rgba(255,255,255,.35)');
    adminVoiceNoteAudio = null;
  });
  adminVoiceNoteAudio.play();
  btn.textContent = '⏸';
};

async function sendAdminReply() {
  if (!activeConvId) return;
  const input = document.getElementById('adminChatText');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  autoGrowAdminChatInput(); // collapse back to one line after sending
  const replyTo = adminReplyToMsgId;
  cancelAdminReply();
  try {
    await api('/api/admin/chat/reply', { method: 'POST', body: JSON.stringify({ text, conversationId: activeConvId, replyToMessageId: replyTo }) });
    await loadAdminMessages(activeConvId);
    await loadAdminConversations();
  } catch (err) {
    input.value = text;
    alert('Failed to send: ' + err.message);
  }
}

async function sendAdminReplyWithFile(file, isVoice = false) {
  if (!activeConvId) return;
  const formData = new FormData();
  formData.append('file', file);
  formData.append('conversationId', activeConvId);
  // Without this the server files it as a plain attachment instead of a
  // playable voice note.
  formData.append('voiceNote', isVoice ? 'true' : 'false');
  if (adminReplyToMsgId) formData.append('replyToMessageId', adminReplyToMsgId);
  try {
    const res = await fetch('/api/admin/chat/upload', { method: 'POST', credentials: 'same-origin', body: formData });
    if (!res.ok) throw new Error(await res.text());
    cancelAdminReply();
    await loadAdminMessages(activeConvId);
    await loadAdminConversations();
  } catch (err) {
    alert('Failed to upload: ' + err.message);
  }
}

/* ---------------------------- Admin voice notes ----------------------------
   The mic button existed in the dashboard markup but had no JavaScript
   behind it at all (and was hardcoded `disabled`), so it did nothing. This
   mirrors the member-side recorder in predictions.js. */
let adminMediaRecorder = null;
let adminVoiceChunks = [];
let adminVoiceStarting = false;
let adminPendingVoiceFile = null;
let adminPendingVoiceUrl = null;

const ADMIN_MIC_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
const ADMIN_STOP_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

function resetAdminVoiceButton() {
  const voiceBtn = document.getElementById('adminChatVoice');
  if (!voiceBtn) return;
  voiceBtn.classList.remove('recording');
  voiceBtn.style.background = '';
  voiceBtn.innerHTML = ADMIN_MIC_ICON;
  voiceBtn.title = 'Record voice note';
}

function closeAdminVoiceReview() {
  const bar = document.getElementById('adminVoiceReview');
  const player = document.getElementById('adminVoicePlayer');
  if (bar) bar.classList.remove('is-open');
  if (player) player.removeAttribute('src');
  if (adminPendingVoiceUrl) URL.revokeObjectURL(adminPendingVoiceUrl);
  adminPendingVoiceUrl = null;
  adminPendingVoiceFile = null;
}

function openAdminVoiceReview(file) {
  adminPendingVoiceFile = file;
  if (adminPendingVoiceUrl) URL.revokeObjectURL(adminPendingVoiceUrl);
  adminPendingVoiceUrl = URL.createObjectURL(file);
  const player = document.getElementById('adminVoicePlayer');
  if (player) player.src = adminPendingVoiceUrl;
  const bar = document.getElementById('adminVoiceReview');
  if (bar) bar.classList.add('is-open');
}

async function toggleAdminVoiceRecord() {
  const voiceBtn = document.getElementById('adminChatVoice');
  if (!activeConvId) return;

  if (adminMediaRecorder && adminMediaRecorder.state === 'recording') {
    adminMediaRecorder.stop(); // onstop opens the review bar
    return;
  }
  if (adminVoiceStarting) return; // mic request already in flight

  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    alert('Voice recording is not supported in this browser.');
    return;
  }

  // Feedback before the await — getUserMedia doesn't resolve until the mic
  // prompt is answered, and without this the button looked dead and got
  // tapped repeatedly, each tap starting another mic request.
  adminVoiceStarting = true;
  voiceBtn.style.opacity = '.65';
  voiceBtn.title = 'Starting microphone…';
  closeAdminVoiceReview();

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    adminVoiceChunks = [];
    adminMediaRecorder = new MediaRecorder(stream, pickRecorderOptions());
    adminMediaRecorder.ondataavailable = (e) => { if (e.data.size) adminVoiceChunks.push(e.data); };
    adminMediaRecorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      resetAdminVoiceButton();
      // Use what the recorder actually produced, not an assumed format.
      const type = (adminMediaRecorder.mimeType || adminVoiceChunks[0]?.type || 'audio/webm').split(';')[0];
      const blob = new Blob(adminVoiceChunks, { type });
      if (!blob.size) {
        alert('Nothing was recorded — try holding the button a moment longer.');
        return;
      }
      openAdminVoiceReview(new File([blob], `voice-${Date.now()}.${extForAudioType(type)}`, { type }));
    };
    adminMediaRecorder.start();
    voiceBtn.classList.add('recording');
    voiceBtn.style.background = 'var(--grana)';
    voiceBtn.innerHTML = ADMIN_STOP_ICON;
    voiceBtn.title = 'Stop recording';
  } catch (err) {
    resetAdminVoiceButton();
    // Report what actually failed — "denied or not available" made real
    // problems (unsupported codec, insecure origin) impossible to diagnose.
    const reason = err && err.name === 'NotAllowedError'
      ? 'Microphone permission was denied. Allow it for this site in your browser settings, then tap again.'
      : err && err.name === 'NotFoundError'
        ? 'No microphone was found on this device.'
        : `Could not start recording (${err?.name || 'error'}: ${err?.message || 'unknown'})`;
    alert(reason);
  } finally {
    adminVoiceStarting = false;
    voiceBtn.style.opacity = '';
  }
}

/* Pick a container the browser can actually record. Chrome/Firefox do webm;
   iOS Safari only does mp4, and recording it while claiming webm produced a
   file that wouldn't play back. Passing no options lets the browser choose. */
function pickRecorderOptions() {
  if (typeof MediaRecorder?.isTypeSupported !== 'function') return undefined;
  for (const mimeType of ['audio/webm', 'audio/mp4', 'audio/ogg']) {
    if (MediaRecorder.isTypeSupported(mimeType)) return { mimeType };
  }
  return undefined;
}

function extForAudioType(type) {
  if (type.includes('mp4')) return 'm4a';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('mpeg')) return 'mp3';
  return 'webm';
}

async function sendAdminPendingVoiceNote() {
  if (!adminPendingVoiceFile) return;
  const file = adminPendingVoiceFile;
  const btn = document.getElementById('adminVoiceSend');
  if (btn) btn.disabled = true;
  try {
    await sendAdminReplyWithFile(file, true);
    closeAdminVoiceReview();
  } finally {
    if (btn) btn.disabled = false;
  }
}

function setAdminReplyTo(msgId, previewText) {
  adminReplyToMsgId = msgId;
  const preview = document.getElementById('adminReplyPreview');
  const text = document.getElementById('adminReplyPreviewText');
  text.textContent = previewText.slice(0, 60);
  preview.style.display = 'block';
  document.getElementById('adminChatText').focus();
}

function cancelAdminReply() {
  adminReplyToMsgId = null;
  document.getElementById('adminReplyPreview').style.display = 'none';
}

async function toggleResolve() {
  if (!activeConvId) return;
  try {
    await api(`/api/admin/chat/resolve/${activeConvId}`, { method: 'POST' });
    await loadAdminMessages(activeConvId);
    await loadAdminConversations();
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}
