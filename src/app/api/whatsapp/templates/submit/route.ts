import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { submitMessageTemplate } from '@/lib/whatsapp/meta-api'
import { validateTemplatePayload, type TemplatePayload } from '@/lib/whatsapp/template-validators'
import { buildMetaTemplatePayload } from '@/lib/whatsapp/template-components'
import { ensureImageHeaderHandle } from '@/lib/whatsapp/template-header-handle'
import { normalizeStatus } from '@/lib/whatsapp/template-status-normalize'

type ChannelConfig = { id: string; waba_id: string | null; access_token: string }

function buildUpsertRow(
  accountId: string,
  userId: string,
  channelId: string,
  payload: TemplatePayload,
  extras: { status: 'DRAFT' | string; metaTemplateId: string | null; submissionError: string | null },
) {
  return {
    account_id: accountId,
    user_id: userId,
    whatsapp_config_id: channelId,
    name: payload.name,
    category: payload.category,
    language: payload.language,
    header_type: payload.header_type ?? null,
    header_content: payload.header_content ?? null,
    header_media_url: payload.header_media_url ?? null,
    header_handle: payload.header_handle ?? null,
    body_text: payload.body_text,
    footer_text: payload.footer_text ?? null,
    buttons: payload.buttons ?? null,
    sample_values: payload.sample_values ?? null,
    status: extras.status,
    meta_template_id: extras.metaTemplateId,
    submission_error: extras.submissionError,
    rejection_reason: null,
    last_submitted_at: new Date().toISOString(),
  }
}

async function upsertTemplateRow(
  supabase: SupabaseClient,
  channelId: string,
  row: ReturnType<typeof buildUpsertRow>,
) {
  const { data: existing, error: lookupError } = await supabase
    .from('message_templates')
    .select('id')
    .eq('whatsapp_config_id', channelId)
    .eq('name', row.name)
    .eq('language', row.language)
    .maybeSingle()
  if (lookupError) return { data: null, error: lookupError }
  if (existing?.id) {
    return supabase.from('message_templates').update(row).eq('id', existing.id).select().single()
  }
  return supabase.from('message_templates').insert(row).select().single()
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    let payload: TemplatePayload & { channel_id?: string; whatsapp_config_id?: string }
    try { payload = (await request.json()) as TemplatePayload & { channel_id?: string; whatsapp_config_id?: string } }
    catch { return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 }) }

    if (payload.category === 'Authentication') {
      return NextResponse.json({ error: 'AUTHENTICATION templates are not yet supported here — create them in Meta WhatsApp Manager and sync them.' }, { status: 400 })
    }
    try { validateTemplatePayload(payload) }
    catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'Validation failed.' }, { status: 400 }) }

    const requestedChannelId = payload.channel_id || payload.whatsapp_config_id || null
    let config: ChannelConfig | null = null
    if (requestedChannelId) {
      const result = await supabase.from('whatsapp_config').select('id,waba_id,access_token').eq('account_id', accountId).eq('id', requestedChannelId).maybeSingle()
      config = result.data as ChannelConfig | null
      if (result.error || !config) return NextResponse.json({ error: 'WhatsApp channel not found.' }, { status: 404 })
    } else {
      const result = await supabase.from('whatsapp_config').select('id,waba_id,access_token').eq('account_id', accountId).order('is_primary', { ascending: false }).order('created_at', { ascending: true }).limit(1)
      config = (result.data?.[0] as ChannelConfig | undefined) ?? null
      if (result.error || !config) return NextResponse.json({ error: 'WhatsApp not configured. Connect a channel first.' }, { status: 400 })
    }

    const dryRun = process.env.WHATSAPP_TEMPLATES_DRY_RUN === 'true' || process.env.WHATSAPP_TEMPLATES_DRY_RUN === '1'
    let metaTemplateId: string
    let metaStatus: string

    if (dryRun) {
      metaTemplateId = `dry-run-${crypto.randomUUID()}`
      metaStatus = 'PENDING'
    } else {
      if (!config.waba_id) return NextResponse.json({ error: 'WABA ID missing for this WhatsApp channel.' }, { status: 400 })
      const accessToken = decrypt(config.access_token)
      try { await ensureImageHeaderHandle(payload, accessToken) }
      catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'Header image upload failed.' }, { status: 400 }) }
      const metaPayload = buildMetaTemplatePayload(payload)
      try {
        const meta = await submitMessageTemplate({ wabaId: config.waba_id, accessToken, payload: metaPayload })
        metaTemplateId = meta.id
        metaStatus = meta.status
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Meta submit failed.'
        await upsertTemplateRow(supabase, config.id, buildUpsertRow(accountId, userId, config.id, payload, { status: 'DRAFT', metaTemplateId: null, submissionError: message }))
        const isRateLimit = /\b429\b/.test(message)
        return NextResponse.json({ error: isRateLimit ? 'Meta rate limit hit (100 template creates per hour). Try again later.' : message }, { status: isRateLimit ? 429 : 502 })
      }
    }

    const { data: row, error } = await upsertTemplateRow(
      supabase,
      config.id,
      buildUpsertRow(accountId, userId, config.id, payload, {
        status: normalizeStatus(metaStatus),
        metaTemplateId,
        submissionError: null,
      }),
    )
    if (error) return NextResponse.json({ error: `Submitted to Meta but failed to save locally: ${error.message}. Sync from Meta to recover.`, meta_template_id: metaTemplateId }, { status: 500 })

    return NextResponse.json({ success: true, channel_id: config.id, template: row, dry_run: dryRun })
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) return toErrorResponse(error)
    console.error('Error submitting template:', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to submit template.' }, { status: 500 })
  }
}