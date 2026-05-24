#!/usr/bin/env bash
# scripts/check.sh — pre-deploy environment validation. Runs the
# preconditions deploy.sh requires WITHOUT making any changes or
# requiring a release artifact. Operator runs this on the target
# server BEFORE the first deploy to confirm setup is complete:
#
#   sudo /opt/bwc/current/scripts/check.sh
#
# Or on a freshly-provisioned shared server right after running
# setup-shared.sh, to see what manual steps remain:
#
#   sudo /path/to/check.sh
#
# Exit 0 = ready to deploy. Exit non-zero = at least one
# precondition not met; the script prints exactly which one and the
# remediation.

set -euo pipefail

# Don't trap ERR — we want each check to run independently and the
# script to keep going and report ALL failures, not just the first.
FAIL_COUNT=0
WARN_COUNT=0

fail() {
  echo "  ✗ $1" >&2
  FAIL_COUNT=$((FAIL_COUNT + 1))
}
ok() {
  echo "  ✓ $1"
}
warn() {
  echo "  ⚠ $1" >&2
  WARN_COUNT=$((WARN_COUNT + 1))
}

if [ "$(id -u)" -ne 0 ]; then
  echo "[check.sh] Run as root to inspect /etc/bwc + system users." >&2
  exit 2
fi

ENV_NAME="${1:-production}"
case "$ENV_NAME" in
  production|staging) ;;
  *) echo "[check.sh] usage: check.sh [production|staging]" >&2; exit 2 ;;
esac

ENV_FILE="/etc/bwc/env.${ENV_NAME}"

echo "[check.sh] checking ${ENV_NAME} preconditions"

# 1. System users + groups
echo "Users + groups:"
if id bwc >/dev/null 2>&1; then ok "user bwc exists"; else fail "user bwc missing (run setup-shared.sh)"; fi
if getent group bwc >/dev/null; then ok "group bwc exists"; else fail "group bwc missing"; fi
if getent group bwcstate >/dev/null; then ok "group bwcstate exists"; else fail "group bwcstate missing"; fi
if id -nG www-data 2>/dev/null | tr ' ' '\n' | grep -qx bwc; then
  ok "www-data is in group bwc (nginx can read /opt/bwc/uploads)"
else
  warn "www-data is NOT in group bwc — nginx can't read /opt/bwc/uploads. Fix: usermod -aG bwc www-data"
fi

# 2. Filesystem layout
echo "Filesystem:"
for d in /opt/bwc /opt/bwc/releases /opt/bwc/incoming /opt/bwc/uploads \
         /opt/bwc/uploads/originals /opt/bwc/uploads/variants \
         /opt/bwc/uploads/brochures-private /opt/bwc/uploads/.tmp \
         /opt/bwc/static-pool/.next/static; do
  if [ -d "$d" ]; then ok "$d"; else fail "$d missing (re-run setup-shared.sh's filesystem block)"; fi
done
for d in /backup/bwc/db /backup/bwc/uploads /backup/bwc/pre-deploy; do
  if [ -d "$d" ]; then ok "$d"; else fail "$d missing"; fi
done
if [ -d /var/lib/bwc ]; then
  mode=$(stat -c %a /var/lib/bwc)
  owner=$(stat -c %U:%G /var/lib/bwc)
  if [ "$mode" = "2770" ] && [ "$owner" = "root:bwcstate" ]; then
    ok "/var/lib/bwc mode 2770 root:bwcstate"
  else
    fail "/var/lib/bwc has mode=$mode owner=$owner (expected 2770 root:bwcstate)"
  fi
else
  fail "/var/lib/bwc missing — cron-purge marker contract broken"
fi

# 3. age key
echo "Age key:"
if [ -f /etc/bwc/backup.pub ]; then
  if grep -qE '^age1[0-9a-z]{58}$' /etc/bwc/backup.pub; then
    ok "/etc/bwc/backup.pub valid age recipient"
  else
    fail "/etc/bwc/backup.pub exists but isn't a valid age recipient"
  fi
else
  fail "/etc/bwc/backup.pub missing — db-backup.sh and uploads-backup.sh refuse without it"
fi
if [ -f /etc/bwc/age-identity ]; then
  ok "/etc/bwc/age-identity present (automated restore-drill enabled)"
else
  warn "/etc/bwc/age-identity not on box — automated restore-drill timer will skip; off-box drill required"
fi

