import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/api/v1/contacts', () => ({
  resolveAuditUserId: vi.fn(async () => 'owner-1'),
  ContactError: class ContactError extends Error {
    status = 500;
  },
}));

import { resolveConversationByPhone } from './resolve-conversation';
import { SendMessageError } from './send-message';

type ContactRow = { id: string; phone: string; name?: string | null };

interface Script {
  config?: { id: string } | null;
  contactCandidates?: ContactRow[];
  contactCandidatesByCall?: ContactRow[][];
  insertedContactId?: string;
  insertContactError?: { code?: string } | null;
  existingConversation?: { id: string } | null;
  existingConversationByCall?: (({ id: string } | null))[];
  insertedConversationId?: string;
  insertConversationError?: { code?: string } | null;
}

function makeDb(script: Script): SupabaseClient {
  let table = '';
  let mode: 'select' | 'insert' | 'update' = 'select';
  let likeCalls = 0;
  let convLookupCalls = 0;

  const builder: Record<string, unknown> = {
    select: () => builder,
    insert: () => {
      mode = 'insert';
      return builder;
    },
    update: () => {
      mode = 'update';
      return builder;
    },
    eq: () => builder,
    order: () => builder,
    limit: () => {
      if (table === 'conversations' && mode === 'select') {
        const row = script.existingConversationByCall
          ? (script.existingConversationByCall[convLookupCalls] ?? null)
          : (script.existingConversation ?? null);
        convLookupCalls++;
        return Promise.resolve({ data: row ? [row] : [], error: null });
      }
      return builder;
    },
    like: () => {
      const data = script.contactCandidatesByCall
        ? (script.contactCandidatesByCall[likeCalls] ?? [])
        : (script.contactCandidates ?? []);
      likeCalls++;
      return Promise.resolve({ data, error: null });
    },
    maybeSingle: () => {
      if (table === 'whatsapp_config') {
        return Promise.resolve({ data: script.config ?? null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    single: () => {
      if (table === 'contacts' && mode === 'insert') {
        if (script.insertContactError) {
          return Promise.resolve({ data: null, error: script.insertContactError });
        }
        return Promise.resolve({ data: { id: script.insertedContactId }, error: null });
      }
      if (table === 'conversations' && mode === 'insert') {
        if (script.insertConversationError) {
          return Promise.resolve({ data: null, error: script.insertConversationError });
        }
        return Promise.resolve({ data: { id: script.insertedConversationId }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    then: (resolve: (v: { data: null; error: null }) => void) =>
      resolve({ data: null, error: null }),
  };

  return {
    from: (t: string) => {
      table = t;
      mode = 'select';
      return builder;
    },
  } as unknown as SupabaseClient;
}

describe('resolveConversationByPhone', () => {
  it('rejects an invalid phone before any DB call', async () => {
    const db = {
      from() {
        throw new Error('should not query');
      },
    } as unknown as SupabaseClient;
    await expect(
      resolveConversationByPhone(db, 'acct', 'not-a-phone'),
    ).rejects.toBeInstanceOf(SendMessageError);
  });

  it('fails with whatsapp_not_configured when the account has no channel', async () => {
    const db = makeDb({ config: null });
    await expect(
      resolveConversationByPhone(db, 'acct', '+14155550123'),
    ).rejects.toMatchObject({ code: 'whatsapp_not_configured', status: 400 });
  });

  it('returns the existing contact + channel conversation without creating', async () => {
    const db = makeDb({
      config: { id: 'wa-1' },
      contactCandidates: [{ id: 'c1', phone: '14155550123' }],
      existingConversation: { id: 'cv1' },
    });
    const res = await resolveConversationByPhone(
      db,
      'acct',
      '+1 (415) 555-0123',
    );
    expect(res).toEqual({
      conversationId: 'cv1',
      contactId: 'c1',
      whatsappConfigId: 'wa-1',
      contactCreated: false,
    });
  });

  it('creates contact + conversation on the resolved channel', async () => {
    const db = makeDb({
      config: { id: 'wa-1' },
      contactCandidates: [],
      insertedContactId: 'c2',
      existingConversation: null,
      insertedConversationId: 'cv2',
    });
    const res = await resolveConversationByPhone(
      db,
      'acct',
      '+14155550199',
      'Jane',
    );
    expect(res).toEqual({
      conversationId: 'cv2',
      contactId: 'c2',
      whatsappConfigId: 'wa-1',
      contactCreated: true,
    });
  });

  it('uses an explicitly requested account channel', async () => {
    const db = makeDb({
      config: { id: 'wa-support' },
      contactCandidates: [{ id: 'c1', phone: '14155550123' }],
      existingConversation: { id: 'cv-support' },
    });
    const res = await resolveConversationByPhone(
      db,
      'acct',
      '+14155550123',
      null,
      'wa-support',
    );
    expect(res.whatsappConfigId).toBe('wa-support');
    expect(res.conversationId).toBe('cv-support');
  });

  it('re-resolves an existing contact when insert loses a unique race', async () => {
    const db = makeDb({
      config: { id: 'wa-1' },
      contactCandidatesByCall: [[], [{ id: 'c-raced', phone: '14155550123' }]],
      insertContactError: { code: '23505' },
      existingConversation: { id: 'cv-raced' },
    });
    const res = await resolveConversationByPhone(db, 'acct', '+14155550123');
    expect(res.contactId).toBe('c-raced');
    expect(res.contactCreated).toBe(false);
    expect(res.conversationId).toBe('cv-raced');
    expect(res.whatsappConfigId).toBe('wa-1');
  });

  it('re-resolves the channel conversation when insert loses a unique race', async () => {
    const db = makeDb({
      config: { id: 'wa-1' },
      contactCandidates: [{ id: 'c1', phone: '14155550123' }],
      existingConversationByCall: [null, { id: 'cv-raced' }],
      insertConversationError: { code: '23505' },
    });
    const res = await resolveConversationByPhone(db, 'acct', '+14155550123');
    expect(res).toEqual({
      conversationId: 'cv-raced',
      contactId: 'c1',
      whatsappConfigId: 'wa-1',
      contactCreated: false,
    });
  });
});
