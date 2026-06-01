# CaveCMS

A self-hosted, AI-native content management system. WordPress-shaped — every
page, post, and section lives as a tree of CMS blocks the operator drags,
drops, and edits in the browser.

- **Website**: [cavecms.derricksiawor.com](https://cavecms.derricksiawor.com)
- **Get started**: [cavecms.derricksiawor.com/get-started](https://cavecms.derricksiawor.com/get-started)
- **Source**: [github.com/derricksiawor/cavecms](https://github.com/derricksiawor/cavecms)
- **License**: [Prosperity Public License 3.0.0](./LICENSE.md) — free for
  personal, hobby, non-profit, government, and educational use; 30-day free
  commercial trial; paid license required for ongoing commercial use.

---

## What CaveCMS is

A single Next.js app + MariaDB pair. One process, one DB, one filesystem
root for uploads. No managed cloud, no S3, no Vercel. Designed to run on
a single VPS the way WordPress runs on shared hosting.

| Layer | Choice |
|---|---|
| App | Next.js 15.5 standalone + React 19 + TypeScript 5.9 |
| DB | MariaDB 10.11 (via mysql2 + drizzle-orm) |
| Auth | Self-hosted JWT (jose) + scrypt + CSRF + lockout, all DB-configurable |
| Media | sharp + filesystem (no S3) |
| Mail | SMTP via nodemailer + a persistent retry queue |
| Process | PM2 single-fork |
| Reverse-proxy | nginx + certbot |
| Updates | Built-in. One click in the admin dashboard. |

Everything an operator would configure — SMTP, site URL, reCAPTCHA, login
path, session timeouts, IP allowlists, lockout policy, integrations — lives
in `settings.*` rows you edit from the dashboard. **No `.env` editing after
install.**

---

## Install — one command, then a browser wizard

> **TL;DR**: `npx create-cavecms my-site` on your server, open the URL it
> prints, finish the browser wizard.

CaveCMS installs on four surfaces with the same one command:

- **VPS** (Ubuntu/Debian 22.04 LTS+ with systemd + nginx, own the whole box)
- **PM2** (shared Linux host already running other Next.js apps via PM2,
  e.g. a portfolio box serving multiple domains)
- **Laptop** (macOS / Linux dev box, for local evaluation)
- **cPanel** (shared host with Node.js Selector + Passenger)

### Prerequisites

- **Node 20+** on the target machine (via [nvm](https://github.com/nvm-sh/nvm)
  on Linux, the installer on macOS, or Node.js Selector on cPanel)
- **MariaDB 10.11+** reachable from the install target (local socket on VPS /
  PM2; local install on a laptop; provider-managed on cPanel)
- On VPS only: a domain pointed at the box (for HTTPS via Let's Encrypt) and
  sudo access during the CLI run
- On PM2 only: `pm2` installed, `www-data` user present, `/var/www/.pm2`
  initialised, and root/passwordless-sudo. The CLI registers a per-install
  PM2 app named `cavecms-<site>` under the existing `www-data` daemon and
  prints an nginx vhost block for the operator to paste into their existing
  vhost file

### One command

```bash
npx create-cavecms my-site
```

The CLI:

1. Detects whether you're on **VPS / PM2 / laptop / cPanel** and picks the right adapter
2. Downloads and signature-verifies the latest release from `cavecms.derricksiawor.com`
3. Unpacks the runtime to the canonical location for the surface
4. Prompts for the minimum it cannot auto-supply: database connection, public
   site URL, port
5. Generates **every** bootstrap secret (JWT, CSRF, preview, brochure, internal
   revalidate, secrets-encryption key, hidden login path)
6. Writes **one** sealed `env.production` file (mode `600`, owned by the
   service user) that you **never open or edit**
7. Runs database migrations
8. Starts the service (systemd on VPS, PM2 daemon on PM2, foreground on laptop,
   Passenger on cPanel)

On VPS installs the CLI also writes a ready-to-use nginx vhost. Total time:
about 2 minutes. Output:

```
✓ CaveCMS is running on https://your-domain.com
✓ Open https://your-domain.com/install to finish setup.
```

### Finish setup in the browser

The install wizard takes 3-5 minutes and writes everything to the database
— never to any file:

1. **Welcome**
2. **Admin account** — create your administrator user (email + 12+ char password)
3. **Site identity** — public site URL + site name
4. **Branding** — logo, brand color, footer text
5. **Contact info** — phone, email, address (used by contact forms + footer)
6. **Email (SMTP)** — paste credentials + test-send, or skip and configure later
7. **Security baseline** — pick a memorable login path, add reCAPTCHA keys, set
   an IP allowlist (all optional)
8. **Done** — sign in at the hidden admin path the wizard shows you

That's the whole install. There is **no** `wp-config.php` to edit, **no**
`.env` to fill in, **no** SSH after the CLI finishes. Everything operator-facing
lives in the dashboard.

---

## Updating

When a new release ships, every admin sees a banner across the top of the
dashboard: *"A new version of CaveCMS is ready to install."*

Click **Update Now**. A modal walks through the six-step install:

1. Getting ready
2. Downloading the new version
3. Preparing your data
4. Building your site
5. Restarting
6. Making sure everything works

If anything fails, CaveCMS automatically rolls back to the previous
version. Your site stays online the whole time.

Operators can also configure an email address under Settings → Updates to
be notified when a new release is published, even if no admin is logged in.

---

## Configuration

Every operator-configurable knob lives in the dashboard:

| Where | What |
|---|---|
| Settings → General | Site URL, site name |
| Settings → Email | SMTP host/port/user/password/from + lead-notification recipient |
| Settings → Security | Login path, reCAPTCHA, IP allow/blocklists, lockout thresholds, maintenance mode, session lifetimes |
| Settings → Integrations | GTM, GA4, Google Ads, Hotjar, Zoho SalesIQ, HubSpot, Zoho CRM |
| Settings → AI Assistant | Gemini API key for AI-driven content |
| Settings → Updates | Auto-apply security patches, notification email |

The only things that stay in `/etc/cavecms/env.production` are
**bootstrap-time** values that must exist before the database connects:
`DATABASE_URL`, `JWT_SECRET`, `CSRF_SECRET`, `PREVIEW_SECRET`,
`BROCHURE_SECRET`, `INTERNAL_REVALIDATE_SECRET`, `SECRETS_ENCRYPTION_KEY`,
`LOGIN_PATH`, and `UPLOADS_ROOT`. The bootstrap script generates all of
those for you; you should never need to touch them.

---

## Using AI Assistants with your CaveCMS install

If you're using Claude Code, Cursor, Windsurf, ChatGPT, Codex, or any other
AI coding assistant on a CaveCMS install: **read [`AGENTS.md`](./AGENTS.md)
first.** Short version:

> AI assistants must NOT modify CaveCMS source code. To build your site,
> use the CMS — create pages, drop in blocks, edit content via the admin
> API. But first the assistant has to **find your running instance** (its
> port lives in `env.production`) and **authenticate** — you log in as admin
> and hand it the session cookie (there's no API-token surface); from there
> it works through scripts against the admin API. It can't just start
> building blind, and it must never scrape secrets from `env.production`.
> That admin API is the only legitimate AI surface.
> Editing `app/`, `components/`, `lib/`, `db/`, or any other code path
> breaks updates, voids your license terms, and is forbidden.

The `AGENTS.md` file is read automatically by every major AI coding tool
that supports the convention (Claude Code, Cursor, Windsurf, Aider, Codex
CLI, OpenHands). Keep it in place; do not delete or edit it.

---

## License

CaveCMS is published under the [Prosperity Public License 3.0.0](./LICENSE.md).

- **Personal, hobby, non-profit, government, educational use** — free, no
  expiration, no key required.
- **Commercial use** — free for the first 30 days. After that, a paid
  commercial license is required. Contact `hello@derricksiawor.com` for
  pricing.

The source is open and auditable on GitHub. You may run CaveCMS on
infrastructure you control under either tier above. You may NOT redistribute
modified copies, sublicense, or host CaveCMS as a service to third parties
without a separate commercial agreement.

This model is the same one used by [Sentry](https://sentry.io),
[Plausible Analytics](https://plausible.io), and
[Cal.com](https://cal.com) — open enough to trust, closed enough to sustain
a single dev.

---

## Support + contributing

- **Bugs / feature requests**: open a GitHub issue.
- **Security disclosures**: email `security@derricksiawor.com` (please don't
  file public issues for security bugs).
- **Code contributions**: we don't accept pull requests at this time.
  CaveCMS is sole-maintained by Derrick S. K. Siawor; the canonical
  branch is closed to outside commits. The source is open so you can
  audit and fork for personal use, but the upstream is one-way.

Roadmap: see [GitHub Projects](https://github.com/derricksiawor/cavecms/projects).
