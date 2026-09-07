import { notifyIncomingMessage } from '@/lib/push/send'
import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { getMediaUrl } from '@/lib/whatsapp/meta-api'
import { mirrorInboundMedia } from '@/lib/whatsapp/mirror-inbound-media'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook'

export const maxDuration = 60

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

interface WhatsAppMessage {
  id: string
  from: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string }
  sticker?: { id: string; mime_type: string }
  location?: { latitude: number; longitude: number; name?: string; address?: string }
  reaction?: { message_id: string; emoji: string }
  interactive?: {
    type: 'button_reply' | 'list_reply'
    button_reply?: { id: string; title: string }
    list_reply?: { id: string; title: string; description?: string }
  }
  button?: { text?: string; payload?: string }
  context?: { id: string }
}

interface WhatsAppWebhookEntry {
  id: string
  changes: Array<{
    value: {
      messaging_product: string
      metadata?: {
        display_phone_number: string
        phone_number_id: string
      }
      contacts?: Array<{
        profile: { name: string }
        wa_id: string
      }>
      messages?: WhatsAppMessage[]
      statuses?: Array<{
        id: string
        status: string
        timestamp: string
        recipient_id: string
      }>
      [key: string]: unknown
    }
    field: string
  }>
}

type ChannelConfig = {
  id: string
  account_id: string
  user_id: string
  phone_number_id: string
  access_token: string
  mirror_inbound_media?: boolean
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json({ error: 'Missing verification parameters' }, { status: 400 })
    }

    const { data: configs, error } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('id, verify_token')
    if (error || !configs) {
      return NextResponse.json({ error: 'Verification failed' }, { status: 403 })
    }

    for (const config of configs) {
      if (!config.verify_token) continue
      try {
        if (decrypt(config.verify_token) !== verifyToken) continue
        if (isLegacyFormat(config.verify_token)) {
          void supabaseAdmin()
            .from('whatsapp_config')
            .update({ verify_token: encrypt(verifyToken) })
            .eq('id', config.id)
        }
        return new Response(challenge, {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        })
      } catch {
        // A corrupt row must not prevent another valid channel from matching.
      }
    }

    return NextResponse.json({ error: 'Verification token mismatch' }, { status: 403 })
  } catch (error) {
    console.error('[webhook] GET failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')
  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    console.warn('[webhook] rejected invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: { entry?: WhatsAppWebhookEntry[] }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  after(async () => {
    try {
      await processWebhook(body)
    } catch (error) {
      console.error('[webhook] processing failed:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function resolveChannelByPhoneNumberId(
  phoneNumberId: string,
): Promise<ChannelConfig | null> {
  const { data, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('id,account_id,user_id,phone_number_id,access_token,mirror_inbound_media')
    .eq('phone_number_id', phoneNumberId)
    .maybeSingle()

  if (error || !data) {
    console.error('[webhook] no unique channel for phone_number_id:', phoneNumberId, error)
    return null
  }
  return data as ChannelConfig
}

async function processWebhook(body: { entry?: WhatsAppWebhookEntry[] }) {
  if (!body.entry) return

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      if (isTemplateWebhookField(change.field)) {
        await handleTemplateWebhookChange(
          { field: change.field, value: change.value as unknown },
          supabaseAdmin(),
          entry.id,
        )
        continue
      }

      const value = change.value
      const phoneNumberId = value.metadata?.phone_number_id
      if (!phoneNumberId) {
        console.warn('[webhook] messaging event missing metadata.phone_number_id')
        continue
      }

      const config = await resolveChannelByPhoneNumberId(phoneNumberId)
      if (!config) continue

      if (value.statuses) {
        for (const status of value.statuses) {
          await handleStatusUpdate(status, config)
        }
      }

      if (!value.messages || !value.contacts) continue

      let accessToken: string
      try {
        accessToken = decrypt(config.access_token)
      } catch (error) {
        console.error('[webhook] channel access token decrypt failed:', config.id, error)
        continue
      }

      for (let i = 0; i < value.messages.length; i++) {
        await processMessage(
          value.messages[i],
          value.contacts[i] || value.contacts[0],
          config,
          accessToken,
        )
      }
    }
  }
}

const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s)
  return idx < 0 ? -1 : idx
}

