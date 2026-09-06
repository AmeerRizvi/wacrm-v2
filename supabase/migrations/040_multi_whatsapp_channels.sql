-- ============================================================
-- 040_multi_whatsapp_channels.sql
--
-- Allow one account/workspace to connect multiple WhatsApp numbers.
-- Existing whatsapp_config rows become channel rows in-place so upgrades
-- preserve encrypted credentials, registration state, and conversation data.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS label TEXT,
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;
UPDATE whatsapp_config SET label = COALESCE(NULLIF(label, ''), phone_number_id) WHERE label IS NULL OR label = '';
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY account_id ORDER BY connected_at DESC NULLS LAST, created_at ASC, id ASC) AS rn
  FROM whatsapp_config
)
UPDATE whatsapp_config wc SET is_primary = (ranked.rn = 1) FROM ranked WHERE wc.id = ranked.id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_one_primary_per_account ON whatsapp_config(account_id) WHERE is_primary = TRUE;
CREATE INDEX IF NOT EXISTS idx_whatsapp_config_account_created ON whatsapp_config(account_id, created_at);

-- A channel row is the permanent identity of one Meta phone number. Credentials,
-- labels and operational state may rotate, but changing phone_number_id in-place
-- would make historical conversations appear to have belonged to a different
-- number. Connecting a different number therefore means creating a new channel.
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
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS prevent_whatsapp_channel_identity_change ON whatsapp_config;
CREATE TRIGGER prevent_whatsapp_channel_identity_change
  BEFORE UPDATE OF phone_number_id ON whatsapp_config
  FOR EACH ROW EXECUTE FUNCTION public.prevent_whatsapp_channel_identity_change();

-- Keep primary selection transactional. Application-side "demote then promote"
-- is racy: a failed second request can leave an account with no primary. The
-- advisory lock serializes primary changes per account, the partial unique index
-- remains a final safety net, and deleting a primary promotes the oldest survivor.
CREATE OR REPLACE FUNCTION public.maintain_whatsapp_primary_channel()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.account_id::text, 0));

  IF TG_OP = 'INSERT' AND NOT NEW.is_primary AND NOT EXISTS (
    SELECT 1 FROM whatsapp_config wc WHERE wc.account_id = NEW.account_id AND wc.is_primary
  ) THEN
    NEW.is_primary := TRUE;
  END IF;

  IF NEW.is_primary THEN
    UPDATE whatsapp_config
    SET is_primary = FALSE, updated_at = now()
    WHERE account_id = NEW.account_id
      AND id IS DISTINCT FROM NEW.id
      AND is_primary = TRUE;
  END IF;

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS maintain_whatsapp_primary_channel ON whatsapp_config;
CREATE TRIGGER maintain_whatsapp_primary_channel
  BEFORE INSERT OR UPDATE OF is_primary ON whatsapp_config
  FOR EACH ROW EXECUTE FUNCTION public.maintain_whatsapp_primary_channel();

-- Deletes must acquire the SAME account lock before touching the row. Taking
-- this lock only in an AFTER DELETE trigger creates a lock-order inversion with
-- a concurrent "make primary" transaction (advisory lock -> row lock), which
-- can deadlock against DELETE's row lock -> advisory lock ordering.
CREATE OR REPLACE FUNCTION public.lock_whatsapp_channel_before_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(OLD.account_id::text, 0));
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS lock_whatsapp_channel_before_delete ON whatsapp_config;
CREATE TRIGGER lock_whatsapp_channel_before_delete
  BEFORE DELETE ON whatsapp_config
  FOR EACH ROW EXECUTE FUNCTION public.lock_whatsapp_channel_before_delete();

CREATE OR REPLACE FUNCTION public.promote_whatsapp_primary_after_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  replacement_id UUID;
BEGIN
  IF NOT OLD.is_primary THEN
    RETURN OLD;
  END IF;

  -- The BEFORE DELETE trigger above already holds the account-scoped advisory
  -- lock for this transaction, so promotion cannot race another primary change.
  SELECT id INTO replacement_id
  FROM whatsapp_config
  WHERE account_id = OLD.account_id
  ORDER BY created_at ASC, id ASC
  LIMIT 1;

  IF replacement_id IS NOT NULL THEN
    UPDATE whatsapp_config SET is_primary = TRUE WHERE id = replacement_id;
  END IF;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS promote_whatsapp_primary_after_delete ON whatsapp_config;
