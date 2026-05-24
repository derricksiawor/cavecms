#!/usr/bin/env bash
# scripts/rollback.sh — re-target /opt/bwc/current to the last-known-good
# release. Invoked TWO ways:
#
#   1. By deploy.sh after healthz fails:
#        AUTO_ROLLBACK=1 bash $RELEASE_DIR/scripts/rollback.sh [env]
#      deploy.sh holds /var/lock/bwc-deploy.lock when calling — rollback
#      SKIPS its own flock acquisition under AUTO_ROLLBACK=1 (the parent
#      lock keeps a concurrent deploy out). deploy.sh passes the script
#      path from the FAILED-but-unpacked release dir; the script is
#      self-contained so the bad release tree can host it.
#      HEALTHZ_TOKEN is MANDATORY in auto mode — without it the healthz
#      poll cannot distinguish stale-old-process 200s from rolled-back
#      200s and the auto path could silently "succeed" on a still-bad
#      deploy.
#
#   2. By the operator from the shell:
#        sudo bash /opt/bwc/current/scripts/rollback.sh [env]
#      Acquires flock itself. Prompts on /dev/tty when fingerprints
#      differ and optionally restores the pre-deploy DB snapshot via
#      age + mysql.
#
# Usage:
#   rollback.sh                  # production env (default)
#   rollback.sh staging          # staging env
#
# Exit codes:
#   0  — rollback completed; 3 consecutive /healthz 200s (commit-verified
#        when HEALTHZ_TOKEN is set, liveness-only otherwise + warn)
#   1  — rollback refused (no LAST_OK target, schema mismatch without
#        operator confirmation, healthz never recovered, restore failed)
#   2  — usage / precondition error (no current symlink, malformed env)
#   3  — another deploy/rollback is in progress (flock contention)

set -euo pipefail
shopt -s inherit_errexit
IFS=$'\n\t'

# shellcheck disable=SC2154
trap 'rc=$?; echo "[rollback.sh] FAIL (rc=$rc) at line $LINENO: $BASH_COMMAND" >&2' ERR

# Required commands — fail fast with a uniform error message rather
# than letting a missing tool surface mid-rollback (e.g., age uninstalled
# becomes a pipeline failure AFTER the operator has confirmed restore).
for cmd in tar flock mysql gzip gunzip age awk grep readlink runuser pm2 curl basename mktemp stat tr; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[rollback.sh] required command missing: $cmd" >&2
    exit 2
  fi
done

# ---------------------------------------------------------------------------
# Linux + root guards (cluster-1 setup.sh idiom)
# ---------------------------------------------------------------------------
if [ "$(uname -s)" != "Linux" ]; then
  echo "[rollback.sh] Linux-only. Refusing on $(uname -s)." >&2
  exit 2
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "[rollback.sh] Run as root (mysql restore needs DDL privileges, env file rewrite needs root)." >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Argument validation
# ---------------------------------------------------------------------------
ENV_NAME="${1:-production}"
case "$ENV_NAME" in
  production|staging) ;;
  *) echo "[rollback.sh] env must be 'production' or 'staging' (got '$ENV_NAME')" >&2; exit 2 ;;
esac
ENV_FILE="/etc/bwc/env.$ENV_NAME"
if [ ! -f "$ENV_FILE" ]; then
  echo "[rollback.sh] env file missing: $ENV_FILE — run setup.sh first" >&2
  exit 2
fi

