// ============================================================
// Public-API broadcast core.
//
// Splits a broadcast into two phases so the HTTP route can persist +
// acknowledge fast and fan out afterwards (in `after()`):
//
//   createBroadcast()  — validate, resolve contacts, insert the
//                        `broadcasts` row + `broadcast_recipients`
//                        rows (status 'pending'), return a plan.
//   deliverBroadcast() — send each recipient's template via Meta
//                        (phone-variant retry), stamp each recipient
//                        row + the aggregate counts, finalize status.
//
// Recipient rows carry `whatsapp_message_id`, so the inbound webhook's
// status handler updates delivered/read on the same stored WhatsApp channel.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import type { MessageTemplate } from '@/types';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';
import { findOrCreateContact } from '@/lib/api/v1/contacts';

/** Thrown by createBroadcast on a caller-visible failure; route maps it. */
export class BroadcastError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'BroadcastError';
    this.code = code;
    this.status = status;
  }
}

export interface BroadcastRecipientInput {
  /** E.164 phone. */
  to: string;
  /** Positional body params for the template ({{1}}, {{2}}…). */
  params?: string[];
}

export interface CreateBroadcastParams {
  name?: string | null;
  templateName: string;
  templateLanguage?: string | null;
  recipients: BroadcastRecipientInput[];
  /** Explicit WhatsApp channel. Alias handling belongs to the HTTP route. */
  channelId?: string | null;
  /**
   * Campaign-wide structured send-time values such as a media-header override.
   * Persisted atomically so Resume/Retry reproduces the original Meta payload.
   */
  templateMessageParams?: SendTimeParams | null;
}

interface PlannedRecipient {
  recipientRowId: string;
  phone: string;
  params: string[];
  messageParams?: SendTimeParams;
}

export interface BroadcastPlan {
  broadcastId: string;
  whatsappConfigId: string;
  templateName: string;
  templateLanguage: string;
  phoneNumberId: string;
  accessToken: string;
  templateRow: MessageTemplate | null;
  planned: PlannedRecipient[];
  /** Phones rejected up front (invalid E.164) — counted as failed. */
  rejected: number;
}

const MAX_RECIPIENTS = 1000;

type BroadcastChannel = {
  id: string;
  phone_number_id: string;
  access_token: string;
};

