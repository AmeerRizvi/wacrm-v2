import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  runAutomationsForTrigger: vi.fn(),
  dispatchInboundToFlows: vi.fn(),
  dispatchInboundToAiReply: vi.fn(),
  dispatchWebhookEvent: vi.fn(),
  state: {
    messageUpsertResult: [{ id: 'msg-1' }] as { id: string }[],
    priorCustomerMsgCount: 0,
    replyContextParent: null as { id: string } | null,
    conversation: {
      id: 'conv-1',
      unread_count: 0,
      account_id: 'acc-1',
      contact_id: 'contact-1',
      whatsapp_config_id: 'cfg-1',
      status: 'open',
    },
    mirrorInboundMedia: true as boolean | undefined,
    upsertCalls: [] as { row: Record<string, unknown>; options: unknown }[],
    updateCalls: [] as {
      table: string
      row: Record<string, unknown>
      filters: Array<[string, unknown]>
    }[],
    rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
    afterCallbacks: [] as (() => Promise<void> | void)[],
    storageUploads: [] as { bucket: string; path: string }[],
    storageUploadError: null as { message: string } | null,
  },
}))

vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => h.state.afterCallbacks.push(cb),
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, init }),
  },
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => {
    function builder(table: string) {
      let mode: 'select' | 'upsert' | 'update' | 'delete' = 'select'
      let payload: Record<string, unknown> = {}
      let selectOptions: { head?: boolean } | undefined
      const filters: Array<[string, unknown]> = []

      const result = () => {
        if (table === 'whatsapp_config') {
          return {
            data: {
              id: 'cfg-1',
              account_id: 'acc-1',
              user_id: 'user-1',
              phone_number_id: 'pn-1',
              access_token: 'enc',
              mirror_inbound_media: h.state.mirrorInboundMedia,
            },
            error: null,
          }
        }
        if (table === 'conversations') {
          return { data: [h.state.conversation], error: null }
        }
        if (table === 'broadcast_recipients') {
          return { data: [], error: null }
        }
        if (table === 'messages') {
          if (mode === 'upsert') {
            return { data: h.state.messageUpsertResult, error: null }
          }
          if (selectOptions?.head) {
            return {
              data: null,
              count: h.state.priorCustomerMsgCount,
              error: null,
            }
          }
          return { data: h.state.replyContextParent, error: null }
        }
        return { data: null, error: null }
      }

      const b: Record<string, unknown> = {
        select: (_columns?: string, options?: { head?: boolean }) => {
          selectOptions = options
          return b
        },
        eq: (column: string, value: unknown) => {
          filters.push([column, value])
          return b
        },
        is: (column: string, value: unknown) => {
          filters.push([column, value])
          return b
        },
        in: () => b,
        order: () => b,
        limit: () => b,
        upsert: (row: Record<string, unknown>, options: unknown) => {
          mode = 'upsert'
          payload = row
          h.state.upsertCalls.push({ row, options })
          return b
        },
        update: (row: Record<string, unknown>) => {
          mode = 'update'
          payload = row
          const call = { table, row, filters }
          h.state.updateCalls.push(call)
          return b
        },
        delete: () => {
          mode = 'delete'
          return b
        },
        maybeSingle: async () => {
          const r = result()
          if (table === 'conversations' && Array.isArray(r.data)) {
            return { ...r, data: r.data[0] ?? null }
          }
          return r
        },
        single: async () => {
          const r = result()
          if (Array.isArray(r.data)) return { ...r, data: r.data[0] ?? null }
          return r
        },
        then: (
          onFulfilled: (value: ReturnType<typeof result>) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => Promise.resolve(result()).then(onFulfilled, onRejected),
      }
      void payload
      return b
    }

    return {
      from: (table: string) => builder(table),
      rpc: (name: string, args: Record<string, unknown>) => {
        h.state.rpcCalls.push({ name, args })
        return Promise.resolve({ data: null, error: null })
      },
      storage: {
        from(bucket: string) {
          return {
            upload: (path: string) => {
              h.state.storageUploads.push({ bucket, path })
              return Promise.resolve({ error: h.state.storageUploadError })
            },
            getPublicUrl: (path: string) => ({
              data: { publicUrl: `https://cdn.test/${bucket}/${path}` },
            }),
          }
        },
      },
    }
  },
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'plain-token',
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}))

vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
}))

vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(async () => ({
    id: 'contact-1',
    name: 'Ada',
    phone: '15551230000',
  })),
  isUniqueViolation: () => false,
}))

vi.mock('@/lib/whatsapp/webhook-signature', () => ({
  verifyMetaWebhookSignature: () => true,
}))
vi.mock('@/lib/whatsapp/template-webhook', () => ({
  isTemplateWebhookField: () => false,
  handleTemplateWebhookChange: vi.fn(),
}))
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.runAutomationsForTrigger,
}))
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: h.dispatchInboundToFlows,
}))
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: h.dispatchInboundToAiReply,
}))
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: h.dispatchWebhookEvent,
}))

