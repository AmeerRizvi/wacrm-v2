import type { SupabaseClient } from '@supabase/supabase-js'

type ConversationChannel = {
  id: string
  phone_number_id: string
  access_token: string
}

/**
 * Resolve the WhatsApp channel permanently attached to a conversation.
 * Service-role engines use this helper so Flow/automation/AI sends cannot
 * fall back to an arbitrary account-level config once an account has more
 * than one WhatsApp number.
 *
 * Legacy NULL-bound conversations are claimed by the account primary on the
 * first outbound engine send. Migration 041 backfills their historical
 * messages when this binding happens.
 */
export async function resolveConversationChannel(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  contactId?: string | null,
): Promise<ConversationChannel> {
  const { data: conversation, error: conversationError } = await db
    .from('conversations')
    .select('id,contact_id,whatsapp_config_id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()

  if (conversationError || !conversation) {
    throw new Error('conversation not found for this account')
  }
  if (contactId && conversation.contact_id !== contactId) {
    throw new Error('conversation does not belong to the supplied contact')
  }

  let channelId = conversation.whatsapp_config_id as string | null
  if (!channelId) {
    const { data: primary, error: primaryError } = await db
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_primary', true)
      .maybeSingle()
    if (primaryError || !primary?.id) {
      throw new Error('WhatsApp not configured for this account')
    }

    const { data: rebound, error: bindError } = await db
      .from('conversations')
      .update({
        whatsapp_config_id: primary.id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .is('whatsapp_config_id', null)
      .select('whatsapp_config_id')
      .maybeSingle()

    if (bindError) {
      throw new Error(`failed to bind legacy conversation channel: ${bindError.message}`)
    }

    if (rebound?.whatsapp_config_id) {
      channelId = rebound.whatsapp_config_id as string
    } else {
      // Another concurrent path may have claimed the legacy row first.
      const { data: raced, error: racedError } = await db
        .from('conversations')
        .select('whatsapp_config_id')
        .eq('id', conversationId)
        .eq('account_id', accountId)
        .maybeSingle()
      if (racedError || !raced?.whatsapp_config_id) {
        throw new Error('conversation has no WhatsApp channel')
      }
      channelId = raced.whatsapp_config_id as string
    }
  }

  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('id,phone_number_id,access_token')
    .eq('id', channelId)
    .eq('account_id', accountId)
    .maybeSingle()

  if (configError || !config) {
    throw new Error('conversation WhatsApp channel is not configured')
  }

  return config as ConversationChannel
}
