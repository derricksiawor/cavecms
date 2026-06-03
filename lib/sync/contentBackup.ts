import 'server-only'
import { spawn, spawnSync } from 'node:child_process'
import { createGzip } from 'node:zlib'
import {
  createWriteStream,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { env } from '@/lib/env'
import { getInstallStateDir } from '@/lib/backups/statusPath'

// Retain at most this many content-sync revert snapshots (oldest pruned).
const KEEP = env.CAVECMS_SYNC_BACKUP_KEEP

// Wall-clock cap for the content dump — a stalled dump must not pin the shared
// op-lock indefinitely.
const DUMP_TIMEOUT_MS = 10 * 60 * 1000

// Resolve the dump binary: prefer mariadb-dump (the canonical name on modern
// MariaDB, where mysqldump may be absent or a deprecation-warning shim), then
// mysqldump. Falls back to 'mysqldump' (a clean ENOENT if neither exists, which
// the caller surfaces as backup_failed).
let _dumpBin: string | null = null
function dumpBinary(): string {
  if (_dumpBin) return _dumpBin
  const probe = spawnSync('sh', ['-c', 'command -v mariadb-dump || command -v mysqldump'], {
    encoding: 'utf8',
  })
  _dumpBin = (probe.stdout ?? '').trim().split('\n')[0] || 'mysqldump'
  return _dumpBin
}

// Content tables a cutover can affect — dumped together so a restore is
// internally consistent (media + its reverse index travel with the content).
export const CONTENT_TABLES = [
  'pages',
  'content_blocks',
  'posts',
  'projects',
  'project_sections',
  'settings',
  'media',
  'media_references',
] as const

interface DbConn {
  host: string
  port: number
  user: string
  password: string
  database: string
  socket: string | null
  sslMode: string | null
}

function parseDatabaseUrl(url: string): DbConn {
  const u = new URL(url.replace(/^mysql:\/\//, 'http://'))
  // Preserve TLS / unix-socket transport from the URL query so the dump uses
  // the SAME connection mode as the app (else a TLS-required or socket-only
  // server rejects the dump).
  const socket = u.searchParams.get('socket')
  const sslMode = u.searchParams.get('ssl-mode') ?? (u.searchParams.get('ssl') ? 'REQUIRED' : null)
  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, '').split('?')[0]!,
    socket,
    sslMode,
  }
}

function backupDir(): string {
  // Resolve via the same machinery the updater/backup system uses (handles
  // CAVECMS_STATE_DIR + the per-install legacy fallback + allowlist).
  const stateDir = getInstallStateDir()
  if (!stateDir) {
    // In production a missing state dir means there is nowhere durable to keep
    // the revert snapshot — refuse rather than silently use a reboot-volatile
    // /tmp. (Dev/test fall back to tmpdir.)
    if (process.env.NODE_ENV === 'production') {
      throw new Error('no durable CAVECMS_STATE_DIR for the revert snapshot — refusing')
    }
    const dir = path.join(tmpdir(), 'cavecms-sync', 'sync-backups')
    mkdirSync(dir, { recursive: true })
    return dir
  }
  const dir = path.join(stateDir, 'sync-backups')
  mkdirSync(dir, { recursive: true })
  return dir
}

// Keep the KEEP most-recent snapshots; delete the rest. Best-effort.
function pruneOldBackups(dir: string): void {
  try {
    const all = readdirSync(dir)
    const files = all
      .filter((f) => f.startsWith('sync-') && f.endsWith('.sql.gz'))
      .map((f) => ({ f, m: statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
    for (const { f } of files.slice(KEEP)) rmSync(path.join(dir, f), { force: true })
    // Sweep any leaked `.my.*.cnf` defaults-file (mode-600, but it carries the
    // plaintext DB password). The happy path removes it in finally; a SIGKILL
    // mid-dump skips finally and would otherwise leave it in the durable backup
    // dir forever. Best-effort reap on the next backup.
    for (const f of all) {
      if (f.startsWith('.my.') && f.endsWith('.cnf')) {
        rmSync(path.join(dir, f), { force: true })
      }
    }
  } catch {
    /* pruning is best-effort — never fail a cutover over housekeeping */
  }
}

// Scoped mysqldump of the content tables -> gzip artifact. Returns the artifact
// path. Throws on failure — the caller MUST treat a backup failure as a reason
// to abort the cutover (no rollback artifact = no safe cutover).
export async function contentBackup(contentHash: string): Promise<string> {
  const conn = parseDatabaseUrl(env.DATABASE_URL)
  const dir = backupDir()
  const artifact = path.join(dir, `sync-${contentHash.slice(0, 12)}-${randomUUID().slice(0, 8)}.sql.gz`)

  // Password via a temp defaults-file (mode 600) — never on the argv (visible
  // in `ps`). Removed in finally. The password is double-quoted with `\` and `"`
  // escaped so an exotic password can't corrupt the ini. A my.cnf is line-
  // oriented, so a CR/LF in ANY interpolated field (host/user/socket/ssl-mode/
  // database, all from DATABASE_URL) would inject a forged directive — reject it
  // rather than emit a corrupt ini.
  for (const [field, val] of Object.entries({
    password: conn.password,
    host: conn.host,
    user: conn.user,
    socket: conn.socket ?? '',
    sslMode: conn.sslMode ?? '',
    database: conn.database,
  })) {
    if (/[\r\n]/.test(val)) {
      throw new Error(`DATABASE_URL ${field} contains a newline — cannot build my.cnf`)
    }
  }
  const escPw = conn.password.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const cnf = path.join(dir, `.my.${randomUUID().slice(0, 8)}.cnf`)
  let cnfBody = `[client]\nhost=${conn.host}\nport=${conn.port}\nuser=${conn.user}\npassword="${escPw}"\n`
  if (conn.socket) cnfBody += `socket=${conn.socket}\n`
  if (conn.sslMode) cnfBody += `ssl-mode=${conn.sslMode}\n`

  let child: ReturnType<typeof spawn> | null = null
  try {
    // Inside the try so the finally's rmSync(cnf) covers a write failure too.
    writeFileSync(cnf, cnfBody, { mode: 0o600 })
    const args = [
      `--defaults-extra-file=${cnf}`,
      '--single-transaction',
      '--quick',
      // --no-tablespaces: avoid needing the PROCESS privilege on MySQL 8 (the
      // dump user is a least-privileged content user). Harmless on MariaDB.
      '--no-tablespaces',
      '--skip-lock-tables',
      conn.database,
      ...CONTENT_TABLES,
    ]
    child = spawn(dumpBinary(), args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Wall-clock cap so a stalled dump can't pin the op-lock forever.
      timeout: DUMP_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    })
    let stderr = ''
    child.stderr!.on('data', (d) => {
      stderr += String(d)
    })
    const exitP = new Promise<number>((resolve, reject) => {
      child!.on('error', reject) // e.g. ENOENT: mysqldump not installed
      child!.on('close', resolve)
    })
    // allSettled (NOT Promise.all): Promise.all short-circuits on the first
    // rejection and leaves the OTHER promise floating → an unhandledRejection,
    // which instrumentation.ts escalates to process.exit(1) (killing every site
    // on the install). allSettled awaits BOTH so neither can float; we then
    // surface whichever failed.
    const dumpP = pipeline(child.stdout!, createGzip(), createWriteStream(artifact))
    const [dumpRes, exitRes] = await Promise.allSettled([dumpP, exitP])
    if (exitRes.status === 'rejected') throw exitRes.reason // spawn error (ENOENT)
    if (dumpRes.status === 'rejected') throw dumpRes.reason // gzip / disk-write (ENOSPC)
    const code = exitRes.value
    if (code !== 0) {
      throw new Error(`mysqldump exited ${code}: ${stderr.slice(0, 300)}`)
    }
    pruneOldBackups(dir)
    return artifact
  } catch (e) {
    // Kill a still-running child (e.g. the gzip pipeline rejected) so we don't
    // leak the process + its DB connection, then remove the half-written file.
    try {
      child?.kill('SIGKILL')
    } catch {
      /* already exited */
    }
    rmSync(artifact, { force: true })
    throw e
  } finally {
    rmSync(cnf, { force: true })
  }
}
