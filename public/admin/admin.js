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
    loadStats(), loadPricing(), loadMembers(), loadFixtureStatus(), loadMediaPosts(),
  ]);

  document.getElementById('pricingForm').addEventListener('submit', savePricing);
  document.getElementById('pwForm').addEventListener('submit', changePassword);
  document.getElementById('mediaForm').addEventListener('submit', addMediaPost);
  document.getElementById('mediaType').addEventListener('change', updateMediaPlaceholder);
  const mediaFileInput = document.getElementById('mediaFile');
  if (mediaFileInput) {
    mediaFileInput.addEventListener('change', () => {
      const f = mediaFileInput.files[0];
      if (!f) return;
      // Auto-detect type from the file
      const isVideo = f.type.startsWith('video/');
      document.getElementById('mediaType').value = isVideo ? 'video' : 'photo';
      // Clear the URL field since we'll upload the file
      document.getElementById('mediaSrc').value = '';
      document.getElementById('mediaSrc').required = false;
    });
  }
  document.getElementById('fxSyncBtn').addEventListener('click', syncFixturesNow);
  document.getElementById('fxClearBtn').addEventListener('click', clearFixturesCache);
  document.getElementById('refreshBtn').addEventListener('click', () => { loadStats(); loadMembers(); loadFixtureStatus(); });
  document.getElementById('searchBox').addEventListener('input', debounce(loadMembers, 300));
  document.getElementById('statusFilter').addEventListener('change', loadMembers);
  document.getElementById('typeFilter').addEventListener('change', loadMembers);
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

/* ---------------- Media gallery ---------------- */
function updateMediaPlaceholder() {
  const type = document.getElementById('mediaType').value;
  const src = document.getElementById('mediaSrc');
  src.placeholder = type === 'video'
    ? 'https://.../clip.mp4 (or YouTube/Vimeo URL)'
    : 'https://.../photo.jpg';
}

async function loadMediaPosts() {
  const list = document.getElementById('mediaList');
  if (!list) return;
  try {
    const { posts } = await api('/api/media');
    if (!posts.length) {
      list.innerHTML = '<p style="color:var(--muted);font-size:.88rem;margin:0">No posts yet. Add your first post above.</p>';
      return;
    }
    list.innerHTML = posts.map((p) => `
      <div data-id="${p.id}" style="display:flex;gap:14px;align-items:center;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:12px">
        <div style="flex:0 0 80px;height:80px;border-radius:6px;overflow:hidden;background:#000;display:flex;align-items:center;justify-content:center">
          ${p.type === 'video'
            ? `<span style="color:var(--blau);font-size:1.4rem">▶</span>`
            : `<img src="${escapeHtml(p.src)}" alt="" style="width:100%;height:100%;object-fit:cover">`}
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">${escapeHtml(p.type)}</div>
          <div style="color:var(--chalk);font-size:.9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(p.caption || '(no caption)')}</div>
          <div style="color:var(--muted);font-size:.78rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(p.link || '→ Instagram profile')}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px">
          <button class="btn-mark" data-action="media-up" ${p.order === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn-mark" data-action="media-down">↓</button>
          <button class="btn-del" data-action="media-delete">Delete</button>
        </div>
      </div>
    `).join('');
    list.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => handleMediaAction(btn));
    });
  } catch (err) {
    list.innerHTML = `<p style="color:var(--grana);font-size:.88rem;margin:0">${escapeHtml(err.message)}</p>`;
  }
}

async function addMediaPost(e) {
  e.preventDefault();
  const msg = document.getElementById('mediaMsg');
  const fileInput = document.getElementById('mediaFile');
  const file = fileInput && fileInput.files[0];
  const urlField = document.getElementById('mediaSrc');

  // If a file was selected, upload it first and use the returned URL
  if (file) {
    const progress = document.getElementById('uploadProgress');
    if (progress) progress.style.display = 'block';
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/admin/media/upload', {
        method: 'POST',
        body: fd,
      });
      if (res.status === 401) { window.location.href = '/admin/login.html'; return; }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      urlField.value = data.url;
      if (progress) { progress.textContent = 'Upload complete!'; progress.style.color = '#0a7d43'; }
    } catch (err) {
      if (progress) { progress.style.display = 'none'; }
      flash(msg, 'Upload failed: ' + err.message, false);
      return;
    }
  }

  const body = {
    type: document.getElementById('mediaType').value,
    src: urlField.value.trim(),
    caption: document.getElementById('mediaCaption').value.trim(),
    link: document.getElementById('mediaLink').value.trim(),
  };
  if (!body.src) { flash(msg, 'Media URL or file is required.', false); return; }
  try {
    await api('/api/admin/media', { method: 'POST', body: JSON.stringify(body) });
    flash(msg, 'Post added — it is now live on the Media page.', true);
    document.getElementById('mediaForm').reset();
    updateMediaPlaceholder();
    const progress = document.getElementById('uploadProgress');
    if (progress) progress.style.display = 'none';
    await loadMediaPosts();
  } catch (err) {
    flash(msg, err.message, false);
  }
}

async function handleMediaAction(btn) {
  const card = btn.closest('[data-id]');
  const id = card.dataset.id;
  const action = btn.dataset.action;
  if (action === 'media-delete' && !confirm('Delete this media post?')) return;
  btn.disabled = true;
  try {
    if (action === 'media-delete') {
      await api(`/api/admin/media/${id}`, { method: 'DELETE' });
    } else if (action === 'media-up') {
      await api(`/api/admin/media/${id}/move`, { method: 'POST', body: JSON.stringify({ dir: -1 }) });
    } else if (action === 'media-down') {
      await api(`/api/admin/media/${id}/move`, { method: 'POST', body: JSON.stringify({ dir: 1 }) });
    }
    await loadMediaPosts();
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
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