import { POST } from './route'
import { downloadMedia, getMediaUrl } from '@/lib/whatsapp/meta-api'

const mockGetMediaUrl = vi.mocked(getMediaUrl)
const mockDownloadMedia = vi.mocked(downloadMedia)

const TEXT_MESSAGE = {
  id: 'wamid.TEST1',
  from: '15551230000',
  timestamp: '1700000000',
  type: 'text',
  text: { body: 'hello' },
}

function inboundRequest(message: Record<string, unknown> = TEXT_MESSAGE) {
  return {
    text: async () =>
      JSON.stringify({
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: 'pn-1' },
                  contacts: [
                    { wa_id: '15551230000', profile: { name: 'Ada' } },
                  ],
                  messages: [message],
                },
              },
            ],
          },
        ],
      }),
    headers: { get: () => 'sha256=stub' },
  } as unknown as Request
}

async function runWebhook(message?: Record<string, unknown>) {
  const response = await POST(inboundRequest(message))
  for (const cb of h.state.afterCallbacks) await cb()
  return response
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.messageUpsertResult = [{ id: 'msg-1' }]
  h.state.priorCustomerMsgCount = 0
  h.state.replyContextParent = null
  h.state.mirrorInboundMedia = true
  h.state.upsertCalls = []
  h.state.updateCalls = []
  h.state.rpcCalls = []
  h.state.afterCallbacks = []
  h.state.storageUploads = []
  h.state.storageUploadError = null
  h.dispatchInboundToFlows.mockResolvedValue({ consumed: false })
  h.dispatchInboundToAiReply.mockResolvedValue(undefined)
  h.dispatchWebhookEvent.mockResolvedValue(undefined)
  h.runAutomationsForTrigger.mockResolvedValue(undefined)
  mockGetMediaUrl.mockResolvedValue({
    url: 'https://lookaside.fbsbx.com/whatsapp/abc',
    mimeType: 'image/jpeg',
    fileSize: 2048,
  })
  mockDownloadMedia.mockResolvedValue({
    buffer: Buffer.alloc(2048),
    contentType: 'image/jpeg',
  })
})

describe('inbound webhook — channel routing', () => {
  it('persists and fans out the receiving WhatsApp channel', async () => {
    await runWebhook()

    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.upsertCalls[0].row).toMatchObject({
      conversation_id: 'conv-1',
      whatsapp_config_id: 'cfg-1',
      message_id: 'wamid.TEST1',
    })
    expect(h.dispatchInboundToFlows).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1' }),
    )
    expect(h.runAutomationsForTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc-1',
        context: expect.objectContaining({
          conversation_id: 'conv-1',
          channel_id: 'cfg-1',
        }),
      }),
    )
    expect(h.dispatchWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      'acc-1',
      'message.received',
      expect.objectContaining({
        conversation_id: 'conv-1',
        channel_id: 'cfg-1',
      }),
    )
  })

  it('keeps a replay idempotent and does not fan out again', async () => {
    h.state.messageUpsertResult = []

    await runWebhook()

    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled()
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()
  })
})

describe('inbound webhook — media channel identity', () => {
  const IMAGE_MESSAGE = {
    id: 'wamid.IMG1',
    from: '15551230000',
    timestamp: '1700000000',
    type: 'image',
    image: {
      id: '1234567890123456',
      mime_type: 'image/jpeg',
      caption: 'hi',
    },
  }

  it('stores durable mirrored media when mirroring succeeds', async () => {
    await runWebhook(IMAGE_MESSAGE)

    expect(h.state.storageUploads).toHaveLength(1)
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url:
        'https://cdn.test/chat-media/account-acc-1/inbound/1234567890123456-image-1700000000.jpg',
      media_type: 'image/jpeg',
      whatsapp_config_id: 'cfg-1',
    })
  })

  it('binds the fallback proxy URL to the receiving channel', async () => {
    h.state.storageUploadError = { message: 'storage unavailable' }

    await runWebhook(IMAGE_MESSAGE)

    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: '/api/whatsapp/media/1234567890123456?channel_id=cfg-1',
      whatsapp_config_id: 'cfg-1',
    })
  })

  it('also binds proxy URLs when mirroring is disabled', async () => {
    h.state.mirrorInboundMedia = false

    await runWebhook(IMAGE_MESSAGE)

    expect(mockDownloadMedia).not.toHaveBeenCalled()
    expect(h.state.storageUploads).toHaveLength(0)
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: '/api/whatsapp/media/1234567890123456?channel_id=cfg-1',
    })
  })
})
