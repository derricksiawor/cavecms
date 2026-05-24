# Best World Properties — Next.js rebuild

Marketing site, blog, and admin CMS for **bestworldcompany.com**.
Single-server deploy, Apache-free, no managed cloud — everything that
runs in production is in this repo. Coexists with other Next.js apps
under PM2 on the same box.

---

## Stack

| Layer       | Choice                                            |
| ----------- | ------------------------------------------------- |
| App         | Next.js 15.5 (standalone) + React 19              |
| Lang        | TypeScript 5.9 (strict)                           |
| DB          | MariaDB 10.11 via mysql2 + drizzle-orm 0.36       |
| Auth        | Self-hosted JWT (jose) + scrypt + CSRF + lockout  |
| Media       | sharp + filesystem on the server (no S3)          |
| Mail        | SMTP via nodemailer + persistent `pending_emails` queue |
| Process     | PM2 (single fork, ecosystem.config.cjs)           |
| Reverse-proxy | nginx + certbot (managed by `scripts/install-nginx.sh`) |
| Backups     | age-encrypted dumps + rclone off-site, weekly restore drill |
| Deploy      | Manual: local build → `~/connect/connect` upload → `deploy.sh` over SSH |

---

## Prereqs

- **Node 22**, **pnpm 10**
- **MariaDB ≥ 10.11** (10.11 is the canonical version; tested on 10.6+)
- Linux / macOS for development
- Production target: **Ubuntu 24.04 LTS** server (or any compatible Linux already running Node 22 + PM2)

## First-time local setup

```bash
cp .env.example .env.local
# Edit .env.local:
#   - DATABASE_URL points at a local MariaDB user with full grants on the bwc DB
#   - Generate each of JWT_SECRET / CSRF_SECRET / PREVIEW_SECRET / BROCHURE_SECRET:
#       openssl rand -base64 64 | tr -d '\n'
#     They MUST be distinct; instrumentation.ts refuses boot otherwise.
#   - LOGIN_PATH = the hidden admin login slug (e.g. baccess). Discoverable
#     only by direct navigation; never advertise it.

pnpm install --frozen-lockfile

pnpm db:migrate              # apply db/migrations/*.sql + write schema-fingerprint.txt
pnpm db:seed                 # interactive: creates the initial admin user
                             #   (or pre-set BWC_ADMIN_EMAIL/NAME/PASSWORD env vars)
pnpm dev                     # http://localhost:3040  (auto-starts MariaDB
                             #   via docker-compose.dev.yml if 127.0.0.1:3306
                             #   isn't already reachable; set
                             #   BWC_SKIP_DOCKER=1 if you have a host MariaDB
                             #   and no Docker installed)
```

The admin dashboard lives at `http://localhost:3040/<LOGIN_PATH>`.

If `pnpm dev` errors with `Port 3040 is already bound`, a stale
`pnpm dev` from a prior session is holding the port — `pkill -f
"next dev"` (or kill the PID from `lsof -i :3040`) then re-run. Set
`BWC_SKIP_PORT_CHECK=1` to bypass for legitimate cases (e.g. running
`pnpm start` against an existing dev).

### Dev-bootstrap escape hatches

`scripts/dev-bootstrap.mjs` runs from `predev` / `prebuild` /
`prestart`. It bootstraps every dependency the app needs:

| Env var | Default | Purpose |
| --- | --- | --- |
| `BWC_SKIP_DOCKER=1` | unset | Skip the MariaDB Docker bootstrap when you have a host MariaDB on 127.0.0.1:3306 and no Docker installed. |
| `BWC_SKIP_PORT_CHECK=1` | unset | Skip the port-3040 conflict probe when running `pnpm start` against an existing `pnpm dev`. |
| `BWC_DEV_BOOTSTRAP_ALLOW_PROD_PATH=1` | unset | Allow `UPLOADS_ROOT` under `/opt/bwc/*` in non-production. Set only if you really need to point the dev box at the production uploads layout (uncommon — the canonical dev path is `./.test-uploads`). |

