#!/usr/bin/env bash
# scripts/setup-shared.sh — provisioning for an EXISTING shared server
# that already runs other Next.js apps under PM2. Skips the blocks of
# scripts/setup.sh that would conflict with the box's existing state:
#
#   - MariaDB install + bwc_user/bwc_migrator/bwc_backup creation
#     (operator creates these by hand with their preferred password
#     policy and grants — see "NEXT STEPS" output)
#   - nginx config drop (operator adds a bwc vhost coexisting with
#     the existing server blocks)
#   - ufw rules (operator manages firewall holistically)
#   - certbot deploy hook (existing renewal infra usually has one)
#
# What it DOES provision:
#
#   1. bwc system user + bwc / bwcstate groups; adds www-data to bwc
#   2. /opt/bwc/{releases,current,incoming,uploads/{originals,variants,
#      brochures-private,.tmp},static-pool/.next/static}
#   3. /backup/bwc/{db,uploads,pre-deploy}  bwc:backup 750
#   4. /var/lib/bwc                          root:bwcstate 2770 (setgid)
#   5. /etc/bwc directory + age key pair (operator decides whether to
#      keep the private key on-box for automated restore-drill)
#   6. pm2-logrotate (50M, retain 30, compress)
#   7. /etc/bwc/env.production scaffold with auto-generated app secrets
#      (JWT/CSRF/PREVIEW/BROCHURE/HEALTHZ) — operator fills DATABASE_URL,
#      SMTP, reCAPTCHA after MariaDB user creation
#   8. /etc/bwc/.setup-shared-complete marker
#
# Run as root. Idempotent: re-running with the marker present is a no-op.

set -euo pipefail
IFS=$'\n\t'

# shellcheck disable=SC2154  # rc and BASH_COMMAND are assigned inside the trap string.
trap 'rc=$?; echo "[setup-shared.sh] FAIL (rc=$rc) at line $LINENO: $BASH_COMMAND" >&2' ERR

if [ "$(uname -s)" != "Linux" ]; then
  echo "[setup-shared.sh] Linux-only. Refusing to run on $(uname -s)." >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "[setup-shared.sh] Run as root." >&2
  exit 1
fi

STATE_MARKER=/etc/bwc/.setup-shared-complete
if [ -f "$STATE_MARKER" ]; then
  echo "[setup-shared.sh] Already provisioned ($STATE_MARKER exists)."
  echo "  To re-provision: rm $STATE_MARKER (and clean /etc/bwc + /opt/bwc manually first)."
  exit 0
fi

# Preflight — every tool used below
for cmd in openssl pm2 age install; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[setup-shared.sh] FAIL: prerequisite '$cmd' not installed." >&2
    exit 1
  fi
done
if ! id www-data >/dev/null 2>&1; then
  echo "[setup-shared.sh] FAIL: 'www-data' user missing — install nginx first." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Users + groups
# ---------------------------------------------------------------------------
if ! getent group bwc >/dev/null; then
  groupadd --system bwc
  echo "[setup-shared.sh] created group bwc"
fi
if ! getent group bwcstate >/dev/null; then
  groupadd --system bwcstate
  echo "[setup-shared.sh] created group bwcstate"
fi
if ! getent group backup >/dev/null; then
  groupadd --system backup
  echo "[setup-shared.sh] created group backup"
fi
if ! id bwc >/dev/null 2>&1; then
  useradd --system --gid bwc --home-dir /home/bwc --create-home --shell /usr/sbin/nologin bwc
  echo "[setup-shared.sh] created user bwc"
fi
# www-data needs read on /opt/bwc/uploads + /opt/bwc/static-pool for nginx
# to serve static assets. Idempotent: usermod -aG is a no-op if already a member.
usermod -aG bwc www-data

# ---------------------------------------------------------------------------
# 2. /opt/bwc filesystem layout
# ---------------------------------------------------------------------------
install -d -o root  -g root  -m 755 /opt/bwc
install -d -o bwc   -g bwc   -m 750 /opt/bwc/releases
install -d -o bwc   -g bwc   -m 750 /opt/bwc/incoming
install -d -o bwc   -g bwc   -m 750 /opt/bwc/uploads
install -d -o bwc   -g bwc   -m 750 /opt/bwc/uploads/originals
install -d -o bwc   -g bwc   -m 750 /opt/bwc/uploads/variants
install -d -o bwc   -g bwc   -m 750 /opt/bwc/uploads/brochures-private
install -d -o bwc   -g bwc   -m 750 /opt/bwc/uploads/.tmp
install -d -o bwc   -g bwc   -m 750 /opt/bwc/static-pool
install -d -o bwc   -g bwc   -m 750 /opt/bwc/static-pool/.next
install -d -o bwc   -g bwc   -m 750 /opt/bwc/static-pool/.next/static

