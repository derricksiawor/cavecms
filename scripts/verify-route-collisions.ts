// Build-time check (spec §2.1): refuse to start if two dynamic
// segments with DIFFERENT names share the same effective URL parent
// path. Next.js' route resolver hard-errors on this with
// "You cannot use different slug names for the same dynamic path".
//
// The pages CMS uses `app/%5Fpage/[slug]/page.tsx` (the URL-encoded
// underscore prefix per Next 15 docs, which routes as the URL segment
// `/_page` while keeping the folder visible to the route resolver — a
// plain `_page` folder name would be PRIVATE and silently un-routable,
// breaking the middleware rewrite).
// `app/(auth)/[loginPath]/page.tsx` lives under a route group, so
// its URL parent is `/`. Different effective parents — no conflict.
//
// A naive contributor adding `app/[name]/page.tsx` would create
// TWO different dynamic segment names under URL parent `/`
// (`[loginPath]` AND `[name]`) — Next refuses. This gate fails
// loud BEFORE Next's resolver crashes mid-boot with an opaque error.
//
// Runs as `predev` + `prebuild`. Filesystem-only; no DB connection.
//
// LIMITATION: this script does NOT understand Next 15 parallel-route
// conventions (`@slot`) or intercepting routes (`(.)`, `(..)`,
// `(...)`). The pages CMS PR-2 does not use any of those. Any
// contributor introducing them must extend this checker — the
// current `name.startsWith('(') && name.endsWith(')')` route-group
// match would incorrectly treat `(.)photo` as a route group.
//
// Defence-in-depth NODE_ENV guard per project standards #0.55: the guard
// fires BEFORE any module imports (the `node:fs/promises`,
// `node:path` resolves are inside the async IIFE below).

// CAVECMS_BUILD_OK=1 is the in-app updater's opt-in: scripts/cavecms-update.sh
// invokes `pnpm build` as part of step 4 with NODE_ENV=production live,
// and that flow IS a legitimate operator-initiated prod build. Honour
// the same opt-in pattern that db-migrate-with-lock uses for
// CAVECMS_MIGRATE_OK so the prebuild gate isn't a hard floor against
// the legitimate in-app path.
if (
  process.env['NODE_ENV'] === 'production' &&
  process.env['CAVECMS_BUILD_OK'] !== '1'
) {
  console.error(
    '[verify-route-collisions] refusing to run with NODE_ENV=production.',
  )
  console.error(
    '[verify-route-collisions]   In-app updater path: set CAVECMS_BUILD_OK=1.',
  )
  process.exit(1)
}

(async () => {
  const { readdir } = await import('node:fs/promises')
  const { join, relative } = await import('node:path')

  const APP_DIR = join(process.cwd(), 'app')

  interface DynamicSegment {
    fsPath: string
    name: string
    urlParent: string
  }

  async function collectDynamicSegments(
    fsDir: string,
    urlParent: string,
    out: DynamicSegment[],
  ): Promise<void> {
    let entries
    try {
      entries = await readdir(fsDir, { withFileTypes: true })
    } catch (err: unknown) {
      const errno = (err as { code?: string }).code
      if (errno === 'ENOENT') {
        console.error(
          `[verify-route-collisions] directory not found: ${fsDir}. ` +
            `Run from the repository root.`,
        )
        process.exit(2)
      }
      throw err
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const name = e.name
      const fullFs = join(fsDir, name)
      // Route group `(foo)` — does NOT advance the URL parent.
      // Intercepting-route conventions ((.) / (..) / (...)) and
      // parallel routes (@slot) are not recognised — see file-top
      // limitation comment.
      if (name.startsWith('(') && name.endsWith(')')) {
        await collectDynamicSegments(fullFs, urlParent, out)
        continue
      }
      // Dynamic segment `[name]` — record AND recurse.
      if (name.startsWith('[') && name.endsWith(']')) {
        const captured = name.slice(1, -1)
        out.push({
          fsPath: relative(process.cwd(), fullFs),
          name: captured,
          urlParent,
        })
        const childUrlParent =
          urlParent === '/' ? `/[${captured}]` : `${urlParent}/[${captured}]`
        await collectDynamicSegments(fullFs, childUrlParent, out)
        continue
      }
      // Plain folder (including `_private`) — advances URL parent.
      const childUrlParent =
        urlParent === '/' ? `/${name}` : `${urlParent}/${name}`
      await collectDynamicSegments(fullFs, childUrlParent, out)
    }
  }

  const segments: DynamicSegment[] = []
  await collectDynamicSegments(APP_DIR, '/', segments)

  const byParent = new Map<string, Map<string, string[]>>()
  for (const s of segments) {
    const parentMap = byParent.get(s.urlParent) ?? new Map<string, string[]>()
    const list = parentMap.get(s.name) ?? []
    list.push(s.fsPath)
    parentMap.set(s.name, list)
    byParent.set(s.urlParent, parentMap)
  }

  let failed = false
  for (const [parent, nameMap] of byParent) {
    if (nameMap.size > 1) {
      failed = true
      console.error(
        `[verify-route-collisions] multiple dynamic segment NAMES under URL parent "${parent}":`,
      )
      for (const [name, paths] of nameMap) {
        console.error(`  - [${name}] at:`)
        for (const p of paths) console.error(`      ${p}`)
      }
    }
  }

  if (failed) {
    console.error(
      '[verify-route-collisions] Next.js refuses two different dynamic segment names sharing a URL parent.\n' +
        '  Pages CMS uses middleware rewrite to `app/%5Fpage/[slug]` (URL parent /_page) so the slug\n' +
        '  space does not collide with `app/(auth)/[loginPath]` (URL parent /). To add a new dynamic\n' +
        '  segment at an existing URL parent, RENAME it to match the existing slug name AND merge\n' +
        '  the route logic, OR move it under a different parent.',
    )
    process.exit(1)
  }

  console.log(
    `[verify-route-collisions] OK — ${segments.length} dynamic segment(s) across ${byParent.size} URL parent(s); no name conflicts.`,
  )
})().catch((err: unknown) => {
  console.error('[verify-route-collisions] unexpected error:')
  console.error(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exit(2)
})