CREATE TRIGGER promote_whatsapp_primary_after_delete
  AFTER DELETE ON whatsapp_config
  FOR EACH ROW EXECUTE FUNCTION public.promote_whatsapp_primary_after_delete();

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE RESTRICT;
UPDATE conversations c SET whatsapp_config_id = wc.id FROM whatsapp_config wc WHERE c.account_id = wc.account_id AND wc.is_primary = TRUE AND c.whatsapp_config_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_whatsapp_config ON conversations(whatsapp_config_id);
DROP INDEX IF EXISTS idx_conversations_account_contact;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact_channel ON conversations(account_id, contact_id, whatsapp_config_id) WHERE whatsapp_config_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact_no_channel ON conversations(account_id, contact_id) WHERE whatsapp_config_id IS NULL;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE RESTRICT;
UPDATE messages m SET whatsapp_config_id = c.whatsapp_config_id FROM conversations c WHERE m.conversation_id = c.id AND m.whatsapp_config_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_whatsapp_config ON messages(whatsapp_config_id);
CREATE INDEX IF NOT EXISTS idx_messages_wamid_channel ON messages(message_id, whatsapp_config_id) WHERE message_id IS NOT NULL;

-- Old Meta-media fallback URLs pre-date channel query parameters. Bind them to
-- the backfilled channel now so changing the account primary later cannot make
-- an old attachment try to decrypt/fetch with another phone's credentials.
UPDATE messages
SET media_url = media_url
  || CASE WHEN position('?' in media_url) > 0 THEN '&' ELSE '?' END
  || 'channel_id=' || whatsapp_config_id::text
WHERE whatsapp_config_id IS NOT NULL
  AND media_url IS NOT NULL
  AND media_url LIKE '%/api/whatsapp/media/%'
  AND position('channel_id=' in media_url) = 0;

ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE RESTRICT;
UPDATE broadcasts b SET whatsapp_config_id = wc.id FROM whatsapp_config wc WHERE b.account_id = wc.account_id AND wc.is_primary = TRUE AND b.whatsapp_config_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_broadcasts_whatsapp_config ON broadcasts(whatsapp_config_id);

ALTER TABLE broadcast_recipients ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE RESTRICT;
UPDATE broadcast_recipients br SET whatsapp_config_id = b.whatsapp_config_id FROM broadcasts b WHERE br.broadcast_id = b.id AND br.whatsapp_config_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_wamid_channel ON broadcast_recipients(whatsapp_message_id, whatsapp_config_id) WHERE whatsapp_message_id IS NOT NULL;

ALTER TABLE message_templates ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE RESTRICT;
UPDATE message_templates mt SET whatsapp_config_id = wc.id FROM whatsapp_config wc WHERE mt.account_id = wc.account_id AND wc.is_primary = TRUE AND mt.whatsapp_config_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_message_templates_whatsapp_config ON message_templates(whatsapp_config_id);
ALTER TABLE message_templates DROP CONSTRAINT IF EXISTS message_templates_user_name_language_key;
CREATE UNIQUE INDEX IF NOT EXISTS message_templates_channel_name_language_key ON message_templates (whatsapp_config_id, name, language) WHERE whatsapp_config_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS message_templates_legacy_account_name_language_key ON message_templates (account_id, name, language) WHERE whatsapp_config_id IS NULL;

DROP INDEX IF EXISTS idx_one_active_run_per_contact;
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_run_per_conversation ON flow_runs(account_id, conversation_id) WHERE status = 'active' AND conversation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_run_legacy_contact ON flow_runs(account_id, contact_id) WHERE status = 'active' AND conversation_id IS NULL;

-- Service-role webhook/worker code bypasses RLS, so database invariants must
-- still prevent account A rows from pointing at account B's WhatsApp channel.
CREATE OR REPLACE FUNCTION public.enforce_whatsapp_channel_account()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  channel_account UUID;
BEGIN
  IF NEW.whatsapp_config_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT account_id INTO channel_account FROM whatsapp_config WHERE id = NEW.whatsapp_config_id;
  IF channel_account IS NULL OR channel_account IS DISTINCT FROM NEW.account_id THEN
    RAISE EXCEPTION 'WhatsApp channel does not belong to row account'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_conversation_whatsapp_channel_account ON conversations;