async function resolveBroadcastChannel(
  db: SupabaseClient,
  accountId: string,
  templateName: string,
  templateLanguage: string,
  requestedChannelId?: string | null,
): Promise<BroadcastChannel> {
  let channelId = requestedChannelId ?? null;

  if (!channelId) {
    // Legacy API callers did not send a channel. Preserve that convenience
    // only when the local template catalog makes the answer unambiguous.
    const { data: candidates, error: candidateError } = await db
      .from('message_templates')
      .select('whatsapp_config_id')
      .eq('account_id', accountId)
      .eq('name', templateName)
      .eq('language', templateLanguage)
      .not('whatsapp_config_id', 'is', null);
    if (candidateError) {
      throw new BroadcastError('internal', 'Failed to resolve broadcast channel', 500);
    }

    const unique = [
      ...new Set(
        (candidates ?? [])
          .map((row: { whatsapp_config_id?: string | null }) => row.whatsapp_config_id)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (unique.length > 1) {
      throw new BroadcastError(
        'channel_required',
        'This template is available on multiple WhatsApp channels. Supply channel_id.',
        409,
      );
    }
    if (unique.length === 1) channelId = unique[0];
  }

  if (!channelId) {
    // A pre-sync legacy caller has no template row to infer from. Primary is
    // the documented compatibility default; the template check below still
    // requires the catalog to be synced before the broadcast is persisted.
    const { data: primary, error: primaryError } = await db
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_primary', true)
      .maybeSingle();
    if (primaryError) {
      throw new BroadcastError('internal', 'Failed to resolve WhatsApp channel', 500);
    }
    channelId = primary?.id ?? null;
  }

  if (!channelId) {
    throw new BroadcastError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400,
    );
  }

  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('id,phone_number_id,access_token')
    .eq('account_id', accountId)
    .eq('id', channelId)
    .maybeSingle();
  if (configError || !config) {
    throw new BroadcastError('channel_not_found', 'WhatsApp channel not found for this account.', 404);
  }
  return config as BroadcastChannel;
}

/**
 * Validate + persist a broadcast, resolving each recipient to a
 * contact. Returns a plan for {@link deliverBroadcast}. Throws
 * {@link BroadcastError} on bad input / missing config / a malformed
 * template / a DB failure — nothing is sent in this phase.
 */
export async function createBroadcast(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  params: CreateBroadcastParams
): Promise<BroadcastPlan> {
  const { name, templateName, recipients } = params;

  if (!templateName) {
    throw new BroadcastError('bad_request', "'template_name' is required", 400);
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new BroadcastError(
      'bad_request',
      "'recipients' must be a non-empty array of { to, params? }",
      400
    );
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new BroadcastError(
      'bad_request',
      `A broadcast is capped at ${MAX_RECIPIENTS} recipients per request; split larger sends`,
      400
    );
  }

  const requestedLanguage = params.templateLanguage || 'en_US';
  const config = await resolveBroadcastChannel(
    db,
    accountId,
    templateName,
    requestedLanguage,
    params.channelId,
  );
  const accessToken = decrypt(config.access_token);

  // Template row (once) for header/button components. It must belong to the
  // selected channel; same-named templates on another WABA are not substitutes.
  const resolvedTemplate = await resolveTemplateRow(
    db,
    accountId,
    templateName,
    params.templateLanguage,
    config.id,
  );
  if (resolvedTemplate.malformed) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — sync this WhatsApp channel from Meta before broadcasting.',
      500
    );
  }
  if (!resolvedTemplate.row) {
    throw new BroadcastError(
      'template_not_found',
      'Template is not synced on the selected WhatsApp channel.',
      400,
    );
  }
  if (resolvedTemplate.row.status !== 'APPROVED') {
    throw new BroadcastError(
      'template_not_approved',
      `Template is ${resolvedTemplate.row.status} on the selected WhatsApp channel.`,
      409,
    );
  }
  const templateRow = resolvedTemplate.row;
  const templateMessageParams = params.templateMessageParams ?? {};

  // Resolve each recipient to a contact. Invalid phones are dropped
  // (counted as rejected) rather than aborting the whole broadcast.
  const resolved: { contactId: string; phone: string; params: string[] }[] = [];
  let rejected = 0;
  for (const r of recipients) {
    const sanitized = sanitizePhoneForMeta(typeof r.to === 'string' ? r.to : '');
    if (!isValidE164(sanitized)) {
      rejected++;
      continue;
    }
    const { id } = await findOrCreateContact(db, accountId, auditUserId, {
      phone: sanitized,
    });
    resolved.push({
      contactId: id,
      phone: sanitized,
      params: Array.isArray(r.params)
        ? r.params.filter((p): p is string => typeof p === 'string')
        : [],
    });
  }

  // Collapse recipients that resolved to the SAME contact. Keep the first
  // occurrence so a contact is messaged once and params remain deterministic.
  const seenContact = new Set<string>();
  const deduped = resolved.filter((r) => {
    if (seenContact.has(r.contactId)) return false;
    seenContact.add(r.contactId);
    return true;
  });

  if (deduped.length === 0) {
    throw new BroadcastError(
      'bad_request',
      'No recipients had a valid E.164 phone number',
      400
    );
  }

  // Migration 050 exposes one canonical atomic creation RPC. In addition to
  // the channel and frozen body params, it persists structured campaign-wide
  // send-time values so Resume/Retry cannot silently change media headers.
  const { data: createdRows, error: createErr } = await db.rpc(
    'create_broadcast_with_recipients',
    {
      p_account_id: accountId,
      p_user_id: auditUserId,
      p_name: name || `API broadcast (${templateName})`,
      p_template_name: templateName,
      p_template_language: resolvedTemplate.language,
      p_total_recipients: deduped.length,
      p_contact_ids: deduped.map((r) => r.contactId),
      p_template_params: deduped.map((r) => r.params),
      p_whatsapp_config_id: config.id,
      p_template_message_params: templateMessageParams,
    }
  );
  if (createErr || !createdRows || createdRows.length === 0) {
    console.error('[broadcast-core] create broadcast error:', createErr);
    throw new BroadcastError('internal', 'Failed to create broadcast', 500);
  }

  const broadcastId = createdRows[0].broadcast_id as string;

  const byContact = new Map(deduped.map((r) => [r.contactId, r]));
  const planned: PlannedRecipient[] = createdRows.map(
    (row: { recipient_id: string; contact_id: string }) => {
      const r = byContact.get(row.contact_id)!;
      return {
        recipientRowId: row.recipient_id,
        phone: r.phone,
        params: r.params,
        messageParams: templateMessageParams,
      };
    }
  );

  return {
    broadcastId,
    whatsappConfigId: config.id,
    templateName,
    templateLanguage: resolvedTemplate.language,
    phoneNumberId: config.phone_number_id,
    accessToken,
    templateRow,
    planned,
    rejected,
  };
}

