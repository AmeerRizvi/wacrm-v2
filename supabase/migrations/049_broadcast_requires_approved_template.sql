-- ============================================================
-- 049_broadcast_requires_approved_template.sql
--
-- Campaign creation is a privileged database boundary. Migration 042 verified
-- that the selected template belonged to the selected WhatsApp channel, but it
-- did not verify that Meta had approved that template. UI callers already hide
-- non-approved templates, but service-role/API callers must get the same rule.
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
  v_contact_count INTEGER;
BEGIN
  IF p_total_recipients < 1
     OR cardinality(p_contact_ids) IS DISTINCT FROM p_total_recipients
     OR cardinality(p_template_params) IS DISTINCT FROM p_total_recipients THEN
    RAISE EXCEPTION 'Broadcast recipient arrays do not match total_recipients'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM profiles p
    WHERE p.user_id = p_user_id
      AND p.account_id = p_account_id
  ) THEN
    RAISE EXCEPTION 'Broadcast audit user does not belong to broadcast account'
      USING ERRCODE = '23514';
  END IF;

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
      AND mt.status = 'APPROVED'
  ) THEN
    RAISE EXCEPTION 'Broadcast template is not approved on the selected WhatsApp channel'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO v_contact_count
  FROM contacts c
  WHERE c.account_id = p_account_id
    AND c.id = ANY(p_contact_ids);

  IF v_contact_count IS DISTINCT FROM p_total_recipients THEN
    RAISE EXCEPTION 'One or more broadcast contacts do not belong to broadcast account'
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
