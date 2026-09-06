import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'

type MediaChannelConfig = { id: string; access_token: string }

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> },
) {
  try {
    const { mediaId } = await params
    if (!mediaId) return NextResponse.json({ error: 'Media ID is required' }, { status: 400 })

    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    let channelId = new URL(request.url).searchParams.get('channel_id')

    if (!channelId) {
      // Old links did not carry channel_id. Prefer the persisted message's
      // channel identity (migration 040 backfills it) rather than whatever
      // number happens to be primary today.
      const { data: mediaRows, error: mediaLookupError } = await supabase
        .from('messages')
        .select('whatsapp_config_id, conversation:conversations!inner(account_id)')
        .like('media_url', `%/api/whatsapp/media/${mediaId}%`)
        .eq('conversation.account_id', accountId)
        .not('whatsapp_config_id', 'is', null)
        .limit(2)

      if (mediaLookupError) {
        console.error('[whatsapp/media] legacy media channel lookup failed:', mediaLookupError)
      } else {
        const storedChannelIds = [
          ...new Set(
            (mediaRows ?? [])
              .map((row) => row.whatsapp_config_id as string | null)
              .filter((id): id is string => Boolean(id)),
          ),
        ]
        if (storedChannelIds.length === 1) channelId = storedChannelIds[0]
        else if (storedChannelIds.length > 1) {
          return NextResponse.json(
            { error: 'Legacy media URL is ambiguous across WhatsApp channels.' },
            { status: 409 },
          )
        }
      }
    }

    let config: MediaChannelConfig | null = null
    if (channelId) {
      const result = await supabase
        .from('whatsapp_config')
        .select('id,access_token')
        .eq('account_id', accountId)
        .eq('id', channelId)
        .maybeSingle()
      config = result.data as MediaChannelConfig | null
      if (result.error || !config) {
        return NextResponse.json({ error: 'WhatsApp channel not found' }, { status: 404 })
      }
    } else {
      // If the old URL cannot be tied to a stored message, guessing is safe
      // only for a truly single-channel workspace.
      const { data: configs, error } = await supabase
        .from('whatsapp_config')
        .select('id,access_token')
        .eq('account_id', accountId)
        .order('created_at', { ascending: true })
        .limit(2)
      if (error) {
        return NextResponse.json({ error: 'Failed to resolve WhatsApp channel' }, { status: 500 })
      }
      if (!configs?.length) {
        return NextResponse.json({ error: 'WhatsApp not configured' }, { status: 400 })
      }
      if (configs.length > 1) {
        return NextResponse.json(
          {
            error:
              'This legacy media URL does not identify a WhatsApp channel. Open the message from the inbox to use its channel-bound URL.',
          },
          { status: 409 },
        )
      }
      config = configs[0] as MediaChannelConfig
    }

    const accessToken = decrypt(config.access_token)
    const mediaInfo = await getMediaUrl({ mediaId, accessToken })
    const { buffer, contentType } = await downloadMedia({ downloadUrl: mediaInfo.url, accessToken })

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': contentType || mediaInfo.mimeType || 'application/octet-stream',
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json({ error: 'Failed to fetch media' }, { status: 500 })
  }
}
