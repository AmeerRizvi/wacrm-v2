-- ============================================================
-- 040_multi_whatsapp_channels.sql
--
-- Allow one account/workspace to connect multiple WhatsApp numbers.
-- Existing `whatsapp_config` rows become channel rows in-place so
-- upgrades preserve encrypted credentials and connection state.
--
-- Core invariants after this migration:
--   * one phone_number_id still belongs to exactly one config globally;
--   * an account may own many whatsapp_config rows;
--   * at most one config per account is marked primary;
--   * conversations remember the config/number they belong to;
--   * outbound messages and broadcasts can retain the sending config.
--
-- Existing installations are backfilled to their sole current config,
-- preserving behaviour until a second number is connected.
-- ============================================================

-- -----------------------------------------------------------------
-- whatsapp_config becomes a multi-row channel collection per account
-- -----------------------------------------------------------------
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS label TEXT,
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE;

-- Migration 017 enforced one config per account. Multi-channel support
-- deliberately removes that constraint while retaining migration 013's
-- globally-unique phone_number_id guarantee.
ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;

-- Give existing rows a stable human-readable fallback label. The UI can
-- replace this with the display phone number/name after Meta verification.
UPDATE whatsapp_config
SET label = COALESCE(NULLIF(label, ''), phone_number_id)
WHERE label IS NULL OR label = '';

-- Existing accounts can only have one row before this migration, but use
-- row_number so this remains deterministic if a manually-modified database
-- already contains multiple configs.
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

-- -----------------------------------------------------------------
-- conversations are channel-scoped
-- -----------------------------------------------------------------
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID
  REFERENCES whatsapp_config(id) ON DELETE SET NULL;

-- Before this migration there was at most one config per account, so the
-- primary row is the correct channel for every existing conversation.
UPDATE conversations c
SET whatsapp_config_id = wc.id
FROM whatsapp_config wc
WHERE c.account_id = wc.account_id
  AND wc.is_primary = TRUE
  AND c.whatsapp_config_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_whatsapp_config
  ON conversations(whatsapp_config_id);

-- Migration 036 enforced one conversation per (account, contact). With
-- multiple numbers the same customer may legitimately have one thread per
-- connected number, so channel identity becomes part of the key.
DROP INDEX IF EXISTS idx_conversations_account_contact;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact_channel
  ON conversations(account_id, contact_id, whatsapp_config_id)
  WHERE whatsapp_config_id IS NOT NULL;

-- Preserve the old anti-duplication guarantee for legacy/no-channel rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact_no_channel
  ON conversations(account_id, contact_id)
  WHERE whatsapp_config_id IS NULL;

-- -----------------------------------------------------------------
-- messages retain sender channel for unambiguous Meta status routing
-- -----------------------------------------------------------------
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

-- -----------------------------------------------------------------
-- broadcasts retain the number they send from
-- -----------------------------------------------------------------
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

-- -----------------------------------------------------------------
-- templates may be WABA/channel-specific. Existing rows inherit primary.
-- Keeping this nullable supports accounts that created draft templates
-- before connecting WhatsApp.
-- -----------------------------------------------------------------
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
