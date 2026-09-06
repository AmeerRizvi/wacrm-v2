# Multi-WhatsApp Channels

wacrm supports multiple Meta WhatsApp Business Cloud API phone numbers inside one account/workspace.

## Mental model

An **account** is the tenant/workspace. A **WhatsApp channel** is one row in `whatsapp_config` and represents one Meta `phone_number_id` plus its WABA credentials. An account may own many channels; exactly zero or one is marked `is_primary`.

```
Account
├── Sales UAE       (primary)
├── Support UAE
├── Abu Dhabi
└── Sri Lanka
```

Contacts remain account-global. Conversations are channel-specific, so the same contact may have one thread with Sales and another with Support.

```
contacts
  └── customer +9715...
      ├── conversation / Sales UAE
      └── conversation / Support UAE
```

This prevents a reply received on one number from accidentally being sent from another.

## Database model

Migration `040_multi_whatsapp_channels.sql` converts the existing single-config design in place. Existing encrypted credentials are not copied or renamed.

### `whatsapp_config`

New fields:

- `label` — human-readable channel name such as `Sales UAE`.
- `is_primary` — default channel for legacy/API operations that do not explicitly choose one.

The old `UNIQUE(account_id)` constraint is removed. `phone_number_id` remains globally unique. A partial unique index allows at most one primary channel per account.

### Channel-bound entities

`whatsapp_config_id` is added to:

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

Template uniqueness becomes channel/WABA scoped:

```
(whatsapp_config_id, name, language)
```

Active Flow uniqueness is conversation scoped so one customer can independently interact with bots on two different WhatsApp numbers.

## Settings

Open **Settings → WhatsApp**.

The channel manager can:

- list every connected number
- add another number
- edit a channel label/WABA/credentials
- test a specific channel against Meta
- mark a channel primary
- toggle inbound media mirroring per channel
- remove an unused channel

When editing an existing channel, leaving access/verify token fields blank retains the encrypted values already stored.

## Inbox

The Inbox offers:

- **All numbers** — unified shared inbox
- a filter for each connected WhatsApp number
- a channel label on each thread while viewing All numbers

Every conversation stores `whatsapp_config_id`. Outbound text, media, templates, interactive messages, replies and reactions resolve the exact channel attached to that conversation.

## Inbound webhook routing

Meta includes `metadata.phone_number_id` on messaging webhook changes. The webhook resolves exactly one `whatsapp_config` row from that ID before processing the change.

That resolved channel is then used for:

- contact/conversation routing
- inbound message persistence
- media download credentials
- delivery/read/failed status updates
- broadcast recipient status updates
- broadcast reply tracking
- automation context
- Flow dispatch
- AI auto-reply context
- public webhook payloads

Meta message IDs (`wamid`) must not be treated as globally unique across phone numbers. Status lookups are therefore scoped by both `message_id` and `whatsapp_config_id`.

## Outbound messages

`sendMessageToConversation()` loads the conversation first and then loads its `whatsapp_config_id`. It does not choose a channel from the logged-in agent.

Legacy conversations with no channel fall back to the account primary channel only for upgrade compatibility.

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

Broadcasts and recipients store their sending channel. The immediate broadcast API accepts `channel_id` / `whatsapp_config_id`.

For backward compatibility, migration 040 includes triggers that infer the channel from the selected template when older browser code creates a broadcast without `whatsapp_config_id`; if no template channel can be resolved, the primary channel is used. Recipient rows inherit the parent broadcast channel.

Template sends are resolved against the same channel/WABA used by the broadcast.

## Templates

Templates are scoped to the WhatsApp channel because Meta template catalogs live under WABAs.

- Sync: `POST /api/whatsapp/templates/sync?channel_id=<uuid>`
- Submit: request body accepts `channel_id` / `whatsapp_config_id`
- Edit/delete: uses the channel stored on the template row
- Sending: resolves the template inside the conversation/broadcast channel

If no channel is explicitly supplied by a legacy caller, the primary channel is used where backward compatibility is safe.

## Media

Inbound mirrored media is durable and does not need Meta credentials after mirroring. The fallback Meta media proxy includes `?channel_id=<uuid>` so it decrypts the correct channel token.

## Security and tenancy

The existing account RLS model remains authoritative. `whatsapp_config` remains settings-class data: account members may read it according to existing policies while admin-level roles perform configuration writes.

Sensitive tokens remain encrypted at rest using the existing encryption helper. API list responses never return encrypted token ciphertext.

A Meta `phone_number_id` may only exist once on a wacrm instance. This guarantees inbound routing maps one phone number to one tenant/channel.

## Upgrade behavior

For an installation upgrading from one WhatsApp number:

1. migration 040 marks the existing config primary;
2. existing conversations/messages/broadcasts/templates are stamped with that config;
3. old behavior remains unchanged until another channel is added;
4. new threads are created per account/contact/channel.

No credential re-entry is required for the existing channel.

## Operational checklist

For each added production number:

1. Add the channel in Settings → WhatsApp.
2. Supply Phone Number ID, WABA ID and a token with the required WhatsApp permissions.
3. Supply the registration PIN where required for the production number.
4. Ensure the WABA is subscribed to the app.
5. Test the channel from Settings.
6. Send an inbound message to the number and confirm it appears with the correct channel label.
7. Reply from the inbox and verify Meta shows the reply from the same number.
8. Sync templates for that channel before template/broadcast use.

## Verification

The migration CI smoke test (`supabase/ci/verify-schema.sql`) asserts the channel columns and key unique indexes exist after replaying all migrations from a clean database.

The normal CI workflow should still run:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Do not deploy the branch until both the application CI and clean-database migration replay pass.
