# CaveCMS

The speed and polish of a hand-coded Next.js site, with a CMS anyone can edit.
Self-hosted, AI-native, batteries included. Every page, post, and section is a
tree of blocks your clients drag, drop, and edit in the browser, or that your
AI agent edits over a real API.

- **Website**: [cavecms.com](https://cavecms.com)
- **Get started**: [cavecms.com/get-started](https://cavecms.com/get-started)
- **Docs**: [cavecms.com/docs](https://cavecms.com/docs)
- **Source**: [github.com/derricksiawor/cavecms](https://github.com/derricksiawor/cavecms)
- **License**: [Prosperity Public License 3.0.0](./LICENSE.md). Free for
  personal, hobby, non-profit, government, and educational use; 30-day free
  commercial trial; paid license required for ongoing commercial use.

---

## What CaveCMS is

A single Next.js app plus a MariaDB database. One process, one DB, one
filesystem root for uploads. No managed cloud, no S3, no Vercel. It runs on a
single VPS the way WordPress runs on shared hosting, and installs on a laptop
or shared cPanel just as easily.

| Layer | Choice |
|---|---|
| App | Next.js 15.5 standalone + React 19 + TypeScript 5.9 |
| DB | MariaDB 10.11 (mysql2 + drizzle-orm) |
| Auth | Self-hosted JWT (jose) + scrypt + CSRF + lockout, all DB-configurable |
| Media | sharp + filesystem (no S3) |
| Mail | SMTP via nodemailer + a persistent retry queue |
| Process | PM2 / systemd / Passenger, by surface |
| Reverse proxy | nginx or Apache + certbot |
| Updates | Built in. One click in the dashboard, or one command in the shell. |

Everything an operator configures (SMTP, site URL, reCAPTCHA, login path,
session timeouts, IP allowlists, lockout policy, API tokens, backups,
integrations) lives in the database and is edited from the dashboard.
**No `.env` editing after install.**

---

## What you can do with it

- **Edit in the browser.** Click any word on any page and change it, autosaved.
  Drag sections between columns and pages. Type `/` to drop in a block from a
  library of 30+ (hero, gallery, pricing, FAQ, contact form, and more).
- **Edit with AI, inline.** Highlight any text and ask AI to rewrite, shorten,
  or translate it, in your voice, through your own Gemini key.
- **Edit with AI agents, over a real API.** A scoped, revocable `cave_` token
  lets Cursor, Claude Code, Windsurf, or Codex read and edit your live site
  (pages, posts, the block tree, media, branding) through a real HTTP API, or
  through the built-in **MCP server**. No browser in the loop.
- **Ship local to production.** Build on a laptop or staging copy, then promote
  the whole site to your live URL in one command with `cavecms push`:
  drift-guarded, atomic, and backed up first.
- **Back up automatically.** Scheduled, optionally AES-256-encrypted backups of
  your whole site (database, media, and secrets if you want them) to Google
  Drive, OneDrive, or local disk, with one-click restore.
- **Stay current safely.** Every release installs in one click behind a
  maintenance screen, signature-verified and health-checked, with automatic
  rollback if anything fails.

SEO, security headers, redirects, sitemaps, and structured data are built in,
not bolted on as plugins.

---

## Install: one command, then a browser wizard

> **TL;DR**: run `npx create-cavecms my-site` on your server, open the URL it
> prints, finish the browser wizard.

CaveCMS installs on four surfaces with the same one command:

- **VPS** (Ubuntu/Debian 22.04 LTS+ with systemd + nginx; you own the box)
- **PM2** (a shared Linux host already running other Next.js apps via PM2)
- **Laptop** (macOS / Linux, for local evaluation)
- **cPanel** (shared host with the Node.js Selector + Passenger)

### Prerequisites

- **Node 20+** on the target machine
- **MariaDB 10.11+** reachable from the install target (10.6 is the hard
  minimum; pure MySQL is not supported)
- On VPS: a domain pointed at the box (for HTTPS via Let's Encrypt) and sudo
  during the CLI run
- On PM2: `pm2` installed, `www-data` present, `/var/www/.pm2` initialised, and
  passwordless sudo

### One command

```bash
npx create-cavecms my-site
```

The CLI detects your surface, downloads and signature-verifies the latest
release, unpacks it, prompts only for what it cannot auto-supply (database
connection, public URL, port), generates every bootstrap secret, writes one
sealed `env.production` (mode 600) you never open, runs migrations, and starts
the service. On VPS it also writes a ready-to-use nginx vhost. About two
minutes.

```
✓ CaveCMS is running on https://your-domain.com
✓ Open https://your-domain.com/install to finish setup.
```

### Finish in the browser

The wizard takes 3-5 minutes and writes everything to the database, never to a
file: admin account, site identity, branding, contact info, SMTP (or skip), and
a security baseline (a memorable hidden login path, optional reCAPTCHA, optional
IP allowlist). There is no `wp-config.php` to edit, no `.env` to fill in, no SSH
after the CLI finishes. The full per-surface walkthrough (including cPanel) lives
at [cavecms.com/get-started](https://cavecms.com/get-started).

---

## Day two: update, recover, sync

Every release shows as a banner in the dashboard (Settings → Updates). Click
**Update now** and a six-step install runs behind a maintenance screen, with
automatic rollback if the new version does not come up healthy. Operators can
set a notification email to hear about releases even when logged out.

The same engine runs from the shell. The `cavecms` shortcut is set up at install
time (from any install directory `./cavecms <command>` or
`npx create-cavecms@latest <command>` is equivalent):

```bash
cavecms status              # what's running, and is an update waiting
cavecms update              # install the latest, auto-rolls back on failure
cavecms rollback            # restore the previous version, even offline
cavecms push --from=<url>   # promote a local or staging site onto this one
```

`cavecms update --version=X.Y.Z` pins a release; `cavecms update --force`
re-installs the current one to recover a broken build; `cavecms help` lists
everything.

---

## Edit your site with AI agents (the HTTP API + MCP)

CaveCMS treats programmatic editing as a first-class feature. There are two ways
an AI tool drives your live site, both landing on the same validated, audited
engine the dashboard uses:

1. **The built-in MCP server.** Every install runs a Model Context Protocol
   server at `/api/cms/mcp`. Connect Claude Code, Cursor, or Windsurf with one
   command and your AI gets typed, named tools for your site.
2. **The HTTP API.** Generate a token in **Settings → API Tokens**, send
   `Authorization: Bearer cave_…`, and read or edit pages, posts, the
   section → column → widget block tree, media, and branding. A single batch
   endpoint (`POST /api/cms/pages/{id}/batch`) applies many edits in one
   transaction.

Tokens are **scoped** (one role, editor or admin), **capped** to content and
branding (never user accounts, security settings, secrets, or the updater, even
for an admin token), **shown once** (stored only as a hash), and **revocable**
instantly. Every install also ships an [`AGENTS.md`](./AGENTS.md) that AI coding
tools read automatically.

Reference: the [API docs](https://cavecms.com/docs/api), the
[MCP guide](https://cavecms.com/docs/mcp), and
[connecting an assistant](https://cavecms.com/docs/agents).

> **For AI assistants working in a CaveCMS clone:** read [`AGENTS.md`](./AGENTS.md)
> first. You must NOT modify CaveCMS source code (`app/`, `components/`, `lib/`,
> `db/`, config); that breaks the update path and the license. Build the
> operator's *site* through the API or MCP with their token; never edit the
> *engine*. Keep `AGENTS.md` in place; do not delete or edit it.

---

## Backups

**Settings → Backups** schedules backups of your whole site (database, uploaded
media, and optionally your secrets) on a daily or weekly cadence, to **Google
Drive**, **OneDrive**, or **local disk**. Turn on a passphrase and each archive
is AES-256 encrypted before it leaves the box. Restore from the cloud or a local
file in one click, with a safety snapshot taken first.

---

## Configuration

Every operator-configurable knob lives in the dashboard:

| Where | What |
|---|---|
| Settings → General | Site URL, site name |
| Settings → Branding | Logo, colors, fonts, favicon |
| Settings → Email | SMTP host/port/user/password/from + lead-notification recipient |
| Settings → Security | Login path, reCAPTCHA, IP allow/blocklists, lockout, maintenance mode, session lifetimes |
| Settings → API Tokens | Scoped, revocable `cave_` tokens for the API + MCP |
| Settings → Backups | Destination (Google Drive / OneDrive / local), schedule, encryption, retention |
| Settings → Integrations | GTM, GA4, Google Ads, Hotjar, Zoho SalesIQ, HubSpot, Zoho CRM |
| Settings → AI Assistant | Gemini API key for inline AI |
| Settings → Updates | Auto-apply security patches, notification email |

The only values in `env.production` are bootstrap secrets the CLI generates
(`DATABASE_URL`, `JWT_SECRET`, `CSRF_SECRET`, `SECRETS_ENCRYPTION_KEY`,
`LOGIN_PATH`, `UPLOADS_ROOT`, and a few more). You should never need to touch
them.

---

## Security

- **Hidden admin URL.** A random login path per install; the middleware never
  leaks it in a redirect or error message.
- **JWT + CSRF + rate limits.** HS256 session tokens (jose), CSRF on every
  mutation, per-IP and per-email login limits with progressive lockout.
- **Strict CSP.** Per-request nonce, no `unsafe-eval` in production; an
  integration's origins appear in the policy only when the operator toggles that
  integration on.
- **Sealed secrets.** Bootstrap secrets are generated once, written mode 600,
  and never hand-edited; all later config flows through the database.

---

## License

CaveCMS is published under the [Prosperity Public License 3.0.0](./LICENSE.md).

- **Personal, hobby, non-profit, government, educational use**: free, no
  expiration, no key required.
- **Commercial use**: free for the first 30 days. After that, a paid commercial
  license is required. Contact `hello@cavecms.com` for pricing.

The source is open and auditable. You may run CaveCMS on infrastructure you
control under either tier. You may NOT redistribute modified copies, sublicense,
or host CaveCMS as a service to third parties without a separate commercial
agreement. This is the same model used by [Sentry](https://sentry.io),
[Plausible](https://plausible.io), and [Cal.com](https://cal.com): open enough to
trust, closed enough to sustain a single maintainer.

---

## Support and contributing

- **Bugs / feature requests**: open a GitHub issue.
- **Security disclosures**: email `support@cavecms.com` (please do not file
  public issues for security bugs).
- **Code contributions**: pull requests are not accepted at this time. CaveCMS is
  sole-maintained by Derrick S. K. Siawor; the canonical branch is closed to
  outside commits. The source is open so you can audit and fork for personal use.

Roadmap: [GitHub Projects](https://github.com/derricksiawor/cavecms/projects).
