-- Post-migration assertions for `.github/workflows/migrations.yml`.
DO $$
BEGIN
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'public.messages is missing — migrations did not apply';
  END IF;
  IF to_regclass('public.whatsapp_config') IS NULL THEN
    RAISE EXCEPTION 'public.whatsapp_config is missing — migrations did not apply';
  END IF;
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION 'storage.buckets is missing — storage migrations could not apply';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'chat-media') THEN
    RAISE EXCEPTION 'the chat-media bucket row was not created (migration 023)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'flow-media') THEN
    RAISE EXCEPTION 'the flow-media bucket row was not created (migration 016)';
  END IF;
  IF to_regclass('public.accounts') IS NULL THEN
    RAISE EXCEPTION 'public.accounts is missing — migration 017 did not apply';
  END IF;

  -- Multi-WhatsApp foundation (040): channel identity must exist on every
  -- runtime object that routes traffic to or from Meta.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='whatsapp_config' AND column_name='is_primary'
  ) THEN RAISE EXCEPTION 'whatsapp_config.is_primary is missing — migration 040 did not apply'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='conversations' AND column_name='whatsapp_config_id'
  ) THEN RAISE EXCEPTION 'conversations.whatsapp_config_id is missing'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='messages' AND column_name='whatsapp_config_id'
  ) THEN RAISE EXCEPTION 'messages.whatsapp_config_id is missing'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='broadcasts' AND column_name='whatsapp_config_id'
  ) THEN RAISE EXCEPTION 'broadcasts.whatsapp_config_id is missing'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='message_templates' AND column_name='whatsapp_config_id'
  ) THEN RAISE EXCEPTION 'message_templates.whatsapp_config_id is missing'; END IF;

  IF to_regclass('public.idx_whatsapp_config_one_primary_per_account') IS NULL THEN
    RAISE EXCEPTION 'single-primary channel index is missing';
  END IF;
  IF to_regclass('public.idx_conversations_account_contact_channel') IS NULL THEN
    RAISE EXCEPTION 'channel-scoped conversation uniqueness index is missing';
  END IF;
  IF to_regclass('public.message_templates_channel_name_language_key') IS NULL THEN
    RAISE EXCEPTION 'channel-scoped template uniqueness index is missing';
  END IF;

  RAISE NOTICE 'schema verification passed';
END
$$;