## Dev commands

```bash
pnpm dev                     # Next dev server (turbopack) on :3040
pnpm build                   # Production build (standalone)
pnpm start                   # Boot the standalone build locally
pnpm typecheck               # tsc --noEmit
pnpm lint                    # eslint
pnpm test                    # vitest unit + lib tests
pnpm test:integration        # vitest against a live DB
pnpm exec playwright test    # full e2e suite (boots its own dev server)
pnpm db:check                # verify schema_fingerprint vs baked-in baseline
pnpm db:studio               # drizzle-kit studio (local DB introspection UI)
```

---

## Deploy flow (manual, operator-driven)

No GitHub Actions, no CI/CD pipeline. The operator builds the
standalone artifact locally, uploads it via `~/connect/connect`, and
runs `scripts/deploy.sh` (or its individual steps) on the server over
SSH. The server is a shared box already running other Next.js apps
under PM2 — bwc deploys alongside them, not on a dedicated droplet.

### Building the artifact locally

```bash
# 1. Sanity gates
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm db:check                                          # local fingerprint sanity

# 2. Migrator bundle (flat, portable node_modules)
pnpm --filter=@bwc/migrator deploy --prod migrator-deploy

# 3. Stage release contents
SHA=$(git rev-parse --short HEAD)
STAGE=out/${SHA}
mkdir -p "${STAGE}/.next"
cp -r .next/standalone "${STAGE}/.next/standalone"
cp -r .next/static     "${STAGE}/.next/static"
cp -r public           "${STAGE}/public"
cp -r db               "${STAGE}/db"
cp -r scripts          "${STAGE}/scripts"
cp ecosystem.config.cjs package.json "${STAGE}/"
cp -r migrator-deploy "${STAGE}/migrator-bundle"

# 4. Compress
tar --use-compress-program='zstd -19 -T0' -cf "${SHA}.tar.zst" -C "${STAGE}" .
```

### Uploading to the server

`~/connect/connect <server>` is the canonical SSH/SCP wrapper. Upload
the tarball to the home directory of the configured user, then move it
into place over SSH.

```bash
~/connect/connect <server> upload "${SHA}.tar.zst"     # SCP into ~/

~/connect/connect <server>                              # interactive SSH
# Then, on the server:
sudo mv ~/<SHA>.tar.zst /opt/bwc/incoming/
sudo /opt/bwc/current/scripts/deploy.sh <SHA> production
```

`deploy.sh` extracts the tarball into `/opt/bwc/releases/<sha>/`, runs
the migrator against the production DB using `DATABASE_MIGRATOR_URL`
from `/etc/bwc/env.production`, atomically flips the
`/opt/bwc/current` symlink, PM2-reloads the app, and verifies
`/healthz` returns 200 three times. On healthz failure it
auto-invokes `rollback.sh`.

If you'd rather not use `deploy.sh` wholesale, the script's body is
ten readable phases you can run by hand on the server (preflight →
extract → migrator → fingerprint check → symlink flip → pm2 reload →
healthz × 3 → static-pool sync → cleanup). Read the top of
`scripts/deploy.sh` for the phase list.

### Manual rollback

```bash
~/connect/connect <server>
# on the server:
sudo /opt/bwc/current/scripts/rollback.sh
```

Flips `/opt/bwc/current` back to the prior release atomically. The
auto-rollback path from `deploy.sh` invokes this with `AUTO_ROLLBACK=1`
on `/healthz` failure during a deploy.

### Release tagging (convention)

Tags don't trigger anything automated — they're documentation. Convention:

- `v1.0.0` after the first successful production cutover proves stable
- `v1.0.x` for bug-fix releases
- `v1.x.0` for feature increments

Tag locally and push to whatever git remote you use:

```bash
git tag -a v1.0.0 -m "First production cutover"
```

---

## Server provisioning + ops scripts

All in `scripts/`. Read the script header for each one's contract; a
brief tour:

### Provisioning (`scripts/setup.sh`)

