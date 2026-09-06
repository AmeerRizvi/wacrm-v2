import { NextResponse } from 'next/server'
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { normalizeStatus } from '@/lib/whatsapp/template-status-normalize'
import type { TemplateButton, TemplateSampleValues } from '@/types'

const META_API_VERSION = 'v21.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

interface MetaButton {
  type: string
  text: string
  url?: string
  phone_number?: string
  example?: string[] | string
}
interface MetaTemplateComponent {
  type: string
  text?: string
  format?: string
  buttons?: MetaButton[]
  example?: { header_text?: string[]; header_handle?: string[]; body_text?: string[][] }
}
interface MetaTemplate {
  id: string
  name: string
  language: string
  status: string
  category: string
  components?: MetaTemplateComponent[]
  quality_score?: { score?: string } | string
}

function normalizeCategory(meta: string): 'Marketing' | 'Utility' | 'Authentication' {
  const upper = meta.toUpperCase()
  if (upper === 'UTILITY') return 'Utility'
  if (upper === 'AUTHENTICATION') return 'Authentication'
  return 'Marketing'
}

function normalizeQualityScore(raw: MetaTemplate['quality_score']): 'GREEN' | 'YELLOW' | 'RED' | null {
  const score = typeof raw === 'string' ? raw : raw?.score ? String(raw.score) : null
  if (!score) return null
  const upper = score.toUpperCase()
  return ['GREEN', 'YELLOW', 'RED'].includes(upper) ? (upper as 'GREEN' | 'YELLOW' | 'RED') : null
}

function parseButtons(metaButtons: MetaButton[] | undefined): TemplateButton[] {
  if (!metaButtons?.length) return []
  const out: TemplateButton[] = []
  for (const b of metaButtons) {
    switch (b.type?.toUpperCase()) {
      case 'QUICK_REPLY':
        out.push({ type: 'QUICK_REPLY', text: b.text })
        break
      case 'URL':
        out.push({
          type: 'URL',
          text: b.text,
          url: b.url ?? '',
          example: Array.isArray(b.example) ? b.example[0] : b.example,
        })
        break
      case 'PHONE_NUMBER':
        out.push({ type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone_number ?? '' })
        break
      case 'COPY_CODE':
        out.push({
          type: 'COPY_CODE',
          text: b.text,
          example: Array.isArray(b.example) ? b.example[0] ?? '' : b.example ?? '',
        })
        break
    }
  }
  return out
}

