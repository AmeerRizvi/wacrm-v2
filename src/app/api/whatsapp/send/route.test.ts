import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  resolveConversationByPhone: vi.fn(),
  sendMessageToConversation: vi.fn(),
  state: {
    denyRole: false,
    contact: {
      id: 'contact-1',
      phone: '+15551234567',
      name: 'Ada',
    } as Record<string, unknown> | null,
    conversation: {
      id: 'conv-1',
      whatsapp_config_id: 'cfg-sales',
    } as Record<string, unknown> | null,
  },
}))

function makeSupabase() {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => {
          if (table === 'contacts') {
            return { data: h.state.contact, error: null }
          }
          if (table === 'conversations') {
            return { data: h.state.conversation, error: null }
          }
          throw new Error(`unexpected table: ${table}`)
        },
      }
      return builder
    },
  }
}

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => {
    if (h.state.denyRole) throw new Error('Forbidden')
    return {
      supabase: makeSupabase(),
      accountId: 'acct-1',
      userId: 'user-1',
    }
  }),
  toErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: error instanceof Error && error.message === 'Forbidden' ? 403 : 500 },
    ),
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({ error: 'rate limited' }, { status: 429 }),
  RATE_LIMITS: { send: {} },
}))

vi.mock('@/lib/whatsapp/resolve-conversation', () => ({
  resolveConversationByPhone: (...args: unknown[]) =>
    h.resolveConversationByPhone(...args),
}))

vi.mock('@/lib/whatsapp/send-message', async (importOriginal) => {
  const original = await importOriginal<
    typeof import('@/lib/whatsapp/send-message')
  >()
  return {
    ...original,
    validateSendMessageParams: vi.fn(),
    sendMessageToConversation: (...args: unknown[]) =>
      h.sendMessageToConversation(...args),
  }
})

import { POST } from './route'

function request(body: Record<string, unknown>) {
  return new Request('http://localhost/api/whatsapp/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const TEMPLATE_BODY = {
  contact_id: 'contact-1',
  message_type: 'template',
  template_name: 'order_update',
  template_language: 'en_US',
  template_params: ['Acme', '#1234'],
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.denyRole = false
  h.state.contact = {
    id: 'contact-1',
    phone: '+15551234567',
    name: 'Ada',
  }
  h.state.conversation = {
    id: 'conv-1',
    whatsapp_config_id: 'cfg-sales',
  }
  h.resolveConversationByPhone.mockResolvedValue({
    conversationId: 'conv-primary',
    contactId: 'contact-1',
    contactCreated: false,
    whatsappConfigId: 'cfg-primary',
  })
  h.sendMessageToConversation.mockResolvedValue({
    messageId: 'msg-1',
    whatsappMessageId: 'wamid-1',
  })
})

describe('POST /api/whatsapp/send — contact routing', () => {
  it('uses the primary channel only when the caller omits channel context', async () => {
    const res = await POST(request(TEMPLATE_BODY))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(h.resolveConversationByPhone).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      '+15551234567',
      'Ada',
      null,
    )
    expect(h.sendMessageToConversation).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      expect.objectContaining({ conversationId: 'conv-primary' }),
    )
    expect(json).toMatchObject({
      success: true,
      channel_id: 'cfg-primary',
      whatsapp_message_id: 'wamid-1',
    })
  })

  it('passes channel_id to the channel-aware conversation resolver', async () => {
    h.resolveConversationByPhone.mockResolvedValue({
      conversationId: 'conv-support',
      contactId: 'contact-1',
      contactCreated: false,
      whatsappConfigId: 'cfg-support',
    })

    const res = await POST(
      request({ ...TEMPLATE_BODY, channel_id: 'cfg-support' }),
    )
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(h.resolveConversationByPhone).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      '+15551234567',
      'Ada',
      'cfg-support',
    )
    expect(json.channel_id).toBe('cfg-support')
  })

  it('accepts whatsapp_config_id as the public alias', async () => {
    await POST(
      request({ ...TEMPLATE_BODY, whatsapp_config_id: 'cfg-support' }),
    )

    expect(h.resolveConversationByPhone).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      '+15551234567',
      'Ada',
      'cfg-support',
    )
  })

  it('404s when the contact is outside the caller account', async () => {
    h.state.contact = null

    const res = await POST(request(TEMPLATE_BODY))
    expect(res.status).toBe(404)
    expect(h.resolveConversationByPhone).not.toHaveBeenCalled()
    expect(h.sendMessageToConversation).not.toHaveBeenCalled()
  })
})

describe('POST /api/whatsapp/send — existing conversation routing', () => {
  it('sends on the channel already bound to the conversation', async () => {
    const res = await POST(
      request({
        conversation_id: 'conv-1',
        message_type: 'text',
        content_text: 'hello',
      }),
    )
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(h.resolveConversationByPhone).not.toHaveBeenCalled()
    expect(h.sendMessageToConversation).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      expect.objectContaining({ conversationId: 'conv-1' }),
    )
    expect(json.channel_id).toBe('cfg-sales')
  })

  it('rejects a caller trying to override a conversation with another channel', async () => {
    const res = await POST(
      request({
        conversation_id: 'conv-1',
        channel_id: 'cfg-support',
        message_type: 'text',
        content_text: 'hello',
      }),
    )
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.error).toMatch(/does not match/i)
    expect(h.sendMessageToConversation).not.toHaveBeenCalled()
  })

  it('404s an unknown conversation', async () => {
    h.state.conversation = null

    const res = await POST(
      request({
        conversation_id: 'missing',
        message_type: 'text',
        content_text: 'hello',
      }),
    )

    expect(res.status).toBe(404)
    expect(h.sendMessageToConversation).not.toHaveBeenCalled()
  })
})

describe('POST /api/whatsapp/send — authorization and validation', () => {
  it('requires either conversation_id or contact_id', async () => {
    const res = await POST(
      request({ message_type: 'template', template_name: 'order_update' }),
    )
    expect(res.status).toBe(400)
  })

  it('refuses a viewer before resolving a channel or sending to Meta', async () => {
    h.state.denyRole = true

    const res = await POST(request(TEMPLATE_BODY))

    expect(res.status).toBe(403)
    expect(h.resolveConversationByPhone).not.toHaveBeenCalled()
    expect(h.sendMessageToConversation).not.toHaveBeenCalled()
  })
})
