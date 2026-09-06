# Multi-WhatsApp Channels

wacrm supports multiple Meta WhatsApp Business Cloud API phone numbers inside one account/workspace.

## Mental model

An **account** is the tenant/workspace. A **WhatsApp channel** is one row in `whatsapp_config` and represents one Meta `phone_number_id` plus the credentials used to operate it.

```text
Account
├── Sales UAE       (primary)
├── Support UAE
├── Abu Dhabi
└── Sri Lanka
```

Contacts remain account-global. Conversations are channel-specific, so one customer may have independent Sales and Support threads. Once a conversation is bound to a channel, that channel is the routing authority for human replies, automations, Flows and AI replies.

`is_primary` is only a compatibility/default choice when a caller has no channel context. The application does not silently move established conversations, broadcasts or bot sessions when the primary changes. When a multi-channel operation is genuinely ambiguous, it fails instead of guessing.

## Database migrations

- `040_multi_whatsapp_channels.sql` — core channel model, conversation/message/broadcast/template bindings, primary-channel handling and legacy backfill.
- `041_multi_channel_hardening.sql` — WABA ownership, WABA/template identity, broadcast/template validation, legacy conversation/message repair and ambiguous broadcast protection.
- `042_multi_channel_broadcast_api.sql` — channel-aware atomic public broadcast creation RPC with SECURITY DEFINER tenant validation.
- `043_multi_channel_relational_guards.sql` — Flow-run conversation identity and broadcast-recipient tenant/channel guards.

Existing encrypted credentials are preserved during the upgrade.

## Channel identity

The old `UNIQUE(account_id)` constraint on `whatsapp_config` is removed. `phone_number_id` remains globally unique and is immutable after a channel is created. A different Meta phone number must be added as a new channel rather than rewriting an existing channel row.

When an account has channels, exactly one is maintained as primary. Primary changes and primary deletion are serialized in PostgreSQL; deleting an unused primary promotes the oldest surviving channel. Historical references use restrictive foreign keys so a channel with retained conversation/message/broadcast/template history cannot be silently deleted.

A WABA may contain several phone channels in the **same** workspace. The same WABA may not be split across two CRM accounts. The migration fails fast if existing data violates that ownership rule.

A WABA ID may be corrected before template history exists. Once templates have been synced/submitted for a channel, changing that channel's WABA is rejected because Meta template IDs belong to the original WABA catalog.

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

instead of `(account_id, contact_id)`.

Active Flow uniqueness is conversation-scoped, so the same customer may independently interact with a bot on Sales and Support at the same time.

Database guards additionally ensure that service-role and SECURITY DEFINER writers cannot pair a row with another tenant's channel/contact/conversation.

## Upgrade behavior

For an existing one-number installation:

1. migration 040 marks the existing config primary;
2. existing conversations/messages/broadcasts/templates are stamped with that config;
3. old Meta media fallback URLs are rewritten with their channel ID;
4. normal single-number behavior remains unchanged until another channel is added.

An older conversation created before any WhatsApp config existed may still have a NULL channel. Its first later inbound/outbound operation safely binds that legacy thread to a real channel. PostgreSQL then stamps its historical messages and repairs legacy media URLs at the same time.

No credential re-entry is required for the existing number.

## Settings → WhatsApp

The channel manager can:

- list all connected numbers without returning encrypted token ciphertext;
- add and edit individual channels;
- test one channel against Meta;
- mark a channel primary;
- toggle inbound-media mirroring per channel;
- see registration/WABA subscription state;
- remove an unused channel.

Configuration mutations require the admin role **before** Meta registration or WABA-subscription side effects are attempted. Leaving token fields blank while editing keeps the encrypted stored values.

## Inbox and human sends

The Inbox supports:

- **All numbers** unified view;
- per-number filtering;
- channel labels on threads in the unified view.

The template picker is scoped to the active conversation's channel through React state/context rather than URL timing.

All human outbound operations resolve the conversation first and then use its exact channel:

- text
- media
- templates
- interactive buttons/lists
- quote replies
- reactions

The dashboard `POST /api/whatsapp/send` also accepts `channel_id` / `whatsapp_config_id` for contact-only sends. If the caller supplies an existing conversation plus a different channel, the request is rejected rather than rerouted.

## Inbound webhook routing

Meta messaging changes include `metadata.phone_number_id`. The webhook resolves exactly one local channel from that value before processing statuses or messages.

That channel is used for:

- conversation routing;
- inbound message persistence;
- media credentials;
- delivery/read/failure statuses;
- broadcast recipient statuses;
- broadcast reply tracking;
- automation context;
- Flow dispatch;
- AI auto-reply context;
- public webhook payloads.

Meta message IDs (`wamid`) are not treated as globally unique across phone numbers. Status and Flow prompt/idempotency lookups are scoped by channel or conversation as appropriate.

## Automations, Flows and AI

