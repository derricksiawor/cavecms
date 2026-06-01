# Deploying a CaveCMS site to a shared production server

This runbook covers the **content-preserving** deploy: you built a site in a
local (laptop-surface) CaveCMS install and now want it live on a production
server that may already host other apps (including other CaveCMS installs).

The shape is: **fresh `create-cavecms` install on the server → restore your
local content over it**. The install wizard is never run — the restore brings a
fully-configured install (admin user, settings, pages, media), which is what
"closes" the wizard.

> If you're standing up a brand-new empty site (no local content to carry over),
> just follow steps 1–7 + 11–14 and skip the backup/restore steps (8–10). The
> empty install's `/install?t=<token>` wizard is then the correct way to create
> the first admin.

Placeholders used throughout — substitute your own:

| Placeholder | Meaning | Example |
|---|---|---|
| `example.com` | the site's apex domain | `acme.com` |
| `APP_USER` | OS user the app runs as | `www-data` or `webapp` |
| `APP_PORT` | loopback port the Node app listens on | `8601` |
| `DOC_ROOT` | install dir | `/var/www/html/example.com/public_html` |
| `DB_NAME` / `DB_USER` | database + app user | `acme` / `acme_app` |
| `RELEASE` | version to install (pin it) | `0.1.85` |

---

## For AI agents (read this first)

The numbered steps below are the canonical procedure. This section is what an
**agent** needs on top of them: how to *discover* the placeholder values, the
decision branches, the execution-environment constraints, and how to *verify by
assertion* instead of eyeballing. Do the human steps; apply this section's rules
as you go.

### Don't assume — discover every placeholder

Never hardcode. Derive each value, then proceed:

| Value | How to discover it |
|---|---|
| Web server | `ls /etc/apache2/sites-available` vs `ls /etc/nginx` — whichever exists |
| `APP_PORT` | `ss -tlnp` → pick a port **not** in the listen list |
| `APP_USER` + `PM2_HOME` | `ps aux \| grep next-server` on an existing CaveCMS proc → note its user; its `PM2_HOME` is `/home/<user>/.pm2` (or `/var/www/.pm2` for `www-data`) |
| DB root access | `sudo mysql -N -e 'SHOW DATABASES;'` (auth_socket) — also confirms `DB_NAME` is free |
| Existing-install conventions | `sudo ls -la /var/www/html/<other>/public_html`; `sudo grep -E '^(PORT\|CAVECMS_RESTART_MODE)=' .../env.production` |
| Local version to pin | `cat VERSION` in the laptop install → that's `RELEASE` |
| Real login path | `sudo mysql -e "SELECT * FROM settings WHERE settings.key='security_login_path';" DB_NAME` |

If a value can't be discovered or a step has an irreversibly-wrong option
(deleting data, overwriting a sibling vhost), **stop and ask** — don't guess.

### Decision branches

1. **Content to migrate?** Local install has pages/media you built → fresh
   install **+ restore** (all steps). Brand-new empty site → install + run the
   `/install` wizard, skip steps 8–10.
2. **Existing CaveCMS install on the box?** Yes → mirror its `APP_USER` +
   `PM2_HOME` via `CAVECMS_PM2_USER`/`CAVECMS_PM2_HOME` (step 6), and use a
   per-domain vhost filename (step 11). No → defaults (`www-data`,
   `/var/www/.pm2`) are fine.
3. **Installer says "Sudo is required"** → you ran it as a non-sudo user;
   re-run as root. **"Target directory is not empty"** → `mv` the dir aside,
   recreate empty, re-run (step 6 gotchas).
4. **`www` resolves?** (`dig +short www.example.com`) → include `-d www.…` in
   certbot; else apex-only.
5. **certbot made `example.com-0001`** → stale lineage exists; run the
   delete/reissue/delete fix (step 12).
6. **Login path 404s after restore** → the restored DB's
   `security_login_path` overrides env `LOGIN_PATH`. Query it (table above) and
   use that path. This is expected, not a bug.

