import { beforeEach, expect, it, vi } from 'vitest'
const { auth, db, send } = vi.hoisted(() => ({ auth: vi.fn(), db: vi.fn(), send: vi.fn() }))
vi.mock('@/lib/auth/account', () => ({ getCurrentAccount: auth, toErrorResponse: () => new Response(null, { status: 401 }) }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: db }))
vi.mock('@/lib/push/send', () => ({ pushConfigured: () => true, sendPush: send }))
import { POST } from './route'
import { __resetRateLimitForTests } from '@/lib/rate-limit'
beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://wa.joyboy.work'); auth.mockReset(); db.mockReset(); send.mockReset(); __resetRateLimitForTests(); auth.mockResolvedValue({ userId: 'u', accountId: 'a' }) })
function request(action: string, origin = 'https://wa.joyboy.work') {
  return new Request('https://wa.joyboy.work/api/push', { method: 'POST', headers: { origin }, body: JSON.stringify({ action, endpoint: 'https://web.push.apple.com/device' }) })
}
it('rejects unauthenticated callers before accessing subscriptions', async () => {
  auth.mockRejectedValue(new Error('no session'))
  expect((await POST(request('test'))).status).toBe(401)
  expect(db).not.toHaveBeenCalled()
})
it('rejects cross-origin subscription changes', async () => {
  expect((await POST(request('disable', 'https://evil.com'))).status).toBe(403)
  expect(db).not.toHaveBeenCalled()
})
it('scopes device tests to both the authenticated user and account', async () => {
  const chain = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }
  chain.select.mockReturnValue(chain); chain.eq.mockReturnValue(chain)
  db.mockReturnValue({ from: () => chain })
  expect((await POST(request('test'))).status).toBe(404)
  expect(chain.eq).toHaveBeenCalledWith('user_id', 'u')
  expect(chain.eq).toHaveBeenCalledWith('account_id', 'a')
  expect(send).not.toHaveBeenCalled()
})

it('accepts the configured HTTPS origin behind an HTTP reverse proxy', async () => {
  const response = await POST(new Request('http://localhost:3000/api/push', {
    method: 'POST', headers: { origin: 'https://wa.joyboy.work' }, body: '{}',
  }))
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'Invalid push endpoint' })
})
it('does not trust a spoofed forwarded host or the internal origin', async () => {
  const response = await POST(new Request('http://localhost:3000/api/push', {
    method: 'POST', headers: { origin: 'https://evil.com', 'x-forwarded-host': 'evil.com', 'x-forwarded-proto': 'https' }, body: '{}',
  }))
  expect(response.status).toBe(403)
})
it('rejects missing origins', async () => {
  expect((await POST(new Request('http://localhost:3000/api/push', { method: 'POST', body: '{}' }))).status).toBe(403)
})
