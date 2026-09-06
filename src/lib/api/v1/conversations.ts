// ============================================================
// Public API (v1) serializers for conversations + messages.
//
// Multi-channel callers need the stable WhatsApp channel id on reads so they
// can correlate a Sales/Support thread and reuse that id on future sends.
// Internal tenant/audit columns remain hidden.
// ============================================================

import type { Conversation, Message } from '@/types';

type ChannelConversation = Conversation & { whatsapp_config_id?: string | null };
type ChannelMessage = Message & { whatsapp_config_id?: string | null };

export interface ApiConversation {
  id: string;
  channel_id: string | null;
  contact_id: string;
  status: string;
  assigned_agent_id: string | null;
  last_message_text: string | null;
  last_message_at: string | null;
  unread_count: number;
  created_at: string;
  updated_at: string;
  contact: {
    id: string;
    phone: string;
    name: string | null;
    email: string | null;
    company: string | null;
    tags: { id: string; name: string; color: string }[];
  } | null;
}

export interface ApiMessage {
  id: string;
  channel_id: string | null;
  conversation_id: string;
  direction: 'inbound' | 'outbound';
  sender_type: string;
  content_type: string;
  content_text: string | null;
  media_url: string | null;
  template_name: string | null;
  whatsapp_message_id: string | null;
  status: string;
  reply_to_message_id: string | null;
  interactive_reply_id: string | null;
  created_at: string;
}

export function serializeConversation(conv: Conversation): ApiConversation {
  const row = conv as ChannelConversation;
  const c = conv.contact;
  return {
    id: conv.id,
    channel_id: row.whatsapp_config_id ?? null,
    contact_id: conv.contact_id,
    status: conv.status,
    assigned_agent_id: conv.assigned_agent_id ?? null,
    last_message_text: conv.last_message_text ?? null,
    last_message_at: conv.last_message_at ?? null,
    unread_count: conv.unread_count ?? 0,
    created_at: conv.created_at,
    updated_at: conv.updated_at,
    contact: c
      ? {
          id: c.id,
          phone: c.phone,
          name: c.name ?? null,
          email: c.email ?? null,
          company: c.company ?? null,
          tags: (c.tags ?? []).map((t) => ({
            id: t.id,
            name: t.name,
            color: t.color,
          })),
        }
      : null,
  };
}

export function serializeMessage(m: Message): ApiMessage {
  const row = m as ChannelMessage;
  return {
    id: m.id,
    channel_id: row.whatsapp_config_id ?? null,
    conversation_id: m.conversation_id,
    direction: m.sender_type === 'customer' ? 'inbound' : 'outbound',
    sender_type: m.sender_type,
    content_type: m.content_type,
    content_text: m.content_text ?? null,
    media_url: m.media_url ?? null,
    template_name: m.template_name ?? null,
    whatsapp_message_id: m.message_id ?? null,
    status: m.status,
    reply_to_message_id: m.reply_to_message_id ?? null,
    interactive_reply_id: m.interactive_reply_id ?? null,
    created_at: m.created_at,
  };
}
