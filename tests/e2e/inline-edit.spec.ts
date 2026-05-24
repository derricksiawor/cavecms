// DEV-ONLY: refuse to run in production (project standards rule #0.55).
if (process.env['NODE_ENV'] === 'production') {
  console.error('[inline-edit.spec] refusing to run with NODE_ENV=production.')
  process.exit(1)
}

import { test, expect, type BrowserContext } from '@playwright/test'
import mysql from 'mysql2/promise'
import { CSRF_COOKIE_NAME } from '@/lib/auth/cookie-names'

const LOGIN_PATH = process.env['LOGIN_PATH'] ?? 'baccess'

// ---------------------------------------------------------------------------
// DB cleanup — soft-deletes freeform blocks on the home page before each
// suite run so the test starts from a known, small state.
// ---------------------------------------------------------------------------

async function purgeAllBlocks(): Promise<void> {
  // Hard-delete ALL content blocks on the home page (live AND soft-deleted).
  // This runs in BOTH beforeAll AND afterAll so the dev DB never accumulates
  // test-residue rows — without the afterAll, prior runs leak `text` blocks
  // with `Playwright-edit-<ts>` headings that the next `pnpm dev` session
  // renders on the public home page (the user sees the test artifact
  // instead of the splash fallback).
  //
  // Hard-delete instead of soft-delete because:
  //   - Test rows never need restore (no audit value)
  //   - Soft-deleted rows still occupy unique-key space (idx_blocks_page_key)
  //     and accumulate across runs
  //   - Their media_references would dangle past cron-purge's
  //     SOFT_DELETE_RETENTION_DAYS=30 window
  //
  // Why ALL blocks (not just freeform): fixed-slot seed blocks (e.g. the hero
  // block at id=10) may have malformed JSON data that fails Zod validation.
  // hydratePage() omits those blocks, so they don't appear as
  // [data-edit-block-id] elements or in the OutlinePanel's initial list.
  // The reorder API requires submitted IDs to equal ALL living block IDs in
  // the DB — if a malformed fixed-slot block is living but not rendered, the
  // submitted set is a strict subset and the API returns 409 (drift) every
  // time. Purging ALL blocks at test start ensures the DB's living set
  // matches exactly the blocks the test adds itself. Safe for local dev only
  // — the host guard below prevents accidental production mutation.

  const dsn = process.env['DATABASE_URL'] ?? ''
  if (!dsn) return

  // Defense-in-depth: only run against a local database host.
  // If DATABASE_URL points at a remote host, refuse to purge to avoid
  // accidentally mutating a staging or production database.
  const hostMatch = dsn.match(/^mysql:\/\/[^@]*@([^:/]+)/)
  const host = hostMatch?.[1] ?? ''
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host)) {
    console.warn(
      `[purgeAllBlocks] refusing to purge — host="${host}" is not localhost. ` +
      'Only local databases may be modified by test setup.'
    )
    return
  }

  // Use a single throwaway connection (not the shared pool) so cleanup
  // does not leave lingering connections after the suite finishes.
  let conn: mysql.Connection | undefined
  try {
    conn = await mysql.createConnection(dsn)
    // FK-cascade order: media_references depend on content_blocks; clear
    // them first to avoid FK-violation aborts when the parent DELETE runs.
    // (FK has ON DELETE CASCADE on media_id, NOT on referent_id, so we
    // must clear referent rows manually.)
    await conn.execute(
      `DELETE mr FROM media_references mr
       INNER JOIN content_blocks cb ON cb.id = mr.referent_id
        AND mr.referent_type = 'content_block'
       WHERE cb.page_id = (SELECT id FROM pages WHERE slug = 'home' LIMIT 1)`,
    )
    await conn.execute(
      `DELETE FROM content_blocks
        WHERE page_id = (SELECT id FROM pages WHERE slug = 'home' LIMIT 1)`,
    )
  } catch (err) {
    // Non-fatal — tests still work even if cleanup fails (just potentially
    // slower due to leftover blocks from previous runs).
    console.warn('[purgeAllBlocks] cleanup failed (non-fatal):', {
      code: (err as { code?: string } | null)?.code,
      errno: (err as { errno?: number } | null)?.errno,
      name: err instanceof Error ? err.name : 'unknown',
    })
  } finally {
    await conn?.end()
  }
}

// ---------------------------------------------------------------------------
// Auth helper — used once per describe block via beforeAll
// ---------------------------------------------------------------------------