# Same-fs assertion: lib/media/storage.ts depends on rename(2) being
# atomic across these dirs. If the operator put /opt/bwc on one device
# and /opt/bwc/uploads on a separate mount, every upload would fail.
ROOT_DEV=$(stat -c %d /opt/bwc/uploads)
for d in originals variants brochures-private .tmp; do
  dev=$(stat -c %d "/opt/bwc/uploads/$d")
  if [ "$dev" != "$ROOT_DEV" ]; then
    echo "[setup-shared.sh] FAIL: /opt/bwc/uploads/$d is on a different filesystem than /opt/bwc/uploads (dev $dev vs $ROOT_DEV)" >&2
    echo "  rename(2) is atomic only within a filesystem. Move /opt/bwc/uploads to a single mount and re-run." >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# 3. /backup/bwc filesystem layout
# ---------------------------------------------------------------------------
install -d -o root -g backup -m 755 /backup
install -d -o bwc  -g backup -m 750 /backup/bwc
install -d -o bwc  -g backup -m 750 /backup/bwc/db
install -d -o bwc  -g backup -m 750 /backup/bwc/uploads
install -d -o bwc  -g backup -m 750 /backup/bwc/pre-deploy

# ---------------------------------------------------------------------------
# 4. /var/lib/bwc — shared state marker dir, root:bwcstate 2770
#    The setgid bit makes files written here inherit the bwcstate group;
#    bwc-user systemd services declare `SupplementaryGroups=bwcstate` to
#    read the markers. See cluster-3 / cluster-4 contract docs.
# ---------------------------------------------------------------------------
install -d -o root -g bwcstate -m 2770 /var/lib/bwc

# ---------------------------------------------------------------------------
# 5. /etc/bwc + age key pair
# ---------------------------------------------------------------------------
install -d -o root -g root -m 755 /etc/bwc
if [ ! -f /etc/bwc/backup.pub ]; then
  age-keygen -o /etc/bwc/age-identity 2>/dev/null
  chmod 600 /etc/bwc/age-identity
  chown root:root /etc/bwc/age-identity
  age-keygen -y /etc/bwc/age-identity > /etc/bwc/backup.pub
  chmod 644 /etc/bwc/backup.pub
  echo "[setup-shared.sh] generated age key pair (private: /etc/bwc/age-identity, public: /etc/bwc/backup.pub)"
  echo "[setup-shared.sh]   IMPORTANT: back up /etc/bwc/age-identity off-box NOW — it cannot be regenerated."
  echo "[setup-shared.sh]   To run automated restore-drill, leave it on the server (default)."
  echo "[setup-shared.sh]   For tighter blast-radius, move it off-box: cp + shred -u /etc/bwc/age-identity."
fi

# ---------------------------------------------------------------------------
# 6. PM2 logrotate
# ---------------------------------------------------------------------------
PM2_BIN=$(command -v pm2)
if ! runuser -u bwc -- "$PM2_BIN" list >/dev/null 2>&1; then
  # First-ever pm2 invocation for the bwc user; primes ~bwc/.pm2/
  runuser -u bwc -- "$PM2_BIN" ping >/dev/null 2>&1 || true
fi
if ! runuser -u bwc -- "$PM2_BIN" describe pm2-logrotate >/dev/null 2>&1; then
  if ! runuser -u bwc -- "$PM2_BIN" install pm2-logrotate; then
    echo "[setup-shared.sh] WARN: pm2-logrotate install failed. Re-run after fixing the cause:" >&2
    echo "  sudo -u bwc $PM2_BIN install pm2-logrotate" >&2
  fi
fi
runuser -u bwc -- "$PM2_BIN" set pm2-logrotate:max_size 50M >/dev/null
runuser -u bwc -- "$PM2_BIN" set pm2-logrotate:retain 30 >/dev/null
runuser -u bwc -- "$PM2_BIN" set pm2-logrotate:compress true >/dev/null
runuser -u bwc -- "$PM2_BIN" set pm2-logrotate:rotateInterval '0 0 * * *' >/dev/null

# /var/log/bwc for direct file logging (systemd journal is the primary
# sink, but some scripts append here too).
install -d -o bwc -g bwc -m 750 /var/log/bwc

# ---------------------------------------------------------------------------
# 7. /etc/bwc/env.production scaffold
# ---------------------------------------------------------------------------
# Auto-generate app secrets. Healthz token + JWT/CSRF/PREVIEW/BROCHURE
# all need to be set BEFORE the first deploy; pre-generating saves the
# operator from a manual edit between this script and deploy.sh.
if [ ! -f /etc/bwc/env.production ]; then
  JWT_SECRET="$(openssl rand -hex 48)"
  CSRF_SECRET="$(openssl rand -hex 48)"
  PREVIEW_SECRET="$(openssl rand -hex 48)"
  BROCHURE_SECRET="$(openssl rand -hex 48)"
  HEALTHZ_TOKEN="$(openssl rand -hex 32)"
  AGE_PUB="$(cat /etc/bwc/backup.pub)"

  install -m 640 -o root -g bwc /dev/null /etc/bwc/env.production
  cat > /etc/bwc/env.production <<EOF
NODE_ENV=production
PORT=3040
HOSTNAME=127.0.0.1

