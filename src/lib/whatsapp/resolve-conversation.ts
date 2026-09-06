// ============================================================
// Resolve (or create) the conversation for a phone number.
//
// The dashboard composer always has a `conversation_id` in hand. The
// public API doesn't — an external automation knows a *phone number*,
// not an internal UUID. This helper bridges that: given an E.164
// phone, it finds-or-creates the contact and its channel-scoped
// conversation so the shared `sendMessageToConversation` core can run.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';
import { SendMessageError } from '@/lib/whatsapp/send-message';
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts';

export interface ResolvedConversation {
  conversationId: string;
  contactId: string;
  /** WhatsApp channel/config this conversation is bound to. */
  whatsappConfigId: string;
  /** True if this call created the contact (vs matched an existing one). */
  contactCreated: boolean;
}

/**
 * Find or create the contact + conversation for `phone` within
 * `accountId`.
 *
 * `whatsappConfigId` is optional for backwards compatibility. When omitted,
 * the account's primary WhatsApp channel is used. This keeps the current
 * public API behaviour deterministic while allowing callers to explicitly
 * select a number once the v1 request surface exposes channel selection.
 */
export async function resolveConversationByPhone(
  db: SupabaseClient,
  accountId: string,
  phone: string,
  name?: string | null,
  whatsappConfigId?: string | null
): Promise<ResolvedConversation> {
  const sanitized = sanitizePhoneForMeta(phone);
  if (!isValidE164(sanitized)) {
    throw new SendMessageError(
      'bad_request',
      "'to' must be a valid phone number in E.164 format (e.g. +14155550123)",
      400
    );
  }

  // Resolve the channel before creating any rows. Explicit selection must
  // belong to the current account. Without one, use the primary channel.
  // A tiny compatibility fallback selects the oldest config for databases
  // in the narrow deployment window where app code lands before migration
  // 040 has marked a primary row.
  let config: { id: string } | null = null;

  if (whatsappConfigId) {
    const { data, error } = await db
      .from('whatsapp_config')
      .select('id')
      .eq('id', whatsappConfigId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) {
      throw new SendMessageError('db_error', 'Failed to resolve WhatsApp channel', 500);
    }
    config = data;
  } else {
    const { data: primary, error: primaryError } = await db
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_primary', true)
      .maybeSingle();

    if (primaryError) {
      throw new SendMessageError('db_error', 'Failed to resolve WhatsApp channel', 500);
    }
    config = primary;

    if (!config) {
      const { data: fallback, error: fallbackError } = await db
        .from('whatsapp_config')
        .select('id')
        .eq('account_id', accountId)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (fallbackError) {
        throw new SendMessageError('db_error', 'Failed to resolve WhatsApp channel', 500);
      }
      config = fallback;
    }
  }

  if (!config) {
    throw new SendMessageError(
      whatsappConfigId ? 'whatsapp_channel_not_found' : 'whatsapp_not_configured',
      whatsappConfigId
        ? 'WhatsApp channel not found for this account.'
        : 'WhatsApp not configured. Please set up your WhatsApp integration first.',
      whatsappConfigId ? 404 : 400
    );
  }

  let ownerUserId: string;
  try {
    ownerUserId = await resolveAuditUserId(db, accountId);
  } catch (err) {
    if (err instanceof ContactError) {
      throw new SendMessageError('db_error', err.message, err.status);
    }
    throw err;
  }

  // ---- contact -------------------------------------------------
  // Contacts stay account-scoped rather than channel-scoped. A customer
  // who messages Sales and Support is one CRM contact with independent
  // conversations on each WhatsApp channel.
  let contactId: string;
  let contactCreated = false;

  const existing = await findExistingContact(db, accountId, sanitized);
  if (existing) {
    contactId = existing.id;
    if (name && name !== existing.name) {
      await db
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
    }
  } else {
    const { data: created, error: createErr } = await db
      .from('contacts')
      .insert({
        account_id: accountId,
        user_id: ownerUserId,
        phone: sanitized,
        name: name || sanitized,
      })
      .select('id')
      .single();

    if (createErr || !created) {
      if (isUniqueViolation(createErr)) {
        const raced = await findExistingContact(db, accountId, sanitized);
        if (raced) {
          contactId = raced.id;
        } else {
          throw new SendMessageError('db_error', 'Failed to create contact', 500);
        }
      } else {
        console.error('[resolve-conversation] contact create error:', createErr);
        throw new SendMessageError('db_error', 'Failed to create contact', 500);
      }
    } else {
      contactId = created.id;
      contactCreated = true;
    }
  }

  // ---- conversation -------------------------------------------
  const conversationId = await findOrCreateConversationRow(
    db,
    accountId,
    contactId,
    ownerUserId,
    config.id
  );

  return {
    conversationId,
    contactId,
    whatsappConfigId: config.id,
    contactCreated,
  };
}

/**
 * Find (oldest-first) or create the single conversation for
 * `(accountId, contactId, whatsappConfigId)`. Handles the unique-index
 * race by re-resolving the winning row after a 23505.
 */
async function findOrCreateConversationRow(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  ownerUserId: string,
  whatsappConfigId: string
): Promise<string> {
  const { data: existing, error: findErr } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('whatsapp_config_id', whatsappConfigId)
    .order('created_at', { ascending: true })
    .limit(1);

  if (findErr) {
    console.error('[resolve-conversation] conversation lookup error:', findErr);
    throw new SendMessageError('db_error', 'Failed to resolve conversation', 500);
  }

  if (existing && existing.length > 0) {
    return existing[0].id;
  }

  const { data: newConv, error: convErr } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      contact_id: contactId,
      whatsapp_config_id: whatsappConfigId,
    })
    .select('id')
    .single();

  if (convErr || !newConv) {
    if (isUniqueViolation(convErr)) {
      const { data: raced } = await db
        .from('conversations')
        .select('id')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .eq('whatsapp_config_id', whatsappConfigId)
        .order('created_at', { ascending: true })
        .limit(1);
      if (raced && raced.length > 0) {
        return raced[0].id;
      }
    }
    console.error('[resolve-conversation] conversation create error:', convErr);
    throw new SendMessageError('db_error', 'Failed to create conversation', 500);
  }

  return newConv.id;
}
