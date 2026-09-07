// ============================================================
// Read-only tools — always registered.
//
// whoami + list/read of contacts, conversations, messages, and
// broadcast status. None of these change state, so they're safe to
// expose unconditionally. Each carries readOnlyHint so clients can
// surface them without a confirmation prompt.
// ============================================================

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WacrmClient } from '../client.js';
import { handle, jsonResult } from './shared.js';

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

export function registerReadTools(server: McpServer, client: WacrmClient): void {
  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description:
        'Verify the API key and show its wacrm account, scopes, and safe WhatsApp channel metadata (channel UUID, label, phone_number_id, status, primary flag). Call this first when a write needs an explicit channel_id.',
      inputSchema: {},
      annotations: { ...READ_ONLY, title: 'Who am I' },
    },
    handle(async () => jsonResult(await client.me())),
  );

  server.registerTool(
    'list_contacts',
    {
      title: 'List contacts',
      description:
        'List contacts in the CRM, newest first. Optionally filter by a free-text search (matches name or phone) or by a tag id. Results are paginated: pass the returned next_cursor to fetch the next page.',
      inputSchema: {
        search: z.string().optional().describe('Free-text search over name or phone number.'),
        tag: z.string().optional().describe('Tag id to filter by.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Page size, 1–100 (default 50).'),
        cursor: z.string().optional().describe('Opaque pagination cursor from a previous response.'),
      },
      annotations: { ...READ_ONLY, title: 'List contacts' },
    },
    handle(async (args) => jsonResult(await client.listContacts(args))),
  );

  server.registerTool(
    'get_contact',
    {
      title: 'Get contact',
      description: 'Read a single contact by its id.',
      inputSchema: {
        id: z.string().describe('Contact id.'),
      },
      annotations: { ...READ_ONLY, title: 'Get contact' },
    },
    handle(async ({ id }) => jsonResult(await client.getContact(id))),
  );

  server.registerTool(
    'list_conversations',
    {
      title: 'List conversations',
      description:
        'List conversations, newest first. Optionally filter by status (open / pending / closed), contact id, or WhatsApp channel id. Paginated. Returned conversations include channel_id.',
      inputSchema: {
        status: z.enum(['open', 'pending', 'closed']).optional().describe('Conversation status filter.'),
        contact_id: z.string().optional().describe('Only conversations for this contact.'),
        channel_id: z
          .string()
          .uuid()
          .optional()
          .describe('Only conversations owned by this WhatsApp channel UUID.'),
        limit: z.number().int().min(1).max(100).optional().describe('Page size, 1–100 (default 50).'),
        cursor: z.string().optional().describe('Opaque pagination cursor.'),
      },
      annotations: { ...READ_ONLY, title: 'List conversations' },
    },
    handle(async (args) => jsonResult(await client.listConversations(args))),
  );

  server.registerTool(
    'get_conversation',
    {
      title: 'Get conversation',
      description: 'Read a single conversation by id, including its contact, tags, and channel_id.',
      inputSchema: {
        id: z.string().describe('Conversation id.'),
      },
      annotations: { ...READ_ONLY, title: 'Get conversation' },
    },
    handle(async ({ id }) => jsonResult(await client.getConversation(id))),
  );

  server.registerTool(
    'list_messages',
    {
      title: 'List messages',
      description:
        'List the messages in a conversation, newest first. Each message includes its channel_id, direction (inbound/outbound), delivery status, and content. Paginated.',
      inputSchema: {
        conversation_id: z.string().describe('The conversation to read messages from.'),
        limit: z.number().int().min(1).max(100).optional().describe('Page size, 1–100 (default 50).'),
        cursor: z.string().optional().describe('Opaque pagination cursor.'),
      },
      annotations: { ...READ_ONLY, title: 'List messages' },
    },
    handle(async ({ conversation_id, limit, cursor }) =>
      jsonResult(await client.listConversationMessages(conversation_id, { limit, cursor })),
    ),
  );

  server.registerTool(
    'get_broadcast',
    {
      title: 'Get broadcast status',
      description:
        'Read a broadcast campaign by id — including its channel_id, status and delivered / read / rejected counts. Use this to poll progress after launching one.',
      inputSchema: {
        id: z.string().describe('Broadcast id.'),
      },
      annotations: { ...READ_ONLY, title: 'Get broadcast status' },
    },
    handle(async ({ id }) => jsonResult(await client.getBroadcast(id))),
  );
}
