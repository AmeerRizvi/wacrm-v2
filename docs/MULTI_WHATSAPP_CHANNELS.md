# Multi-WhatsApp Channels

wacrm supports multiple Meta WhatsApp Business Cloud API phone numbers inside one account/workspace.

## Mental model

An **account** is the tenant/workspace. A **WhatsApp channel** is one row in `whatsapp_config` and represents one Meta `phone_number_id` plus the credentials used to operate it.

```
Account
├── Sales UAE       (primary)
├── Support UAE
├── Abu Dhabi
└── Sri Lanka
```

When an account has at least one channel, exactly one channel is maintained as primary. The primary is only a compatibility/default choice for operations that do not explicitly supply a channel; existing conversations never switch to it automatically.

Contacts remain account-global. Conversations are channel-specific, so the same contact may have one thread with Sales and another with Support.

```
contacts
  └── customer +9715...
      ├── conversation / Sales UAE
      └── conversation / Support UAE
```

This prevents a reply received on one number from accidentally being sent from another.

## Database model

Migration `040_multi_whatsapp_channels.sql` converts the existing single-config design in place. Migration `041_multi_channel_hardening.sql` adds second-pass integrity rules. Existing encrypted credentials are preserved.

### `whatsapp_config`

New fields:

- `label` — human-readable channel name such as `Sales UAE`.
- `is_primary` — default channel for legacy/API operations that do not explicitly choose one.

The old `UNIQUE(account_id)` constraint is removed. `phone_number_id` remains globally unique. Primary-channel changes are serialized in PostgreSQL and performed transactionally; deleting an unused primary channel promotes the oldest remaining channel.

`phone_number_id` is immutable after channel creation. Changing a channel row from one phone number to another would rewrite the meaning of historical conversations, messages and broadcasts, so a different number must be added as a new channel.

A WABA ID may be corrected before templates are used. Once template history exists on that channel, changing its WABA is rejected because Meta template IDs belong to the original WABA catalog.

### Channel-bound entities

`whatsapp_config_id` is stored on:

- `conversations`
- `messages`
- `broadcasts`
- `broadcast_recipients`
- `message_templates`

Existing rows are backfilled to the account's prior/primary channel.

Conversation uniqueness becomes:

```
(account_id, contact_id, whatsapp_config_id)
```

instead of `(account_id, contact_id)`.

Active Flow uniqueness is conversation-scoped, so one customer can independently interact with bots on two different WhatsApp numbers.

Database triggers also enforce that:

- a conversation/broadcast/template cannot reference another tenant's channel;
- a message channel must match its parent conversation;
- a broadcast recipient channel must match its parent broadcast;
- a broadcast template must exist on the selected sending channel.

These checks intentionally protect service-role webhook/worker writes as well as browser writes, because service-role clients bypass RLS.

## Settings → WhatsApp

The channel manager can:

- list every connected number;
- add another number;
- edit channel label, WABA and credentials where safe;
- test a specific channel against Meta;
- mark a channel primary;
- toggle inbound media mirroring per channel;
- see registration/WABA subscription health;
- remove an unused channel.

Leaving access/verify token fields blank while editing keeps the encrypted values already stored. Channels with retained conversations, messages, broadcasts or templates cannot be deleted; `ON DELETE RESTRICT` preserves their historical identity.

## Inbox

The Inbox offers:

- **All numbers** — unified shared inbox;
- a filter for each connected WhatsApp number;
- a channel label on each thread while viewing All numbers.

Every conversation stores `whatsapp_config_id`. Outbound text, media, templates, interactive messages, replies and reactions resolve the exact channel attached to that conversation.

The template picker also resolves the active conversation's channel first and only shows approved templates available on that number.

## Inbound webhook routing

Meta includes `metadata.phone_number_id` on messaging webhook changes. The webhook resolves exactly one `whatsapp_config` row from that ID before processing the change.

That resolved channel is used for:

- contact/conversation routing;
- inbound message persistence;
- media download credentials;
- delivery/read/failed status updates;
- broadcast recipient status updates;
- broadcast reply tracking;
- automation context;
- Flow dispatch;
- AI auto-reply context;
- public webhook payloads.

Meta message IDs (`wamid`) must not be treated as globally unique across phone numbers. Status lookups are scoped by both `message_id` and `whatsapp_config_id`.

## Outbound messages

