import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { RedirectsClient, type RedirectItem, type NotFoundItem } from './RedirectsClient'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

const iso = (v: Date | string | null): string | null =>
  v === null ? null : new Date(v).toISOString()

interface RRow {
  id: number
  source: string
  match_type: RedirectItem['matchType']
  action: RedirectItem['action']
  target: string | null
  status_code: number | null
  query_handling: RedirectItem['queryHandling']
  case_insensitive: number
  enabled: number
  position: number
  hit_count: number
  last_hit_at: string | null
  notes: string | null
}
interface NRow {
  id: number
  path: string
  hits: number
  last_seen_at: string
  referrer: string | null
}

export default async function AdminRedirects() {
  await requireRoleOrRedirect(['admin'])
  const [[rRows], [nRows]] = await Promise.all([
    db.execute(sql`
      SELECT id, source, match_type, action, target, status_code, query_handling,
             case_insensitive, enabled, position, hit_count, last_hit_at, notes
      FROM redirects ORDER BY position ASC, id ASC
    `) as unknown as Promise<[RRow[]]>,
    db.execute(sql`
      SELECT id, path, hits, last_seen_at, referrer
      FROM not_found_log ORDER BY last_seen_at DESC LIMIT 500
    `) as unknown as Promise<[NRow[]]>,
  ])

  const redirects: RedirectItem[] = rRows.map((r) => ({
    id: r.id,
    source: r.source,
    matchType: r.match_type,
    action: r.action,
    target: r.target,
    statusCode: r.status_code,
    queryHandling: r.query_handling,
    caseInsensitive: r.case_insensitive === 1,
    enabled: r.enabled === 1,
    position: r.position,
    hitCount: r.hit_count,
    lastHitAt: iso(r.last_hit_at),
    notes: r.notes,
  }))
  const notFounds: NotFoundItem[] = nRows.map((n) => ({
    id: n.id,
    path: n.path,
    hits: n.hits,
    lastSeenAt: iso(n.last_seen_at)!,
    referrer: n.referrer,
  }))

  return (
    <div className="max-w-5xl">
      <RedirectsClient initialRedirects={redirects} initialNotFounds={notFounds} />
    </div>
  )
}
