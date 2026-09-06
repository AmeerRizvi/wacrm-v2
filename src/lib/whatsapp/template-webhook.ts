/**
 * Handlers for Meta's template-lifecycle webhook events.
 *
 * Meta delivers three template-related webhook fields, each with a
 * different `value` shape:
 *
 *   - message_template_status_update      — APPROVED / REJECTED / PAUSED / etc.
 *   - message_template_quality_update     — GREEN / YELLOW / RED quality score
 *   - message_template_components_update  — Meta auto-modified the template
 *
 * Template lifecycle events are WABA-scoped. Meta's webhook entry id is the
 * WhatsApp Business Account id, while `message_template_id` is only guaranteed
 * unique inside that WABA. The caller therefore passes entry.id so updates are
 * fanned out only to local channel copies belonging to that WABA.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeStatus } from './template-status-normalize'

const TEMPLATE_WEBHOOK_FIELDS = new Set([
  'message_template_status_update',
  'message_template_quality_update',
  'message_template_components_update',
])

export function isTemplateWebhookField(field: string): boolean {
  return TEMPLATE_WEBHOOK_FIELDS.has(field)
}

interface TemplateStatusUpdateValue {
  event?: string
  message_template_id?: string | number
  message_template_name?: string
  message_template_language?: string
  reason?: string
}

interface TemplateQualityUpdateValue {
  message_template_id?: string | number
  message_template_name?: string
  message_template_language?: string
  previous_quality_score?: string
  new_quality_score?: string
}

interface TemplateComponentsUpdateValue {
  message_template_id?: string | number
  message_template_name?: string
  message_template_language?: string
}

export interface TemplateWebhookChange {
  field: string
  value: unknown
}

async function channelIdsForWaba(
  supabase: SupabaseClient,
  wabaId: string,
): Promise<string[] | null> {
  const { data, error } = await supabase
    .from('whatsapp_config')
    .select('id')
    .eq('waba_id', wabaId)

  if (error) {
    console.error('[template-webhook] failed to resolve WABA channels:', wabaId, error.message)
    return null
  }
  return (data ?? []).map((row) => row.id as string)
}

/**
 * Dispatch a single template change. `wabaId` should be Meta's webhook
 * `entry.id`. It remains optional only for backwards-compatible unit callers;
 * production webhook routing always supplies it. If omitted, the old global
 * meta_template_id lookup is retained with a warning rather than silently
 * dropping lifecycle events in older integrations.
 */
export async function handleTemplateWebhookChange(
  change: TemplateWebhookChange,
  supabase: SupabaseClient,
  wabaId?: string,
): Promise<void> {
  if (!wabaId) {
    console.warn(
      '[template-webhook] template lifecycle event has no WABA context; falling back to legacy meta_template_id lookup',
    )
  }

  switch (change.field) {
    case 'message_template_status_update':
      await handleStatusUpdate(change.value as TemplateStatusUpdateValue, supabase, wabaId)
      return
    case 'message_template_quality_update':
      await handleQualityUpdate(change.value as TemplateQualityUpdateValue, supabase, wabaId)
      return
    case 'message_template_components_update':
      handleComponentsUpdate(change.value as TemplateComponentsUpdateValue, wabaId)
      return
  }
}

async function handleStatusUpdate(
  value: TemplateStatusUpdateValue,
  supabase: SupabaseClient,
  wabaId?: string,
): Promise<void> {
  const metaTemplateId =
    value.message_template_id !== undefined ? String(value.message_template_id) : null
  if (!metaTemplateId || !value.event) {
    console.warn(
      '[template-webhook] status update missing message_template_id or event:',
      value,
    )
    return
  }

  const status = normalizeStatus(value.event)
  const update: Record<string, unknown> = {
    status,
    rejection_reason:
      status === 'REJECTED' ? value.reason ?? 'Rejected by Meta' : null,
    submission_error: null,
  }

  let channelIds: string[] | null = null
  if (wabaId) {
    channelIds = await channelIdsForWaba(supabase, wabaId)
    if (channelIds === null) return
    if (channelIds.length === 0) {
      console.warn('[template-webhook] status update received for unconfigured WABA:', wabaId)
      return
    }
  }

  let query = supabase
    .from('message_templates')
    .update(update)
    .eq('meta_template_id', metaTemplateId)
  if (channelIds) query = query.in('whatsapp_config_id', channelIds)

  const { data, error } = await query.select('id')
  if (error) {
    console.error(
      '[template-webhook] status update failed for meta_template_id',
      metaTemplateId,
      error.message,
    )
    return
  }
  if (!data || data.length === 0) {
    console.warn(
      '[template-webhook] status update received for unknown template:',
      metaTemplateId,
      value.message_template_name,
      wabaId ? `WABA ${wabaId}` : '',
    )
  }
}

async function handleQualityUpdate(
  value: TemplateQualityUpdateValue,
  supabase: SupabaseClient,
  wabaId?: string,
): Promise<void> {
  const metaTemplateId =
    value.message_template_id !== undefined ? String(value.message_template_id) : null
  if (!metaTemplateId) {
    console.warn(
      '[template-webhook] quality update missing message_template_id:',
      value,
    )
    return
  }

  const raw = value.new_quality_score
  const score =
    raw && ['GREEN', 'YELLOW', 'RED'].includes(raw.toUpperCase())
      ? (raw.toUpperCase() as 'GREEN' | 'YELLOW' | 'RED')
      : null

  let channelIds: string[] | null = null
  if (wabaId) {
    channelIds = await channelIdsForWaba(supabase, wabaId)
    if (channelIds === null) return
    if (channelIds.length === 0) {
      console.warn('[template-webhook] quality update received for unconfigured WABA:', wabaId)
      return
    }
  }

  let query = supabase
    .from('message_templates')
    .update({ quality_score: score })
    .eq('meta_template_id', metaTemplateId)
  if (channelIds) query = query.in('whatsapp_config_id', channelIds)

  const { error } = await query
  if (error) {
    console.error(
      '[template-webhook] quality update failed for meta_template_id',
      metaTemplateId,
      error.message,
    )
  }
}

/**
 * Meta auto-modified the template (typically category reclassification).
 * We log and let the operator sync the WABA so the UI never silently changes
 * submitted content behind their back.
 */
function handleComponentsUpdate(
  value: TemplateComponentsUpdateValue,
  wabaId?: string,
): void {
  console.info(
    '[template-webhook] components updated by Meta for template',
    value.message_template_id,
    value.message_template_name,
    wabaId ? `in WABA ${wabaId}` : '',
    '— run "Sync from Meta" in Settings to pull the new components.',
  )
}