# AUTO_ROLLBACK=1 (set by deploy.sh) implies non-interactive. We require
# HEALTHZ_TOKEN in that path so the post-reload poll can verify the
# served `commit` field rather than trusting any 200 (which the bad-but-
# still-draining PM2 worker could emit during the reload window).
#
# Note: HEALTHZ_TOKEN must ALSO be persisted as a non-empty value in
# $ENV_FILE so that the new PM2 worker (which sources $ENV_FILE in the
# runuser subshell below) responds with the verbose /healthz body
# containing the `commit` field. T6 / setup.sh own that persistence; we
# verify it here when AUTO_ROLLBACK=1.
AUTO_ROLLBACK="${AUTO_ROLLBACK:-0}"
if [ "$AUTO_ROLLBACK" = "1" ]; then
  if [ -z "${HEALTHZ_TOKEN:-}" ]; then
    echo "[rollback.sh] AUTO_ROLLBACK=1 requires HEALTHZ_TOKEN in env for commit-verified healthz." >&2
    echo "[rollback.sh]   either set HEALTHZ_TOKEN in $ENV_FILE and re-source, or run interactively." >&2
    exit 2
  fi
  # Refuse if the env file's HEALTHZ_TOKEN ends up empty after shell
  # interpretation — the parent env may have it but the spawned PM2
  # worker won't. We source the file in a SUBSHELL so the test mirrors
  # exactly what `set -a; . "$ENV_FILE"; set +a` will produce inside
  # the bwc subshell at PM2 reload time. Subshell isolation prevents
  # the env file's keys from polluting this script's environment.
  # shellcheck disable=SC1090  # source target is dynamic (production|staging) — intentional.
  if ! ( set -a; . "$ENV_FILE"; set +a; [ -n "${HEALTHZ_TOKEN:-}" ] ); then
    echo "[rollback.sh] AUTO_ROLLBACK=1 but $ENV_FILE yields empty HEALTHZ_TOKEN when sourced — PM2 worker would boot without it" >&2
    exit 2
  fi
fi

# Preconditions
HISTORY_LOG=/opt/bwc/releases-history.log
if [ ! -f "$HISTORY_LOG" ]; then
  echo "[rollback.sh] no $HISTORY_LOG — nothing to roll back to" >&2
  exit 2
fi
if [ ! -L /opt/bwc/current ]; then
  echo "[rollback.sh] /opt/bwc/current is not a symlink — first deploy never landed?" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Mutex
# ---------------------------------------------------------------------------
# When invoked auto from deploy.sh, the parent already holds the lock.
# flock(2) on Linux is per-open-file-description: a child opening a new
# fd via `exec 9<>` produces a SEPARATE OFD and contends with the
# parent → would always exit 3. Skip flock acquisition in that case;
# the parent's lock continues to keep concurrent deploys out for the
# duration of rollback.
LOCK_FILE=/var/lock/bwc-deploy.lock
if [ "$AUTO_ROLLBACK" != "1" ]; then
  exec 9<>"$LOCK_FILE"
  if ! flock -n 9; then
    echo "[rollback.sh] another deploy/rollback holds $LOCK_FILE — refusing" >&2
    exit 3
  fi
fi

# ---------------------------------------------------------------------------
# Resolve current SHA + last-known-good SHA
# ---------------------------------------------------------------------------
CURRENT_TARGET=$(readlink /opt/bwc/current)
CURRENT_SHA=$(basename "$CURRENT_TARGET")
if [[ ! "$CURRENT_SHA" =~ ^[0-9a-f]{7,64}$ ]]; then
  echo "[rollback.sh] current symlink target malformed: $CURRENT_TARGET" >&2
  exit 2
fi

# Find newest "ok" entry that ISN'T the current SHA. History format is
# "<sha> <status> <iso-ts>"; awk iterates and keeps the latest matching
# row (file is append-only, newest at the bottom). $1==current rows are
# skipped so the rollback target is genuinely PRIOR to the current one.
# The "ok" filter ignores rollback-from-<sha> rows (this script's own
# audit entries), so rolling back twice in a row goes back two releases.
LAST_OK_SHA=$(awk -v cur="$CURRENT_SHA" '$2=="ok" && $1!=cur {sha=$1} END{print sha}' "$HISTORY_LOG")
if [ -z "$LAST_OK_SHA" ]; then
  echo "[rollback.sh] no prior 'ok' release in $HISTORY_LOG (current=$CURRENT_SHA)" >&2
  exit 1
fi
LAST_OK_DIR="/opt/bwc/releases/$LAST_OK_SHA"
if [ ! -d "$LAST_OK_DIR" ]; then
  echo "[rollback.sh] rollback target pruned: $LAST_OK_DIR — keep-last-N rotation removed it" >&2
  exit 1
fi
# Confirm the release tree has the artifacts we'll touch.
for needed in .next/standalone/server.js ecosystem.config.cjs db/schema-fingerprint.txt; do
  if [ ! -e "$LAST_OK_DIR/$needed" ]; then
    echo "[rollback.sh] rollback target incomplete: $LAST_OK_DIR/$needed missing" >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# Schema fingerprint compare
