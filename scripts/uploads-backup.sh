#!/usr/bin/env bash
# scripts/uploads-backup.sh — daily encrypted uploads backup with off-site copy.
#
# Invoked by systemd: bwc-uploads-backup.timer → bwc-uploads-backup.service.
# Runs as bwc:backup with IOSchedulingClass=idle, MemoryMax=256M,
# ReadWritePaths=/backup /var/log/bwc /var/lib/bwc, ProtectSystem=strict,
# PrivateTmp=true, EnvironmentFile=/etc/bwc/env.production (per
# scripts/systemd/bwc-uploads-backup.service).
#
# What's backed up:
#   /opt/bwc/uploads/originals/         — full-resolution source images
#   /opt/bwc/uploads/variants/          — generated derivative variants
#   /opt/bwc/uploads/brochures-private/ — PII-bearing private documents
#
# What's excluded:
#   /opt/bwc/uploads/.tmp/              — work-in-flight uploads (the
#                                         tarball selects the three
#                                         canonical subdirs by name, so
#                                         .tmp is excluded by selection;
#                                         a defence-in-depth --exclude
#                                         on the tar command catches any
#                                         future move of .tmp into a
#                                         tracked subdir).
#
# Why age encryption is mandatory:
#   brochures-private contains PII. Any unencrypted backup of this tree
#   landing off-site is a data breach. The pipeline encrypts everything
#   end-to-end with the cluster-1 age public key, so plaintext PII never
#   leaves the box.
#
# Format: tar → gzip → age encrypt → /backup/bwc/uploads/<YYYY-MM-DD-UTC>.tar.age.
# This is a SEPARATE invariant from db-backup.sh's mysqldump→gzip→age
# format. There is no consumer that reads both — restore-drill.sh
# operates on db dumps only. The on-disk shape of an uploads backup is
# decode-via:
#   age decrypt -i <identity> file.tar.age | gunzip | tar -xf - -C <target>
#
# Skip-if-no-changes:
#   Compares /var/lib/bwc/last-uploads-backup.ok mtime against the
#   newest file mtime in the three tracked subdirs. If nothing in
#   uploads has changed since the last successful backup, skip the run
#   entirely — daily backups of an unchanged 10GB tree are wasteful
#   IO and off-site bandwidth. First run (marker absent) always runs.
#
#   Marker mtime semantics: $SCAN_MARKER is installed via
#   `mv PRE_MARKER → $SCAN_MARKER`, where PRE_MARKER is a tempfile
#   created BEFORE tar walks the source tree. This makes
#   $SCAN_MARKER.mtime == "tar-start time", so any file finalized AT
#   OR AFTER tar-start (whether captured in the in-flight archive or
#   not) is caught by the next run's find -newer. A naive "touch
#   $SCAN_MARKER after backup completes" would set the marker AFTER
#   any file-write that raced the tar pipeline, silently dropping
#   those files from every future backup — the bug this scheme avoids.
#
#   A separate $HEALTH_MARKER (visible /var/lib/bwc/last-uploads-backup.ok)
#   is touched on every successful exit, including the no-changes skip
#   path. bwc-cron-purge (cluster 4) reads this marker and aborts if
#   it's older than 24h — so on a no-upload-activity day the script
#   must STILL refresh the health marker, even though it doesn't touch
#   the scan marker.
#
# Off-site backups are MANDATORY:
#   Per project standards handoff and Plan 09 cluster-3 brief, production backups
#   MUST land off-site. BACKUP_RCLONE_REMOTE in /etc/bwc/env.production
#   names the rclone target. If unset OR rclone cannot reach the target,
#   refuse the run. db-backup.sh runs daily with a full rclone pre-flight,
#   so cross-script monitoring catches an off-site outage within 24h even
#   if uploads-backup skipped on no-changes that day.
#
# Output: /backup/bwc/uploads/<YYYY-MM-DD-UTC>.tar.age
#   - Same-day re-runs OVERWRITE today's file via .partial → mv -f.
#   - Local retention: files older than 30 days are deleted at the end
#     of each successful run.
#   - Off-site retention: rclone delete --min-age 90d (best-effort).
#
# Concurrency: persistent flock at /var/lib/bwc/.bwc-uploads-backup.lock.
# Same persistent-lock pattern as disk-check.sh / db-backup.sh — lock
# file lives across runs (see disk-check.sh:135-149 for the full
# rationale).
#
# Side effects: writes /backup/bwc/uploads/*.tar.age and the lock file;
# reads /opt/bwc/uploads/{originals,variants,brochures-private}; touches
# /var/lib/bwc/last-uploads-backup.ok on success. Logs to stdout/stderr
# (systemd journal). OnFailure=bwc-alert@%n.service.
#
# Exit codes:
#   0  — backup completed and off-site copy succeeded, OR no-changes
#        skip path taken, OR another backup already holds the lock
#   1  — fatal: required tool/path missing, tar/gzip/age pipe failure,
#        off-site unreachable, size anomaly, write failure
#   2  — usage error (stray arguments) or env precondition failure

