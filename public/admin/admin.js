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
    if (!activeConvId) return;
    document.getElementById('adminChatFile').click();
  });
  document.getElementById('adminChatFile').addEventListener('change', () => {
    const f = document.getElementById('adminChatFile');
    if (f.files[0]) sendAdminReplyWithFile(f.files[0]);
    f.value = '';
  });
  document.getElementById('adminResolveBtn').addEventListener('click', toggleResolve);
  document.getElementById('fxSyncBtn').addEventListener('click', syncFixturesNow);
  document.getElementById('fxClearBtn').addEventListener('click', clearFixturesCache);
  document.getElementById('refreshBtn').addEventListener('click', () => { loadStats(); loadMembers(); loadFixtureStatus(); });
  document.getElementById('searchBox').addEventListener('input', debounce(loadMembers, 300));
  document.getElementById('statusFilter').addEventListener('change', loadMembers);
  document.getElementById('typeFilter').addEventListener('change', loadMembers);
  loadBroadcasts();
  loadAdminConversations();
  setInterval(loadAdminConversations, 5000);
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
  const text = document.getElementById('broadcastText').value.trim();
  if (!text) return;
  if (!confirm('Send this announcement to all members on the Match Predictions page?')) return;
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
        <div style="background:rgba(237,187,0,.08);border:1px solid rgba(237,187,0,.2);border-radius:4px;padding:10px 14px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
          <div style="flex:1;min-width:0">
            <div style="font-size:.8rem;color:var(--chalk);margin-bottom:4px">${escapeHtml(b.text)}</div>
            <div style="font-size:.65rem;color:var(--muted)">${new Date(b.createdAt).toLocaleString()}</div>
          </div>
          <button class="btn" style="padding:6px 12px;font-size:.65rem;flex-shrink:0;border-color:var(--grana);color:var(--grana)" onclick="deleteBroadcast('${b.id}')">Delete</button>
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

/* ---------------------------- Peyna Assistant Admin ---------------------------- */
let activeConvId = null;
let adminReplyToMsgId = null;

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
    if (!convs.length) {
      listEl.innerHTML = '<p style="padding:20px;text-align:center;color:var(--muted);font-size:.75rem">No conversations yet.</p>';
      return;
    }
    listEl.innerHTML = convs.map((c) => `
      <div class="conv-item ${c.id === activeConvId ? 'active' : ''}" data-conv-id="${c.id}"
        onclick="selectConversation('${c.id}')"
        style="padding:12px 14px;border-bottom:1px solid var(--line);cursor:pointer;transition:background .15s;${c.id === activeConvId ? 'background:rgba(0,77,152,.2)' : ''}">
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:.78rem;font-weight:600;color:var(--chalk);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(c.memberName)}</span>
          ${c.adminUnreadCount > 0 ? `<span style="background:var(--grana);color:#fff;font-size:.55rem;padding:1px 6px;border-radius:8px;flex-shrink:0">${c.adminUnreadCount}</span>` : ''}
          ${c.resolved ? '<span style="font-size:.55rem;color:#0a7d43;flex-shrink:0">✓</span>' : ''}
        </div>
        <div style="font-size:.65rem;color:var(--muted);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(c.lastMessagePreview || 'No messages yet')}</div>
        <div style="font-size:.55rem;color:var(--muted-lt);margin-top:2px">${new Date(c.lastMessageAt).toLocaleDateString()} ${new Date(c.lastMessageAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div>
      </div>
    `).join('');
  } catch (err) {
    listEl.innerHTML = `<p style="padding:20px;text-align:center;color:var(--grana);font-size:.75rem">${escapeHtml(err.message)}</p>`;
  }
}

async function selectConversation(convId) {
  activeConvId = convId;
  adminReplyToMsgId = null;
  cancelAdminReply();
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
    resolveBtn.style.display = 'inline-block';
    resolveBtn.textContent = conv.resolved ? 'Reopen' : 'Resolve';
    resolveBtn.style.color = conv.resolved ? '#0a7d43' : 'var(--gold)';
    textInput.disabled = false;
    sendBtn.disabled = false;
    attachBtn.disabled = false;

    if (!msgs.length) {
      body.innerHTML = '<p style="text-align:center;color:var(--muted);font-size:.8rem;padding:20px">No messages in this conversation yet.</p>';
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

async function sendAdminReplyWithFile(file) {
  if (!activeConvId) return;
  const formData = new FormData();
  formData.append('file', file);
  formData.append('conversationId', activeConvId);
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
