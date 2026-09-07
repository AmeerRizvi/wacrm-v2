import { describe, expect, it } from 'vitest'
import { validEndpoint, validSubscription } from './validation'

describe('push endpoint validation', () => {
  it('accepts supported browser push services', () => {
    for (const host of ['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com']) expect(validEndpoint(`https://${host}/subscription`)).toBe(true)
  })
  it('rejects SSRF targets and misleading hosts', () => {
    for (const url of ['http://fcm.googleapis.com/a', 'https://localhost/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'https://fcm.googleapis.com.evil.com/a', 'https://evil.com/?fcm.googleapis.com', 'https://user:pass@fcm.googleapis.com/a', 'https://fcm.googleapis.com:8443/a']) expect(validEndpoint(url)).toBe(false)
  })
  it('requires correctly sized encryption keys', () => {
    const sub = { endpoint: 'https://web.push.apple.com/a', keys: { p256dh: 'A'.repeat(87), auth: 'A'.repeat(22) } }
    expect(validSubscription(sub)).toBe(true)
    expect(validSubscription({ ...sub, keys: { ...sub.keys, auth: 'short' } })).toBe(false)
    expect(validSubscription(null)).toBe(false)
  })
})