set -euo pipefail
shopt -s inherit_errexit
IFS=$'\n\t'

# Pin collation for deterministic sort/find/awk under any host locale.
# Same idiom as db-backup.sh / prune-static-pool.sh.
export LC_ALL=C

sanitize() { tr -cd '\11\12\15\40-\176'; }

# shellcheck disable=SC2154
trap 'rc=$?; cmd=$(printf "%s" "${BASH_COMMAND-}" | sanitize); echo "[uploads-backup.sh] FAIL (rc=$rc) at line $LINENO: $cmd" >&2' ERR

# Required commands — every entry is invoked in the script body.
for cmd in age awk chmod chown date find flock gzip head id mktemp mv printf rclone rm stat tar tr; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[uploads-backup.sh] required command missing: $cmd" >&2
    exit 1
  fi
done

if [ $# -ne 0 ]; then
  echo "[uploads-backup.sh] usage: uploads-backup.sh (no arguments)" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Paths and constants
# ---------------------------------------------------------------------------
UPLOADS_ROOT=/opt/bwc/uploads
# The three canonical subdirs from cluster-1 setup.sh's uploads-tree
# install -d block (originals + variants + brochures-private). .tmp is
# DELIBERATELY NOT in this list — work-in-flight uploads must not be
# captured in a backup.
SUBDIRS=(originals variants brochures-private)
BACKUP_DIR=/backup/bwc/uploads
# Two separate markers with two distinct semantics:
#   SCAN_MARKER (hidden, mtime = tar-start time):
#     - Used by find -newer in the skip-if-no-changes gate.
#     - Updated ONLY on the full-backup path (via rename of PRE_MARKER).
#     - On a no-changes skip we MUST NOT touch this; otherwise the next
#       run's find would compare against "today" and miss every upload
#       finalized before that touch.
#   HEALTH_MARKER (visible, mtime = "last successful run"):
#     - Consumed by bwc-cron-purge (see bwc-cron-purge.service header:
#       "cron-purge.ts ... aborts if the marker is older than 24h").
#     - Updated on EVERY successful exit, including the no-changes skip
#       path. On a low-activity week with daily no-op runs, cron-purge
#       must still see a fresh marker — otherwise it aborts and uploads
#       cleanup is deferred indefinitely.
# These two semantics CONFLICTED when both were collapsed onto a single
# file. They are split here.
SCAN_MARKER=/var/lib/bwc/.last-uploads-backup.scan
HEALTH_MARKER=/var/lib/bwc/last-uploads-backup.ok
LOCK_FILE=/var/lib/bwc/.bwc-uploads-backup.lock
RECIPIENT_FILE=/etc/bwc/backup.pub
DATE=$(date -u +%F)
OUT=$BACKUP_DIR/$DATE.tar.age
RETENTION_LOCAL_DAYS=30
RETENTION_OFFSITE_DAYS=90
# Size floors. tar's worst-case compressed empty archive is around 50
# bytes (just the EOF blocks). A real BWC uploads archive — even on a
# brand-new install with stock seed media — is hundreds of KB. The
# absolute floor catches catastrophic truncation; the ratio floor
# catches "new < half of largest prior", flagging both corruption and
# mass-deletion events for operator review.
SIZE_FLOOR_RATIO_NUM=1
SIZE_FLOOR_RATIO_DEN=2
SIZE_FLOOR_BYTES_ABS=1024

# ---------------------------------------------------------------------------
# Validate env
# ---------------------------------------------------------------------------
if [ -z "${BACKUP_RCLONE_REMOTE:-}" ]; then
  echo "[uploads-backup.sh] BACKUP_RCLONE_REMOTE is empty — production backups MUST be off-site." >&2
  echo "[uploads-backup.sh]   Populate BACKUP_RCLONE_REMOTE in /etc/bwc/env.production (see setup.sh's NEXT STEPS instruction)." >&2
  exit 2
fi
BACKUP_RCLONE_REMOTE=${BACKUP_RCLONE_REMOTE//[$'\r\n\t']/}
while [ "${BACKUP_RCLONE_REMOTE: -1}" = "/" ]; do
  BACKUP_RCLONE_REMOTE=${BACKUP_RCLONE_REMOTE%/}
done
BACKUP_RCLONE_REMOTE=$(printf '%s' "$BACKUP_RCLONE_REMOTE" | sanitize)
if [ -z "$BACKUP_RCLONE_REMOTE" ]; then
  echo "[uploads-backup.sh] BACKUP_RCLONE_REMOTE collapsed to empty after canonicalization — check /etc/bwc/env.production" >&2
  exit 2
fi
# Reject leading `-` — see db-backup.sh for the rationale (rclone flag
# smuggling via a tampered or typo'd env.production).
case "$BACKUP_RCLONE_REMOTE" in
  -*) echo "[uploads-backup.sh] BACKUP_RCLONE_REMOTE must not start with '-' (would be parsed as an rclone flag)" >&2; exit 2 ;;
esac

if [ -z "${RCLONE_CONFIG:-}" ]; then
  echo "[uploads-backup.sh] RCLONE_CONFIG is empty — expected /etc/bwc/rclone.conf via env.production" >&2
  exit 2
fi
if [ ! -r "$RCLONE_CONFIG" ]; then
  echo "[uploads-backup.sh] RCLONE_CONFIG=$RCLONE_CONFIG is not readable as user $(id -un)" >&2
  exit 2
fi
rclone_conf_size=$(stat -c %s "$RCLONE_CONFIG")
if [ "$rclone_conf_size" -eq 0 ]; then
  echo "[uploads-backup.sh] $RCLONE_CONFIG is zero-byte — operator must populate it (see setup.sh's rclone.conf operator-step note)" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Validate age recipient
# ---------------------------------------------------------------------------
if [ ! -r "$RECIPIENT_FILE" ]; then
  echo "[uploads-backup.sh] $RECIPIENT_FILE not readable — age recipient missing" >&2
  exit 2
fi
AGE_PUB=$(head -n 1 "$RECIPIENT_FILE" | tr -d '[:space:]')
if [[ ! "$AGE_PUB" =~ ^age1[0-9a-z]+$ ]]; then
  echo "[uploads-backup.sh] $RECIPIENT_FILE: first line is not a valid age1-prefixed recipient" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Validate source tree. All three subdirs MUST exist — partial layout
# indicates env drift from cluster-1 setup.sh and would silently exclude
# the missing subdir from the backup (a real data-loss hazard for
# brochures-private). Refuse loudly.
# ---------------------------------------------------------------------------
if [ ! -d "$UPLOADS_ROOT" ]; then
  echo "[uploads-backup.sh] $UPLOADS_ROOT missing — cluster-1 setup didn't create it; refusing" >&2
  exit 1
fi
for sub in "${SUBDIRS[@]}"; do
  if [ ! -d "$UPLOADS_ROOT/$sub" ]; then
    echo "[uploads-backup.sh] $UPLOADS_ROOT/$sub missing — env drift from cluster-1 setup.sh's uploads-tree install block; refusing" >&2
    exit 1
  fi
done

if [ ! -d "$BACKUP_DIR" ]; then
  echo "[uploads-backup.sh] $BACKUP_DIR missing — cluster-1 setup didn't create it; refusing" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Skip-if-no-changes gate. find -newer + -print -quit terminates on the
# first matching file, so the walk is O(1) when there's been any change
# and at most O(N) when there hasn't (worst case: full tree walk to
# confirm no changes). On a daily timer with modest upload activity this
# is the right trade-off — we'd rather walk a few thousand inodes than
# tar+gzip+age+rclone a multi-GB tree we've already backed up.
#
# First-ever run (marker absent) always runs the backup.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Symlink prechecks — MUST run BEFORE the skip-if-no-changes gate below,
# because the skip path also writes $HEALTH_MARKER via `: > "$HEALTH_MARKER"`
# (truncate-write follows symlinks). Without this guard placed first, a
# bwc-uid attacker could pre-plant $HEALTH_MARKER as a symlink to
# /var/lib/bwc/deploy.blocked (writable via group bwcstate per the
# cluster-3 perm fix) → the next no-changes tick's skip-path HEALTH
# touch would truncate the sentinel → empty sentinel = "operator-
# owned" per disk-check's is_ours semantics → preflight refuses every
# subsequent deploy = permanent deploy-pipeline DoS until manual
# operator intervention. Closes the symlink-follow attack on the
# dominant (no-changes) code path.
#
# $SCAN_MARKER is installed via `mv` (rename(2)) which does NOT follow
# symlinks — rename replaces the symlink with the source file, leaving
# the symlink target untouched. So SCAN_MARKER does not need a precheck.
for f in "$LOCK_FILE" "$HEALTH_MARKER"; do
  if [ -L "$f" ]; then
    echo "[uploads-backup.sh] refusing: $f is a symlink (expected regular file or absent)" >&2
    exit 1
  fi
done

if [ -f "$SCAN_MARKER" ]; then
  # find -newer compares mtimes by the kernel's nanosecond clock; no
  # ambiguity from "same second" edge cases. We pass all three subdirs
  # so find never sees /opt/bwc/uploads/.tmp.
  #
  # Fail-OPEN on find error: a permission drift on a subdir would
  # otherwise silently skip backups indefinitely (the scan marker
  # doesn't update on the skip path, so the same find fails the next
  # day, and the next, with no alert). `if cmd; then` suspends errexit;
  # we branch on rc explicitly to distinguish "found nothing" from
  # "find errored".
  if newer=$(find "${SUBDIRS[@]/#/$UPLOADS_ROOT/}" -type f -newer "$SCAN_MARKER" -print -quit 2>&1); then
    if [ -z "$newer" ]; then
      echo "[uploads-backup.sh] no upload changes since $(stat -c %y "$SCAN_MARKER" | sanitize) — skipping"
      # CRITICAL: refresh the HEALTH marker even on the skip path so
      # bwc-cron-purge doesn't see a stale marker on no-activity days.
      # See bwc-cron-purge.service header — it aborts if this marker
      # is older than 24h. The scan marker is intentionally left
      # untouched so the find-newer gate keeps comparing against the
      # actual tar-start time.
      #
      # Note: this touch is NOT lock-protected (the flock is acquired
      # further down at the full-backup branch). Two concurrent
      # invocations both reaching the skip path is benign — `: > FILE`
      # is open(O_TRUNC) on a regular file; both succeed, mtime ends
      # up at the later one, content is zero bytes either way. Cluster-
      # consistent semantics ("only acknowledge work via the lock")
      # would move this inside the flock, but the no-changes case is
      # idempotent and lock-free is the simpler invariant.
      if ! : > "$HEALTH_MARKER" 2>/dev/null; then
        echo "[uploads-backup.sh] WARN: could not touch $HEALTH_MARKER on skip path (parent missing?)" >&2
      fi
      exit 0
    fi
  else
    echo "[uploads-backup.sh] WARN: no-changes find failed: $(printf '%s' "$newer" | sanitize)" >&2
    echo "[uploads-backup.sh]   falling through to full backup; investigate uploads tree permissions" >&2
  fi
fi

# ---------------------------------------------------------------------------
# Lock + tempfile setup (mirrors db-backup.sh ordering invariant).
# Note: symlink prechecks for $LOCK_FILE and $HEALTH_MARKER ran earlier,
# BEFORE the skip-if-no-changes gate above, so the skip path's
# HEALTH_MARKER truncate-write is also protected.
# ---------------------------------------------------------------------------
# IMPORTANT INVARIANT — DO NOT REORDER:
#   The `exit 0` on flock contention MUST happen BEFORE the EXIT trap is
#   installed. See disk-check.sh:135-149 for the full rationale on
#   persistent-lock-file ordering.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[uploads-backup.sh] another uploads-backup holds $LOCK_FILE — skipping this tick"
  exit 0
fi

SNAP_TMP=$(mktemp "$BACKUP_DIR/$DATE.tar.age.partial.XXXXXX")
# PRE_MARKER captures "tar-start time" — its mtime is set NOW, before
# any file in uploads is read. On success we `mv PRE_MARKER → $SCAN_MARKER`
# (mv preserves mtime via rename(2) on the same FS), so SCAN_MARKER.mtime
# becomes this pre-tar timestamp and the NEXT run's find -newer
# correctly catches every file finalized during the backup window.
PRE_MARKER=$(mktemp "$(dirname "$SCAN_MARKER")/.last-uploads-backup.pre.XXXXXX")
# shellcheck disable=SC2064  # expand SNAP_TMP/PRE_MARKER NOW so trap survives scope.
trap "rm -f -- \"$SNAP_TMP\" \"$PRE_MARKER\"" EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# ---------------------------------------------------------------------------
# Off-site pre-flight: rclone mkdir BEFORE doing the expensive tar.
# ---------------------------------------------------------------------------
if ! rclone mkdir -- "$BACKUP_RCLONE_REMOTE/uploads" >/dev/null 2>&1; then
  echo "[uploads-backup.sh] rclone pre-flight failed: cannot mkdir $BACKUP_RCLONE_REMOTE/uploads" >&2
  echo "[uploads-backup.sh]   check RCLONE_CONFIG=$RCLONE_CONFIG, network, and BACKUP_RCLONE_REMOTE" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# tar → gzip → age pipeline.
#
# tar flags:
#   -C $UPLOADS_ROOT     change to uploads root so paths in the archive
#                        are subdir-relative (originals/foo.jpg, not
#                        /opt/bwc/uploads/originals/foo.jpg). Decoding
#                        to a fresh target dir gives a clean tree.
#   --exclude '.tmp'     defence-in-depth — already excluded by NOT
#                        passing .tmp to the SUBDIRS list, but if a
#                        future maintainer adds /opt/bwc/uploads/<sub>/.tmp/
#                        the exclude rule keeps work-in-flight uploads
#                        out of the backup. tar's --exclude with this
#                        pattern is path-component-anchored and applies
#                        recursively: it prunes any `.tmp` directory at
#                        any depth, AND tar does not descend into it,
#                        so a separate `--exclude='.tmp/*'` is redundant.
#   --warning=no-file-removed: similar — a file that was deleted between
#                        tar's stat and read (concurrent cleanup of an
#                        orphan in /opt/bwc/uploads) would otherwise
#                        produce a "file vanished" warning + exit 1.
#                        The skip-if-no-changes scheme's self-healing
#                        property covers this: if the file genuinely
#                        no longer exists, no backup of it is needed.
#   --warning=no-file-changed: tar otherwise emits warnings (exit 1) on
#                        files modified during the read. Uploads are
#                        typically written via tmpname+rename; if a
#                        write races the tar, the worst case is one
#                        partial file in the archive — acceptable
#                        because the marker mtime is updated only after
#                        success, so the NEXT backup picks up the
#                        finalised version. The warning suppression
#                        avoids spurious failures from harmless races.
#   --sort=name          deterministic archive ordering for byte-stable
#                        outputs given identical inputs (helps off-site
#                        dedup if rclone backend supports it).
# ---------------------------------------------------------------------------
echo "[uploads-backup.sh] writing snapshot to $OUT..."
if ! tar -C "$UPLOADS_ROOT" \
       --exclude='.tmp' \
       --sort=name \
       --warning=no-file-changed \
       --warning=no-file-removed \
       -cf - "${SUBDIRS[@]}" \
     | gzip \
     | age -r "$AGE_PUB" > "$SNAP_TMP"; then
  pipestatus=("${PIPESTATUS[@]}")
  echo "[uploads-backup.sh] snapshot FAILED" >&2
  printf '[uploads-backup.sh]   PIPESTATUS (tar|gzip|age) = %s %s %s\n' \
    "${pipestatus[0]:-?}" "${pipestatus[1]:-?}" "${pipestatus[2]:-?}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Size-anomaly guard.
# ---------------------------------------------------------------------------
new_size=$(stat -c %s "$SNAP_TMP")
[[ "$new_size" =~ ^[0-9]+$ ]] || {
  echo "[uploads-backup.sh] stat returned non-numeric size for $SNAP_TMP" >&2
  exit 1
}
# Gate the absolute floor on whether the source tree has any files.
# A fresh install with empty subdirs legitimately produces a tiny
# archive (gzip+age of an empty tar is a few hundred bytes); applying
# the 1KiB floor blindly would fail every first-run before any uploads
# arrive. find -quit short-circuits on the first file.
#
# Fail-CLOSED on find error (UNLIKE the skip-if-no-changes find above
# which fails open). The size-anomaly guard is a data-integrity check;
# if we cannot determine whether the source has files, we cannot trust
# the guard's "empty tree is fine" bypass — apply the floor regardless.
if src_has_files=$(find "${SUBDIRS[@]/#/$UPLOADS_ROOT/}" -type f -print -quit 2>&1); then
  if [ -n "$src_has_files" ]; then
    src_known_nonempty=1
  else
    src_known_nonempty=0
  fi
else
  echo "[uploads-backup.sh] WARN: src-has-files find failed: $(printf '%s' "$src_has_files" | sanitize); applying absolute floor regardless" >&2
  src_known_nonempty=1
fi
if [ "$src_known_nonempty" = "1" ] && [ "$new_size" -lt "$SIZE_FLOOR_BYTES_ABS" ]; then
  echo "[uploads-backup.sh] size anomaly: new=${new_size}B < absolute floor ${SIZE_FLOOR_BYTES_ABS}B (source tree has files)" >&2
  echo "[uploads-backup.sh]   refusing to accept — investigate tar/gzip/age pipeline" >&2
  exit 1
fi
# BACKUP_DIR existence was validated up-top; the `[ -d ]` guard here
# would be unreachable-as-false. Drop it.
largest=$(find "$BACKUP_DIR" -maxdepth 1 -name '*.tar.age' -type f -printf '%s\n' \
  | awk 'BEGIN{m=0} {if ($1+0 > m) m=$1+0} END{print m+0}')
[[ "$largest" =~ ^[0-9]+$ ]] || largest=0
if [ "$largest" -gt 0 ]; then
  threshold=$(( largest * SIZE_FLOOR_RATIO_NUM / SIZE_FLOOR_RATIO_DEN ))
  if [ "$new_size" -lt "$threshold" ]; then
    echo "[uploads-backup.sh] size anomaly: new=${new_size}B < ${SIZE_FLOOR_RATIO_NUM}/${SIZE_FLOOR_RATIO_DEN} of largest existing (${largest}B → threshold ${threshold}B)" >&2
    echo "[uploads-backup.sh]   refusing to accept — either tar corruption or mass deletion event" >&2
    echo "[uploads-backup.sh]   if mass deletion is expected, manually remove the .partial and re-run after confirmation" >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Commit locally: chmod → chown → mv (same as db-backup.sh; see that
# file for the comment on why this differs from deploy.sh's mv-first order).
# ---------------------------------------------------------------------------
chmod 640 "$SNAP_TMP"
if ! chown bwc:backup "$SNAP_TMP" 2>/dev/null; then
  echo "[uploads-backup.sh] WARN: chown bwc:backup $SNAP_TMP failed; snapshot will be bwc:bwc" >&2
fi
mv -f -- "$SNAP_TMP" "$OUT"

# ---------------------------------------------------------------------------
# Off-site copy. Required for the run to count as successful.
# ---------------------------------------------------------------------------
echo "[uploads-backup.sh] copying $OUT to $BACKUP_RCLONE_REMOTE/uploads/..."
if ! rclone copy --no-traverse -- "$OUT" "$BACKUP_RCLONE_REMOTE/uploads/"; then
  echo "[uploads-backup.sh] rclone copy FAILED — off-site copy unsuccessful. Local snapshot is preserved at $OUT." >&2
  echo "[uploads-backup.sh]   operator: investigate rclone connectivity and re-run with \`rclone copy $OUT $BACKUP_RCLONE_REMOTE/uploads/\`" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Local retention prune + SIGKILL-orphan sweep (cluster-3 idiom; see
# db-backup.sh:390-401 for the rationale).
# ---------------------------------------------------------------------------
find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.tar.age' -mtime "+$RETENTION_LOCAL_DAYS" -delete
find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.tar.age.partial.*' -mtime +1 -delete

# ---------------------------------------------------------------------------
# Off-site retention prune (best-effort).
# ---------------------------------------------------------------------------
if ! rclone delete --min-age "${RETENTION_OFFSITE_DAYS}d" -- "$BACKUP_RCLONE_REMOTE/uploads/"; then
  echo "[uploads-backup.sh] WARN: off-site prune failed — local snapshot succeeded, off-site prune is best-effort" >&2
fi

# ---------------------------------------------------------------------------
# Install both markers. PRE_MARKER's mtime was captured BEFORE tar
# started; mv on the same FS preserves that mtime via rename(2), so
# $SCAN_MARKER.mtime ends up at "tar-start time" — the next run's
# find -newer correctly catches every file finalized AT OR AFTER tar
# started, including files that raced the tar walk and weren't in this
# archive (they're picked up by the next backup instead of being
# silently dropped).
#
# $HEALTH_MARKER is a separate file with "now" mtime — consumed by
# bwc-cron-purge as a "uploads-backup ran successfully today" signal.
# Touched on both the skip path (above) and here on the full-backup
# path, so cron-purge always sees a fresh marker on a healthy schedule.
#
# Best-effort: if either mv/touch fails (parent missing, perms drift),
# don't fail the run after a successful backup + copy. Markers are
# observability, not load-bearing.
if ! mv -f -- "$PRE_MARKER" "$SCAN_MARKER" 2>/dev/null; then
  echo "[uploads-backup.sh] WARN: could not install $SCAN_MARKER (parent missing?)" >&2
fi
if ! : > "$HEALTH_MARKER" 2>/dev/null; then
  echo "[uploads-backup.sh] WARN: could not touch $HEALTH_MARKER (parent missing?)" >&2
fi
# PRE_MARKER may or may not be consumed by mv; the EXIT trap will
# clean it up either way via `rm -f -- $PRE_MARKER` (no-op on the
# consumed path).

echo "[uploads-backup.sh] ok (local=${OUT}; size=${new_size}B; offsite=${BACKUP_RCLONE_REMOTE}/uploads/; retention_local=${RETENTION_LOCAL_DAYS}d; retention_offsite=${RETENTION_OFFSITE_DAYS}d)"

exit 0
