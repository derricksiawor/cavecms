import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { rateLimit } from '@/lib/auth/rateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { publicPostConditionSql } from '@/lib/cms/postStatus'

// Public, cached options for a form's DYNAMIC dropdown (lx_form select fields
// with optionsSource = 'tags' | 'categories'). Returns the taxonomy terms as
// { label, value } where value = slug. No auth — but gated on EXISTS(published
// post) exactly like the sitemap/archive, so it can ONLY surface terms a visitor
// could already discover publicly (a term tied only to a draft/scheduled post is
// NOT leaked). Bounded (LIMIT 200) + per-IP rate-limited + cacheable.

const limit = rateLimit('form-options:ip', { limit: 60, windowSec: 60 })

type Ctx = { params: Promise<{ collection: string }> }

export const GET = withError<Ctx>(async (req, { params }) => {
  const { collection } = await params

  const headerObj: Record<string, string | undefined> = {}
  req.headers.forEach((v, k) => {
    headerObj[k] = v
  })
  const ip = clientIpFromHeaders(headerObj, '127.0.0.1') ?? '0.0.0.0'
  if (!limit(ip)) {
    return new Response('Too Many Requests', {
      status: 429,
      headers: { 'cache-control': 'private, no-store', 'retry-after': '60' },
    })
  }

  let options: Array<{ label: string; value: string }> = []
  if (collection === 'tags') {
    const [rows] = (await db.execute(sql`
      SELECT t.slug, t.name FROM tags t
      WHERE EXISTS (
        SELECT 1 FROM post_tags pt JOIN posts p ON p.id = pt.post_id
        WHERE pt.tag_id = t.id AND ${publicPostConditionSql('p')}
      )
      ORDER BY t.name
      LIMIT 200
    `)) as unknown as [Array<{ slug: string; name: string }>]
    options = rows.map((r) => ({ label: r.name, value: r.slug }))
  } else if (collection === 'categories') {
    const [rows] = (await db.execute(sql`
      SELECT t.slug, t.name FROM categories t
      WHERE EXISTS (
        SELECT 1 FROM post_categories pc JOIN posts p ON p.id = pc.post_id
        WHERE pc.category_id = t.id AND ${publicPostConditionSql('p')}
      )
      ORDER BY t.position, t.name
      LIMIT 200
    `)) as unknown as [Array<{ slug: string; name: string }>]
    options = rows.map((r) => ({ label: r.name, value: r.slug }))
  } else {
    return new Response(JSON.stringify({ options: [] }), {
      status: 404,
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    })
  }

  return new Response(JSON.stringify({ options }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      // Public + short-cacheable. Taxonomy terms can be added/renamed/deleted
      // independently of post publish (admin taxonomy edits) with no edge-purge
      // hook, so keep the edge window short — match s-maxage to max-age (60s).
      'cache-control': 'public, max-age=60, s-maxage=60',
    },
  })
})
