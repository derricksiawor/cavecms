// Build-time check (spec §5.3): refuse to ship a build when a live
// `pages` row's slug collides with a built static route, EXCEPT for
// the intentional cohabitation case (a system=1 row whose slug is in
// the RESERVED set — currently `contact`). Without this gate, an
// operator creating a page with slug `projects` would shadow the
// existing `app/projects/` listing route — middleware Block 2
// blocks the rewrite via the RESERVED set, but the gate catches the
// case where `app/projects/` (or another listing route) was added
// AFTER an operator already owned the colliding slug. Filesystem
// truth vs DB truth — this check makes deploys fail loud rather than
// silently breaking the listing route.
//
// Runs as `postbuild` so it fires AFTER `next build` produces the
// `.next` artifact — i.e. on every CI build and every local
// production-build dry-run, but NOT on dev. Failure halts the
// pipeline before any deploy step.
//
// USES mysql2/promise DIRECTLY (NOT @/db/client) because @/db/client
// pulls `server-only` which blows up outside Next's RSC build. Same
// pattern as scripts/pre-migrate-asserts.ts.
//
// Defence-in-depth NODE_ENV guard per project standards #0.55: dev/build
// tooling MUST NOT run on a production box. The guard fires BEFORE
// any module imports (the `mysql2`, `@/lib/cms/page-slug`, etc.
// resolves are inside the async IIFE below so a prod-box accidental
// invocation exits cleanly without ever loading them).
//
// DATABASE_URL semantics: when unset, the gate SKIPS with a warning
// (default-permissive — local prod-build dry-runs without a DB
// shouldn't fail). To force the gate strict in CI/deploy, set
// `CAVECMS_POSTBUILD_DB_REQUIRED=1` — `scripts/deploy.sh` does this so
// production deploys can never silently skip the check. Without
// that env signal, missing DATABASE_URL is treated as a developer
// signal of "no DB available here," not as a security regression.

// Type-only imports are erased at runtime — no module loading, no
// NODE_ENV-guard violation. Required so the `mysql.RowDataPacket[]`
// annotation below resolves at compile time.
import type mysql from 'mysql2/promise'

// CAVECMS_BUILD_OK=1 is the in-app updater's opt-in (same pattern as
// CAVECMS_MIGRATE_OK for db-migrate-with-lock). The in-app update
// flow runs `pnpm build` under NODE_ENV=production legitimately.
if (
  process.env['NODE_ENV'] === 'production' &&
  process.env['CAVECMS_BUILD_OK'] !== '1'
) {
  console.error(
    '[postbuild-check-slug-collisions] refusing to run with NODE_ENV=production.',
  )
  console.error(
    '[postbuild-check-slug-collisions]   In-app updater path: set CAVECMS_BUILD_OK=1.',
  )
  process.exit(1)
}