async function doLogin(page: import('@playwright/test').Page) {
  await page.goto(`/${LOGIN_PATH}`, { waitUntil: 'networkidle' })
  await page.fill('input[name=email]', 'admin@bwc.test')
  await page.fill('input[name=password]', 'CorrectHorseBattery0!')
  const [resp] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST',
    ),
    page.click('button[type=submit]'),
  ])
  expect(resp.status()).toBe(200)
  await page.waitForURL(/\/admin$/)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Enable edit mode. Navigates to '/', clicks "Enter edit mode", then does
 * a full goto('/') so OutlinePanel mounts fresh (avoids router.refresh state
 * issues). If edit mode is already on (cookie from a previous step), skips.
 */
async function ensureEditMode(page: import('@playwright/test').Page) {
  await page.goto('/', { waitUntil: 'networkidle' })
  const exitBtn = page.getByRole('button', { name: 'Exit edit mode' })
  const enterBtn = page.getByRole('button', { name: 'Enter edit mode' })

  // If edit mode is already on, just refresh the page so panel is in initial state.
  if (await exitBtn.isVisible()) {
    // Re-navigate to get a fresh-mounted OutlinePanel.
    await page.goto('/', { waitUntil: 'networkidle' })
    await exitBtn.waitFor({ timeout: 8_000 })
    return
  }

  await enterBtn.waitFor({ timeout: 10_000 })
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/api/cms/edit-mode') && r.status() === 200,
    ),
    enterBtn.click(),
  ])
  await exitBtn.waitFor({ timeout: 10_000 })
  // Full navigation to get a clean React tree after router.refresh().
  await page.goto('/', { waitUntil: 'networkidle' })
  await exitBtn.waitFor({ timeout: 10_000 })
}

/** Expand the OutlinePanel (it starts collapsed after each mount). */
async function openOutlinePanel(page: import('@playwright/test').Page) {
  const aside = page.locator('aside').last()
  const toggle = aside.locator('header button')
  await toggle.waitFor({ timeout: 8_000 })

  // Retry opening the panel. After router.refresh(), React may not have
  // finished hydration on the first attempt.
  const addBlockTextBtn = aside.getByRole('button', { name: 'text', exact: true })
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    const btnText = await toggle.textContent().catch(() => '')
    if (btnText?.trim() !== '–') {
      await toggle.click({ force: true })
      await page.waitForTimeout(300)
    }
    if (await addBlockTextBtn.count() > 0) break
  }
  await addBlockTextBtn.waitFor({ timeout: 3_000 })
}

/**
 * Add a text block via the OutlinePanel Add block menu.
 * After POST, AddBlockMenu calls router.refresh() to update the page.
 */
async function addTextBlock(page: import('@playwright/test').Page) {
  await openOutlinePanel(page)
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/api/cms/blocks') && r.request().method() === 'POST' && r.status() === 201,
    ),
    page.locator('aside').last().getByRole('button', { name: 'text', exact: true }).click(),
  ])
  await page.waitForLoadState('networkidle')
}

/** Hover + force-click the edit button on the last EditableBlock. */
async function openLastTextBlockEditor(page: import('@playwright/test').Page) {
  const wrapper = page.locator('[data-edit-block-id]').last()
  const editBtn = page.getByRole('button', { name: /✎ Edit text/ }).last()
  await wrapper.hover()
  await editBtn.click({ force: true })
  await page.getByRole('heading', { name: /Edit text/ }).waitFor({ timeout: 8_000 })
}

// ---------------------------------------------------------------------------
// Tests — serial to share context state without re-logging in per test
// ---------------------------------------------------------------------------

