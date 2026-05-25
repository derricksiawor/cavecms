#!/usr/bin/env bash
# scripts/setup-shared.sh — provisioning for an EXISTING shared server
# that already runs other Next.js apps under PM2. Skips the blocks of
# scripts/setup.sh that would conflict with the box's existing state:
#
#   - MariaDB install + cavecms_user/cavecms_migrator/cavecms_backup creation
#     (operator creates these by hand with their preferred password
#     policy and grants — see "NEXT STEPS" output)
#   - nginx config drop (operator adds a cavecms vhost coexisting with
#     the existing server blocks)
#   - ufw rules (operator manages firewall holistically)
#   - certbot deploy hook (existing renewal infra usually has one)
#
# What it DOES provision:
#
#   1. cavecms system user + cavecms / cavecmsstate groups; adds www-data to cavecms
#   2. /opt/cavecms/{releases,current,incoming,uploads/{originals,variants,
#      brochures-private,.tmp},static-pool/.next/static}
#   3. /backup/cavecms/{db,uploads,pre-deploy}  cavecms:backup 750
#   4. /var/lib/cavecms                          root:cavecmsstate 2770 (setgid)
#   5. /etc/cavecms directory + age key pair (operator decides whether to
#      keep the private key on-box for automated restore-drill)
#   6. pm2-logrotate (50M, retain 30, compress)
#   7. /etc/cavecms/env.production scaffold with auto-generated app secrets
#      (JWT/CSRF/PREVIEW/BROCHURE/HEALTHZ) — operator fills DATABASE_URL,
#      SMTP, reCAPTCHA after MariaDB user creation
#   8. /etc/cavecms/.setup-shared-complete marker
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

STATE_MARKER=/etc/cavecms/.setup-shared-complete
if [ -f "$STATE_MARKER" ]; then
  echo "[setup-shared.sh] Already provisioned ($STATE_MARKER exists)."
  echo "  To re-provision: rm $STATE_MARKER (and clean /etc/cavecms + /opt/cavecms manually first)."
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
if ! getent group cavecms >/dev/null; then
  groupadd --system cavecms
  echo "[setup-shared.sh] created group cavecms"
fi
if ! getent group cavecmsstate >/dev/null; then
  groupadd --system cavecmsstate
  echo "[setup-shared.sh] created group cavecmsstate"
fi
if ! getent group backup >/dev/null; then
  groupadd --system backup
  echo "[setup-shared.sh] created group backup"
fi
if ! id cavecms >/dev/null 2>&1; then
  useradd --system --gid cavecms --home-dir /home/cavecms --create-home --shell /usr/sbin/nologin cavecms
  echo "[setup-shared.sh] created user cavecms"
fi
# www-data needs read on /opt/cavecms/uploads + /opt/cavecms/static-pool for nginx
# to serve static assets. Idempotent: usermod -aG is a no-op if already a member.
usermod -aG cavecms www-data

# ---------------------------------------------------------------------------
# 2. /opt/cavecms filesystem layout
# ---------------------------------------------------------------------------
install -d -o root  -g root  -m 755 /opt/cavecms
install -d -o cavecms   -g cavecms   -m 750 /opt/cavecms/releases
install -d -o cavecms   -g cavecms   -m 750 /opt/cavecms/incoming
install -d -o cavecms   -g cavecms   -m 750 /opt/cavecms/uploads
install -d -o cavecms   -g cavecms   -m 750 /opt/cavecms/uploads/originals
install -d -o cavecms   -g cavecms   -m 750 /opt/cavecms/uploads/variants
install -d -o cavecms   -g cavecms   -m 750 /opt/cavecms/uploads/brochures-private
install -d -o cavecms   -g cavecms   -m 750 /opt/cavecms/uploads/.tmp
install -d -o cavecms   -g cavecms   -m 750 /opt/cavecms/static-pool
install -d -o cavecms   -g cavecms   -m 750 /opt/cavecms/static-pool/.next
install -d -o cavecms   -g cavecms   -m 750 /opt/cavecms/static-pool/.next/static

