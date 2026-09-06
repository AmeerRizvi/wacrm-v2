import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveChannel(supabase: any, accountId: string, id?: string | null) {
  let query = supabase
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)

  if (id) {
    const { data, error } = await query.eq('id', id).maybeSingle()
    return { data, error }
  }

  const { data, error } = await query
    .order('is_primary', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(1)
  return { data: data?.[0] ?? null, error }
}

async function authenticatedContext() {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) return { error: 'Unauthorized' as const, status: 401, supabase }

  const accountId = await resolveAccountId(supabase, user.id)
  if (!accountId) {
    return {
      error: 'Your profile is not linked to an account.' as const,
      status: 403,
      supabase,
    }
  }

  return { supabase, user, accountId }
}

/**
 * GET /api/whatsapp/config
 *
 * - ?list=1 returns safe metadata for every channel in the account.
 * - ?id=<uuid> verifies a specific channel against Meta.
 * - no id preserves legacy behaviour by verifying the primary channel.
 */
export async function GET(request: Request) {
  try {
    const ctx = await authenticatedContext()
    if ('error' in ctx) {
      return NextResponse.json({ error: ctx.error }, { status: ctx.status })
    }
    const { supabase, accountId } = ctx
    const { searchParams } = new URL(request.url)

    if (searchParams.get('list') === '1') {
      const { data, error } = await supabase
        .from('whatsapp_config')
        .select(
          'id,label,phone_number_id,waba_id,status,is_primary,connected_at,registered_at,subscribed_apps_at,last_registration_error,mirror_inbound_media,created_at,updated_at',
        )
        .eq('account_id', accountId)
        .order('is_primary', { ascending: false })
        .order('created_at', { ascending: true })

      if (error) {
        console.error('[whatsapp/config GET list] DB error:', error)
        return NextResponse.json({ error: 'Failed to fetch channels' }, { status: 500 })
      }
      return NextResponse.json({ channels: data ?? [] })
    }

    const channelId = searchParams.get('id')
    const { data: config, error: configError } = await resolveChannel(
      supabase,
      accountId,
      channelId,
    )

    if (configError) {
      console.error('[whatsapp/config GET] DB error:', configError)
      return NextResponse.json(
        { connected: false, reason: 'db_error', message: 'Failed to fetch configuration' },
        { status: 200 },
      )
    }
    if (!config) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_config',
          message: channelId
            ? 'WhatsApp channel not found.'
            : 'No WhatsApp configuration saved yet.',
        },
        { status: 200 },
      )
    }

    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
    } catch (err) {
      console.error('[whatsapp/config GET] Token decryption failed:', err)
      return NextResponse.json(
        {
          connected: false,
          channel_id: config.id,
          reason: 'token_corrupted',
          needs_reset: true,
          message:
            'The stored access token cannot be decrypted with the current ENCRYPTION_KEY. Reset this channel and save it again.',
        },
        { status: 200 },
      )
    }

    try {
      const phoneInfo = await verifyPhoneNumber({
        phoneNumberId: config.phone_number_id,
        accessToken,
      })
      return NextResponse.json({
        connected: true,
        channel_id: config.id,
        label: config.label,
        is_primary: config.is_primary,
        phone_info: phoneInfo,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('[whatsapp/config GET] Meta verification failed:', message)
      return NextResponse.json(
        {
          connected: false,
          channel_id: config.id,
          reason: 'meta_api_error',
          message: `Meta API rejected the credentials: ${message}`,
        },
        { status: 200 },
      )
    }
  } catch (error) {
    console.error('[whatsapp/config GET] unexpected error:', error)
    return NextResponse.json(
      { connected: false, reason: 'unknown', message: 'Internal server error' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/whatsapp/config
 *
 * Create a new channel or update one channel when `id` is provided.
 * For an existing channel, access_token / verify_token may be left blank
 * to keep the encrypted value already stored in the database.
 */
export async function POST(request: Request) {
  try {
    const ctx = await authenticatedContext()
    if ('error' in ctx) {
      return NextResponse.json({ error: ctx.error }, { status: ctx.status })
    }
    const { supabase, user, accountId } = ctx
    const body = await request.json()
    const {
      id,
      label,
      phone_number_id,
      waba_id,
      access_token,
      verify_token,
      pin,
      is_primary,
      mirror_inbound_media,
    } = body as Record<string, unknown>

    if (typeof phone_number_id !== 'string' || !phone_number_id.trim()) {
      return NextResponse.json({ error: 'phone_number_id is required' }, { status: 400 })
    }
    if (pin !== undefined && pin !== null && pin !== '') {
      if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
        return NextResponse.json({ error: 'PIN must be exactly 6 digits.' }, { status: 400 })
      }
    }

    let existing: Record<string, unknown> | null = null
    if (typeof id === 'string' && id) {
      const { data, error } = await supabase
        .from('whatsapp_config')
        .select('*')
        .eq('account_id', accountId)
        .eq('id', id)
        .maybeSingle()
      if (error) return NextResponse.json({ error: 'Failed to load channel' }, { status: 500 })
      if (!data) return NextResponse.json({ error: 'WhatsApp channel not found' }, { status: 404 })
      existing = data as Record<string, unknown>
    }

    // One Meta phone_number_id can belong to only one channel globally.
    const { data: claimedRows, error: claimedError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('id,account_id')
      .eq('phone_number_id', phone_number_id.trim())
      .limit(2)

    if (claimedError) {
      console.error('[whatsapp/config POST] ownership lookup failed:', claimedError)
      return NextResponse.json({ error: 'Failed to validate configuration' }, { status: 500 })
    }
    const conflict = (claimedRows ?? []).find(
      (row: { id: string; account_id: string }) => row.account_id !== accountId || row.id !== existing?.id,
    )
    if (conflict) {
      return NextResponse.json(
        { error: 'This WhatsApp phone number is already linked to another channel.' },
        { status: 409 },
      )
    }

    let plainAccessToken: string
    let encryptedAccessToken: string
    try {
      if (typeof access_token === 'string' && access_token.trim()) {
        plainAccessToken = access_token.trim()
        encryptedAccessToken = encrypt(plainAccessToken)
      } else if (existing?.access_token && typeof existing.access_token === 'string') {
        encryptedAccessToken = existing.access_token
        plainAccessToken = decrypt(existing.access_token)
      } else {
        return NextResponse.json({ error: 'access_token is required for a new channel' }, { status: 400 })
      }
    } catch (err) {
      console.error('[whatsapp/config POST] access token encryption/decryption failed:', err)
      return NextResponse.json(
        { error: 'Failed to process access token. Check ENCRYPTION_KEY.' },
        { status: 500 },
      )
    }

    let encryptedVerifyToken: string | null = null
    try {
      encryptedVerifyToken =
        typeof verify_token === 'string' && verify_token.trim()
          ? encrypt(verify_token.trim())
          : (existing?.verify_token as string | null | undefined) ?? null
    } catch (err) {
      console.error('[whatsapp/config POST] verify token encryption failed:', err)
      return NextResponse.json({ error: 'Failed to encrypt verify token.' }, { status: 500 })
    }

    let phoneInfo
    try {
      phoneInfo = await verifyPhoneNumber({
        phoneNumberId: phone_number_id.trim(),
        accessToken: plainAccessToken,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      return NextResponse.json({ error: `Meta API error: ${message}` }, { status: 400 })
    }

    const sameRegisteredNumber =
      existing?.phone_number_id === phone_number_id.trim() && existing?.registered_at != null
    let registeredAt = (existing?.registered_at as string | null | undefined) ?? null
    let registrationError: string | null = null
    let registrationSkipped = false
    const hasPin = typeof pin === 'string' && pin.length > 0

    if (!sameRegisteredNumber || hasPin) {
      if (!hasPin) {
        registrationSkipped = true
        if (!sameRegisteredNumber) registeredAt = null
      } else {
        try {
          await registerPhoneNumber({
            phoneNumberId: phone_number_id.trim(),
            accessToken: plainAccessToken,
            pin,
          })
          registeredAt = new Date().toISOString()
        } catch (err) {
          registrationError = err instanceof Error ? err.message : 'Unknown Meta API error'
          registeredAt = null
        }
      }
    }

    let subscribedAppsAt = (existing?.subscribed_apps_at as string | null | undefined) ?? null
    if (typeof waba_id === 'string' && waba_id.trim()) {
      try {
        await subscribeWabaToApp({ wabaId: waba_id.trim(), accessToken: plainAccessToken })
        subscribedAppsAt = new Date().toISOString()
      } catch (err) {
        console.warn(
          '[whatsapp/config POST] WABA subscribed_apps failed (non-fatal):',
          err instanceof Error ? err.message : err,
        )
      }
    }

    const { count } = await supabase
      .from('whatsapp_config')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
    const shouldBePrimary = existing?.is_primary === true || count === 0 || is_primary === true

    const displayPhone =
      phoneInfo && typeof phoneInfo === 'object' && 'display_phone_number' in phoneInfo
        ? String((phoneInfo as { display_phone_number?: unknown }).display_phone_number ?? '')
        : ''
    const baseRow = {
      phone_number_id: phone_number_id.trim(),
      waba_id: typeof waba_id === 'string' && waba_id.trim() ? waba_id.trim() : null,
      label:
        typeof label === 'string' && label.trim()
          ? label.trim()
          : ((existing?.label as string | undefined) || displayPhone || phone_number_id.trim()),
      access_token: encryptedAccessToken,
      verify_token: encryptedVerifyToken,
      status: registrationError ? 'disconnected' : 'connected',
      connected_at: registrationError ? null : new Date().toISOString(),
      registered_at: registrationError ? null : registeredAt,
      subscribed_apps_at: subscribedAppsAt,
      last_registration_error: registrationError,
      mirror_inbound_media:
        typeof mirror_inbound_media === 'boolean'
          ? mirror_inbound_media
          : (existing?.mirror_inbound_media as boolean | undefined) ?? true,
      updated_at: new Date().toISOString(),
    }

    let channelId: string
    if (existing) {
      const { data, error } = await supabase
        .from('whatsapp_config')
        .update(baseRow)
        .eq('account_id', accountId)
        .eq('id', existing.id as string)
        .select('id')
        .single()
      if (error || !data) {
        console.error('[whatsapp/config POST] update failed:', error)
        return NextResponse.json({ error: 'Failed to update configuration' }, { status: 500 })
      }
      channelId = data.id
    } else {
      const { data, error } = await supabase
        .from('whatsapp_config')
        .insert({ account_id: accountId, user_id: user.id, is_primary: false, ...baseRow })
        .select('id')
        .single()
      if (error || !data) {
        console.error('[whatsapp/config POST] insert failed:', error)
        return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
      }
      channelId = data.id
    }

    if (shouldBePrimary) {
      // Partial unique index guarantees one primary. Demote first, then promote.
      await supabase
        .from('whatsapp_config')
        .update({ is_primary: false })
        .eq('account_id', accountId)
        .neq('id', channelId)
      const { error: primaryError } = await supabase
        .from('whatsapp_config')
        .update({ is_primary: true })
        .eq('account_id', accountId)
        .eq('id', channelId)
      if (primaryError) {
        console.error('[whatsapp/config POST] primary update failed:', primaryError)
      }
    }

    return NextResponse.json({
      success: registrationError == null,
      saved: true,
      channel_id: channelId,
      registered: registeredAt != null,
      registration_skipped: registrationSkipped,
      registration_error: registrationError,
      phone_info: phoneInfo,
    })
  } catch (error) {
    console.error('[whatsapp/config POST] unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/** Lightweight metadata edits that do not require Meta credentials. */
export async function PATCH(request: Request) {
  try {
    const ctx = await authenticatedContext()
    if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })
    const { supabase, accountId } = ctx
    const body = (await request.json()) as {
      id?: string
      label?: string
      is_primary?: boolean
      mirror_inbound_media?: boolean
    }
    if (!body.id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    const { data: channel } = await supabase
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', accountId)
      .eq('id', body.id)
      .maybeSingle()
    if (!channel) return NextResponse.json({ error: 'WhatsApp channel not found' }, { status: 404 })

    if (body.is_primary === true) {
      await supabase
        .from('whatsapp_config')
        .update({ is_primary: false })
        .eq('account_id', accountId)
        .neq('id', body.id)
    }

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (typeof body.label === 'string' && body.label.trim()) update.label = body.label.trim()
    if (body.is_primary === true) update.is_primary = true
    if (typeof body.mirror_inbound_media === 'boolean') {
      update.mirror_inbound_media = body.mirror_inbound_media
    }

    const { error } = await supabase
      .from('whatsapp_config')
      .update(update)
      .eq('account_id', accountId)
      .eq('id', body.id)
    if (error) return NextResponse.json({ error: 'Failed to update channel' }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[whatsapp/config PATCH] unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/** Delete one channel. Legacy no-id calls delete the current primary channel only. */
export async function DELETE(request: Request) {
  try {
    const ctx = await authenticatedContext()
    if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })
    const { supabase, accountId } = ctx
    const id = new URL(request.url).searchParams.get('id')
    const { data: channel, error: loadError } = await resolveChannel(supabase, accountId, id)
    if (loadError) return NextResponse.json({ error: 'Failed to load channel' }, { status: 500 })
    if (!channel) return NextResponse.json({ error: 'WhatsApp channel not found' }, { status: 404 })

    const wasPrimary = channel.is_primary === true
    const { error: deleteError } = await supabase
      .from('whatsapp_config')
      .delete()
      .eq('account_id', accountId)
      .eq('id', channel.id)
    if (deleteError) {
      console.error('[whatsapp/config DELETE] delete failed:', deleteError)
      return NextResponse.json({ error: 'Failed to delete configuration' }, { status: 500 })
    }

    if (wasPrimary) {
      const { data: remaining } = await supabase
        .from('whatsapp_config')
        .select('id')
        .eq('account_id', accountId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (remaining?.[0]) {
        await supabase
          .from('whatsapp_config')
          .update({ is_primary: true })
          .eq('account_id', accountId)
          .eq('id', remaining[0].id)
      }
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[whatsapp/config DELETE] unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