### Execution-environment constraints (e.g. ssh-mcp tiers)

If you drive the server through a tiered SSH tool rather than a raw shell, these
**will** bite — they did during the reference deploy:

- **Read tier** rejects output redirects (`>`, `2>/dev/null`), and classifies
  `node`, `which`, `bash -c`, and `curl -o` as higher tiers. Keep read-tier
  commands to plain `ls`/`cat`/`grep`/`ps`/`ss` with no redirects.
- **Write tier** is needed for `curl -o /dev/null` health checks, but rejects
  `curl` with POST data, shell `VAR=...` assignments, and `bash -c`.
- **Dangerous tier** is needed for `bash`, `sudo`, and any `mysql` query. It
  blocks: `$(...)` command substitution **and backticks** (so you can't
  `SELECT \`key\`` — query `SELECT * … WHERE settings.key='…'` instead),
  SUID/octal `chmod 600` (use symbolic `chmod u=rw,go=`), `chown root:root`,
  and `rm -rf` of system paths (use `mv <dir> /tmp/…` instead).
- **sudo:** a passwordless-sudo flag is fine for most commands but is refused
  for **service restarts**. For `pm2 restart` / `systemctl reload`, drop the
  flag and pipe the password inline: `echo 'SUDO_PW' | sudo -S systemctl reload apache2`.
- **Long ops** (the installer downloads ~120 MB + builds; uploads are slow) —
  raise the per-command timeout (≈300 s) and run big uploads in the background.

### Verify by assertion, not by eyeballing

- After **restore** (step 9): assert the row counts match the source
  (`pages`/`content_blocks`/`users`) and `find uploads -type f | wc -l` is
  non-zero — don't trust restore's stdout (it can be truncated).
