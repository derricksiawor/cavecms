#!/usr/bin/env bash
# scripts/restore-drill.sh — weekly verification that the latest db-backup
# can actually be decrypted and restored.
#
# Invoked by systemd: cavecms-restore-drill.timer → cavecms-restore-drill.service.
# Runs as ROOT (needs CREATE DATABASE / DROP DATABASE privilege that
# cavecms_migrator does not have — cavecms_migrator's grants are scoped to
# cavecms.* by setup.sh's cavecms_migrator GRANT block). Authenticates to
# MariaDB via unix_socket on the root@localhost account (cluster-1
# invariant — Ubuntu MariaDB default).
#
# What this catches:
#   - Off-site format corruption (rclone wrote garbage; age decrypt
#     fails or produces bad gzip).
#   - age recipient/identity mismatch (encrypt-side public key drifted
#     from the operator's saved private key).
#   - mysqldump bugs producing un-restorable SQL.
#   - Schema-level migration breakage (CREATE TABLE syntax that mysql
#     refuses on restore).
#   - Restore-then-empty regressions (mysqldump emitted schema but no
#     row data).
#
# What this does NOT catch:
#   - Detailed row-level data drift (would require a separate row
#     fingerprint per table — out of scope for the drill MVP).
#   - Long-term backup degradation (rclone copies daily; if the off-site
#     drops the file, db-backup.sh's next run uploads a fresh copy).
#
# Flow:
#   1. Validate /etc/cavecms/age-identity exists at mode 600/400 owned by
#      root. If MISSING, exit 0 with a notice — the operator has not
#      opted in to automated drills. (The identity is the private key;
#      shipping it on the prod box is a security trade-off the operator
#      explicitly accepts by installing it.)
#   2. Find the latest /backup/cavecms/db/*.sql.age by mtime.
#   3. DROP DATABASE IF EXISTS cavecms_drill; CREATE DATABASE cavecms_drill.
#   4. age decrypt | gunzip | mysql cavecms_drill.
#   5. Verify: cavecms_drill table count matches cavecms within a tolerance,
#      AND tracked tables (__drizzle_migrations, users) have non-zero
#      rows. Both gates: each catches a different failure mode (table
#      count = schema correctness; tracked rows = data presence).
#   6. DROP DATABASE cavecms_drill regardless of verification outcome
#      (cleanup in finally-like fashion via EXIT trap).
#
# Why scratch-DB instead of restore-to-live:
#   The live cavecms database is serving traffic. Restoring on top would
#   wipe in-flight data. The drill validates the restore PATH without
#   touching production data — exactly the property we need for a
#   confidence check.
#
# Why root-auth instead of a dedicated drill user:
#   Adding a cavecms_drill_admin user would require touching setup.sh
#   (cluster-1 invariant, already shipped). Root-via-socket auth is the
#   minimal-blast-radius alternative: the unit's ProtectSystem=strict
#   sandbox keeps the script from poking at anything besides MariaDB
#   and a tempdir, and the script never writes plaintext SQL to disk
#   (everything is piped age→gunzip→mysql, with no intermediate tee).
#
# Concurrency: persistent flock at /var/lib/cavecms/.cavecms-restore-drill.lock.
# Same persistent-lock pattern as cluster-3 siblings.
#
# Side effects: creates+drops the cavecms_drill DB; touches
# /var/lib/cavecms/last-restore-drill.ok on success. Logs to stdout/stderr
# (systemd journal). OnFailure=cavecms-alert@%n.service alerts on non-zero
# exits.
#
# Exit codes:
#   0  — drill completed successfully OR opted-out (no identity file)
#        OR another drill holds the lock (skipped)
#   1  — fatal: required tool/path missing, backup missing, decrypt
#        failure, restore failure, verification failure
#   2  — usage error (stray arguments) or env precondition failure

set -euo pipefail
shopt -s inherit_errexit
IFS=$'\n\t'
export LC_ALL=C

sanitize() { tr -cd '\11\12\15\40-\176'; }

# shellcheck disable=SC2154
trap 'rc=$?; cmd=$(printf "%s" "${BASH_COMMAND-}" | sanitize); echo "[restore-drill.sh] FAIL (rc=$rc) at line $LINENO: $cmd" >&2' ERR

for cmd in age awk basename date find flock gunzip id mysql printf sort stat timeout tr; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[restore-drill.sh] required command missing: $cmd" >&2
    exit 1
  fi
done

