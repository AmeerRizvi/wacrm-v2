-- ============================================================
-- 045_require_whatsapp_primary_channel.sql
--
-- The partial unique index guarantees AT MOST one primary channel, while the
-- promotion trigger normally keeps one selected. A direct/privileged update can
-- still demote the only primary (`SET is_primary = false`) and leave an account
-- with channels but no default. Enforce the other half of the invariant at
-- transaction end so temporary zero-primary states during promotion are legal,
-- but a committed zero-primary workspace is not.
-- ============================================================

CREATE OR REPLACE FUNCTION public.require_whatsapp_primary_channel()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_account_id := OLD.account_id;
  ELSE
    v_account_id := NEW.account_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM whatsapp_config wc WHERE wc.account_id = v_account_id
  ) AND NOT EXISTS (
    SELECT 1
    FROM whatsapp_config wc
    WHERE wc.account_id = v_account_id
      AND wc.is_primary = TRUE
  ) THEN
    RAISE EXCEPTION 'An account with WhatsApp channels must have exactly one primary channel'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS require_whatsapp_primary_channel ON whatsapp_config;
CREATE CONSTRAINT TRIGGER require_whatsapp_primary_channel
  AFTER INSERT OR UPDATE OF is_primary OR DELETE
  ON whatsapp_config
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.require_whatsapp_primary_channel();
