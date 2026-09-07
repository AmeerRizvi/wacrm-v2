import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  sendMessageToConversation,
  validateSendMessageParams,
  SendMessageError,
} from '@/lib/whatsapp/send-message'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`send:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json()
    const {
      conversation_id: conversationIdInput,
      contact_id: contactId,
      channel_id: channelId,
      whatsapp_config_id: whatsappConfigId,
      message_type,
      content_text,
      media_url,
      filename,
      template_name,
      template_language,
      template_params,
      template_message_params,
      interactive_payload,
      reply_to_message_id,
    } = body

    if ((!conversationIdInput && !contactId) || !message_type) {
      return NextResponse.json(
        { error: 'Either conversation_id or contact_id, plus message_type, are required' },
        { status: 400 },
      )
    }

    try {
      validateSendMessageParams({
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
        templateName: template_name,
        interactivePayload: interactive_payload,
      })
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }

    const requestedChannel =
      typeof whatsappConfigId === 'string' && whatsappConfigId
        ? whatsappConfigId
        : typeof channelId === 'string' && channelId
          ? channelId
          : null

    let conversationId: string
    let resolvedChannelId: string | null = null

    if (conversationIdInput) {
      const { data, error } = await supabase
        .from('conversations')
        .select('id,whatsapp_config_id')
        .eq('id', conversationIdInput)
        .eq('account_id', accountId)
        .maybeSingle()
      if (error || !data) {
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
      }
      conversationId = data.id
      resolvedChannelId = data.whatsapp_config_id ?? null

      if (requestedChannel && resolvedChannelId && requestedChannel !== resolvedChannelId) {
        return NextResponse.json(
          { error: 'channel_id does not match the conversation WhatsApp channel' },
          { status: 409 },
        )
      }

      // Upgrade edge: a conversation created before WhatsApp was configured can
      // still be NULL-bound. When the caller explicitly chooses a channel, that
      // choice must win over the primary fallback used by the shared sender.
      // Bind before the Meta send so historical messages are backfilled by the
      // DB trigger and a uniqueness race fails before anything is transmitted.
      if (requestedChannel && !resolvedChannelId) {
        const { data: channel, error: channelError } = await supabase
          .from('whatsapp_config')
          .select('id')
          .eq('account_id', accountId)
          .eq('id', requestedChannel)
          .maybeSingle()
        if (channelError) {
          return NextResponse.json({ error: 'Failed to resolve WhatsApp channel' }, { status: 500 })
        }
        if (!channel) {
          return NextResponse.json({ error: 'WhatsApp channel not found' }, { status: 404 })
        }

        const { data: bound, error: bindError } = await supabase
          .from('conversations')
          .update({
            whatsapp_config_id: requestedChannel,
            updated_at: new Date().toISOString(),
          })
          .eq('id', conversationId)
          .eq('account_id', accountId)
          .is('whatsapp_config_id', null)
          .select('id,whatsapp_config_id')
          .maybeSingle()

        if (bindError) {
          if (bindError.code === '23505') {
            return NextResponse.json(
              {
                error:
                  'A channel-specific conversation already exists for this contact. Refresh the inbox and use that thread.',
              },
              { status: 409 },
            )
          }
          return NextResponse.json(
            { error: 'Failed to bind conversation to WhatsApp channel' },
            { status: 500 },
          )
        }

        if (!bound) {
          // Another request may have bound the legacy row after our first read.
          const { data: current, error: currentError } = await supabase
            .from('conversations')
            .select('whatsapp_config_id')
            .eq('id', conversationId)
            .eq('account_id', accountId)
            .maybeSingle()
          if (currentError || !current) {
            return NextResponse.json(
              { error: 'Failed to re-read conversation WhatsApp channel' },
              { status: 500 },
            )
          }
          if (current.whatsapp_config_id !== requestedChannel) {
            return NextResponse.json(
              {
                error:
                  'This conversation was assigned to another WhatsApp channel concurrently. Refresh the inbox before sending.',
              },
              { status: 409 },
            )
          }
        }

        resolvedChannelId = requestedChannel
      }
    } else {
      const { data: contact, error: contactError } = await supabase
        .from('contacts')
        .select('id,phone,name')
        .eq('id', contactId)
        .eq('account_id', accountId)
        .maybeSingle()
      if (contactError || !contact?.phone) {
        return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
      }

      try {
        const resolved = await resolveConversationByPhone(
          supabase,
          accountId,
          contact.phone,
          contact.name,
          requestedChannel,
        )
        conversationId = resolved.conversationId
        resolvedChannelId = resolved.whatsappConfigId
      } catch (err) {
        if (err instanceof SendMessageError) {
          return NextResponse.json({ error: err.message }, { status: err.status })
        }
        throw err
      }
    }

    try {
      const result = await sendMessageToConversation(supabase, accountId, {
        conversationId,
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
        filename,
        templateName: template_name,
        templateLanguage: template_language,
        templateParams: template_params,
        templateMessageParams: template_message_params,
        interactivePayload: interactive_payload,
        replyToMessageId: reply_to_message_id,
      })

      return NextResponse.json({
        success: true,
        channel_id: resolvedChannelId,
        message_id: result.messageId,
        whatsapp_message_id: result.whatsappMessageId,
      })
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }
  } catch (error) {
    console.error('Error in WhatsApp send POST:', error)
    return toErrorResponse(error)
  }
}
