#!/usr/bin/env bash
# scripts/prune-static-pool.sh — daily pruner for the CaveCMS static-asset pool.
#
# Invoked by systemd: cavecms-static-prune.timer → cavecms-static-prune.service.
# Runs as the cavecms user with ReadWritePaths=/opt/cavecms/static-pool /var/log/cavecms,
# ProtectSystem=strict, PrivateTmp=true, MemoryMax=128M (per
# scripts/systemd/cavecms-static-prune.service).
#
# Why this script exists:
#   deploy.sh rsyncs every release's .next/static tree INTO the shared pool
#   at /opt/cavecms/static-pool/.next/static/ additively — never deleting old
#   chunks. Nginx aliases /_next/static to that pool. The additive policy
#   means a client browser still holding a stale HTML page can fetch its
#   referenced chunks even after a new release ships. Over time the pool
#   accumulates unreferenced chunks from rolled-off releases; this script
#   reclaims their disk.
#
# Algorithm:
#   1. Build a KEEP set: every relative chunk path referenced by
#        /opt/cavecms/current/.next/static/                   (active release)
#        /opt/cavecms/current/.next/standalone/.next/static/  (standalone copy)
#        AND the same two subpaths under each of the 5 most-recently-touched
#        /opt/cavecms/releases/* directories (matching deploy.sh's keep-last-5
#        rotation at deploy.sh:167-191).
#   2. Walk the pool. For each file:
#        delete iff (NOT in KEEP) AND (ctime older than GRACE_DAYS).
#      ctime — not mtime — because rsync -a preserves source mtime (which
#      can be the CI build time, weeks old) but cannot set ctime from
#      userspace. Newly-rsync'd files always have ctime ≈ now, so the
#      grace gate protects them even if the KEEP set computation is racing
#      a deploy.sh rsync in progress.
#   3. Remove now-empty directories under the pool.
#
# Safety rails:
#   - REFUSE to prune if the KEEP set ends up empty (would wipe the pool).
#     An empty KEEP can only happen when /opt/cavecms/current is dangling AND
#     /opt/cavecms/releases is empty — that's a broken-deploy state, not a
#     normal pruning condition.
#   - REFUSE to prune if /opt/cavecms/static-pool/.next/static is missing or
#     not a directory (pre-first-deploy state — nothing to prune anyway).
#   - The release rotation here MUST match deploy.sh's rotation gate
#     (5 most-recently-touched dirs by mtime). If deploy.sh's KEEP_LAST
#     ever changes, this script's KEEP_LAST must change too — both are
#     hard-coded constants. See deploy.sh:167 for the parent decision.
#
# Concurrency: a non-blocking flock at /var/log/cavecms/.prune-static-pool.lock
# rejects an overlapping invocation (daily timer + manual `systemctl start`
# race). Skipped runs exit 0 — duplicate work isn't a failure. The lock
# file is a zero-byte regular file intentionally left on disk across runs
# (same pattern as /var/lock/cavecms-deploy.lock used by deploy.sh / rollback.sh
# and /var/lib/cavecms/.disk-check.lock used by disk-check.sh) — DO NOT delete
# it as an "operator cleanup". Unlinking under a live fd would let a
# concurrent open(O_CREAT) create a fresh inode at the same path and acquire
# an independent lock, defeating mutual exclusion.
#
# Side effects: writes only to /opt/cavecms/static-pool (deletions) and
# /var/log/cavecms (lock file, tempfiles). Logs to stdout/stderr — systemd
# journal captures both. OnFailure=cavecms-alert@%n.service handles non-zero
# exits; this script carries no alert logic.
#
# Exit codes:
#   0  — prune completed (may have deleted zero files) OR another prune
#        holds the lock (skipped, not failed)
#   1  — fatal: required tool missing, pool missing, KEEP set empty,
#        find failure, etc.
#   2  — usage error (stray arguments)

