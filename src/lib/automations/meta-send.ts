import { sendTextMessage, sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
} from '@/lib/flows/meta-send'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import {
  resolveTemplateRow,
  templateContentText,
} from '@/lib/whatsapp/template-body'
import { resolveConversationChannel } from '@/lib/whatsapp/conversation-channel'
import { supabaseAdmin } from './admin-client'

interface SendTextArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  text: string
}

interface SendTemplateArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  templateName: string
  language?: string
  params?: string[]
}

interface SendInteractiveArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  payload: InteractiveMessagePayload
}

export async function engineSendText(args: SendTextArgs): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'text' })
}

export async function engineSendTemplate(
  args: SendTemplateArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'template' })
}

export async function engineSendInteractive(
  args: SendInteractiveArgs,
): Promise<{ whatsapp_message_id: string }> {
  const { payload, accountId, userId, conversationId, contactId } = args
  const common = { accountId, userId, conversationId, contactId }
  if (payload.kind === 'buttons') {
    return engineSendInteractiveButtons({
      ...common,
      bodyText: payload.body,
      headerText: payload.header,
      footerText: payload.footer,
      buttons: payload.buttons,
    })
  }
  return engineSendInteractiveList({
    ...common,
    bodyText: payload.body,
    buttonLabel: payload.button_label,
    headerText: payload.header,
    footerText: payload.footer,
    sections: payload.sections,
  })
}

type SendInput =
  | (SendTextArgs & { kind: 'text' })
  | (SendTemplateArgs & { kind: 'template' })

async function sendViaMeta(input: SendInput): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id,phone')
    .eq('id', input.contactId)
    .eq('account_id', input.accountId)
    .maybeSingle()
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this account')
  }

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  // The conversation is the routing authority. Never choose an account-level
  // config here: a contact may have simultaneous Sales and Support threads.
  const config = await resolveConversationChannel(
    db,
    input.accountId,
    input.conversationId,
    input.contactId,
  )
  const accessToken = decrypt(config.access_token)

  let templateRow = null
  let templateLanguage = input.kind === 'template' ? input.language : undefined
  if (input.kind === 'template') {
    const resolved = await resolveTemplateRow(
      db,
      input.accountId,
      input.templateName,
      input.language,
      config.id,
    )
    if (resolved.malformed) {
      throw new Error('template row is malformed locally; sync this WhatsApp channel from Meta')
    }
    templateRow = resolved.row
    templateLanguage = resolved.language
  }

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'template') {
      const result = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        templateName: input.templateName,
        language: templateLanguage,
        template: templateRow ?? undefined,
        params: input.params,
      })
      return result.messageId
    }
    const result = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      text: input.text,
    })
    return result.messageId
  }

  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const variant of phoneVariants(sanitized)) {
    try {
      waMessageId = await attempt(variant)
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

  if (workingPhone !== sanitized) {
    await db
      .from('contacts')
      .update({ phone: workingPhone })
      .eq('id', contact.id)
      .eq('account_id', input.accountId)
  }

  const contentType = input.kind === 'template' ? 'template' : 'text'
  const contentText =
    input.kind === 'text'
      ? input.text
      : templateContentText(templateRow, input.params ?? [])
  const templateName = input.kind === 'template' ? input.templateName : null

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: input.conversationId,
    whatsapp_config_id: config.id,
    sender_type: 'bot',
    content_type: contentType,
    content_text: contentText,
    template_name: templateName,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text:
        input.kind === 'template'
          ? (contentText ?? `[template:${input.templateName}]`)
          : input.text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.conversationId)
    .eq('account_id', input.accountId)

  return { whatsapp_message_id: waMessageId }
}
