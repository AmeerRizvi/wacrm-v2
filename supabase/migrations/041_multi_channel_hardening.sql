-- ============================================================
-- 041_multi_channel_hardening.sql
--
-- Follow-up invariants discovered during the multi-channel audit.
-- These rules protect service-role/background writers as well as the UI.
-- ============================================================

-- Once a channel has local template history its WABA becomes part of that
-- history's identity. Moving the same channel row to another WABA would leave
-- Meta template ids pointing at the wrong catalog. WABA corrections are still
-- allowed before templates are synced/submitted.
CREATE OR REPLACE FUNCTION public.prevent_whatsapp_waba_change_with_templates()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.waba_id IS DISTINCT FROM OLD.waba_id
     AND EXISTS (
       SELECT 1
       FROM message_templates mt
       WHERE mt.whatsapp_config_id = OLD.id
       LIMIT 1
     ) THEN
    RAISE EXCEPTION 'waba_id cannot change after template history exists for this WhatsApp channel'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_whatsapp_waba_change_with_templates ON whatsapp_config;
CREATE TRIGGER prevent_whatsapp_waba_change_with_templates
  BEFORE UPDATE OF waba_id ON whatsapp_config
  FOR EACH ROW EXECUTE FUNCTION public.prevent_whatsapp_waba_change_with_templates();

-- A broadcast's selected template must be usable on its sending channel. This
-- prevents a stale/legacy client from selecting a same-named template from a
-- different WABA and relying on name/language guessing.
CREATE OR REPLACE FUNCTION public.validate_broadcast_template_channel()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.whatsapp_config_id IS NULL OR NEW.template_name IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM message_templates mt
    WHERE mt.account_id = NEW.account_id
      AND mt.whatsapp_config_id = NEW.whatsapp_config_id
      AND mt.name = NEW.template_name
      AND mt.language = NEW.template_language
  ) THEN
    RAISE EXCEPTION 'Broadcast template is not available on the selected WhatsApp channel'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_broadcast_template_channel ON broadcasts;
CREATE TRIGGER validate_broadcast_template_channel
  BEFORE INSERT OR UPDATE OF account_id, whatsapp_config_id, template_name, template_language
  ON broadcasts
  FOR EACH ROW EXECUTE FUNCTION public.validate_broadcast_template_channel();