Bot/workflow senders do **not** query an account-level WhatsApp config with `.single()`. They resolve the exact channel attached to the conversation.

Automation sends:

- validate account/contact/conversation ownership;
- use the conversation channel;
- resolve templates inside that channel;
- stamp outbound messages with `whatsapp_config_id`.

Conversation mutations such as **Assign conversation** and **Close conversation** act on one verified conversation. They no longer update every Sales/Support thread belonging to the contact. Delayed executions preserve the triggering conversation/channel context. A contact-only automation with several possible WhatsApp conversations fails unless the context disambiguates the target.

Flow runtime state is also conversation-scoped. Incoming Support traffic cannot advance a Sales Flow run. Prompt-message lookup and duplicate-inbound protection use the exact conversation instead of WAMID alone. Flow handoff validates the target agent as a member of the same account and updates only the run's conversation.

AI auto-replies use the same conversation-channel sender as Flow text sends, so they inherit the receiving number automatically.

## Broadcasts

A broadcast permanently stores its sending channel, and every recipient inherits that same channel.

The browser wizard carries the selected template's channel through:

```text
template selection
→ broadcast row
→ recipient rows
→ every send batch
```

The immediate broadcast API and public `POST /api/v1/broadcasts` accept `channel_id` / `whatsapp_config_id`. A legacy caller may omit it only when template/channel resolution is unambiguous. If the same template exists on multiple channels, the API returns a conflict instead of selecting primary.

Public broadcast creation uses the channel-aware atomic `create_broadcast_with_recipients(..., p_whatsapp_config_id)` RPC. Because it is SECURITY DEFINER, the function validates:

- audit user membership;
- selected channel ownership;
- template availability on that channel;
- recipient array cardinality;
- every contact's account ownership.

Resume/Retry reconstructs delivery from the broadcast's stored `whatsapp_config_id`. Changing workspace primary after campaign creation cannot move a retry to another number. A legacy broadcast that has no safe stored channel is refused for resume rather than guessed.

## Templates and WABAs

Meta message-template catalogs are **WABA-scoped**, while wacrm sends are **phone-channel-scoped**. Local template copies are therefore stored per phone channel for deterministic sends.

When several channels in the same workspace share one WABA:

- **Sync** fetches Meta once and mirrors the catalog to sibling channels;
- **Submit** creates the Meta template once and updates sibling local copies;
- **Edit** changes Meta once and updates sibling copies;
- **Delete** removes Meta once and removes sibling copies;
- **Lifecycle webhooks** use Meta webhook `entry.id` (the WABA) and update only copies belonging to that WABA.

A lifecycle event without WABA context is dropped. The handler never falls back to globally updating rows by `meta_template_id` alone.

Settings → Templates has an explicit WhatsApp-number selector and uses account-level visibility rather than the logged-in creator's `user_id`.

## Media

Mirrored inbound media is durable and no longer needs Meta credentials. If mirroring is disabled or fails, the fallback proxy URL still contains `channel_id` so the correct channel token is used later.

For old/bookmarked proxy URLs without a channel parameter, the media endpoint first attempts to recover the channel from the stored message. A multi-number workspace is not allowed to guess an arbitrary primary channel when the media's ownership cannot be resolved.

## Public API

`POST /api/v1/messages` accepts:

```json
{
  "to": "+971500000000",
  "type": "text",
  "text": "Hello",
  "channel_id": "<whatsapp_config uuid>"
}
```

`whatsapp_config_id` is accepted as an alias. If omitted, primary remains the compatibility default for a new phone-based send.

Public conversation/message serializers return `channel_id`, and public broadcast create/status responses return the broadcast `channel_id`, so integrations can preserve number identity across subsequent requests.

## Operational checklist

For each production number:

1. Add the channel in Settings → WhatsApp.
2. Supply Phone Number ID, WABA ID and an appropriately permissioned token.
3. Supply the registration PIN where required.
4. Ensure the WABA is subscribed to the app.
5. Test the channel from Settings.
6. Open Settings → Templates, choose that number and sync the WABA catalog.
7. Send an inbound message and confirm the correct channel label appears.
8. Reply from the Inbox and verify Meta sends from the same number.
9. Trigger an automation/Flow on that conversation and verify the bot reply uses the same number.
10. Create a test broadcast and confirm its displayed **From** channel before sending.
11. Retry that broadcast after changing primary and confirm it still uses its original channel.

## Verification

`supabase/ci/verify-schema.sql` asserts the channel columns, indexes, conversation-scoped Flow uniqueness, channel-aware privileged broadcast RPC and relational hardening triggers after a clean migration replay.

The repository tests have been updated to cover exact-channel conversation resolution/sending, WABA-scoped lifecycle updates, Flow conversation ownership, channel-aware broadcast creation and stored-channel Resume/Retry.

Before deployment, actually execute:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

and replay all Supabase migrations from a clean database followed by `supabase/ci/verify-schema.sql`.

The feature PR must remain Draft until those executable checks pass.