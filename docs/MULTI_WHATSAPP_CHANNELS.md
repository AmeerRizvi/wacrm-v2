# Multi-WhatsApp Channels

wacrm supports multiple Meta WhatsApp Business Cloud API phone numbers inside one account/workspace.

## Mental model

An **account** is the tenant/workspace. A **WhatsApp channel** is one row in `whatsapp_config` and represents one immutable Meta `phone_number_id` plus the credentials used to operate it.

```text
Account
├── Sales UAE       (primary)
├── Support UAE
├── Abu Dhabi
└── Sri Lanka
```

Contacts remain account-global. Conversations are channel-specific, so one customer may have independent Sales and Support threads. Once a conversation is bound to a channel, that channel is the routing authority for human replies, automations, Flows and AI replies.

`is_primary` is only a compatibility/default choice when a caller has no channel context. Established conversations and broadcasts never move when the primary changes. When a multi-channel operation is ambiguous, it fails instead of guessing.

## Database migrations

The multi-channel series is deliberately layered so the core model and later audit hardening are independently reviewable:

- `040_multi_whatsapp_channels.sql` — channel model, entity bindings, primary handling and legacy backfill.
- `041_multi_channel_hardening.sql` — WABA ownership, WABA/template identity, legacy-history repair and channel-safe broadcast/template guards.
- `042_multi_channel_broadcast_api.sql` — atomic channel-aware broadcast creation RPC.
- `043_multi_channel_relational_guards.sql` — Flow-run and broadcast-recipient account/contact/channel consistency.
- `044_whatsapp_channel_tenant_identity.sql` — makes both phone identity and tenant ownership immutable on an existing channel.
- `045_require_whatsapp_primary_channel.sql` — deferred invariant requiring a primary whenever an account has channels.
- `046_drop_legacy_template_unique_index.sql` — removes the old per-user template UNIQUE INDEX that would otherwise block same-WABA templates on sibling phone channels.
- `047_drop_legacy_broadcast_rpc_overloads.sql` — removes old channel-blind SECURITY DEFINER broadcast RPC overloads.
- `048_whatsapp_channel_concurrency.sql` — fail-fast account-level serialization for concurrent primary/delete mutations instead of a lock cycle.
- `049_broadcast_requires_approved_template.sql` — requires an APPROVED local template at the privileged broadcast boundary.
- `050_persist_broadcast_template_message_params.sql` — freezes campaign-wide send-time template values (for example a media-header override) and makes the 10-argument channel-aware RPC the sole canonical broadcast creator.

Existing encrypted credentials are preserved during upgrade.

## Channel identity and tenancy

The old `UNIQUE(account_id)` constraint on `whatsapp_config` is removed. `phone_number_id` remains globally unique. Both `phone_number_id` and `account_id` are immutable on an existing channel row; replacing a number or moving it between tenants means creating/migrating a channel explicitly, never rewriting historical identity.

When an account has channels, exactly one must be primary. The partial unique index guarantees at most one and a deferred constraint guarantees at least one. Concurrent primary/delete mutations fail fast if another transaction owns the account mutation lock instead of committing a broken state.

A WABA may contain several phone channels in the **same** workspace. The same WABA may not be split across CRM accounts. Once template history exists for a channel, changing its WABA is rejected because Meta template IDs belong to the original WABA catalog.

Historical references use restrictive foreign keys, so a channel with conversation/message/broadcast/template history cannot be silently deleted.

## Channel-bound entities

`whatsapp_config_id` is stored on:

- `conversations`
- `messages`
- `broadcasts`
- `broadcast_recipients`
- `message_templates`

Conversation uniqueness is:

```text
(account_id, contact_id, whatsapp_config_id)
```

Active Flow uniqueness is conversation-scoped. Database triggers additionally protect service-role/background writers from pairing rows with another tenant's channel/contact/conversation.

## Upgrade and legacy NULL conversations

For an existing one-number installation, migration 040 marks the existing config primary and backfills existing conversations/messages/broadcasts/templates. Old Meta-media fallback URLs are stamped with the channel ID.

A conversation created before any WhatsApp config existed can remain NULL-bound. The first channel-aware inbound/outbound use claims it safely. If an API/manual automation explicitly supplies a channel, that explicit choice wins over primary fallback and the conversation is bound **before** a Meta send. A uniqueness race fails before transmission and points the caller to the canonical channel thread.

When a legacy conversation is bound, PostgreSQL backfills its historical messages and media proxy URLs at the same boundary.

## Settings and Inbox

Settings → WhatsApp lists safe metadata for every connected number, supports add/edit/test/primary/media-mirroring operations and blocks deletion of channels that retain history. Token ciphertext is never returned by the list API.

Configuration writes require an admin before Meta registration/subscription side effects.

Inbox supports **All numbers** plus per-number filtering. Human text/media/template/interactive/reply/reaction operations resolve the exact conversation and therefore its exact sending channel.

The dashboard send endpoint accepts `channel_id` / `whatsapp_config_id` for contact-only or legacy-thread sends. A conflicting channel on an already-bound conversation returns a conflict rather than rerouting.

## Inbound webhook routing

Meta messaging changes include `metadata.phone_number_id`. The webhook resolves the exact local channel before processing statuses/messages. That identity is carried through conversation routing, message persistence, media credentials, delivery/read/failure status, broadcast reply/status handling, automations, Flows, AI and public webhooks.

Meta message IDs (`wamid`) are not assumed globally unique across phone numbers. Lookups use channel or conversation identity as appropriate.

