// Shared status-file path allowlist for the update + backup + restore
// progress engines.
//
// The status-file path is taken from an env var (e.g.
// `CAVECMS_UPDATE_STATUS_PATH` / `CAVECMS_BACKUP_STATUS_PATH`). Without
// restriction, a hostile env would let a status writer overwrite arbitrary
// files (e.g. /etc/cron.d/*). We hard-allowlist the parent directory to one
// of `/var/lib/cavecms/`, `<CAVECMS_STATE_DIR>/`, the per-platform temp dir
// (dev/test only), or the legacy install-cwd-derived `.cavecms-state` dir.
//
// This module is filename-agnostic — extracted from lib/updates/statusFile.ts
// so the backup/restore status modules reuse the exact same discipline.

import { resolve } from 'node:path'
import { tmpdir } from 'node:os'

const ALLOWED_SYSTEM_DIR_PREFIXES: readonly string[] = ['/var/lib/cavecms/']

/**
 * Per-install state directory. Set by the CLI (`create-cavecms` writes
 * `CAVECMS_STATE_DIR=<install dir>/.cavecms-state` into env.production),
 * provisioned at install time as the same user that owns the install.
 *
 * Legacy installs (upgraded in place from pre-0.1.27 releases) won't have
 * CAVECMS_STATE_DIR stamped. For those we derive a sibling `.cavecms-state`
 * next to the standalone `process.cwd()` — that directory is by-definition
 * owned by the runtime user (otherwise the Node listener couldn't have
 * booted there), so writes will never EACCES.
 *
 * Returns null only in dev/test contexts where neither env var nor a usable
 * cwd is available — callers then fall back to the system path.
 */
export function getInstallStateDir(): string | null {
  const raw = process.env.CAVECMS_STATE_DIR
  if (raw) return resolve(raw)
  // Legacy-install fallback. process.cwd() in a Next.js standalone build is
  // `<install>/.next/standalone`; the runtime user owns it. We stash state in
  // `<cwd>/.cavecms-state/` so the on-demand mkdir never EACCES on the system
  // path.
  try {
    const cwd = process.cwd()
    if (cwd && cwd !== '/') return resolve(`${cwd}/.cavecms-state`)
  } catch {
    /* very-restricted runtimes (some test harnesses) — null fallback */
  }
  return null
}

/**
 * Validate that a candidate status-file path lives inside an allowed
 * directory. Returns the resolved path on success, throws otherwise.
 *
 * /tmp + os.tmpdir() are ALLOWED in dev/test only. On production /tmp is
 * world-writable and prone to symlink-precreate attacks — an attacker (or
 * another low-priv process) can create the status file as a symlink to
 * /etc/cron.d/cavecms.cron before we open it. In production we lock the
 * allowlist to /var/lib/cavecms/* (system path) OR <CAVECMS_STATE_DIR>/*
 * (the per-install path the CLI provisioned).
 */
export function ensureAllowedStatusPath(candidate: string): string {
  const resolved = resolve(candidate)
  const isProd = process.env.NODE_ENV === 'production'
  if (!isProd) {
    if (resolved.startsWith(resolve(tmpdir()) + '/')) return resolved
    if (resolved.startsWith('/tmp/')) return resolved
  }
  for (const prefix of ALLOWED_SYSTEM_DIR_PREFIXES) {
    if (resolved === prefix.replace(/\/$/, '') || resolved.startsWith(prefix)) {
      return resolved
    }
  }
  const stateDir = getInstallStateDir()
  if (stateDir) {
    if (resolved === stateDir || resolved.startsWith(stateDir + '/')) {
      return resolved
    }
  }
  throw new Error(`status path not allowed: ${candidate}`)
}
