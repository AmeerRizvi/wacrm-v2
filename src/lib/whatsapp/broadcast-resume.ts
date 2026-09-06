// ============================================================
// Broadcast resume / retry (issue #472).
//
// A resumed campaign must use the exact WhatsApp channel stored on the
// broadcast. Changing the workspace primary after a campaign was created must
// never change the number used by Retry/Resume.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { BroadcastError, type BroadcastPlan } from '@/lib/whatsapp/broadcast-core';
import { decrypt } from '@/lib/whatsapp/encryption';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';

export type ResumeScope = 'pending' | 'failed' | 'all';

export const RESUME_SCOPES: readonly ResumeScope[] = [
  'pending',
  'failed',
  'all',
];

export const RESUME_MAX_PER_REQUEST = 1000;
export const DELIVERY_LOCK_STALE_MS = 30 * 60 * 1000;

function scopeStatuses(scope: ResumeScope): string[] {
  if (scope === 'pending') return ['pending'];
  if (scope === 'failed') return ['failed'];
  return ['pending', 'failed'];
}

export async function claimBroadcastDelivery(
  db: SupabaseClient,
  accountId: string,
  broadcastId: string,
  now: Date = new Date()
): Promise<boolean> {
  const staleCutoff = new Date(
    now.getTime() - DELIVERY_LOCK_STALE_MS
  ).toISOString();

  const { data, error } = await db
    .from('broadcasts')
    .update({ delivery_locked_at: now.toISOString() })
    .eq('id', broadcastId)
    .eq('account_id', accountId)
    .or(`delivery_locked_at.is.null,delivery_locked_at.lt.${staleCutoff}`)
    .select('id');

  if (error) {
    console.error('[broadcast-resume] claim failed:', error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

export async function releaseBroadcastDelivery(
  db: SupabaseClient,
  broadcastId: string
): Promise<void> {
  const { error } = await db
    .from('broadcasts')
    .update({ delivery_locked_at: null })
    .eq('id', broadcastId);
  if (error) {
    console.error('[broadcast-resume] release failed:', error.message);
  }
}

export interface ResumePlan {
  plan: BroadcastPlan;
  remaining: number;
  unsendable: number;
}

interface RecipientRow {
  id: string;
  template_params: unknown;
  whatsapp_config_id?: string | null;
  contact: { phone?: string | null } | { phone?: string | null }[] | null;
}

function contactPhone(row: RecipientRow): string | null {
  const c = Array.isArray(row.contact) ? row.contact[0] : row.contact;
  return c?.phone ?? null;
}

export async function planBroadcastResume(
  db: SupabaseClient,
  accountId: string,
  broadcastId: string,
  scope: ResumeScope
): Promise<ResumePlan> {
  const { data: broadcast, error: bcError } = await db
    .from('broadcasts')
    .select('id, template_name, template_language, whatsapp_config_id')
    .eq('id', broadcastId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (bcError || !broadcast) {
    throw new BroadcastError('not_found', 'Broadcast not found', 404);
  }
  if (!broadcast.whatsapp_config_id) {
    throw new BroadcastError(
      'channel_required',
      'This legacy broadcast is not bound to a WhatsApp channel and cannot be safely resumed.',
      409,
    );
  }

  const channelId = broadcast.whatsapp_config_id as string;
  const statuses = scopeStatuses(scope);
  const { data: rawRows, error: recError } = await db
    .from('broadcast_recipients')
    .select('id, template_params, whatsapp_config_id, contact:contacts(phone)')
    .eq('broadcast_id', broadcastId)
    .eq('whatsapp_config_id', channelId)
    .in('status', statuses)
    .order('created_at', { ascending: true });

  if (recError) {
    console.error('[broadcast-resume] recipient load failed:', recError.message);
    throw new BroadcastError('internal', 'Failed to load recipients', 500);
  }

  const rows = (rawRows ?? []) as RecipientRow[];
  const sendable: RecipientRow[] = [];
  const unsendable: string[] = [];
  for (const row of rows) {
    const sanitized = sanitizePhoneForMeta(contactPhone(row) ?? '');
    if (isValidE164(sanitized)) sendable.push(row);
    else unsendable.push(row.id);
  }
  if (unsendable.length > 0) {
    await db
      .from('broadcast_recipients')
      .update({
        status: 'failed',
        error_message: 'No valid phone number on contact',
      })
      .in('id', unsendable)
      .eq('whatsapp_config_id', channelId);
  }

  const slice = sendable.slice(0, RESUME_MAX_PER_REQUEST);
  const remaining = sendable.length - slice.length;

  if (slice.length === 0) {
    throw new BroadcastError(
      'nothing_to_resume',
      scope === 'failed'
        ? 'This broadcast has no failed recipients to retry'
        : 'This broadcast has no recipients left to send',
      400
    );
  }

  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('id,phone_number_id,access_token')
    .eq('account_id', accountId)
    .eq('id', channelId)
    .maybeSingle();
  if (configError || !config) {
    throw new BroadcastError(
      'whatsapp_not_configured',
      'The WhatsApp channel used by this broadcast is no longer configured.',
      400
    );
  }

  const resolvedTemplate = await resolveTemplateRow(
    db,
    accountId,
    broadcast.template_name,
    broadcast.template_language,
    channelId,
  );
  if (resolvedTemplate.malformed) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — sync this WhatsApp channel from Meta before resuming.',
      500
    );
  }
  if (!resolvedTemplate.row) {
    throw new BroadcastError(
      'template_not_found',
      'Template is no longer available on the WhatsApp channel used by this broadcast.',
      400,
    );
  }

  const plan: BroadcastPlan = {
    broadcastId,
    whatsappConfigId: channelId,
    templateName: broadcast.template_name,
    templateLanguage: resolvedTemplate.language,
    phoneNumberId: config.phone_number_id,
    accessToken: decrypt(config.access_token),
    templateRow: resolvedTemplate.row,
    planned: slice.map((row) => ({
      recipientRowId: row.id,
      phone: sanitizePhoneForMeta(contactPhone(row) ?? ''),
      params: Array.isArray(row.template_params)
        ? row.template_params.filter((p): p is string => typeof p === 'string')
        : [],
    })),
    rejected: 0,
  };

  return { plan, remaining, unsendable: unsendable.length };
}

export async function markBroadcastSending(
  db: SupabaseClient,
  broadcastId: string
): Promise<void> {
  await db
    .from('broadcasts')
    .update({ status: 'sending', updated_at: new Date().toISOString() })
    .eq('id', broadcastId);
}