test.describe.serial('inline-edit roundtrip', () => {
  // One login per suite. All tests reuse the same BrowserContext (serial)
  // so we can store state (cookies, storage) across tests. The login rate
  // limit is 3/60 s per IP; using beforeAll avoids hitting it.
  let sharedContext: BrowserContext

  test.beforeAll(async ({ browser }) => {
    // Hard-delete all blocks so tests start from a clean, predictable DB state.
    await purgeAllBlocks()
    sharedContext = await browser.newContext()
    const setupPage = await sharedContext.newPage()
    await doLogin(setupPage)
    await setupPage.close()
  })

  test.afterAll(async () => {
    // Hard-delete again on teardown so the next `pnpm dev` session shows
    // the splash fallback (zero blocks → SplashFallback) rather than the
    // `Playwright-edit-<ts>` text block residue from the last test run.
    await purgeAllBlocks()
    await sharedContext.close()
  })

  test('admin can edit text block heading and reload shows new copy', async () => {
    const page = await sharedContext.newPage()
    try {
      await ensureEditMode(page)
      await addTextBlock(page)
      await openOutlinePanel(page)
      await openLastTextBlockEditor(page)

      const unique = `Playwright-edit-${Date.now()}`
      await page.getByLabel('Heading').fill(unique)

      await Promise.all([
        page.waitForResponse(
          (r) =>
            r.url().includes('/api/cms/blocks/') &&
            r.request().method() === 'PATCH' &&
            r.status() === 200,
        ),
        page.getByRole('button', { name: 'Save' }).click(),
      ])

      await page.reload({ waitUntil: 'networkidle' })
      await expect(page.getByText(unique)).toBeVisible({ timeout: 10_000 })
    } finally {
      await page.close()
    }
  })

  test('drawer warns on discard with dirty changes', async () => {
    const page = await sharedContext.newPage()
    try {
      await ensureEditMode(page)
      await addTextBlock(page)
      await openOutlinePanel(page)
      await openLastTextBlockEditor(page)

      await page.getByLabel('Heading').fill('Will be discarded')

      page.on('dialog', (d) => { void d.dismiss() })
      // Click the close button (aria-label="close" on the ✕ button in EditDrawer).
      await page.getByRole('button', { name: 'close' }).click()

      // Drawer must stay open — Heading field still visible.
      await expect(page.getByLabel('Heading')).toBeVisible({ timeout: 5_000 })
    } finally {
      await page.close()
    }
  })

  test('reorder endpoint is reachable with auth and CSRF', async () => {
    // What this test covers: the reorder API endpoint correctly accepts an
    // authenticated session with a valid CSRF token, applies the reorder, and
    // returns 200.
    //
    // What this test does NOT cover: visual drag-and-drop via the OutlinePanel.
    // dnd-kit's PointerSensor requires real browser pointer capture and cannot
    // be reliably triggered via Playwright's synthetic pointer events.
    test.setTimeout(90_000)
    const page = await sharedContext.newPage()
    try {
      await ensureEditMode(page)

      // Add two text blocks to the DB via the OutlinePanel AddBlockMenu.
      await addTextBlock(page)
      await addTextBlock(page)

      // Hard-navigate so OutlinePanel remounts with fresh server-rendered
      // initial props (router.refresh only patches RSC; it does not reset
      // client useState, so cursor-grab rows would show only the count from
      // the previous mount without a full navigation).
      await page.goto('/', { waitUntil: 'networkidle' })
      await page.getByRole('button', { name: 'Exit edit mode' }).waitFor({ timeout: 8_000 })

      // Open panel and wait for at least 2 draggable (cursor-grab) rows.
      await openOutlinePanel(page)
      const rows = page.locator('aside .cursor-grab')
      await rows.nth(1).waitFor({ timeout: 12_000 })
      const count = await rows.count()
      expect(count).toBeGreaterThanOrEqual(2)

      // Call the reorder API directly via page.evaluate, simulating what
      // OutlinePanel's onDragEnd handler does. This exercises the full
      // authentication + CSRF verification path server-side.
      const reorderStatus = await page.evaluate(async (csrfCookieName) => {
        // Read CSRF token from cookie.
        const csrfToken = document.cookie
          .split('; ')
          .find((c) => c.startsWith(`${csrfCookieName}=`))
          ?.split('=')[1]
        if (!csrfToken) return { status: 0, error: 'no csrf cookie' }

        // Read pageId from <main data-page-id="…">. Throw if missing — that is
        // a genuine render bug, not a condition we fall back through.
        const mainEl = document.querySelector('main[data-page-id]')
        if (!mainEl) throw new Error('[reorder test] <main data-page-id> not found — app/page.tsx must render it')
        const pageId = Number(mainEl.getAttribute('data-page-id'))

        // Read block IDs and their current optimistic versions from
        // EditableBlock wrappers. Throw if fewer than 2 — the addTextBlock
        // calls above should have guaranteed at least 2 blocks.
        const blockEls = Array.from(document.querySelectorAll('[data-edit-block-id]'))
        if (blockEls.length < 2) throw new Error('[reorder test] fewer than 2 [data-edit-block-id] elements on page')

        // Reverse block order as a drag would — last becomes first.
        const blocks = [...blockEls].reverse().map((el) => {
          const id = Number(el.getAttribute('data-edit-block-id'))
          const versionAttr = el.getAttribute('data-edit-block-version')
          if (versionAttr === null) throw new Error(`[reorder test] [data-edit-block-version] missing on block id=${id}`)
          return { id, expectedVersion: Number(versionAttr) }
        })

        const res = await fetch('/api/cms/blocks/reorder', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrfToken,
          },
          body: JSON.stringify({ pageId, blocks }),
        })
        return { status: res.status }
      }, CSRF_COOKIE_NAME)

      expect(reorderStatus.status).toBe(200)
    } finally {
      await page.close()
    }
  })
})