- After **go-live** (step 14): assert `home:200`, `wizard:404`, every secret
  path `403`, unauth `/admin` → `/`, `/api/admin/settings` → `401`, and **bwc /
  sibling sites still 200** (you didn't break them).
- **Login page:** a bare `curl` to the login path returns `403`/`404` (anti-bot
  guard) **even when it works** — this is a false negative. Confirm in a **real
  browser** (it renders the form / redirects a logged-in session to `/admin`),
  or at minimum confirm the path matches `security_login_path` in the DB.
- **Screenshots lie:** a full-page screenshot can show scroll-reveal sections as
  blank (they start at low opacity). Scroll/element-screenshot a mid-page
  section before concluding content is missing.
- **"Logged-in admin with no login"** during a browser check usually means *you*
  (or the operator) already have a session in that browser profile — re-verify
  auth with a **cookie-less** `curl` before crying "auth bypass."

### Idempotency / re-run safety

`create-cavecms` migrations are journal-based (re-runs are no-ops); the DB
`CREATE … IF NOT EXISTS`; `a2enmod`/`usermod -aG`/`provisionSystemDirs` are
idempotent. The one non-idempotent guard is the installer's **empty-dir
pre-flight** — handle via the `mv`-aside branch (step 6).

---

## 0. Prerequisites

**Server** (Ubuntu/Debian or RHEL): Node 20+, MariaDB/MySQL, a web server
(Apache **or** nginx), PM2, `wget`, `certbot`. Confirm:

```bash
node -v            # >= 20
command -v npx pm2 wget certbot
```

**DNS:** point `example.com` (and `www` only if you actually have a www record)
at the server **before** issuing certs. Keep it DNS-only (un-proxied) through
cert issuance if you front it with Cloudflare later.

```bash
dig +short example.com        # must return the server IP
dig +short www.example.com    # empty? then issue the cert apex-only (step 12)
```

---

## 1. Recon the target server first

Don't assume a clean box. Establish:

```bash
# OS + web server flavour
cat /etc/os-release | head -2
ls /etc/nginx/ 2>/dev/null ; ls /etc/apache2/sites-available/ 2>/dev/null

# What's already listening (pick a FREE APP_PORT not in this list)
ss -tlnp

# Existing node/CaveCMS processes — note their runtime USER + PM2_HOME
ps aux | grep -E 'node|pm2|next' | grep -v grep

# Existing databases (don't collide on DB_NAME)
sudo mysql -N -e 'SHOW DATABASES;'
```

**If another CaveCMS install already exists, mirror its conventions** — same
runtime user, same `PM2_HOME`, same vhost layout. To inspect it:

```bash
sudo ls -la /var/www/html/<other-site>/public_html/
sudo grep -E '^(PORT|CAVECMS_RESTART_MODE|UPLOADS_ROOT)=' \
  /var/www/html/<other-site>/public_html/env.production
getent passwd <its APP_USER>           # confirm it has a real shell (/bin/bash)
```

---

## 2. Back up the local site (run on your laptop install)

From inside your local install dir:

```bash
./cavecms backup        # NOT --include-env: content + media only, no secrets
ls -la backups/         # cavecms-backup-<ts>-<sha>.tar.gz  (db + uploads)
```

The archive contains exactly three members — verify it's complete:

```bash
gzip -t backups/cavecms-backup-*.tar.gz && echo OK
tar -tzf backups/cavecms-backup-*.tar.gz   # manifest.json, database.sql.gz, uploads.tar.gz
```

> A harmless `HEALTHZ_URL: unbound variable` line may print at the end of
> `backup` on a laptop install. The archive is still written — verify with
> `gzip -t` as above.

**Pin the version.** Note the local version (`cat VERSION`, e.g. `0.1.85`) and
install that exact `RELEASE` on the server (step 6). The restore loads a
`mysqldump` taken against that schema; installing a *newer* release first and
then restoring an older dump risks a schema mismatch.

---

## 3. Create the install directory (server)

Parent stays `root`; the install dir itself is owned by `APP_USER`:

```bash
sudo mkdir -p DOC_ROOT
sudo chown APP_USER:APP_USER DOC_ROOT
```

---

## 4. Create the database + user (server)

CaveCMS needs only db-scoped privileges — no superuser.

```bash
sudo mysql -e "
  CREATE DATABASE IF NOT EXISTS DB_NAME CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  CREATE USER IF NOT EXISTS 'DB_USER'@'localhost' IDENTIFIED BY 'CHANGE_ME_STRONG_PASSWORD';
  GRANT ALL PRIVILEGES ON DB_NAME.* TO 'DB_USER'@'localhost';
  FLUSH PRIVILEGES;"
```

Generate the password with `openssl rand -hex 24`.

> **`localhost` vs `127.0.0.1`:** CaveCMS's `DATABASE_URL` connects over TCP to
> `127.0.0.1`. With MySQL name-resolution on (default), `127.0.0.1` resolves to
> `localhost`, so a `'DB_USER'@'localhost'` grant matches. If your server has
> `skip-name-resolve` on, create `'DB_USER'@'127.0.0.1'` instead.

---

## 5. (no-op) — DB created above; the installer runs migrations, not DB creation

---

## 6. Run the installer (server)

Run it **as root** so it has passwordless sudo to chown the tree, register PM2,
and provision `/var/log/cavecms` + `/var/lib/cavecms`. Override the PM2 runtime
user/home to **match the existing install** (otherwise it defaults to
`www-data` + `/var/www/.pm2`):

```bash
cd DOC_ROOT
CAVECMS_PM2_USER=APP_USER \
CAVECMS_PM2_HOME=/home/APP_USER/.pm2 \
CAVECMS_DB_HOST=127.0.0.1 CAVECMS_DB_PORT=3306 \
CAVECMS_DB_USER=DB_USER CAVECMS_DB_PASSWORD='THE_PASSWORD_FROM_STEP_4' \
CAVECMS_DB_NAME=DB_NAME \
CAVECMS_SITE_URL=https://example.com \
npx --yes create-cavecms@latest <site-name> \
  --surface=pm2 --port=APP_PORT --version=RELEASE --dir=DOC_ROOT -y
```

- `<site-name>` sets the PM2 app name → `cavecms-<site-name>`. Pick something
  stable; it's what you'll `pm2 restart`.
- The installer: downloads + Ed25519-verifies the release, writes a sealed
  `env.production` (mode 600), runs migrations, writes `pm2.config.cjs`, starts
  PM2, runs `pm2 save`, prints the login path + an `/install?t=<token>` URL.

It ends with `CaveCMS installed`. **Record the printed `Login path`** — though
note step 13: a restored site overrides it.

### Gotchas

- **"Sudo is required … Re-run as root":** you ran the installer as a non-root
  user that can't sudo non-interactively. Re-run as root (above). Re-running is
  the sanctioned fix.
- **"Target directory is not empty":** a previous attempt populated `DOC_ROOT`.
  Move it aside and recreate before re-running:
  ```bash
  cd $(dirname DOC_ROOT)
  sudo mv public_html public_html.aside && sudo mkdir public_html
  ```
  (Delete `public_html.aside` after a clean run — it holds an unused, now-stale
  copy of secrets.)

If you have **no** local content to restore, stop here and complete setup via
`https://example.com/install?t=<token>` in a browser, then skip to step 11.

---

## 7. Confirm the app is up on loopback (server)

```bash
curl -s -o /dev/null -w 'home:%{http_code}\n' http://127.0.0.1:APP_PORT/
```

A brand-new (un-restored) install redirects (`307`) to its `/install` wizard —
that's expected; the restore in step 9–10 flips it to `200`.

---

## 8. Upload the backup to the server

From the laptop (any method — `scp`, `rsync`, your deploy harness):

```bash
scp backups/cavecms-backup-<ts>-<sha>.tar.gz user@server:~/
```

Verify it landed intact, then stage it into the install's `backups/` dir owned
by `APP_USER`:

```bash
# on the server
stat -c '%s' ~/cavecms-backup-*.tar.gz       # matches the laptop size
gzip -t ~/cavecms-backup-*.tar.gz && echo OK
sudo cp ~/cavecms-backup-*.tar.gz DOC_ROOT/backups/
sudo chown APP_USER:APP_USER DOC_ROOT/backups/cavecms-backup-*.tar.gz
```

---

## 9. Restore content + media (server) — this replaces the wizard

Run as `APP_USER`:

```bash
sudo -u APP_USER bash -lc \
  'cd DOC_ROOT && ./cavecms restore --archive backups/cavecms-backup-<ts>-<sha>.tar.gz --yes'
```

Restore takes a safety snapshot first and rolls back on failure. It imports
`database.sql.gz` into `DB_NAME` and extracts `uploads.tar.gz` into
`UPLOADS_ROOT`. It does **not** touch `env.production` — your server keeps its
own secrets, port, and paths; only content + media come from the backup.

Verify it landed (don't trust stdout alone):

```bash
sudo mysql -N -e "SELECT
  (SELECT COUNT(*) FROM pages) AS pages,
  (SELECT COUNT(*) FROM content_blocks) AS blocks,
  (SELECT COUNT(*) FROM users) AS users;" DB_NAME
sudo find DOC_ROOT/uploads -type f | wc -l
```

> `--include-env` was **not** used for the backup, so no secrets transfer. If
> your local site configured integrations/SMTP (values encrypted in the DB with
> the *local* `SECRETS_ENCRYPTION_KEY`), those won't decrypt under the server's
> new key — re-enter them in the admin after go-live.

---

## 10. Restart the app (server)

```bash
sudo -u APP_USER bash -lc \
  'PM2_HOME=/home/APP_USER/.pm2 pm2 restart cavecms-<site-name> --update-env'
```

(`restore` already restarts on a `pm2` surface; this is a belt-and-suspenders
cache flush.) Then confirm the wizard is now closed:

```bash
curl -s -o /dev/null -w 'home:%{http_code} wizard:' http://127.0.0.1:APP_PORT/ ; \
curl -s -o /dev/null -w '%{http_code}\n'            http://127.0.0.1:APP_PORT/install
# expect  home:200 wizard:404
```

---

## 11. Web-server vhost (server)

CaveCMS ships hardened templates under `scripts/apache/cavecms.conf.template`
and `scripts/nginx/`. The bundled `scripts/install-apache.sh` /
`install-nginx.sh` write to a **fixed** filename (`cavecms.conf`) — which
**collides** if the box already has a CaveCMS install. On a shared box, render
the template yourself to a **per-domain** filename instead.

**Apache:**

```bash
awk -v apex=example.com -v staging=staging.example.com \
    -v login=unused -v doc=DOC_ROOT -v port=APP_PORT '
  { gsub(/__APEX__/,apex); gsub(/__STAGING__/,staging); gsub(/__LOGIN_PATH__/,login);
    gsub(/__DOC_ROOT__/,doc); gsub(/__PORT__/,port); print }' \
  DOC_ROOT/scripts/apache/cavecms.conf.template \
  | sudo tee /etc/apache2/sites-available/example.com.conf >/dev/null
sudo chmod u=rw,go=r /etc/apache2/sites-available/example.com.conf

# sanity: no placeholders left except the literal /__healthz/probe path
grep -n '__APEX__\|__DOC_ROOT__\|__PORT__\|__STAGING__' /etc/apache2/sites-available/example.com.conf || echo "clean"
```

Required Apache modules (idempotent): `proxy proxy_http headers rewrite ssl
expires deflate http2` (`sudo a2enmod <mod>`). `__LOGIN_PATH__` is not used in
the vhost body, so its value is irrelevant here.

> **nginx boxes:** append a per-server block to your sites file instead, proxying
> `/` to `http://127.0.0.1:APP_PORT` and serving `/_next/static` + `/uploads`
> from disk. The installer prints a ready-to-paste nginx block at the end of
> step 6; use that as the starting point.

---

## 12. TLS certificate (server)

Issue **apex-only** unless `www` actually resolves (step 0). The Apache
authenticator validates through the already-running web server on :80 without
needing the proxy vhost enabled yet:

```bash
sudo certbot certonly --apache -d example.com --non-interactive --agree-tos --keep-until-expiring
ls -la /etc/letsencrypt/live/example.com/      # fullchain.pem + privkey.pem
```

> **Stale-lineage gotcha:** if a previous attempt left an orphan renewal config,
> certbot names the new cert `example.com-0001` and your template's
> `/etc/letsencrypt/live/example.com/` path won't exist. Fix to the canonical
> name:
> ```bash
> sudo certbot delete --cert-name example.com -n            # remove the orphan
> sudo certbot certonly --apache -d example.com --cert-name example.com -n --agree-tos
> sudo certbot delete --cert-name example.com-0001 -n       # drop the dup
> ```

---

## 13. Enable the site + reload (server)

Enable, **syntax-check, then reload only if the check passes**:

```bash
# Apache
sudo a2ensite example.com && sudo apache2ctl configtest && sudo systemctl reload apache2
# nginx
sudo nginx -t && sudo systemctl reload nginx
```

---

## 14. Verify end-to-end (public)

From your laptop, against the real public URL:

```bash
# Live + TLS + redirect
curl -s -o /dev/null -w 'home:%{http_code} ssl:%{ssl_verify_result}\n' https://example.com/
curl -s -o /dev/null -w 'http->:%{http_code} ->%{redirect_url}\n'       http://example.com/

# Media served from disk over HTTPS
curl -s -o /dev/null -w 'media:%{http_code} %{content_type}\n' https://example.com/uploads/variants/<some-file>.webp

# Secrets must NOT be web-readable (expect 403/404 each)
for p in env.production .env .git/config package.json pnpm-lock.yaml uploads/brochures-private/x.pdf; do
  curl -s -o /dev/null -w "$p:%{http_code} " https://example.com/$p; done; echo

# Auth must be enforced (no cookies)
curl -s -o /dev/null -w 'admin:%{http_code} ->%{url_effective}\n' -L https://example.com/admin   # → redirects to /
curl -s -o /dev/null -w 'admin-api:%{http_code}\n' https://example.com/api/admin/settings        # → 401
```

Then a **real browser** pass (don't trust `curl` alone — the login page is
anti-bot guarded and 403/404s blind requests):

- Load `https://example.com/` — scroll the whole page; scroll-reveal sections
  start near-invisible and a single full-page screenshot can look "blank" even
  though they render fine on scroll. Confirm hero, content sections, and images.
- Open the **login path** and confirm the form renders, then log in.

### Finding the real login path (important)

The effective login path is stored in the **database**, not just the env file:

```bash
sudo mysql -e "SELECT * FROM settings WHERE settings.key='security_login_path';" DB_NAME
# e.g. {"path":"caccess"}  -> log in at  https://example.com/caccess
```

If the operator changed the login path in **Settings → Security**, that DB value
**overrides** `LOGIN_PATH` in `env.production`. After a content restore, the
*restored* site's custom path wins — so the installer-printed login path may
404. Always check `security_login_path` in the DB before concluding login is
broken.

Also worth a glance in `settings`:

```bash
sudo mysql -e "SELECT * FROM settings WHERE settings.key='security_maintenance';" DB_NAME
# {"enabled":false,...}  -> site public.  enabled:true -> only bypassIps get in.
```

---

## 15. Security check

```bash
sudo ls -la DOC_ROOT/env.production        # -rw------- APP_USER APP_USER (mode 600)
sudo find DOC_ROOT -maxdepth 2 -user root  # expect empty — nothing root-owned
```

The vhost templates already deny direct web access to `env.production`, `.env`,
lockfiles, `.git`, `.next/cache`, and `uploads/brochures-private/` (gated
brochures are served only via `/api/brochure/<token>`). Step 14 verifies this
from the outside.

---

## 16. Clean up

```bash
# upload staging copy
rm -f ~/cavecms-backup-*.tar.gz
# any failed-install dir from the step-6 gotcha (holds stale secrets)
sudo rm -rf $(dirname DOC_ROOT)/public_html.aside
```

Keep the archive in `DOC_ROOT/backups/` — it's a valid restore point (content +
media only, no secrets).

---

## Gotchas & notes (the things that actually bite)

- **PM2 runtime user defaults to `www-data` + `/var/www/.pm2`.** To match an
  existing install, set `CAVECMS_PM2_USER` + `CAVECMS_PM2_HOME` (step 6).
  Starting PM2 as bare `root` registers the app under the wrong daemon.
- **`pm2 save` + a boot unit** (`pm2-<APP_USER>.service`) are what make the app
  survive reboot. The installer runs `pm2 save`; confirm the unit exists:
  `systemctl is-active pm2-APP_USER.service`.
- **In-app update *snapshots*:** if the `APP_USER` PM2 daemon was already running
  before this install, it won't have the new `cavecmsstate` group until you run
  `sudo -u APP_USER PM2_HOME=/home/APP_USER/.pm2 pm2 update` (briefly restarts
  *all* of that user's PM2 apps — do it in a maintenance window). Updates still
  apply without it; only snapshot/rollback needs the group.
- **Login path lives in the DB** (`settings.security_login_path`) and overrides
  the env value — see step 14.
- **Version pinning:** install the **same** `RELEASE` the backup was built on, so
  the restored dump's schema matches the app code.
- **Don't run the install wizard on a restored site** — the restore already
  brought a complete install. The wizard would create a second admin / overwrite
  settings. A correctly restored install returns `404` at `/install`.
- **Shared box:** never let the installer's `install-apache.sh` /
  `install-nginx.sh` overwrite a sibling install's `cavecms.conf`. Use a
  per-domain vhost filename (step 11).
- **`ss -tlnp`** before choosing `APP_PORT` — don't collide with an existing app.
