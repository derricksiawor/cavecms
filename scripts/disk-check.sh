#!/usr/bin/env bash
# scripts/disk-check.sh — hourly disk-usage gate for the CaveCMS deploy pipeline.
#
# Invoked by systemd: cavecms-disk-check.timer → cavecms-disk-check.service.
# Runs as root with ReadWritePaths=/var/lib/cavecms /var/log/cavecms and
# MemoryMax=64M (per scripts/systemd/cavecms-disk-check.service). All other
# paths are read-only thanks to ProtectSystem=strict.
#
# Behaviour:
#   1. Polls % used on each monitored filesystem (deduped by mount source).
#   2. At >=90% on ANY monitored FS, writes a single-line reason to
#      /var/lib/cavecms/deploy.blocked (preflight.sh:93 consumes this).
#   3. When EVERY monitored FS is <85%, removes the sentinel. The 5-point
#      hysteresis gap prevents flapping when usage oscillates around the
#      threshold (e.g. log rotation freeing 3% then refilling).
#   4. When at least one FS is in the 85-89% band, the sentinel is left
#      as-is (no-op). The script does NOT downgrade-then-upgrade the block;
#      either usage drops below LOW or the operator clears manually.
#
# Operator-sentinel protection:
#   The sentinel is owned by THIS script ONLY when its first 512 bytes
#   begin with the literal "disk-check:" prefix. Anything else — including
#   the EMPTY FILE — is treated as operator-set and will not be overwritten
#   or removed. preflight.sh:98 explicitly accommodates an empty sentinel
#   (`: "${reason:=<empty>}"`), which makes
#     sudo touch /var/lib/cavecms/deploy.blocked
#   a supported manual-block workflow. This script must therefore never
#   auto-clear a zero-byte sentinel.
#
# Filesystems monitored:
#   /             — root FS (small droplets keep everything here)
#   /opt/cavecms      — release tree, uploads, static-pool, incoming tarballs
#   /backup/cavecms   — pre-deploy snapshots + db-backup outputs
# Missing /opt/cavecms or /backup/cavecms is gracefully skipped (fresh-box state
# pre-setup.sh, or pre-first-backup state). Root is always monitored.
#
# Concurrency: a non-blocking flock at /var/lib/cavecms/.disk-check.lock
# rejects a second invocation that overlaps the first (timer + manual
# `systemctl start` race). Skipped runs exit 0 — duplicate work isn't
# a failure. The lock file is a zero-byte regular file intentionally
# left on disk across runs (same pattern as /var/lock/cavecms-deploy.lock
# used by deploy.sh / rollback.sh) — DO NOT delete it as an "operator
# cleanup". Unlinking under a live fd would let a concurrent
# open(O_CREAT) create a fresh inode at the same path and acquire an
# independent lock, defeating mutual exclusion. See the inline INVARIANT
# block at the flock site for the full rationale.
#
# Side effects: only writes / unlinks /var/lib/cavecms/deploy.blocked (plus
# the flock + tempfile inside /var/lib/cavecms). Logs to stdout/stderr —
# systemd journal captures both. The unit's OnFailure=cavecms-alert@%n.service
# handles non-zero exits, so this script carries no alert logic of its own.
#
# Exit codes:
#   0  — check completed (sentinel state may or may not have changed) OR
#        another invocation already holds the lock (skipped, not failed)
#   1  — fatal: required tool missing, df parse failure, write failure,
#        or no monitorable filesystem found
#   2  — usage error (stray arguments)

set -euo pipefail
# inherit_errexit propagates `set -e` into command substitutions —
# without it, `VAR=$(failing | awk)` silently sets VAR to ''. Critical
# for the df parse where '' would be treated as 0% and silently mask a
# full disk. Same idiom as preflight.sh.
shopt -s inherit_errexit
IFS=$'\n\t'

# Sanitize untrusted strings before echoing to operator-facing terminals
# or files. Keeps tab, LF, CR, and printable ASCII (0x20-0x7e) — strips
# every other byte including UTF-8 continuation bytes and ANSI escapes.
sanitize() { tr -cd '\11\12\15\40-\176'; }

# shellcheck disable=SC2154  # rc/BASH_COMMAND populated by the shell inside the trap string.
# $BASH_COMMAND can contain expanded variables — pass through sanitize so a
# pathological value (mount label with control bytes, etc.) can't smuggle
# terminal escapes into the systemd journal.
trap 'rc=$?; cmd=$(printf "%s" "${BASH_COMMAND-}" | sanitize); echo "[disk-check.sh] FAIL (rc=$rc) at line $LINENO: $cmd" >&2' ERR

