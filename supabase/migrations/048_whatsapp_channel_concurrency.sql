-- ============================================================
-- 048_whatsapp_channel_concurrency.sql
--
-- Row-level BEFORE UPDATE/DELETE triggers run after PostgreSQL has already
-- identified/locked the target tuple. A blocking advisory lock taken inside
-- such a trigger can therefore participate in a lock-order cycle:
--
--   tx A: target channel row -> waits for account advisory lock
--   tx B: account advisory lock -> waits for target/primary channel row
--
-- Keep the account-scoped serialization from migration 040, but never WAIT for
-- that advisory lock while holding a channel row lock. A concurrent contender
-- fails with SQLSTATE 40001 (serialization_failure), rolls back cleanly, and can
-- be retried. The unique primary index + deferred primary invariant remain the
-- correctness backstops.
-- ============================================================

CREATE OR REPLACE FUNCTION public.maintain_whatsapp_primary_channel()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended(NEW.account_id::text, 0)) THEN
    RAISE EXCEPTION 'Concurrent WhatsApp channel mutation; retry the transaction'
      USING ERRCODE = '40001';
  END IF;

  IF TG_OP = 'INSERT' AND NOT NEW.is_primary AND NOT EXISTS (
    SELECT 1
    FROM whatsapp_config wc
    WHERE wc.account_id = NEW.account_id
      AND wc.is_primary
  ) THEN
    NEW.is_primary := TRUE;
  END IF;

  IF NEW.is_primary THEN
    UPDATE whatsapp_config
    SET is_primary = FALSE,
        updated_at = NOW()
    WHERE account_id = NEW.account_id
      AND id IS DISTINCT FROM NEW.id
      AND is_primary = TRUE;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.lock_whatsapp_channel_before_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended(OLD.account_id::text, 0)) THEN
    RAISE EXCEPTION 'Concurrent WhatsApp channel mutation; retry the transaction'
      USING ERRCODE = '40001';
  END IF;
  RETURN OLD;
END;
$$;