function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') return current === 'pending' || current === 'sent'
  if (current === 'failed') return false
  const currentLevel = ladderLevel(current)
  const incomingLevel = ladderLevel(incoming)
  if (incomingLevel < 0) return false
  if (currentLevel < 0) return true
  return incomingLevel > currentLevel
}

async function handleStatusUpdate(
  status: { id: string; status: string; timestamp: string; recipient_id: string },
  config: ChannelConfig,
) {
  const { error: msgErr } = await supabaseAdmin()
    .from('messages')
    .update({ status: status.status })
    .eq('message_id', status.id)
    .eq('whatsapp_config_id', config.id)
  if (msgErr) console.error('[webhook] message status update failed:', msgErr)

  const tsIso = new Date(parseInt(status.timestamp) * 1000).toISOString()
  const { data: recipient, error: recFetchErr } = await supabaseAdmin()
    .from('broadcast_recipients')
    .select('id,status')
    .eq('whatsapp_message_id', status.id)
    .eq('whatsapp_config_id', config.id)
    .maybeSingle()

  if (recFetchErr) {
    console.error('[webhook] broadcast recipient lookup failed:', recFetchErr)
  } else if (recipient && isValidStatusTransition(recipient.status, status.status)) {
    const update: Record<string, unknown> = { status: status.status }
    if (status.status === 'sent') update.sent_at = tsIso
    if (status.status === 'delivered') update.delivered_at = tsIso
    if (status.status === 'read') update.read_at = tsIso
    const { error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update(update)
      .eq('id', recipient.id)
    if (error) console.error('[webhook] broadcast status update failed:', error)
  }

  const { data: msgRow } = await supabaseAdmin()
    .from('messages')
    .select('conversation_id, conversations(account_id)')
    .eq('message_id', status.id)
    .eq('whatsapp_config_id', config.id)
    .limit(1)
    .maybeSingle()

  if (msgRow) {
    const conv = msgRow.conversations as { account_id: string } | null
    if (conv?.account_id) {
      await dispatchWebhookEvent(
        supabaseAdmin(),
        conv.account_id,
        'message.status_updated',
        {
          whatsapp_message_id: status.id,
          conversation_id: msgRow.conversation_id,
          channel_id: config.id,
          status: status.status,
        },
      )
    }
  }
}

async function flagBroadcastReplyIfAny(
  accountId: string,
  contactId: string,
  channelId: string,
) {
  try {
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id,status,broadcast_id,broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('whatsapp_config_id', channelId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)
    if (error || !recs?.length) return

    await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', recs[0].id)
  } catch (error) {
    console.error('[webhook] flagBroadcastReplyIfAny failed:', error)
  }
}

async function lookupInternalIdByMetaId(
  metaId: string,
  conversationId: string,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', metaId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) return null
  return data?.id ?? null
}

async function handleReaction(
  message: WhatsAppMessage,
  conversationId: string,
  contactId: string,
) {
  const reaction = message.reaction
  if (!reaction?.message_id) return
  const targetInternalId = await lookupInternalIdByMetaId(reaction.message_id, conversationId)
  if (!targetInternalId) return

  if (!reaction.emoji) {
    await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    return
  }

  await supabaseAdmin().from('message_reactions').upsert(
    {
      message_id: targetInternalId,
      conversation_id: conversationId,
      actor_type: 'customer',
      actor_id: contactId,
      emoji: reaction.emoji,
    },
    { onConflict: 'message_id,actor_type,actor_id' },
  )
}

async function processMessage(
  message: WhatsAppMessage,
  contact: { profile: { name: string }; wa_id: string },
  config: ChannelConfig,
  accessToken: string,
) {
  const accountId = config.account_id
  const senderPhone = normalizePhone(message.from)
  const contactOutcome = await findOrCreateContact(
    accountId,
    config.user_id,
    senderPhone,
    contact.profile.name,
  )
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  const convResult = await findOrCreateConversation(
    accountId,
    config.user_id,
    contactRecord.id,
    config.id,
  )
  if (!convResult) return
  const conversation = convResult.conversation

  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
      channel_id: config.id,
    })
  }

  if (message.type === 'reaction') {
    await handleReaction(message, conversation.id, contactRecord.id)
    return
  }

  const { contentText, mediaUrl, mediaType, interactiveReplyId } =
    await parseMessageContent(message, accessToken, {
      accountId,
      channelId: config.id,
      mirror: config.mirror_inbound_media !== false,
    })

  let replyToInternalId: string | null = null
  if (message.context?.id) {
    replyToInternalId = await lookupInternalIdByMetaId(message.context.id, conversation.id)
  }

  const allowedContentTypes = new Set([
    'text',
    'image',
    'document',
    'audio',
    'video',
    'location',
    'template',
    'interactive',
  ])
  const contentType = allowedContentTypes.has(message.type)
    ? message.type
    : message.type === 'sticker'
      ? 'image'
      : message.type === 'button'
        ? 'interactive'
        : 'text'

  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  const { data: insertedRows, error: msgError } = await supabaseAdmin()
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        whatsapp_config_id: config.id,
        sender_type: 'customer',
        content_type: contentType,
        content_text: contentText,
        media_url: mediaUrl,
        media_type: mediaType,
        message_id: message.id,
        status: 'delivered',
        created_at: new Date(parseInt(message.timestamp) * 1000).toISOString(),
        reply_to_message_id: replyToInternalId,
        interactive_reply_id: interactiveReplyId,
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true },
    )
    .select('id')

  if (msgError) {
    console.error('[webhook] inbound message insert failed:', msgError)
    return
  }
  if (!insertedRows?.length) return

  await notifyIncomingMessage(accountId, conversation.id, insertedRows[0].id).catch(() => console.warn('[push] incoming notification failed'))

  const { error: convError } = await supabaseAdmin().rpc('bump_conversation_on_inbound', {
    p_conversation_id: conversation.id,
    p_last_message_text: contentText || `[${message.type}]`,
  })
  if (convError) console.error('[webhook] conversation bump failed:', convError)

  await reopenClosedConversation(supabaseAdmin(), conversation)
  await flagBroadcastReplyIfAny(accountId, contactRecord.id, config.id)

  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: config.user_id,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message: interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: interactiveReplyId,
          reply_title: contentText ?? '',
          meta_message_id: message.id,
        }
      : {
          kind: 'text',
          text: contentText ?? message.text?.body ?? '',
          meta_message_id: message.id,
        },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  const inboundText = contentText ?? message.text?.body ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []

  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
    if (interactiveReplyId) automationTriggers.push('interactive_reply')
  }
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')

  for (const triggerType of automationTriggers) {
    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        channel_id: config.id,
        interactive_reply_id: interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  if (!flowConsumed && !interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId: config.user_id,
    })
  }

  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    channel_id: config.id,
    whatsapp_message_id: message.id,
    content_type: contentType,
    text: contentText,
  })
}

