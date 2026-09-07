import webpush from 'web-push'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { validSubscription } from './validation'

export function pushConfigured() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT)
}
export async function sendPush(row: { id: string; subscription: unknown }, payload: object) {
  if (!pushConfigured() || !validSubscription(row.subscription)) return false
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await webpush.sendNotification(row.subscription, JSON.stringify(payload), {
        vapidDetails: { subject: process.env.VAPID_SUBJECT!, publicKey: process.env.VAPID_PUBLIC_KEY!, privateKey: process.env.VAPID_PRIVATE_KEY! },
        TTL: 3600, timeout: 5000,
      })
      return true
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode
      if (status === 404 || status === 410) {
        await supabaseAdmin().from('push_subscriptions').delete().eq('id', row.id)
        return false
      }
      if (attempt === 0 && (!status || status >= 500)) continue
      // Never log endpoint URLs, encryption keys, or provider response bodies.
      console.warn('[push] delivery failed', status ?? 'network')
      return false
    }
  }
  return false
}
export async function notifyIncomingMessage(accountId: string, conversationId: string, messageId: string) {
  if (!pushConfigured()) return
  const db = supabaseAdmin()
  const { data: members, error: memberError } = await db.from('profiles').select('user_id').eq('account_id', accountId)
  if (memberError) throw new Error('Push member lookup failed')
  if (!members?.length) return
  const { data, error } = await db.from('push_subscriptions').select('id,subscription').eq('account_id', accountId).in('user_id', members.map(m => m.user_id))
  if (error) throw new Error('Push subscription lookup failed')
  for (const row of data ?? []) {
    await sendPush(row, { title: 'wacrm', body: 'New WhatsApp message', url: `/inbox?c=${encodeURIComponent(conversationId)}`, tag: messageId })
  }
}