# ---------------------------------------------------------------------------
# Helper: read a fingerprint file, return "" if missing OR if the file
# is empty (corrupt write). Using an explicit empty signal rather than
# a string sentinel like "missing" avoids the unlikely-but-real value-
# space collision with a legitimate fingerprint that happens to render
# as that word after whitespace strip.
read_fp() {
  local file="$1"
  if [ -r "$file" ]; then
    tr -d '[:space:]' <"$file"
  fi
}
CUR_FP_FILE="/opt/bwc/releases/$CURRENT_SHA/db/schema-fingerprint.txt"
LAST_FP_FILE="$LAST_OK_DIR/db/schema-fingerprint.txt"
CUR_FP="$(read_fp "$CUR_FP_FILE")"
LAST_FP="$(read_fp "$LAST_FP_FILE")"

DB_RESTORE=0  # set to 1 if we must restore the pre-deploy snapshot

if [ -z "$CUR_FP" ] || [ -z "$LAST_FP" ] || [ "$CUR_FP" != "$LAST_FP" ]; then
  printf '%s\n' "[rollback.sh] schema fingerprint mismatch — current=${CUR_FP:-<missing>}, rollback-target=${LAST_FP:-<missing>}" >&2
  if [ "$AUTO_ROLLBACK" = "1" ]; then
    # Refuse to swap code onto a forward-migrated DB silently — operator
    # must run interactively to confirm the DB-restore step.
    echo "[rollback.sh] AUTO_ROLLBACK=1: refusing to roll back across a schema change without operator confirmation" >&2
    echo "[rollback.sh]   re-run interactively: sudo $0 $ENV_NAME" >&2
    exit 1
  fi
  if [ ! -t 0 ]; then
    echo "[rollback.sh] no TTY for confirmation prompt; re-run interactively" >&2
    exit 1
  fi
  SNAP_FILE="/backup/bwc/pre-deploy/$CURRENT_SHA.sql.age"
  if [ ! -f "$SNAP_FILE" ]; then
    echo "[rollback.sh] pre-deploy snapshot missing: $SNAP_FILE" >&2
    echo "[rollback.sh]   cannot safely roll back across schema change without DB restore" >&2
    exit 1
  fi
  printf '\n' >&2
  echo "[rollback.sh] -------- DB RESTORE PROMPT --------" >&2
  echo "  current SHA:   $CURRENT_SHA (fp ${CUR_FP:-<missing>})" >&2
  echo "  rollback to:   $LAST_OK_SHA (fp ${LAST_FP:-<missing>})" >&2
  echo "  snapshot file: $SNAP_FILE" >&2
  echo "  Restoring will reload the bwc DB to the pre-deploy state." >&2
  printf '\n' >&2
  read -r -p "Restore pre-deploy DB snapshot? (yes/no): " ans </dev/tty
  case "$ans" in
    yes|YES)
      echo "  (cluster-1 convention stores the age private key at /root/.age-identity, mode 0600)" >&2
      read -r -p "Path to age identity file: " AGE_KEY_PATH </dev/tty
      # Strip only TTY noise (\r\n) and leading/trailing whitespace —
      # NOT internal spaces (which could be legitimate path components).
      AGE_KEY_PATH="${AGE_KEY_PATH%$'\r'}"
      AGE_KEY_PATH="${AGE_KEY_PATH#"${AGE_KEY_PATH%%[![:space:]]*}"}"
      AGE_KEY_PATH="${AGE_KEY_PATH%"${AGE_KEY_PATH##*[![:space:]]}"}"
      if [ ! -f "$AGE_KEY_PATH" ]; then
        echo "[rollback.sh] age identity file not found: $AGE_KEY_PATH" >&2
        exit 1
      fi
      # Refuse a permissive identity file. Operators sometimes drop a
      # key in /tmp with default umask — better to fail loud than
      # restore using a key the host considers world-readable. Also
      # require root ownership: root can read anything, so a 0600 key
      # owned by `bwc` is unsafe to trust as the canonical restore key.
      # `stat -c '%a'` GNU stat — Linux guard at top covers portability.
      # `%a` can return 3 OR 4 chars depending on setuid/setgid/sticky
      # bits — take the last 3 to compare just the permission triplet.
      raw_mode=$(stat -c '%a' "$AGE_KEY_PATH")
      key_mode="${raw_mode: -3}"
      key_owner=$(stat -c '%U' "$AGE_KEY_PATH")
      if [ "$key_mode" != "600" ] && [ "$key_mode" != "400" ]; then
        echo "[rollback.sh] age identity file perms ${raw_mode} — must be 0600 or 0400 (ignoring setuid/setgid/sticky bits)" >&2
        exit 1
      fi
      if [ "$key_owner" != "root" ]; then
        echo "[rollback.sh] age identity file owner $key_owner — must be root" >&2
        exit 1
      fi
      DB_RESTORE=1
      ;;
    no|NO|"")
      echo "[rollback.sh] operator declined DB restore — refusing rollback (app would refuse to boot on mismatched fingerprint)" >&2
      exit 1
      ;;
    *)
      echo "[rollback.sh] unrecognized answer '$ans' — refusing rollback" >&2
      exit 1
      ;;
  esac
