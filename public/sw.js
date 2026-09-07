/* Push only: never cache authenticated pages or API responses. */
self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data?.json() || {} } catch { /* Show a private fallback. */ }
  event.waitUntil(self.registration.showNotification('wacrm', {
    body: data.body || 'New WhatsApp message',
    icon: '/pwa-192.png',
    tag: data.tag,
    data: { url: data.url || '/inbox' },
  }))
})
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL(event.notification.data?.url || '/inbox', self.location.origin)
  if (target.origin !== self.location.origin || target.pathname !== '/inbox') target.href = self.location.origin + '/inbox'
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const client = windows.find(window => new URL(window.url).origin === self.location.origin)
    if (client) {
      await client.navigate(target.href)
      return client.focus()
    }
    return self.clients.openWindow(target.href)
  })())
})
