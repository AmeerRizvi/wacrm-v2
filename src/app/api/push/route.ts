import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { pushConfigured, sendPush } from '@/lib/push/send'
import { validSubscription, validEndpoint } from '@/lib/push/validation'

export async function GET() {
  try {
    await getCurrentAccount()
    return NextResponse.json({ publicKey: pushConfigured() ? process.env.VAPID_PUBLIC_KEY : null })
  } catch (error) { return toErrorResponse(error) }
}
export async function POST(request: Request) {
  try {
    const { userId, accountId } = await getCurrentAccount()
    if (request.headers.get('origin') !== new URL(request.url).origin) return NextResponse.json({ error: 'Invalid origin' }, { status: 403 })
    const limit = checkRateLimit(`push:${userId}`, { limit: 10, windowMs: 60000 })
    if (!limit.success) return rateLimitResponse(limit)
    const raw = await request.text()
    if (raw.length > 8192) return NextResponse.json({ error: 'Request too large' }, { status: 413 })
    let body
    try { body = JSON.parse(raw) } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
    if (!body || !validEndpoint(body.endpoint)) return NextResponse.json({ error: 'Invalid push endpoint' }, { status: 400 })
    const db = supabaseAdmin()
    if (body.action === 'disable') {
      const { error } = await db.from('push_subscriptions').delete().eq('endpoint', body.endpoint).eq('user_id', userId).eq('account_id', accountId)
      if (error) throw new Error('Could not disable notifications')
    } else if (body.action === 'enable') {
      if (!pushConfigured()) return NextResponse.json({ error: 'Push notifications are not configured on the server yet' }, { status: 503 })
      if (!validSubscription(body.subscription) || body.subscription.endpoint !== body.endpoint) return NextResponse.json({ error: 'Invalid subscription' }, { status: 400 })
      const { data: existing, error: lookupError } = await db.from('push_subscriptions').select('user_id').eq('endpoint', body.endpoint).maybeSingle()
      if (lookupError) throw new Error('Subscription lookup failed')
      if (existing && existing.user_id !== userId) return NextResponse.json({ error: 'Disable notifications in the previous account first' }, { status: 409 })
      const values = { user_id: userId, account_id: accountId, endpoint: body.endpoint, subscription: body.subscription }
      const { error } = existing
        ? await db.from('push_subscriptions').update(values).eq('endpoint', body.endpoint).eq('user_id', userId)
        : await db.from('push_subscriptions').insert(values)
      if (error) throw new Error('Subscription save failed')
    } else if (body.action === 'test') {
      const { data, error } = await db.from('push_subscriptions').select('id,subscription').eq('endpoint', body.endpoint).eq('user_id', userId).eq('account_id', accountId).maybeSingle()
      if (error || !data) return NextResponse.json({ error: 'Enable notifications on this device first' }, { status: 404 })
      if (!await sendPush(data, { title: 'wacrm', body: 'Notifications are working on this device', url: '/inbox', tag: 'wacrm-test' })) return NextResponse.json({ error: 'Push delivery failed. Try enabling notifications again.' }, { status: 502 })
    } else return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    return NextResponse.json({ success: true })
  } catch (error) { return toErrorResponse(error) }
}