fi

# ---------------------------------------------------------------------------
# DB restore BEFORE swap. Order matters: if we swap first, $LAST_OK_SHA's
# instrumentation.ts boot-time fingerprint check would refuse to start
# (file expects fingerprint A, DB still has fingerprint B from the bad
# deploy). The bad release is already failing healthz, so traffic is
# effectively halted — the brief window where the bad code's
# loopback connections see the rolled-back schema is acceptable.
# ---------------------------------------------------------------------------
if [ "$DB_RESTORE" = "1" ]; then
  # Pre-flight: verify the mysql defaults file is readable before we
  # touch the age key or stream plaintext SQL. Without this, a missing
  # /etc/bwc/bwc-migrate.cnf surfaces as a mid-pipeline failure with
  # plaintext SQL already buffered through gunzip — diagnosable, but
  # the error message is "Access denied; using password: NO" which
  # mis-leads the operator. Fail-fast here.
  if [ ! -r /etc/bwc/bwc-migrate.cnf ]; then
    echo "[rollback.sh] /etc/bwc/bwc-migrate.cnf not readable — DDL credentials missing, cannot restore" >&2
    exit 1
  fi
  echo "[rollback.sh] restoring DB snapshot from $SNAP_FILE..." >&2
  # Snapshot format contract (must match deploy.sh's writer):
  #   mysqldump → gzip → age encrypt → <sha>.sql.age
  # so the rollback path is:
  #   age decrypt → gunzip → mysql
  # If the order in deploy.sh is ever reversed (age over gunzip output
  # vs over raw SQL), this decrypt pipeline produces nothing parseable
  # and mysql exits 1 with a cryptic syntax error. PIPESTATUS diagnoses
  # which stage failed.
  #
  # set -o pipefail (from set -euo) + `if !`: if any of age / gunzip /
  # mysql exits non-zero, the pipeline exit is non-zero and we enter the
  # failure branch. PIPESTATUS must be captured into a local array on
  # the VERY NEXT line after the pipeline — any intervening simple
  # command (including `echo`) overwrites it.
  if ! age --decrypt -i "$AGE_KEY_PATH" "$SNAP_FILE" | gunzip | mysql --defaults-extra-file=/etc/bwc/bwc-migrate.cnf bwc; then
    pipestatus=("${PIPESTATUS[@]}")
    echo "[rollback.sh] DB restore FAILED — DB may be in an inconsistent state. Manual recovery required." >&2
    # Force space-separated join regardless of IFS=$'\n\t' so the
    # PIPESTATUS triple lands on one operator-readable line.
    printf '[rollback.sh]   PIPESTATUS (age|gunzip|mysql) = %s %s %s\n' \
      "${pipestatus[0]:-?}" "${pipestatus[1]:-?}" "${pipestatus[2]:-?}" >&2
    exit 1
  fi
  echo "[rollback.sh] DB restore ok" >&2
fi

