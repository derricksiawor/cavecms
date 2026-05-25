#!/usr/bin/env bash
# scripts/preflight.sh — pre-deploy gate, invoked by scripts/deploy.sh.
#
# Refuses the deploy when ANY of these hold:
#   1. /var/lib/cavecms/deploy.blocked sentinel exists (disk-check.sh writes
#      this at >=90% usage — operator clears manually after pruning).
#   2. Projected disk footprint exceeds free space on EITHER the
#      /opt/cavecms filesystem (release tree + headroom) or the /backup/cavecms
#      filesystem (pre-deploy snapshot landing zone). Many droplet
#      setups put /backup on a separate attached volume — we must check
#      both or mysqldump can fail mid-deploy with no rollback artifact.
#   3. The unpacked release contains a destructive migration (DROP /
#      RENAME / CHANGE / TRUNCATE / MODIFY VARCHAR()) without
#      ALLOW_CONTRACT=1 — forces operator to acknowledge expand/contract.
#  3.5. MariaDB server version is < 10.6 (or not MariaDB at all). The
#       pages-CMS migration (0010_pages_cms.sql) needs ADD CONSTRAINT IF
#       NOT EXISTS + DELETE...RETURNING + online ENUM widening + UNIQUE
#       on STORED generated columns — all 10.6+.
#   4. sharp's native .node binaries link against glibc symbols missing
#      from the running kernel/libc (Ubuntu LTS upgrade window).
#   5. The currently-deployed release is unhealthy (skipped on first
#      deploy when /opt/cavecms/current does not yet exist).
#
# Side effects: NONE. preflight is read-only and idempotent.
# Exit codes:
#   0  — all gates passed
#   1  — a gate refused the deploy (operator action required)
#   2  — usage / precondition error (caller bug)

set -euo pipefail
# inherit_errexit propagates `set -e` into command substitutions —
# without it, `VAR=$(failing_cmd | awk ...)` silently sets VAR to ''
# and the gate downstream undercounts. CRITICAL for the disk math.
shopt -s inherit_errexit
IFS=$'\n\t'

# shellcheck disable=SC2154  # rc and BASH_COMMAND are populated by the shell inside the trap string.
trap 'rc=$?; echo "[preflight.sh] FAIL (rc=$rc) at line $LINENO: $BASH_COMMAND" >&2' ERR

# Required commands — fail fast with a uniform error message rather
# than letting a missing tool surface mid-gate with a less-actionable
# error from the consumer. Matches deploy.sh / rollback.sh idiom.
for cmd in awk grep find curl df du ldd mktemp tr head tail sort; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[preflight.sh] required command missing: $cmd" >&2
    exit 2
  fi
done

# MariaDB client binary: prefer `mariadb` (the canonical name on modern
# Ubuntu where the `mysql` compat symlink may be absent), fall back to
# `mysql`. Refuses if neither is installed — the version gate below
# can't run without one of them.
if command -v mariadb >/dev/null 2>&1; then
  MYSQL_CMD=mariadb
elif command -v mysql >/dev/null 2>&1; then
  MYSQL_CMD=mysql
else
  echo "[preflight.sh] required command missing: mariadb (or mysql compat symlink)" >&2
  echo "[preflight.sh]   fix: apt install mariadb-client" >&2
  exit 2
fi

# 512 MiB headroom over the strict projection. Covers tmp churn, swap
# spillover, log rotation, and a small safety margin against
# concurrent writes from systemd timers running in the deploy window.
BUFFER_KB=524288