/**
 * Fan out a {@link BroadcastPlan}: send each recipient's template
 * (phone-variant retry) and stamp its `broadcast_recipients` row.
 * Best-effort per recipient — one failure never aborts the rest.
 * Designed to run inside `after()`.
 */
export async function deliverBroadcast(
  db: SupabaseClient,
  plan: BroadcastPlan
): Promise<void> {
  for (const recipient of plan.planned) {
    const variants = phoneVariants(recipient.phone);
    let sentMessageId: string | null = null;
    let lastError: string | null = null;

    for (const variant of variants) {
      try {
        const result = await sendTemplateMessage({
          phoneNumberId: plan.phoneNumberId,
          accessToken: plan.accessToken,
          to: variant,
          templateName: plan.templateName,
          language: plan.templateLanguage,
          template: plan.templateRow ?? undefined,
          params: recipient.params,
          messageParams: recipient.messageParams,
        });
        sentMessageId = result.messageId;
        lastError = null;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        lastError = message;
        if (!isRecipientNotAllowedError(message)) break;
      }
    }

    if (sentMessageId) {
      await db
        .from('broadcast_recipients')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          whatsapp_message_id: sentMessageId,
          error_message: null,
        })
        .eq('id', recipient.recipientRowId)
        .eq('whatsapp_config_id', plan.whatsappConfigId);
    } else {
      await db
        .from('broadcast_recipients')
        .update({
          status: 'failed',
          error_message: lastError || 'Unknown error',
        })
        .eq('id', recipient.recipientRowId)
        .eq('whatsapp_config_id', plan.whatsappConfigId);
    }
  }

  await finalizeBroadcastStatus(db, plan.broadcastId);
}

/**
 * Flip a broadcast out of `sending` once no recipient is left pending.
 * Counts are derived from recipient rows; only the terminal status is written.
 */
export async function finalizeBroadcastStatus(
  db: SupabaseClient,
  broadcastId: string
): Promise<void> {
  const countWhere = async (status: string): Promise<number> => {
    const { count } = await db
      .from('broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', broadcastId)
      .eq('status', status);
    return count ?? 0;
  };

  if ((await countWhere('pending')) > 0) return;

  const failed = await countWhere('failed');
  const { count: total } = await db
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId);

  await db
    .from('broadcasts')
    .update({
      status: failed > 0 && failed === (total ?? 0) ? 'failed' : 'sent',
      updated_at: new Date().toISOString(),
    })
    .eq('id', broadcastId);
}