# ---------------------------------------------------------------------------
# Atomically update env file (BWC_COMMIT, BWC_RELEASE_TS) so a future
# pm2 resurrect (system reboot) brings up the rolled-back SHA, and the
# PM2 --update-env reload below picks them up immediately.
# mktemp + register-trap-IMMEDIATELY-after sequence: any signal between
# mktemp and the trap registration would otherwise leak the temp file.
# ---------------------------------------------------------------------------
NOW_ISO=$(date -u +%FT%TZ)
ENV_TMP=$(mktemp "/etc/bwc/.env.$ENV_NAME.rollback.XXXXXX")
# shellcheck disable=SC2064
trap "rm -f '$ENV_TMP'" EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
chmod 640 "$ENV_TMP"
chown root:bwc "$ENV_TMP"
# awk substitution; sed is project-banned (project standards #0.15).
# `seen_*` flags allow the END block to append a missing key rather
# than silently dropping the substitution — guards against a future
# setup.sh template that omits these keys.
awk -v sha="$LAST_OK_SHA" -v ts="$NOW_ISO" '
  /^BWC_COMMIT=/      { print "BWC_COMMIT=" sha; seen_commit=1; next }
  /^BWC_RELEASE_TS=/  { print "BWC_RELEASE_TS=" ts; seen_ts=1; next }
  { print }
  END {
    if (!seen_commit) print "BWC_COMMIT=" sha
    if (!seen_ts)     print "BWC_RELEASE_TS=" ts
  }
' "$ENV_FILE" > "$ENV_TMP"
# Verify both substitutions made it into the new file.
if ! grep -q "^BWC_COMMIT=$LAST_OK_SHA\$" "$ENV_TMP"; then
  echo "[rollback.sh] env rewrite did not produce BWC_COMMIT=$LAST_OK_SHA in $ENV_FILE" >&2
  exit 1
fi
if ! grep -q "^BWC_RELEASE_TS=$NOW_ISO\$" "$ENV_TMP"; then
  echo "[rollback.sh] env rewrite did not produce BWC_RELEASE_TS=$NOW_ISO in $ENV_FILE" >&2
  exit 1
fi
# Atomic rename on the same filesystem (/etc/bwc) — mode + owner from
# the temp file survive. ACLs and xattrs are NOT preserved (mv writes
# a new inode). Cluster-1's env files have no ACLs, so this is fine.
mv -f "$ENV_TMP" "$ENV_FILE"

# ---------------------------------------------------------------------------
# Atomic symlink swap
# ---------------------------------------------------------------------------
ln -sfn "$LAST_OK_DIR" /opt/bwc/current

# ---------------------------------------------------------------------------
# PM2 reload — runuser (cluster-1 idiom from setup.sh's PM2-runuser block) rather than
# sudo, to bypass PAM's PATH reset and skip the per-call audit entry.
# Positional args avoid interpolating $ENV_FILE / $PM2_BIN / $ECO into
# a sh -c string (single-quote injection if any ever gain a quote).
# ---------------------------------------------------------------------------
PM2_BIN="$(command -v pm2)"
if [ -z "$PM2_BIN" ]; then
  echo "[rollback.sh] pm2 not in root's PATH — install pm2 globally or symlink into /usr/local/bin" >&2
  exit 1
fi
ECO="/opt/bwc/current/ecosystem.config.cjs"
# shellcheck disable=SC2016  # $1/$2/$3 are positional args for the inner bash; intentional no-expansion in parent.
runuser -u bwc -- bash -c '
  set -a
  . "$1"
  set +a
  "$2" startOrReload "$3" --update-env
' _ "$ENV_FILE" "$PM2_BIN" "$ECO"
# pm2 save persists ~bwc/.pm2/dump.pm2 for `pm2 resurrect` on system
# reboot. If save fails (e.g., disk full on /home/bwc), the running
# state is still correct — but the next reboot would bring up the bad
# SHA. Treat failure as fatal so the operator addresses the underlying
# cause (and the history-log audit row is NOT written until success,
# keeping the audit trail honest about what's durable).
if ! runuser -u bwc -- "$PM2_BIN" save >/dev/null; then
  echo "[rollback.sh] pm2 save failed — running state is rolled back but resurrect-on-reboot is stale" >&2
  echo "[rollback.sh]   investigate: ls -lh /home/bwc/.pm2/ ; df -h /home/bwc" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Healthz gate — 3 consecutive 200s, ~60s wall-clock budget. Cluster-1
