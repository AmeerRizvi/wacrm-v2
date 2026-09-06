-- ============================================================
-- 042_multi_channel_broadcast_api.sql
--
-- The API broadcast core uses an atomic SECURITY DEFINER RPC introduced in
-- migrations 037/038. That function pre-dates multi-channel support, so it
-- could not persist the caller's WhatsApp channel. Add an explicit overload
-- rather than weakening the 041 channel/template guards or relying on trigger
-- inference inside a privileged function.
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_broadcast_with_recipients(
  p_account_id          UUID,
  p_user_id             UUID,
  p_name                TEXT,
  p_template_name       TEXT,
  p_template_language   TEXT,
  p_total_recipients    INTEGER,
  p_contact_ids         UUID[],
  p_template_params     JSONB[],
  p_whatsapp_config_id  UUID
)
RETURNS TABLE(broadcast_id UUID, recipient_id UUID, contact_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_broadcast_id UUID;
BEGIN
  -- SECURITY DEFINER bypasses RLS, so tenant/channel validation belongs here
  -- too. The table triggers remain a second line of defense.
  IF NOT EXISTS (
    SELECT 1
    FROM whatsapp_config wc
    WHERE wc.id = p_whatsapp_config_id
      AND wc.account_id = p_account_id
  ) THEN
    RAISE EXCEPTION 'WhatsApp channel does not belong to broadcast account'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM message_templates mt
    WHERE mt.account_id = p_account_id
      AND mt.whatsapp_config_id = p_whatsapp_config_id
      AND mt.name = p_template_name
      AND mt.language = p_template_language
  ) THEN
    RAISE EXCEPTION 'Broadcast template is not available on the selected WhatsApp channel'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO broadcasts (
    account_id, user_id, whatsapp_config_id, name, template_name,
    template_language, status, total_recipients
  )
  VALUES (
    p_account_id, p_user_id, p_whatsapp_config_id, p_name, p_template_name,
    p_template_language, 'sending', p_total_recipients
  )
  RETURNING id INTO v_broadcast_id;

  RETURN QUERY
  WITH ins AS (
    INSERT INTO broadcast_recipients (
      broadcast_id, contact_id, whatsapp_config_id, status, template_params
    )
    SELECT v_broadcast_id, t.cid, p_whatsapp_config_id, 'pending', t.prm
    FROM unnest(p_contact_ids, p_template_params) AS t(cid, prm)
    RETURNING id, contact_id
  )
  SELECT v_broadcast_id, ins.id, ins.contact_id
  FROM ins;
END;
$$;

REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], UUID
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], UUID
) FROM anon;
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], UUID
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], UUID
) TO service_role;
