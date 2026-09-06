-- ============================================================
-- 043_multi_channel_relational_guards.sql
--
-- Defense-in-depth for rows written by service-role workers / SECURITY
-- DEFINER functions. RLS cannot protect those callers, so relational tenant
-- identity is enforced at the database boundary.
-- ============================================================

-- A Flow run that points at a conversation must describe that exact
-- account/contact pair. contact_id is intentionally nullable for historical
-- audit rows after a contact is deleted, so FK cleanup to NULL is allowed while
-- the account/conversation relationship remains protected.
CREATE OR REPLACE FUNCTION public.enforce_flow_run_conversation_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_contact_id UUID;
BEGIN
  IF NEW.conversation_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT c.account_id, c.contact_id
  INTO v_account_id, v_contact_id
  FROM conversations c
  WHERE c.id = NEW.conversation_id;

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Flow run conversation does not exist'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.account_id IS DISTINCT FROM v_account_id THEN
    RAISE EXCEPTION 'Flow run account does not match conversation account'
      USING ERRCODE = '23514';
  END IF;

  -- ON DELETE SET NULL preserves run history when the contact is removed.
  -- While both references are live, however, they must identify the same CRM
  -- contact as the conversation.
  IF NEW.contact_id IS NOT NULL AND NEW.contact_id IS DISTINCT FROM v_contact_id THEN
    RAISE EXCEPTION 'Flow run contact does not match conversation contact'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_flow_run_conversation_identity ON flow_runs;
CREATE TRIGGER enforce_flow_run_conversation_identity
  BEFORE INSERT OR UPDATE OF account_id, contact_id, conversation_id
  ON flow_runs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_flow_run_conversation_identity();

-- A recipient inherits both tenant and WhatsApp channel from its parent
-- broadcast. `broadcast_recipients` has no account_id column, so validate its
-- contact against the parent account explicitly. Deleted contacts remain NULL
-- for historical rows and are intentionally allowed.
CREATE OR REPLACE FUNCTION public.enforce_broadcast_recipient_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_channel_id UUID;
  v_contact_account UUID;
BEGIN
  SELECT b.account_id, b.whatsapp_config_id
  INTO v_account_id, v_channel_id
  FROM broadcasts b
  WHERE b.id = NEW.broadcast_id;

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Broadcast recipient parent broadcast does not exist'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.whatsapp_config_id IS NULL THEN
    NEW.whatsapp_config_id := v_channel_id;
  ELSIF NEW.whatsapp_config_id IS DISTINCT FROM v_channel_id THEN
    RAISE EXCEPTION 'Broadcast recipient WhatsApp channel does not match parent broadcast'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.contact_id IS NOT NULL THEN
    SELECT c.account_id INTO v_contact_account
    FROM contacts c
    WHERE c.id = NEW.contact_id;

    IF v_contact_account IS NULL OR v_contact_account IS DISTINCT FROM v_account_id THEN
      RAISE EXCEPTION 'Broadcast recipient contact does not belong to parent broadcast account'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_broadcast_recipient_identity ON broadcast_recipients;
CREATE TRIGGER enforce_broadcast_recipient_identity
  BEFORE INSERT OR UPDATE OF broadcast_id, contact_id, whatsapp_config_id
  ON broadcast_recipients
  FOR EACH ROW EXECUTE FUNCTION public.enforce_broadcast_recipient_identity();
