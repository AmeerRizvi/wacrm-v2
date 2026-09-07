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
  IF to_regclass('public.message_templates_user_name_language_key') IS NOT NULL THEN
    RAISE EXCEPTION 'legacy per-user template unique index still exists — migration 046 did not apply';
  END IF;
  IF to_regclass('public.idx_one_active_run_per_conversation') IS NULL THEN
    RAISE EXCEPTION 'conversation-scoped active Flow uniqueness index is missing';
  END IF;
  IF to_regclass('public.idx_one_active_run_per_contact') IS NOT NULL THEN
    RAISE EXCEPTION 'legacy contact-scoped active Flow uniqueness index still exists';
  END IF;

  IF to_regprocedure(
    'public.create_broadcast_with_recipients(uuid,uuid,text,text,text,integer,uuid[],jsonb[],uuid)'
  ) IS NULL THEN
    RAISE EXCEPTION 'channel-aware atomic broadcast creation RPC is missing';
  END IF;
  IF pg_get_functiondef(
    to_regprocedure('public.create_broadcast_with_recipients(uuid,uuid,text,text,text,integer,uuid[],jsonb[],uuid)')
  ) NOT ILIKE '%mt.status = ''APPROVED''%' THEN
    RAISE EXCEPTION 'broadcast creation RPC does not require an APPROVED template';
  END IF;
  IF to_regprocedure(
    'public.create_broadcast_with_recipients(uuid,uuid,text,text,text,integer,uuid[],jsonb[])'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'legacy 8-argument channel-blind broadcast RPC still exists — migration 047 did not apply';
  END IF;
  IF to_regprocedure(
    'public.create_broadcast_with_recipients(uuid,uuid,text,text,text,integer,uuid[])'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'legacy 7-argument channel-blind broadcast RPC still exists';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'enforce_waba_single_account' AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'WABA tenant ownership trigger is missing'; END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'prevent_whatsapp_channel_identity_change'
      AND NOT tgisinternal
      AND pg_get_triggerdef(oid) ILIKE '%phone_number_id%'
      AND pg_get_triggerdef(oid) ILIKE '%account_id%'
  ) THEN
    RAISE EXCEPTION 'WhatsApp channel phone/account identity protection trigger is missing or incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'maintain_whatsapp_primary_channel' AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'transactional primary-channel trigger is missing'; END IF;
  IF pg_get_functiondef(to_regprocedure('public.maintain_whatsapp_primary_channel()')) NOT ILIKE '%pg_try_advisory_xact_lock%' THEN
    RAISE EXCEPTION 'primary-channel mutation function is missing fail-fast advisory locking';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'require_whatsapp_primary_channel'
      AND NOT tgisinternal
      AND tgdeferrable
      AND tginitdeferred
  ) THEN
    RAISE EXCEPTION 'deferred at-least-one-primary WhatsApp channel invariant is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'lock_whatsapp_channel_before_delete' AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'primary-channel delete lock trigger is missing'; END IF;
  IF pg_get_functiondef(to_regprocedure('public.lock_whatsapp_channel_before_delete()')) NOT ILIKE '%pg_try_advisory_xact_lock%' THEN
    RAISE EXCEPTION 'channel delete function is missing fail-fast advisory locking';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'promote_whatsapp_primary_after_delete' AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'primary-channel delete promotion trigger is missing'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'inherit_message_whatsapp_channel' AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'message/conversation channel consistency trigger is missing'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'backfill_messages_after_conversation_channel_bind' AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'legacy conversation history channel backfill trigger is missing'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'enforce_conversation_whatsapp_channel_account' AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'conversation tenant/channel guard is missing'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'inherit_recipient_whatsapp_channel' AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'broadcast recipient/channel consistency trigger is missing'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'prevent_whatsapp_waba_change_with_templates' AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'WABA/template identity protection trigger is missing'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'validate_broadcast_template_channel' AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'broadcast template/channel validation trigger is missing'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'enforce_flow_run_conversation_identity' AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'Flow run conversation tenant/contact guard is missing'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'enforce_broadcast_recipient_identity' AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'broadcast recipient tenant/channel guard is missing'; END IF;

  RAISE NOTICE 'schema verification passed';
END
$$;
