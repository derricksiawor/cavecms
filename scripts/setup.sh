#!/usr/bin/env bash
# scripts/setup.sh — one-time-per-droplet bootstrap. Idempotent: safe
# to re-run. Provisions everything a fresh Ubuntu 24.04 LTS box needs
# to host the CaveCMS app: system user, directories, MariaDB users, nginx,
# systemd timers, PM2 logrotate, firewall, env-file scaffolding.
#
# Run as root via:
#   sudo ./scripts/setup.sh
#
# Prerequisites (apt install before running this):
#   nginx-core mariadb-server certbot ufw mailutils apache2-utils
#   age rclone curl
# Plus Node 22 + pnpm 10 + pm2 installed globally.
# A `command -v` preflight at the top of this script fails fast if
# any of those is missing.
#
# DOES NOT touch /opt/cavecms/incoming/<sha>.tar.zst — that's the deploy
# script's job. setup.sh only prepares the host shape that deploy.sh
# assumes.

set -euo pipefail
IFS=$'\n\t'

# ERR trap captures the failing command + exit code, not just line
# number — saves operator the "what failed at line 247?" hunt.
# shellcheck disable=SC2154  # rc and BASH_COMMAND are assigned inside the trap string.
trap 'rc=$?; echo "[setup.sh] FAIL (rc=$rc) at line $LINENO: $BASH_COMMAND" >&2' ERR

# Hard-gate to Linux. macOS BSD coreutils differ from GNU on `stat -c`
# and `install -d` semantics — refuse outright rather than mid-script.
if [ "$(uname -s)" != "Linux" ]; then
  echo "[setup.sh] Linux-only (Ubuntu 24.04 LTS). Refusing to run on $(uname -s)." >&2
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root." >&2
  exit 1
fi

# State marker — short-circuit on re-run. Operator can delete the
# marker to force re-provision but they take responsibility for
# .cnf / env-file / DB password drift (see commentary below).
STATE_MARKER=/etc/cavecms/.setup-complete
if [ -f "$STATE_MARKER" ]; then
  echo "[setup.sh] Box already provisioned ($STATE_MARKER exists)."
  echo "  - To rotate secrets: use a dedicated rotation script (TODO)."
  echo "  - To re-provision from scratch: rm $STATE_MARKER (and clean DB + /opt/cavecms + /etc/cavecms manually first)."
  exit 0
fi

# ---------------------------------------------------------------------------
# Preflight: every external dependency this script invokes
# ---------------------------------------------------------------------------
# Surface missing tools BEFORE prompting for 9 inputs. Cuts the
# "answered 7 prompts, mysql not installed, abort" footgun.
for cmd in mysql nginx htpasswd ufw openssl pm2 age rclone mailx curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[setup.sh] FAIL: prerequisite '$cmd' not installed." >&2
    echo "  Install OS packages per README first-deploy checklist." >&2
    exit 1
  fi
done
if ! id www-data >/dev/null 2>&1; then
  echo "[setup.sh] FAIL: 'www-data' user missing — install nginx-core first." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------
read -r -p "LOGIN_PATH (6-32 lowercase/digits/dashes): " LOGIN_PATH
LOGIN_PATH="${LOGIN_PATH//[$'\r\n\t ']/}"
if [[ ! "$LOGIN_PATH" =~ ^[a-z0-9-]{6,32}$ ]]; then
  echo "Invalid LOGIN_PATH (must match ^[a-z0-9-]{6,32}\$)." >&2
  exit 1
fi
# RFC-1035 DNS hostname regex — labels are 1-63 chars,
# alphanumeric + dashes (not leading/trailing), total ≤ 253. Reject
# anything that could inject nginx directives via __APEX__ /
# __STAGING__ substitution, embed shell metachars in SITE_ORIGIN,
# or land special chars in the LE cert's subjectAltName.
hostname_re='^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
read -r -p "Apex domain [your-domain.com]: " APEX
APEX="${APEX:-your-domain.com}"
APEX="${APEX//[$'\r\n\t ']/}"
if [[ ! "$APEX" =~ $hostname_re ]] || [ "${#APEX}" -gt 253 ]; then
  echo "Invalid apex domain '$APEX' — must be a valid DNS name." >&2; exit 1
fi
read -r -p "Staging hostname [staging.your-domain.com]: " STAGING
STAGING="${STAGING:-staging.your-domain.com}"
STAGING="${STAGING//[$'\r\n\t ']/}"
if [[ ! "$STAGING" =~ $hostname_re ]] || [ "${#STAGING}" -gt 253 ]; then
  echo "Invalid staging hostname '$STAGING' — must be a valid DNS name." >&2; exit 1
fi
read -r -p "DB host [127.0.0.1]: " DB_HOST
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_HOST="${DB_HOST//[$'\r\n\t ']/}"
# Accept either an IPv4 literal or a DNS hostname. mysql2 parses
# DATABASE_URL as a URL; an unvalidated DB_HOST containing `?`/`&`
# would inject driver parameters like `?allowPublicKeyRetrieval=true`.
ipv4_re='^([0-9]{1,3}\.){3}[0-9]{1,3}$'
if [[ ! "$DB_HOST" =~ $hostname_re ]] && [[ ! "$DB_HOST" =~ $ipv4_re ]]; then
  echo "Invalid DB host '$DB_HOST' — must be a DNS name or IPv4 literal." >&2; exit 1