if [ $# -ne 0 ]; then
  echo "[restore-drill.sh] usage: restore-drill.sh (no arguments)" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Paths and constants
# ---------------------------------------------------------------------------
BACKUP_DIR=/backup/cavecms/db
LIVE_DB=cavecms
DRILL_DB=cavecms_drill
AGE_IDENTITY=/etc/cavecms/age-identity
MARKER=/var/lib/cavecms/last-restore-drill.ok
LOCK_FILE=/var/lib/cavecms/.cavecms-restore-drill.lock
# Tolerance in table-count delta between cavecms_drill and cavecms. The drill
# restores a backup that may be several days old; live cavecms could have
# 0 to a handful of new tables from migrations since. ±5 absorbs the
# realistic migration cadence (≤1 migration/week) plus reserve.
TABLE_COUNT_TOLERANCE=5
# Tracked tables — restored data MUST have non-zero rows here. These
# are the minimum-fanout tables that exist in every CaveCMS install:
#   __drizzle_migrations — migrations history; never empty after
#                          first deploy.
#   users                — admin users; setup.sh seeds at least one.
# Adding row-count baseline gates against schema-only-no-data dumps,
# which mysqldump CAN produce silently with --no-data (a footgun if a
# future deploy.sh refactor flips that flag).
TRACKED_TABLES=(__drizzle_migrations users)

# ---------------------------------------------------------------------------
# Must run as root — CREATE/DROP DATABASE requires the global privilege
# that cavecms_migrator does not have. The systemd unit sets User=root.
# ---------------------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  echo "[restore-drill.sh] must run as root (need CREATE DATABASE privilege; running as $(id -un))" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Opt-in gate: the age identity file is the private key that decrypts
# every backup written by the cluster. Shipping it on the production
# box is a security trade-off — it means a host compromise immediately
# reveals every backup, including off-site copies. Operators must
# explicitly opt in by installing the key at $AGE_IDENTITY with mode
# 0600 or 0400 owned by root.
#
# Skip-with-notice when the file is absent. This is intentional: a
# missing identity is operator policy (no automated drills), not an
# error. Logs the skip so operators can verify the script ran.
# ---------------------------------------------------------------------------
if [ ! -e "$AGE_IDENTITY" ]; then
  echo "[restore-drill.sh] $AGE_IDENTITY does not exist — restore drill skipped (operator opt-in required)"
  echo "[restore-drill.sh]   to enable: install the age private key at $AGE_IDENTITY mode 0600 owned by root"
  exit 0
fi
# Refuse a permissive identity. Identical perm-validation idiom to
# rollback.sh:240-250 — kept byte-for-byte so a perm drift is detected
# the same way by both consumers.
raw_mode=$(stat -c '%a' "$AGE_IDENTITY")
key_mode="${raw_mode: -3}"
key_owner=$(stat -c '%U' "$AGE_IDENTITY")
if [ "$key_mode" != "600" ] && [ "$key_mode" != "400" ]; then
  echo "[restore-drill.sh] $AGE_IDENTITY perms ${raw_mode} — must be 0600 or 0400" >&2
  exit 1
fi
if [ "$key_owner" != "root" ]; then
  echo "[restore-drill.sh] $AGE_IDENTITY owner $key_owner — must be root" >&2
  exit 1
fi
if [ ! -r "$AGE_IDENTITY" ]; then
  echo "[restore-drill.sh] $AGE_IDENTITY not readable (despite mode $raw_mode)" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Backup directory must exist (cluster-1 invariant).
# ---------------------------------------------------------------------------
if [ ! -d "$BACKUP_DIR" ]; then
  echo "[restore-drill.sh] $BACKUP_DIR missing — db-backup hasn't run, nothing to drill" >&2
  exit 1
fi

# Find the most-recent *.sql.age by mtime. `find -printf '%T@\t%p\0'`
# + `sort -zrn` + `awk` strips the timestamp prefix; same idiom as
# deploy.sh's release rotation (deploy.sh:182-183).
LATEST_BACKUP=$(
  find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.sql.age' -printf '%T@\t%p\0' \
    | sort -zrn \
    | awk -v RS='\0' 'NR==1 { sub(/^[^\t]+\t/, ""); print; exit }'
)
if [ -z "$LATEST_BACKUP" ]; then
  echo "[restore-drill.sh] no *.sql.age files in $BACKUP_DIR — db-backup hasn't run, nothing to drill" >&2
  exit 1
fi
# Anchor the result back to BACKUP_DIR — defence in depth even though
# find's -maxdepth 1 + -name glob bounds the output by construction.
case "$LATEST_BACKUP" in
  "$BACKUP_DIR"/*.sql.age) ;;
  *)
    echo "[restore-drill.sh] internal: latest backup path '$LATEST_BACKUP' is outside $BACKUP_DIR — refusing" >&2
    exit 1
    ;;
esac

# ---------------------------------------------------------------------------
# Backup-age sanity check — fire BEFORE the expensive scratch-DB
# create + decrypt + restore pipeline. If the latest backup is stale,
# we already know the drill is going to fail; surfacing the staleness
# now saves ~minutes of mysqld IO and gives the operator a faster
# signal. db-backup runs daily, so anything older than 3 days is a
# real failure mode (db-backup has been failing or disabled). 3d also
# aligns with TABLE_COUNT_TOLERANCE=5 — bounded migration window so
# the tolerance gate's reserve actually holds.
#
# Comparison is done in SECONDS, not whole days. Bash arithmetic
# `seconds / 86400` truncates toward zero, so `-gt 3` on the day-
# count would only trip at ≥4 full days (96h+), widening the
# intended detection window by ~24h. The seconds-based comparison
# trips at exactly 3*86400 = 259200s = 3.0 days, matching the
# documented intent.
backup_age_seconds=$(( $(date -u +%s) - $(stat -c %Y "$LATEST_BACKUP") ))
backup_age_days=$(( backup_age_seconds / 86400 ))
if [ "$backup_age_seconds" -gt $((3 * 86400)) ]; then
  echo "[restore-drill.sh] latest backup is ${backup_age_days}d (${backup_age_seconds}s) old (>3d) — db-backup may have stopped running" >&2
  echo "[restore-drill.sh]   investigate journalctl -u cavecms-db-backup.service" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Lock
# ---------------------------------------------------------------------------
for f in "$LOCK_FILE" "$MARKER"; do
  # $LOCK_FILE — `exec 9>` follows symlinks and would O_TRUNC the target.
  # $MARKER — `: > "$MARKER"` (post-success touch) also follows symlinks.
  # Without this precheck, a cavecms-uid attacker could pre-plant $MARKER as
  # a symlink to /var/lib/cavecms/deploy.blocked or any path in this unit's
  # ReadWritePaths set (/var/log/cavecms /var/lib/cavecms); the next drill tick
  # (running as root, mode 0644 truncate via shell `>`) would zero the
  # target. systemd's ProtectSystem=strict bounds the blast radius to
  # the unit's RW paths, but a truncated deploy.blocked sentinel is
  # enough to DoS the deploy pipeline until manual intervention.
  if [ -L "$f" ]; then
    echo "[restore-drill.sh] refusing: $f is a symlink (expected regular file or absent)" >&2
    exit 1
  fi
done
# IMPORTANT INVARIANT — DO NOT REORDER (see disk-check.sh:135-149).
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[restore-drill.sh] another restore-drill holds $LOCK_FILE — skipping this tick"
  exit 0
fi

# ---------------------------------------------------------------------------
# Cleanup trap. Always DROP the scratch DB on exit, success or failure,
# so we never leave a stale cavecms_drill lying around to occupy disk or
# confuse the next drill run's "DROP IF EXISTS" with old indexes.
#
# Why the DROP is idempotent: mysql IF EXISTS variants tolerate the DB
# not existing. The trap fires on every exit path including signal-
# triggered traps (which call exit explicitly), so a SIGTERM during
# the restore mysql pipe still triggers the cleanup.
# ---------------------------------------------------------------------------
# shellcheck disable=SC2329  # called indirectly via `trap … EXIT` below.
cleanup_scratch() {
  # Suppress mysql output unless something interesting happens — the
  # success path doesn't need to chatter. Errors here are real (mysql
  # unreachable, disk full) — surface them but don't fail the cleanup.
  #
  # Outer `timeout 30` caps the cleanup independently of mysql's own
  # --connect-timeout: if mysqld is hung mid-query, --connect-timeout
  # (which only covers the initial connect handshake) won't fire, and
  # the cleanup would block the EXIT trap past systemd's TimeoutStopSec.
  # timeout(1) from coreutils is the simplest portable cap.
  if ! timeout 30 mysql --protocol=socket --connect-timeout=10 -uroot -e "DROP DATABASE IF EXISTS \`$DRILL_DB\`;"; then
    echo "[restore-drill.sh] WARN: cleanup DROP DATABASE \`$DRILL_DB\` failed or timed out; manual cleanup required" >&2
  fi
}
trap cleanup_scratch EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# ---------------------------------------------------------------------------
# Create scratch DB. DROP first in case a prior run died after CREATE
# but before DROP (a SIGKILL would skip the EXIT trap and leave the
# scratch around). Idempotent.
# ---------------------------------------------------------------------------
echo "[restore-drill.sh] creating scratch DB $DRILL_DB..."
if ! mysql --protocol=socket --connect-timeout=10 -uroot -e "DROP DATABASE IF EXISTS \`$DRILL_DB\`; CREATE DATABASE \`$DRILL_DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"; then
  echo "[restore-drill.sh] failed to create scratch DB $DRILL_DB" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Decrypt → decompress → restore. PIPESTATUS pattern matches deploy.sh
# and rollback.sh — captured on the line immediately after the pipeline.
#
# `age --decrypt -i <identity> <file>` reads the encrypted file and
# writes plaintext to stdout. The identity file is path-validated above
# (owner root, mode 600/400) but the bytes themselves come from the
# operator-controlled keystore — outside the script's trust boundary.
# ---------------------------------------------------------------------------
echo "[restore-drill.sh] restoring $(basename "$LATEST_BACKUP") into $DRILL_DB..."
if ! age --decrypt -i "$AGE_IDENTITY" "$LATEST_BACKUP" \
     | gunzip \
     | mysql --protocol=socket --connect-timeout=10 -uroot "$DRILL_DB"; then
  pipestatus=("${PIPESTATUS[@]}")
  echo "[restore-drill.sh] restore FAILED" >&2
  printf '[restore-drill.sh]   PIPESTATUS (age|gunzip|mysql) = %s %s %s\n' \
    "${pipestatus[0]:-?}" "${pipestatus[1]:-?}" "${pipestatus[2]:-?}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Verification gate 1: table count.
# Compare cavecms_drill table count vs live cavecms. Drift > TABLE_COUNT_TOLERANCE
# indicates either (a) the backup is from far enough back that several
# migrations have run since, or (b) the dump dropped tables entirely.
# Either way, alert.
# ---------------------------------------------------------------------------
live_count=$(mysql --protocol=socket --connect-timeout=10 -uroot -N -B -e \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$LIVE_DB';")
drill_count=$(mysql --protocol=socket --connect-timeout=10 -uroot -N -B -e \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$DRILL_DB';")
[[ "$live_count" =~ ^[0-9]+$ ]] || { echo "[restore-drill.sh] live table count non-numeric: '$live_count'" >&2; exit 1; }
[[ "$drill_count" =~ ^[0-9]+$ ]] || { echo "[restore-drill.sh] drill table count non-numeric: '$drill_count'" >&2; exit 1; }
# Absolute difference. Bash arithmetic: if drill_count > live_count we
# also want the positive delta — though that's the "drill has tables
# live doesn't" case, which is also worth flagging.
if [ "$drill_count" -ge "$live_count" ]; then
  delta=$(( drill_count - live_count ))
else
  delta=$(( live_count - drill_count ))
fi
if [ "$delta" -gt "$TABLE_COUNT_TOLERANCE" ]; then
  echo "[restore-drill.sh] table-count drift: live=${live_count} drill=${drill_count} delta=${delta} > tolerance=${TABLE_COUNT_TOLERANCE}" >&2
  echo "[restore-drill.sh]   suggests either schema migration drift or dump truncation; investigate" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Verification gate 2: tracked tables have rows.
# Catches the "schema-only dump" failure mode where mysqldump produces
# CREATE TABLE statements but no INSERT data (e.g., from --no-data).
# A clean backup of a live CaveCMS install MUST have rows in these tables.
# ---------------------------------------------------------------------------
for tbl in "${TRACKED_TABLES[@]}"; do
  rows=$(mysql --protocol=socket --connect-timeout=10 -uroot -N -B -e \
    "SELECT COUNT(*) FROM \`$DRILL_DB\`.\`$tbl\`;" 2>&1) || {
    echo "[restore-drill.sh] tracked table query failed for $DRILL_DB.$tbl: $(printf '%s' "$rows" | sanitize)" >&2
    exit 1
  }
  [[ "$rows" =~ ^[0-9]+$ ]] || {
    echo "[restore-drill.sh] non-numeric row count for $DRILL_DB.$tbl: '$(printf '%s' "$rows" | sanitize)'" >&2
    exit 1
  }
  if [ "$rows" -eq 0 ]; then
    echo "[restore-drill.sh] tracked table $DRILL_DB.$tbl has 0 rows — restore looks empty" >&2
    echo "[restore-drill.sh]   likely cause: backup was schema-only (--no-data flag regression in deploy.sh / db-backup.sh)" >&2
    exit 1
  fi
done

# NOTE: backup-age sanity check was MOVED earlier in this script (right
# after $LATEST_BACKUP is resolved) so the staleness alert fires BEFORE
# the expensive scratch-DB create + decrypt + restore. The check at
# that earlier site also enforces a tighter 3-day window aligned with
# TABLE_COUNT_TOLERANCE=5's migration-cadence budget.

# ---------------------------------------------------------------------------
# Touch the success marker. Best-effort: a failed marker write after a
# verified-successful drill should not fail the run.
# ---------------------------------------------------------------------------
if ! : > "$MARKER" 2>/dev/null; then
  echo "[restore-drill.sh] WARN: could not touch $MARKER (parent missing?)" >&2
fi

echo "[restore-drill.sh] ok (backup=$(basename "$LATEST_BACKUP"); age=${backup_age_days}d; live_tables=${live_count}; drill_tables=${drill_count}; delta=${delta}; tracked_tables_nonempty=${#TRACKED_TABLES[@]})"

exit 0
