import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { deleteMessageTemplate, editMessageTemplate } from '@/lib/whatsapp/meta-api'
import { validateTemplatePayload, type TemplatePayload } from '@/lib/whatsapp/template-validators'
import { buildMetaTemplatePayload } from '@/lib/whatsapp/template-components'
import { ensureImageHeaderHandle } from '@/lib/whatsapp/template-header-handle'

const EDITABLE_STATUSES = new Set(['APPROVED', 'REJECTED', 'PAUSED'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function isDryRun() { return process.env.WHATSAPP_TEMPLATES_DRY_RUN === 'true' || process.env.WHATSAPP_TEMPLATES_DRY_RUN === '1' }

async function loadTemplateAndChannel(supabase: SupabaseClient, accountId: string, id: string) {
  const { data: template, error } = await supabase
    .from('message_templates')
    .select('id,name,status,meta_template_id,language,whatsapp_config_id')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error || !template) return { template: null, config: null }

  let config = null
  if (template.whatsapp_config_id) {
    const result = await supabase.from('whatsapp_config').select('*').eq('account_id', accountId).eq('id', template.whatsapp_config_id).maybeSingle()
    config = result.data
  } else {
    const result = await supabase.from('whatsapp_config').select('*').eq('account_id', accountId).order('is_primary', { ascending: false }).order('created_at', { ascending: true }).limit(1)
    config = result.data?.[0] ?? null
  }
  return { template, config }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid template id.' }, { status: 400 })
    const { supabase, accountId } = await requireRole('admin')
    let payload: TemplatePayload
    try { payload = (await request.json()) as TemplatePayload } catch { return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 }) }

    const { template: existing, config } = await loadTemplateAndChannel(supabase, accountId, id)
    if (!existing) return NextResponse.json({ error: 'Template not found.' }, { status: 404 })
    if (!existing.meta_template_id) return NextResponse.json({ error: 'This template was never submitted to Meta.' }, { status: 400 })
    if (!EDITABLE_STATUSES.has(existing.status)) return NextResponse.json({ error: `Templates in status ${existing.status} cannot be edited.` }, { status: 400 })
    if (payload.category === 'Authentication') return NextResponse.json({ error: 'AUTHENTICATION templates are not editable here.' }, { status: 400 })
    try { validateTemplatePayload(payload) } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'Validation failed.' }, { status: 400 }) }

    if (!isDryRun()) {
      if (!config) return NextResponse.json({ error: 'The WhatsApp channel for this template is not configured.' }, { status: 400 })
      const accessToken = decrypt(config.access_token)
      try { await ensureImageHeaderHandle(payload, accessToken) } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'Header image upload failed.' }, { status: 400 }) }
      try {
        const metaPayload = buildMetaTemplatePayload(payload)
        await editMessageTemplate({ metaTemplateId: existing.meta_template_id, accessToken, components: metaPayload.components })
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Meta edit failed.'
        await supabase.from('message_templates').update({ submission_error: message, last_submitted_at: new Date().toISOString() }).eq('id', id)
        return NextResponse.json({ error: message }, { status: 502 })
      }
    }

    const { data: row, error } = await supabase.from('message_templates').update({
      category: payload.category,
      header_type: payload.header_type ?? null,
      header_content: payload.header_content ?? null,
      header_media_url: payload.header_media_url ?? null,
      header_handle: payload.header_handle ?? null,
      body_text: payload.body_text,
      footer_text: payload.footer_text ?? null,
      buttons: payload.buttons ?? null,
      sample_values: payload.sample_values ?? null,
      status: 'PENDING', submission_error: null, rejection_reason: null,
      last_submitted_at: new Date().toISOString(),
    }).eq('id', id).select().single()
    if (error) return NextResponse.json({ error: `Edited on Meta but failed to save locally: ${error.message}` }, { status: 500 })
    return NextResponse.json({ success: true, channel_id: existing.whatsapp_config_id ?? config?.id ?? null, template: row, dry_run: isDryRun() })
  } catch (error) { return toErrorResponse(error) }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid template id.' }, { status: 400 })
    const { supabase, accountId } = await requireRole('admin')
    const { template: existing, config } = await loadTemplateAndChannel(supabase, accountId, id)
    if (!existing) return NextResponse.json({ error: 'Template not found.' }, { status: 404 })

    if (existing.meta_template_id && !isDryRun()) {
      if (!config?.waba_id) return NextResponse.json({ error: 'The template WhatsApp channel/WABA is not configured.' }, { status: 400 })
      try {
        await deleteMessageTemplate({ wabaId: config.waba_id, accessToken: decrypt(config.access_token), name: existing.name, metaTemplateId: existing.meta_template_id })
      } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'Meta delete failed.' }, { status: 502 }) }
    }

    const { error } = await supabase.from('message_templates').delete().eq('id', id).eq('account_id', accountId)
    if (error) return NextResponse.json({ error: `Deleted on Meta but failed locally: ${error.message}` }, { status: 500 })
    return NextResponse.json({ success: true, dry_run: isDryRun() })
  } catch (error) { return toErrorResponse(error) }
}
