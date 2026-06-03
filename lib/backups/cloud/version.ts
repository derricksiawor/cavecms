import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// This install's CaveCMS version, for the remote-backup compat badge. Prefer
// the release env (set on hosted installs); fall back to package.json. Cached.
let cached: string | null = null

export function installVersion(): string {
  if (cached) return cached
  const fromEnv = process.env.CAVECMS_RELEASE_VERSION?.trim()
  if (fromEnv) {
    cached = fromEnv
    return fromEnv
  }
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      version?: unknown
    }
    if (typeof pkg.version === 'string') {
      cached = pkg.version
      return pkg.version
    }
  } catch {
    /* fall through */
  }
  // Don't CACHE the fallback — a transient first-read miss would otherwise mark
  // every remote backup "made by a newer version" for the whole process life.
  return '0.0.0'
}