# ecosystem is fork mode (instances:1) so startOrReload does stop→start
# with a brief ECONNREFUSED window. The OLD PM2 worker cannot serve a
# 200 once stopped, so a consecutive-200 streak implies the NEW process
# is up. Commit-match verification is REQUIRED when HEALTHZ_TOKEN is
# set, and AUTO_ROLLBACK=1 callers must set it (enforced above).
# Without token, liveness-only — log a WARN so the operator knows the
# guarantee is reduced.
#
# Wall-clock deadline rather than a fixed iteration count: each iter
# costs up to ~3s (curl --max-time 2 + sleep 1), so `for _ in $(seq 1 60)`
# would actually span 60-180s. SECONDS-based bound keeps the wall budget
# honest at ~60s.
#
# Token is passed via `curl -K -` (config-file from stdin) instead of
# -H "Authorization: Bearer $TOKEN" so the token does not appear in
# /proc/<pid>/cmdline during the poll window.
# ---------------------------------------------------------------------------
HEALTHZ_URL="http://127.0.0.1:3040/healthz"
HAS_TOKEN=0
if [ -n "${HEALTHZ_TOKEN:-}" ]; then
  HAS_TOKEN=1
else
  echo "[rollback.sh] WARN: HEALTHZ_TOKEN unset — healthz check is liveness-only (cannot verify commit)" >&2
fi

# Parse the JSON commit field tolerantly. The healthz contract emits
# "commit":"<sha>" (no extra fields embedding the substring). Allow
# optional whitespace after the colon for future formatting changes.
# Fall back to jq if present; cluster-1 setup.sh doesn't install jq so
# the grep path is the production code path.
extract_commit() {
  local body="$1"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$body" | jq -r '.commit // empty' 2>/dev/null
  else
    printf '%s' "$body" | grep -oE '"commit"[[:space:]]*:[[:space:]]*"[0-9a-f]{7,64}"' \
      | head -1 \
      | grep -oE '[0-9a-f]{7,64}'
  fi
}

ok=0
HEALTHZ_DEADLINE=$((SECONDS + 60))
while [ "$SECONDS" -lt "$HEALTHZ_DEADLINE" ]; do
  if [ "$HAS_TOKEN" = "1" ]; then
    body=$(printf 'header = "Authorization: Bearer %s"\n' "$HEALTHZ_TOKEN" \
      | curl -fsS --max-time 2 --connect-timeout 1 -K - "$HEALTHZ_URL" 2>/dev/null \
      || true)
    if [ -n "$body" ] && [ "$(extract_commit "$body")" = "$LAST_OK_SHA" ]; then
      ok=$((ok+1))
    else
      ok=0
    fi
  else
    if curl -fsS --max-time 2 --connect-timeout 1 -o /dev/null "$HEALTHZ_URL" 2>/dev/null; then
      ok=$((ok+1))
    else
      ok=0
    fi
  fi
  if [ "$ok" -ge 3 ]; then break; fi
  sleep 1
done
if [ "$ok" -lt 3 ]; then
  echo "[rollback.sh] healthz did not reach 3 consecutive 200s within 60s — rolled-back release is also unhealthy" >&2
  echo "[rollback.sh]   diagnose: runuser -u bwc -- pm2 logs bwc --lines 100 && curl -i $HEALTHZ_URL" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Audit-log entry. Status `rollback-from-<sha>` is awk-FS-stable (no
# whitespace) so deploy.sh's `$2=="ok"` filter correctly skips this row
# when looking for the next rollback target. Defensive newline check:
# if the previous entry lacked a trailing newline (manual edit
# pathology), the append would collide on the same line.
# ---------------------------------------------------------------------------
if [ -s "$HISTORY_LOG" ] && [ "$(tail -c1 "$HISTORY_LOG")" != $'\n' ]; then
  printf '\n' >> "$HISTORY_LOG"
fi
echo "$LAST_OK_SHA rollback-from-$CURRENT_SHA $NOW_ISO" >> "$HISTORY_LOG"

echo "[rollback.sh] ok — current is now $LAST_OK_SHA (env=$ENV_NAME, db_restore=$DB_RESTORE)"
exit 0
