'use client'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'

export function PushNotifications() {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null)
  const [subscription, setSubscription] = useState<PushSubscription | null>(null)
  const [publicKey, setPublicKey] = useState<string | null>(null)
  const [status, setStatus] = useState('Checking notification support…')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let cancelled = false
    async function load() {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        setStatus('On iPhone, use iOS 16.4 or later and open wacrm from your Home Screen. Add it using Safari → Share → Add to Home Screen.')
        return
      }
      try {
        const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
        await navigator.serviceWorker.ready
        const sub = await reg.pushManager.getSubscription()
        const response = await fetch('/api/push')
        if (!response.ok) throw new Error('Could not load notification settings')
        const config = await response.json()
        if (cancelled) return
        setRegistration(reg); setSubscription(sub); setPublicKey(config.publicKey)
        setStatus(!config.publicKey ? 'Notifications need server configuration before they can be enabled.' : sub ? 'This browser has a subscription. Enable again to sync it with your account, or send a test.' : 'Enable alerts for incoming messages across your WhatsApp numbers.')
      } catch (error) { if (!cancelled) setStatus(error instanceof Error ? error.message : 'Could not load notifications') }
    }
    void load()
    return () => { cancelled = true }
  }, [])
  async function action(kind: 'enable' | 'disable' | 'test') {
    setBusy(true)
    try {
      let sub = subscription
      if (kind === 'enable') {
        // Permission is requested directly from this button gesture (required on iOS).
        if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications are blocked. Allow them in your device notification settings.')
        if (!registration || !publicKey) throw new Error('Notifications are not ready yet')
        const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
        sub = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
        setSubscription(sub)
      }
      if (!sub) throw new Error('Enable notifications first')
      const response = await fetch('/api/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: kind, endpoint: sub.endpoint, subscription: sub.toJSON() }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not update notifications')
      if (kind === 'disable') { await sub.unsubscribe(); setSubscription(null) }
      setStatus(kind === 'test' ? 'Test sent. Check your notifications.' : kind === 'enable' ? 'Notifications enabled on this device.' : 'Notifications disabled on this device.')
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Notification request failed') }
    finally { setBusy(false) }
  }
  return <section className="mt-6 rounded-xl border bg-card p-6 space-y-4">
    <h2 className="text-lg font-semibold">Device notifications</h2>
    <p className="text-sm text-muted-foreground">Get a private “New WhatsApp message” alert, even when wacrm is closed. Tap it to open the conversation. Disable here before sharing this device.</p>
    <p role="status" className="text-sm">{status}</p>
    <div className="flex flex-wrap gap-2">
      <Button disabled={busy || !registration || !publicKey} onClick={() => void action('enable')}>Enable on this device</Button>
      {subscription && <><Button variant="outline" disabled={busy} onClick={() => void action('test')}>Send test notification</Button><Button variant="outline" disabled={busy} onClick={() => void action('disable')}>Disable</Button></>}
    </div>
  </section>
}
