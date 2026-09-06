import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from './template-webhook';

type RecordedCall = {
  table: string;
  select?: string;
  update?: Record<string, unknown>;
  eq: { column: string; value: unknown }[];
  in?: { column: string; values: unknown[] };
};

function makeSupabaseStub(options?: {
  channels?: { id: string }[];
  updatedRows?: { id: string }[];
}) {
  const calls: RecordedCall[] = [];
  const channels = options?.channels ?? [{ id: 'channel-1' }, { id: 'channel-2' }];
  const updatedRows = options?.updatedRows ?? [{ id: 'template-1' }];

  const stub = {
    from(table: string) {
      const call: RecordedCall = { table, eq: [] };
      calls.push(call);

      if (table === 'whatsapp_config') {
        const q: Record<string, unknown> = {
          select(columns: string) {
            call.select = columns;
            return q;
          },
          eq(column: string, value: unknown) {
            call.eq.push({ column, value });
            return q;
          },
          then(resolve: (value: { data: { id: string }[]; error: null }) => unknown) {
            return Promise.resolve({ data: channels, error: null }).then(resolve);
          },
        };
        return q;
      }

      if (table === 'message_templates') {
        const q: Record<string, unknown> = {
          update(payload: Record<string, unknown>) {
            call.update = payload;
            return q;
          },
          eq(column: string, value: unknown) {
            call.eq.push({ column, value });
            return q;
          },
          in(column: string, values: unknown[]) {
            call.in = { column, values };
            return q;
          },
          select(columns: string) {
            call.select = columns;
            return Promise.resolve({ data: updatedRows, error: null });
          },
          then(resolve: (value: { error: null }) => unknown) {
            return Promise.resolve({ error: null }).then(resolve);
          },
        };
        return q;
      }

      throw new Error(`unexpected table ${table}`);
    },
  };

  return { stub: stub as unknown as SupabaseClient, calls };
}

describe('isTemplateWebhookField', () => {
  it('recognises the three template fields', () => {
    expect(isTemplateWebhookField('message_template_status_update')).toBe(true);
    expect(isTemplateWebhookField('message_template_quality_update')).toBe(true);
    expect(isTemplateWebhookField('message_template_components_update')).toBe(true);
  });

  it('rejects messaging fields', () => {
    expect(isTemplateWebhookField('messages')).toBe(false);
    expect(isTemplateWebhookField('message_status')).toBe(false);
  });
});

describe('handleTemplateWebhookChange', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('requires WABA context instead of updating globally by template id', async () => {
    const warn = vi.spyOn(console, 'warn');
    const { stub, calls } = makeSupabaseStub();

    await handleTemplateWebhookChange(
      {
        field: 'message_template_status_update',
        value: { event: 'APPROVED', message_template_id: '123' },
      },
      stub,
    );

    expect(calls).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it('updates only local copies belonging to the webhook WABA', async () => {
    const { stub, calls } = makeSupabaseStub();

    await handleTemplateWebhookChange(
      {
        field: 'message_template_status_update',
        value: {
          event: 'APPROVED',
          message_template_id: 12345,
          message_template_name: 'order_confirmation',
        },
      },
      stub,
      'waba-1',
    );

    expect(calls[0]).toMatchObject({
      table: 'whatsapp_config',
      eq: [{ column: 'waba_id', value: 'waba-1' }],
    });
    expect(calls[1].table).toBe('message_templates');
    expect(calls[1].eq).toContainEqual({ column: 'meta_template_id', value: '12345' });
    expect(calls[1].in).toEqual({
      column: 'whatsapp_config_id',
      values: ['channel-1', 'channel-2'],
    });
    expect(calls[1].update).toEqual({
      status: 'APPROVED',
      rejection_reason: null,
      submission_error: null,
    });
  });

  it('persists rejection reason and normalises status within the WABA', async () => {
    const { stub, calls } = makeSupabaseStub();
    await handleTemplateWebhookChange(
      {
        field: 'message_template_status_update',
        value: {
          event: 'REJECTED',
          message_template_id: 'TMPL_99',
          reason: 'Template uses non-compliant language.',
        },
      },
      stub,
      'waba-1',
    );
    expect(calls[1].update?.status).toBe('REJECTED');
    expect(calls[1].update?.rejection_reason).toBe(
      'Template uses non-compliant language.',
    );

    const second = makeSupabaseStub();
    await handleTemplateWebhookChange(
      {
        field: 'message_template_status_update',
        value: { event: 'PENDING_REVIEW', message_template_id: '1' },
      },
      second.stub,
      'waba-1',
    );
    expect(second.calls[1].update?.status).toBe('PENDING');
  });

  it('does not write when the WABA is not configured locally', async () => {
    const warn = vi.spyOn(console, 'warn');
    const { stub, calls } = makeSupabaseStub({ channels: [] });
    await handleTemplateWebhookChange(
      {
        field: 'message_template_status_update',
        value: { event: 'APPROVED', message_template_id: '1' },
      },
      stub,
      'unknown-waba',
    );
    expect(calls).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
  });

  it('scopes quality updates to all channel copies in the same WABA', async () => {
    const { stub, calls } = makeSupabaseStub();
    await handleTemplateWebhookChange(
      {
        field: 'message_template_quality_update',
        value: {
          message_template_id: '99',
          previous_quality_score: 'GREEN',
          new_quality_score: 'YELLOW',
        },
      },
      stub,
      'waba-1',
    );
    expect(calls[1].update).toEqual({ quality_score: 'YELLOW' });
    expect(calls[1].in?.values).toEqual(['channel-1', 'channel-2']);
  });

  it('components update is an info-log no-op', async () => {
    const info = vi.spyOn(console, 'info');
    const { stub, calls } = makeSupabaseStub();
    await handleTemplateWebhookChange(
      {
        field: 'message_template_components_update',
        value: { message_template_id: '5', message_template_name: 'x' },
      },
      stub,
      'waba-1',
    );
    // Components events do not need a DB query; sync pulls the full catalog.
    expect(calls).toHaveLength(0);
    expect(info).toHaveBeenCalled();
  });
});