fi
read -r -s -p "Existing MariaDB root password: " DB_ROOT_PW
echo
[ -n "$DB_ROOT_PW" ] || { echo "DB root password cannot be empty." >&2; exit 1; }
read -r -p "Staging basic-auth username: " STAGING_USER
STAGING_USER="${STAGING_USER//[$'\r\n\t ']/}"
# Restrict to chars htpasswd handles cleanly. `:` would corrupt the
# file format (`:` is the field separator). Apostrophe / quotes /
# slashes would break nginx parsing of the htpasswd file.
if [[ ! "$STAGING_USER" =~ ^[A-Za-z0-9._-]{1,32}$ ]]; then
  echo "Invalid staging user (alphanumeric + . _ -, 1-32 chars)." >&2
  exit 1
fi
read -r -s -p "Staging basic-auth password (min 16 chars, mixed case+digit): " STAGING_PW
echo
if [ "${#STAGING_PW}" -lt 16 ]; then
  echo "Staging password must be at least 16 characters." >&2; exit 1
fi
if [[ ! "$STAGING_PW" =~ [A-Z] ]] || [[ ! "$STAGING_PW" =~ [a-z] ]] || [[ ! "$STAGING_PW" =~ [0-9] ]]; then
  echo "Staging password must contain at least one upper, one lower, and one digit." >&2; exit 1
fi
read -r -p "Backup age recipient public key (age1...): " AGE_PUB
AGE_PUB="${AGE_PUB//[$'\r\n\t ']/}"
# Real age recipients are exactly 62 chars (age1 + 58 bech32) per the
# age v1 spec. Enforce length AT SETUP so typos / truncated paste are
# caught BEFORE the operator walks away thinking setup succeeded —
# otherwise the failure surfaces 24h later when the first backup
# tries to encrypt and age refuses the malformed key.
#
# Hyphens (plugin recipients like age1tpm-..., age1yubikey-...) are
# rejected by every consumer of backup.pub (deploy.sh, db-backup.sh,
# uploads-backup.sh). An operator who tries a plugin key here gets a
# specific error pointing at the migration path; without this branch
# they'd see the same generic "not a valid age1-prefixed recipient"
# message 24h later, having forgotten which choice broke things.
if [[ "$AGE_PUB" =~ ^age1[a-z0-9-]+$ ]] && [[ "$AGE_PUB" == *-* ]]; then
  echo "Invalid age recipient: plugin recipients (age1tpm-..., age1yubikey-...) are NOT supported." >&2
  echo "  Prior versions of this script accepted them, but cluster-3 consumers reject them." >&2
  echo "  Generate a standard age key with: age-keygen -o /root/.age-identity" >&2
  exit 1
fi
if [[ ! "$AGE_PUB" =~ ^age1[0-9a-z]{58}$ ]]; then
  echo "Invalid age recipient (expected 'age1' + 58 bech32 chars [0-9a-z], got '${AGE_PUB:0:10}...' length ${#AGE_PUB})." >&2
  exit 1
