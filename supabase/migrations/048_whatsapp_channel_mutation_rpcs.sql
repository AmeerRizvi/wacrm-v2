-- ============================================================
-- 048_whatsapp_channel_mutation_rpcs.sql
--
-- Row-level BEFORE triggers run after PostgreSQL has identified/locked the
-- target tuple. That means a trigger-level advisory lock cannot guarantee the
-- global lock order for a concurrent primary promotion vs channel deletion.
--
-- The application uses these SECURITY INVOKER RPCs for the two operations that
-- need serialization. They resolve the account without a row lock, acquire the
-- account-scoped advisory lock, and only then UPDATE/DELETE the channel row.
-- RLS remains active because these functions are SECURITY INVOKER, so only a
-- caller allowed by the existing whatsapp_config policies can mutate the row.
-- ============================================================

CREATE OR REPLACE FUNCTION public.set_primary_whatsapp_channel(
  p_channel_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  SELECT wc.account_id
  INTO v_account_id
  FROM whatsapp_config wc
  WHERE wc.id = p_channel_id;

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'WhatsApp channel not found'
      USING ERRCODE = 'P0002';
  END IF;

  -- Acquired before UPDATE takes the target channel row lock. The existing
  -- maintain_whatsapp_primary_channel trigger re-enters the same xact lock.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_account_id::text, 0));

  UPDATE whatsapp_config
  SET is_primary = TRUE,
      updated_at = NOW()
  WHERE id = p_channel_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WhatsApp channel not found'
      USING ERRCODE = 'P0002';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_whatsapp_channel(
  p_channel_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  SELECT wc.account_id
  INTO v_account_id
  FROM whatsapp_config wc
  WHERE wc.id = p_channel_id;

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'WhatsApp channel not found'
      USING ERRCODE = 'P0002';
  END IF;

  -- Acquired before DELETE takes the channel row lock. The delete/promotion
  -- triggers then run under the same already-held account lock.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_account_id::text, 0));

  DELETE FROM whatsapp_config
  WHERE id = p_channel_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WhatsApp channel not found'
      USING ERRCODE = 'P0002';
  END IF;
END;
$$;

-- Functions default to PUBLIC EXECUTE in PostgreSQL. Limit discovery/use to
-- authenticated application callers (whose RLS policies remain authoritative)
-- and service_role for operational recovery.
REVOKE ALL ON FUNCTION public.set_primary_whatsapp_channel(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_primary_whatsapp_channel(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_primary_whatsapp_channel(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.delete_whatsapp_channel(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_whatsapp_channel(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.delete_whatsapp_channel(UUID) TO authenticated, service_role;
