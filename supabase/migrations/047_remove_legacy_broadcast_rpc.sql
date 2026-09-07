-- ============================================================
-- 047_remove_legacy_broadcast_rpc.sql
--
-- Migration 038 created an 8-argument SECURITY DEFINER broadcast creation RPC.
-- Migration 042 introduced the channel-aware 9-argument replacement as an
-- overload, which leaves the old function callable by service_role. The current
-- application uses the 9-argument signature, so remove the channel-blind
-- privileged escape hatch entirely.
-- ============================================================

DROP FUNCTION IF EXISTS public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[]
);
