import { sql } from 'drizzle-orm'
import { db } from '@/db/client'

// Skip noise: assets, internal/admin/api surfaces. Method isn't available
// in an RSC, so we rely on path shape only. The login path is single-
// segment but unknown here; a 404 there is rare and low-value, and the
// aggregation + prune keep the table bounded regardless.
const ASSET_RE = /\.[a-z0-9]{1,8}$/i

function shouldLog(path: string): boolean {
  if (!path || !path.startsWith('/')) return false
  if (path.length > 512) return false
  if (
    path.startsWith('/admin') ||
    path.startsWith('/api/') ||
    path.startsWith('/_next/') ||
    path.startsWith('/uploads/') ||
    path.startsWith('/cms-render') ||
    path.startsWith('/.well-known') ||
    path === '/favicon.ico'
  ) {
    return false
  }
  if (ASSET_RE.test(path)) return false
  return true
}

export async function recordNotFound(
  rawPath: string,
  referrer: string | null,
): Promise<void> {
  // Drop any query string from the aggregation key.
  const path = (rawPath.split('?')[0] ?? rawPath).slice(0, 512)
  if (!shouldLog(path)) return
  const ref = referrer ? referrer.slice(0, 512) : null
  try {
    await db.execute(sql`
      INSERT INTO not_found_log (path, hits, referrer)
      VALUES (${path}, 1, ${ref})
      ON DUPLICATE KEY UPDATE hits = hits + 1, last_seen_at = NOW(3), referrer = VALUES(referrer)
    `)
    // Opportunistic prune (~1 in 50 writes): keep the 1000 most-recent rows.
    // Time-based gate (not Math.random) so this stays deterministic.
    if (Math.floor(Date.now() / 1000) % 50 === 0) {
      await db.execute(sql`
        DELETE FROM not_found_log
        WHERE id NOT IN (
          SELECT id FROM (
            SELECT id FROM not_found_log ORDER BY last_seen_at DESC LIMIT 1000
          ) keep
        )
      `)
    }
  } catch {
    // Logging a 404 must never throw into the 404 page render.
  }
}
