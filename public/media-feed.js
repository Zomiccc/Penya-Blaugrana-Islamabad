/* ==========================================================================
   SELF-HOSTED MEDIA FEED (Media page)
   No third-party widget, no API keys. Fetches posts the admin has added from
   the dashboard (/api/media) and renders them as a simple grid.
   - Photos: tapping the tile opens the post's link (defaults to the club's
     Instagram profile if the admin didn't set one) in a new tab.
   - Videos: tapping/hovering the tile plays it inline (muted, looping); a
     small corner button still lets people jump to the linked Instagram post.
   ========================================================================== */
document.addEventListener('DOMContentLoaded', () => {
  const grid = document.getElementById('mediaGrid');
  if (!grid) return;

  fetch('/api/media')
    .then((r) => r.json())
    .then(({ posts }) => {
      if (!posts || !posts.length) {
        grid.innerHTML = '<p class="media-empty">No posts yet — check back soon, or follow us on Instagram for the latest.</p>';
        return;
      }
      grid.innerHTML = posts.map(mediaTileHTML).join('');
    })
    .catch(() => {
      grid.innerHTML = '<p class="media-empty">Could not load the media feed right now. Please refresh.</p>';
    });
});

function mediaTileHTML(post) {
  const caption = (post.caption || '').replace(/"/g, '&quot;');
  const link = post.link || 'https://www.instagram.com/pbislamabad';

  if (post.type === 'video') {
    return `
      <div class="media-tile">
        <video src="${post.src}" muted loop playsinline preload="metadata"
          onmouseover="this.play()" onmouseout="this.pause()"
          onclick="this.paused ? this.play() : this.pause()"></video>
        <span class="play-badge"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></span>
        <a class="link-badge" href="${link}" target="_blank" rel="noopener" aria-label="View on Instagram" onclick="event.stopPropagation()">
          <svg viewBox="0 0 24 24"><path d="M12 2c-2.72 0-3.06.01-4.12.06-1.06.05-1.79.22-2.43.47-.66.26-1.22.6-1.77 1.16-.56.55-.9 1.11-1.16 1.77-.25.64-.42 1.37-.47 2.43C2 8.94 2 9.28 2 12s.01 3.06.06 4.12c.05 1.06.22 1.79.47 2.43.26.66.6 1.22 1.16 1.77.55.56 1.11.9 1.77 1.16.64.25 1.37.42 2.43.47C8.94 22 9.28 22 12 22s3.06-.01 4.12-.06c1.06-.05 1.79-.22 2.43-.47.66-.26 1.22-.6 1.77-1.16.56-.55.9-1.11 1.16-1.77.25-.64.42-1.37.47-2.43.05-1.06.06-1.4.06-4.12s-.01-3.06-.06-4.12c-.05-1.06-.22-1.79-.47-2.43a4.9 4.9 0 0 0-1.16-1.77 4.9 4.9 0 0 0-1.77-1.16c-.64-.25-1.37-.42-2.43-.47C15.06 2.01 14.72 2 12 2m0 1.8c2.67 0 2.99.01 4.04.06.98.04 1.5.21 1.86.34.47.18.8.4 1.15.75.35.35.57.68.75 1.15.13.36.29.88.34 1.86.05 1.05.06 1.37.06 4.04s-.01 2.99-.06 4.04c-.04.98-.21 1.5-.34 1.86-.18.47-.4.8-.75 1.15-.35.35-.68.57-1.15.75-.36.13-.88.29-1.86.34-1.05.05-1.37.06-4.04.06s-2.99-.01-4.04-.06c-.98-.04-1.5-.21-1.86-.34a3.1 3.1 0 0 1-1.15-.75 3.1 3.1 0 0 1-.75-1.15c-.13-.36-.29-.88-.34-1.86C3.81 14.99 3.8 14.67 3.8 12s.01-2.99.06-4.04c.04-.98.21-1.5.34-1.86.18-.47.4-.8.75-1.15.35-.35.68-.57 1.15-.75.36-.13.88-.29 1.86-.34C9.01 3.81 9.33 3.8 12 3.8m0 3.06a5.14 5.14 0 1 0 0 10.28 5.14 5.14 0 0 0 0-10.28M12 15.4a3.4 3.4 0 1 1 0-6.8 3.4 3.4 0 0 1 0 6.8m6.54-9.94a1.2 1.2 0 1 1-2.4 0 1.2 1.2 0 0 1 2.4 0"/></svg>
        </a>
        ${caption ? `<span class="caption-veil">${caption}</span>` : ''}
      </div>
    `;
  }

  return `
    <a class="media-tile" href="${link}" target="_blank" rel="noopener">
      <img src="${post.src}" alt="${caption || 'Penya Blaugrana Islamabad'}" loading="lazy">
      ${caption ? `<span class="caption-veil">${caption}</span>` : ''}
    </a>
  `;
}
