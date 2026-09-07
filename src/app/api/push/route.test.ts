import { beforeEach, expect, it, vi } from 'vitest'
const { auth, db, send } = vi.hoisted(() => ({ auth: vi.fn(), db: vi.fn(), send: vi.fn() }))
vi.mock('@/lib/auth/account', () => ({ getCurrentAccount: auth, toErrorResponse: () => new Response(null, { status: 401 }) }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: db }))
vi.mock('@/lib/push/send', () => ({ pushConfigured: () => true, sendPush: send }))
import { POST } from './route'
import { __resetRateLimitForTests } from '@/lib/rate-limit'
beforeEach(() => { auth.mockReset(); db.mockReset(); send.mockReset(); __resetRateLimitForTests(); auth.mockResolvedValue({ userId: 'u', accountId: 'a' }) })
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
