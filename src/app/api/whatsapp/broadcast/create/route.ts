import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'

const MAX_RECIPIENTS = 1000

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 })
    }

    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const templateName =
      typeof body.template_name === 'string' ? body.template_name.trim() : ''
    const templateLanguage =
      typeof body.template_language === 'string' && body.template_language
        ? body.template_language
        : 'en_US'
    const channelId =
      typeof body.channel_id === 'string' && body.channel_id ? body.channel_id : null
    const contactIds = Array.isArray(body.contact_ids)
      ? body.contact_ids.filter((id: unknown): id is string => typeof id === 'string' && Boolean(id))
      : []
    const rawParams = Array.isArray(body.template_params) ? body.template_params : []

    if (!name || !templateName || !channelId) {
      return NextResponse.json(
        { error: 'name, template_name, and channel_id are required' },
        { status: 400 },
      )
    }
    if (contactIds.length === 0) {
      return NextResponse.json({ error: 'contact_ids must be a non-empty array' }, { status: 400 })
    }
    if (contactIds.length > MAX_RECIPIENTS) {
      return NextResponse.json(
        { error: `A broadcast is capped at ${MAX_RECIPIENTS} recipients` },
        { status: 400 },
      )
    }
    if (rawParams.length !== contactIds.length) {
      return NextResponse.json(
        { error: 'template_params must contain one entry per contact_id' },
        { status: 400 },
      )
    }

    // Preserve the first occurrence of a contact and its frozen parameters.
    // The database RPC intentionally rejects duplicate ids because its tenant
    // validation count must equal total_recipients.
    const deduped = new Map<string, string[]>()
    for (let i = 0; i < contactIds.length; i += 1) {
      if (deduped.has(contactIds[i])) continue
      const params = Array.isArray(rawParams[i])
        ? rawParams[i].filter((value: unknown): value is string => typeof value === 'string')
        : []
      deduped.set(contactIds[i], params)
    }

    const ids = [...deduped.keys()]
    const params = ids.map((id) => deduped.get(id) ?? [])

    // Use the same privileged, channel-aware transaction as the public API.
    // The RPC validates audit-user membership, channel ownership, template
    // availability on that channel, array cardinality, and every contact before
    // it writes either the broadcast or any recipient row.
    const { data: createdRows, error: createError } = await supabaseAdmin().rpc(
      'create_broadcast_with_recipients',
      {
        p_account_id: accountId,
        p_user_id: userId,
        p_name: name,
        p_template_name: templateName,
        p_template_language: templateLanguage,
        p_total_recipients: ids.length,
        p_contact_ids: ids,
        p_template_params: params,
        p_whatsapp_config_id: channelId,
      },
    )

    if (createError || !createdRows?.length) {
      console.error('[whatsapp/broadcast/create] atomic create failed:', createError)
      return NextResponse.json(
        { error: createError?.message || 'Failed to create broadcast' },
        { status: 400 },
      )
    }

    const broadcastId = createdRows[0].broadcast_id as string

    // These fields are descriptive UI metadata; recipient send parameters have
    // already been frozen atomically by the RPC. A metadata write failure must
    // not encourage the browser to retry creation and duplicate a campaign.
    const { error: metadataError } = await supabase
      .from('broadcasts')
      .update({
        template_variables:
          body.template_variables && typeof body.template_variables === 'object'
            ? body.template_variables
            : {},
        audience_filter:
          body.audience_filter && typeof body.audience_filter === 'object'
            ? body.audience_filter
            : {},
      })
      .eq('id', broadcastId)
      .eq('account_id', accountId)

    if (metadataError) {
      console.warn('[whatsapp/broadcast/create] metadata update failed:', metadataError.message)
    }

    return NextResponse.json({
      success: true,
      broadcast_id: broadcastId,
      channel_id: channelId,
      total_recipients: ids.length,
      metadata_saved: !metadataError,
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
