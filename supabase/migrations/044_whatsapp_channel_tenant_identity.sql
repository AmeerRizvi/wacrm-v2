-- ============================================================
-- 044_whatsapp_channel_tenant_identity.sql
--
-- A WhatsApp channel is historical identity, not a movable configuration row.
-- Migration 040 already made phone_number_id immutable; make account ownership
-- immutable as well so a privileged/manual UPDATE cannot move the channel to a
-- different tenant while conversations/messages/broadcasts still reference it.
-- Child-row guards do not fire when only the parent whatsapp_config row changes,
-- so this invariant belongs on the channel itself.
-- ============================================================

CREATE OR REPLACE FUNCTION public.prevent_whatsapp_channel_identity_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.phone_number_id IS DISTINCT FROM OLD.phone_number_id THEN
    RAISE EXCEPTION 'phone_number_id is immutable for an existing WhatsApp channel; create a new channel instead'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'account_id is immutable for an existing WhatsApp channel; create a new channel in the target account instead'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_whatsapp_channel_identity_change ON whatsapp_config;
CREATE TRIGGER prevent_whatsapp_channel_identity_change
  BEFORE UPDATE OF phone_number_id, account_id ON whatsapp_config
  FOR EACH ROW EXECUTE FUNCTION public.prevent_whatsapp_channel_identity_change();
