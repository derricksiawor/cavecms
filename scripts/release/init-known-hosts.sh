#!/usr/bin/env bash
# scripts/release/init-known-hosts.sh
#
# Bootstrap (or rotate) the SSH known_hosts file that
# scripts/release/publish.mjs uses to pin timemacro's host key.
#
# Run ONCE before the first publish, and again whenever the timemacro
# host key changes (server reinstall, key rotation). Commit the resulting
# scripts/release/known_hosts.
#
# Why: publish.mjs uses StrictHostKeyChecking=yes against this pinned
# allowlist so a MITM during a publish (rogue Wi-Fi, BGP hijack) cannot
# silently swap the destination host. The previous version used
# StrictHostKeyChecking=no — easy to MITM during a release.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
KNOWN_HOSTS="$HERE/known_hosts"

TIMEMACRO_IP="66.165.235.70"

echo "Fetching current host key for $TIMEMACRO_IP..."
echo ""
echo "VERIFY THE FINGERPRINT BELOW OUT-OF-BAND before committing."
echo "(connect to the server some OTHER way and run"
echo "  ssh-keyscan -t ed25519,rsa $TIMEMACRO_IP | ssh-keygen -lf -"
echo "there.)"
echo ""

# -T 10s connect timeout; -t list accepts ed25519 (preferred) + rsa fallback.
# ssh-keyscan emits one line per accepted host key.
ssh-keyscan -T 10 -t ed25519,rsa "$TIMEMACRO_IP" > "$KNOWN_HOSTS.tmp" 2>/dev/null

if [ ! -s "$KNOWN_HOSTS.tmp" ]; then
  echo "ERROR: ssh-keyscan returned no keys for $TIMEMACRO_IP" >&2
  rm -f "$KNOWN_HOSTS.tmp"
  exit 1
fi

echo "Keys captured. Fingerprints:"
ssh-keygen -lf "$KNOWN_HOSTS.tmp"
echo ""
read -p "Match the out-of-band fingerprint? [y/N] " ok
if [[ "$ok" != "y" && "$ok" != "Y" ]]; then
  echo "Aborted. Did not write known_hosts." >&2
  rm -f "$KNOWN_HOSTS.tmp"
  exit 1
fi

mv "$KNOWN_HOSTS.tmp" "$KNOWN_HOSTS"
chmod u=rw,go=r "$KNOWN_HOSTS"
echo "Wrote $KNOWN_HOSTS"
echo ""
echo "Commit it: git add scripts/release/known_hosts && git commit -m 'release: pin timemacro host key'"
