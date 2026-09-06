import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BroadcastError } from './broadcast-core';
import {
  claimBroadcastDelivery,
  planBroadcastResume,
  releaseBroadcastDelivery,
  RESUME_MAX_PER_REQUEST,
} from './broadcast-resume';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `decrypted:${v}`,
}));
vi.mock('@/lib/whatsapp/template-body', () => ({
  resolveTemplateRow: vi.fn(async () => ({
    row: {
      id: 'tpl-1',
      user_id: 'u-1',
      name: 'order_update',
      language: 'en_US',
      category: 'Utility',
      body_text: 'Your order {{1}} ships on {{2}}',
      created_at: '2026-01-01T00:00:00Z',
    },
    language: 'en_US',
    malformed: false,
  })),
}));

interface ClaimCall {
  update: Record<string, unknown>;
  filters: Record<string, unknown>;
  or?: string;
}

function claimDb(returnedRows: unknown[], calls: ClaimCall[]): SupabaseClient {
  return {
    from() {
      const call: ClaimCall = { update: {}, filters: {} };
      const b: Record<string, unknown> = {
        update: (row: Record<string, unknown>) => {
          call.update = row;
          calls.push(call);
          return b;
        },
        eq: (col: string, val: unknown) => {
          call.filters[col] = val;
          return b;
        },
        or: (expr: string) => {
          call.or = expr;
          return b;
        },
        select: async () => ({ data: returnedRows, error: null }),
        then: (resolve: (r: { error: null }) => unknown) =>
          resolve({ error: null }),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

describe('claim/release broadcast delivery', () => {
  it('claims only inside the account and uses the stale-lock cutoff', async () => {
    const calls: ClaimCall[] = [];
    const ok = await claimBroadcastDelivery(
      claimDb([{ id: 'bc-1' }], calls),
      'acct-1',
      'bc-1',
      new Date('2026-08-11T12:00:00Z'),
    );
    expect(ok).toBe(true);
    expect(calls[0].filters).toEqual({ id: 'bc-1', account_id: 'acct-1' });
    expect(calls[0].or).toBe(
      'delivery_locked_at.is.null,delivery_locked_at.lt.2026-08-11T11:30:00.000Z',
    );
  });

  it('refuses when another pass already holds the lock', async () => {
    expect(await claimBroadcastDelivery(claimDb([], []), 'acct-1', 'bc-1')).toBe(false);
  });

  it('clears the lock', async () => {
    const calls: ClaimCall[] = [];
    await releaseBroadcastDelivery(claimDb([], calls), 'bc-1');
    expect(calls[0].update).toEqual({ delivery_locked_at: null });
    expect(calls[0].filters).toEqual({ id: 'bc-1' });
  });
});

interface PlanFixture {
  broadcast?: Record<string, unknown> | null;
  recipients?: Record<string, unknown>[];
  config?: Record<string, unknown> | null;
}

interface PlanWrites {
  statusFilter?: unknown;
  channelFilters: unknown[];
  failedIds?: unknown;
  failedUpdate?: Record<string, unknown>;
}

function planDb(
  fx: PlanFixture,
  writes: PlanWrites = { channelFilters: [] },
): SupabaseClient {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, value: unknown) => {
          if (col === 'whatsapp_config_id') writes.channelFilters.push(value);
          return b;
        },
        order: () => b,
        in: (col: string, vals: unknown) => {
          if (col === 'status') writes.statusFilter = vals;
          if (col === 'id') writes.failedIds = vals;
          return b;
        },
        update: (row: Record<string, unknown>) => {
          writes.failedUpdate = row;
          return b;
        },
        maybeSingle: async () => {
          if (table === 'broadcasts') {
            return { data: fx.broadcast === undefined ? null : fx.broadcast, error: null };
          }
          if (table === 'whatsapp_config') {
            return { data: fx.config === undefined ? null : fx.config, error: null };
          }
          return { data: null, error: null };
        },
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) => {
          if (table === 'broadcast_recipients') {
            return resolve({ data: fx.recipients ?? [], error: null });
          }
          return resolve({ data: [], error: null });
        },
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

const BROADCAST = {
  id: 'bc-1',
  template_name: 'order_update',
  template_language: 'en_US',
  whatsapp_config_id: 'wa-1',
};
const CONFIG = {
  id: 'wa-1',
  phone_number_id: 'pn-1',
  access_token: 'tok',
};

function recipient(id: string, phone: string | null, params: unknown = ['A123']) {
  return {
    id,
    whatsapp_config_id: 'wa-1',
    template_params: params,
    contact: phone ? { phone } : null,
  };
}

describe('planBroadcastResume', () => {
  it('reconstructs the plan from the broadcast stored channel', async () => {
    const writes: PlanWrites = { channelFilters: [] };
    const { plan, remaining, unsendable } = await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [
            recipient('r1', '+15551234567', ['A123', 'Friday']),
            recipient('r2', '+15559876543', ['B456', 'Monday']),
          ],
        },
        writes,
      ),
      'acct-1',
      'bc-1',
      'pending',
    );

    expect(writes.statusFilter).toEqual(['pending']);
    expect(writes.channelFilters).toContain('wa-1');
    expect(plan.whatsappConfigId).toBe('wa-1');
    expect(plan.phoneNumberId).toBe('pn-1');
    expect(plan.accessToken).toBe('decrypted:tok');
    expect(plan.planned).toEqual([
      { recipientRowId: 'r1', phone: '15551234567', params: ['A123', 'Friday'] },
      { recipientRowId: 'r2', phone: '15559876543', params: ['B456', 'Monday'] },
    ]);
    expect(remaining).toBe(0);
    expect(unsendable).toBe(0);
  });

  it('refuses a legacy broadcast with no stored channel instead of guessing primary', async () => {
    await expect(
      planBroadcastResume(
        planDb({
          broadcast: { ...BROADCAST, whatsapp_config_id: null },
          config: CONFIG,
          recipients: [recipient('r1', '+15551234567')],
        }),
        'acct-1',
        'bc-1',
        'pending',
      ),
    ).rejects.toMatchObject({ code: 'channel_required', status: 409 });
  });

  it('scopes retry status correctly', async () => {
    const failedWrites: PlanWrites = { channelFilters: [] };
    await planBroadcastResume(
      planDb(
        { broadcast: BROADCAST, config: CONFIG, recipients: [recipient('r1', '+15551234567')] },
        failedWrites,
      ),
      'acct-1',
      'bc-1',
      'failed',
    );
    expect(failedWrites.statusFilter).toEqual(['failed']);

    const allWrites: PlanWrites = { channelFilters: [] };
    await planBroadcastResume(
      planDb(
        { broadcast: BROADCAST, config: CONFIG, recipients: [recipient('r1', '+15551234567')] },
        allWrites,
      ),
      'acct-1',
      'bc-1',
      'all',
    );
    expect(allWrites.statusFilter).toEqual(['pending', 'failed']);
  });

  it('treats malformed params as empty and fails unsendable contacts', async () => {
    const writes: PlanWrites = { channelFilters: [] };
    const { plan, unsendable } = await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [
            recipient('r1', '+15551234567', null),
            recipient('r2', null),
            recipient('r3', 'nonsense'),
          ],
        },
        writes,
      ),
      'acct-1',
      'bc-1',
      'pending',
    );
    expect(plan.planned[0].params).toEqual([]);
    expect(unsendable).toBe(2);
    expect(writes.failedIds).toEqual(['r2', 'r3']);
    expect(writes.failedUpdate?.status).toBe('failed');
  });

  it('caps one pass and reports the leftover', async () => {
    const many = Array.from({ length: RESUME_MAX_PER_REQUEST + 25 }, (_, i) =>
      recipient(`r${i}`, '+1555000' + String(i).padStart(4, '0')),
    );
    const { plan, remaining } = await planBroadcastResume(
      planDb({ broadcast: BROADCAST, config: CONFIG, recipients: many }),
      'acct-1',
      'bc-1',
      'pending',
    );
    expect(plan.planned).toHaveLength(RESUME_MAX_PER_REQUEST);
    expect(remaining).toBe(25);
  });

  it('404s a broadcast that is not on this account', async () => {
    await expect(
      planBroadcastResume(planDb({ broadcast: null }), 'acct-1', 'bc-1', 'pending'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses when there is nothing outstanding', async () => {
    await expect(
      planBroadcastResume(
        planDb({ broadcast: BROADCAST, config: CONFIG, recipients: [] }),
        'acct-1',
        'bc-1',
        'failed',
      ),
    ).rejects.toBeInstanceOf(BroadcastError);
  });
});
