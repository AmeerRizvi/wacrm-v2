-- ============================================================
-- 041_multi_channel_hardening.sql
--
-- Follow-up invariants discovered during the multi-channel audit.
-- These rules protect service-role/background writers as well as the UI.
-- ============================================================

-- A Meta WABA owns one shared template catalog. Splitting phone numbers from
-- the same WABA across two CRM accounts would make template lifecycle events,
-- edits and deletes cross tenant boundaries by definition. One WABA may have
-- many channels, but every one of those channels must belong to one account.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM whatsapp_config
    WHERE waba_id IS NOT NULL
    GROUP BY waba_id
    HAVING count(DISTINCT account_id) > 1
  ) THEN
    RAISE EXCEPTION 'A WhatsApp Business Account (WABA) is linked to multiple CRM accounts; resolve the tenant ownership conflict before enabling multi-channel support';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.enforce_waba_single_account()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.waba_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM whatsapp_config wc
    WHERE wc.waba_id = NEW.waba_id
      AND wc.account_id IS DISTINCT FROM NEW.account_id
      AND wc.id IS DISTINCT FROM NEW.id
  ) THEN
    RAISE EXCEPTION 'This WABA is already linked to another CRM account'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_waba_single_account ON whatsapp_config;
CREATE TRIGGER enforce_waba_single_account
  BEFORE INSERT OR UPDATE OF waba_id, account_id ON whatsapp_config
  FOR EACH ROW EXECUTE FUNCTION public.enforce_waba_single_account();

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

-- Migration 040 can intentionally leave conversations NULL-bound when an old
-- installation had no WhatsApp config yet. The first later inbound/outbound
-- operation claims that legacy thread for a real channel. Stamp its historical
-- messages at the database boundary and repair any pre-channel media proxy URLs
-- at the same moment so no caller has to remember a second backfill step.
CREATE OR REPLACE FUNCTION public.backfill_messages_after_conversation_channel_bind()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.whatsapp_config_id IS NULL AND NEW.whatsapp_config_id IS NOT NULL THEN
    UPDATE messages
    SET
      whatsapp_config_id = NEW.whatsapp_config_id,
      media_url = CASE
        WHEN media_url IS NOT NULL
         AND media_url LIKE '%/api/whatsapp/media/%'
         AND position('channel_id=' in media_url) = 0
        THEN media_url
          || CASE WHEN position('?' in media_url) > 0 THEN '&' ELSE '?' END
          || 'channel_id=' || NEW.whatsapp_config_id::text
        ELSE media_url
      END
    WHERE conversation_id = NEW.id
      AND whatsapp_config_id IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS backfill_messages_after_conversation_channel_bind ON conversations;
CREATE TRIGGER backfill_messages_after_conversation_channel_bind
  AFTER UPDATE OF whatsapp_config_id ON conversations
  FOR EACH ROW EXECUTE FUNCTION public.backfill_messages_after_conversation_channel_bind();

-- Harden migration 040's compatibility writer. A missing channel may be
-- inferred from a template only when that name/language maps to exactly one
-- local phone channel. If it exists on several channels/WABAs, choosing primary
-- would be a wrong-number risk, so old/direct DB writers must disambiguate.
CREATE OR REPLACE FUNCTION public.inherit_broadcast_whatsapp_channel()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  candidate_channels UUID[];
  candidate_count INTEGER;
BEGIN
  IF NEW.whatsapp_config_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT array_agg(DISTINCT mt.whatsapp_config_id)
  INTO candidate_channels
  FROM message_templates mt
  WHERE mt.account_id = NEW.account_id
    AND mt.name = NEW.template_name
    AND mt.language = NEW.template_language
    AND mt.whatsapp_config_id IS NOT NULL;

  candidate_count := COALESCE(array_length(candidate_channels, 1), 0);

  IF candidate_count > 1 THEN
    RAISE EXCEPTION 'Broadcast template exists on multiple WhatsApp channels; whatsapp_config_id is required'
      USING ERRCODE = '23514';
  ELSIF candidate_count = 1 THEN
    NEW.whatsapp_config_id := candidate_channels[1];
    RETURN NEW;
  END IF;

  -- Legacy installations that have not synced a local template catalog yet
  -- retain the historical default-channel behavior.
  SELECT wc.id INTO NEW.whatsapp_config_id
  FROM whatsapp_config wc
  WHERE wc.account_id = NEW.account_id
  ORDER BY wc.is_primary DESC, wc.created_at ASC, wc.id ASC
  LIMIT 1;

  RETURN NEW;
END;
$$;

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
