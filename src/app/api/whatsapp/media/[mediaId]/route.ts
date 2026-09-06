import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> },
) {
  try {
    const { mediaId } = await params
    if (!mediaId) return NextResponse.json({ error: 'Media ID is required' }, { status: 400 })

    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await supabase.from('profiles').select('account_id').eq('user_id', user.id).maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) return NextResponse.json({ error: 'Your profile is not linked to an account.' }, { status: 403 })

    const channelId = new URL(request.url).searchParams.get('channel_id')
    let config
    if (channelId) {
      const result = await supabase.from('whatsapp_config').select('id,access_token').eq('account_id', accountId).eq('id', channelId).maybeSingle()
      config = result.data
      if (result.error || !config) return NextResponse.json({ error: 'WhatsApp channel not found' }, { status: 404 })
    } else {
      // Legacy media URLs had no channel query parameter. Prefer primary so
      // old single-channel installations continue to work after migration.
      const result = await supabase.from('whatsapp_config').select('id,access_token').eq('account_id', accountId).order('is_primary', { ascending: false }).order('created_at', { ascending: true }).limit(1)
      config = result.data?.[0]
      if (result.error || !config) return NextResponse.json({ error: 'WhatsApp not configured' }, { status: 400 })
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