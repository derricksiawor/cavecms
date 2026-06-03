import { describe, it, expect, vi } from 'vitest'
import { guardPermalink, SecurityGuardFailure } from '@/lib/security/patchGuards'
import { registerSegmentChangeRedirects } from '@/lib/blog/permalinkRedirects'

// Minimal Tx/Execable mock: records every execute() and returns a queued result
// per call so the guard's sibling-row SELECT can be simulated. The drizzle `sql`
// object is opaque, so we assert behavior (throws / count of writes) rather than
// the raw SQL string — the values flow through bound params either way.
function makeTx(results: unknown[]) {
  const calls: Array<unknown> = []
  let i = 0
  return {
    calls,
    execute: vi.fn(async (q: unknown) => {
      calls.push(q)
      const r = results[i++] ?? [[]]
      return r
    }),
  }
}

// ─── In-memory `redirects` interpreter for the H1 loop/chain tests ───
// Reconstructs the SQL text + interpolated string values from drizzle's
// queryChunks (StringChunk = literal SQL; a plain interpolated string appears
// as its own chunk whose JSON.stringify is the raw value), then applies the
// three statement shapes registerSegmentChangeRedirects emits (DELETE-now-live,
// retarget UPDATE, INSERT…ON DUPLICATE KEY upsert) against an array of rows.
// Faithful enough to assert the final table state without a real DB.
interface RedirectRow {
  source: string
  matchType: string
  action: string
  target: string | null
}
function reconstruct(q: { queryChunks?: unknown[] }): { sqlText: string; values: string[] } {
  let sqlText = ''
  const values: string[] = []
  for (const c of q.queryChunks ?? []) {
    const ctor = (c as { constructor?: { name?: string } })?.constructor?.name
    if (ctor === 'StringChunk') {
      sqlText += ((c as { value: string[] }).value).join('')
    } else if (typeof c === 'string') {
      values.push(c)
    } else {
      // A plain string interpolated into sql`` is itself the chunk; JSON of it
      // is the raw string. Numbers (e.g. SUBSTRING length) come through too.
      const v = c as unknown
      if (typeof v === 'number') values.push(String(v))
      else values.push(String(v))
    }
  }
  return { sqlText, values }
}
function makeRedirectStore() {
  const rows: RedirectRow[] = []
  const tx = {
    execute: async (q: unknown) => {
      const { sqlText, values } = reconstruct(q as { queryChunks?: unknown[] })
      if (sqlText.startsWith('\n    DELETE FROM redirects') || sqlText.includes('DELETE FROM redirects')) {
        // DELETE … WHERE source IN (v0, v1)
        const [a, b] = values
        for (let k = rows.length - 1; k >= 0; k--) {
          if (rows[k]!.source === a || rows[k]!.source === b) rows.splice(k, 1)
        }
        return [{ affectedRows: 0 }]
      }
      if (sqlText.includes('UPDATE redirects')) {
        // Retarget: values = [oldExactTarget, newExact, newWildPrefix, lenStr,
        //                     oldExact(NOT IN), oldWild(NOT IN), oldExactTarget(=),
        //                     oldWildLike]
        // We pull the semantically-meaningful ones positionally from the
        // reconstructed list: the CASE/WHERE all reference the same four base
        // strings, so derive old/new from them.
        const oldExactTarget = values[0]! // `/old`
        const newExact = values[1]! // `/new`
        const newWildPrefix = values[2]! // `/new/`
        const subLen = Number(values[3]) // prefix length + 1
        const oldExclExact = values[4]! // `/old`
        const oldExclWild = values[5]! // `/old/*`
        const oldWildLike = values[7]! // `/old/%`
        const oldWildPrefix = oldWildLike.slice(0, -1) // strip trailing %
        for (const r of rows) {
          if (r.action !== 'redirect' || r.target == null) continue
          if (r.source === oldExclExact || r.source === oldExclWild) continue
          const t = r.target
          if (t === oldExactTarget) {
            r.target = newExact
          } else if (t.startsWith(oldWildPrefix)) {
            r.target = newWildPrefix + t.slice(subLen - 1)
          }
        }
        return [{ affectedRows: 0 }]
      }
      if (sqlText.includes('INSERT INTO redirects')) {
        // upsert(source, matchType, target). The VALUES list order in
        // upsertRedirect: source, matchType, target (then literals).
        const source = values[0]!
        const matchType = values[1]!
        const target = values[2]!
        const existing = rows.find((r) => r.source === source && r.matchType === matchType)
        if (existing) {
          existing.action = 'redirect'
          existing.target = target
        } else {
          rows.push({ source, matchType, action: 'redirect', target })
        }
        return [{ affectedRows: 1 }]
      }
      return [[]]
    },
  }
  return { rows, tx }
}