`sendMessageToConversation()` loads the conversation first and then its `whatsapp_config_id`. It does not choose a channel from the logged-in agent.

Legacy conversations with no channel fall back to the account primary only for upgrade compatibility.

The public endpoint `POST /api/v1/messages` accepts either:

```json
{
  "to": "+971500000000",
  "type": "text",
  "text": "Hello",
  "channel_id": "<whatsapp_config uuid>"
}
```

or the alias `whatsapp_config_id`. If omitted, the primary channel is used. The response includes `channel_id`.

## Broadcasts

Broadcasts and recipients permanently store their sending channel. The broadcast wizard shows the sending number on each template card, persists the selected template's `whatsapp_config_id`, stamps recipients with the same channel and supplies `channel_id` on every batch send.

The immediate broadcast API also accepts `channel_id` / `whatsapp_config_id`.

Migration 040 retains a compatibility trigger for older callers that omit the channel, but current UI paths do not depend on that guess. Migration 041 additionally rejects a broadcast if the requested template is not available on the chosen channel.

## Templates and WABAs

Meta message-template catalogs are **WABA-scoped**, while wacrm sending is **phone-channel-scoped**. A workspace can therefore have two important cases:

1. two phone numbers under different WABAs — each has a distinct template catalog;
2. two phone numbers under the same WABA — both share the same Meta catalog.

wacrm stores a local template copy per phone channel so sends remain deterministic by `whatsapp_config_id`. When multiple workspace channels share one WABA:

- **Sync** fetches Meta once and mirrors the catalog to every sibling channel on that WABA;
- **Submit** creates the Meta template once and creates/updates every sibling local copy;
- **Edit** changes Meta once and updates every sibling local copy;
- **Delete** removes Meta once and removes every sibling local copy;
- **lifecycle webhooks** use Meta's webhook `entry.id` (WABA ID) and update only local copies belonging to that WABA.

Settings → Templates has an explicit WhatsApp-number selector. It is account-scoped, not `user_id`-scoped, so all workspace admins see the same catalog for the selected channel.

Endpoints:

- Sync: `POST /api/whatsapp/templates/sync?channel_id=<uuid>`
- Submit: body accepts `channel_id` / `whatsapp_config_id`
- Edit/delete: uses the channel/WABA stored on the template row
- Sending: resolves the template inside the conversation/broadcast channel

## Media

Inbound mirrored media is durable and does not need Meta credentials after mirroring. The fallback Meta media proxy includes `?channel_id=<uuid>` so it decrypts the correct channel token.

Migration 040 also rewrites pre-migration fallback media URLs to append their backfilled channel ID. Changing the primary channel later therefore cannot make an old attachment use another number's credentials.

## Security and tenancy

The existing account RLS model remains authoritative. Channel configuration mutations require the admin role before any Meta-side registration/subscription side effect is attempted.

Sensitive tokens remain encrypted at rest using the existing encryption helper. Channel-list API responses never return encrypted token ciphertext.

A Meta `phone_number_id` may only exist once on a wacrm instance. This guarantees inbound routing maps one phone number to one tenant/channel.

Database account/channel guards are additional defense in depth for privileged background paths that bypass RLS.

## Upgrade behavior

For an installation upgrading from one WhatsApp number:

1. migration 040 marks the existing config primary;
2. existing conversations/messages/broadcasts/templates are stamped with that config;
3. old fallback media URLs are bound to that config;
4. old behavior remains unchanged until another channel is added;
5. new threads are created per account/contact/channel.

No credential re-entry is required for the existing channel.

## Operational checklist

For each added production number:

1. Add the channel in Settings → WhatsApp.
2. Supply Phone Number ID, WABA ID and a token with the required WhatsApp permissions.
3. Supply the registration PIN where required for the production number.
4. Ensure the WABA is subscribed to the app.
5. Test the channel from Settings.
6. Open Settings → Templates, choose that number and sync the WABA catalog.
7. Send an inbound message to the number and confirm it appears with the correct channel label.
8. Reply from the inbox and verify Meta shows the reply from the same number.
9. Create a test broadcast and confirm the wizard shows the intended **From** channel before sending.

## Verification

`supabase/ci/verify-schema.sql` asserts the channel columns, unique indexes and hardening triggers after replaying all migrations from a clean database.

Application validation should run:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

and the migration workflow should replay the complete schema from a clean local Supabase database.

Do not deploy the branch until both application checks and the clean-database migration replay pass.