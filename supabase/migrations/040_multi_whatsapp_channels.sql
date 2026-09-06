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

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL;
UPDATE conversations c SET whatsapp_config_id = wc.id FROM whatsapp_config wc WHERE c.account_id = wc.account_id AND wc.is_primary = TRUE AND c.whatsapp_config_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_whatsapp_config ON conversations(whatsapp_config_id);
DROP INDEX IF EXISTS idx_conversations_account_contact;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact_channel ON conversations(account_id, contact_id, whatsapp_config_id) WHERE whatsapp_config_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact_no_channel ON conversations(account_id, contact_id) WHERE whatsapp_config_id IS NULL;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL;
UPDATE messages m SET whatsapp_config_id = c.whatsapp_config_id FROM conversations c WHERE m.conversation_id = c.id AND m.whatsapp_config_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_whatsapp_config ON messages(whatsapp_config_id);
CREATE INDEX IF NOT EXISTS idx_messages_wamid_channel ON messages(message_id, whatsapp_config_id) WHERE message_id IS NOT NULL;

ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL;
UPDATE broadcasts b SET whatsapp_config_id = wc.id FROM whatsapp_config wc WHERE b.account_id = wc.account_id AND wc.is_primary = TRUE AND b.whatsapp_config_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_broadcasts_whatsapp_config ON broadcasts(whatsapp_config_id);

ALTER TABLE broadcast_recipients ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL;
UPDATE broadcast_recipients br SET whatsapp_config_id = b.whatsapp_config_id FROM broadcasts b WHERE br.broadcast_id = b.id AND br.whatsapp_config_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_wamid_channel ON broadcast_recipients(whatsapp_message_id, whatsapp_config_id) WHERE whatsapp_message_id IS NOT NULL;

ALTER TABLE message_templates ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL;
UPDATE message_templates mt SET whatsapp_config_id = wc.id FROM whatsapp_config wc WHERE mt.account_id = wc.account_id AND wc.is_primary = TRUE AND mt.whatsapp_config_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_message_templates_whatsapp_config ON message_templates(whatsapp_config_id);
ALTER TABLE message_templates DROP CONSTRAINT IF EXISTS message_templates_user_name_language_key;
CREATE UNIQUE INDEX IF NOT EXISTS message_templates_channel_name_language_key ON message_templates (whatsapp_config_id, name, language) WHERE whatsapp_config_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS message_templates_legacy_account_name_language_key ON message_templates (account_id, name, language) WHERE whatsapp_config_id IS NULL;

DROP INDEX IF EXISTS idx_one_active_run_per_contact;
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_run_per_conversation ON flow_runs(account_id, conversation_id) WHERE status = 'active' AND conversation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_run_legacy_contact ON flow_runs(account_id, contact_id) WHERE status = 'active' AND conversation_id IS NULL;

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
BEGIN
  IF NEW.whatsapp_config_id IS NULL THEN
    SELECT b.whatsapp_config_id INTO NEW.whatsapp_config_id
    FROM broadcasts b WHERE b.id = NEW.broadcast_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inherit_recipient_whatsapp_channel ON broadcast_recipients;
CREATE TRIGGER inherit_recipient_whatsapp_channel
  BEFORE INSERT OR UPDATE OF broadcast_id, whatsapp_config_id
  ON broadcast_recipients
  FOR EACH ROW EXECUTE FUNCTION public.inherit_recipient_whatsapp_channel();
