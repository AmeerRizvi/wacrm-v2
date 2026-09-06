import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder'
import { resolveTemplateRow } from '@/lib/whatsapp/template-body'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

interface BroadcastResult {
  phone: string
  status: 'sent' | 'failed'
  whatsapp_message_id?: string
  error?: string
}

interface NewRecipient {
  phone: string
  params?: string[]
  messageParams?: SendTimeParams
}

type ChannelConfig = {
  id: string
  phone_number_id: string
  access_token: string
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const limit = checkRateLimit(`broadcast:${userId}`, RATE_LIMITS.broadcast)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json()
    const {
      recipients: newRecipients,
      phone_numbers,
      template_name,
      template_language,
      template_params,
      whatsapp_config_id,
      channel_id,
    } = body

    let recipients: NewRecipient[]
    if (Array.isArray(newRecipients) && newRecipients.length > 0) {
      recipients = newRecipients
    } else if (Array.isArray(phone_numbers) && phone_numbers.length > 0) {
      const shared: string[] = Array.isArray(template_params) ? template_params : []
      recipients = phone_numbers.map((phone: string) => ({ phone, params: shared }))
    } else {
      return NextResponse.json(
        { error: 'Provide either `recipients` or `phone_numbers` as a non-empty array' },
        { status: 400 },
      )
    }

    if (!template_name) {
      return NextResponse.json({ error: 'template_name is required' }, { status: 400 })
    }

    let requestedChannelId =
      typeof whatsapp_config_id === 'string' && whatsapp_config_id
        ? whatsapp_config_id
        : typeof channel_id === 'string' && channel_id
          ? channel_id
          : null

    // Legacy callers may omit channel_id. That is safe only when this exact
    // template resolves to ONE WhatsApp channel. If the same name/language is
    // present on multiple numbers/WABAs, guessing a primary can send a campaign
    // from the wrong number, so force the caller to disambiguate instead.
    if (!requestedChannelId) {
      const { data: templateCandidates, error: candidateError } = await supabase
        .from('message_templates')
        .select('whatsapp_config_id')
        .eq('account_id', accountId)
        .eq('name', template_name)
        .eq('language', template_language || 'en_US')
        .not('whatsapp_config_id', 'is', null)

      if (candidateError) {
        return NextResponse.json(
          { error: 'Failed to resolve template WhatsApp channel' },
          { status: 500 },
        )
      }

      const candidateChannelIds = [
        ...new Set(
          (templateCandidates ?? [])
            .map((row) => row.whatsapp_config_id as string | null)
            .filter((id): id is string => Boolean(id)),
        ),
      ]

      if (candidateChannelIds.length > 1) {
        return NextResponse.json(
          {
            error:
              'This template is available on multiple WhatsApp channels. Specify `channel_id` (or `whatsapp_config_id`) explicitly.',
            code: 'ambiguous_whatsapp_channel',
            channel_ids: candidateChannelIds,
          },
          { status: 409 },
        )
      }

      if (candidateChannelIds.length === 1) {
        requestedChannelId = candidateChannelIds[0]
      }
    }

    let config: ChannelConfig | null = null
    if (requestedChannelId) {
      const result = await supabase
        .from('whatsapp_config')
        .select('id,phone_number_id,access_token')
        .eq('account_id', accountId)
        .eq('id', requestedChannelId)
        .maybeSingle()
      config = result.data as ChannelConfig | null
      if (result.error || !config) {
        return NextResponse.json({ error: 'WhatsApp channel not found' }, { status: 404 })
      }
    } else {
      // No local template row exists yet (for example a legacy install before
      // first sync), so preserve the historical primary-channel fallback.
      const result = await supabase
        .from('whatsapp_config')
        .select('id,phone_number_id,access_token')
        .eq('account_id', accountId)
        .order('is_primary', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(1)
      config = (result.data?.[0] as ChannelConfig | undefined) ?? null
      if (result.error || !config) {
        return NextResponse.json(
          { error: 'WhatsApp not configured. Connect a channel first.' },
          { status: 400 },
        )
      }
    }

    const accessToken = decrypt(config.access_token)
    const resolvedTemplate = await resolveTemplateRow(
      supabase,
      accountId,
      template_name,
      template_language,
      config.id,
    )
    if (resolvedTemplate.malformed) {
      return NextResponse.json(
        {
          error:
            'Template row is malformed locally — sync this channel from Meta before broadcasting.',
        },
        { status: 500 },
      )
    }

    const results: BroadcastResult[] = []
    let sentCount = 0
    let failedCount = 0

    for (const recipient of recipients) {
      const sanitized = sanitizePhoneForMeta(recipient.phone)
      if (!isValidE164(sanitized)) {
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: 'Invalid phone number format',
        })
        failedCount++
        continue
      }

      let sentMessageId: string | null = null
      let lastError: string | null = null
      for (const variant of phoneVariants(sanitized)) {
        try {
          const result = await sendTemplateMessage({
            phoneNumberId: config.phone_number_id,
            accessToken,
            to: variant,
            templateName: template_name,
            language: resolvedTemplate.language,
            template: resolvedTemplate.row ?? undefined,
            messageParams: recipient.messageParams,
            params: recipient.params ?? [],
          })
          sentMessageId = result.messageId
          lastError = null
          break
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error'
          lastError = message
          if (!isRecipientNotAllowedError(message)) break
        }
      }

      if (sentMessageId) {
        results.push({
          phone: recipient.phone,
          status: 'sent',
          whatsapp_message_id: sentMessageId,
        })
        sentCount++
      } else {
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: lastError || 'Unknown error',
        })
        failedCount++
      }
    }

    return NextResponse.json({
      success: true,
      channel_id: config.id,
      total: recipients.length,
      sent: sentCount,
      failed: failedCount,
      results,
    })
  } catch (error) {
    console.error('Error in WhatsApp broadcast POST:', error)
    return toErrorResponse(error)
  }
}
