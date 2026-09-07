# Device notifications

Settings → Overview → Device notifications lets each user enable, test, and disable alerts on that browser. Notifications contain only “New WhatsApp message”; tapping opens the conversation. All channels in the user's current account are covered. Subscriptions are independent of login sessions: disable on a shared device before signing out. Removed account members are excluded when dispatching.

## Deployment

Apply `supabase/migrations/051_web_push.sql` before deploying this code. Add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT=https://wa.joyboy.work` to the server runtime environment. Generated keys are saved in the gitignored `.env.local` and `.env.production.local`; preserve this pair across deployments. No new GitHub build variables are needed: the authenticated API supplies the public key at runtime. Never commit the private key.

On iPhone (iOS 16.4+), open the HTTPS app from its Home Screen icon, go to Settings, and tap Enable on this device. Accept the system permission, then send a test notification. Focus modes and OS notification settings affect presentation. Existing installations may need to be reopened after deployment to pick up the manifest.

Test incoming delivery by sending a WhatsApp message from another phone after Meta webhooks are connected. Close wacrm first; verify the private alert appears and opens the correct thread. Repeat with another connected number. Replayed Meta message IDs must not produce another alert. Disable notifications and confirm no further alerts arrive. Permission and lock-screen delivery require testing on a real iPhone.

## Delivery behavior

Push runs only after a new inbound message is saved. Meta retries are deduplicated by the existing message insert. Provider network/5xx failures get one bounded retry, and expired subscriptions (404/410) are deleted. This is best-effort delivery, not a durable queue: a process crash or prolonged outage can lose an alert. Messages remain in the inbox. There is no unread badge synchronization yet. No page or API response is cached by the service worker.

Subscriptions are service-role-only in the database. API calls require an authenticated account, same-origin writes and a per-user rate limit; test and delete operations only address that user's device. Outbound URLs are restricted to Apple, Google and Mozilla push services. Subscription capability URLs and encryption keys must not be logged.
