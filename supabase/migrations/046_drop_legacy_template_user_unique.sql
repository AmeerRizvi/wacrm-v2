-- ============================================================
-- 046_drop_legacy_template_user_unique.sql
--
-- Migration 014 created `message_templates_user_name_language_key` with
-- CREATE UNIQUE INDEX, not ALTER TABLE ... ADD CONSTRAINT. Migration 040 tried
-- to remove it with DROP CONSTRAINT, which cannot remove a standalone index.
--
-- Leaving that index in place prevents a shared WABA template from having a
-- local copy on two WhatsApp channels owned/audited by the same user, defeating
-- the channel-scoped template model. Remove the legacy index explicitly; the
-- channel-scoped and legacy-NULL indexes from migration 040 remain authoritative.
-- ============================================================

DROP INDEX IF EXISTS public.message_templates_user_name_language_key;
