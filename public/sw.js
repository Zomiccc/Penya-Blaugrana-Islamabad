/* ==========================================================================
   Service worker for admin phone push notifications.
   Registered with scope '/admin/' from the admin dashboard — it only shows
   notifications for chat messages, it does not do any offline caching.
   ========================================================================== */

self.addEventListener('push', (event) => {
  let data = { title: 'Peyna Assistant', body: 'You have a new message.' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    /* keep default */
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: 'https://pbisb.com/wp-content/uploads/2025/08/WhatsApp-Image-2025-08-16-at-13.14.56-1-252x300.png',
      tag: 'pbi-admin-chat',
      renotify: true,
      data: { url: '/admin/dashboard.html' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/admin/dashboard.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const win of windows) {
        if (win.url.includes('/admin/') && 'focus' in win) return win.focus();
      }
      return clients.openWindow(url);
    }),
  );
});
