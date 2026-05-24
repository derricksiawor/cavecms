#!/usr/bin/env bash
# scripts/deploy.sh — production deploy orchestrator. Invoked by CI (or
# an operator with a hand-placed artifact) AFTER CI has scp'd
# /opt/bwc/incoming/<sha>.tar.zst onto the droplet.
#
# Flow:
#   1. flock /var/lock/bwc-deploy.lock (mutex vs concurrent deploy/rollback)
#   2. Rotate /opt/bwc/releases/ keeping the last 5
#   3. tar --use-compress-program=zstd -xf incoming → releases/<sha>/
#   4. ln -sfn /etc/bwc/env.<env> $RELEASE_DIR/.env.local (audit trail)
#   5. bash $RELEASE_DIR/scripts/preflight.sh <sha>
#   6. Pre-deploy mysqldump → gzip → age encrypt → /backup/bwc/pre-deploy/<sha>.sql.age
#      (writer order matches rollback.sh's reader)
#   7. node migrator-bundle/run.js (uses DATABASE_MIGRATOR_URL from env file)
#   8. Verify $RELEASE_DIR/db/schema-fingerprint.txt matches the
#      schema_fingerprint table row written by the migrator
#   9. Atomically rewrite /etc/bwc/env.<env> with BWC_COMMIT + BWC_RELEASE_TS
#  10. rsync .next/static into /opt/bwc/static-pool (additive — preserves
#      old hashed chunks for clients still on the previous bundle)
#  11. Atomic symlink swap: ln -sfn $RELEASE_DIR /opt/bwc/current
#  12. PM2 startOrReload via runuser bwc (cluster-1 idiom, NOT sudo)
#  13. Healthz poll: 3 consecutive 200s, ~60s wall-clock budget, body
#      `commit` field must equal $SHA when HEALTHZ_TOKEN set
#  14. On healthz fail: invoke rollback.sh with AUTO_ROLLBACK=1
#  15. PM2 save (durable across reboot)
#  16. Append "<sha> ok <iso>" to /opt/bwc/releases-history.log
#  17. First-deploy ONLY: systemctl start bwc-*.timer
#  18. Clean up /opt/bwc/incoming/<sha>.tar.zst
#
# Usage:
#   sudo bash scripts/deploy.sh <git-sha> [production|staging]
#
# Env vars consumed:
#   ALLOW_CONTRACT=1   forwarded to preflight (acknowledge destructive migration)
#   HEALTHZ_TOKEN      MUST be set in /etc/bwc/env.<env-name>; deploy
#                      refuses without it so the post-reload commit
#                      verification works AND so auto-rollback's
#                      mandatory token check passes.
#
# Exit codes:
#   0  — deploy succeeded; /healthz emitted 3 consecutive 200s with
#        commit==<sha> when HEALTHZ_TOKEN is set, liveness-only with
#        WARN otherwise (HEALTHZ_TOKEN is REQUIRED, so this branch is
#        unreachable in normal operation)
#   1  — deploy refused or failed past the snapshot point (rollback may
#        have been attempted; check log for "ROLLBACK" lines)
#   2  — usage / precondition error (no artifact, malformed sha, bad env)
#   3  — another deploy/rollback is in progress (flock contention)

set -euo pipefail
shopt -s inherit_errexit
IFS=$'\n\t'

# shellcheck disable=SC2154
trap 'rc=$?; echo "[deploy.sh] FAIL (rc=$rc) at line $LINENO: $BASH_COMMAND" >&2' ERR

# ---------------------------------------------------------------------------
# Linux + root guards
# ---------------------------------------------------------------------------
if [ "$(uname -s)" != "Linux" ]; then
  echo "[deploy.sh] Linux-only. Refusing on $(uname -s)." >&2
  exit 2
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "[deploy.sh] Run as root (mysqldump/migrator need DDL principal; env files require root write)." >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Argument validation
# ---------------------------------------------------------------------------
if [ $# -lt 1 ]; then
  echo "[deploy.sh] usage: deploy.sh <git-sha> [production|staging]" >&2
  exit 2
fi
SHA="$1"
if [[ ! "$SHA" =~ ^[0-9a-f]{7,64}$ ]]; then
  echo "[deploy.sh] invalid SHA '$SHA' — must be 7-64 hex chars" >&2
  exit 2
fi
ENV_NAME="${2:-production}"
case "$ENV_NAME" in
  production|staging) ;;
  *) echo "[deploy.sh] env must be 'production' or 'staging' (got '$ENV_NAME')" >&2; exit 2 ;;