# Same-fs assertion: lib/media/storage.ts depends on rename(2) being
# atomic across these dirs. If the operator put /opt/cavecms on one device
# and /opt/cavecms/uploads on a separate mount, every upload would fail.
ROOT_DEV=$(stat -c %d /opt/cavecms/uploads)
for d in originals variants brochures-private .tmp; do
  dev=$(stat -c %d "/opt/cavecms/uploads/$d")
  if [ "$dev" != "$ROOT_DEV" ]; then
    echo "[setup-shared.sh] FAIL: /opt/cavecms/uploads/$d is on a different filesystem than /opt/cavecms/uploads (dev $dev vs $ROOT_DEV)" >&2
    echo "  rename(2) is atomic only within a filesystem. Move /opt/cavecms/uploads to a single mount and re-run." >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# 3. /backup/cavecms filesystem layout
# ---------------------------------------------------------------------------
install -d -o root -g backup -m 755 /backup
install -d -o cavecms  -g backup -m 750 /backup/cavecms
install -d -o cavecms  -g backup -m 750 /backup/cavecms/db
install -d -o cavecms  -g backup -m 750 /backup/cavecms/uploads
install -d -o cavecms  -g backup -m 750 /backup/cavecms/pre-deploy

# ---------------------------------------------------------------------------
# 4. /var/lib/cavecms — shared state marker dir, root:cavecmsstate 2770
#    The setgid bit makes files written here inherit the cavecmsstate group;
#    cavecms-user systemd services declare `SupplementaryGroups=cavecmsstate` to
#    read the markers. See cluster-3 / cluster-4 contract docs.
# ---------------------------------------------------------------------------
install -d -o root -g cavecmsstate -m 2770 /var/lib/cavecms

# ---------------------------------------------------------------------------
# 5. /etc/cavecms + age key pair
# ---------------------------------------------------------------------------
install -d -o root -g root -m 755 /etc/cavecms
if [ ! -f /etc/cavecms/backup.pub ]; then
  age-keygen -o /etc/cavecms/age-identity 2>/dev/null
  chmod 600 /etc/cavecms/age-identity
  chown root:root /etc/cavecms/age-identity
  age-keygen -y /etc/cavecms/age-identity > /etc/cavecms/backup.pub
  chmod 644 /etc/cavecms/backup.pub
  echo "[setup-shared.sh] generated age key pair (private: /etc/cavecms/age-identity, public: /etc/cavecms/backup.pub)"
  echo "[setup-shared.sh]   IMPORTANT: back up /etc/cavecms/age-identity off-box NOW — it cannot be regenerated."
  echo "[setup-shared.sh]   To run automated restore-drill, leave it on the server (default)."
  echo "[setup-shared.sh]   For tighter blast-radius, move it off-box: cp + shred -u /etc/cavecms/age-identity."
fi

# ---------------------------------------------------------------------------
# 6. PM2 logrotate
# ---------------------------------------------------------------------------
PM2_BIN=$(command -v pm2)
if ! runuser -u cavecms -- "$PM2_BIN" list >/dev/null 2>&1; then
  # First-ever pm2 invocation for the cavecms user; primes ~cavecms/.pm2/
  runuser -u cavecms -- "$PM2_BIN" ping >/dev/null 2>&1 || true
fi
if ! runuser -u cavecms -- "$PM2_BIN" describe pm2-logrotate >/dev/null 2>&1; then
  if ! runuser -u cavecms -- "$PM2_BIN" install pm2-logrotate; then
    echo "[setup-shared.sh] WARN: pm2-logrotate install failed. Re-run after fixing the cause:" >&2
    echo "  sudo -u cavecms $PM2_BIN install pm2-logrotate" >&2
  fi
fi
runuser -u cavecms -- "$PM2_BIN" set pm2-logrotate:max_size 50M >/dev/null
runuser -u cavecms -- "$PM2_BIN" set pm2-logrotate:retain 30 >/dev/null
runuser -u cavecms -- "$PM2_BIN" set pm2-logrotate:compress true >/dev/null
runuser -u cavecms -- "$PM2_BIN" set pm2-logrotate:rotateInterval '0 0 * * *' >/dev/null

# /var/log/cavecms for direct file logging (systemd journal is the primary
# sink, but some scripts append here too).
install -d -o cavecms -g cavecms -m 750 /var/log/cavecms