function extractSampleValues(
  body: MetaTemplateComponent | undefined,
  header: MetaTemplateComponent | undefined,
): TemplateSampleValues | null {
  const bodySample = body?.example?.body_text?.[0]
  const headerSample = header?.example?.header_text
  if (!bodySample?.length && !headerSample?.length) return null
  const sv: TemplateSampleValues = {}
  if (bodySample?.length) sv.body = bodySample
  if (headerSample?.length) sv.header = headerSample
  return sv
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const requestedChannelId = new URL(request.url).searchParams.get('channel_id')

    let config
    if (requestedChannelId) {
      const result = await supabase
        .from('whatsapp_config')
        .select('*')
        .eq('account_id', accountId)
        .eq('id', requestedChannelId)
        .maybeSingle()
      config = result.data
      if (result.error || !config) {
        return NextResponse.json({ error: 'WhatsApp channel not found.' }, { status: 404 })
      }
    } else {
      const result = await supabase
        .from('whatsapp_config')
        .select('*')
        .eq('account_id', accountId)
        .order('is_primary', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(1)
      config = result.data?.[0]
      if (result.error || !config) {
        return NextResponse.json(
          { error: 'WhatsApp not configured. Connect a channel first.' },
          { status: 400 },
        )
      }
    }

    if (!config.waba_id) {
      return NextResponse.json({ error: 'WABA ID missing for this channel.' }, { status: 400 })
    }
    const accessToken = decrypt(config.access_token)

    // Meta templates live on the WABA, not an individual phone number. Keep a
    // local copy per phone channel for deterministic sending, but synchronize
    // every sibling channel in this account that points at the same WABA.
    const { data: siblingChannels, error: siblingError } = await supabase
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', accountId)
      .eq('waba_id', config.waba_id)
      .order('created_at', { ascending: true })
    if (siblingError) {
      return NextResponse.json({ error: 'Failed to resolve WABA channels.' }, { status: 500 })
    }
    const channelIds = (siblingChannels ?? []).map((row) => row.id as string)
    if (!channelIds.includes(config.id)) channelIds.push(config.id)

    const metaTemplates: MetaTemplate[] = []
    let nextUrl: string | null = `${META_API_BASE}/${config.waba_id}/message_templates?limit=100&fields=id,name,language,status,category,components,quality_score`
    const PAGE_CAP = 20
    let pageCount = 0
    while (nextUrl && pageCount < PAGE_CAP) {
      pageCount++
      const metaRes: Response = await fetch(nextUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!metaRes.ok) {
        let metaErr = `Meta API error: ${metaRes.status}`
        try {
          const body = await metaRes.json()
          if (body?.error?.message) metaErr = body.error.message
        } catch {
          // Keep the HTTP status fallback.
        }
        return NextResponse.json({ error: metaErr }, { status: 502 })
      }
      const metaBody: { data?: MetaTemplate[]; paging?: { next?: string } } = await metaRes.json()
      if (metaBody.data) metaTemplates.push(...metaBody.data)
      nextUrl = metaBody.paging?.next ?? null
    }

    let inserted = 0
    let updated = 0
    const errors: { channel_id: string; name: string; language: string; message: string }[] = []

    for (const t of metaTemplates) {
      const body = (t.components ?? []).find((c) => c.type === 'BODY')
      const header = (t.components ?? []).find((c) => c.type === 'HEADER')
      const footer = (t.components ?? []).find((c) => c.type === 'FOOTER')
      const buttons = (t.components ?? []).find((c) => c.type === 'BUTTONS')
      const parsedButtons = parseButtons(buttons?.buttons)
      const sampleValues = extractSampleValues(body, header)
      const headerFormat = header?.format?.toUpperCase()
      const headerType = ['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerFormat ?? '')
        ? headerFormat!.toLowerCase()
        : null

      for (const channelId of channelIds) {
        const row = {
          account_id: accountId,
          user_id: userId,
          whatsapp_config_id: channelId,
          name: t.name,
          category: normalizeCategory(t.category),
          language: t.language,
          header_type: headerType,
          header_content: header?.text ?? null,
          header_handle: header?.example?.header_handle?.[0] ?? null,
          body_text: body?.text ?? '',
          footer_text: footer?.text ?? null,
          buttons: parsedButtons.length ? parsedButtons : null,
          sample_values: sampleValues,
          status: normalizeStatus(t.status),
          meta_template_id: t.id,
          quality_score: normalizeQualityScore(t.quality_score),
          updated_at: new Date().toISOString(),
        }

        const { data: existing, error: lookupErr } = await supabase
          .from('message_templates')
          .select('id')
          .eq('whatsapp_config_id', channelId)
          .eq('name', t.name)
          .eq('language', t.language)
          .maybeSingle()
        if (lookupErr) {
          errors.push({ channel_id: channelId, name: t.name, language: t.language, message: lookupErr.message })
          continue
        }

        if (existing?.id) {
          const { error } = await supabase.from('message_templates').update(row).eq('id', existing.id)
          if (error) {
            errors.push({ channel_id: channelId, name: t.name, language: t.language, message: error.message })
          } else {
            updated++
          }
        } else {
          const { error } = await supabase.from('message_templates').insert(row)
          if (error) {
            errors.push({ channel_id: channelId, name: t.name, language: t.language, message: error.message })
          } else {
            inserted++
          }
        }
      }
    }

    return NextResponse.json({
      success: errors.length === 0,
      channel_id: config.id,
      waba_id: config.waba_id,
      channel_ids: channelIds,
      channels_synced: channelIds.length,
      total: metaTemplates.length,
      inserted,
      updated,
      errors,
      truncated: pageCount >= PAGE_CAP && nextUrl !== null,
    })
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return toErrorResponse(error)
    }
    console.error('Error syncing WhatsApp templates:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to sync templates' },
      { status: 500 },
    )
  }
}
