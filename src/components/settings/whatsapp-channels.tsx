'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

type Channel = {
  id: string
  label: string | null
  phone_number_id: string
  waba_id: string | null
  status: string
  is_primary: boolean
  connected_at: string | null
  registered_at: string | null
  mirror_inbound_media: boolean
}

type FormState = {
  id?: string
  label: string
  phone_number_id: string
  waba_id: string
  access_token: string
  verify_token: string
  pin: string
}

const EMPTY: FormState = {
  label: '',
  phone_number_id: '',
  waba_id: '',
  access_token: '',
  verify_token: '',
  pin: '',
}

export function WhatsAppChannels() {
  const [channels, setChannels] = useState<Channel[]>([])
  const [form, setForm] = useState<FormState>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const selected = useMemo(
    () => channels.find((channel) => channel.id === form.id) ?? null,
    [channels, form.id],
  )

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/whatsapp/config?list=1', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to load WhatsApp channels')
      setChannels(json.channels ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load WhatsApp channels')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const edit = (channel: Channel) => {
    setNotice(null)
    setError(null)
    setForm({
      id: channel.id,
      label: channel.label ?? '',
      phone_number_id: channel.phone_number_id,
      waba_id: channel.waba_id ?? '',
      access_token: '',
      verify_token: '',
      pin: '',
    })
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const res = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to save WhatsApp channel')
      setNotice(json.registration_error ? `Saved, but registration failed: ${json.registration_error}` : 'WhatsApp channel saved.')
      setForm(EMPTY)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save WhatsApp channel')
    } finally {
      setSaving(false)
    }
  }

  const patch = async (id: string, data: Record<string, unknown>) => {
    setError(null)
    const res = await fetch('/api/whatsapp/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...data }),
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error || 'Failed to update channel')
    await load()
  }

  const test = async (id: string) => {
    setNotice(null)
    setError(null)
    try {
      const res = await fetch(`/api/whatsapp/config?id=${encodeURIComponent(id)}`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok || !json.connected) throw new Error(json.message || json.error || 'Connection test failed')
      setNotice(`Connection verified${json.phone_info?.display_phone_number ? `: ${json.phone_info.display_phone_number}` : ''}.`)
    } catch (e) { setError(e instanceof Error ? e.message : 'Connection test failed') }
  }

  const remove = async (channel: Channel) => {
    if (!window.confirm(`Remove ${channel.label || channel.phone_number_id}? Existing channel history must be moved or deleted first.`)) return
    setError(null)
    setNotice(null)
    try {
      const res = await fetch(`/api/whatsapp/config?id=${encodeURIComponent(channel.id)}`, { method: 'DELETE' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to remove channel')
      if (form.id === channel.id) setForm(EMPTY)
      setNotice('WhatsApp channel removed.')
      await load()
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to remove channel') }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">WhatsApp channels</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect multiple WhatsApp Business numbers to this workspace. Each conversation stays permanently bound to the number that received it.
        </p>
      </div>

      {notice && <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">{notice}</div>}
      {error && <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

      <div className="grid gap-3">
        {loading ? <p className="text-sm text-muted-foreground">Loading channels…</p> : channels.length === 0 ? (
          <div className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">No WhatsApp numbers connected yet.</div>
        ) : channels.map((channel) => (
          <div key={channel.id} className="flex flex-col gap-3 rounded-lg border bg-card p-4 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-foreground">{channel.label || channel.phone_number_id}</span>
                {channel.is_primary && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">Primary</span>}
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{channel.status}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Phone number ID: {channel.phone_number_id}{channel.waba_id ? ` · WABA: ${channel.waba_id}` : ''}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" onClick={() => void test(channel.id)}>Test</button>
              <button className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" onClick={() => edit(channel)}>Edit</button>
              {!channel.is_primary && <button className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" onClick={() => void patch(channel.id, { is_primary: true }).catch((e) => setError(e.message))}>Make primary</button>}
              <button className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" onClick={() => void patch(channel.id, { mirror_inbound_media: !channel.mirror_inbound_media }).catch((e) => setError(e.message))}>{channel.mirror_inbound_media ? 'Media mirror on' : 'Media mirror off'}</button>
              <button className="rounded-md border border-destructive/30 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10" onClick={() => void remove(channel)}>Remove</button>
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-lg border bg-card p-5">
        <div className="mb-4 flex items-center justify-between gap-4">
          <div>
            <h3 className="font-medium text-foreground">{selected ? `Edit ${selected.label || selected.phone_number_id}` : 'Add WhatsApp number'}</h3>
            <p className="text-xs text-muted-foreground">Tokens are encrypted at rest. Leave token fields blank while editing to keep the saved values.</p>
          </div>
          {selected && <button className="text-sm text-muted-foreground hover:text-foreground" onClick={() => setForm(EMPTY)}>Cancel edit</button>}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Channel name" value={form.label} placeholder="Sales UAE" onChange={(value) => setForm((f) => ({ ...f, label: value }))} />
          <Field label="Phone Number ID" value={form.phone_number_id} onChange={(value) => setForm((f) => ({ ...f, phone_number_id: value }))} />
          <Field label="WABA ID" value={form.waba_id} onChange={(value) => setForm((f) => ({ ...f, waba_id: value }))} />
          <Field label={selected ? 'Access token (leave blank to keep)' : 'Access token'} type="password" value={form.access_token} onChange={(value) => setForm((f) => ({ ...f, access_token: value }))} />
          <Field label={selected ? 'Verify token (leave blank to keep)' : 'Verify token'} type="password" value={form.verify_token} onChange={(value) => setForm((f) => ({ ...f, verify_token: value }))} />
          <Field label="6-digit registration PIN (optional)" type="password" value={form.pin} onChange={(value) => setForm((f) => ({ ...f, pin: value.replace(/\D/g, '').slice(0, 6) }))} />
        </div>

        <button disabled={saving || !form.phone_number_id || (!selected && !form.access_token)} onClick={() => void save()} className="mt-5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50">
          {saving ? 'Saving…' : selected ? 'Update channel' : 'Add channel'}
        </button>
      </div>
    </div>
  )
}

function Field({ label, value, onChange, placeholder, type = 'text' }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: string }) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium text-foreground">{label}</span>
      <input type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className="h-10 rounded-md border bg-background px-3 text-foreground outline-none focus:ring-2 focus:ring-ring" />
    </label>
  )
}