# ---------------------------------------------------------------------------
# Argument validation
# ---------------------------------------------------------------------------
if [ $# -lt 1 ]; then
  echo "[preflight.sh] usage: preflight.sh <git-sha>" >&2
  exit 2
fi
SHA="$1"
# Accept short (7) or full (40, or sha256 64) hex shas. Anything else is
# operator error or a path-traversal attempt — refuse both at the boundary
# so every downstream interpolation can assume well-formed input.
if [[ ! "$SHA" =~ ^[0-9a-f]{7,64}$ ]]; then
  echo "[preflight.sh] invalid SHA '$SHA' — must be 7-64 hex chars" >&2
  exit 2
fi
RELEASE_DIR="/opt/cavecms/releases/$SHA"
if [ ! -d "$RELEASE_DIR" ]; then
  echo "[preflight.sh] release dir missing: $RELEASE_DIR" >&2
  exit 2
fi

# Cluster-1 invariant: setup.sh creates /opt/cavecms. If it's missing the
# operator never ran setup.sh and the rest of preflight would silently
# fall back to /opt (or /) — masking a real misconfig. Fail loudly here.
if [ ! -d /opt/cavecms ]; then
  echo "[preflight.sh] /opt/cavecms missing — run scripts/setup.sh first" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Uploads-tree integrity. lib/media/storage.ts's assertSameFs() refuses
# boot in production when any of these dirs is missing — without the
# precheck a first-deploy mistake (operator skipped setup.sh's dir
# block) would PM2-restart-loop until max_restarts: 10 hits permanent
# stop. Catching it here gives the operator the missing-dir hint plus
# the exact setup.sh block to re-run.
# ---------------------------------------------------------------------------
UPLOADS_ROOT_DEFAULT=/opt/cavecms/uploads
for sub in originals variants brochures-private .tmp; do
  d="$UPLOADS_ROOT_DEFAULT/$sub"
  if [ ! -d "$d" ]; then
    echo "[preflight.sh] uploads subdir missing: $d" >&2
    echo "[preflight.sh]   fix: re-run setup.sh's uploads dir block, or run as root:" >&2
    echo "[preflight.sh]     install -d -o cavecms -g cavecms -m 750 $UPLOADS_ROOT_DEFAULT/{originals,variants,brochures-private,.tmp}" >&2
    exit 1
  fi
done

# /backup/cavecms/pre-deploy is the encrypted mysqldump landing zone for
# scripts/deploy.sh's pre-symlink-flip snapshot. Missing → mysqldump
# fails halfway through deploy.sh with a confusing "directory not
# found" rather than a clean abort here.
for d in /backup/cavecms/db /backup/cavecms/uploads /backup/cavecms/pre-deploy; do
  if [ ! -d "$d" ]; then
    echo "[preflight.sh] backup subdir missing: $d" >&2
    echo "[preflight.sh]   fix: re-run setup.sh's /backup/cavecms block, or:" >&2
    echo "[preflight.sh]     install -d -o cavecms -g backup -m 750 /backup/cavecms/{db,uploads,pre-deploy}" >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# Env contract — required secrets must be present in /etc/cavecms/env.production
# BEFORE we let the deploy proceed. lib/env.ts is the trust boundary and
# refuses to boot if any required secret is missing; without this gate, a
# deploy with a stale env file would symlink-flip successfully then crash
# PM2 indefinitely. The only secret we check by name here is the one this
# preflight is responsible for: SECRETS_ENCRYPTION_KEY (added in the AI
# integration). Other secrets (JWT, CSRF, PREVIEW, BROCHURE) have been in
# setup.sh since the project's first deploy — they're either already
# present or the operator has bigger problems.
# ---------------------------------------------------------------------------
ENV_FILE_PROD=/etc/cavecms/env.production
if [ -f "$ENV_FILE_PROD" ]; then
  if ! grep -Eq '^SECRETS_ENCRYPTION_KEY=[A-Za-z0-9+/]{43}=$' "$ENV_FILE_PROD"; then
    echo "[preflight.sh] $ENV_FILE_PROD missing or malformed SECRETS_ENCRYPTION_KEY" >&2
    echo "[preflight.sh]   fix (one-time): add a 44-char base64 line:" >&2
    echo "[preflight.sh]     echo \"SECRETS_ENCRYPTION_KEY=\$(openssl rand -base64 32)\" | sudo tee -a $ENV_FILE_PROD" >&2
    echo "[preflight.sh]   NOTE: rotating this invalidates ALL stored encrypted secrets (currently: ai_config.apiKey)." >&2
    echo "[preflight.sh]   Operators must re-enter their stored secrets via the dashboard after rotation." >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Helper: sanitize untrusted file contents before echoing to an operator
# terminal. Strips control bytes and ANSI escapes so a tampered sentinel
# or migration file can't hijack the terminal or smuggle CSI codes into
# log scrapers.
# ---------------------------------------------------------------------------
sanitize() { tr -cd '\11\12\15\40-\176'; }

# ---------------------------------------------------------------------------
# 1. deploy.blocked sentinel — checked first. The disk-check timer writes
#    this when free space drops below threshold; even if THIS deploy would
#    fit, the box is unhealthy and the operator's attention is required.
# ---------------------------------------------------------------------------
if [ -f /var/lib/cavecms/deploy.blocked ]; then
  # Sentinel content is operator-readable, control-byte stripped, and
  # trimmed of trailing whitespace. Empty file → explicit "<empty>" so
  # the operator doesn't see "reason: " with nothing after it.
  reason=$(head -c 512 /var/lib/cavecms/deploy.blocked | sanitize | tr '\n' ' ' | awk '{sub(/[[:space:]]+$/, ""); print}')
  : "${reason:=<empty>}"
  echo "[preflight.sh] /var/lib/cavecms/deploy.blocked is set — refusing deploy" >&2
  echo "[preflight.sh]   reason: ${reason}" >&2
  echo "[preflight.sh]   to clear: sudo rm /var/lib/cavecms/deploy.blocked  (after pruning to <85%)" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. Disk gates — TWO filesystems matter:
#
#    a. /opt/cavecms        — holds the unpacked release tree (already on disk
#                         when preflight runs — deploy.sh extracted it),
#                         the .tar.zst still sitting in /opt/cavecms/incoming/
#                         <sha> (deploy.sh keeps it through preflight and
#                         only cleans on success), the currently-running
#                         release. Everything already on disk is already
#                         netted out of df-avail, so the gate reserves
#                         space for what's about to LAND in /opt/cavecms next:
#                         that's only BUFFER_KB headroom for log spillover,
#                         tmp churn, etc. The tarball-already-on-disk size
#                         is included for diagnostic transparency in the
#                         failure message, NOT in the required total.
#                         Required: BUFFER_KB.
#    b. /backup/cavecms     — holds the pre-deploy mysqldump (encrypted age
#                         output, deploy.sh writes to pre-deploy/<sha>).
#                         Sized against the LARGEST existing dump across
#                         both /backup/cavecms/db/ and /backup/cavecms/pre-deploy/.
#                         Required: LARGEST_DUMP_KB + BUFFER_KB.
#
#    Splitting these is the difference between "we caught it pre-deploy"
#    and "mysqldump failed at line 12 of deploy.sh, no rollback snapshot
#    exists, /backup is full, operator pages at 03:00."
# ---------------------------------------------------------------------------

# du failures must propagate. `shopt -s inherit_errexit` (set at top)
# ensures `VAR=$(failing_cmd | awk ...)` exits the script instead of
# silently leaving VAR=''. We still do the du calls OUTSIDE pipes so a
# numeric-regex sanity check can catch any other oddity (locale, weird
# du output) and exit loudly rather than producing 0 silently.
artifact_du=$(du -sk "$RELEASE_DIR")
ARTIFACT_KB=$(awk '{print $1}' <<<"$artifact_du")
[[ "$ARTIFACT_KB" =~ ^[0-9]+$ ]] || { echo "[preflight.sh] du returned non-numeric for $RELEASE_DIR" >&2; exit 1; }

TARBALL=/opt/cavecms/incoming/$SHA.tar.zst
TARBALL_KB=0
if [ -f "$TARBALL" ]; then
  tarball_du=$(du -sk "$TARBALL")
  TARBALL_KB=$(awk '{print $1}' <<<"$tarball_du")
  [[ "$TARBALL_KB" =~ ^[0-9]+$ ]] || TARBALL_KB=0
fi

# LARGEST_DUMP_KB (not "latest" — picked by size, not age) is the
# worst-case projection for the next snapshot, which tends to grow with
# the row count of the largest table. Scan BOTH the daily-backup dir
# and the pre-deploy snapshot dir so we don't undercount when the box
# has been running long enough that pre-deploy snapshots are the
# heaviest artifacts on /backup. `find -printf '%s\n'` avoids the
# ARG_MAX limit that a `du -sk *` glob would hit on a long-running box.
#
# Build the dir list explicitly per existence — if we pass a missing
# dir to find, it returns non-zero AND prints to stderr. We want a real
# find failure (EIO, permission) to surface, not a "no such file" on a
# fresh-box pre-deploy/ dir to mask everything.
LARGEST_DUMP_BYTES=0
dump_paths=()
[ -d /backup/cavecms/db ] && dump_paths+=(/backup/cavecms/db)
[ -d /backup/cavecms/pre-deploy ] && dump_paths+=(/backup/cavecms/pre-deploy)
if [ "${#dump_paths[@]}" -gt 0 ]; then
  dump_sizes=$(find "${dump_paths[@]}" -maxdepth 1 -name '*.sql.age' -type f -printf '%s\n')
  if [ -n "$dump_sizes" ]; then
    LARGEST_DUMP_BYTES=$(awk 'BEGIN{m=0} {if ($1+0 > m) m=$1+0} END{print m}' <<<"$dump_sizes")
    [[ "$LARGEST_DUMP_BYTES" =~ ^[0-9]+$ ]] || LARGEST_DUMP_BYTES=0
  fi
fi
LARGEST_DUMP_KB=$(( LARGEST_DUMP_BYTES / 1024 ))

# /opt/cavecms gate: the new release + tarball are already on disk and
# already accounted for in df-avail. We only need to ensure the buffer
# is met — bigger headroom would refuse legitimate deploys.
OPT_REQ_KB=$BUFFER_KB
OPT_AVAIL_KB=$(LC_ALL=C df --output=avail /opt/cavecms | tail -n 1 | tr -d '[:space:]')
[[ "$OPT_AVAIL_KB" =~ ^[0-9]+$ ]] || { echo "[preflight.sh] df returned non-numeric for /opt/cavecms" >&2; exit 1; }
if [ "$OPT_AVAIL_KB" -le "$OPT_REQ_KB" ]; then
  echo "[preflight.sh] insufficient disk on /opt/cavecms: avail=${OPT_AVAIL_KB}KB <= required=${OPT_REQ_KB}KB" >&2
  echo "[preflight.sh]   (already on disk: artifact=${ARTIFACT_KB}KB + tarball=${TARBALL_KB}KB; required=${BUFFER_KB}KB headroom)" >&2
  exit 1
fi

# /backup may not exist on a fresh box (first deploy before any snapshot
# was written). In that case there is no projection to make — db-backup
# timer will create the tree on first run.
if [ -d /backup/cavecms ]; then
  BACKUP_REQ_KB=$(( LARGEST_DUMP_KB + BUFFER_KB ))
  BACKUP_AVAIL_KB=$(LC_ALL=C df --output=avail /backup/cavecms | tail -n 1 | tr -d '[:space:]')
  [[ "$BACKUP_AVAIL_KB" =~ ^[0-9]+$ ]] || { echo "[preflight.sh] df returned non-numeric for /backup/cavecms" >&2; exit 1; }
  if [ "$BACKUP_AVAIL_KB" -le "$BACKUP_REQ_KB" ]; then
    echo "[preflight.sh] insufficient disk on /backup/cavecms: avail=${BACKUP_AVAIL_KB}KB <= required=${BACKUP_REQ_KB}KB" >&2
    echo "[preflight.sh]   (largest_existing_dump=${LARGEST_DUMP_KB}KB + buffer=${BUFFER_KB}KB)" >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 3. Expand/contract gate
#    Greps SQL migrations for irreversible / data-loss patterns. Operator
#    overrides with ALLOW_CONTRACT=1 after confirming the migration is
#    intended. False positives are cheap (re-run with env var); a missed
#    contract is silent data loss.
#
#    Patterns covered:
#      - DROP {COLUMN|TABLE|DATABASE|TRIGGER|PROCEDURE|FUNCTION|VIEW|EVENT|USER|PARTITION}
#      - DROP FOREIGN KEY | DROP PRIMARY KEY | DROP CONSTRAINT
#      - TRUNCATE TABLE
#      - RENAME COLUMN  (MySQL 8 syntax)
#      - CHANGE COLUMN  (MariaDB rename-or-retype)
#      - ALTER COLUMN ... DROP
#      - ALTER TABLE ... DROP (PARTITION|<bare col, no COLUMN keyword>)
#      - MODIFY ... VARCHAR(<n>)   (size change — gate intentionally broad;
#                                   widening is safe in practice, but we
#                                   can't distinguish narrowing without
#                                   the prior schema. Operator acks via env)
#
#    DROP INDEX is intentionally NOT in this list. It's a perf change, not
#    a data-loss change — migrations that idempotently drop-then-recreate
#    indexes should not require ALLOW_CONTRACT, or operators will set the
#    bypass habitually and the gate's point evaporates.
#
#    SQL line comments (-- and #) are stripped before grepping so a
#    commented-out `-- TODO: DROP COLUMN bar` doesn't trip the gate.
#    Block comments (/* */) spanning lines are not stripped (operator
#    convention: don't ship multi-line-commented destructive SQL).
# ---------------------------------------------------------------------------
if [ "${ALLOW_CONTRACT:-0}" != "1" ]; then
  MIGRATIONS_DIR="$RELEASE_DIR/db/migrations"
  if [ -d "$MIGRATIONS_DIR" ]; then
    CONTRACT_RE='DROP[[:space:]]+(COLUMN|TABLE|DATABASE|TRIGGER|PROCEDURE|FUNCTION|VIEW|EVENT|USER|PARTITION|FOREIGN[[:space:]]+KEY|PRIMARY[[:space:]]+KEY|CONSTRAINT)'
    CONTRACT_RE+='|TRUNCATE[[:space:]]+TABLE'
    CONTRACT_RE+='|RENAME[[:space:]]+COLUMN'
    CONTRACT_RE+='|CHANGE[[:space:]]+COLUMN'
    CONTRACT_RE+='|ALTER[[:space:]]+COLUMN[[:space:]]+[^[:space:]]+[[:space:]]+DROP'
    CONTRACT_RE+='|MODIFY[[:space:]]+[^[:space:]]+[[:space:]]+VARCHAR\([0-9]+\)'
    # Keyword-less `ALTER TABLE t DROP col` (with or without backticks).
    # Permissive; will fire on `ALTER TABLE t DROP PARTITION p1` too —
    # already covered above, so this is just defense-in-depth.
    # shellcheck disable=SC2016  # backticks here are literal SQL-identifier quotes, not command substitution.
    CONTRACT_RE+='|ALTER[[:space:]]+TABLE[[:space:]]+[`"]?[a-zA-Z0-9_]+[`"]?[[:space:]]+DROP[[:space:]]+[`"]?[a-zA-Z0-9_]+[`"]?'

    shopt -s nullglob
    SQL_FILES=( "$MIGRATIONS_DIR"/*.sql )
    shopt -u nullglob
    for f in "${SQL_FILES[@]}"; do
      # Strip line comments before checking. awk because sed is project-
      # banned (project standards #0.15). Block comments are not stripped.
      stripped=$(awk '{sub(/--.*$/, ""); sub(/#.*$/, ""); print}' "$f")
      if grep -qiE "$CONTRACT_RE" <<<"$stripped"; then
        echo "[preflight.sh] destructive migration in $f — re-run with ALLOW_CONTRACT=1 to acknowledge" >&2
        # Print only line numbers and matched keyword, NOT the surrounding
        # SQL — a seed-row migration could put a hashed credential or API
        # key on a line near a DROP and leak it to operator logs.
        grep -niE -o "$CONTRACT_RE" <<<"$stripped" | sanitize >&2 || true
        exit 1
      fi
    done
  fi
fi

# ---------------------------------------------------------------------------
# 3.5 MariaDB >= 10.6
#     Migration 0010_pages_cms.sql relies on features added in 10.6:
#       - ADD CONSTRAINT IF NOT EXISTS (MDEV-16745)
#       - DELETE...RETURNING and INSERT...RETURNING
#       - online ENUM widening
#       - UNIQUE INDEX on STORED generated columns
#     scripts/pre-migrate-asserts.ts re-asserts this from the TS side, but
#     surfacing the failure here lets the operator catch it before disk
#     snapshots and migrator side effects start. Read-only SELECT via the
#     cavecms_backup principal — same connect-extra file used for the inline
#     fingerprint check in deploy.sh.
#
#     Regex strips the 5.5.5- legacy MySQL client compat prefix that
#     MariaDB 10.x prepends to VERSION() output (e.g.
#     "5.5.5-10.6.5-MariaDB-..."). The regex also rejects pure MySQL
#     servers, which would fail the migrator anyway but with a less
#     actionable error.
# ---------------------------------------------------------------------------
MYSQL_CNF=/etc/cavecms/cavecms-backup.cnf
if [ ! -r "$MYSQL_CNF" ]; then
  echo "[preflight.sh] $MYSQL_CNF missing or unreadable — required for DB version gate" >&2
  echo "[preflight.sh]   fix: re-run scripts/setup.sh to provision the cavecms_backup principal" >&2
  exit 1
fi
# Mirror db/min-mariadb-version.ts — keep these literals in sync.
# When raising the floor, edit BOTH (TS for the assert script, bash
# here for the preflight gate).
MIN_MARIADB_MAJOR=10
MIN_MARIADB_MINOR=6
# Wrap the failing pipe in `if !` so set -e + pipefail + inherit_errexit
# don't abort the script through the ERR trap before the helpful
# "DB unreachable or credentials wrong" branch can run. Redirect mysql
# stderr to stdout so the operator sees the actual driver error (auth
# failure, connection refused) rather than a silenced one.
DB_VERSION_RAW=""
DB_VERSION_COMMENT=""
if ! DB_VERSION_RAW=$("$MYSQL_CMD" --defaults-extra-file="$MYSQL_CNF" -N -B -e 'SELECT VERSION()' 2>&1); then
  echo "[preflight.sh] could not query SELECT VERSION() via $MYSQL_CNF — DB unreachable or credentials wrong" >&2
  echo "[preflight.sh]   driver said: $(echo "$DB_VERSION_RAW" | sanitize | head -c 200)" >&2
  echo "[preflight.sh]   diagnose: $MYSQL_CMD --defaults-extra-file=$MYSQL_CNF -e 'SELECT 1'" >&2
  exit 1
fi
# @@version_comment is a belt-and-braces discriminator: legitimate
# MariaDB returns "MariaDB Server" here even on hardened distros that
# strip the "-MariaDB" suffix from VERSION(). MySQL returns something
# starting with "MySQL" or "Oracle".
if ! DB_VERSION_COMMENT=$("$MYSQL_CMD" --defaults-extra-file="$MYSQL_CNF" -N -B -e 'SELECT @@version_comment' 2>&1); then
  echo "[preflight.sh] could not query @@version_comment via $MYSQL_CNF" >&2
  exit 1
fi
# Sanitize before any echo to operator stderr — a compromised DB with
# SUPER privileges could craft a value containing ANSI/CSI escapes
# that forge a "passed" line into the deploy log. Hard-cap length to
# prevent log flooding even after sanitisation.
DB_VERSION=$(echo "$DB_VERSION_RAW" | tr -d '[:space:]' | sanitize | head -c 200)
DB_VERSION_COMMENT_SAFE=$(echo "$DB_VERSION_COMMENT" | sanitize | head -c 200)
if [ -z "$DB_VERSION" ]; then
  echo "[preflight.sh] empty VERSION() result via $MYSQL_CNF — DB returned no version string" >&2
  exit 1
fi
# bash regex: capture major.minor in BASH_REMATCH. The =~ is unanchored.
# Primary pattern targets the canonical "X.Y...-MariaDB" suffix MariaDB
# 10.x emits. Fallback path accepts any leading "X.Y" if @@version_comment
# explicitly says MariaDB — covers stripped-suffix distros.
# IMPORTANT: keep this regex byte-for-byte aligned with the prefix-aware
# regex in scripts/pre-migrate-asserts.ts.
DB_VERSION_RE='([0-9]+)\.([0-9]+)[^-]*-MariaDB'
DB_FALLBACK_RE='^(5\.5\.5-)?([0-9]+)\.([0-9]+)'
DB_MAJOR=""
DB_MINOR=""
if [[ "$DB_VERSION" =~ $DB_VERSION_RE ]]; then
  DB_MAJOR="${BASH_REMATCH[1]}"
  DB_MINOR="${BASH_REMATCH[2]}"
elif [[ "$DB_VERSION_COMMENT_SAFE" =~ ^MariaDB ]] && [[ "$DB_VERSION" =~ $DB_FALLBACK_RE ]]; then
  DB_MAJOR="${BASH_REMATCH[2]}"
  DB_MINOR="${BASH_REMATCH[3]}"
else
  echo "[preflight.sh] not running MariaDB (VERSION()=$DB_VERSION, @@version_comment=$DB_VERSION_COMMENT_SAFE); this codebase requires MariaDB >= ${MIN_MARIADB_MAJOR}.${MIN_MARIADB_MINOR}" >&2
  exit 1
fi
if (( DB_MAJOR < MIN_MARIADB_MAJOR )) || (( DB_MAJOR == MIN_MARIADB_MAJOR && DB_MINOR < MIN_MARIADB_MINOR )); then
  echo "[preflight.sh] MariaDB version too old: $DB_VERSION (parsed ${DB_MAJOR}.${DB_MINOR}); need >= ${MIN_MARIADB_MAJOR}.${MIN_MARIADB_MINOR}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 4. sharp glibc compatibility
#    sharp's binary layout shifted in 0.33. Old: node_modules/sharp/build/
#    Release/*.node. New: node_modules/@img/sharp-linux-x64/lib/*.node +
#    @img/sharp-libvips-linux-x64/lib/*.so.*. We scan BOTH so the gate
#    doesn't silently skip on a sharp upgrade.
#
#    ldd executes the program's ELF interpreter, which has historical
#    CVEs around malicious binaries. The release tree is owned cavecms:cavecms
#    750 and is only ever written by deploy.sh extracting a CI-trusted
#    tarball — within that trust model ldd is acceptable. If the
#    tarball-signing chain ever weakens, swap ldd for a `readelf -d`
#    + LD_TRACE_LOADED_OBJECTS=1 invocation pattern.
# ---------------------------------------------------------------------------
SHARP_ROOT="$RELEASE_DIR/.next/standalone/node_modules"
if [ -d "$SHARP_ROOT" ]; then
  # Write find's output to a temp file so a find error (permission, EIO)
  # is surfaced via its exit code instead of being swallowed by the
  # process-substitution that `mapfile < <(...)` would set up. The release
  # tree is owned cavecms:cavecms 750 and preflight runs as root via deploy.sh —
  # any find error here is anomalous and worth failing on.
  SHARP_LIST=$(mktemp)
  # Cleanup on every exit path. The signal traps explicitly re-raise the
  # exit code so deploy.sh sees a non-zero status (and won't proceed)
  # when the operator Ctrl-C's preflight. Without the explicit `exit N`
  # the signal traps would clean up and then continue the script, ending
  # with an accidental `exit 0` that masks the abort.
  # shellcheck disable=SC2064  # expand SHARP_LIST now so the trap survives variable scope changes.
  trap "rm -f '$SHARP_LIST'" EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP
  if ! find "$SHARP_ROOT" \
       \( -path '*/sharp/build/Release/*.node' \
          -o -path '*/@img/sharp-*/lib/*.node' \
          -o -path '*/@img/sharp-libvips-*/lib/*.so*' \) \
       -type f > "$SHARP_LIST"; then
    echo "[preflight.sh] find failed scanning $SHARP_ROOT for sharp binaries" >&2
    exit 1
  fi
  mapfile -t SHARP_BINS < "$SHARP_LIST"
  for bin in "${SHARP_BINS[@]}"; do
    [ -r "$bin" ] || continue
    ldd_out=$(ldd "$bin" 2>&1 || true)
    # ldd on a non-ELF / corrupt / unreadable binary may emit nothing —
    # the subsequent grep silently passes. Fail closed: any sharp binary
    # we cannot inspect is a signal to stop, not to proceed.
    if [ -z "$ldd_out" ]; then
      echo "[preflight.sh] ldd produced no output for $bin — refusing deploy" >&2
      exit 1
    fi
    if grep -qE '(not found|undefined symbol|not a dynamic executable)' <<<"$ldd_out"; then
      echo "[preflight.sh] sharp glibc / linkage issue on $bin" >&2
      grep -E '(not found|undefined symbol|not a dynamic executable)' <<<"$ldd_out" | sanitize >&2 || true
      exit 1
    fi
  done
fi

# ---------------------------------------------------------------------------
# 5. /healthz of currently-deployed release
#    Skipped on first deploy when /opt/cavecms/current isn't a symlink yet.
#    --fsS makes curl fail on 4xx/5xx and stay silent on success.
#    Port 3040 matches ecosystem.config.cjs (cluster 1, single fork).
#    Body shape is NOT validated here — that's deploy.sh's commit==$SHA
#    poll on the NEW release. preflight only asks "is current healthy
#    enough to swap out from under?"
# ---------------------------------------------------------------------------
if [ -L /opt/cavecms/current ]; then
  # No X-Real-IP header — it's only meaningful when an upstream proxy
  # sets it, and /healthz makes no auth decision off it (verified in
  # app/healthz/route.ts). Sending one from a loopback caller would
  # only confuse rate-limiter accounting on a future middleware change.
  if ! curl -fsS --max-time 3 --connect-timeout 2 \
       -o /dev/null \
       http://127.0.0.1:3040/healthz; then
    echo "[preflight.sh] current release unhealthy — refusing to deploy on top of a broken process" >&2
    echo "[preflight.sh]   diagnose: curl -i http://127.0.0.1:3040/healthz && pm2 logs cavecms --lines 50" >&2
    exit 1
  fi
fi

echo "[preflight.sh] ok ($SHA: artifact=${ARTIFACT_KB}KB, tarball=${TARBALL_KB}KB, largest_dump=${LARGEST_DUMP_KB}KB, opt_free=${OPT_AVAIL_KB}KB, backup_free=${BACKUP_AVAIL_KB:-na}KB)"
exit 0
