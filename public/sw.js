/* ==========================================================================
   Service worker for push notifications — used by BOTH sides of the chat:
     - the admin dashboard (scope '/admin/'), for member messages
     - the member predictions page (scope '/'), for admin replies
   It only shows notifications; there is no offline caching here.

   The target page, the tag and the reply endpoint all come from the push
   payload, so the same worker serves both sides without knowing who
   registered it.
   ========================================================================== */

// Served from our own origin. The club crest used to be pulled from
// pbisb.com/wp-content/..., which is cross-origin AND behind a 301 redirect
// — notification icons don't reliably survive that, which is why the
// notification fell back to a generic letter avatar.
const PBISB_ICON = '/icons/pbisb-logo.png';

self.addEventListener('push', (event) => {
  let data = { title: 'Penya Blaugrana Islamabad', body: 'You have a new message.' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    /* keep default */
  }

  const url = data.url || '/';
  const options = {
    body: data.body,
    icon: PBISB_ICON,
    badge: PBISB_ICON,
    // Tag per destination so an admin notification can't replace a member
    // one (and vice versa) on a device signed into both.
    tag: `pbi-chat:${url}`,
    renotify: true,
    data: { url, replyUrl: data.replyUrl || null, conversationId: data.conversationId || null },
  };

  // Inline reply where the platform supports it (Android Chrome). Browsers
  // that don't support actions simply ignore this, and Chrome's own
  // unsubscribe/site-settings entry is unaffected either way.
  if (data.replyUrl) {
    options.actions = [{ action: 'reply', type: 'text', title: 'Reply', placeholder: 'Type a reply…' }];
  }

  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener('notificationclick', (event) => {
  const { url = '/', replyUrl, conversationId } = event.notification.data || {};

  // Inline reply: post it straight from the notification.
  if (event.action === 'reply') {
    const text = (event.reply || '').trim();
    if (!text || !replyUrl) {
      event.notification.close();
      return;
    }
    const payload = conversationId ? { text, conversationId } : { text };
    event.waitUntil(
      fetch(replyUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then((res) => {
          if (res.ok) return;
          throw new Error('reply failed');
        })
        .catch(() =>
          // Session expired or offline — say so rather than losing it silently.
          self.registration.showNotification('Reply not sent', {
            body: 'Open the site to send your message.',
            icon: PBISB_ICON,
            badge: PBISB_ICON,
            data: { url },
          }),
        )
        .finally(() => event.notification.close()),
    );
    return;
  }

  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      // Prefer an already-open tab on the same page.
      for (const win of windows) {
        if (win.url.includes(url) && 'focus' in win) return win.focus();
      }
      return clients.openWindow(url);
    }),
  );
});