esac
ENV_FILE="/etc/bwc/env.$ENV_NAME"
if [ ! -f "$ENV_FILE" ]; then
  echo "[deploy.sh] env file missing: $ENV_FILE — run setup.sh first" >&2
  exit 2
fi

TARBALL="/opt/bwc/incoming/$SHA.tar.zst"
if [ ! -f "$TARBALL" ]; then
  echo "[deploy.sh] artifact missing: $TARBALL — CI should scp it before invoking deploy" >&2
  exit 2
fi
RELEASE_DIR="/opt/bwc/releases/$SHA"
HISTORY_LOG=/opt/bwc/releases-history.log

# HEALTHZ_TOKEN is REQUIRED. Without it the auto-rollback path (which
# this script invokes on healthz fail) refuses, and the operator cannot
# distinguish a stale-old-process 200 from a verified rolled-back 200
# during the reload race.
#
# Two-step: first verify the env file produces a non-empty token when
# shell-sourced (mirrors what the PM2 worker sees inside its runuser
# subshell). Then hydrate the value into THIS script's environment so
# the healthz-poll printf and the auto-rollback exec see it — the
# verification subshell's exports do NOT leak to the parent.
# shellcheck disable=SC1090  # source target is dynamic (production|staging) — intentional.
if ! ( set -a; . "$ENV_FILE"; set +a; [ -n "${HEALTHZ_TOKEN:-}" ] ); then
  echo "[deploy.sh] $ENV_FILE yields empty HEALTHZ_TOKEN — set a 32+ char token before deploying" >&2
  echo "[deploy.sh]   generate: openssl rand -hex 32" >&2
  exit 2
fi
# shellcheck disable=SC1090
HEALTHZ_TOKEN=$( ( set -a; . "$ENV_FILE"; set +a; printf '%s' "${HEALTHZ_TOKEN:-}" ) )
# Trim only \r (TTY line-ending noise on edited env files); preserve
# every other byte so a token containing legitimate whitespace would
# still be passed through verbatim (Bearer tokens by RFC are
# token-grammar so this is unlikely, but defense in depth).
HEALTHZ_TOKEN="${HEALTHZ_TOKEN%$'\r'}"
# Defensive: the env-schema in lib/env.ts requires 32+ chars when set.
# If the file has an oddly-quoted value that survived the non-empty
# check but became junk after shell processing, refuse here.
if [ "${#HEALTHZ_TOKEN}" -lt 32 ]; then
  echo "[deploy.sh] HEALTHZ_TOKEN length ${#HEALTHZ_TOKEN} < 32 after shell expansion of $ENV_FILE" >&2
  exit 2
fi

# Validate the age recipient public key format up front. age accepts a
# line beginning with `-` as a flag — a tampered or zero-byte
# /etc/bwc/backup.pub could inject options into the snapshot pipeline.
# Cluster-1 setup.sh writes one age1-prefixed line; reject anything else.
if [ ! -r /etc/bwc/backup.pub ]; then
  echo "[deploy.sh] /etc/bwc/backup.pub not readable — age recipient missing" >&2
  exit 2
fi
AGE_PUB=$(head -n 1 /etc/bwc/backup.pub | tr -d '[:space:]')
if [[ ! "$AGE_PUB" =~ ^age1[0-9a-z]+$ ]]; then
  echo "[deploy.sh] /etc/bwc/backup.pub: first line is not a valid age1-prefixed recipient" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Required commands — fail fast if any are missing.
# NOTE: sed intentionally absent — banned per project standards #0.15, use awk.
# ---------------------------------------------------------------------------
for cmd in tar zstd flock mysqldump mysql gzip age awk grep find rsync ln mv readlink runuser pm2 node curl systemctl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[deploy.sh] required command missing: $cmd" >&2
    exit 2
  fi
done

# ---------------------------------------------------------------------------
# Mutex
# ---------------------------------------------------------------------------
LOCK_FILE=/var/lock/bwc-deploy.lock
exec 9<>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[deploy.sh] another deploy/rollback holds $LOCK_FILE — refusing" >&2
  exit 3
fi