fi
read -r -p "Admin alert email [ops@example.com]: " ALERT
ALERT="${ALERT:-ops@example.com}"
ALERT="${ALERT//[$'\r\n\t ']/}"
# Reject anything that doesn't look like an email. mailx parses
# leading `-` as a flag, so even with `--` separator, a deliberately
# weird recipient is a reliability footgun.
if [[ ! "$ALERT" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
  echo "Invalid admin alert email." >&2
  exit 1
fi

# DB user passwords are GENERATED, not prompted. Hex-only output is
# SQL-literal-safe (no quotes/backslashes), shell-safe (no $ / `),
# and URL-safe for DATABASE_URL=mysql://user:PASS@host (no @ / : / /
# / ? / # / %). 32 hex chars = 128 bits of entropy — far above what
# the runtime needs and avoids every documented password-injection
# class for operator-typed passwords.
CAVECMS_PW="$(openssl rand -hex 32)"
MIG_PW="$(openssl rand -hex 32)"
BACKUP_PW="$(openssl rand -hex 32)"
# Pre-generate the four app-runtime secrets so we can assert their
# contract before they're interpolated into the env-file heredoc.
# Generating inside the heredoc subshell would silently produce an
# empty value if openssl ever fails (rare but possible in container
# environments with no /dev/urandom). Same pattern, same defence.
JWT_SECRET_PROD="$(openssl rand -hex 48)"
CSRF_SECRET_PROD="$(openssl rand -hex 48)"
PREVIEW_SECRET_PROD="$(openssl rand -hex 48)"
BROCHURE_SECRET_PROD="$(openssl rand -hex 48)"
JWT_SECRET_STAGING="$(openssl rand -hex 48)"
CSRF_SECRET_STAGING="$(openssl rand -hex 48)"
PREVIEW_SECRET_STAGING="$(openssl rand -hex 48)"
BROCHURE_SECRET_STAGING="$(openssl rand -hex 48)"
# AES-256-GCM master key for lib/security/secretCipher.ts — used to
# encrypt operator-provided secrets at rest (ai_config.apiKey today;
# SMTP password on a follow-up migration). Must decode from base64 to
# EXACTLY 32 bytes. Distinct openssl invocation (base64 not hex)
# because the cipher decodes via Buffer.from(s, 'base64') and a hex
# value would decode to a different byte length than required.
SECRETS_ENCRYPTION_KEY_PROD="$(openssl rand -base64 32)"
SECRETS_ENCRYPTION_KEY_STAGING="$(openssl rand -base64 32)"
# Healthz bearer tokens — 32 bytes hex (64 chars). deploy.sh:111
# refuses to deploy if HEALTHZ_TOKEN is empty or shorter than 32
# chars, so auto-generating here removes the manual-edit-between-
# setup-and-deploy step that was previously required.
HEALTHZ_TOKEN_PROD="$(openssl rand -hex 32)"
HEALTHZ_TOKEN_STAGING="$(openssl rand -hex 32)"
# Belt-and-braces: assert the contract a future maintainer might
# accidentally break (e.g., swapping `-hex` for `-base64`). DATABASE_URL
# interpolation, SQL heredoc interpolation, and the .cnf parser all
# depend on hex-only output. The JWT-family secrets are 96 hex chars
# (48 bytes); the DB passwords are 64 hex chars (32 bytes).
for pw in "$CAVECMS_PW" "$MIG_PW" "$BACKUP_PW"; do
  [[ "$pw" =~ ^[0-9a-f]{64}$ ]] || { echo "[setup.sh] FAIL: generated DB password must be 64 hex chars" >&2; exit 1; }
done
for s in "$JWT_SECRET_PROD" "$CSRF_SECRET_PROD" "$PREVIEW_SECRET_PROD" "$BROCHURE_SECRET_PROD" \
         "$JWT_SECRET_STAGING" "$CSRF_SECRET_STAGING" "$PREVIEW_SECRET_STAGING" "$BROCHURE_SECRET_STAGING"; do
  [[ "$s" =~ ^[0-9a-f]{96}$ ]] || { echo "[setup.sh] FAIL: generated app secret must be 96 hex chars" >&2; exit 1; }
done
for s in "$HEALTHZ_TOKEN_PROD" "$HEALTHZ_TOKEN_STAGING"; do
  [[ "$s" =~ ^[0-9a-f]{64}$ ]] || { echo "[setup.sh] FAIL: generated healthz token must be 64 hex chars" >&2; exit 1; }
done
# SECRETS_ENCRYPTION_KEY contract: base64 of 32 bytes — that's 44 chars
# total with a single trailing '=' (openssl rand -base64 32 output).
# The exact regex `^[A-Za-z0-9+/]{43}=$` matches that shape; the
# decoded length is also verified by lib/security/secretCipher.ts at
# first use, but failing here makes for a clearer install-time error.
for s in "$SECRETS_ENCRYPTION_KEY_PROD" "$SECRETS_ENCRYPTION_KEY_STAGING"; do
  [[ "$s" =~ ^[A-Za-z0-9+/]{43}=$ ]] || { echo "[setup.sh] FAIL: generated secrets-encryption key must be 44-char base64 (openssl rand -base64 32)" >&2; exit 1; }
done

# ---------------------------------------------------------------------------
# MariaDB root authentication file (used ONLY by this script run).
# Never expose root password via -p"$DB_ROOT_PW" on the command line.
# `umask 077` ensures the file is born 0600 before we write secrets.
# ---------------------------------------------------------------------------
ROOT_CNF="$(mktemp /tmp/cavecms-setup-root.XXXXXX.cnf)"
chmod 600 "$ROOT_CNF"
{
  printf '[client]\n'
  printf 'host=%s\n' "$DB_HOST"
  printf 'user=root\n'
  printf 'password=%s\n' "$DB_ROOT_PW"
} > "$ROOT_CNF"
# shellcheck disable=SC2154  # rc + BASH_COMMAND assigned inside the trap string.
trap 'rc=$?; shred -u "$ROOT_CNF" 2>/dev/null || rm -f "$ROOT_CNF"; [ "$rc" -ne 0 ] && echo "[setup.sh] FAIL (rc=$rc) at line $LINENO: $BASH_COMMAND" >&2' EXIT INT TERM

# Connectivity probe BEFORE any state mutation. If root creds are
# wrong the operator gets a clear error before the script creates
# the cavecms user, dirs, etc. — re-running on a clean slate is then
# truly idempotent.
if ! mysql --defaults-extra-file="$ROOT_CNF" -e 'SELECT 1' >/dev/null 2>&1; then
  echo "[setup.sh] FAIL: cannot connect to MariaDB with the supplied root credentials." >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# 1. App user + groups
# ---------------------------------------------------------------------------
# `cavecms` is a system user that PM2 + the runtime + the timer scripts
# run under. systemd's `User=` directive doesn't invoke a login shell,
# so the user's login shell value doesn't matter for service contexts.
# We still set `nologin` to lock out interactive ssh-as-cavecms, and `-L`
# to lock the password — defence-in-depth.
if ! id cavecms >/dev/null 2>&1; then
  useradd --system --shell /usr/sbin/nologin --create-home --home-dir /home/cavecms cavecms
fi
usermod -s /usr/sbin/nologin -L cavecms
if ! getent group backup >/dev/null; then
  groupadd --system backup
fi
# cavecmsstate is a DEDICATED group for /var/lib/cavecms state files (markers,
# locks, sentinels). It exists so the cluster-3 round-2 fix that grants
# group rwx on /var/lib/cavecms (so cavecms-user services can write lock and
# marker files) does NOT also extend that write surface to www-data.
# www-data is intentionally a member of group `cavecms` (next line down)
# for nginx to serve /opt/cavecms/uploads, but www-data is NOT added to
# cavecmsstate — so an nginx-route RCE cannot plant /var/lib/cavecms/deploy.blocked
# (DoS deploys), truncate the cron-purge health markers (mask backup
# outages), or plant lock files (silent backup outage via flock contention).
if ! getent group cavecmsstate >/dev/null; then
  groupadd --system cavecmsstate
fi
usermod -aG cavecms www-data
usermod -aG backup cavecms
usermod -aG cavecmsstate cavecms

# ---------------------------------------------------------------------------
# 2. Directories — locked-down ownership.
# ---------------------------------------------------------------------------
# Uploads + releases at 750 so nginx (via the cavecms group) and PM2
# (via the cavecms user) can read. /backup at 750 with the backup group
# so off-site sync timers can list/copy without world-readable.
# /etc/cavecms is root:cavecms 750 (group r-x so User=cavecms services can read
# the 0640 env + credential files inside). /var/lib/cavecms is
# root:cavecmsstate 2770 setgid (group rwx scoped to the dedicated
# cavecmsstate group so cavecms-user services can write lock + marker files
# WITHOUT extending that write surface to www-data which is in group
# cavecms for nginx). See the per-directory blocks below for the full
# rationale on each one.
install -d -o cavecms -g cavecms -m 750 \
  /opt/cavecms \
  /opt/cavecms/releases \
  /opt/cavecms/incoming \
  /opt/cavecms/uploads \
  /opt/cavecms/uploads/originals \
  /opt/cavecms/uploads/variants \
  /opt/cavecms/uploads/brochures-private \
  /opt/cavecms/uploads/.tmp \
  /opt/cavecms/static-pool \
  /opt/cavecms/static-pool/.next \
  /opt/cavecms/static-pool/.next/static
install -d -o cavecms -g backup -m 750 \
  /backup \
  /backup/cavecms \
  /backup/cavecms/db \
  /backup/cavecms/uploads \
  /backup/cavecms/pre-deploy
install -d -o cavecms -g cavecms -m 750 \
  /var/log/cavecms \
  /var/www
# /etc/cavecms is root:cavecms 750 — owner root writes, group cavecms has
# `r-x` for traversal so `User=cavecms` systemd services and the PM2
# runtime can read the 0640 env file and .cnf credentials inside.
# Without group=cavecms here, every cavecms service would 401 on
# EnvironmentFile= even though the inner files are correctly perm'd.
install -d -o root -g cavecms -m 750 /etc/cavecms
# /var/lib/cavecms is root:cavecmsstate 2770 — cavecms systemd services need group
# rwx to create lock and marker files here (lock acquisition, marker
# updates), but `cavecms` group is shared with www-data (see the Section-1
# usermod for nginx serving /opt/cavecms/uploads), and we deliberately
# DO NOT want www-data to be able to plant deploy.blocked / lock
# files / truncate health markers. The dedicated `cavecmsstate` group
# scopes the rwx grant to {cavecms, root} only.
#
# The setgid bit (2xxx) makes new files inside inherit group=cavecmsstate,
# so files written by `User=cavecms Group=backup` services (db-backup,
# uploads-backup) and by `User=root` services (disk-check,
# restore-drill) all end up readable by any service running with
# supplementary group cavecmsstate (e.g., cron-purge). Without setgid,
# db-backup would write files as cavecms:backup, restore-drill as
# root:root, and cross-service readability would break.
#
# cavecms-user services that need to write here MUST declare
# `SupplementaryGroups=cavecmsstate` in their unit (when Group= overrides
# the user's default group). Otherwise the process runs with no
# cavecmsstate group membership and gets "other" perms (---). See
# scripts/systemd/cavecms-{db,uploads}-backup.service and
# scripts/systemd/cavecms-cron-purge.service.
install -d -o root -g cavecmsstate -m 2770 /var/lib/cavecms
# Snapshot root for the in-app updater. Mode 2770 (setgid +
# group-rwx) so the orchestrator running as the cavecms-user group
# can write here; the setgid bit ensures every child snapshot dir
# inherits the cavecmsstate group, so a later watchdog rollback can
# read it back even if it runs under a different (but cavecmsstate-
# group-member) user. snapshot_current_tree in
# scripts/lib/cavecms-update-helpers.sh assumes this dir exists and
# is writable at runtime — provisioning here gives the orchestrator
# its first snapshot a stable home.
install -d -o root -g cavecmsstate -m 2770 /var/lib/cavecms/snapshots

# Logrotate config for /var/log/cavecms/*.log. The in-app updater
# + watchdog write ~20 distinct log streams that accumulate over
# the install's lifetime — without rotation, a weekly-updating
# install grows the log dir by ~50 MB/year. Ship the config from
# deploy/logrotate.d/cavecms; install via root:root 0644 so any
# logrotate runner (default cron.daily) can read it.
if [ -f "$(dirname "$0")/../deploy/logrotate.d/cavecms" ]; then
  install -o root -g root -m 0644 \
    "$(dirname "$0")/../deploy/logrotate.d/cavecms" \
    /etc/logrotate.d/cavecms
fi

# Same-FS assertion: uploads-move semantics (originals → variants and
# .tmp → originals on commit) require a single filesystem. If an
# operator ever mounts /opt/cavecms/uploads/originals onto separate storage
# the upload pipeline silently degrades to slow cross-device cp.
D1=$(stat -c %d /opt/cavecms/uploads/.tmp)
for d in /opt/cavecms/uploads/originals /opt/cavecms/uploads/variants /opt/cavecms/uploads/brochures-private; do
  if [ "$(stat -c %d "$d")" != "$D1" ]; then
    echo "[setup.sh] FAIL: $d must share one filesystem with /opt/cavecms/uploads/.tmp" >&2
    exit 1
  fi
done

# /backup mount advisory — if /backup is on a separate volume, it
# must be mounted BEFORE setup.sh so the install -d perms apply on
# the mounted FS. The check below warns if /backup looks like a
# fresh mount point (different st_dev from / suggests intentional
# mount; same st_dev suggests no separate volume yet attached).
ROOT_DEV=$(stat -c %d /)
BACKUP_DEV=$(stat -c %d /backup)
if [ "$BACKUP_DEV" != "$ROOT_DEV" ]; then
  # Separate FS — verify perms applied (mount could have happened
  # after the install -d).
  BACKUP_OWNER=$(stat -c '%U:%G' /backup)
  if [ "$BACKUP_OWNER" != "cavecms:backup" ]; then
    chown cavecms:backup /backup
    chmod 750 /backup
  fi
fi

# ---------------------------------------------------------------------------
# 3. MariaDB DB + principals
# ---------------------------------------------------------------------------
# Three principals, each least-privileged for its role:
#   - cavecms_user (runtime): DML only. No DDL, no LOCK TABLES, no
#     TRIGGER/EVENT/SHOW VIEW — the runtime doesn't need them and
#     limiting blast radius of a SQLi against the app code is the
#     whole point of this split.
#   - cavecms_migrator (deploy): DDL + DML. Used by migrator-bundle/run.js
#     and by rollback.sh's restore path (via /etc/cavecms/cavecms-migrate.cnf).
#   - cavecms_backup (dump): SELECT + LOCK TABLES + SHOW VIEW + EVENT +
#     TRIGGER. mysqldump --routines --triggers --events requires
#     EVENT + TRIGGER privileges and SHOW VIEW (for views, if any).
#     LOCK TABLES is included for MyISAM safety should any future
#     table land outside InnoDB (`--single-transaction` doesn't
#     cover MyISAM tables).
# All three bound to 127.0.0.1 — remote DB access is an operational
# anti-pattern and would need separate principals.
mysql --defaults-extra-file="$ROOT_CNF" <<SQL
CREATE DATABASE IF NOT EXISTS cavecms CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'cavecms_user'@'127.0.0.1' IDENTIFIED BY '${CAVECMS_PW}';
ALTER USER 'cavecms_user'@'127.0.0.1' IDENTIFIED BY '${CAVECMS_PW}';
GRANT SELECT, INSERT, UPDATE, DELETE ON cavecms.* TO 'cavecms_user'@'127.0.0.1';
CREATE USER IF NOT EXISTS 'cavecms_migrator'@'127.0.0.1' IDENTIFIED BY '${MIG_PW}';
ALTER USER 'cavecms_migrator'@'127.0.0.1' IDENTIFIED BY '${MIG_PW}';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, REFERENCES ON cavecms.* TO 'cavecms_migrator'@'127.0.0.1';
CREATE USER IF NOT EXISTS 'cavecms_backup'@'127.0.0.1' IDENTIFIED BY '${BACKUP_PW}';
ALTER USER 'cavecms_backup'@'127.0.0.1' IDENTIFIED BY '${BACKUP_PW}';
GRANT SELECT, LOCK TABLES, SHOW VIEW, EVENT, TRIGGER ON cavecms.* TO 'cavecms_backup'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL

# ---------------------------------------------------------------------------
# 4. Backup public key
# ---------------------------------------------------------------------------
# age recipient public key is world-readable (it's a public key by
# definition) — anyone can encrypt FOR us, only the private key
# holder (off-box) can decrypt.
install -m 644 /dev/null /etc/cavecms/backup.pub
printf '%s\n' "$AGE_PUB" > /etc/cavecms/backup.pub

# ---------------------------------------------------------------------------
# 5. mysqldump credential files
# ---------------------------------------------------------------------------
# Two .cnf files live in /etc/cavecms:
#   - cavecms-backup.cnf : cavecms_backup creds. 0640 root:cavecms — db-backup
#     service runs as User=cavecms, needs read.
#   - cavecms-migrate.cnf: cavecms_migrator creds. 0600 root:root —
#     rollback.sh runs as root via sudo, cavecms readability not needed.
#
# Files placed in /etc/cavecms (root:cavecms 750) NOT /root (700) — /root
# blocks cavecms traversal entirely, breaking any User=cavecms service that
# needs to consume the backup credentials. The cavecms group bit on
# /etc/cavecms gives the traversal needed for the 0640 group-read to
# apply.
#
# Atomic write via tempfile + mv: a SIGKILL / disk-full / power loss
# during the printf cannot leave a half-written credential file.
# Pre-create with `install -m` to fix perms BEFORE the tempfile
# is populated (eliminates the TOCTOU window mktemp's default 0600
# would still leave at the chown step).
install -m 640 -o root -g cavecms /dev/null /etc/cavecms/cavecms-backup.cnf
CAVECMS_BACKUP_TMP="$(mktemp /etc/cavecms/.cavecms-backup.cnf.XXXXXX)"
chmod 640 "$CAVECMS_BACKUP_TMP"; chown root:cavecms "$CAVECMS_BACKUP_TMP"
{
  printf '[client]\n'
  printf 'host=%s\n' "$DB_HOST"
  printf 'user=cavecms_backup\n'
  printf 'password=%s\n' "$BACKUP_PW"
} > "$CAVECMS_BACKUP_TMP"
mv -f "$CAVECMS_BACKUP_TMP" /etc/cavecms/cavecms-backup.cnf

install -m 600 -o root -g root /dev/null /etc/cavecms/cavecms-migrate.cnf
CAVECMS_MIGRATE_TMP="$(mktemp /etc/cavecms/.cavecms-migrate.cnf.XXXXXX)"
chmod 600 "$CAVECMS_MIGRATE_TMP"; chown root:root "$CAVECMS_MIGRATE_TMP"
{
  printf '[client]\n'
  printf 'host=%s\n' "$DB_HOST"
  printf 'user=cavecms_migrator\n'
  printf 'password=%s\n' "$MIG_PW"
} > "$CAVECMS_MIGRATE_TMP"
mv -f "$CAVECMS_MIGRATE_TMP" /etc/cavecms/cavecms-migrate.cnf

# ---------------------------------------------------------------------------
# 6. Maintenance page
# ---------------------------------------------------------------------------
# nginx falls back to this static HTML on 502/503/504 (PM2 reload
# window, build start, OOM kill). Atomic-write via tempfile + mv so
# nginx can never observe a half-written file even if disk fills
# mid-script. Overwritten on every setup re-run — re-running setup
# is the documented way to update the maintenance page's branding.
MAINT_TMP="$(mktemp /var/www/.cavecms-maint.XXXXXX)"
cat > "$MAINT_TMP" <<'EOF'
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Just a moment</title>
  <meta name="robots" content="noindex">
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0a0a0a; color: #f5f5f5; }
    main { text-align: center; }
    h1 { font-size: 1.25rem; font-weight: 500; letter-spacing: 0.04em; }
    p { color: #999; }
  </style>
</head>
<body>
  <main>
    <h1>We&rsquo;ll be right back.</h1>
    <p>Your Site</p>
  </main>
</body>
</html>
EOF
test -s "$MAINT_TMP" || { rm -f "$MAINT_TMP"; echo "[setup.sh] FAIL: cavecms-maint.html staging failed (disk full?)" >&2; exit 1; }
chmod 644 "$MAINT_TMP"
mv -f "$MAINT_TMP" /var/www/cavecms-maint.html

# ---------------------------------------------------------------------------
# 7. nginx config (staging htpasswd written here, ahead of install)
# ---------------------------------------------------------------------------
# bcrypt-hashed htpasswd (`-B`). `-i` reads the password from stdin
# (NOT argv) — `-b` would put the password on the command line
# where /proc/<pid>/cmdline / `ps aux` could capture it during the
# millisecond htpasswd is alive. `printf '%s'` (no \n) prevents an
# accidental newline becoming part of the bcrypt input.
#
# htpasswd writes via tempfile + atomic rename, replacing the inode
# we pre-created with one whose perms come from htpasswd's umask
# (defaults to 0644 = world-readable). The subshell forces umask 027
# so the new inode is born 0640. The post-call chown reasserts the
# group ownership in case rename retained the original.
install -m 640 -o root -g www-data /dev/null /etc/nginx/.htpasswd-cavecms-staging
( umask 027; printf '%s' "$STAGING_PW" | htpasswd -iB /etc/nginx/.htpasswd-cavecms-staging "$STAGING_USER" )
chown root:www-data /etc/nginx/.htpasswd-cavecms-staging
chmod 640 /etc/nginx/.htpasswd-cavecms-staging

bash "$HERE/install-nginx.sh" "$APEX" "$STAGING" "$LOGIN_PATH"

# Force a full restart (not reload) so the nginx master process
# picks up the supplementary `cavecms` group that `usermod -aG cavecms
# www-data` added earlier. SIGHUP reload only re-spawns workers
# from the existing master, which keeps its old supplementary
# group list — workers would then 403 on /opt/cavecms/uploads/* (mode
# 750, group cavecms). One-time cost at setup; subsequent
# install-nginx.sh runs (post-LE-cert swap) get reload-only.
if systemctl is-active --quiet nginx; then
  systemctl restart nginx
fi

# ---------------------------------------------------------------------------
# 8. Certbot deploy hook
# ---------------------------------------------------------------------------
# Cert renewal must reload nginx ONLY if config is still valid.
install -d -o root -g root -m 755 /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
nginx -t || { logger -t certbot-deploy "nginx -t failed after renewal; NOT reloading"; exit 1; }
systemctl reload nginx
logger -t certbot-deploy "nginx reloaded after cert renewal for ${RENEWED_DOMAINS:-unknown}"
EOF
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

# ---------------------------------------------------------------------------
# 9. systemd units + timers
# ---------------------------------------------------------------------------
bash "$HERE/install-systemd.sh"

# ---------------------------------------------------------------------------
# 10. PM2 logrotate + startup
# ---------------------------------------------------------------------------
# Resolve pm2 to an absolute path. `runuser` resets PATH to the
# /etc/login.defs default (typically /usr/local/sbin:/usr/local/bin:
# /usr/sbin:/usr/bin), but pm2 installed via a node version manager
# (nvm/fnm) may live elsewhere. Capturing the path here uses the
# preflight-verified pm2 binary that command -v already located.
PM2_BIN="$(command -v pm2)"

# `runuser -u cavecms --` invokes commands without going through PAM
# session/auth (unlike `sudo -u cavecms`), so it works regardless of
# the user's login shell or PAM account stack. PM2 modules install
# into /home/cavecms/.pm2.
if ! runuser -u cavecms -- "$PM2_BIN" install pm2-logrotate; then
  echo "[setup.sh] WARN: pm2-logrotate install failed. Re-run after fixing the cause:" >&2
  echo "             sudo -u cavecms $PM2_BIN install pm2-logrotate" >&2
fi
# `pm2 set` writes to /home/cavecms/.pm2/module_conf.json regardless of
# whether the module is installed — values are picked up the next
# time pm2-logrotate is actually installed.
runuser -u cavecms -- "$PM2_BIN" set pm2-logrotate:max_size 50M
runuser -u cavecms -- "$PM2_BIN" set pm2-logrotate:retain 30
runuser -u cavecms -- "$PM2_BIN" set pm2-logrotate:compress true
runuser -u cavecms -- "$PM2_BIN" set pm2-logrotate:rotateInterval '0 0 * * *'

# `pm2 startup` PRINTS the systemd-unit install command and (in
# recent PM2 versions) also executes it when run as root. To be
# explicit and survive future PM2 behaviour changes, we capture
# and eval the printed sudo line. The `--service-name pm2-cavecms`
# pin makes the resulting unit name deterministic.
if ! systemctl is-enabled pm2-cavecms.service >/dev/null 2>&1; then
  STARTUP_CMD="$(env PATH="$PATH:/usr/bin" "$PM2_BIN" startup systemd \
    --service-name pm2-cavecms -u cavecms --hp /home/cavecms 2>&1 | grep -E '^sudo ' | tail -1 || true)"
  # Strict shape match: `sudo env PATH=<safe-chars> <path>/pm2 startup
  # systemd --service-name pm2-cavecms -u cavecms --hp /home/cavecms`. Anchored
  # at BOTH ends — without the trailing `$`, a malicious or future
  # pm2 release could append `; rm -rf /` to a regex-matched prefix
  # and the eval would execute it. The full anchor constrains the
  # entire captured line.
  if [[ "$STARTUP_CMD" =~ ^sudo[[:space:]]+env[[:space:]]+PATH=[A-Za-z0-9:/_.-]+[[:space:]]+[A-Za-z0-9/_.-]+/pm2[[:space:]]+startup[[:space:]]+systemd[[:space:]]+--service-name[[:space:]]+pm2-cavecms[[:space:]]+-u[[:space:]]+cavecms[[:space:]]+--hp[[:space:]]+/home/cavecms[[:space:]]*$ ]]; then
    # Strip the "sudo " prefix — we're already root.
    eval "${STARTUP_CMD#sudo }"
    if ! systemctl is-enabled pm2-cavecms.service >/dev/null 2>&1; then
      echo "[setup.sh] WARN: pm2 startup eval did not produce an enabled pm2-cavecms.service." >&2
      echo "             Reboots will not auto-resurrect the app until you run:" >&2
      echo "             sudo $PM2_BIN startup systemd --service-name pm2-cavecms -u cavecms --hp /home/cavecms" >&2
    fi
  else
    echo "[setup.sh] WARN: pm2 startup output did not match the expected shape; skipping eval." >&2
    echo "             Reboots will not auto-resurrect the app. Run manually:" >&2
    echo "             sudo $PM2_BIN startup systemd --service-name pm2-cavecms -u cavecms --hp /home/cavecms" >&2
  fi
fi

# ---------------------------------------------------------------------------
# 11. Firewall
# ---------------------------------------------------------------------------
# :3040 is the upstream PM2 listens on — nginx proxies to it on
# 127.0.0.1, so the port must NOT be reachable from outside. UFW's
# default-deny incoming covers this; the explicit `deny` is
# defence-in-depth against a future operator who reconfigures the
# default policy.
ufw deny 3040
ufw allow 22
ufw allow 80
ufw allow 443
ufw --force enable
# Sanity probe: confirm SSH (22) is in the active rule set. If a
# prior operator inserted a `deny from any to any port 22` at a
# higher priority, our `allow 22` lands at the end and is overridden
# — operator could lock themselves out on the next SSH session.
if ! ufw status numbered 2>/dev/null | grep -qE '22(/tcp)?[[:space:]]+ALLOW'; then
  echo "[setup.sh] FAIL: SSH (port 22) is not in the active UFW rule set after enable." >&2
  echo "             Refusing to leave the box in a lockable state. Inspect with 'ufw status numbered'." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 12. /etc/cavecms/env.<env> templates
# ---------------------------------------------------------------------------
# Per-environment env files; PM2 picks one up via deploy.sh's
# `ln -sfn /etc/cavecms/env.$ENV_NAME $RELEASE_DIR/.env.local`.
# 0640 root:cavecms — cavecms reads at PM2 launch time; nothing else needs
# access.
#
# IMPORTANT idempotency contract: the state marker at the top of
# this script short-circuits re-runs. If the operator deletes the
# marker and re-runs (intentionally re-provisioning), env files
# are REWRITTEN with fresh secrets. The .cnf files and DB users
# are also rewritten consistently in that case. There is no
# "rotate some secrets and keep others" path here — that needs a
# dedicated rotation script.
for env_name in production staging; do
  f="/etc/cavecms/env.${env_name}"
  case "$env_name" in
    production)
      site_origin="https://${APEX}"
      jwt_secret="$JWT_SECRET_PROD"
      csrf_secret="$CSRF_SECRET_PROD"
      preview_secret="$PREVIEW_SECRET_PROD"
      brochure_secret="$BROCHURE_SECRET_PROD"
      healthz_token="$HEALTHZ_TOKEN_PROD"
      secrets_encryption_key="$SECRETS_ENCRYPTION_KEY_PROD"
      ;;
    staging)
      site_origin="https://${STAGING}"
      jwt_secret="$JWT_SECRET_STAGING"
      csrf_secret="$CSRF_SECRET_STAGING"
      preview_secret="$PREVIEW_SECRET_STAGING"
      brochure_secret="$BROCHURE_SECRET_STAGING"
      healthz_token="$HEALTHZ_TOKEN_STAGING"
      secrets_encryption_key="$SECRETS_ENCRYPTION_KEY_STAGING"
      ;;
  esac
  # Atomic write — see .cnf-file rationale above. mktemp in the same
  # dir so the final mv is rename-on-same-FS (truly atomic).
  install -m 640 -o root -g cavecms /dev/null "$f"
  env_tmp="$(mktemp "${f}.XXXXXX")"
  chmod 640 "$env_tmp"; chown root:cavecms "$env_tmp"
  {
    cat <<EOF
NODE_ENV=production
PORT=3040
HOSTNAME=127.0.0.1

# Path additions so systemd timer units can resolve tsx from the
# release's node_modules (which deploy.sh installs as a production
# dep) without a global npm install.
PATH=/opt/cavecms/current/node_modules/.bin:/usr/local/bin:/usr/bin:/bin

# Database — separate principals for runtime (DML) and migrator (DDL).
DATABASE_URL=mysql://cavecms_user:${CAVECMS_PW}@${DB_HOST}:3306/cavecms
DATABASE_MIGRATOR_URL=mysql://cavecms_migrator:${MIG_PW}@${DB_HOST}:3306/cavecms

# Secrets — generated on setup. Rotate via the documented procedure
# in README §Secret rotation; never edit one in place without bumping
# tokens_valid_after for every user (otherwise active sessions break).
JWT_SECRET=${jwt_secret}
CSRF_SECRET=${csrf_secret}
PREVIEW_SECRET=${preview_secret}
BROCHURE_SECRET=${brochure_secret}
# AES-256-GCM master key for at-rest encryption of operator secrets
# (ai_config.apiKey today, SMTP password on follow-up migration).
# Must decode from base64 to exactly 32 bytes — distinct from the
# 96-char hex secrets above. Rotation requires every operator to
# re-enter their stored secrets through the dashboard; do not
# rotate casually.
SECRETS_ENCRYPTION_KEY=${secrets_encryption_key}

# Hidden login
LOGIN_PATH=${LOGIN_PATH}

# Public origin — drives sitemap canonical URLs, JSON-LD, robots.
SITE_ORIGIN=${site_origin}

# Health-check authentication. Required by deploy.sh — the
# auto-rollback path polls /healthz with this Bearer and asserts
# the commit field matches the deploying SHA. Auto-generated per
# environment by setup.sh; rotate via the documented procedure.
HEALTHZ_TOKEN=${healthz_token}

# Build metadata — deploy.sh overrides these per-release.
CAVECMS_COMMIT=unknown
CAVECMS_RELEASE_TS=

# SMTP — operator fills in post-setup. The app boots without these
# but lead emails fall to notification_failures (queue_stale).
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
SMTP_FROM_NAME=Your Site
SALES_EMAIL=${ALERT}

# reCAPTCHA v3 — required in production (env.ts superRefine).
# Without these the runtime refuses to boot in production.
RECAPTCHA_SECRET_KEY=
NEXT_PUBLIC_RECAPTCHA_SITE_KEY=
RECAPTCHA_MIN_SCORE=0.5

# Backup
BACKUP_AGE_RECIPIENT=${AGE_PUB}
BACKUP_RCLONE_REMOTE=
# Relocates rclone's config path off /home/cavecms/.config/rclone/ which
# is hidden by ProtectHome=true in the backup systemd units. Without
# this override, rclone runs with an empty config and the off-site
# sync silently does nothing.
RCLONE_CONFIG=/etc/cavecms/rclone.conf

# Alerting
ADMIN_ALERT_EMAIL=${ALERT}
EOF
  } > "$env_tmp"
  test -s "$env_tmp" || { rm -f "$env_tmp"; echo "[setup.sh] FAIL: env-file staging produced empty result" >&2; exit 1; }
  mv -f "$env_tmp" "$f"
done

# Dedicated alert env file — cavecms-alert@.service reads ONLY this,
# not the full env.production. Limits the secret blast radius:
# mailx and its subprocesses inherit ADMIN_ALERT_EMAIL only, never
# JWT_SECRET / DATABASE_URL / SMTP_PASS. 0640 root:cavecms — even
# though cavecms-alert@ runs as root (no User= directive), keeping this
# group-readable means a future operator switching to User=cavecms on
# the alert template won't have to re-permission the file.
# Placeholder rclone config — operator populates it during NEXT
# STEPS. 640 root:cavecms so backup services running as User=cavecms can
# read it.
install -m 640 -o root -g cavecms /dev/null /etc/cavecms/rclone.conf

install -m 640 -o root -g cavecms /dev/null /etc/cavecms/alert.env
alert_tmp="$(mktemp /etc/cavecms/.alert.env.XXXXXX)"
chmod 640 "$alert_tmp"; chown root:cavecms "$alert_tmp"
printf 'ADMIN_ALERT_EMAIL=%s\n' "$ALERT" > "$alert_tmp"
mv -f "$alert_tmp" /etc/cavecms/alert.env

# ---------------------------------------------------------------------------
# 13. Marker — provisioning complete
# ---------------------------------------------------------------------------
touch "$STATE_MARKER"

echo "[setup.sh] OK — host provisioned."
echo
echo "NEXT STEPS:"
echo "  1. Fill the following in /etc/cavecms/env.production:"
echo "       SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM"
echo "       RECAPTCHA_SECRET_KEY / NEXT_PUBLIC_RECAPTCHA_SITE_KEY (REQUIRED — app refuses to boot without these)"
echo "       BACKUP_RCLONE_REMOTE (REQUIRED for production off-site backups)"
echo "  1b. Populate /etc/cavecms/rclone.conf with the remote auth config"
echo "      (run \`rclone config\` then copy ~/.config/rclone/rclone.conf"
echo "       to /etc/cavecms/rclone.conf and chown root:cavecms, chmod 640)"
echo "  1c. OPTIONAL — install the age PRIVATE key at /etc/cavecms/age-identity"
echo "      (mode 0600 owned by root) to enable the weekly restore-drill."
echo "      Skipping this leaves cavecms-restore-drill.timer firing as a no-op"
echo "      (skip-with-notice in journal). Installing the private key on prod"
echo "      is a security trade-off: a host compromise immediately reveals"
echo "      every encrypted backup. Without it, you have no automated"
echo "      verification that backups can be restored — investigate the"
echo "      trade-off before opting in."
echo "  2. Issue Let's Encrypt cert via DNS-01:"
echo "       certbot certonly --manual --preferred-challenges dns \\"
echo "         -d ${APEX} -d www.${APEX} -d ${STAGING}"
echo "     (Single combined cert under /etc/letsencrypt/live/${APEX}/ covers all three SANs.)"
echo "  3. Re-run scripts/install-nginx.sh ${APEX} ${STAGING} ${LOGIN_PATH}"
echo "     to swap the bootstrap self-signed cert for the LE cert."
echo "  4. First deploy: ssh deployer@host sudo /opt/cavecms/current/scripts/deploy.sh <sha> production"
echo "  5. Seed the initial admin: pnpm db:seed on the release directory"
