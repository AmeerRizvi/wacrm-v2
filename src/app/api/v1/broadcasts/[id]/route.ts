// ============================================================
// GET /api/v1/broadcasts/{id} — broadcast status + counts
// (scope: broadcasts:send).
//
// Poll this after POST /api/v1/broadcasts to watch the fan-out
// progress. `channel_id` identifies the number permanently bound to the
// campaign; changing the workspace primary does not change it.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'broadcasts:send');
    const { id } = await params;

    const { data, error } = await ctx.supabase
      .from('broadcasts')
      .select(
        'id, whatsapp_config_id, name, template_name, template_language, status, total_recipients, sent_count, delivered_count, read_count, replied_count, failed_count, created_at, updated_at'
      )
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (error) {
      console.error('[api/v1/broadcasts] read error:', error);
      return fail('internal', 'Failed to read broadcast', 500);
    }
    if (!data) return fail('not_found', 'Broadcast not found', 404);

    return ok({
      ...data,
      channel_id: data.whatsapp_config_id ?? null,
    });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