set -euo pipefail
# inherit_errexit propagates `set -e` into command substitutions —
# without it, a failing `find … | sort > $KEEP` would silently leave the
# tempfile empty, the script would refuse via the KEEP-empty guard
# (acceptable), but losing find errors mid-pipeline is worse than
# explicit failure. Same idiom as disk-check.sh / preflight.sh.
shopt -s inherit_errexit
IFS=$'\n\t'

# Pin collation to byte order. sort and comm must agree on ordering or
# their pairing semantics break: under en_US.UTF-8, glibc's collation
# can treat `_` and `-` as equal at primary weight, so two distinct
# chunk filenames could sort adjacent yet compare unequal to comm,
# producing duplicates or missed matches. systemd hands the unit
# whatever locale the host defaults to; pin LC_ALL=C unconditionally so
# the KEEP-vs-pool comparison is deterministic across hosts and across
# glibc versions. Also makes awk numeric formatting locale-independent.

export LC_ALL=C

# Sanitize untrusted strings before echoing to operator-facing terminals.
# Keep TAB/LF/CR + printable ASCII; strip everything else (including
# multi-byte UTF-8 continuation bytes and ANSI escapes).
sanitize() { tr -cd '\11\12\15\40-\176'; }

# shellcheck disable=SC2154  # rc/BASH_COMMAND populated by the shell inside the trap string.
trap 'rc=$?; cmd=$(printf "%s" "${BASH_COMMAND-}" | sanitize); echo "[prune-static-pool.sh] FAIL (rc=$rc) at line $LINENO: $cmd" >&2' ERR

# Required commands — fail fast with a uniform error message. find -printf
# %P is GNU-only; mapfile is bash-4+; flock is util-linux. All present on
# the Ubuntu LTS baseline.
for cmd in awk comm find flock head mapfile mktemp printf rm sort tr; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    # `command -v` recognises bash builtins (mapfile, printf), so this
    # check fires only when an external is missing — which on a sandboxed
    # cavecms-user invocation usually means a busted release artifact.
    echo "[prune-static-pool.sh] required command missing: $cmd" >&2
    exit 1
  fi
done