Idempotent fresh-droplet bootstrap. Creates the `bwc`, `bwc_migrator`,
and `bwcstate` system users / groups, installs MariaDB + the rclone +
age toolchains, lays out `/opt/bwc/{releases,current,incoming,uploads}`,
writes `/etc/bwc/env.production`, provisions the `/var/lib/bwc` marker
directory (mode 2770 root:bwcstate so bwc-user systemd services can
write into it via `SupplementaryGroups=bwcstate`), and emits a
"**NEXT STEPS**" block that operators must execute by hand (age key
generation, `rclone config`, `BACKUP_RCLONE_REMOTE` population).

### Deploy + rollback (`scripts/deploy.sh`, `scripts/rollback.sh`)

`deploy.sh` consumes the manually-built artifact at
`/opt/bwc/incoming/<sha>.tar.zst`. `rollback.sh` flips the
`/opt/bwc/current` symlink back to the previous release atomically.

### nginx + systemd installers

- `scripts/install-nginx.sh` — drops the vhost config, reloads nginx
  with the certbot deploy hook validating `nginx -t` before reload.
- `scripts/install-systemd.sh` — installs + enables + STARTS all
  cluster-1 and cluster-3 timer units (re-run is idempotent).

### Maintenance + retention

| Script                          | Schedule                | What it does |
| ------------------------------- | ----------------------- | ------------ |
| `scripts/disk-check.sh`         | hourly                  | Writes `/var/lib/bwc/deploy.blocked` if free space too low. `deploy.sh` reads it as a preflight gate. |
| `scripts/prune-static-pool.sh`  | daily 05:30 UTC         | Age-prunes hashed `.next/static` chunks under `/opt/bwc/static-pool/.next/static/` that no honoured release references anymore. |
| `scripts/db-backup.sh`          | daily 03:00 UTC         | age-encrypted full DB dump + off-site rclone copy. |
| `scripts/uploads-backup.sh`     | daily 04:30 UTC         | Full tar of `/opt/bwc/uploads` (tar → gzip → age, written as `.tar.age`) gated by a find-newer scan marker — runs the full archive only when uploads have actually changed since the last successful run; otherwise touches the health marker and exits. Off-site rclone copy on success. |
| `scripts/restore-drill.sh`      | **weekly Sun 02:00 UTC, automated** | Restores last night's encrypted dump into a scratch DB, runs assertions, drops the scratch DB. Refuses to run if backup > 3 days old. |
| `scripts/cron-purge.ts`         | daily 06:00 UTC         | Retention purge (login_attempts, audit_log, soft-deleted content_blocks, soft-deleted media). Gated on `/var/lib/bwc/last-uploads-backup.ok` ≤ 24h old. |
| `scripts/verify-media-refs.ts`  | weekly Sun 05:00 UTC    | Rebuilds the media_references reverse index from authoritative sources; logs drift to audit_log. |

Restore drill cadence: cluster-3 brought this **weekly + automated on
the server** when `/etc/bwc/age-identity` is present. If the operator
elects to keep the age private key off-box, the on-server weekly drill
logs "skipped: no identity" and the operator runs the drill off-box on
their own cadence. Off-box drills remain the canonical recovery-quality
gate after any incident.

---

## Backups + recovery

Backup pipeline:

1. `db-backup.sh` dumps the DB, pipes through gzip → age, writes to
   `/backup/bwc/db/<ts>.sql.age` (gzip is in-stream — the filename
   does not include `.gz`), then `rclone copy` to
   `BACKUP_RCLONE_REMOTE/db/`.
2. `uploads-backup.sh` tars uploads (full archive each run; whether
   the run produces a tarball at all is gated by a hidden scan
   marker that compares against the last successful run), pipes
   through gzip → age, writes to `/backup/bwc/uploads/<ts>.tar.age`,
   off-site copies.
3. `restore-drill.sh` decrypts last night's DB dump into a scratch
   schema, runs SELECT/COUNT smoke tests, and drops the scratch DB.
   Touches `/var/lib/bwc/last-restore-drill.ok` on success.