describe('guardPermalink (cross-collision + login-path)', () => {
  // prevSegment differs from the candidate in every collision test below so the
  // L3 early-return doesn't short-circuit the check under test.
  it('rejects a blog segment equal to the CURRENT projects segment', async () => {
    // Sibling (projects) row currently 'work'.
    const tx = makeTx([[[{ value: JSON.stringify({ segment: 'work' }) }]]])
    await expect(
      guardPermalink(tx as never, 'permalink_blog', 'work', 'kqt9ji3jrhz7', 'blog'),
    ).rejects.toBeInstanceOf(SecurityGuardFailure)
  })

  it('rejects a segment equal to the login path BEFORE any DB read', async () => {
    const tx = makeTx([])
    await expect(
      guardPermalink(tx as never, 'permalink_blog', 'kqt9ji3jrhz7', 'kqt9ji3jrhz7', 'blog'),
    ).rejects.toBeInstanceOf(SecurityGuardFailure)
    // Login-path collision short-circuits — no sibling SELECT issued.
    expect(tx.execute).not.toHaveBeenCalled()
  })

  it('accepts a non-colliding segment (sibling differs, not login path)', async () => {
    const tx = makeTx([[[{ value: JSON.stringify({ segment: 'work' }) }]]])
    await expect(
      guardPermalink(tx as never, 'permalink_blog', 'news', 'kqt9ji3jrhz7', 'blog'),
    ).resolves.toBeUndefined()
  })

  it('falls back to the sibling DEFAULT when its row is absent and still blocks a collision', async () => {
    // No projects row → guard uses default 'projects'. A blog segment of
    // 'projects' must still be rejected.
    const tx = makeTx([[[]]])
    await expect(
      guardPermalink(tx as never, 'permalink_blog', 'projects', 'kqt9ji3jrhz7', 'blog'),
    ).rejects.toBeInstanceOf(SecurityGuardFailure)
  })

  it('tolerates a corrupt sibling row (enforces against the default)', async () => {
    const tx = makeTx([[[{ value: '{not json' }]]])
    // Corrupt → default 'projects'; 'news' is fine.
    await expect(
      guardPermalink(tx as never, 'permalink_blog', 'news', 'kqt9ji3jrhz7', 'blog'),
    ).resolves.toBeUndefined()
  })

  // ─── L3: structure-only save (segment unchanged) skips the SELECT entirely ──
  it('early-returns WITHOUT a sibling SELECT when the segment is unchanged', async () => {
    const tx = makeTx([])
    // newSegment === prevSegment → no collision possible; no DB read.
    await expect(
      guardPermalink(tx as never, 'permalink_blog', 'news', 'kqt9ji3jrhz7', 'news'),
    ).resolves.toBeUndefined()
    expect(tx.execute).not.toHaveBeenCalled()
  })

  it('still enforces collisions when the segment DID change to the login path even if prev matched it shape-wise', async () => {
    // prev 'blog' → candidate equals login path: must reject (segment changed).
    const tx = makeTx([])
    await expect(
      guardPermalink(tx as never, 'permalink_blog', 'kqt9ji3jrhz7', 'kqt9ji3jrhz7', 'blog'),
    ).rejects.toBeInstanceOf(SecurityGuardFailure)
  })

  // ─── F3: shadowing an existing live page / published post ────────────────
  // After the login-path + sibling-segment checks pass, the guard issues two
  // existence probes in order: (1) live page with this slug, (2) published,
  // non-deleted post with this slug. makeTx queues results by call order:
  //   [0] sibling-segment SELECT, [1] page-shadow SELECT, [2] post-shadow SELECT.
  it('rejects a segment that shadows an existing live page slug', async () => {
    const tx = makeTx([
      [[{ value: JSON.stringify({ segment: 'work' }) }]], // sibling differs
      [[{ '1': 1 }]], // page-shadow hit (one row)
      [[]], // post-shadow miss
    ])
    await expect(
      guardPermalink(tx as never, 'permalink_blog', 'about', 'kqt9ji3jrhz7', 'blog'),
    ).rejects.toBeInstanceOf(SecurityGuardFailure)
  })

  it('rejects a segment that shadows a published post slug (no page hit)', async () => {
    const tx = makeTx([
      [[{ value: JSON.stringify({ segment: 'work' }) }]], // sibling differs
      [[]], // page-shadow miss
      [[{ '1': 1 }]], // post-shadow hit
    ])
    await expect(
      guardPermalink(tx as never, 'permalink_blog', 'hello-world', 'kqt9ji3jrhz7', 'blog'),
    ).rejects.toBeInstanceOf(SecurityGuardFailure)
  })

  it('accepts a segment that shadows nothing (sibling/page/post all clear)', async () => {
    const tx = makeTx([
      [[{ value: JSON.stringify({ segment: 'work' }) }]], // sibling differs
      [[]], // page-shadow miss
      [[]], // post-shadow miss
    ])
    await expect(
      guardPermalink(tx as never, 'permalink_blog', 'news', 'kqt9ji3jrhz7', 'blog'),
    ).resolves.toBeUndefined()
    // Three SELECTs issued: sibling, page-shadow, post-shadow.
    expect(tx.execute).toHaveBeenCalledTimes(3)
  })

  it('does NOT reach the shadow probes when the sibling collision already fails', async () => {
    // Sibling (projects) is 'about'; candidate 'about' collides at the sibling
    // check → guard throws BEFORE the page/post shadow SELECTs.
    const tx = makeTx([[[{ value: JSON.stringify({ segment: 'about' }) }]]])
    await expect(
      guardPermalink(tx as never, 'permalink_blog', 'about', 'kqt9ji3jrhz7', 'blog'),
    ).rejects.toBeInstanceOf(SecurityGuardFailure)
    // Only the sibling SELECT ran.
    expect(tx.execute).toHaveBeenCalledTimes(1)
  })

  // ─── BUG-2: reverting to the segment's OWN canonical default is ALLOWED ──────
  // The blog/projects SYSTEM PAGE legitimately has slug='blog'/'projects' and
  // coexists with the default segment by design (the segment rewrite is a no-op
  // on the default word, so that page is never shadowed). Reverting a custom
  // segment back to its canonical default must therefore SKIP the page/post
  // shadow probes — even though those system pages exist — or the operator is
  // permanently locked out of the default.
  it('ALLOWS reverting permalink_blog to the canonical "blog" even though the blog system page exists', async () => {
    // Sibling (projects) differs. The page/post shadow rows are queued as HITS
    // to prove the guard NEVER reaches them (the canonical exemption returns
    // before those SELECTs).
    const tx = makeTx([
      [[{ value: JSON.stringify({ segment: 'work' }) }]], // sibling differs
      [[{ '1': 1 }]], // page-shadow WOULD hit (blog system page) — must not be read
      [[{ '1': 1 }]], // post-shadow WOULD hit — must not be read
    ])
    await expect(
      guardPermalink(tx as never, 'permalink_blog', 'blog', 'kqt9ji3jrhz7', 'news'),
    ).resolves.toBeUndefined()
    // Only the sibling SELECT ran — the canonical exemption returned before the
    // page/post shadow probes.
    expect(tx.execute).toHaveBeenCalledTimes(1)
  })

  it('ALLOWS reverting permalink_projects to the canonical "projects" even though the projects system page exists', async () => {
    const tx = makeTx([
      [[{ value: JSON.stringify({ segment: 'blog' }) }]], // sibling (blog) differs
      [[{ '1': 1 }]], // page-shadow WOULD hit — must not be read
      [[{ '1': 1 }]], // post-shadow WOULD hit — must not be read
    ])
    await expect(
      guardPermalink(tx as never, 'permalink_projects', 'projects', 'kqt9ji3jrhz7', 'work'),
    ).resolves.toBeUndefined()
    expect(tx.execute).toHaveBeenCalledTimes(1)
  })

  // The exemption is SCOPED to the canonical word — a NON-canonical custom
  // segment that shadows a real page/post is STILL rejected.
  it('STILL rejects a non-canonical segment that shadows a real page (exemption does not over-apply)', async () => {
    const tx = makeTx([
      [[{ value: JSON.stringify({ segment: 'work' }) }]], // sibling differs
      [[{ '1': 1 }]], // page-shadow hit on the custom 'news' page
      [[]], // post-shadow miss
    ])
    await expect(
      guardPermalink(tx as never, 'permalink_blog', 'news', 'kqt9ji3jrhz7', 'blog'),
    ).rejects.toBeInstanceOf(SecurityGuardFailure)
  })

  // The canonical exemption must NOT bypass the SIBLING-collision check: if the
  // projects segment were (somehow) 'blog', reverting blog→'blog' still collides
  // at the sibling check, which runs BEFORE the exemption.
  it('STILL rejects reverting to "blog" when the sibling projects segment is also "blog" (sibling check precedes exemption)', async () => {
    const tx = makeTx([[[{ value: JSON.stringify({ segment: 'blog' }) }]]])
    await expect(
      guardPermalink(tx as never, 'permalink_blog', 'blog', 'kqt9ji3jrhz7', 'news'),
    ).rejects.toBeInstanceOf(SecurityGuardFailure)
    // Sibling SELECT ran and threw; exemption never reached.
    expect(tx.execute).toHaveBeenCalledTimes(1)
  })
})

