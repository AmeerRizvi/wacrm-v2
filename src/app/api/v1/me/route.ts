// ============================================================
// GET /api/v1/me — public API identity probe.
//
// The reference endpoint for the public API: it requires nothing
// but a valid key (no scope), and returns the account the key is
// bound to plus the scopes it carries. Multi-number integrations also
// need a safe way to discover channel UUIDs before a write; expose only
// non-secret WhatsApp channel metadata here.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { getAccountName } from '@/lib/api-keys/store';
import { ok, toApiErrorResponse } from '@/lib/api/v1/respond';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request);
    const [name, channelsResult] = await Promise.all([
      getAccountName(ctx.accountId),
      ctx.supabase
        .from('whatsapp_config')
        .select('id,label,phone_number_id,status,is_primary')
        .eq('account_id', ctx.accountId)
        .order('is_primary', { ascending: false })
        .order('created_at', { ascending: true }),
    ]);

    if (channelsResult.error) {
      throw new Error(`Failed to load WhatsApp channels: ${channelsResult.error.message}`);
    }

    return ok({
      account: { id: ctx.accountId, name },
      key: { id: ctx.keyId, scopes: ctx.scopes },
      whatsapp_channels: channelsResult.data ?? [],
    });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}