Recovery:

```bash
# Decrypt the latest DB backup off-line (e.g. on a recovery laptop).
# The filename ends in .sql.age (no .gz) but the stream IS gzipped —
# pipe through gunzip after decrypting:
age --decrypt -i /path/to/private-age-key \
  /path/to/<ts>.sql.age | gunzip > recovery.sql

mysql -u root bwc < recovery.sql
```

The age **private key** lives at `/etc/bwc/age-identity` on the server
ONLY if the operator has chosen to enable automated restore-drill (it
is opt-in per cluster-3's design — installing the private key on the
server trades a small ops-convenience win for a non-trivial blast
radius if the server is fully compromised). Without
`/etc/bwc/age-identity`, the weekly restore-drill timer logs "skipped:
no identity" and the operator runs the drill off-box on their own
schedule.

## State markers + cross-script contracts

`/var/lib/bwc/` is the shared state directory for ops scripts. Markers
are written by one script and consumed by others (deploy.sh, cron-purge,
operator dashboards). Future contributors editing any of these scripts
MUST preserve the contract or the consumer breaks silently:

| Marker                                   | Writer                    | Reader(s)                          | Mode |
| ---------------------------------------- | ------------------------- | ---------------------------------- | ---- |
| `last-db-backup.ok`                      | `db-backup.sh`            | (advisory only — operator-visible) | 644  |
| `last-uploads-backup.ok`                 | `uploads-backup.sh`       | **`cron-purge.ts` (≤ 24h)**        | 644  |
| `last-restore-drill.ok`                  | `restore-drill.sh`        | advisory                            | 644  |
| `deploy.blocked`                         | `disk-check.sh`           | **`deploy.sh` preflight**           | 640  |

`/var/lib/bwc` itself is `2770 root:bwcstate` — setgid so files inherit
the group. bwc-user services (cron-purge, the backup scripts) declare
`SupplementaryGroups=bwcstate` to read the directory; the app process
(also `bwc`, but not in `bwcstate`) cannot touch these files.

---

## Env var reference

`lib/env.ts` is the source of truth for the **app runtime**. Every key
in `.env.example` is documented inline there with units, defaults, and
the boot-time validation rules. **Do not add new env vars without
adding the Zod schema entry and `.env.example` line in the same PR.**

`/etc/bwc/env.production` (NOT a file in this repo — owned root:root
640 on the server) holds the **deploy-time + systemd-timer env**.
Listed in the footer of `.env.example` for visibility, but the app
never reads these.

---

## Troubleshooting

| Symptom                                            | Likely cause / fix |
| -------------------------------------------------- | ------------------ |
| `pnpm dev` errors with "secret must be ≥ 32 chars" | Each `*_SECRET` in `.env.local` must be ≥ 32 bytes. Regenerate with `openssl rand -base64 64`. |
| `/admin` returns 307 → `/`                         | Expected when unauthenticated (per gold-standard auth rules — login URL is never disclosed). Use the path in `LOGIN_PATH`. |
| 502 on the public site                             | `pm2 logs bwc` for the runtime stack; nginx maintenance page should be visible during a deploy. |
| Forgot admin password                              | `pnpm db:seed` refuses on a non-empty users table — reset via SQL on staging, or follow the password-reset flow in `/admin/users`. |
| `/healthz` returns 503                             | DB unreachable; check `pm2 logs bwc` and `mysql -u bwc -p`. |
| Deploy hangs at "running migrator"                 | Migrator is holding the advisory lock — confirm a prior deploy crashed without releasing. The lock auto-frees after the connection closes (≤60s after the crashed process exits). |
| Boot failure: "fingerprint mismatch"               | `db/schema-fingerprint.txt` (in the artifact) doesn't match `schema_fingerprint` row in the DB. The migrator should have updated both — a partial migration is the usual cause. See `deploy.sh`'s recovery instructions. |

---

## Operator handoff notes

The deploy target is an **existing shared production server** running
other Next.js apps under PM2. Coexistence rules:

