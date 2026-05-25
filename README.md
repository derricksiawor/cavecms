# CaveCMS

A self-hosted, AI-native content management system. WordPress-shaped — every
page, post, and section lives as a tree of CMS blocks the operator drags,
drops, and edits in the browser.

- **Source**: [github.com/derricksiawor/cavecms](https://github.com/derricksiawor/cavecms)
- **Releases**: [cavecms.derricksiawor.com](https://cavecms.derricksiawor.com)
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

## Install — the 5-minute path

> **TL;DR for the impatient**: provision a VPS with MariaDB, run the
> bootstrap script, open the URL it prints, finish the browser wizard.

### Prerequisites

- A Linux VPS (Ubuntu 22.04 LTS+ tested), 1 GB RAM minimum (2 GB recommended)
- A domain name pointed at the VPS (for HTTPS via Let's Encrypt)
- **MariaDB 10.11+** running locally (`apt install mariadb-server`)
- **Node 22** + **pnpm 10** (via [corepack](https://nodejs.org/api/corepack.html)
  or [nvm](https://github.com/nvm-sh/nvm))
- Root or sudo access during install

### Step 1 — Download + verify the release

```bash
# Download the latest signed release manifest
curl -sSL https://cavecms.derricksiawor.com/manifest.json -o /tmp/manifest.json

# Fetch the tarball + signature listed in the manifest
LATEST=$(awk -F'"' '/"version":/ {print $4; exit}' /tmp/manifest.json)
curl -sSL "https://cavecms.derricksiawor.com/releases/cavecms-${LATEST}.zip" \
  -o /tmp/cavecms.zip

# Verify SHA256 against the manifest (one-liner; replace with the value
# from manifest.json's `sha256` field for that release)
EXPECTED=$(awk -F'"' '/"sha256":/ {print $4; exit}' /tmp/manifest.json)
echo "$EXPECTED  /tmp/cavecms.zip" | sha256sum -c
```

### Step 2 — Extract + bootstrap

```bash
sudo mkdir -p /opt/cavecms/releases
sudo unzip -q /tmp/cavecms.zip -d /opt/cavecms/releases
sudo ln -sfn "/opt/cavecms/releases/cavecms-${LATEST}" /opt/cavecms/current

# Run the one-shot bootstrap. Prompts for MariaDB root password, creates
# the `cavecms` user + database, generates ALL secrets, writes
# /etc/cavecms/env.production, runs migrations, provisions the systemd
# unit, starts the service.
sudo /opt/cavecms/current/scripts/bootstrap.sh
```

The bootstrap script prints the next step:

```
✓ CaveCMS is running on 127.0.0.1:3040
✓ Configure your domain in nginx, then open:
  https://your-domain.com/install
```

### Step 3 — Point your domain at the server

Install nginx + a Let's Encrypt cert. The bootstrap script writes a
ready-to-use nginx vhost at `/etc/nginx/sites-available/cavecms`:

```bash
sudo ln -s /etc/nginx/sites-available/cavecms /etc/nginx/sites-enabled/
sudo certbot --nginx -d your-domain.com
sudo systemctl reload nginx
```

### Step 4 — Finish setup in the browser

Open `https://your-domain.com/install` and walk through the wizard:

1. **Welcome** — confirm you're ready
2. **Admin account** — create your administrator user (email + 12+ char password)
3. **Site identity** — your public site URL + site name
4. **Email** — paste SMTP credentials, OR skip and configure later under Settings → Email
5. **Done** — sign in at the obscured admin path the bootstrap script printed

That's the whole install. There is no `wp-config.php` to edit, no `.env`
to fill in. Everything else is in the dashboard.

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
> API. That's the only legitimate AI surface. Editing `app/`, `components/`,
> `lib/`, `db/`, or any other code path breaks updates, voids your license
> terms, and is forbidden.

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
