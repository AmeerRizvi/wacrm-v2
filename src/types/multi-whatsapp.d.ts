// Multi-channel fields added by migrations 040-050.
//
// Keep these as module augmentations until the older monolithic `src/types`
// file is regenerated from the database schema. This makes channel identity
// visible to every existing `import type { ... } from '@/types'` call without
// duplicating the legacy interfaces or forcing unsafe local casts.
import '@/types'

declare module '@/types' {
  interface Conversation {
    /** Account tenancy key; NOT NULL since migration 017. */
    account_id: string
    /** WhatsApp number that permanently owns this conversation. */
    whatsapp_config_id: string | null
  }

  interface Message {
    /** Must match the parent conversation channel for WhatsApp messages. */
    whatsapp_config_id: string | null
  }

  interface WhatsAppConfig {
    account_id: string
    /** Human-readable channel name, e.g. "Sales UAE". */
    label: string | null
    /** Compatibility/default channel for operations with no explicit context. */
    is_primary: boolean
  }

  interface MessageTemplate {
    account_id: string
    /** Local channel copy of the WABA-scoped Meta template. */
    whatsapp_config_id: string | null
  }

  interface Broadcast {
    account_id: string
    /** Sending channel frozen when the campaign is planned. */
    whatsapp_config_id: string | null
    /**
     * Campaign-wide structured send-time values frozen at creation, such as a
     * media-header override. Optional here only for pre-050 object literals;
     * migration 050 makes the database column NOT NULL with an empty-object default.
     */
    template_message_params?: Record<string, unknown>
  }

  interface BroadcastRecipient {
    /** Inherited from the parent broadcast and enforced by DB trigger. */
    whatsapp_config_id: string | null
  }
}

export {}