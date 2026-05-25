#!/usr/bin/env bash
# scripts/db-backup.sh — daily encrypted MariaDB backup with off-site copy.
#
# Invoked by systemd: cavecms-db-backup.timer → cavecms-db-backup.service.
# Runs as cavecms:backup with IOSchedulingClass=idle, MemoryMax=256M,
# ReadWritePaths=/backup /var/log/cavecms /var/lib/cavecms, ProtectSystem=strict,
# PrivateTmp=true, EnvironmentFile=/etc/cavecms/env.production (per
# scripts/systemd/cavecms-db-backup.service).
#
# Format INVARIANT (cross-script contract):
#   mysqldump → gzip → age encrypt → <date-utc>.sql.age
#
# This MUST match deploy.sh's pre-deploy snapshot writer (deploy.sh:282-286)
# so rollback.sh's reader pipeline (`age decrypt | gunzip | mysql`,
# rollback.sh:298) succeeds against outputs from EITHER source. If the
# order is ever changed (e.g. age before gzip, or zstd in place of gzip),
# update all three sites in lockstep:
#   - scripts/deploy.sh (pre-deploy snapshot writer)
#   - scripts/db-backup.sh (this file)
#   - scripts/rollback.sh (decrypt+restore reader)
#
# Off-site backups are MANDATORY:
#   Per project standards handoff and Plan 09 cluster-3 brief, production backups
#   MUST land off-site. BACKUP_RCLONE_REMOTE in /etc/cavecms/env.production
#   names the rclone target (operator populates during cluster-1 setup
#   second-stage; setup.sh's NEXT STEPS block documents the requirement).
#   If the env var
#   is empty OR rclone cannot reach the target, this script REFUSES to
#   run rather than producing a local-only backup that gives a false
#   sense of safety.
#
# Output: /backup/cavecms/db/<YYYY-MM-DD-UTC>.sql.age
#   - Same-day re-runs OVERWRITE today's file via .partial → mv -f. The
#     previous day's file is preserved by the date-based filename.
#   - Local retention: files older than 30 days are deleted at the end of
#     each successful run.
#   - Off-site retention: rclone delete --min-age 90d. The off-site
#     prune is best-effort — if the off-site is temporarily unreachable
#     for the prune step we log it and still exit success, because the
#     copy step (which already succeeded) is the load-bearing operation.
#
# Concurrency: persistent flock at /var/lib/cavecms/.cavecms-db-backup.lock.
# Same persistent-lock pattern as disk-check.sh / deploy.sh / rollback.sh
# / prune-static-pool.sh — see INVARIANT block below the flock site for
# the full "don't unlink the lock file" rationale.
#
# Side effects: writes /backup/cavecms/db/*.sql.age and the lock file; reads
# /etc/cavecms/{backup.pub,cavecms-backup.cnf,rclone.conf,env.production}. Logs
# to stdout/stderr — systemd journal captures both. OnFailure=
# cavecms-alert@%n.service alerts on non-zero exits; this script carries no
# alert logic of its own.
#
# Exit codes:
#   0  — backup completed and off-site copy succeeded OR another backup
#        already holds the lock (skipped, not failed)
#   1  — fatal: required tool/path missing, mysqldump/gzip/age pipe
#        failure, off-site unreachable, size anomaly, write failure
#   2  — usage error (stray arguments) or env precondition failure

set -euo pipefail
# inherit_errexit propagates `set -e` into command substitutions. Without
# it, a failing `find … | sort > $tmp` silently produces an empty file.
# Same idiom as disk-check.sh / prune-static-pool.sh / preflight.sh.
shopt -s inherit_errexit
IFS=$'\n\t'

# Pin collation to byte order for any sort/find/awk we run. Backup
# scripts compose paths and dates that must be deterministic across the
# host's locale state — see prune-static-pool.sh:78-84 for the full
# rationale on glibc collation surprises.
export LC_ALL=C

# Sanitize untrusted strings before echoing to operator-facing terminals
# or files. Keep TAB/LF/CR + printable ASCII; strip everything else
# (including multi-byte UTF-8 continuation bytes and ANSI escapes).
sanitize() { tr -cd '\11\12\15\40-\176'; }

# shellcheck disable=SC2154  # rc/BASH_COMMAND populated by the shell inside the trap string.
trap 'rc=$?; cmd=$(printf "%s" "${BASH_COMMAND-}" | sanitize); echo "[db-backup.sh] FAIL (rc=$rc) at line $LINENO: $cmd" >&2' ERR