# 4. env file
echo "Env file ($ENV_FILE):"
if [ ! -f "$ENV_FILE" ]; then
  fail "$ENV_FILE missing"
else
  # Mode check
  mode=$(stat -c %a "$ENV_FILE")
  if [ "$mode" = "640" ]; then ok "mode 640"; else warn "mode is $mode (expected 640)"; fi
  # Required keys
  for k in DATABASE_URL DATABASE_MIGRATOR_URL JWT_SECRET CSRF_SECRET \
           PREVIEW_SECRET BROCHURE_SECRET LOGIN_PATH SITE_ORIGIN \
           HEALTHZ_TOKEN BACKUP_AGE_RECIPIENT BACKUP_RCLONE_REMOTE; do
    if grep -qE "^${k}=." "$ENV_FILE"; then
      # Check for placeholder values
      val=$(grep -E "^${k}=" "$ENV_FILE" | head -1 | cut -d= -f2-)
      case "$val" in
        *CHANGE_ME*|"") fail "$k still placeholder/empty in $ENV_FILE" ;;
        *) ok "$k set" ;;
      esac
    else
      fail "$k missing from $ENV_FILE"
    fi
  done
  # Secret length sanity (32+ chars hex/base64)
  for k in JWT_SECRET CSRF_SECRET PREVIEW_SECRET BROCHURE_SECRET HEALTHZ_TOKEN; do
    val=$(grep -E "^${k}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
    len=${#val}
    if [ "$len" -lt 32 ]; then
      fail "$k length $len < 32 (env validation refuses boot)"
    fi
  done
fi

# 5. Binaries
echo "Binaries:"
for cmd in pm2 nginx mysql age rclone openssl; do
  if command -v "$cmd" >/dev/null 2>&1; then ok "$cmd"; else fail "$cmd not installed"; fi
done

# 6. nginx config sanity
echo "nginx config:"
if command -v nginx >/dev/null 2>&1; then
  if nginx -t >/dev/null 2>&1; then
    ok "nginx -t passes"
  else
    fail "nginx -t fails — run 'nginx -t' for details"
  fi
fi

# 7. systemd timers (optional but recommended)
echo "Systemd timers:"
TIMER_COUNT=$(systemctl list-unit-files 'bwc-*.timer' --no-legend 2>/dev/null | wc -l)
if [ "$TIMER_COUNT" -gt 0 ]; then
  ok "$TIMER_COUNT bwc-*.timer unit(s) installed"
else
  warn "no bwc-*.timer units installed — run scripts/install-systemd.sh to enable backups + cron-purge"
fi

# 8. deploy.blocked sentinel
echo "Deploy sentinels:"
if [ -f /var/lib/bwc/deploy.blocked ]; then
  reason=$(head -c 256 /var/lib/bwc/deploy.blocked 2>/dev/null | tr '\n' ' ')
  fail "/var/lib/bwc/deploy.blocked is set: ${reason:-<empty>}"
else
  ok "no deploy block"
fi

# 9. MariaDB reachability (best-effort)
echo "Database:"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090  # env path is operator-supplied
  DB_URL=$( ( set -a; . "$ENV_FILE"; set +a; printf '%s' "${DATABASE_URL:-}" ) )
  if [ -z "$DB_URL" ] || echo "$DB_URL" | grep -q CHANGE_ME; then
    warn "DATABASE_URL still placeholder — can't test connectivity"
  else
    # Extract host + port via bash parameter expansion (no sed — banned
    # per project rules). DATABASE_URL format: mysql://user:pass@host:port/db
    rest=${DB_URL#*://*@}     # strip protocol + user:pass@ → host:port/db
    hostport=${rest%%/*}       # → host:port
    host=${hostport%%:*}       # → host
    port=${hostport##*:}       # → port (or unchanged if no colon)
    case "$port" in
      ''|*[!0-9]*) port=3306 ;;
    esac
    if [ -n "$host" ]; then
      if timeout 3 bash -c ">/dev/tcp/$host/$port" 2>/dev/null; then
        ok "MariaDB reachable at $host:$port"
      else
        fail "MariaDB at $host:$port not reachable"
      fi
    fi
  fi
fi

echo ""
if [ "$FAIL_COUNT" -eq 0 ]; then
  echo "[check.sh] OK — $WARN_COUNT warning(s), 0 failures. Ready to deploy."
  exit 0
fi
echo "[check.sh] FAIL — $FAIL_COUNT failure(s), $WARN_COUNT warning(s). Fix the failures above before deploying." >&2
exit 1