async function parseMessageContent(
  message: WhatsAppMessage,
  accessToken: string,
  mediaContext: { accountId: string; channelId: string; mirror: boolean },
): Promise<{
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
  interactiveReplyId: string | null
}> {
  const verifyAndBuildUrl = async (
    mediaId: string,
    fileName?: string | null,
  ): Promise<string | null> => {
    try {
      const info = await getMediaUrl({ mediaId, accessToken })
      if (mediaContext.mirror) {
        const mirrored = await mirrorInboundMedia({
          storage: supabaseAdmin().storage,
          accountId: mediaContext.accountId,
          mediaId,
          downloadUrl: info.url,
          accessToken,
          mimeType: info.mimeType,
          fileSize: info.fileSize,
          fileName,
          messageTimestamp: message.timestamp,
        })
        if (mirrored) return mirrored
      }
      return `/api/whatsapp/media/${mediaId}?channel_id=${encodeURIComponent(mediaContext.channelId)}`
    } catch (error) {
      console.error(`[webhook] failed to resolve media ${mediaId}:`, error)
      return null
    }
  }

  const empty = {
    contentText: null,
    mediaUrl: null,
    mediaType: null,
    interactiveReplyId: null,
  }

  switch (message.type) {
    case 'text':
      return { ...empty, contentText: message.text?.body || null }
    case 'image':
      return message.image?.id
        ? {
            ...empty,
            contentText: message.image.caption || null,
            mediaUrl: await verifyAndBuildUrl(message.image.id),
            mediaType: message.image.mime_type,
          }
        : empty
    case 'video':
      return message.video?.id
        ? {
            ...empty,
            contentText: message.video.caption || null,
            mediaUrl: await verifyAndBuildUrl(message.video.id),
            mediaType: message.video.mime_type,
          }
        : empty
    case 'document':
      return message.document?.id
        ? {
            ...empty,
            contentText: message.document.caption || message.document.filename || null,
            mediaUrl: await verifyAndBuildUrl(message.document.id, message.document.filename),
            mediaType: message.document.mime_type,
          }
        : empty
    case 'audio':
      return message.audio?.id
        ? {
            ...empty,
            mediaUrl: await verifyAndBuildUrl(message.audio.id),
            mediaType: message.audio.mime_type,
          }
        : empty
    case 'sticker':
      return message.sticker?.id
        ? {
            ...empty,
            mediaUrl: await verifyAndBuildUrl(message.sticker.id),
            mediaType: message.sticker.mime_type,
          }
        : empty
    case 'location': {
      if (!message.location) return empty
      const loc = message.location
      return {
        ...empty,
        contentText: [loc.name, loc.address, `${loc.latitude},${loc.longitude}`]
          .filter(Boolean)
          .join(' - '),
      }
    }
    case 'reaction':
      return { ...empty, contentText: message.reaction?.emoji || null }
    case 'interactive': {
      const reply = message.interactive?.button_reply ?? message.interactive?.list_reply
      if (!reply?.id) return { ...empty, contentText: '[Interactive reply]' }
      return {
        ...empty,
        contentText: reply.title || reply.id,
        interactiveReplyId: reply.id,
      }
    }
    case 'button': {
      const payload = message.button?.payload || null
      const label = message.button?.text || null
      return {
        ...empty,
        contentText: label || payload,
        interactiveReplyId: payload || label,
      }
    }
    default:
      return { ...empty, contentText: `[Unsupported message type: ${message.type}]` }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any
interface ContactOutcome {
  contact: ContactRow
  wasCreated: boolean
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string,
): Promise<ContactOutcome | null> {
  const existing = await findExistingContact(supabaseAdmin(), accountId, phone)
  if (existing) {
    if (name && name !== existing.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
    }
    return { contact: existing, wasCreated: false }
  }

  const { data: created, error } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (error) {
    if (isUniqueViolation(error)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('[webhook] contact create failed:', error)
    return null
  }
  return { contact: created, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
  channelId: string,
) {
  const { data: existingRows, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('whatsapp_config_id', channelId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('[webhook] conversation lookup failed:', findError)
    return null
  }
  if (existingRows?.length) return { conversation: existingRows[0], created: false }

  // Preserve pre-channel history. If migration 040 ran before WhatsApp was
  // configured, the one legacy thread for this contact remains NULL-bound.
  // Claim it for the first real channel instead of splitting the history.
  const { data: legacyRows, error: legacyError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .is('whatsapp_config_id', null)
    .order('created_at', { ascending: true })
    .limit(1)

  if (legacyError) {
    console.error('[webhook] legacy conversation lookup failed:', legacyError)
    return null
  }

  if (legacyRows?.[0]) {
    const legacy = legacyRows[0]
    const { data: rebound, error: bindError } = await supabaseAdmin()
      .from('conversations')
      .update({ whatsapp_config_id: channelId, updated_at: new Date().toISOString() })
      .eq('id', legacy.id)
      .eq('account_id', accountId)
      .is('whatsapp_config_id', null)
      .select()
      .maybeSingle()

    if (!bindError && rebound) return { conversation: rebound, created: false }
    if (bindError && !isUniqueViolation(bindError)) {
      console.error('[webhook] legacy conversation bind failed:', bindError)
      return null
    }

    const { data: racedExact, error: racedExactError } = await supabaseAdmin()
      .from('conversations')
      .select('*')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .eq('whatsapp_config_id', channelId)
      .order('created_at', { ascending: true })
      .limit(1)
    if (racedExactError) {
      console.error('[webhook] raced conversation lookup failed:', racedExactError)
      return null
    }
    if (racedExact?.length) return { conversation: racedExact[0], created: false }
  }

  const { data: created, error } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
      whatsapp_config_id: channelId,
    })
    .select()
    .single()

  if (error) {
    if (isUniqueViolation(error)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .eq('whatsapp_config_id', channelId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced?.length) return { conversation: raced[0], created: false }
    }
    console.error('[webhook] conversation create failed:', error)
    return null
  }

  return { conversation: created, created: true }
}