# Reject stray args. Keeps callers honest.
if [ $# -ne 0 ]; then
  echo "[prune-static-pool.sh] usage: prune-static-pool.sh (no arguments)" >&2
  exit 2
fi

POOL=/opt/cavecms/static-pool/.next/static
CURRENT=/opt/cavecms/current
RELEASES_DIR=/opt/cavecms/releases
LOCK_FILE=/var/log/cavecms/.prune-static-pool.lock
# KEEP_LAST must match deploy.sh's keep-last-5 rotation (deploy.sh:167-191).
KEEP_LAST=5
# Grace period: files newer than this are kept regardless of KEEP-set
# membership. ctime, not mtime — see header comment for the rationale.
GRACE_DAYS=7

# Pool absent → pre-first-deploy state. Not an error.
if [ ! -d "$POOL" ]; then
  echo "[prune-static-pool.sh] $POOL missing — nothing to prune (pre-first-deploy)"
  exit 0
fi

# Symlink prechecks on $LOCK_FILE. flock's `exec 9>` would otherwise follow
# a symlink and O_TRUNC the target — a cavecms-group attacker (the unit runs
# as the cavecms user, but /var/log/cavecms is cavecms-writable by design) could plant
# .prune-static-pool.lock → /var/log/cavecms/<sensitive>.log and have this
# script truncate it.
if [ -L "$LOCK_FILE" ]; then
  echo "[prune-static-pool.sh] refusing: $LOCK_FILE is a symlink (expected regular file or absent)" >&2
  exit 1
fi

# IMPORTANT INVARIANT — DO NOT REORDER:
#   The `exit 0` on flock contention (below) MUST happen BEFORE the EXIT
#   trap is installed. Otherwise the losing process's EXIT trap would
#   run while the winner still holds the lock, and an opportunity to
#   unlink the lock or tempfile mid-run opens up. Today the trap is
#   installed AFTER the contention exit. Trap intentionally does NOT
#   touch $LOCK_FILE — see disk-check.sh:135-149 for the full rationale.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[prune-static-pool.sh] another prune holds $LOCK_FILE — skipping this tick"
  exit 0
fi

# Tempfiles under /var/log/cavecms (in the unit's ReadWritePaths) — PrivateTmp
# would give us /tmp too, but /var/log/cavecms keeps everything in one cavecms-
# readable place for post-mortem inspection if a prune misbehaves.
# mktemp uses O_CREAT|O_EXCL, so it refuses to follow attacker-planted
# symlinks.
KEEP_FILE=$(mktemp /var/log/cavecms/.prune-keep.XXXXXX)
POOL_FILE=$(mktemp /var/log/cavecms/.prune-pool.XXXXXX)
# shellcheck disable=SC2064  # expand the tempfile names NOW so the trap survives variable scope changes.
trap "rm -f -- \"$KEEP_FILE\" \"$POOL_FILE\"" EXIT
# Signal traps re-raise conventional 128+signo exit codes.
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# ---------------------------------------------------------------------------
# Build the list of release directories to honour: current + 5 most-recent.
# Duplicates (the most-recent-by-mtime in $RELEASES_DIR will usually BE
# the target of $CURRENT) are fine — the KEEP set dedups via sort -u below.
# ---------------------------------------------------------------------------
declare -a keep_dirs=()

# /opt/cavecms/current is a symlink in normal operation. `-d` follows the link
# and only succeeds when the target exists, so a dangling symlink (left
# behind by an aborted deploy) cleanly skips current rather than failing.
if [ -L "$CURRENT" ] && [ -d "$CURRENT" ]; then
  keep_dirs+=("$CURRENT")
fi

# Pick the most-recently-touched K release dirs by mtime. Mirrors
# deploy.sh:182-183's rotation selector — same printf, RS/ORS NUL,
# sort -zrn, awk strip — but INVERTED: deploy.sh uses `tail -zn +6` to
# pick the rotation-OUT set (drop oldest beyond K), we use
# `head -zn "$KEEP_LAST"` to pick the rotation-IN set (keep newest K).
# Both expressions partition the same find output and select the same K
# directories. If deploy.sh's KEEP_LAST or selector ever changes, MIRROR
# the change here (with the head-vs-tail inversion preserved) — both
# must agree on the set or this prune will reclaim chunks deploy.sh
# still considers warm.
if [ -d "$RELEASES_DIR" ]; then
  mapfile -d '' -t recent_releases < <(
    find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@\t%p\0' \
      | sort -zrn \
      | head -zn "$KEEP_LAST" \
      | awk -v RS='\0' -v ORS='\0' '{sub(/^[^\t]+\t/, ""); print}'
  )
  for r in "${recent_releases[@]}"; do
    [ -n "$r" ] || continue
    # Defence in depth: refuse to honour any release path that didn't
    # come from /opt/cavecms/releases/. find with the rooted -mindepth/-maxdepth
    # above can't emit anything else today, but a future refactor of the
    # find could; this gate is cheap and traps that class of regression.
    case "$r" in
      "$RELEASES_DIR"/*) keep_dirs+=("$r") ;;
      *)
        echo "[prune-static-pool.sh] internal: suspicious release path '$r' — refusing" >&2
        exit 1
        ;;
    esac
  done
fi

# ---------------------------------------------------------------------------
# Build the KEEP set: relative chunk paths referenced by any honoured
# release. Two subpaths per release because Next.js standalone output
# duplicates .next/static under .next/standalone/.next/static; deploy.sh
# rsyncs from both into the same pool (deploy.sh:425-431). We honour both
# locations so a release that only ships one of them still seeds KEEP.
# ---------------------------------------------------------------------------
{
  for d in "${keep_dirs[@]}"; do
    for sub in ".next/standalone/.next/static" ".next/static"; do
      if [ -d "$d/$sub" ]; then
        # %P emits paths relative to the find root, so chunks share the
        # same KEY across release directories — that's what makes the
        # KEEP set a true union.
        find "$d/$sub" -type f -printf '%P\n'
      fi
    done
  done
} | sort -u > "$KEEP_FILE"

# Empty KEEP would mean "no monitorable releases" — usually a dangling
# /opt/cavecms/current AND an empty /opt/cavecms/releases. In that state, every
# pool file would be unreferenced and the script would wipe the pool.
# That's wrong: a broken deploy state shouldn't trigger reclamation.
if [ ! -s "$KEEP_FILE" ]; then
  echo "[prune-static-pool.sh] KEEP set empty (no honoured releases found) — refusing to prune" >&2
  exit 1
fi
keep_count=$(wc -l < "$KEEP_FILE")

# ---------------------------------------------------------------------------
# Walk the pool, emit candidate deletions: files older than GRACE_DAYS
# (by ctime — see header) that are NOT in the KEEP set.
#
# Two-pass: first build the sorted pool-file list, then use comm -23 to
# subtract KEEP from it. comm needs both inputs sorted. find -printf %P
# under POOL emits relative paths that share the same key shape as the
# KEEP entries; sort -u gives the canonical ordering both files need.
# ---------------------------------------------------------------------------
find "$POOL" -type f -ctime +"$GRACE_DAYS" -printf '%P\n' | sort -u > "$POOL_FILE"

pool_total=$(wc -l < "$POOL_FILE")

# comm -23 = "lines unique to file1 (pool) not in file2 (keep)" — exactly
# the unreferenced-and-old set we want to reclaim. Reading the result
# back via a while-read loop with NUL-safe semantics would be overkill;
# pool paths are %P-relative, all-ASCII (Next.js chunk filenames are
# [a-zA-Z0-9_./-]). Pass through sanitize as a belt against any future
# Next-asset naming change that introduces non-printable bytes — the
# downstream rm would happily delete them, but the journal log line
# below would otherwise carry control bytes from a tampered filesystem.
deleted=0
while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  # Anchor the relative path back into the pool. Refuse anything that
  # looks like a path-traversal artifact — comm's output should never
  # contain "../" given both inputs were produced by find -printf '%P',
  # but the cost of the check is zero and the cost of missing one would
  # be a write outside POOL.
  case "$rel" in
    */../*|../*|*/..) echo "[prune-static-pool.sh] internal: refusing path '$rel' (traversal-shaped)" >&2; exit 1 ;;
  esac
  target="$POOL/$rel"
  # rm -f: tolerate the file having vanished between the find and the
  # delete (a concurrent deploy.sh rsync might have refreshed it; rsync
  # writes via tmpname+rename which means a brief unlink window).
  rm -f -- "$target"
  deleted=$((deleted + 1))
done < <(comm -23 "$POOL_FILE" "$KEEP_FILE")

# Remove now-empty subdirectories. -mindepth 1 ensures we never `rmdir
# $POOL` itself. `find -delete` implies `-depth` (post-order traversal)
# per find(1), so leaf empties are removed first and parents that
# become empty as a result are visited later in the SAME pass and
# removed too — one invocation handles arbitrary nesting depth.
find "$POOL" -mindepth 1 -type d -empty -delete

# Report what changed. The numbers feed straight into journalctl so the
# operator can correlate pool growth/shrink with deploy frequency.
sanitized_pool=$(printf '%s' "$POOL" | sanitize)
echo "[prune-static-pool.sh] ok (pool=${sanitized_pool}; keep=${keep_count}; aged_candidates=${pool_total}; deleted=${deleted}; releases_honoured=${#keep_dirs[@]})"

exit 0
