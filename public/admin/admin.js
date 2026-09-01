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
    if (e.key === 'Enter') { e.preventDefault(); sendAdminReply(); }
  });
  document.getElementById('adminChatAttach').addEventListener('click', () => {
    document.getElementById('adminChatFile').click();
  });
  document.getElementById('adminChatFile').addEventListener('change', () => {
    const f = document.getElementById('adminChatFile');
    if (f.files[0]) sendAdminReplyWithFile(f.files[0]);
    f.value = '';
  });
  document.getElementById('fxSyncBtn').addEventListener('click', syncFixturesNow);
  document.getElementById('fxClearBtn').addEventListener('click', clearFixturesCache);
  document.getElementById('refreshBtn').addEventListener('click', () => { loadStats(); loadMembers(); loadFixtureStatus(); });
  document.getElementById('searchBox').addEventListener('input', debounce(loadMembers, 300));
  document.getElementById('statusFilter').addEventListener('change', loadMembers);
  document.getElementById('typeFilter').addEventListener('change', loadMembers);
  loadBroadcasts();
  loadAdminChat();
  setInterval(loadAdminChat, 5000);
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

/* ---------------------------- ChatBox Broadcast ---------------------------- */
async function sendBroadcast(e) {
  e.preventDefault();
  const msg = document.getElementById('broadcastMsg');
  const text = document.getElementById('broadcastText').value.trim();
  if (!text) return;
  if (!confirm('Send this broadcast to all members in the ChatBox?')) return;
  try {
    await api('/api/admin/chat/broadcast', { method: 'POST', body: JSON.stringify({ text }) });
    document.getElementById('broadcastText').value = '';
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
        <div style="background:rgba(237,187,0,.08);border:1px solid rgba(237,187,0,.2);border-radius:4px;padding:10px 14px;margin-bottom:8px">
          <div style="font-size:.8rem;color:var(--chalk);margin-bottom:4px">${escapeHtml(b.text)}</div>
          <div style="font-size:.65rem;color:var(--muted)">${new Date(b.createdAt).toLocaleString()}</div>
        </div>
      `).join('');
  } catch (err) {
    container.innerHTML = `<p style="color:var(--grana);font-size:.8rem">${escapeHtml(err.message)}</p>`;
  }
}

/* ---------------------------- Admin ChatBox ---------------------------- */
let adminChatLastCount = 0;

async function loadAdminChat() {
  const body = document.getElementById('adminChatBody');
  if (!body) return;
  try {
    const data = await api('/api/admin/chat/messages');
    const msgs = data.messages || [];
    if (!msgs.length) {
      body.innerHTML = '<p style="text-align:center;color:var(--muted);font-size:.8rem">No messages yet.</p>';
      adminChatLastCount = 0;
      return;
    }
    // Preserve scroll position if user is near bottom
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 100;
    body.innerHTML = msgs.map(renderAdminChatMsg).join('');
    if (nearBottom) body.scrollTop = body.scrollHeight;
    adminChatLastCount = msgs.length;
  } catch (err) {
    body.innerHTML = `<p style="text-align:center;color:var(--grana);font-size:.8rem">${escapeHtml(err.message)}</p>`;
  }
}

function renderAdminChatMsg(m) {
  let bg, border, align, sender;
  if (m.isBroadcast) {
    bg = 'rgba(237,187,0,.1)'; border = 'rgba(237,187,0,.3)';
    align = 'center'; sender = '📢 Broadcast';
  } else if (m.isAdmin) {
    bg = 'rgba(0,77,152,.15)'; border = 'rgba(0,77,152,.4)';
    align = 'flex-end'; sender = '🛡️ Admin (You)';
  } else {
    bg = 'rgba(255,255,255,.06)'; border = 'rgba(255,255,255,.1)';
    align = 'flex-start'; sender = escapeHtml(m.senderName);
  }
  const time = new Date(m.createdAt).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const email = m.senderEmail ? ` &lt;${escapeHtml(m.senderEmail)}&gt;` : '';
  let content = escapeHtml(m.text || '');
  if (m.attachment) {
    const url = m.attachment.url;
    if (m.attachment.mimetype && m.attachment.mimetype.startsWith('image/')) {
      content += `<br><img src="${url}" alt="${escapeHtml(m.attachment.filename)}" style="max-width:200px;border-radius:4px;margin-top:4px;cursor:pointer" onclick="window.open('${url}','_blank')">`;
    } else if (m.attachment.mimetype && m.attachment.mimetype.startsWith('video/')) {
      content += `<br><video src="${url}" controls style="max-width:200px;border-radius:4px;margin-top:4px"></video>`;
    } else {
      content += `<br><a href="${url}" target="_blank" style="color:var(--gold)">📎 ${escapeHtml(m.attachment.filename)}</a>`;
    }
  }
  if (m.voiceNote) {
    content += `<br><audio src="${m.voiceNote.url}" controls style="width:100%;margin-top:4px"></audio>`;
  }
  const replyBtn = (!m.isAdmin && !m.isBroadcast) ?
    ` <button class="btn" style="padding:3px 8px;font-size:.65rem;margin-top:4px" onclick="adminReplyTo('${m.id}','${escapeHtml(m.senderName).replace(/'/g, "\\'")}')">Reply</button>` : '';
  return `<div style="align-self:${align};max-width:75%;background:${bg};border:1px solid ${border};border-radius:6px;padding:8px 12px;font-size:.8rem;font-family:var(--mono);word-break:break-word">
    <div style="font-size:.6rem;color:var(--muted-lt);text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px">${sender}${email}</div>
    <div style="color:var(--chalk);line-height:1.4">${content}</div>
    <div style="font-size:.55rem;color:var(--muted);margin-top:4px;opacity:.7">${time}</div>
    ${replyBtn}
  </div>`;
}

async function sendAdminReply() {
  const input = document.getElementById('adminChatText');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try {
    await api('/api/admin/chat/reply', { method: 'POST', body: JSON.stringify({ text }) });
    await loadAdminChat();
  } catch (err) {
    input.value = text;
    alert('Failed to send: ' + err.message);
  }
}

async function sendAdminReplyWithFile(file) {
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await fetch('/api/admin/chat/upload', {
      method: 'POST',
      credentials: 'same-origin',
      body: formData,
    });
    if (!res.ok) throw new Error(await res.text());
    await loadAdminChat();
  } catch (err) {
    alert('Failed to upload: ' + err.message);
  }
}

function adminReplyTo(msgId, senderName) {
  const input = document.getElementById('adminChatText');
  input.value = `@${senderName}: `;
  input.focus();
}