# Required commands — fail fast with a uniform error message rather
# than letting a missing tool surface mid-pipeline. NOTE: sed
# intentionally absent — banned per project standards #0.15, use awk.
# Every entry here is actually invoked in the script body; cross-check
# before adding or removing.
for cmd in age awk chmod chown date find flock gzip head id mktemp mv mysqldump printf rclone rm stat tr; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[db-backup.sh] required command missing: $cmd" >&2
    exit 1
  fi
done

# Reject stray args. Keeps callers honest.
if [ $# -ne 0 ]; then
  echo "[db-backup.sh] usage: db-backup.sh (no arguments)" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Paths and constants
# ---------------------------------------------------------------------------
BACKUP_DIR=/backup/cavecms/db
LOCK_FILE=/var/lib/cavecms/.cavecms-db-backup.lock
# Health marker — `: > $HEALTH_MARKER` truncate-writes follow symlinks
# (open(O_CREAT|O_WRONLY|O_TRUNC) doesn't honor symlink-safety unless
# explicitly using O_NOFOLLOW, which shell `>` doesn't). Precheck the
# path for a planted symlink to prevent a cavecms-uid attacker (e.g., via
# a compromised PM2 worker) from redirecting the truncate into
# /var/lib/cavecms/deploy.blocked (DoS deploy pipeline) or another
# cavecms-writable file in /var/log/cavecms.
HEALTH_MARKER=/var/lib/cavecms/last-db-backup.ok
DEFAULTS_FILE=/etc/cavecms/cavecms-backup.cnf
RECIPIENT_FILE=/etc/cavecms/backup.pub
DATE=$(date -u +%F)
OUT=$BACKUP_DIR/$DATE.sql.age
# Local retention: 30 days. Plenty for forensic rollback while still
# bounding /backup growth. Operator can extend by tweaking this constant
# (NOT by symlinking, NOT by setting an env var — backup retention is a
# policy decision that lives in the script, not in operator state).
RETENTION_LOCAL_DAYS=30
# Off-site retention: 90 days. Triple the local window so a long-window
# corruption event (hidden bad write, ransomware dwell) still has an
# off-site copy from before the event.
RETENTION_OFFSITE_DAYS=90
# Size-anomaly floor: refuse to accept a dump that's less than half the
# size of the LARGEST existing dump in $BACKUP_DIR. mysqldump on a
# corrupt table or a transient permissions failure can emit a dramatically
# truncated dump that age still encrypts happily — this guard catches
# those before they overwrite a known-good prior.
SIZE_FLOOR_RATIO_NUM=1   # numerator of the floor ratio (1/2 → 50%)
SIZE_FLOOR_RATIO_DEN=2
# Absolute floor: refuse anything under 1 KiB on the very first run when
# we have no prior to ratio-compare against. A real cavecms dump is hundreds
# of KB minimum even with empty content tables (schema + routines).
SIZE_FLOOR_BYTES_ABS=1024

# ---------------------------------------------------------------------------
# Validate env (from /etc/cavecms/env.production via EnvironmentFile)
# ---------------------------------------------------------------------------
# BACKUP_RCLONE_REMOTE is MANDATORY — refuse to run without an off-site
# target. The placeholder in env.production (setup.sh's env.production
# write block) is empty until
# the operator populates it; this guard makes "I forgot to set it"
# loud rather than silently producing local-only backups.
if [ -z "${BACKUP_RCLONE_REMOTE:-}" ]; then
  echo "[db-backup.sh] BACKUP_RCLONE_REMOTE is empty — production backups MUST be off-site." >&2
  echo "[db-backup.sh]   Populate BACKUP_RCLONE_REMOTE in /etc/cavecms/env.production (see setup.sh's NEXT STEPS instruction)." >&2
  exit 2
fi
# Strip CR/LF/TAB the operator may have introduced via a heredoc or
# copy-paste in /etc/cavecms/env.production. Spaces and quotes are
# intentionally left intact: rclone remote names per its config grammar
# do not contain whitespace, and a literal `"` in the value is operator
# error worth surfacing loudly via the downstream rclone failure rather
# than silently swallowed here.
BACKUP_RCLONE_REMOTE=${BACKUP_RCLONE_REMOTE//[$'\r\n\t']/}
# Canonicalize trailing slashes — strip ALL of them, not just one.
# `${VAR%/}` only strips a single trailing slash; an operator typo
# `remote:path//` would otherwise compose as `remote:path//db` (which
# rclone tolerates but is not strictly canonical). Loop until no
# trailing slash remains.
while [ "${BACKUP_RCLONE_REMOTE: -1}" = "/" ]; do
  BACKUP_RCLONE_REMOTE=${BACKUP_RCLONE_REMOTE%/}
done
# Sanitize once here so every downstream echo of $BACKUP_RCLONE_REMOTE
# (error paths, progress logs, final ok line) is safe by construction.
# Done AFTER canonicalization so the strip operations work on the raw
# operator-supplied value first.
BACKUP_RCLONE_REMOTE=$(printf '%s' "$BACKUP_RCLONE_REMOTE" | sanitize)
if [ -z "$BACKUP_RCLONE_REMOTE" ]; then
  echo "[db-backup.sh] BACKUP_RCLONE_REMOTE collapsed to empty after canonicalization — check /etc/cavecms/env.production" >&2
  exit 2
fi
# Reject a leading `-` so a tampered or typo'd env.production cannot
# smuggle a flag override into rclone (e.g. `--config=/tmp/evil:bucket`
# would be parsed as an rclone option, redirecting backups to an
# attacker-controlled remote). The double-quoting we use protects
# against shell word-splitting but does NOT prevent rclone's own
# argument parser from interpreting flag-shaped positional args.
case "$BACKUP_RCLONE_REMOTE" in
  -*) echo "[db-backup.sh] BACKUP_RCLONE_REMOTE must not start with '-' (would be parsed as an rclone flag)" >&2; exit 2 ;;
esac

# RCLONE_CONFIG should be set by env.production (setup.sh's env.production
# write block emits
# RCLONE_CONFIG=/etc/cavecms/rclone.conf). If missing or pointing at an
# unreadable path, rclone falls back to ~/.config/rclone/rclone.conf —
# but as the cavecms system user that path doesn't exist, so rclone would
# proceed with an empty config and the off-site copy would silently go
# nowhere. Verify the config path before doing the expensive mysqldump.
if [ -z "${RCLONE_CONFIG:-}" ]; then
  echo "[db-backup.sh] RCLONE_CONFIG is empty — expected /etc/cavecms/rclone.conf via env.production" >&2
  exit 2
fi
if [ ! -r "$RCLONE_CONFIG" ]; then
  echo "[db-backup.sh] RCLONE_CONFIG=$RCLONE_CONFIG is not readable as user $(id -un)" >&2
  exit 2
fi
# Refuse a zero-byte rclone.conf — setup.sh creates a placeholder at this
# size; the operator must populate it during cluster-1 second-stage
# provisioning (setup.sh's rclone.conf operator-step note documents it).
rclone_conf_size=$(stat -c %s "$RCLONE_CONFIG")
if [ "$rclone_conf_size" -eq 0 ]; then
  echo "[db-backup.sh] $RCLONE_CONFIG is zero-byte — operator must populate it (see setup.sh's rclone.conf operator-step note)" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Validate mysqldump credentials + age recipient
# ---------------------------------------------------------------------------
# cavecms-backup.cnf is mode 0640 root:cavecms per setup.sh's cavecms-backup.cnf
# install block. The cavecms system
# user reads it as group member; if the file isn't readable from here,
# the systemd unit's User= directive or the file's perms have drifted.
if [ ! -r "$DEFAULTS_FILE" ]; then
  echo "[db-backup.sh] $DEFAULTS_FILE not readable as user $(id -un) — check setup.sh perms (640 root:cavecms)" >&2
  exit 2
fi

# Validate the age recipient up-front. Cluster-1 setup.sh writes ONE
# age1-prefixed line; reject anything else. Same defence as deploy.sh:135-143
# — a tampered or zero-byte backup.pub could otherwise feed `age` a line
# starting with `-` and inject options into the pipeline.
if [ ! -r "$RECIPIENT_FILE" ]; then
  echo "[db-backup.sh] $RECIPIENT_FILE not readable — age recipient missing" >&2
  exit 2
fi
AGE_PUB=$(head -n 1 "$RECIPIENT_FILE" | tr -d '[:space:]')
if [[ ! "$AGE_PUB" =~ ^age1[0-9a-z]+$ ]]; then
  echo "[db-backup.sh] $RECIPIENT_FILE: first line is not a valid age1-prefixed recipient" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Ensure local backup dir exists (cluster-1 invariant — setup.sh creates
# /backup/cavecms/db at 750 cavecms:backup). install -d is idempotent and a
# no-op when the dir already has the right ownership/mode.
# ---------------------------------------------------------------------------
if [ ! -d "$BACKUP_DIR" ]; then
  echo "[db-backup.sh] $BACKUP_DIR missing — cluster-1 setup didn't create it; refusing" >&2
  exit 1
fi

# Symlink precheck on $LOCK_FILE. `exec 9>` would otherwise follow a
# symlink and O_TRUNC the target — a cavecms-group attacker (we run AS cavecms,
# so anything in /var/lib/cavecms that the cavecms user can write is in-scope)
# could plant .cavecms-db-backup.lock → /var/lib/cavecms/<sensitive> and have
# this script truncate it.
for f in "$LOCK_FILE" "$HEALTH_MARKER"; do
  if [ -L "$f" ]; then
    echo "[db-backup.sh] refusing: $f is a symlink (expected regular file or absent)" >&2
    exit 1
  fi
done

# IMPORTANT INVARIANT — DO NOT REORDER:
#   The `exit 0` on flock contention MUST happen BEFORE the EXIT trap is
#   installed. Otherwise the losing process's EXIT trap would unlink
#   files the winner still references. Trap intentionally does NOT touch
#   $LOCK_FILE (see disk-check.sh:135-149 for the full rationale on
#   persistent lock files).
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[db-backup.sh] another db-backup holds $LOCK_FILE — skipping this tick"
  exit 0
fi

# Tempfile for the snapshot pipeline. mktemp (O_CREAT|O_EXCL) refuses
# attacker-planted symlinks. Name pattern `<date>.sql.age.partial.XXXXXX`
# combines the cluster `.partial` convention from deploy.sh:265 with
# mktemp's randomized suffix for O_EXCL safety. The name is visible in
# plain `ls /backup/cavecms/db` (no leading dot) so operators can spot
# aborted runs at a glance. The trailing `.partial.XXXXXX` keeps it
# distinct from the canonical `*.sql.age` glob used by retention prune
# at the end of this script.
SNAP_TMP=$(mktemp "$BACKUP_DIR/$DATE.sql.age.partial.XXXXXX")
# shellcheck disable=SC2064  # expand SNAP_TMP NOW so the trap survives variable scope.
trap "rm -f -- \"$SNAP_TMP\"" EXIT
# Signal traps re-raise conventional 128+signo exit codes.
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# ---------------------------------------------------------------------------
# Off-site pre-flight: verify rclone can reach $BACKUP_RCLONE_REMOTE/db
# BEFORE spending mysqldump's CPU/IO. rclone mkdir is idempotent — a
# missing remote dir on first run is created here; an already-existing
# dir is left untouched. Failure means either bad config, expired
# credentials, or network — none of which are worth dumping for.
# ---------------------------------------------------------------------------
if ! rclone mkdir -- "$BACKUP_RCLONE_REMOTE/db" >/dev/null 2>&1; then
  echo "[db-backup.sh] rclone pre-flight failed: cannot mkdir $BACKUP_RCLONE_REMOTE/db" >&2
  echo "[db-backup.sh]   check RCLONE_CONFIG=$RCLONE_CONFIG, network, and BACKUP_RCLONE_REMOTE" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Dump → gzip → age pipeline. Format INVARIANT (see header) — DO NOT
# alter ordering or stage selection without also updating deploy.sh and
# rollback.sh in lockstep.
#
# mysqldump flags match deploy.sh:282-284 byte-for-byte:
#   --single-transaction → consistent snapshot via REPEATABLE READ
#   --quick              → row-by-row streaming, low memory footprint
#   --skip-lock-tables   → don't request LOCK TABLES (single-transaction
#                          handles consistency without blocking writes)
#   --routines/--triggers/--events → cover all DB-side artifacts; cavecms_backup
#                          principal has SELECT+TRIGGER+EVENT+SHOW VIEW+
#                          LOCK TABLES grants (cluster-1 setup.sh).
# NOTE: --set-gtid-purged is MySQL-only — MariaDB exits 2 on unknown
# flag. Both deploy.sh and this script omit it (see deploy.sh:251-252).
# ---------------------------------------------------------------------------
echo "[db-backup.sh] writing snapshot to $OUT..."
if ! mysqldump --defaults-extra-file="$DEFAULTS_FILE" \
       --single-transaction --quick --skip-lock-tables \
       --routines --triggers --events cavecms \
     | gzip \
     | age -r "$AGE_PUB" > "$SNAP_TMP"; then
  # Capture PIPESTATUS on the line IMMEDIATELY after the pipeline so a
  # subsequent simple command can't clobber it. Same idiom as
  # deploy.sh:287-291.
  pipestatus=("${PIPESTATUS[@]}")
  echo "[db-backup.sh] snapshot FAILED" >&2
  printf '[db-backup.sh]   PIPESTATUS (mysqldump|gzip|age) = %s %s %s\n' \
    "${pipestatus[0]:-?}" "${pipestatus[1]:-?}" "${pipestatus[2]:-?}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Size-anomaly guard. Apply BEFORE the off-site copy so a corrupt dump
# never leaves the box. On refusal the EXIT trap cleans the .partial
# without overwriting a known-good prior at $OUT.
# ---------------------------------------------------------------------------
new_size=$(stat -c %s "$SNAP_TMP")
[[ "$new_size" =~ ^[0-9]+$ ]] || {
  echo "[db-backup.sh] stat returned non-numeric size for $SNAP_TMP" >&2
  exit 1
}
# Absolute floor (covers first-ever-run when there's no prior to compare).
if [ "$new_size" -lt "$SIZE_FLOOR_BYTES_ABS" ]; then
  echo "[db-backup.sh] size anomaly: new=${new_size}B < absolute floor ${SIZE_FLOOR_BYTES_ABS}B" >&2
  echo "[db-backup.sh]   refusing to accept — a real cavecms dump is much larger than ${SIZE_FLOOR_BYTES_ABS}B" >&2
  exit 1
fi
# Ratio floor (compare against largest existing dump). preflight.sh:163-171
# uses the same "largest, not yesterday" approach — a single missing day
# shouldn't disable the gate. Excludes the .partial we just wrote.
# BACKUP_DIR existence was validated up-top (line ~218); the `[ -d ]`
# wrapper here would be unreachable-as-false. Mirror uploads-backup.sh's
# shape — let find/awk run unconditionally and seed largest=0 via the
# awk BEGIN block.
largest=$(find "$BACKUP_DIR" -maxdepth 1 -name '*.sql.age' -type f -printf '%s\n' \
  | awk 'BEGIN{m=0} {if ($1+0 > m) m=$1+0} END{print m+0}')
[[ "$largest" =~ ^[0-9]+$ ]] || largest=0
if [ "$largest" -gt 0 ]; then
  # Multiply first, then divide — avoids losing precision on small fractions.
  threshold=$(( largest * SIZE_FLOOR_RATIO_NUM / SIZE_FLOOR_RATIO_DEN ))
  if [ "$new_size" -lt "$threshold" ]; then
    echo "[db-backup.sh] size anomaly: new=${new_size}B < ${SIZE_FLOOR_RATIO_NUM}/${SIZE_FLOOR_RATIO_DEN} of largest existing (${largest}B → threshold ${threshold}B)" >&2
    echo "[db-backup.sh]   refusing to accept — investigate before forcing a backup" >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Commit locally: atomic rename. mode 0640 cavecms:backup so operators in
# the backup group can read for restore-drill / forensic purposes.
# mv -f tolerates an existing target (same-day re-run).
#
# Ordering: chmod → chown → mv. Functionally equivalent to deploy.sh's
# mv → chmod → chown sequence (the perms ride the inode through rename
# either way), but doing it on the tempfile first avoids a brief window
# where the canonical $OUT file exists at the wrong perms. NOT byte-
# identical to deploy.sh:296-297 — flagged so a future cross-script
# diff doesn't treat this as a regression.
# ---------------------------------------------------------------------------
chmod 640 "$SNAP_TMP"
# Group `backup` (not `cavecms`) matches the cluster-1 chown convention used
# by deploy.sh:297 on its pre-deploy snapshot. If chown fails (group
# missing — shouldn't happen given cluster-1 invariants), fall back
# without failing the run; the file stays at mktemp's default
# cavecms:cavecms 600 which the cavecms user can still read.
if ! chown cavecms:backup "$SNAP_TMP" 2>/dev/null; then
  echo "[db-backup.sh] WARN: chown cavecms:backup $SNAP_TMP failed; snapshot will be cavecms:cavecms" >&2
fi
mv -f -- "$SNAP_TMP" "$OUT"
# mv consumed $SNAP_TMP; the EXIT trap captured the original mktemp path
# at trap-install time (double-quoted expansion), so its `rm -f` against
# the now-absent path no-ops on exit.

# ---------------------------------------------------------------------------
# Off-site copy. Required for the run to count as successful — a local-
# only backup is not a backup per the cluster-3 brief.
#
# rclone copy is incremental (uploads only changed files). Today's
# encrypted dump has changed every byte vs yesterday's (age uses fresh
# nonces) so it will always be uploaded fresh; that's fine, and the
# off-site retention prunes old copies.
# ---------------------------------------------------------------------------
echo "[db-backup.sh] copying $OUT to $BACKUP_RCLONE_REMOTE/db/..."
if ! rclone copy --no-traverse -- "$OUT" "$BACKUP_RCLONE_REMOTE/db/"; then
  echo "[db-backup.sh] rclone copy FAILED — off-site copy unsuccessful. Local snapshot is preserved at $OUT." >&2
  echo "[db-backup.sh]   operator: investigate rclone connectivity and re-run with \`rclone copy $OUT $BACKUP_RCLONE_REMOTE/db/\`" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Local retention prune. mtime — the file was written by THIS script, so
# mtime is current as of the .partial → mv. find -delete is idempotent.
# The `*.sql.age` glob deliberately does NOT match in-flight tempfiles
# (which carry a `.partial.XXXXXX` suffix), so an aborted concurrent
# run's tempfile is never reaped by this gate.
# ---------------------------------------------------------------------------
find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.sql.age' -mtime "+$RETENTION_LOCAL_DAYS" -delete

# ---------------------------------------------------------------------------
# Sweep orphan .partial.* tempfiles from SIGKILL'd runs. The EXIT trap
# cleans tempfiles on every catchable exit (errors, signals 1/2/15), but
# SIGKILL (OOM-killer, MemoryMax=256M-hit, manual `kill -9`) bypasses
# every trap. Without this sweep, an orphan .partial accumulates per
# SIGKILL'd run. The +1d age filter guarantees we never delete a tempfile
# being actively written by a parallel invocation — but flock already
# prevents concurrent runs, so this is belt-and-suspenders.
# ---------------------------------------------------------------------------
find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.sql.age.partial.*' -mtime +1 -delete

# ---------------------------------------------------------------------------
# Off-site retention prune. Best-effort: if this fails (transient network,
# remote ACL drift), we log it but the run still succeeds — the
# load-bearing operation was the copy, which already succeeded.
# `--min-age 90d` deletes any file in the remote dir whose remote mtime
# is older than 90 days.
# ---------------------------------------------------------------------------
if ! rclone delete --min-age "${RETENTION_OFFSITE_DAYS}d" -- "$BACKUP_RCLONE_REMOTE/db/"; then
  echo "[db-backup.sh] WARN: off-site prune failed — local snapshot succeeded, off-site prune is best-effort" >&2
fi

# Touch a state marker for operators / cron-purge orchestration. Same
# idiom as uploads-backup.sh will use (T8b adds
# /var/lib/cavecms/last-uploads-backup.ok); a future health-monitor script
# can `stat -c %Y` this and alert if it falls behind a fresh 24h.
#
# Best-effort: if /var/lib/cavecms drifted (operator cleaned, FS unmounted,
# etc.), don't fail the run after a successful backup + copy. Marker is
# observability, not a load-bearing operation.
if ! : > "$HEALTH_MARKER" 2>/dev/null; then
  echo "[db-backup.sh] WARN: could not touch $HEALTH_MARKER (parent missing?)" >&2
fi

# $OUT is constructed from a hardcoded constant + UTC date — no control
# bytes possible. $BACKUP_RCLONE_REMOTE was sanitized at env-validation
# time. Both are echo-safe by construction; the explicit sanitize on
# the final line is removed.
echo "[db-backup.sh] ok (local=${OUT}; size=${new_size}B; offsite=${BACKUP_RCLONE_REMOTE}/db/; retention_local=${RETENTION_LOCAL_DAYS}d; retention_offsite=${RETENTION_OFFSITE_DAYS}d)"

exit 0