# Required commands — fail fast with a uniform error message rather than
# letting a missing tool surface mid-gate. Matches the upfront-loop idiom
# used in preflight.sh / deploy.sh / rollback.sh. flock is in util-linux
# (cluster-1 invariant — Ubuntu LTS base).
for cmd in awk df chmod chown flock head mktemp mv printf rm tr; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[disk-check.sh] required command missing: $cmd" >&2
    exit 1
  fi
done

# Reject stray args. Keeps callers honest; an operator typo that adds
# a path argument would otherwise silently no-op against the wrong FS.
if [ $# -ne 0 ]; then
  echo "[disk-check.sh] usage: disk-check.sh (no arguments)" >&2
  exit 2
fi

SENTINEL_DIR=/var/lib/cavecms
SENTINEL=$SENTINEL_DIR/deploy.blocked
LOCK_FILE=$SENTINEL_DIR/.disk-check.lock
# Identifies sentinels written by this script. Exact-leading-segment match
# so an operator could write "disk-check by hand: ..." (note the space)
# without tripping the auto-overwrite logic. The colon is the discriminator.
DISK_CHECK_PREFIX='disk-check:'
# Hysteresis bounds. HIGH=block threshold, LOW=clear threshold. The gap
# (HIGH - LOW = 5 points) is the minimum free-space recovery before the
# gate auto-clears. Smaller gaps cause flapping; larger gaps risk a
# stuck block when usage hovers in the band.
HIGH=90
LOW=85

# Cluster-1 invariant: setup.sh creates $SENTINEL_DIR mode 2770
# root:cavecmsstate (cluster-3 cohesive audit changed this from 750 root:cavecms
# to enable cavecms-user backup scripts to write lock/marker files here,
# with the dedicated cavecmsstate group scoping write access AWAY from
# www-data which is in group cavecms for nginx). Without the directory we
# can't write the sentinel — refuse rather than silently fail later.
if [ ! -d "$SENTINEL_DIR" ]; then
  echo "[disk-check.sh] $SENTINEL_DIR missing — run scripts/setup.sh first" >&2
  exit 1
fi

# Symlink prechecks: refuse to operate against a $SENTINEL or $LOCK_FILE
# that is a symlink. Within the cluster-3 trust model (2770 root:cavecmsstate
# on /var/lib/cavecms, so root + cavecmsstate-group members — currently just the
# `cavecms` user — can plant, write, AND truncate files) this is
# defence-in-depth: it closes TOCTOU windows where an attacker holding
# the cavecms uid could redirect operations into other writable paths via
# a symlink.
#
# Particular concern for $LOCK_FILE: `exec 9>$LOCK_FILE` would otherwise
# follow a symlink and O_TRUNC the target — e.g. a symlink at
# .disk-check.lock pointing to /var/lib/cavecms/deploy.blocked would let a
# cavecms-group user truncate the sentinel via this script's privilege.
for f in "$SENTINEL" "$LOCK_FILE"; do
  if [ -L "$f" ]; then
    echo "[disk-check.sh] refusing: $f is a symlink (expected regular file or absent)" >&2
    exit 1
  fi
done

# Non-blocking advisory lock against a concurrent invocation (timer +
# manual `systemctl start` race). Holding the lock for the full state
# machine prevents an interleaving where one process reads "no sentinel"
# and another writes one between the read and the no-op decision.
#
# IMPORTANT INVARIANT — DO NOT REORDER:
#   The `exit 0` on flock contention (below) MUST happen BEFORE the EXIT
#   trap is installed. Otherwise the losing process's EXIT trap would run
#   while the winner still holds the lock, and an opportunity to unlink
#   the lock file mid-run opens up. Today the trap is installed AFTER the
#   contention exit (see line 141 vs line 138) and the trap deliberately
#   does NOT touch $LOCK_FILE — both decisions are load-bearing.
#
# fd 9 is conventional for advisory locks; release is automatic on
# process exit (no explicit `flock -u` needed). The lock file itself is
# intentionally left on disk across runs — consistent with
# deploy.sh:159 / rollback.sh:128 which both keep /var/lock/cavecms-deploy.lock
# in place. Unlinking a lock file under a live fd would let a concurrent
# `open(O_CREAT)` create a fresh inode at the same path and acquire a
# second independent lock, defeating mutual exclusion.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[disk-check.sh] another disk-check holds $LOCK_FILE — skipping this tick"
  exit 0
fi

# Tempfile via mktemp uses O_CREAT|O_EXCL, so it refuses to follow an
# attacker-planted symlink. Constrains the name pattern to our dir + a
# random suffix; ReadWritePaths permits the write.
TMPFILE=$(mktemp "${SENTINEL_DIR}/.disk-check.tmp.XXXXXX")
# Trap intentionally does NOT clean $LOCK_FILE (see invariant block
# above). It only removes the tempfile, which is consumed by mv on the
# write-success path — `rm -f` on a non-existent path is a no-op.
# shellcheck disable=SC2064  # expand TMPFILE now so the trap survives variable scope changes.
trap "rm -f -- \"$TMPFILE\"" EXIT
# Signal traps re-raise the conventional 128+signo exit codes so callers
# (systemd, operator shells) can distinguish abort modes. EXIT trap still
# fires after these — explicit exit ensures the cleanup runs.
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# Per-path df. Calling df once per path lets us validate each result in
# isolation rather than parsing a multi-row table where a single bad row
# (mount label with whitespace, etc) could mis-attribute a percentage to
# the wrong mount. --output=source,pcent is GNU coreutils only — Ubuntu
# LTS ships GNU coreutils, the documented prod baseline.
#
# Single awk pass: pick the last non-empty row, validate the source and
# Use% shape, strip the %, and emit "src<TAB>pct". Awk exits non-zero on
# malformed input so `set -e` / `inherit_errexit` propagates the failure
# back to the caller. Refuses bare "-" source (overlay/btrfs subvolume
# placeholder) — if production ever moves to a setup that reports "-",
# the explicit failure here surfaces the issue rather than silently
# under-monitoring via dedupe collapse.
df_pct() {
  local path="$1"
  LC_ALL=C df --output=source,pcent -- "$path" | awk -v path="$path" '
    NF { src=$1; pct=$NF }
    END {
      if (src == "" || pct == "" || src == "Filesystem") {
        print "[disk-check.sh] df produced no data row for " path > "/dev/stderr"
        exit 1
      }
      if (src == "-") {
        print "[disk-check.sh] df reported placeholder source \"-\" for " path " — update gate to dedupe by mount before deploying on overlay/btrfs" > "/dev/stderr"
        exit 1
      }
      if (src !~ /^\/[A-Za-z0-9_./:-]+$/ && src !~ /^[A-Za-z0-9_.-]+$/) {
        # Use \047 (octal 47 = single quote) to avoid awk-script-quoting hell.
        print "[disk-check.sh] unrecognised df source \047" src "\047 for " path > "/dev/stderr"
        exit 1
      }
      if (pct !~ /^[0-9]+%$/) {
        print "[disk-check.sh] unparseable df Use% \047" pct "\047 for " path > "/dev/stderr"
        exit 1
      }
      sub(/%$/, "", pct)
      printf "%s\t%s\n", src, pct
    }
  '
}

# Build the candidate list. / is the only mandatory target; the others
# may legitimately not exist on a fresh box mid-setup.
candidate_paths=(/)
[ -d /opt/cavecms ] && candidate_paths+=(/opt/cavecms)
[ -d /backup/cavecms ] && candidate_paths+=(/backup/cavecms)

# Collect (source, pct) rows, deduping by mount source. Two monitored
# paths on the same FS (common on small droplets where /opt/cavecms and /
# share a volume) only score once.
declare -A seen_src=()
worst=-1
worst_target=""
all_below_low=1
monitored=0

for path in "${candidate_paths[@]}"; do
  row=$(df_pct "$path")
  # IFS-scoped read splits on the tab from df_pct's awk emit. Bash-native
  # split here removes two awk forks per iteration and the dead numeric
  # re-check those forks required — df_pct already validated pct.
  IFS=$'\t' read -r src pct <<<"$row"
  if [ -n "${seen_src[$src]+x}" ]; then
    continue
  fi
  seen_src[$src]=1
  monitored=$((monitored + 1))
  if [ "$pct" -gt "$worst" ]; then
    worst=$pct
    worst_target=$path
  fi
  if [ "$pct" -ge "$LOW" ]; then
    all_below_low=0
  fi
done

if [ "$monitored" -eq 0 ]; then
  # / always exists, so reaching here means df_pct failed for / — already
  # surfaced on stderr; this branch is a defence-in-depth assertion.
  echo "[disk-check.sh] no monitorable filesystem found" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Sentinel state machine
# ---------------------------------------------------------------------------

# Read any existing sentinel reason — head -c 512 matches preflight.sh:97
# so we see the same content the consumer sees. Strip control bytes /
# trailing whitespace before testing the prefix.
current_reason=""
sentinel_present=0
if [ -f "$SENTINEL" ]; then
  sentinel_present=1
  current_reason=$(head -c 512 "$SENTINEL" | sanitize | tr '\n' ' ' | awk '{sub(/[[:space:]]+$/, ""); print}')
fi

# is_ours returns 0 ONLY when the reason starts with the literal
# "disk-check:" prefix. Returns 1 for empty string AND for any other
# non-prefixed content. An EMPTY sentinel is operator-owned
# (sudo touch /var/lib/cavecms/deploy.blocked is the supported manual-block
# workflow — preflight.sh:98 explicitly handles the empty case).
# The caller handles the no-sentinel case explicitly via $sentinel_present
# BEFORE calling is_ours (see the `sentinel_present -eq 0 || is_ours` and
# `sentinel_present -eq 1 && all_below_low` gates further down).
is_ours() {
  local r="$1"
  [[ "$r" == "${DISK_CHECK_PREFIX}"* ]]
}

# Atomic write into the sentinel. Tempfile (mktemp, O_EXCL-safe) in same
# dir → mv is rename(2), atomic on the same filesystem. Mode 640 root:cavecms
# lets preflight (root) read directly and any cavecms-group member read it
# too — useful for a `cat /var/lib/cavecms/deploy.blocked` diagnostic by the
# deploy user.
write_sentinel() {
  local content="$1"
  printf '%s\n' "$content" > "$TMPFILE"
  chmod 640 "$TMPFILE"
  # Group cavecms is a cluster-1 invariant. If it's missing we have bigger
  # problems but the sentinel is still functional at root:root — fall
  # back without failing.
  if ! chown root:cavecms "$TMPFILE" 2>/dev/null; then
    echo "[disk-check.sh] WARN: chown root:cavecms $TMPFILE failed; sentinel will be root:root" >&2
  fi
  # Re-check the sentinel target right before the rename, defending
  # against an attacker who planted a symlink between the precheck at
  # the top of the script and now. Flock prevents script-internal
  # interleaving; this guards against external cavecms-group manipulation.
  if [ -L "$SENTINEL" ]; then
    echo "[disk-check.sh] refusing: $SENTINEL became a symlink mid-run" >&2
    exit 1
  fi
  mv -f -- "$TMPFILE" "$SENTINEL"
  # mv consumed the tempfile path; the EXIT trap captured the original
  # mktemp path at trap-set time (double-quoted expansion at install
  # time), so its `rm -f` against the now-absent path no-ops on exit.
}

if [ "$worst" -ge "$HIGH" ]; then
  # worst_target is one of the hardcoded candidate paths so it carries no
  # injected bytes. reason composes only literals + integers + the worst
  # path — bounded length ~85 bytes, fits preflight's 512-byte read budget.
  # ASCII-only separator: preflight.sh:84 strips multi-byte UTF-8 (em-dash
  # would become invisible). `--` survives the sanitize filter intact and
  # reads identically in operator logs and `cat $SENTINEL` output.
  reason="${DISK_CHECK_PREFIX} ${worst_target} at ${worst}% -- block threshold ${HIGH}%, clears at <${LOW}%"
  if [ "$sentinel_present" -eq 0 ] || is_ours "$current_reason"; then
    write_sentinel "$reason"
    echo "[disk-check.sh] sentinel set: $reason"
  else
    # Operator-set sentinel (non-empty, no "disk-check:" prefix). Don't
    # overwrite — they have their own reason; ours would erase it.
    # Surface in the journal so operators can correlate and learn the
    # auto-clear convention.
    echo "[disk-check.sh] FS at ${worst}% on ${worst_target} (>=${HIGH}%) — operator-set sentinel present, not overwriting (auto-managed reasons start with '${DISK_CHECK_PREFIX}')"
  fi
elif [ "$sentinel_present" -eq 1 ] && [ "$all_below_low" -eq 1 ]; then
  # Every monitored FS is below LOW% — hysteresis says clear, but only
  # if WE wrote the sentinel. Empty sentinel and operator-set non-empty
  # sentinels both stay until the operator clears them by hand.
  if is_ours "$current_reason"; then
    rm -f -- "$SENTINEL"
    echo "[disk-check.sh] sentinel cleared (max ${worst}% on ${worst_target} < ${LOW}%)"
  else
    echo "[disk-check.sh] all FS below ${LOW}% — operator-set sentinel left as-is (auto-clear only on '${DISK_CHECK_PREFIX}' sentinels)"
  fi
else
  # Healthy paths reaching here:
  #   1. No sentinel and worst < HIGH (nothing to do).
  #   2. Sentinel present, worst in [LOW, HIGH) — hysteresis band, no-op.
  #   3. Sentinel present (operator), worst < HIGH but some FS >= LOW.
  echo "[disk-check.sh] ok (max ${worst}% on ${worst_target}; HIGH=${HIGH}% LOW=${LOW}%; monitored=${monitored})"
fi

exit 0