- The bwc app gets its own PM2 entry (named `bwc` per
  `ecosystem.config.cjs`); the other apps are untouched.
- nginx is operator-managed — add a bwc-specific server block by hand
  rather than running `scripts/install-nginx.sh` wholesale (the
  install script assumes ownership of the nginx tree, which would
  conflict with the existing vhosts).
- `scripts/setup.sh` was written for a fresh droplet. On the existing
  server, **run only the parts you need**: the bwc user / group / dir
  layout block, the `/var/lib/bwc` marker directory, age key
  generation. Skip the apt-install, mariadb-setup, and nginx-bootstrap
  blocks if those are already provisioned.
- The systemd timers in `scripts/systemd/` (db-backup, uploads-backup,
  cron-purge, etc.) are bwc-namespaced (`bwc-*.service`/`.timer`) so
  they coexist with whatever other timers the box runs.

Before the first cutover:

- **age key**: decide whether to install `/etc/bwc/age-identity` on
  the server (enables automated weekly restore-drill) or keep the
  private key off-box (operator runs the drill on their own machine).
  Documented in cluster-3 `setup.sh` "NEXT STEPS".
- **`/etc/bwc/env.production`**: populate `DATABASE_URL` (app
  principal), `DATABASE_MIGRATOR_URL` (DDL principal),
  `BACKUP_RCLONE_REMOTE`, and any reCAPTCHA / SMTP keys. Mode 640
  root:root. `BACKUP_AGE_RECIPIENT` is written from
  `/etc/bwc/backup.pub` automatically if `setup.sh`'s age block was
  run.
- **`~/connect/connect`**: confirm the bwc target server is in the
  configured server list (`SERVER_IPS`/`SERVER_USERS`/`SERVER_KEYS`).
  Test `~/connect/connect <server>` and
  `~/connect/connect <server> upload <small-file>` round-trip before
  the cutover day.

---

## Cutover checklist

Run through this list **the day of the production flip**. None of these
steps are automated — operator responsibility.

- [ ] All projects published with content + brochure PDFs
- [ ] Initial admin user created on prod; credentials delivered out-of-band
- [ ] Smoke-tested every public page + every lead-capture form on staging
- [ ] Monitoring + alerting wired (uptime probe against `/healthz`,
      log shipping if applicable, on-call rotation knows the runbook)
- [ ] `restore-drill.sh` executed off-box (independent of the on-server
      weekly drill) within the prior 7 days
- [ ] Apex nginx server block ready (mirrors staging, but with apex
      `server_name` + no IP allowlist + indexable robots.txt)
- [ ] 301 redirects map old-site URLs → new ones (via
      `slug_redirects` table; bulk-import via SQL if needed)
- [ ] Apex `Let's Encrypt` cert pre-issued via DNS-01 challenge
      (avoids the HTTP-01 redirect-loop at first cutover)
- [ ] DNS TTL on the apex lowered to **60s, at least 24h before flip**
- [ ] Build the artifact locally (commands in "Deploy flow" above);
      `<sha>.tar.zst` lands at the workspace root
- [ ] `~/connect/connect <server> upload <sha>.tar.zst`
- [ ] On the server: `sudo mv ~/<sha>.tar.zst /opt/bwc/incoming/ && sudo /opt/bwc/current/scripts/deploy.sh <sha> production`
- [ ] Verify `/healthz` returns 200 and reports the new commit before
      DNS flip
- [ ] DNS A record on the apex updated → server IP
- [ ] Monitor `/healthz`, `pm2 logs bwc`, and `mysql -u root bwc -e
      "SELECT COUNT(*) FROM leads"` for 30 min after the flip
- [ ] DNS TTL restored to 3600s after 7 stable days

---

## Reference

- Design spec: `docs/specs/2026-05-10-bwc-rebuild-design.md`
- Deployment-ops plan (this rebuild's implementation log):
  `docs/superpowers/plans/2026-05-10-bwc-09-deployment-ops.md`
- Architecture / branding / typography: `docs/design/`
