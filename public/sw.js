/* ==========================================================================
   Service worker for push notifications — used by BOTH sides of the chat:
     - the admin dashboard (scope '/admin/'), for member messages
     - the member predictions page (scope '/'), for admin replies
   It only shows notifications; there is no offline caching here.

   The target page and the notification tag come from the push payload, so
   the same worker serves both without knowing who registered it.
   ========================================================================== */

self.addEventListener('push', (event) => {
  let data = { title: 'Penya Blaugrana Islamabad', body: 'You have a new message.' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    /* keep default */
  }

  const url = data.url || '/';
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: 'https://pbisb.com/wp-content/uploads/2025/08/WhatsApp-Image-2025-08-16-at-13.14.56-1-252x300.png',
      // Tag per destination so an admin notification can't replace a
      // member one (and vice versa) on a device signed into both.
      tag: `pbi-chat:${url}`,
      renotify: true,
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
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
