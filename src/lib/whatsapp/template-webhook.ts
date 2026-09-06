/**
 * Handlers for Meta template-lifecycle webhook events.
 *
 * Template events are WABA-scoped. `message_template_id` is not treated as a
 * cross-WABA routing key; production callers must provide Meta webhook entry.id.
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

export async function handleTemplateWebhookChange(
  change: TemplateWebhookChange,
  supabase: SupabaseClient,
  wabaId?: string,
): Promise<void> {
  if (!wabaId) {
    // A global meta_template_id lookup is unsafe once several WABAs/tenants
    // exist. Meta production webhooks provide entry.id; callers without it
    // must not mutate template state.
    console.warn('[template-webhook] dropping lifecycle event without WABA context')
    return
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
  wabaId: string,
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

  const channelIds = await channelIdsForWaba(supabase, wabaId)
  if (channelIds === null) return
  if (channelIds.length === 0) {
    console.warn('[template-webhook] status update received for unconfigured WABA:', wabaId)
    return
  }

  const status = normalizeStatus(value.event)
  const { data, error } = await supabase
    .from('message_templates')
    .update({
      status,
      rejection_reason:
        status === 'REJECTED' ? value.reason ?? 'Rejected by Meta' : null,
      submission_error: null,
    })
    .eq('meta_template_id', metaTemplateId)
    .in('whatsapp_config_id', channelIds)
    .select('id')

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
      `WABA ${wabaId}`,
    )
  }
}

async function handleQualityUpdate(
  value: TemplateQualityUpdateValue,
  supabase: SupabaseClient,
  wabaId: string,
): Promise<void> {
  const metaTemplateId =
    value.message_template_id !== undefined ? String(value.message_template_id) : null
  if (!metaTemplateId) {
    console.warn('[template-webhook] quality update missing message_template_id:', value)
    return
  }

  const channelIds = await channelIdsForWaba(supabase, wabaId)
  if (channelIds === null) return
  if (channelIds.length === 0) {
    console.warn('[template-webhook] quality update received for unconfigured WABA:', wabaId)
    return
  }

  const raw = value.new_quality_score
  const score =
    raw && ['GREEN', 'YELLOW', 'RED'].includes(raw.toUpperCase())
      ? (raw.toUpperCase() as 'GREEN' | 'YELLOW' | 'RED')
      : null

  const { error } = await supabase
    .from('message_templates')
    .update({ quality_score: score })
    .eq('meta_template_id', metaTemplateId)
    .in('whatsapp_config_id', channelIds)

  if (error) {
    console.error(
      '[template-webhook] quality update failed for meta_template_id',
      metaTemplateId,
      error.message,
    )
  }
}

function handleComponentsUpdate(
  value: TemplateComponentsUpdateValue,
  wabaId: string,
): void {
  console.info(
    '[template-webhook] components updated by Meta for template',
    value.message_template_id,
    value.message_template_name,
    `in WABA ${wabaId}`,
    '— run "Sync from Meta" in Settings to pull the new components.',
  )
}
