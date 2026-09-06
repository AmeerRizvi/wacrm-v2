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
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

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

    const requestedChannelId =
      typeof whatsapp_config_id === 'string' && whatsapp_config_id
        ? whatsapp_config_id
        : typeof channel_id === 'string' && channel_id
          ? channel_id
          : null

    let configQuery = supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)

    let config: Record<string, unknown> | null = null
    if (requestedChannelId) {
      const { data, error } = await configQuery.eq('id', requestedChannelId).maybeSingle()
      if (error || !data) {
        return NextResponse.json({ error: 'WhatsApp channel not found' }, { status: 404 })
      }
      config = data
    } else {
      const { data, error } = await configQuery
        .order('is_primary', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(1)
      if (error || !data?.[0]) {
        return NextResponse.json(
          { error: 'WhatsApp not configured. Please connect a WhatsApp channel first.' },
          { status: 400 },
        )
      }
      config = data[0]
    }

    const configId = String(config.id)
    const accessToken = decrypt(String(config.access_token))
    const resolvedTemplate = await resolveTemplateRow(
      supabase,
      accountId,
      template_name,
      template_language,
      configId,
    )
    if (resolvedTemplate.malformed) {
      return NextResponse.json(
        { error: 'Template row is malformed locally — sync this channel from Meta before broadcasting.' },
        { status: 500 },
      )
    }
    const templateRow = resolvedTemplate.row

    const results: BroadcastResult[] = []
    let sentCount = 0
    let failedCount = 0

    for (const recipient of recipients) {
      const sanitized = sanitizePhoneForMeta(recipient.phone)
      if (!isValidE164(sanitized)) {
        results.push({ phone: recipient.phone, status: 'failed', error: 'Invalid phone number format' })
        failedCount++
        continue
      }

      let sentMessageId: string | null = null
      let lastError: string | null = null
      for (const variant of phoneVariants(sanitized)) {
        try {
          const result = await sendTemplateMessage({
            phoneNumberId: String(config.phone_number_id),
            accessToken,
            to: variant,
            templateName: template_name,
            language: resolvedTemplate.language,
            template: templateRow ?? undefined,
            messageParams: recipient.messageParams,
            params: recipient.params ?? [],
          })
          sentMessageId = result.messageId
          lastError = null
          break
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error'
          lastError = errorMessage
          if (!isRecipientNotAllowedError(errorMessage)) break
        }
      }

      if (sentMessageId) {
        results.push({ phone: recipient.phone, status: 'sent', whatsapp_message_id: sentMessageId })
        sentCount++
      } else {
        results.push({ phone: recipient.phone, status: 'failed', error: lastError || 'Unknown error' })
        failedCount++
      }
    }

    return NextResponse.json({
      success: true,
      channel_id: configId,
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
