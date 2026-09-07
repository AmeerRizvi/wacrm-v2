import { beforeEach, expect, it, vi } from 'vitest'
const { send, from, eq } = vi.hoisted(() => ({ send: vi.fn(), from: vi.fn(), eq: vi.fn() }))
vi.mock('web-push', () => ({ default: { sendNotification: send } }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ from }) }))
import { sendPush } from './send'
const row = { id: 'device', subscription: { endpoint: 'https://web.push.apple.com/a', keys: { p256dh: 'A'.repeat(87), auth: 'A'.repeat(22) } } }
beforeEach(() => {
  vi.stubEnv('VAPID_PUBLIC_KEY', 'public'); vi.stubEnv('VAPID_PRIVATE_KEY', 'private'); vi.stubEnv('VAPID_SUBJECT', 'https://wa.joyboy.work')
  send.mockReset(); from.mockReset(); eq.mockReset()
  from.mockReturnValue({ delete: () => ({ eq }) })
})
it('removes expired subscriptions without retrying', async () => {
  send.mockRejectedValue({ statusCode: 410 })
  expect(await sendPush(row, {})).toBe(false)
  expect(eq).toHaveBeenCalledWith('id', 'device')
  expect(send).toHaveBeenCalledTimes(1)
})
it('retries a transient failure once', async () => {
  send.mockRejectedValueOnce({ statusCode: 503 }).mockResolvedValueOnce({})
  expect(await sendPush(row, {})).toBe(true)
  expect(send).toHaveBeenCalledTimes(2)
})
it('does not send to arbitrary stored endpoints', async () => {
  expect(await sendPush({ ...row, subscription: { ...row.subscription, endpoint: 'https://localhost/' } }, {})).toBe(false)
  expect(send).not.toHaveBeenCalled()
})