# PATH for systemd timer units to resolve tsx from the release node_modules
PATH=/opt/bwc/current/node_modules/.bin:/usr/local/bin:/usr/bin:/bin

# Database — separate principals for runtime (DML) and migrator (DDL).
# Create these manually on the shared MariaDB instance:
#   CREATE USER 'bwc_user'@'127.0.0.1' IDENTIFIED BY '...';
#   CREATE USER 'bwc_migrator'@'127.0.0.1' IDENTIFIED BY '...';
#   CREATE DATABASE bwc CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
#   GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON bwc.* TO 'bwc_user'@'127.0.0.1';
#   GRANT ALL PRIVILEGES ON bwc.* TO 'bwc_migrator'@'127.0.0.1';
#   GRANT REFERENCES, EVENT, CREATE TEMPORARY TABLES ON bwc.* TO 'bwc_user'@'127.0.0.1';
#   FLUSH PRIVILEGES;
DATABASE_URL=mysql://bwc_user:CHANGE_ME@127.0.0.1:3306/bwc
DATABASE_MIGRATOR_URL=mysql://bwc_migrator:CHANGE_ME@127.0.0.1:3306/bwc

# Secrets — auto-generated. NEVER edit in place; bump tokens_valid_after
# for all users if rotating JWT_SECRET.
JWT_SECRET=$JWT_SECRET
CSRF_SECRET=$CSRF_SECRET
PREVIEW_SECRET=$PREVIEW_SECRET
BROCHURE_SECRET=$BROCHURE_SECRET

# Hidden admin login slug — set to a memorable but obscure path
LOGIN_PATH=CHANGE_ME_LOGIN_PATH

# Public origin — drives sitemap canonical URLs, JSON-LD, robots.
SITE_ORIGIN=https://CHANGE_ME.bestworldcompany.com

# Health-check bearer (required by deploy.sh).
HEALTHZ_TOKEN=$HEALTHZ_TOKEN

# Build metadata — deploy.sh overrides per-release.
BWC_COMMIT=unknown
BWC_RELEASE_TS=

# SMTP — fill in to enable lead emails / brochure delivery.
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
SMTP_FROM_NAME=Best World Properties
SALES_EMAIL=
ADMIN_ALERT_EMAIL=

# reCAPTCHA v3 — required in production for public forms.
NEXT_PUBLIC_RECAPTCHA_SITE_KEY=
RECAPTCHA_SECRET_KEY=
RECAPTCHA_MIN_SCORE=0.5

# Backup encryption recipient (age public key).
BACKUP_AGE_RECIPIENT=$AGE_PUB

# Off-site backup target — REQUIRED for db-backup.sh and uploads-backup.sh.
# Configure rclone remote: sudo -u bwc rclone config
# Then set the destination here:
BACKUP_RCLONE_REMOTE=
EOF
  echo "[setup-shared.sh] wrote /etc/bwc/env.production (mode 640 root:bwc)"
fi

# ---------------------------------------------------------------------------
# 8. Mark complete
# ---------------------------------------------------------------------------
touch "$STATE_MARKER"

cat <<EOF

[setup-shared.sh] OK. Marker: $STATE_MARKER

NEXT STEPS (operator):

  1. MariaDB users — connect to your existing MariaDB instance as a
     privileged user and run the CREATE USER / GRANT block in
     /etc/bwc/env.production's DATABASE_URL comment. Then replace the
     CHANGE_ME passwords with the actual values.

  2. /etc/bwc/env.production — fill in:
       LOGIN_PATH (6-32 lowercase alphanumeric/dashes)
       SITE_ORIGIN (your apex URL)
       SMTP_* (after picking an SMTP provider)
       NEXT_PUBLIC_RECAPTCHA_SITE_KEY + RECAPTCHA_SECRET_KEY
       BACKUP_RCLONE_REMOTE (after running 'sudo -u bwc rclone config')

  3. nginx — add a bwc server block by hand (do NOT run
     install-nginx.sh — it assumes ownership of the nginx tree).
     Proxy /healthz and / to 127.0.0.1:3040; serve /uploads/variants
     statically from /opt/bwc/uploads/variants; serve /_next/static
     statically from /opt/bwc/static-pool/.next/static. Reload with
     'nginx -t && systemctl reload nginx'.

  4. Optional: systemd timers — run scripts/install-systemd.sh to
     install + enable + start the bwc-*.timer units (backups,
     cron-purge, restore-drill, media-verify, disk-check,
     prune-static-pool). Coexists with whatever other timers the
     box has.

  5. Off-site backups — sudo -u bwc rclone config (set up
     destination), then update BACKUP_RCLONE_REMOTE in
     /etc/bwc/env.production.

  6. age private key — currently at /etc/bwc/age-identity. Decide:
       Keep on-server: automated weekly restore-drill works.
       Move off-box: tighter blast-radius; operator runs the drill
       on their own machine. Copy then shred -u to remove.

  7. First deploy — build the artifact locally, upload via
     ~/connect/connect, run deploy.sh. See README "Deploy flow".

EOF
