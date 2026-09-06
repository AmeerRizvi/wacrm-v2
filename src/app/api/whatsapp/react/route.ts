import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { sendReactionMessage } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    const limit = checkRateLimit(`react:${userId}`, RATE_LIMITS.react);
    if (!limit.success) return rateLimitResponse(limit);

    const { message_id, emoji } = (await request.json()) as { message_id?: string; emoji?: string };
    if (!message_id || typeof emoji !== 'string') {
      return NextResponse.json({ error: 'message_id and emoji are required' }, { status: 400 });
    }

    const { data: targetMessage, error: msgError } = await supabase
      .from('messages')
      .select('id,message_id,conversation_id,whatsapp_config_id')
      .eq('id', message_id)
      .maybeSingle();
    if (msgError || !targetMessage) return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    if (!targetMessage.message_id) return NextResponse.json({ error: 'Cannot react to a message that has not been sent to WhatsApp' }, { status: 400 });

    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('id,account_id,whatsapp_config_id,contact:contacts(phone)')
      .eq('id', targetMessage.conversation_id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (convError || !conversation) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });

    const contact = Array.isArray(conversation.contact) ? conversation.contact[0] : conversation.contact;
    if (!contact?.phone) return NextResponse.json({ error: 'Contact phone number not found' }, { status: 400 });

    const channelId = conversation.whatsapp_config_id || targetMessage.whatsapp_config_id;
    if (!channelId) return NextResponse.json({ error: 'Conversation is not bound to a WhatsApp channel.' }, { status: 400 });
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('id,phone_number_id,access_token')
      .eq('account_id', accountId)
      .eq('id', channelId)
      .maybeSingle();
    if (configError || !config) return NextResponse.json({ error: 'Conversation WhatsApp channel is not configured.' }, { status: 400 });

    try {
      await sendReactionMessage({
        phoneNumberId: config.phone_number_id,
        accessToken: decrypt(config.access_token),
        to: sanitizePhoneForMeta(contact.phone),
        targetMessageId: targetMessage.message_id,
        emoji,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error';
      return NextResponse.json({ error: `Meta API error: ${message}` }, { status: 502 });
    }

    if (emoji === '') {
      const { error } = await supabase.from('message_reactions').delete().eq('message_id', targetMessage.id).eq('actor_type', 'agent').eq('actor_id', userId);
      if (error) return NextResponse.json({ error: 'Reaction sent to Meta but DB delete failed' }, { status: 500 });
    } else {
      const { error } = await supabase.from('message_reactions').upsert({
        message_id: targetMessage.id,
        conversation_id: targetMessage.conversation_id,
        actor_type: 'agent',
        actor_id: userId,
        emoji,
      }, { onConflict: 'message_id,actor_type,actor_id' });
      if (error) return NextResponse.json({ error: 'Reaction sent to Meta but DB upsert failed' }, { status: 500 });
    }

    return NextResponse.json({ success: true, channel_id: config.id });
  } catch (error) {
    console.error('Error in WhatsApp react POST:', error);
    return toErrorResponse(error);
  }
}