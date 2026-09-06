import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import {
  sendMessageToConversation,
  validateSendMessageParams,
  SendMessageError,
} from '@/lib/whatsapp/send-message';
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive';

/**
 * POST /api/v1/messages
 *
 * Optional `channel_id` (alias `whatsapp_config_id`) selects the WhatsApp
 * number to send from. When omitted, the account's primary channel is used.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'messages:send');
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const to = typeof body.to === 'string' ? body.to.trim() : '';
    if (!to) return fail('bad_request', "'to' is required", 400);
    const type = typeof body.type === 'string' ? body.type : 'text';

    const template =
      body.template && typeof body.template === 'object'
        ? (body.template as Record<string, unknown>)
        : null;
    const templateParams = Array.isArray(template?.params)
      ? (template.params as unknown[]).filter((p): p is string => typeof p === 'string')
      : undefined;
    const templateMessageParams =
      template?.params && !Array.isArray(template.params) ? template.params : undefined;
    const interactivePayload =
      body.interactive_payload && typeof body.interactive_payload === 'object'
        ? (body.interactive_payload as InteractiveMessagePayload)
        : null;

    validateSendMessageParams({
      messageType: type,
      contentText: typeof body.text === 'string' ? body.text : null,
      mediaUrl: typeof body.media_url === 'string' ? body.media_url : null,
      templateName: typeof template?.name === 'string' ? template.name : null,
      interactivePayload,
    });

    const requestedChannelId =
      typeof body.channel_id === 'string' && body.channel_id
        ? body.channel_id
        : typeof body.whatsapp_config_id === 'string' && body.whatsapp_config_id
          ? body.whatsapp_config_id
          : null;

    const resolved = await resolveConversationByPhone(
      ctx.supabase,
      ctx.accountId,
      to,
      typeof body.name === 'string' ? body.name : null,
      requestedChannelId,
    );

    const result = await sendMessageToConversation(ctx.supabase, ctx.accountId, {
      conversationId: resolved.conversationId,
      messageType: type,
      contentText: typeof body.text === 'string' ? body.text : null,
      mediaUrl: typeof body.media_url === 'string' ? body.media_url : null,
      filename: typeof body.filename === 'string' ? body.filename : null,
      templateName: typeof template?.name === 'string' ? template.name : null,
      templateLanguage:
        typeof template?.language === 'string' ? template.language : null,
      templateParams,
      templateMessageParams,
      interactivePayload,
      replyToMessageId:
        typeof body.reply_to_message_id === 'string' ? body.reply_to_message_id : null,
    });

    return ok(
      {
        message_id: result.messageId,
        whatsapp_message_id: result.whatsappMessageId,
        conversation_id: resolved.conversationId,
        contact_id: resolved.contactId,
        contact_created: resolved.contactCreated,
        channel_id: resolved.whatsappConfigId,
      },
      201,
    );
  } catch (err) {
    if (err instanceof SendMessageError) return fail(err.code, err.message, err.status);
    return toApiErrorResponse(err);
  }
}