describe('registerSegmentChangeRedirects', () => {
  it('is a no-op when old === new (no writes)', async () => {
    const tx = makeTx([])
    await registerSegmentChangeRedirects(tx as never, 'blog', 'blog', 1)
    expect(tx.execute).not.toHaveBeenCalled()
  })

  it('issues an exact (index) + wildcard (sub-path) upsert on a real change', async () => {
    const tx = makeTx([[{}], [{}], [{}], [{}]])
    await registerSegmentChangeRedirects(tx as never, 'blog', 'news', 7)
    // Four statements: DELETE-now-live, retarget UPDATE, then two upserts.
    expect(tx.execute).toHaveBeenCalledTimes(4)
    // The drizzle SQL object carries the interpolated values; assert both
    // source forms are present across the calls by stringifying the query.
    const blob = JSON.stringify(tx.calls)
    expect(blob).toContain('/blog')
    expect(blob).toContain('/news')
  })

  // ─── H1: a re-rename 2-cycle must leave NO rule shadowing the live segment ──
  // We drive registerSegmentChangeRedirects against an in-memory `redirects`
  // table that interprets each issued statement (DELETE-now-live, retarget
  // UPDATE, upserts) so we can assert the table state after a full
  // news → press → news round-trip. The classic infinite-301 trap is that the
  // first rename's `/news/*`→`/press/$1` rule survives the second rename and
  // shadows the now-live `/news/...` — the fix DELETEs any rule whose source is
  // exactly `/new` or `/new/*` before upserting.
  it('news → press → news leaves no rule whose source is /news or /news/*', async () => {
    const store = makeRedirectStore()
    await registerSegmentChangeRedirects(store.tx as never, 'news', 'press', 1)
    await registerSegmentChangeRedirects(store.tx as never, 'press', 'news', 1)
    const sources = store.rows.map((r) => r.source)
    expect(sources).not.toContain('/news')
    expect(sources).not.toContain('/news/*')
    // The live rules are the press→news pair; /news/... resolves to the file
    // route via the segment rewrite with nothing shadowing it.
    expect(sources).toContain('/press')
    expect(sources).toContain('/press/*')
  })

  // Chain collapse: news → press → media retargets the original news rules so
  // they point straight at /media (one hop, no /press intermediate).
  it('news → press → media collapses the chain to a single hop', async () => {
    const store = makeRedirectStore()
    await registerSegmentChangeRedirects(store.tx as never, 'news', 'press', 1)
    await registerSegmentChangeRedirects(store.tx as never, 'press', 'media', 1)
    const bySource = new Map(store.rows.map((r) => [r.source, r.target]))
    // The original /news/* rule now points at /media/$1 directly (was /press/$1).
    expect(bySource.get('/news/*')).toBe('/media/$1')
    expect(bySource.get('/news')).toBe('/media')
    // Fresh press→media rules also present.
    expect(bySource.get('/press/*')).toBe('/media/$1')
    expect(bySource.get('/press')).toBe('/media')
  })
})
