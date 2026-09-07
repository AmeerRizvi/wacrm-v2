# Production: wa.joyboy.work

Target: CATSYS 12GB, root@207.180.251.120:22. Existing Caddy serves HTTPS.

## Release path

`.github/workflows/deploy.yml` checks main, runs lint/typecheck/tests, builds the existing Dockerfile, and transfers the exact commit image over SSH. Image transfer avoids adding a registry credential to the server. The image is currently built for Linux amd64; confirm server architecture before enabling.

Deployments require repository variable `DEPLOY_ENABLED=true` and use the GitHub `production` environment. Configure environment reviewers if desired. Deployment runs only through GitHub Actions → Deploy production → Run workflow. Select main. Pushes to any branch never trigger deployment; manual dispatch still requires main.

Repository/environment variables:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` (public client key, never service-role key)
- `DEPLOY_ENABLED` (keep false until server setup is verified)

GitHub environment secrets:

- `DEPLOY_HOST`: 207.180.251.120
- `DEPLOY_USER`: root (prefer a dedicated deployment identity later)
- `DEPLOY_SSH_KEY`: dedicated deployment private key
- `DEPLOY_KNOWN_HOSTS`: host key verified against trusted server information; never disable host verification

## Server prerequisites

Linux amd64, Docker Engine with Compose v2 supporting `up --wait`, Bash, flock, and existing Caddy. The deploy identity needs Docker access and ownership of `/opt/wacrm` (Docker access effectively grants root privileges).

Create `/opt/wacrm` and its `staging`/`releases` directories. Put runtime variables in `/opt/wacrm/.env.production` with mode 600. Keep a restricted, ignored local backup in `.env.production.local`.

Required variables: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY`, and `META_APP_SECRET`. Preserve the existing ENCRYPTION_KEY so saved encrypted credentials remain readable. Set `NEXT_PUBLIC_SITE_URL=https://wa.joyboy.work`, `META_APP_ID=1690492782000541`, and `AUTOMATION_CRON_SECRET`. Production disables template dry-run. Do not copy placeholder Meta secrets into production.

Install `deploy/Caddyfile` as `/etc/caddy/sites/wa.joyboy.work.caddy`. Preserve existing sites in the main `/etc/caddy/Caddyfile` and add `import /etc/caddy/sites/*.caddy` once. Validate the complete config before reloading Caddy. Future domains can each use a separate file in this directory. DNS must point wa.joyboy.work to the server. The app binds only 127.0.0.1:3100; only Caddy should expose it. Preserve Caddy's existing firewall configuration.

## Database and WhatsApp

Database migrations are deliberately separate from image deployment. Preview with `supabase db push --dry-run`, take a database backup, apply reviewed backward-compatible migrations, and verify schema before releasing code that depends on them. Never run db reset against production. Image rollback does not roll back database migrations. The current hosted database has migrations 001–050 applied.

Configure authenticated periodic calls to `/api/automations/cron` and `/api/flows/cron` using `x-cron-secret` when delayed automations are needed. Keep the secret in a restricted file, not in command arguments or checked-in crontabs.

After HTTPS and Meta credentials are verified, configure the Ameer (Test) WABA callback override to `https://wa.joyboy.work/api/whatsapp/webhook`; preserve the shared Jumnah callback. Saving identifiers in an env file does not create a CRM channel: configure the selected channel through Settings → WhatsApp.

## Health and rollback

The release script requires the new container's login route to return HTTP 200. On failure it restores the previous release's image and Compose configuration, then reports failure. This probes application startup, not an authenticated Supabase operation or WhatsApp delivery. Verify those separately after deploying.

Successful releases update `/opt/wacrm/current`. Images and release directories are retained for rollback; monitor disk and prune only releases no longer needed. A failed attempt retains its directory for diagnosis; inspect it before retrying the same SHA. Deployment replaces one container, so brief downtime is possible.

## Outstanding production security work

The earlier audit identified public chat media, incomplete outbound URL protection, report-only CSP, and dependency advisories. These are not fixed by deploying. Resolve before using sensitive customer data.
