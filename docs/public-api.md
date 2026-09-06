# Public API (`/api/v1`)

The public API lets integrations drive a wacrm account without the dashboard: send WhatsApp messages, manage contacts, read channel-specific conversations, launch broadcasts, and receive outbound webhooks.

> **Status:** stable. Authentication, scopes, rate limiting, messaging, contacts, conversations, broadcasts, and outbound webhooks ship now.

## Authentication

Send the API key as a bearer token:

```text
Authorization: Bearer wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Keys are account-scoped. A key acts only on the account where it was created.

Create or revoke keys under **Settings → API keys**. Only admins/owners can create keys, and the full secret is shown once.

## Scopes

| Scope | Allows |
| --- | --- |
| `messages:send` | Send WhatsApp messages |
| `messages:read` | Read messages and delivery status |
| `contacts:read` | List/read contacts |
| `contacts:write` | Create/update contacts |
| `conversations:read` | List/read conversations |
| `broadcasts:send` | Launch/read broadcast campaigns |
| `webhooks:manage` | Register/manage outbound webhooks |

A key with no scopes can still call `GET /api/v1/me`.

## Multiple WhatsApp numbers

A workspace may connect several WhatsApp phone numbers. Public API responses use `channel_id` for the `whatsapp_config` UUID that owns a conversation/message/broadcast.

For outbound operations:

- pass `channel_id` to explicitly choose the sender;
- `whatsapp_config_id` is accepted as an alias on write endpoints;
- if omitted for a new phone-number send or broadcast, the workspace primary channel is the backward-compatible default;
- an established conversation never moves to another number just because the primary changes.

For read operations, conversations/messages/broadcasts return `channel_id`. `GET /api/v1/conversations` can filter by `?channel_id=<uuid>` (or `?whatsapp_config_id=<uuid>`).

For integrations that operate a multi-number workspace, persist `channel_id` alongside conversation IDs rather than relying on the current primary.

## Response envelope

```jsonc
// success
{ "data": { /* ... */ } }

// failure
{ "error": { "code": "forbidden", "message": "This API key is missing the required scope" } }
```

Branch on `error.code`; human-readable messages may change.

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `bad_request` | Malformed/invalid input |
| 401 | `unauthorized` | Missing/invalid/revoked key |
| 403 | `forbidden` | Missing scope |
| 404 | `not_found` | Resource not found in this account |
| 409 | conflict-specific error | Supplied channel conflicts with stored resource identity |
| 429 | `rate_limited` | Rate limit exceeded |
| 500 | `internal` | Server error |

## Rate limits

Requests are limited per API key to 120 requests/minute. A `429` response includes `Retry-After` plus `X-RateLimit-*` headers.

The current limiter is in-memory/per-process. Multi-instance deployments should replace it with a shared store.

## Endpoints

### `GET /api/v1/me`

Returns the account bound to the key and its scopes. No scope beyond a valid key is required.

```bash
curl https://your-crm.example.com/api/v1/me \
  -H "Authorization: Bearer wacrm_live_xxx"
```

### `POST /api/v1/messages`

Scope: `messages:send`.

Send to an E.164 phone number. wacrm finds/creates the account-global contact and the conversation on the selected WhatsApp channel.

```bash
curl -X POST https://your-crm.example.com/api/v1/messages \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "+14155550123",
    "channel_id": "8bd1c3f8-1111-4444-9999-0123456789ab",
    "type": "text",
    "text": "Hi"
  }'
