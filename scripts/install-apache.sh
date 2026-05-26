#!/usr/bin/env bash
# scripts/install-apache.sh
#
# Apache vhost installer for CaveCMS — companion to scripts/install-nginx.sh
# for operators on Apache-based hosts (cPanel, Plesk, RHEL default
# stack, shared hosting that doesn't ship nginx).
#
# Detects the OS-flavour and writes the vhost to the right path:
#   Debian/Ubuntu: /etc/apache2/sites-available/cavecms.conf  (+ a2ensite)
#   RHEL/Fedora:   /etc/httpd/conf.d/cavecms.conf
#
# Enables the modules Apache needs to host the CaveCMS proxy:
#   proxy, proxy_http, headers, rewrite, ssl, expires, deflate, http2
#
# Substitutes the template placeholders + asks the operator to run
# certbot (mirrors install-nginx.sh's --apache path).

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="$HERE/apache/cavecms.conf.template"

APEX="${1:-}"
LOGIN_PATH="${2:-}"
STAGING="${3:-}"
DOC_ROOT="${4:-/opt/cavecms}"
PORT="${5:-3040}"

if [ -z "$APEX" ] || [ -z "$LOGIN_PATH" ]; then
  echo "Usage: install-apache.sh APEX_DOMAIN LOGIN_PATH [STAGING] [DOC_ROOT] [PORT]"
  echo "Example: install-apache.sh acme.com baccess staging.acme.com /opt/cavecms 3040"
  exit 64
fi
STAGING="${STAGING:-staging.$APEX}"

if [ ! -f "$TEMPLATE" ]; then
  echo "Template not found: $TEMPLATE" >&2
  exit 70
fi

# ─── OS flavour detection ─────────────────────────────────────────────
APACHE_FLAVOUR=""
if [ -d /etc/apache2 ] && command -v a2ensite >/dev/null 2>&1; then
  APACHE_FLAVOUR="debian"
  VHOST_DIR="/etc/apache2/sites-available"
  RELOAD_CMD="systemctl reload apache2"
  TEST_CMD="apache2ctl configtest"
  ENABLE_SITE_CMD="a2ensite cavecms"
  ENABLE_MODULE_CMD="a2enmod"
elif [ -d /etc/httpd/conf.d ]; then
  APACHE_FLAVOUR="rhel"
  VHOST_DIR="/etc/httpd/conf.d"
  RELOAD_CMD="systemctl reload httpd"
  TEST_CMD="httpd -t"
  ENABLE_SITE_CMD=""   # RHEL conf.d is auto-loaded
  ENABLE_MODULE_CMD="" # most modules are on by default
else
  echo "Couldn't find /etc/apache2 or /etc/httpd. Is Apache installed?" >&2
  echo "  Debian/Ubuntu: apt install apache2" >&2
  echo "  RHEL/Fedora:   dnf install httpd" >&2
  exit 69
fi

echo "Detected Apache flavour: $APACHE_FLAVOUR"

# ─── Enable required modules (Debian) ─────────────────────────────────
if [ "$APACHE_FLAVOUR" = "debian" ] && [ -n "$ENABLE_MODULE_CMD" ]; then
  for mod in proxy proxy_http headers rewrite ssl expires deflate http2; do
    if ! sudo $ENABLE_MODULE_CMD "$mod" >/dev/null 2>&1; then
      echo "  warning: couldn't enable mod_$mod (may already be on or unavailable)"
    fi
  done
fi

# ─── Substitute placeholders + write the vhost (awk; sed is banned) ──
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
awk -v apex="$APEX" -v staging="$STAGING" -v login="$LOGIN_PATH" -v doc="$DOC_ROOT" -v port="$PORT" '
{
  gsub(/__APEX__/, apex)
  gsub(/__STAGING__/, staging)
  gsub(/__LOGIN_PATH__/, login)
  gsub(/__DOC_ROOT__/, doc)
  gsub(/__PORT__/, port)
  print
}
' "$TEMPLATE" > "$TMP"

DEST="$VHOST_DIR/cavecms.conf"
sudo mv "$TMP" "$DEST"
sudo chmod u=rw,go=r "$DEST"
echo "Wrote $DEST"

# ─── Enable the site (Debian) ─────────────────────────────────────────
if [ -n "$ENABLE_SITE_CMD" ]; then
  sudo $ENABLE_SITE_CMD
fi

# ─── Syntax-check + reload ────────────────────────────────────────────
echo "Running $TEST_CMD…"
if ! sudo $TEST_CMD; then
  echo "Apache config test FAILED. Inspect $DEST and re-run." >&2
  exit 1
fi

echo "Reloading Apache…"
sudo $RELOAD_CMD
echo "OK — CaveCMS is now reachable via Apache on https://$APEX/"
echo ""
echo "Next: provision TLS via certbot (if not already):"
if [ "$APACHE_FLAVOUR" = "debian" ]; then
  echo "  sudo apt install certbot python3-certbot-apache"
else
  echo "  sudo dnf install certbot python3-certbot-apache"
fi
echo "  sudo certbot --apache -d $APEX -d www.$APEX -d $STAGING"
