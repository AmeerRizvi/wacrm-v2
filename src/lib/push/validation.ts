import type { PushSubscription } from 'web-push'

// Only browser-vendor push services may receive server requests. No arbitrary URLs.
export function validEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
      (url.hostname === 'web.push.apple.com' || url.hostname === 'fcm.googleapis.com' ||
       url.hostname === 'updates.push.services.mozilla.com' ||
       url.hostname.endsWith('.push.services.mozilla.com'))
  } catch { return false }
}
export function validSubscription(value: unknown): value is PushSubscription {
  if (!value || typeof value !== 'object') return false
  const sub = value as PushSubscription
  return validEndpoint(sub.endpoint) && !!sub.keys &&
    typeof sub.keys.p256dh === 'string' && /^[A-Za-z0-9_-]{87}=?$/.test(sub.keys.p256dh) &&
    typeof sub.keys.auth === 'string' && /^[A-Za-z0-9_-]{22}={0,2}$/.test(sub.keys.auth)
}
