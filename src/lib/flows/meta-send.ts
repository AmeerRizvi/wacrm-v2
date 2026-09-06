import {
  sendInteractiveButtons,
  sendInteractiveList,
  sendMediaMessage,
  sendTextMessage,
  type InteractiveButton,
  type InteractiveListSection,
  type MediaKind,
} from '@/lib/whatsapp/meta-api'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import { resolveConversationChannel } from '@/lib/whatsapp/conversation-channel'
import { supabaseAdmin } from './admin-client'

interface SendTextEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  text: string
  aiGenerated?: boolean
}

interface SendMediaEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  kind: MediaKind
  link: string
  caption?: string
  filename?: string
}

interface SendInteractiveButtonsEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttons: InteractiveButton[]
  headerText?: string
  footerText?: string
}

interface SendInteractiveListEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttonLabel: string
  sections: InteractiveListSection[]
  headerText?: string
  footerText?: string
}

type PreparedSend = {
  contact: { id: string; phone: string }
  sanitized: string
  channel: { id: string; phone_number_id: string; access_token: string }
  accessToken: string
}

async function prepareSend(args: {
  accountId: string
  conversationId: string
  contactId: string
}): Promise<PreparedSend> {
  const db = supabaseAdmin()
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id,phone')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle()
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this account')
  }

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  const channel = await resolveConversationChannel(
    db,
    args.accountId,
    args.conversationId,
    args.contactId,
  )

  return {
    contact: contact as { id: string; phone: string },
    sanitized,
    channel,
    accessToken: decrypt(channel.access_token),
  }
}

async function sendWithPhoneVariants(
  sanitized: string,
  attempt: (phone: string) => Promise<string>,
): Promise<{ whatsappMessageId: string; workingPhone: string }> {
  let workingPhone = sanitized
  let whatsappMessageId = ''
  let lastError: unknown = null

  for (const variant of phoneVariants(sanitized)) {
    try {
      whatsappMessageId = await attempt(variant)
      workingPhone = variant
      lastError = null
      break
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(message)) throw err
      lastError = err
    }
  }
  if (lastError) throw lastError
  return { whatsappMessageId, workingPhone }
}

async function persistPhoneVariant(
  accountId: string,
  contactId: string,
  sanitized: string,
  workingPhone: string,
) {
  if (workingPhone === sanitized) return
  await supabaseAdmin()
    .from('contacts')
    .update({ phone: workingPhone })
    .eq('id', contactId)
    .eq('account_id', accountId)
}

export async function engineSendText(
  args: SendTextEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()
  const prepared = await prepareSend(args)
  const { whatsappMessageId, workingPhone } = await sendWithPhoneVariants(
    prepared.sanitized,
    async (phone) => {
      const result = await sendTextMessage({
        phoneNumberId: prepared.channel.phone_number_id,
        accessToken: prepared.accessToken,
        to: phone,
        text: args.text,
      })
      return result.messageId
    },
  )

  await persistPhoneVariant(args.accountId, prepared.contact.id, prepared.sanitized, workingPhone)

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    whatsapp_config_id: prepared.channel.id,
    sender_type: 'bot',
    content_type: 'text',
    content_text: args.text,
    message_id: whatsappMessageId,
    status: 'sent',
    ai_generated: args.aiGenerated ?? false,
  })
  if (msgErr) throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)

  await db
    .from('conversations')
    .update({
      last_message_text: args.text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)
    .eq('account_id', args.accountId)

  return { whatsapp_message_id: whatsappMessageId }
}

export async function engineSendMedia(
  args: SendMediaEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()
  const prepared = await prepareSend(args)
  const { whatsappMessageId, workingPhone } = await sendWithPhoneVariants(
    prepared.sanitized,
    async (phone) => {
      const result = await sendMediaMessage({
        phoneNumberId: prepared.channel.phone_number_id,
        accessToken: prepared.accessToken,
        to: phone,
        kind: args.kind,
        link: args.link,
        caption: args.caption,
        filename: args.filename,
      })
      return result.messageId
    },
  )

  await persistPhoneVariant(args.accountId, prepared.contact.id, prepared.sanitized, workingPhone)
  const preview = args.caption?.trim() || `[${args.kind}]`

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    whatsapp_config_id: prepared.channel.id,
    sender_type: 'bot',
    content_type: args.kind,
    content_text: args.caption ?? null,
    media_url: args.link,
    message_id: whatsappMessageId,
    status: 'sent',
  })
  if (msgErr) throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)

  await db
    .from('conversations')
    .update({
      last_message_text: preview,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)
    .eq('account_id', args.accountId)

  return { whatsapp_message_id: whatsappMessageId }
}

export async function engineSendInteractiveButtons(
  args: SendInteractiveButtonsEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaMeta({ ...args, kind: 'buttons' })
}

export async function engineSendInteractiveList(
  args: SendInteractiveListEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaMeta({ ...args, kind: 'list' })
}

type InteractiveSendInput =
  | (SendInteractiveButtonsEngineArgs & { kind: 'buttons' })
  | (SendInteractiveListEngineArgs & { kind: 'list' })

async function sendInteractiveViaMeta(
  input: InteractiveSendInput,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()
  const prepared = await prepareSend(input)

  const { whatsappMessageId, workingPhone } = await sendWithPhoneVariants(
    prepared.sanitized,
    async (phone) => {
      if (input.kind === 'buttons') {
        const result = await sendInteractiveButtons({
          phoneNumberId: prepared.channel.phone_number_id,
          accessToken: prepared.accessToken,
          to: phone,
          bodyText: input.bodyText,
          buttons: input.buttons,
          headerText: input.headerText,
          footerText: input.footerText,
        })
        return result.messageId
      }
      const result = await sendInteractiveList({
        phoneNumberId: prepared.channel.phone_number_id,
        accessToken: prepared.accessToken,
        to: phone,
        bodyText: input.bodyText,
        buttonLabel: input.buttonLabel,
        sections: input.sections,
        headerText: input.headerText,
        footerText: input.footerText,
      })
      return result.messageId
    },
  )

  await persistPhoneVariant(
    input.accountId,
    prepared.contact.id,
    prepared.sanitized,
    workingPhone,
  )

  const interactivePayload: InteractiveMessagePayload =
    input.kind === 'buttons'
      ? {
          kind: 'buttons',
          body: input.bodyText,
          header: input.headerText,
          footer: input.footerText,
          buttons: input.buttons,
        }
      : {
          kind: 'list',
          body: input.bodyText,
          header: input.headerText,
          footer: input.footerText,
          button_label: input.buttonLabel,
          sections: input.sections,
        }

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: input.conversationId,
    whatsapp_config_id: prepared.channel.id,
    sender_type: 'bot',
    content_type: 'interactive',
    content_text: input.bodyText,
    interactive_payload: interactivePayload,
    message_id: whatsappMessageId,
    status: 'sent',
  })
  if (msgErr) throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)

  await db
    .from('conversations')
    .update({
      last_message_text: input.bodyText,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.conversationId)
    .eq('account_id', input.accountId)

  return { whatsapp_message_id: whatsappMessageId }
}