# ---------------------------------------------------------------------------
# Rotate: keep the most-recently-touched 5 release dirs. Plan template
# uses mtime — close enough to "5 most-recent successful" given history
# log is append-only and failed deploys leave the unpacked tree in place
# (operator can manually clean if needed). NOT a hard guarantee — the
# release immediately prior to current is always retained, which is the
# only one rollback.sh actually needs in the happy path.
# ---------------------------------------------------------------------------
if [ -d /opt/bwc/releases ]; then
  # mapfile + find -print0 to handle any path edge case (release dirs
  # are SHA-named hex so embedded newlines won't occur in practice, but
  # the defensive read avoids relying on that invariant).
  # GNU awk required for RS='\0'/ORS='\0' — mawk handles NUL records
  # differently and would silently break rotation. Cluster-1 ships
  # gawk via Ubuntu defaults; a future minimal image swapping in mawk
  # would need this re-evaluated.
  mapfile -d '' -t old_releases < <(find /opt/bwc/releases -mindepth 1 -maxdepth 1 -type d -printf '%T@\t%p\0' \
    | sort -zrn | tail -zn +6 | awk -v RS='\0' -v ORS='\0' '{sub(/^[^\t]+\t/, ""); print}')
  for d in "${old_releases[@]}"; do
    [ -n "$d" ] || continue
    # Defense in depth: refuse to rm anything outside /opt/bwc/releases/.
    case "$d" in
      /opt/bwc/releases/*) rm -rf "$d" ;;
      *) echo "[deploy.sh] rotate refused suspicious path: $d" >&2; exit 1 ;;
    esac
  done
fi

# ---------------------------------------------------------------------------
# Unpack artifact. tar -xf with same-owner is fine when running as root;
# we then chown to bwc:bwc 750 to match cluster-1's expected layout.
# `--no-same-owner` because the tarball was built in CI with whoever's
# uid runs the build runner — don't trust those uids on the droplet.
# ---------------------------------------------------------------------------
# Wipe-then-recreate $RELEASE_DIR so a same-SHA retry from a failed
# prior attempt does not silently merge half-unpacked content.
rm -rf "$RELEASE_DIR"
install -d -m 750 -o bwc -g bwc "$RELEASE_DIR"
# tar hardening: --no-same-owner refuses to honor the tarball's uids
# (CI's runner uid is meaningless on the droplet); --no-same-permissions
# defers to our explicit chmod -R below; --no-overwrite-dir refuses to
# change the mode of $RELEASE_DIR itself from what `install -d` set;
# --no-acls / --no-xattrs / --no-selinux refuse arbitrary metadata that
# a tarball could carry (cluster-1 box uses AppArmor + no ACLs, so any
# such metadata would be unexpected and should be dropped).
if ! tar --use-compress-program=zstd \
       --no-same-owner --no-same-permissions \
       --no-overwrite-dir --no-acls --no-xattrs --no-selinux \
       -xf "$TARBALL" -C "$RELEASE_DIR"; then
  echo "[deploy.sh] tar extract failed for $TARBALL → $RELEASE_DIR" >&2
  rm -rf "$RELEASE_DIR"
  exit 1
fi
chown -R bwc:bwc "$RELEASE_DIR"
chmod -R u=rwX,g=rX,o= "$RELEASE_DIR"

# ---------------------------------------------------------------------------
# .env.local symlink — audit trail only. Next 15 standalone server.js
# does NOT auto-source .env.local at runtime; PM2 reload sources the
# env file directly in the bwc subshell (see PM2 step below). The
# symlink lets an operator running `ls -la $RELEASE_DIR` immediately
# see which env file the release is tied to.
# ---------------------------------------------------------------------------
ln -sfn "$ENV_FILE" "$RELEASE_DIR/.env.local"

# ---------------------------------------------------------------------------
# Preflight — disk + contract + sharp + current/healthz
# ---------------------------------------------------------------------------
# ALLOW_CONTRACT is propagated as-is; preflight refuses destructive
# migrations unless this is set to 1 by the operator.
if ! ALLOW_CONTRACT="${ALLOW_CONTRACT:-0}" bash "$RELEASE_DIR/scripts/preflight.sh" "$SHA"; then
  echo "[deploy.sh] preflight refused the deploy" >&2
  rm -rf "$RELEASE_DIR"
  exit 1
fi

# ---------------------------------------------------------------------------
# Pre-deploy DB snapshot. Format contract is fixed at this writer end
# AND in rollback.sh's reader: mysqldump → gzip → age encrypt. If the
# order changes here, rollback.sh's `age decrypt | gunzip | mysql`
# pipeline produces nothing parseable.
#
# `bwc_backup` user (cluster-1 grant: SELECT+TRIGGER+EVENT+SHOW VIEW+
# LOCK TABLES) covers --routines/--triggers/--events.
#
# MariaDB note: the plan template included --set-gtid-purged=OFF, which
# is MySQL-only. Removed — MariaDB's mysqldump exits 2 on unknown flag.
# --single-transaction + --quick + --skip-lock-tables together give a
# consistent snapshot without blocking writes from the still-running
# release.
# ---------------------------------------------------------------------------
install -d -m 750 -o bwc -g backup /backup/bwc/pre-deploy 2>/dev/null || true
# Snapshot file name pinned to SHA so rollback.sh's
# /backup/bwc/pre-deploy/<current-sha>.sql.age lookup works. On a
# same-SHA retry, the PRIOR snapshot (genuinely pre-deploy) is
# preserved by refusing to overwrite — otherwise the second attempt
# would replace the genuine pre-deploy artifact with a post-migrator
# snapshot, breaking rollback semantics for that SHA.
SNAP_FILE="/backup/bwc/pre-deploy/$SHA.sql.age"
SNAP_TMP="${SNAP_FILE}.partial"
if [ -f "$SNAP_FILE" ]; then
  echo "[deploy.sh] $SNAP_FILE already exists — same-SHA retry would clobber the genuine pre-deploy snapshot; refusing" >&2
  echo "[deploy.sh]   if this is an intentional re-deploy, remove the file manually after confirming you don't need it for rollback" >&2
  exit 1
fi
# Cleanup .partial on any exit path (including signal). Registered
# BEFORE the pipeline so a kill mid-pipe doesn't leave the half-written
# file in /backup/bwc/pre-deploy.
# shellcheck disable=SC2064
trap "rm -f '$SNAP_TMP'" EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
echo "[deploy.sh] writing pre-deploy snapshot to $SNAP_FILE..." >&2
# PIPESTATUS captured on the line IMMEDIATELY after the pipeline,
# before any other simple command can clobber it. AGE_PUB is the
# validated recipient from the up-front age1-prefix check.
if ! mysqldump --defaults-extra-file=/etc/bwc/bwc-backup.cnf \
       --single-transaction --quick --skip-lock-tables \
       --routines --triggers --events bwc \
     | gzip \
     | age -r "$AGE_PUB" > "$SNAP_TMP"; then
  pipestatus=("${PIPESTATUS[@]}")
  echo "[deploy.sh] pre-deploy snapshot FAILED — refusing to migrate without rollback artifact" >&2
  printf '[deploy.sh]   PIPESTATUS (mysqldump|gzip|age) = %s %s %s\n' \
    "${pipestatus[0]:-?}" "${pipestatus[1]:-?}" "${pipestatus[2]:-?}" >&2
  exit 1
fi
mv -f "$SNAP_TMP" "$SNAP_FILE"
# chmod before chown matches the cluster-1 idiom used elsewhere
# (mktemp → trap → chmod → chown); only style consistency.
chmod 640 "$SNAP_FILE"
chown bwc:backup "$SNAP_FILE"

# ---------------------------------------------------------------------------
# Pre-migrate asserts (spec §1.5). Runs BEFORE the migrator. Catches
# conditions that would crash the migration mid-way (orphan
# content_blocks, duplicate (resource_type, old_slug) rows, MariaDB
# version < 10.6). Read-only SELECTs via the bwc app principal — no
# DDL grant needed. Failure here halts BEFORE any DDL executes; the
# pre-deploy snapshot already exists, the old binary keeps serving,
# nothing to roll back.
#
# Invoked as `node --import tsx` via the PM2-reload pattern: runuser
# subshell sources the env file so DATABASE_URL is available without
# leaking the password through the parent shell's process listing or
# the ERR trap's $BASH_COMMAND. The assert script uses mysql2 directly
# (not @/db/client), so it doesn't load @/lib/env or validate other
# secrets — DATABASE_URL is all it needs.
# ---------------------------------------------------------------------------
# Extract DATABASE_URL only — the asserts use raw mysql2 (not @/db/client),
# so they don't need JWT_SECRET / CSRF_SECRET / etc. Mirrors the migrator's
# tight extract-only pattern at line 333; minimises blast radius if anything
# in the child process tree ever auto-reads process.env for unrelated secrets.
# shellcheck disable=SC1090  # ENV_FILE is operator-supplied; existence already validated.
ASSERT_DB_URL=$( ( set -a; . "$ENV_FILE"; set +a; printf '%s' "${DATABASE_URL:-}" ) )
if [ -z "$ASSERT_DB_URL" ]; then
  echo "[deploy.sh] DATABASE_URL missing from $ENV_FILE — required for pre/post-migrate asserts" >&2
  exit 1
fi
echo "[deploy.sh] running pre-migrate asserts..." >&2
if ! ( cd "$RELEASE_DIR" && DATABASE_URL="$ASSERT_DB_URL" runuser -u bwc -- node --import tsx scripts/pre-migrate-asserts.ts ); then
  echo "[deploy.sh] pre-migrate-asserts FAILED — halting before migrator runs" >&2
  echo "[deploy.sh]   no DDL was executed; the old binary keeps serving" >&2
  echo "[deploy.sh]   resolve the assert message (orphan blocks / duplicate redirects / MariaDB < 10.6), then re-deploy" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Run the migrator. The bundle is shipped in the release tarball and
# uses DATABASE_MIGRATOR_URL (bwc_migrator principal with DDL grant).
# Source the env file in a SUBSHELL so the script's own env isn't
# polluted by the keys.
# ---------------------------------------------------------------------------
echo "[deploy.sh] running migrator..." >&2
# shellcheck disable=SC1090
DATABASE_URL=$( ( set -a; . "$ENV_FILE"; set +a; printf '%s' "${DATABASE_MIGRATOR_URL:-}" ) )
if [ -z "$DATABASE_URL" ]; then
  echo "[deploy.sh] DATABASE_MIGRATOR_URL missing from $ENV_FILE" >&2
  exit 1
fi
if [ ! -f "$RELEASE_DIR/migrator-bundle/run.js" ]; then
  echo "[deploy.sh] migrator bundle missing: $RELEASE_DIR/migrator-bundle/run.js — CI build incomplete?" >&2
  exit 1
fi
# Run as bwc — even though migrator credentials come from the env, we
# don't need root for node + tcp connect to 127.0.0.1:3306.
if ! ( cd "$RELEASE_DIR" && DATABASE_URL="$DATABASE_URL" runuser -u bwc -- node migrator-bundle/run.js ); then
  echo "[deploy.sh] migrator FAILED — DB may be in a partial state" >&2
  echo "[deploy.sh]   if the migrator runs each migration in its own transaction, prior migrations are committed" >&2
  echo "[deploy.sh]   /opt/bwc/current still points to the prior release; the running app may now mismatch the DB" >&2
  echo "[deploy.sh]   manual recovery (DB-only, do NOT run rollback.sh — current symlink is still good):" >&2
  echo "[deploy.sh]     age --decrypt -i <age-key> $SNAP_FILE | gunzip | mysql --defaults-extra-file=/etc/bwc/bwc-migrate.cnf bwc" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Post-migrate asserts (spec §1.5). Runs BETWEEN the migrator and the
# fingerprint+symlink steps. Verifies post-migration invariants (9
# checks). Failure halts BEFORE the symlink flip — the schema is now
# ahead of the running binary, but the binary's read path is
# forward-compatible (it ignores columns it doesn't know about).
# Recovery options below.
# ---------------------------------------------------------------------------
echo "[deploy.sh] running post-migrate asserts..." >&2
if ! ( cd "$RELEASE_DIR" && DATABASE_URL="$ASSERT_DB_URL" runuser -u bwc -- node --import tsx scripts/post-migrate-asserts.ts ); then
  echo "[deploy.sh] post-migrate-asserts FAILED — halting before fingerprint+symlink flip" >&2
  echo "[deploy.sh]   migrator already ran; the schema is forward of the running binary" >&2
  echo "[deploy.sh]   /opt/bwc/current still points to the prior release — the running app reads OK (forward-compat)" >&2
  echo "[deploy.sh]   recovery options:" >&2
  echo "[deploy.sh]     1. read the assert message; manually fix the specific invariant; re-deploy" >&2
  echo "[deploy.sh]     2. roll the DB back to the pre-deploy snapshot via rollback.sh interactive:" >&2
  echo "[deploy.sh]          sudo bash $RELEASE_DIR/scripts/rollback.sh $ENV_NAME" >&2
  echo "[deploy.sh]        rollback.sh detects the fingerprint mismatch, prompts for the age key, restores" >&2
  echo "[deploy.sh]        the snapshot, and leaves /opt/bwc/current pointing at the last-known-good release" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Verify schema fingerprint consistency (deferred #8). The build artifact
# contains db/schema-fingerprint.txt computed at CI time over the
# tracked-table column shape. The migrator bundle is expected to also
# populate the schema_fingerprint table row. instrumentation.ts at boot
# compares the two and refuses to start on mismatch — we mirror that
# check here so the deploy fails LOUDLY at deploy time instead of
# silently bouncing the PM2 worker.
# ---------------------------------------------------------------------------
FP_FILE="$RELEASE_DIR/db/schema-fingerprint.txt"
if [ ! -s "$FP_FILE" ]; then
  echo "[deploy.sh] $FP_FILE missing/empty — CI must bake the fingerprint" >&2
  exit 1
fi
expected_fp=$(tr -d '[:space:]' < "$FP_FILE")
# Validate the file content is a hex digest (sha-256 in update-fingerprint.ts
# emits 64 hex chars; accept 32-128 for forward-compat). A garbage file
# whose content rendered as "garbage" would otherwise mismatch the DB
# with a confusing "fingerprint mismatch" message.
if [[ ! "$expected_fp" =~ ^[0-9a-f]{32,128}$ ]]; then
  echo "[deploy.sh] $FP_FILE is not a hex digest — CI build corrupt" >&2
  exit 1
fi
# Query schema_fingerprint table via mysql. bwc_backup has SELECT. Drop
# the `|| true` so a mysql failure (auth, network) surfaces via the ERR
# trap rather than being misreported as "table empty."
actual_fp=$(mysql --defaults-extra-file=/etc/bwc/bwc-backup.cnf -N -B bwc \
  -e 'SELECT fingerprint FROM schema_fingerprint WHERE id = 1' \
  | tr -d '[:space:]')
if [ -z "$actual_fp" ]; then
  echo "[deploy.sh] schema_fingerprint table empty — migrator did not populate the row" >&2
  echo "[deploy.sh]   snapshot is at $SNAP_FILE; restore manually via scripts/rollback.sh if needed" >&2
  exit 1
fi
if [ "$expected_fp" != "$actual_fp" ]; then
  echo "[deploy.sh] schema fingerprint mismatch — file=$expected_fp DB=$actual_fp" >&2
  echo "[deploy.sh]   migrator and CI baseline disagree; refusing to PM2-reload onto drift" >&2
  echo "[deploy.sh]   /opt/bwc/current still points to the prior release; the running app may now mismatch the DB" >&2
  echo "[deploy.sh]   manual recovery (DB-only, do NOT run rollback.sh — current symlink is still good):" >&2
  echo "[deploy.sh]     age --decrypt -i <age-key> $SNAP_FILE | gunzip | mysql --defaults-extra-file=/etc/bwc/bwc-migrate.cnf bwc" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Atomically update env file (BWC_COMMIT + BWC_RELEASE_TS). After this
# point a system reboot brings up PM2 resurrect against the NEW SHA
# even if subsequent steps fail. rollback.sh's same-pattern rewrite
# will reverse it if/when invoked.
# ---------------------------------------------------------------------------
NOW_ISO=$(date -u +%FT%TZ)
ENV_TMP=$(mktemp "/etc/bwc/.env.$ENV_NAME.deploy.XXXXXX")
# Chain ENV_TMP cleanup with the pre-existing SNAP_TMP cleanup so both
# files get scrubbed on any exit path. The prior trap (registered at
# the snapshot block) only knew about SNAP_TMP; without re-registration
# the env_tmp would orphan on a SIGINT here.
#
# Note: by this point SNAP_TMP has already been mv'd to SNAP_FILE (the
# final path). The `rm -f "$SNAP_TMP"` in this chained trap is therefore
# a no-op on the success path — kept for symmetry with the failure path
# (a kill between SNAP_TMP write and the upcoming env-file mv leaves
# both partial files orphaned without it).
# shellcheck disable=SC2064
trap "rm -f '$SNAP_TMP' '$ENV_TMP'" EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
chmod 640 "$ENV_TMP"
chown root:bwc "$ENV_TMP"
awk -v sha="$SHA" -v ts="$NOW_ISO" '
  /^BWC_COMMIT=/      { print "BWC_COMMIT=" sha; seen_commit=1; next }
  /^BWC_RELEASE_TS=/  { print "BWC_RELEASE_TS=" ts; seen_ts=1; next }
  { print }
  END {
    if (!seen_commit) print "BWC_COMMIT=" sha
    if (!seen_ts)     print "BWC_RELEASE_TS=" ts
  }
' "$ENV_FILE" > "$ENV_TMP"
if ! grep -q "^BWC_COMMIT=$SHA\$" "$ENV_TMP"; then
  echo "[deploy.sh] env rewrite did not produce BWC_COMMIT=$SHA" >&2
  exit 1
fi
if ! grep -q "^BWC_RELEASE_TS=$NOW_ISO\$" "$ENV_TMP"; then
  echo "[deploy.sh] env rewrite did not produce BWC_RELEASE_TS=$NOW_ISO" >&2
  exit 1
fi
mv -f "$ENV_TMP" "$ENV_FILE"

# ---------------------------------------------------------------------------
# Static asset pool — additive rsync. Clients still on the old bundle
# may request hashed chunks (.next/static/chunks/<hash>.js) from URLs
# they cached; keeping the pool additive across deploys prevents 404s
# during the transition window. The pool is the nginx-served root for
# /_next/static (see cluster-1 nginx config).
# ---------------------------------------------------------------------------
install -d -m 750 -o bwc -g bwc /opt/bwc/static-pool/.next/static
# Two source trees: Next 15 standalone copies a subset into
# .next/standalone/.next/static; the FULL set is at .next/static (these
# directories are NOT the same when next.config has client-side assets
# Next decided to skip from the standalone copy). Sync both to the
# pool with the FULL set winning on conflict.
if [ -d "$RELEASE_DIR/.next/standalone/.next/static" ]; then
  rsync -a "$RELEASE_DIR/.next/standalone/.next/static/" /opt/bwc/static-pool/.next/static/
fi
if [ -d "$RELEASE_DIR/.next/static" ]; then
  rsync -a "$RELEASE_DIR/.next/static/" /opt/bwc/static-pool/.next/static/
fi
chown -R bwc:bwc /opt/bwc/static-pool/.next/static

# ---------------------------------------------------------------------------
# Atomic symlink swap
# ---------------------------------------------------------------------------
ln -sfn "$RELEASE_DIR" /opt/bwc/current

# ---------------------------------------------------------------------------
# PM2 reload. Same runuser + positional-args pattern as rollback.sh.
# Source env file inside the bwc subshell so PM2's --update-env picks
# up BWC_COMMIT, DATABASE_URL, JWT_SECRET, HEALTHZ_TOKEN, etc.
# ---------------------------------------------------------------------------
PM2_BIN="$(command -v pm2)"
if [ -z "$PM2_BIN" ]; then
  echo "[deploy.sh] pm2 not in root's PATH — install pm2 globally" >&2
  exit 1
fi
ECO="/opt/bwc/current/ecosystem.config.cjs"
# shellcheck disable=SC2016  # $1/$2/$3 are positional args for the inner bash; intentional.
runuser -u bwc -- bash -c '
  set -a
  . "$1"
  set +a
  "$2" startOrReload "$3" --update-env
' _ "$ENV_FILE" "$PM2_BIN" "$ECO"

# ---------------------------------------------------------------------------
# Healthz gate. Mirrors rollback.sh's commit-verified poll: token-only
# path; HEALTHZ_TOKEN is enforced as non-empty above, so the WARN
# fallback is unreachable in normal operation but kept for diagnostic
# clarity. On failure: invoke rollback.sh with AUTO_ROLLBACK=1 (which
# the parent's flock continues to cover — rollback skips its own).
# ---------------------------------------------------------------------------
HEALTHZ_URL="http://127.0.0.1:3040/healthz"

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
  body=$(printf 'header = "Authorization: Bearer %s"\n' "$HEALTHZ_TOKEN" \
    | curl -fsS --max-time 2 --connect-timeout 1 -K - "$HEALTHZ_URL" 2>/dev/null \
    || true)
  if [ -n "$body" ] && [ "$(extract_commit "$body")" = "$SHA" ]; then
    ok=$((ok+1))
  else
    ok=0
  fi
  if [ "$ok" -ge 3 ]; then break; fi
  sleep 1
done

if [ "$ok" -lt 3 ]; then
  echo "[deploy.sh] healthz did not reach 3 consecutive commit-verified 200s — initiating rollback" >&2
  # The unpacked release tree still holds the rollback script. Invoke
  # via AUTO_ROLLBACK=1; rollback's HEALTHZ_TOKEN check passes because
  # we required it above and persisted it in the env file.
  #
  # IMPORTANT: when the failing deploy advanced the schema (migrator
  # succeeded), rollback.sh will detect the fingerprint mismatch
  # between the failed release and the rollback target — and REFUSE
  # under AUTO_ROLLBACK=1 (no TTY for DB-restore confirmation). The
  # site stays on the failing release until the operator runs rollback
  # interactively. The message below makes that explicit.
  if AUTO_ROLLBACK=1 HEALTHZ_TOKEN="$HEALTHZ_TOKEN" bash "$RELEASE_DIR/scripts/rollback.sh" "$ENV_NAME"; then
    echo "[deploy.sh] ROLLBACK ok — current restored to previous release" >&2
  else
    echo "[deploy.sh] ROLLBACK FAILED — SITE IS LIKELY DOWN, /opt/bwc/current and $ENV_FILE both point at the failing release" >&2
    echo "[deploy.sh]   if schema changed in this deploy, AUTO_ROLLBACK refuses without operator DB-restore confirmation" >&2
    echo "[deploy.sh]   recover: sudo bash /opt/bwc/current/scripts/rollback.sh $ENV_NAME  (interactively, will prompt for age key)" >&2
  fi
  exit 1
fi

# ---------------------------------------------------------------------------
# Persist PM2 state — see rollback.sh comment for why this is fatal on
# failure (resurrect would otherwise come back stale on reboot).
# ---------------------------------------------------------------------------
if ! runuser -u bwc -- "$PM2_BIN" save >/dev/null; then
  echo "[deploy.sh] pm2 save failed — running state is correct but resurrect-on-reboot is stale" >&2
  echo "[deploy.sh]   investigate: ls -lh /home/bwc/.pm2/ ; df -h /home/bwc" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Audit log — append AFTER healthz + pm2 save so a row with status "ok"
# only ever appears for a fully-verified deploy. rollback.sh's awk
# filter (`$2=="ok" && $1!=cur`) depends on this invariant.
# ---------------------------------------------------------------------------
if [ -s "$HISTORY_LOG" ] && [ "$(tail -c1 "$HISTORY_LOG")" != $'\n' ]; then
  printf '\n' >> "$HISTORY_LOG"
fi
FIRST_DEPLOY=0
if [ ! -s "$HISTORY_LOG" ] || ! grep -qE '^[0-9a-f]+ ok ' "$HISTORY_LOG"; then
  FIRST_DEPLOY=1
fi
echo "$SHA ok $NOW_ISO" >> "$HISTORY_LOG"

# ---------------------------------------------------------------------------
# First-deploy: activate the systemd timers cluster-1 enabled-but-didn't-
# start. Done now (not in setup.sh) so the timers don't fire alerts on
# a half-provisioned box that never received an app. After this point
# every system reboot resurrects the timers via `Persistent=true` on
# the units cluster-1 installed.
# ---------------------------------------------------------------------------
if [ "$FIRST_DEPLOY" = "1" ]; then
  echo "[deploy.sh] first successful deploy — activating bwc-*.timer units" >&2
  # Enumerate installed bwc-*.timer units and start each individually.
  # The previous `systemctl start 'bwc-*.timer'` literal-glob form
  # returned non-zero on a cherry-picked install where install-systemd.sh
  # hadn't been run (zero matches → "Unit bwc-*.timer not found"), even
  # though `|| WARN` softened the error. Listing first gives a clean
  # silent no-op when there are no units to start.
  timer_units=$(systemctl list-unit-files 'bwc-*.timer' --no-legend 2>/dev/null | awk '{print $1}' | grep -E '^bwc-' || true)
  if [ -n "$timer_units" ]; then
    while IFS= read -r unit; do
      [ -z "$unit" ] && continue
      systemctl start "$unit" || echo "[deploy.sh] WARN: systemctl start $unit returned non-zero" >&2
    done <<< "$timer_units"
  else
    echo "[deploy.sh] no bwc-*.timer units installed — skipping (run install-systemd.sh if backups/cron-purge are expected)" >&2
  fi
fi

# ---------------------------------------------------------------------------
# Clean up the incoming tarball. Preflight measured it for the disk
# gate, so it MUST persist through preflight; cleaning here (after
# success) frees disk for the next deploy.
# ---------------------------------------------------------------------------
rm -f "$TARBALL"

echo "[deploy.sh] ok — $SHA deployed to $ENV_NAME (snapshot=$SNAP_FILE)"
exit 0