```

`type` may be `text` (default), `template`, `image`, `video`, `document`, or `audio`. Media requires `media_url`; `text` doubles as its caption. A template send uses:

```jsonc
{
  "to": "+14155550123",
  "channel_id": "<whatsapp_config uuid>",
  "type": "template",
  "template": {
    "name": "order_update",
    "language": "en_US",
    "params": ["A123"]
  },
  "reply_to_message_id": "<uuid>"
}
```

The selected template must be available on the selected channel/WABA.

Response (201):

```json
{
  "data": {
    "message_id": "…",
    "whatsapp_message_id": "wamid.…",
    "conversation_id": "…",
    "contact_id": "…",
    "contact_created": true,
    "channel_id": "…"
  }
}
```

Additional domain errors include `whatsapp_not_configured` (400), `whatsapp_channel_not_found` (404), `meta_error` (502), and `template_malformed` (500).

### `GET /api/v1/contacts`

Scope: `contacts:read`. Newest-first, keyset-paginated. Optional filters: `?search=` (name/phone) and `?tag=<tagId>`.

Contacts are account-global: one contact can have separate conversations on Sales and Support numbers.

### `POST /api/v1/contacts`

Scope: `contacts:write`. `phone` (E.164) is required; `name`, `email`, `company`, and `tags` are optional. This is find-or-create by phone within the account.

### `GET /api/v1/contacts/{id}` / `PATCH /api/v1/contacts/{id}`

Scopes: `contacts:read` / `contacts:write`. PATCH changes only supplied fields. Another account's contact returns `404`.

### `GET /api/v1/conversations`

Scope: `conversations:read`. Newest-first, paginated.

Optional filters:

- `?status=open|pending|closed`
- `?contact_id=<uuid>`
- `?channel_id=<whatsapp_config uuid>`
- `?whatsapp_config_id=<uuid>` (alias)

Each row returns its stable `channel_id` plus the embedded contact/tags.

Example:

```json
{
  "data": [
    {
      "id": "conv-uuid",
      "channel_id": "support-channel-uuid",
      "contact_id": "contact-uuid",
      "status": "open",
      "contact": { "id": "contact-uuid", "phone": "+14155550123", "name": "Jane", "tags": [] }
    }
  ],
  "meta": { "next_cursor": null }
}
```

### `GET /api/v1/conversations/{id}`

Scope: `conversations:read`. Returns the same channel-aware conversation shape. `404` if outside the key's account.

### `GET /api/v1/conversations/{id}/messages`

Scope: `messages:read`. Newest-first, paginated. Every message includes `channel_id`, `direction`, delivery `status`, `whatsapp_message_id`, and content fields. The conversation is account-validated first.

A message's `channel_id` should match its parent conversation for WhatsApp traffic; database guards enforce this for service-role writes.

### `POST /api/v1/broadcasts`

Scope: `broadcasts:send`.

Launch an approved-template broadcast. The campaign permanently stores its sending channel so Resume/Retry cannot move after the workspace primary changes.

```bash
curl -X POST https://your-crm.example.com/api/v1/broadcasts \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "July promo",
    "channel_id": "8bd1c3f8-1111-4444-9999-0123456789ab",
    "template_name": "promo_july",
    "template_language": "en_US",
    "recipients": [
      { "to": "+14155550123", "params": ["Jane"] },
      { "to": "+14155550124" }
    ]
  }'
```

Maximum: 1000 recipients/request. Invalid numbers are rejected before delivery.

Response (202):

```json
{
  "data": {
    "broadcast_id": "…",
    "channel_id": "…",
    "status": "sending",
    "total_recipients": 2,
    "accepted": 2,
    "rejected": 0
  }
}
```

### `GET /api/v1/broadcasts/{id}`

Scope: `broadcasts:send`. Returns `channel_id`, campaign status, and delivery/read/reply/failure counters.

## Pagination

List endpoints use opaque keyset cursors:

```text
GET /api/v1/contacts?limit=50
→ { "data": [...], "meta": { "next_cursor": "eyJ..." } }

GET /api/v1/contacts?limit=50&cursor=eyJ...
→ { "data": [...], "meta": { "next_cursor": null } }
```

Pass the cursor back verbatim. `next_cursor: null` means the last page.

## Webhooks

Register HTTPS endpoints under scope `webhooks:manage`.

Supported events:

| Event | Fires when |
| --- | --- |
| `message.received` | An inbound message arrives |
| `message.status_updated` | A stored outbound message changes delivery state |
| `conversation.created` | A new channel-specific conversation is opened |

Management endpoints:

- `POST /api/v1/webhooks`
- `GET /api/v1/webhooks`
- `GET /api/v1/webhooks/{id}`
- `PATCH /api/v1/webhooks/{id}`
- `DELETE /api/v1/webhooks/{id}`

The creation response returns the signing `secret` exactly once.

### Delivery envelope

```json
{
  "id": "8f3c…",
  "event": "message.received",
  "occurred_at": "2026-07-01T12:00:00.000Z",
  "account_id": "…",
  "data": {
    "conversation_id": "…",
    "contact_id": "…",
    "channel_id": "…",
    "whatsapp_message_id": "wamid.…",
    "content_type": "text",
    "text": "Hi"
  }
}
```

Channel identity is included in channel-specific events:

```jsonc
// message.received
{ "conversation_id": "…", "contact_id": "…", "channel_id": "…", "whatsapp_message_id": "wamid.…", "content_type": "text", "text": "Hi" }

// conversation.created
{ "conversation_id": "…", "contact_id": "…", "channel_id": "…" }

// message.status_updated
{ "whatsapp_message_id": "wamid.…", "conversation_id": "…", "channel_id": "…", "status": "delivered" }
```

### Verifying signatures

Headers include `X-Wacrm-Event`, `X-Wacrm-Webhook-Id`, and `X-Wacrm-Signature`.

`X-Wacrm-Signature` has form `t=<unix_seconds>,v1=<hex>`, where `v1` is HMAC-SHA256 over `"${t}.${rawBody}"` with the endpoint secret. Verify against the raw request body in constant time and reject stale timestamps.

### Delivery semantics

Delivery is best-effort: one short-timeout attempt, redirects are not followed, and callbacks may be duplicated or reordered. Dedupe on the delivery `id` and reconcile with read endpoints when correctness matters.

Repeated delivery failures increment `failure_count` and can auto-disable the endpoint. Re-enable it with PATCH after fixing the receiver.

Webhook targets must be public HTTPS destinations. Private, loopback, link-local, metadata-service and similar SSRF targets are rejected.

## Roadmap

The public API covers messaging, contacts, conversations, broadcasts, and outbound webhooks. Deals/pipelines, templates, flows, and durable webhook delivery queues remain future additions.