(async () => {
  const { readdir } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const mysqlMod = await import('mysql2/promise')
  const mysqlRuntime = mysqlMod.default
  const { RESERVED } = await import('@/lib/cms/page-slug')

  const APP_DIR = join(process.cwd(), 'app')

  // Walk `app/` at depth 1 and collect every directory name that is a
  // real top-level URL segment (NOT a route group, NOT a private
  // folder, NOT a dynamic segment, NOT a dotfile).
  async function collectTopLevelRouteNames(): Promise<string[]> {
    let entries
    try {
      entries = await readdir(APP_DIR, { withFileTypes: true })
    } catch (err: unknown) {
      const errno = (err as { code?: string }).code
      if (errno === 'ENOENT') {
        console.error(
          `[postbuild-check-slug-collisions] directory not found: ${APP_DIR}. ` +
            `Run from the repository root.`,
        )
        process.exit(2)
      }
      throw err
    }
    const out: string[] = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const name = e.name
      if (name.startsWith('.')) continue          // dotfiles
      if (name.startsWith('_')) continue          // private folders (incl. _page)
      if (name.startsWith('(') && name.endsWith(')')) continue  // route groups
      if (name.startsWith('[') && name.endsWith(']')) continue  // dynamic segments
      out.push(name.toLowerCase())
    }
    return out
  }

  const routeNames = await collectTopLevelRouteNames()
  if (routeNames.length === 0) {
    console.log('[postbuild-check-slug-collisions] OK — no top-level routes to check.')
    return
  }

  const url = process.env['DATABASE_URL']
  const strict = process.env['CAVECMS_POSTBUILD_DB_REQUIRED'] === '1'
  if (!url) {
    if (strict) {
      console.error(
        '[postbuild-check-slug-collisions] DATABASE_URL not set; CAVECMS_POSTBUILD_DB_REQUIRED=1 demands strict mode. Aborting.',
      )
      process.exit(2)
    }
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'postbuild_check_slug_collisions_skipped',
        reason: 'database_url_missing',
        note: 'Set CAVECMS_POSTBUILD_DB_REQUIRED=1 in CI/deploy to force this check.',
      }),
    )
    return
  }

  // Query the FULL route-names list (NOT filtered by RESERVED). For
  // each colliding row, classify:
  //   - row.system=1 AND name in RESERVED → intentional cohabitation
  //     (e.g. `contact` — the static route renders renderCmsPage(slug)
  //     blocks AND adds the page-specific extras like <ContactForm/>).
  //     Logged as informational, NOT a failure.
  //   - otherwise → real collision, fail the build.
  //
  // This catches the failure mode where an operator adds a new
  // top-level route AND adds its name to RESERVED in the same PR
  // while a non-system live page already owns the slug — that's a
  // real bug; cohabitation only applies to system rows.
  const conn = await mysqlRuntime.createConnection({
    uri: url,
    connectTimeout: 5000,
  })
  try {
    // mysql2 query (not execute) expands array placeholders to (?,?,...)
    // automatically. Bound input is the filesystem-scanned static list
    // (not user-controlled).
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT id, slug, system FROM pages WHERE deleted_at IS NULL AND slug IN (?)`,
      [routeNames],
    )
    const realCollisions: Array<{ id: number; slug: string }> = []
    const cohabitations: Array<{ id: number; slug: string }> = []
    for (const r of rows) {
      const slug = String(r['slug'] ?? '')
      const id = Number(r['id'] ?? 0)
      const system = Number(r['system'] ?? 0) === 1
      if (system && RESERVED.has(slug)) {
        cohabitations.push({ id, slug })
      } else {
        realCollisions.push({ id, slug })
      }
    }
    if (cohabitations.length > 0) {
      console.log(
        `[postbuild-check-slug-collisions] cohabitation OK — ${cohabitations.length} system page(s) share a URL with a static route:`,
      )
      for (const c of cohabitations) {
        console.log(`  - page id=${c.id} slug=${JSON.stringify(c.slug)} (system=1, RESERVED — intentional)`)
      }
    }
    if (realCollisions.length > 0) {
      console.error(
        `[postbuild-check-slug-collisions] ${realCollisions.length} live page(s) collide with built routes:`,
      )
      for (const c of realCollisions) {
        console.error(
          `  - page id=${c.id} slug=${JSON.stringify(c.slug)} collides with app/${c.slug}/`,
        )
      }
      console.error(
        'Resolution: rename the page slug in /admin/pages, OR remove the colliding\n' +
          '            top-level directory in app/. The pages-CMS dynamic-route resolver\n' +
          '            yields to filesystem-defined routes — without this gate, the operator\n' +
          '            would see a stale 404 / wrong page at the colliding URL.\n' +
          '            If this collision is intentional (e.g. a new system page + static route),\n' +
          '            mark the page row system=1 AND add its slug to lib/cms/page-slug.ts:RESERVED.',
      )
      process.exit(1)
    }
    console.log(
      `[postbuild-check-slug-collisions] OK — checked ${routeNames.length} top-level route name(s); no unexpected collisions.`,
    )
  } finally {
    await conn.end().catch(() => {})
  }
})().catch((err: unknown) => {
  console.error(
    '[postbuild-check-slug-collisions] DB query failed; refusing to pass the gate.',
  )
  console.error(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exit(2)
})
