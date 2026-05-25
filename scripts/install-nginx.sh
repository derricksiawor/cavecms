#!/usr/bin/env bash
# scripts/install-nginx.sh — installs the cavecms nginx config from the
# template + snippets. Called by setup.sh on first provision; safe
# to re-run after a Let's Encrypt cert has been issued (swaps the
# bootstrap self-signed cert for the real one).
#
# Usage: install-nginx.sh <apex-domain> <staging-host> <login-path>
#
# On first run (no LE cert yet) a 7-day self-signed cert is
# generated under /etc/ssl/cavecms-bootstrap/ so `nginx -t` passes and
# nginx can serve HTTP — required for certbot HTTP-01 / DNS-01 to
# even run. Re-run after certbot succeeds to swap to the real cert.

set -euo pipefail
IFS=$'\n\t'
# shellcheck disable=SC2154  # rc + BASH_COMMAND assigned inside the trap string.
trap 'rc=$?; echo "[install-nginx.sh] FAIL (rc=$rc) at line $LINENO: $BASH_COMMAND" >&2' ERR

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root." >&2
  exit 1
fi

if [ $# -ne 3 ]; then
  echo "Usage: $0 <apex-domain> <staging-host> <login-path>" >&2
  exit 1
fi

APEX="$1"
STAGING="$2"
LOGIN_PATH="$3"

if [[ ! "$LOGIN_PATH" =~ ^[a-z0-9-]{6,32}$ ]]; then
  echo "[install-nginx.sh] FAIL: invalid LOGIN_PATH '$LOGIN_PATH'" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

install -d -o root -g root -m 755 \
  /etc/nginx/snippets \
  /etc/nginx/sites-available \
  /etc/nginx/sites-enabled

install -m 644 "$HERE/nginx/snippets/cavecms-proxy.conf"       /etc/nginx/snippets/cavecms-proxy.conf
install -m 644 "$HERE/nginx/snippets/cavecms-tls.conf"         /etc/nginx/snippets/cavecms-tls.conf
install -m 644 "$HERE/nginx/snippets/cavecms-compression.conf" /etc/nginx/snippets/cavecms-compression.conf
install -m 644 "$HERE/nginx/snippets/cavecms-asset-headers.conf" /etc/nginx/snippets/cavecms-asset-headers.conf

# Staging allowlist seed lives in /etc/nginx/snippets/ (NOT
# /etc/nginx/conf.d/) so it's only included where the template
# explicitly does so. Stock Ubuntu nginx.conf includes
# /etc/nginx/conf.d/*.conf at http{} scope — placing allowlist
# rules there would inherit them across every server block,
# including production apex.
if [ ! -f /etc/nginx/snippets/cavecms-staging-allow.conf ]; then
  cat > /etc/nginx/snippets/cavecms-staging-allow.conf <<'EOF'
# Add 'allow <ip>;' lines here, one per office/dev IP.
# Example:
#   allow 203.0.113.42;
#   allow 198.51.100.0/24;
EOF
  chmod 644 /etc/nginx/snippets/cavecms-staging-allow.conf
fi

# Bootstrap self-signed cert when no Let's Encrypt cert is on disk
# yet. Without this, the first `nginx -t` after install fails on
# missing ssl_certificate files and setup.sh aborts mid-way.
# certbot HTTP-01 / DNS-01 issuance is then impossible because
# nginx itself isn't running.
LE_CERT="/etc/letsencrypt/live/${APEX}/fullchain.pem"
if [ ! -f "$LE_CERT" ]; then
  # Loud warning if certbot has previously been used on this box —
  # someone may have just run `certbot delete` and re-running this
  # script would silently install a 7-day self-signed cert over the
  # production hostname. Operator must explicitly accept by setting
  # ALLOW_BOOTSTRAP_CERT=1.
  if [ -d /var/log/letsencrypt ] && [ "${ALLOW_BOOTSTRAP_CERT:-0}" != "1" ]; then
    echo "[install-nginx.sh] FAIL: /var/log/letsencrypt exists (certbot has been used here)" >&2
    echo "             but $LE_CERT is missing. Refusing to write a self-signed" >&2
    echo "             bootstrap cert over a host that should have a real LE cert." >&2
    echo "             Either re-issue the LE cert, OR set ALLOW_BOOTSTRAP_CERT=1 to force." >&2
    exit 1
  fi
  echo "[install-nginx.sh] No Let's Encrypt cert at $LE_CERT — generating 7-day bootstrap self-signed pair."
  install -d -o root -g root -m 755 /etc/letsencrypt /etc/letsencrypt/live "/etc/letsencrypt/live/${APEX}"
  # umask 077 inside the subshell so openssl creates the privkey
  # already-0600. Without this, the file is born 0644 (default umask)
  # and the explicit chmod that follows leaves a TOCTOU window where
  # any local unprivileged process can snapshot the bootstrap key.
  (
    umask 077
    openssl req -x509 -nodes -newkey rsa:2048 -days 7 \
      -keyout "/etc/letsencrypt/live/${APEX}/privkey.pem" \
      -out   "/etc/letsencrypt/live/${APEX}/fullchain.pem" \
      -subj  "/CN=${APEX}" \
      -addext "subjectAltName=DNS:${APEX},DNS:www.${APEX},DNS:${STAGING}" >/dev/null 2>&1
  )
  chmod 644 "/etc/letsencrypt/live/${APEX}/fullchain.pem"
  echo "[install-nginx.sh] Bootstrap cert installed. Re-run this script after certbot issues the real cert."
fi

# Substitute placeholders in the template via awk (sed banned per
# project convention). mktemp + atomic install means a failed
# substitution can't leave the live config half-written.
TMP="$(mktemp)"
# Cleanup the temp file on every exit path; preserve any prior ERR
# trap diagnostic by checking $rc.
# shellcheck disable=SC2154  # rc + BASH_COMMAND assigned inside the trap string.
trap 'rc=$?; rm -f "$TMP"; [ "$rc" -ne 0 ] && echo "[install-nginx.sh] FAIL (rc=$rc) at line $LINENO: $BASH_COMMAND" >&2' EXIT INT TERM

awk \
  -v apex="$APEX" \
  -v staging="$STAGING" \
  -v lp="$LOGIN_PATH" \
  '{
    gsub(/__APEX__/, apex);
    gsub(/__STAGING__/, staging);
    gsub(/__LOGIN_PATH__/, lp);
    print
  }' "$HERE/nginx/cavecms.conf.template" > "$TMP"

install -m 644 "$TMP" /etc/nginx/sites-available/cavecms.conf
ln -sfn /etc/nginx/sites-available/cavecms.conf /etc/nginx/sites-enabled/cavecms.conf

# Validate BEFORE reloading — a syntax error here would tear down
# the listener and 502 every site nginx serves.
nginx -t

# reload-or-restart handles BOTH the running-service case (HUP-style
# reload) and the not-yet-started case (cold start). `reload` alone
# fails on first install where the package shipped nginx stopped.
systemctl reload-or-restart nginx

echo "[install-nginx.sh] OK — cavecms.conf installed and applied."