Template lifecycle events are WABA-scoped using webhook `entry.id`. Events without WABA context are dropped instead of globally updating same-ID/name template copies.

## Automations, Flows and AI

Automation and Flow send adapters resolve credentials from the conversation, not an account-wide WhatsApp config. Templates are resolved inside that same channel and outbound messages are stamped with the same channel.

Delayed automations persist their original context. Manual automation execution validates `account + contact + conversation`; when it supplies an explicit channel for a legacy NULL conversation, the route binds that channel before switching to service-role execution.

Flow runtime/idempotency is conversation-scoped. Support traffic cannot advance a Sales run for the same contact.

AI auto-reply validates account/contact/conversation identity before mutations and sends through the conversation-channel sender. Draft generation is read-only and RLS/account scoped.

## Broadcasts

A broadcast permanently stores its sending channel, and every recipient inherits it. Browser wizard, public API and Resume/Retry share the same privileged atomic creation model.

The canonical RPC is:

```text
create_broadcast_with_recipients(
  account,
  audit_user,
  name,
  template_name,
  language,
  total,
  contact_ids,
  per_recipient_body_params,
  whatsapp_config_id,
  template_message_params
)
```

The RPC is service-role only and validates:

- audit-user membership;
- selected channel ownership;
- selected template belongs to that channel **and is APPROVED**;
- recipient-array cardinality;
- every contact belongs to the account;
- structured send-time params are a JSON object.

Old 7-, 8- and 9-argument privileged overloads are removed so callers cannot bypass channel/send-time validation.

### Atomic browser campaign creation

The dashboard wizard resolves the entire audience and freezes each recipient's body parameters first. A cookie-authenticated server endpoint then calls the same atomic RPC, creating the parent and **all** recipient rows in one transaction. A failure cannot leave a broadcast with only part of its audience persisted.

### Resume/Retry fidelity

Resume/Retry always reads the broadcast's stored `whatsapp_config_id`; changing workspace primary cannot move a campaign to another number.

Migration 050 also persists `broadcasts.template_message_params`. This matters for media-header templates: a campaign-specific image/video/document override used for the first batch is restored exactly after interruption. Resume is not allowed to silently fall back to a different `message_templates.header_media_url`.

Both creation and Resume refuse templates that are no longer `APPROVED`.

The low-level batch sender independently enforces exact channel + synced APPROVED template, so bypassing the wizard cannot bypass lifecycle validation.

## Templates and WABAs

Meta template catalogs are WABA-scoped while message sends are phone-channel-scoped. wacrm stores deterministic local copies per phone channel.

For sibling channels sharing one WABA, Sync/Submit/Edit/Delete/Lifecycle operations mutate Meta once and mirror/update only channels belonging to that WABA.

Migration 046 is important: migration 014 created `message_templates_user_name_language_key` as a UNIQUE **INDEX**, not a table constraint. It must be dropped as an index or same template names on sibling phone channels remain impossible.

Settings → Templates includes an explicit channel selector and account-level visibility.

## Media

Inbound mirrored media is durable. Fallback proxy URLs carry `channel_id`, and old proxy URLs attempt to recover channel identity from their stored message rather than guessing primary.

Broadcast media-header overrides are campaign state, not template state, and are persisted as described above.

## Public API and MCP

`POST /api/v1/messages` accepts `channel_id` (with `whatsapp_config_id` as alias). Omission preserves primary as the compatibility default only for new phone-based sends.

Public conversation/message serializers expose `channel_id`, and conversation lists can filter by it.

`GET /api/v1/me` exposes safe WhatsApp-channel discovery metadata:

```json
{
  "whatsapp_channels": [
    {
      "id": "<channel uuid>",
      "label": "Support UAE",
      "phone_number_id": "<meta phone number id>",
      "status": "connected",
      "is_primary": false
    }
  ]
}
```

No access/verify tokens are included. MCP can therefore discover the UUID before an explicit-channel message, broadcast or conversation filter instead of guessing it.

The MCP client and write/read tool schemas pass `channel_id` through to `/api/v1`. CI has a separate MCP install/typecheck/build job in addition to the main app job.

## Operational checklist

1. Add each channel in Settings → WhatsApp.
2. Supply Phone Number ID, WABA ID, token and registration PIN where required.
3. Ensure the WABA is subscribed and test the channel.
4. In Settings → Templates, select the number and sync its WABA catalog.
5. Send inbound traffic to each number and confirm distinct channel-labelled conversations.
6. Reply/template/react on each conversation and verify the same Meta number sends.
7. Trigger Automation, Flow and AI paths on multiple channels for the same contact.
8. Create a broadcast and confirm its From channel.
9. For a media-header campaign, use a campaign-specific asset, interrupt delivery, then Resume and verify the same asset/channel are reused.
10. Change primary and retry an older campaign; it must remain on its original channel.
11. Exercise public API/MCP channel discovery and explicit-channel sends.

## Verification and release gate

`supabase/ci/verify-schema.sql` asserts channel columns/indexes, primary invariants, tenant/relational triggers, absence of old template/RPC uniqueness paths, the canonical 10-argument broadcast RPC, APPROVED-template validation, persisted structured broadcast params and fail-fast channel mutation locking.

Before deployment, execute the main application checks:

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

and the MCP checks:

```bash
cd mcp-server
npm ci
npm run typecheck
npm run build
```

Then replay **all** Supabase migrations from a clean database and execute `supabase/ci/verify-schema.sql`.

The feature PR must remain **Draft** until those executable checks pass. Static auditing is not a substitute for TypeScript compilation, tests, Next.js build or PostgreSQL migration execution.