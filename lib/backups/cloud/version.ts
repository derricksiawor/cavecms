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
  let v = '0.0.0'
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      version?: unknown
    }
    if (typeof pkg.version === 'string') v = pkg.version
  } catch {
    /* fall back to 0.0.0 */
  }
  cached = v
  return v
}
