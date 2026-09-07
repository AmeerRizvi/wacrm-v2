import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import type { AutomationTriggerType } from '@/types'

async function bindExplicitLegacyChannel(
  supabase: SupabaseClient,
  accountId: string,
  conversationId: string,
  contactId: string | null,
  channelId: string,
): Promise<NextResponse | null> {
  let conversationQuery = supabase
    .from('conversations')
    .select('id,contact_id,whatsapp_config_id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
  if (contactId) conversationQuery = conversationQuery.eq('contact_id', contactId)

  const { data: conversation, error: conversationError } = await conversationQuery.maybeSingle()
  if (conversationError) {
    return NextResponse.json({ error: 'Failed to resolve conversation' }, { status: 500 })
  }
  if (!conversation) {
    return NextResponse.json({ error: 'Conversation not found for this account/contact' }, { status: 404 })
  }

  if (conversation.whatsapp_config_id) {
    if (conversation.whatsapp_config_id !== channelId) {
      return NextResponse.json(
        { error: 'channel_id does not match the conversation WhatsApp channel' },
        { status: 409 },
      )
    }
    return null
  }

  const { data: channel, error: channelError } = await supabase
    .from('whatsapp_config')
    .select('id')
    .eq('account_id', accountId)
    .eq('id', channelId)
    .maybeSingle()
  if (channelError) {
    return NextResponse.json({ error: 'Failed to resolve WhatsApp channel' }, { status: 500 })
  }
  if (!channel) {
    return NextResponse.json({ error: 'WhatsApp channel not found' }, { status: 404 })
  }

  const { data: bound, error: bindError } = await supabase
    .from('conversations')
    .update({ whatsapp_config_id: channelId, updated_at: new Date().toISOString() })
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
            'A channel-specific conversation already exists for this contact. Use that conversation_id instead.',
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
    if (current.whatsapp_config_id !== channelId) {
      return NextResponse.json(
        {
          error:
            'This conversation was assigned to another WhatsApp channel concurrently. Retry with the current conversation.',
        },
        { status: 409 },
      )
    }
  }

  return null
}

/**
 * Manual trigger for testing or for external integrations that want
 * to fire automations. Auth is required — we resolve the caller's
 * account_id and dispatch over the account's automations.
 */
export async function POST(request: Request) {
  let accountId: string
  let supabase: SupabaseClient
  try {
    const ctx = await requireRole('agent')
    accountId = ctx.accountId
    supabase = ctx.supabase
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body?.trigger_type) {
    return NextResponse.json({ error: 'trigger_type required' }, { status: 400 })
  }

  const contactId = typeof body.contact_id === 'string' && body.contact_id ? body.contact_id : null
  const context = body.context && typeof body.context === 'object' ? body.context : {}
  const conversationId =
    typeof context.conversation_id === 'string' && context.conversation_id
      ? context.conversation_id
      : null
  const channelId =
    typeof context.channel_id === 'string' && context.channel_id ? context.channel_id : null

  // Explicit channel context must never be ignored. A pre-channel legacy
  // conversation can be claimed here, before the automation engine switches to
  // service-role writes; after binding, every send/assign/close step resolves
  // the exact same conversation channel.
  if (conversationId && channelId) {
    const bindResponse = await bindExplicitLegacyChannel(
      supabase,
      accountId,
      conversationId,
      contactId,
      channelId,
    )
    if (bindResponse) return bindResponse
  }

  await runAutomationsForTrigger({
    accountId,
    triggerType: body.trigger_type as AutomationTriggerType,
    contactId,
    context,
  })

  return NextResponse.json({ ok: true })
}
