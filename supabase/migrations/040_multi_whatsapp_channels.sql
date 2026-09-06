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

ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;

UPDATE whatsapp_config
SET label = COALESCE(NULLIF(label, ''), phone_number_id)
WHERE label IS NULL OR label = '';

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY account_id
           ORDER BY connected_at DESC NULLS LAST, created_at ASC, id ASC
         ) AS rn
  FROM whatsapp_config
)
UPDATE whatsapp_config wc
SET is_primary = (ranked.rn = 1)
FROM ranked
WHERE wc.id = ranked.id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_one_primary_per_account
  ON whatsapp_config(account_id)
  WHERE is_primary = TRUE;

CREATE INDEX IF NOT EXISTS idx_whatsapp_config_account_created
  ON whatsapp_config(account_id, created_at);

-- Conversations are scoped by account + contact + WhatsApp channel.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID
  REFERENCES whatsapp_config(id) ON DELETE SET NULL;

UPDATE conversations c
SET whatsapp_config_id = wc.id
FROM whatsapp_config wc
WHERE c.account_id = wc.account_id
  AND wc.is_primary = TRUE
  AND c.whatsapp_config_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_whatsapp_config
  ON conversations(whatsapp_config_id);

DROP INDEX IF EXISTS idx_conversations_account_contact;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact_channel
  ON conversations(account_id, contact_id, whatsapp_config_id)
  WHERE whatsapp_config_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact_no_channel
  ON conversations(account_id, contact_id)
  WHERE whatsapp_config_id IS NULL;

-- Messages retain channel identity so Meta wamids are resolved safely even
-- when the same wamid exists on another WhatsApp number.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID
  REFERENCES whatsapp_config(id) ON DELETE SET NULL;

UPDATE messages m
SET whatsapp_config_id = c.whatsapp_config_id
FROM conversations c
WHERE m.conversation_id = c.id
  AND m.whatsapp_config_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_messages_whatsapp_config
  ON messages(whatsapp_config_id);
CREATE INDEX IF NOT EXISTS idx_messages_wamid_channel
  ON messages(message_id, whatsapp_config_id)
  WHERE message_id IS NOT NULL;

-- Broadcasts and recipients retain their sending channel.
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID
  REFERENCES whatsapp_config(id) ON DELETE SET NULL;

UPDATE broadcasts b
SET whatsapp_config_id = wc.id
FROM whatsapp_config wc
WHERE b.account_id = wc.account_id
  AND wc.is_primary = TRUE
  AND b.whatsapp_config_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_broadcasts_whatsapp_config
  ON broadcasts(whatsapp_config_id);

ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID
  REFERENCES whatsapp_config(id) ON DELETE SET NULL;

UPDATE broadcast_recipients br
SET whatsapp_config_id = b.whatsapp_config_id
FROM broadcasts b
WHERE br.broadcast_id = b.id
  AND br.whatsapp_config_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_wamid_channel
  ON broadcast_recipients(whatsapp_message_id, whatsapp_config_id)
  WHERE whatsapp_message_id IS NOT NULL;

-- Templates belong to a channel/WABA. Existing rows inherit the primary.
ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID
  REFERENCES whatsapp_config(id) ON DELETE SET NULL;

UPDATE message_templates mt
SET whatsapp_config_id = wc.id
FROM whatsapp_config wc
WHERE mt.account_id = wc.account_id
  AND wc.is_primary = TRUE
  AND mt.whatsapp_config_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_message_templates_whatsapp_config
  ON message_templates(whatsapp_config_id);

-- Migration 014 keyed templates to the original creator. Shared accounts and
-- multiple WABAs need identity to be account + channel + name + language.
ALTER TABLE message_templates
  DROP CONSTRAINT IF EXISTS message_templates_user_name_language_key;
CREATE UNIQUE INDEX IF NOT EXISTS message_templates_channel_name_language_key
  ON message_templates (whatsapp_config_id, name, language)
  WHERE whatsapp_config_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS message_templates_legacy_account_name_language_key
  ON message_templates (account_id, name, language)
  WHERE whatsapp_config_id IS NULL;

-- A contact can be in a bot flow independently on Sales and Support. Runtime
-- identity is therefore the conversation, not account/contact alone.
DROP INDEX IF EXISTS idx_one_active_run_per_contact;
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_run_per_conversation
  ON flow_runs(account_id, conversation_id)
  WHERE status = 'active' AND conversation_id IS NOT NULL;

-- Keep a conservative guard for legacy rows that predate conversation_id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_run_legacy_contact
  ON flow_runs(account_id, contact_id)
  WHERE status = 'active' AND conversation_id IS NULL;