CREATE TRIGGER enforce_conversation_whatsapp_channel_account
  BEFORE INSERT OR UPDATE OF account_id, whatsapp_config_id ON conversations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_whatsapp_channel_account();

DROP TRIGGER IF EXISTS enforce_broadcast_whatsapp_channel_account ON broadcasts;
CREATE TRIGGER enforce_broadcast_whatsapp_channel_account
  BEFORE INSERT OR UPDATE OF account_id, whatsapp_config_id ON broadcasts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_whatsapp_channel_account();

DROP TRIGGER IF EXISTS enforce_template_whatsapp_channel_account ON message_templates;
CREATE TRIGGER enforce_template_whatsapp_channel_account
  BEFORE INSERT OR UPDATE OF account_id, whatsapp_config_id ON message_templates
  FOR EACH ROW EXECUTE FUNCTION public.enforce_whatsapp_channel_account();

-- Messages inherit their conversation channel and may never disagree with it.
CREATE OR REPLACE FUNCTION public.inherit_message_whatsapp_channel()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  expected_channel UUID;
BEGIN
  SELECT whatsapp_config_id INTO expected_channel
  FROM conversations WHERE id = NEW.conversation_id;

  IF NEW.whatsapp_config_id IS NULL THEN
    NEW.whatsapp_config_id := expected_channel;
  ELSIF NEW.whatsapp_config_id IS DISTINCT FROM expected_channel THEN
    RAISE EXCEPTION 'Message WhatsApp channel does not match conversation channel'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS inherit_message_whatsapp_channel ON messages;
CREATE TRIGGER inherit_message_whatsapp_channel
  BEFORE INSERT OR UPDATE OF conversation_id, whatsapp_config_id ON messages
  FOR EACH ROW EXECUTE FUNCTION public.inherit_message_whatsapp_channel();

-- Backward-compatible broadcast writers (the existing browser wizard and any
-- older API client) do not know about whatsapp_config_id. Resolve the channel
-- from the selected template when unambiguous, then prefer the primary channel.
CREATE OR REPLACE FUNCTION public.inherit_broadcast_whatsapp_channel()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.whatsapp_config_id IS NULL THEN
    SELECT mt.whatsapp_config_id INTO NEW.whatsapp_config_id
    FROM message_templates mt
    JOIN whatsapp_config wc ON wc.id = mt.whatsapp_config_id
    WHERE mt.account_id = NEW.account_id
      AND mt.name = NEW.template_name
      AND mt.language = NEW.template_language
    ORDER BY wc.is_primary DESC, mt.created_at DESC
    LIMIT 1;

    IF NEW.whatsapp_config_id IS NULL THEN
      SELECT wc.id INTO NEW.whatsapp_config_id
      FROM whatsapp_config wc
      WHERE wc.account_id = NEW.account_id
      ORDER BY wc.is_primary DESC, wc.created_at ASC
      LIMIT 1;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inherit_broadcast_whatsapp_channel ON broadcasts;
CREATE TRIGGER inherit_broadcast_whatsapp_channel
  BEFORE INSERT OR UPDATE OF template_name, template_language, whatsapp_config_id
  ON broadcasts
  FOR EACH ROW EXECUTE FUNCTION public.inherit_broadcast_whatsapp_channel();

CREATE OR REPLACE FUNCTION public.inherit_recipient_whatsapp_channel()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  expected_channel UUID;
BEGIN
  SELECT whatsapp_config_id INTO expected_channel
  FROM broadcasts WHERE id = NEW.broadcast_id;

  IF NEW.whatsapp_config_id IS NULL THEN
    NEW.whatsapp_config_id := expected_channel;
  ELSIF NEW.whatsapp_config_id IS DISTINCT FROM expected_channel THEN
    RAISE EXCEPTION 'Broadcast recipient WhatsApp channel does not match broadcast channel'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inherit_recipient_whatsapp_channel ON broadcast_recipients;
CREATE TRIGGER inherit_recipient_whatsapp_channel
  BEFORE INSERT OR UPDATE OF broadcast_id, whatsapp_config_id
  ON broadcast_recipients
  FOR EACH ROW EXECUTE FUNCTION public.inherit_recipient_whatsapp_channel();