# ---------------------------------------------------------------------------
# 7. /etc/cavecms/env.production scaffold
# ---------------------------------------------------------------------------
# Auto-generate app secrets. Healthz token + JWT/CSRF/PREVIEW/BROCHURE
# all need to be set BEFORE the first deploy; pre-generating saves the
# operator from a manual edit between this script and deploy.sh.
if [ ! -f /etc/cavecms/env.production ]; then
  JWT_SECRET="$(openssl rand -hex 48)"
  CSRF_SECRET="$(openssl rand -hex 48)"
  PREVIEW_SECRET="$(openssl rand -hex 48)"
  BROCHURE_SECRET="$(openssl rand -hex 48)"
  HEALTHZ_TOKEN="$(openssl rand -hex 32)"
  AGE_PUB="$(cat /etc/cavecms/backup.pub)"

  install -m 640 -o root -g cavecms /dev/null /etc/cavecms/env.production
  cat > /etc/cavecms/env.production <<EOF
NODE_ENV=production
PORT=3040
HOSTNAME=127.0.0.1

# PATH for systemd timer units to resolve tsx from the release node_modules
PATH=/opt/cavecms/current/node_modules/.bin:/usr/local/bin:/usr/bin:/bin

# Database — separate principals for runtime (DML) and migrator (DDL).
# Create these manually on the shared MariaDB instance:
#   CREATE USER 'cavecms_user'@'127.0.0.1' IDENTIFIED BY '...';
#   CREATE USER 'cavecms_migrator'@'127.0.0.1' IDENTIFIED BY '...';
#   CREATE DATABASE cavecms CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
#   GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON cavecms.* TO 'cavecms_user'@'127.0.0.1';
#   GRANT ALL PRIVILEGES ON cavecms.* TO 'cavecms_migrator'@'127.0.0.1';
#   GRANT REFERENCES, EVENT, CREATE TEMPORARY TABLES ON cavecms.* TO 'cavecms_user'@'127.0.0.1';
#   FLUSH PRIVILEGES;
DATABASE_URL=mysql://cavecms_user:CHANGE_ME@127.0.0.1:3306/cavecms
DATABASE_MIGRATOR_URL=mysql://cavecms_migrator:CHANGE_ME@127.0.0.1:3306/cavecms

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
CAVECMS_COMMIT=unknown
CAVECMS_RELEASE_TS=

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
# Configure rclone remote: sudo -u cavecms rclone config
# Then set the destination here:
BACKUP_RCLONE_REMOTE=
EOF
  echo "[setup-shared.sh] wrote /etc/cavecms/env.production (mode 640 root:cavecms)"
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
     /etc/cavecms/env.production's DATABASE_URL comment. Then replace the
     CHANGE_ME passwords with the actual values.

  2. /etc/cavecms/env.production — fill in:
       LOGIN_PATH (6-32 lowercase alphanumeric/dashes)
       SITE_ORIGIN (your apex URL)
       SMTP_* (after picking an SMTP provider)
       NEXT_PUBLIC_RECAPTCHA_SITE_KEY + RECAPTCHA_SECRET_KEY
       BACKUP_RCLONE_REMOTE (after running 'sudo -u cavecms rclone config')

  3. nginx — add a cavecms server block by hand (do NOT run
     install-nginx.sh — it assumes ownership of the nginx tree).
     Proxy /healthz and / to 127.0.0.1:3040; serve /uploads/variants
     statically from /opt/cavecms/uploads/variants; serve /_next/static
     statically from /opt/cavecms/static-pool/.next/static. Reload with
     'nginx -t && systemctl reload nginx'.

  4. Optional: systemd timers — run scripts/install-systemd.sh to
     install + enable + start the cavecms-*.timer units (backups,
     cron-purge, restore-drill, media-verify, disk-check,
     prune-static-pool). Coexists with whatever other timers the
     box has.

  5. Off-site backups — sudo -u cavecms rclone config (set up
     destination), then update BACKUP_RCLONE_REMOTE in
     /etc/cavecms/env.production.

  6. age private key — currently at /etc/cavecms/age-identity. Decide:
       Keep on-server: automated weekly restore-drill works.
       Move off-box: tighter blast-radius; operator runs the drill
       on their own machine. Copy then shred -u to remove.

  7. First deploy — build the artifact locally, upload via
     ~/connect/connect, run deploy.sh. See README "Deploy flow".

EOF
