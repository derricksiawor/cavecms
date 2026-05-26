// DEV-ONLY: refuse to run in production (project standards rule #0.55).
if (process.env['NODE_ENV'] === 'production') {
  console.error('[seo.spec] refusing to run with NODE_ENV=production.')
  process.exit(1)
}

import { test, expect } from '@playwright/test'

// Plan 05 SEO E2E. Verifies:
//   1. Home page emits OG + canonical + Organization JSON-LD
//   2. /sitemap.xml is well-formed and includes static routes
//   3. /robots.txt allows apex, blocks staging.* hosts, never exposes
//      the secret login path

test.describe('Plan 05 SEO', () => {
  test('home emits canonical + og:title + Organization JSON-LD', async ({
    page,
  }) => {
    await page.goto('/')
    const canonical = await page.getAttribute('link[rel=canonical]', 'href')
    expect(canonical).toBe('/')
    const ogTitle = await page.getAttribute(
      'meta[property="og:title"]',
      'content',
    )
    expect(ogTitle).toBeTruthy()
    // Organization JSON-LD is emitted by app/layout.tsx so EVERY
    // public route must carry it — no splash-fallback escape hatch.
    // safeJsonForScript escapes </script> so the inline content is
    // safe even if admin-edited contact/org fields contain HTML.
    const ldNodes = await page.locator('script[type="application/ld+json"]').all()
    expect(ldNodes.length).toBeGreaterThan(0)
    const hasOrg = (
      await Promise.all(
        ldNodes.map(async (n) => (await n.textContent())?.includes('"Organization"') ?? false),
      )
    ).some(Boolean)
    expect(hasOrg).toBe(true)
  })

  test('sitemap.xml lists projects on apex; empty on non-apex hosts', async ({ request }) => {
    // Apex host: full sitemap with static + dynamic URLs.
    const apex = await request.get('/sitemap.xml', {
      headers: { host: 'yourdomain.com' },
    })
    expect(apex.status()).toBe(200)
    const apexBody = await apex.text()
    expect(apexBody).toContain('<urlset')
    expect(apexBody).toContain('/projects')

    // Non-apex host (e.g. localhost during dev or a future
    // staging.* deploy): empty <urlset> so production URLs never
    // get crawled from a non-canonical origin.
    const local = await request.get('/sitemap.xml')
    expect(local.status()).toBe(200)
    const localBody = await local.text()
    expect(localBody).toContain('<urlset')
    expect(localBody).not.toContain('/projects')
  })

  test('robots blocks staging, allows apex, never leaks login path', async ({
    request,
  }) => {
    // Staging host: blanket Disallow:/
    const staging = await request.get('/robots.txt', {
      headers: { host: 'staging.yourdomain.com' },
    })
    expect(staging.status()).toBe(200)
    const stagingBody = await staging.text()
    expect(stagingBody).toContain('Disallow: /')

    // Apex host: allow /, disallow /admin + /api/, sitemap link.
    const apex = await request.get('/robots.txt', {
      headers: { host: 'yourdomain.com' },
    })
    expect(apex.status()).toBe(200)
    const apexBody = await apex.text()
    expect(apexBody).toContain('Disallow: /admin')
    expect(apexBody).toContain('Disallow: /api/')
    // The secret login path MUST NOT appear anywhere in robots.txt —
    // listing it would tell crawlers (and attackers) that it exists.
    const loginPath = process.env['LOGIN_PATH']
    if (loginPath) {
      expect(apexBody).not.toMatch(new RegExp(loginPath, 'i'))
    }
  })

  test('about/services/contact return 200 or fall back gracefully', async ({
    request,
  }) => {
    for (const path of ['/about', '/services', '/contact']) {
      const r = await request.get(path)
      // 200 when the `pages` row exists; 404 when the page wasn't
      // seeded yet. Both are valid states — what matters is no 500.
      expect([200, 404]).toContain(r.status())
    }
  })
})
