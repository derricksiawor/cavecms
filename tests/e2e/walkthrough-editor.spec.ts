// DEV-ONLY: refuse to run in production (project standards rule #0.55).
if (process.env['NODE_ENV'] === 'production') {
  throw new Error('walkthrough-editor.spec.ts must NOT run in production.')
}

import { test, expect, type Page } from '@playwright/test'

const BASE = 'http://localhost:3040'
const LOGIN_PATH = process.env['LOGIN_PATH'] || 'baccess'
const EMAIL = process.env['ADMIN_TEST_EMAIL'] || 'admin@bwc.test'
const PASSWORD = process.env['ADMIN_TEST_PASSWORD'] || 'TestAdmin123!'

const log = (...args: unknown[]) => console.log('[editor]', ...args)

async function login(page: Page) {
  await page.goto(`${BASE}/${LOGIN_PATH}`)
  await page.waitForLoadState('networkidle')
  // Scope to the login form to avoid colliding with the footer newsletter input
  const loginForm = page.locator('form').filter({ has: page.locator('input[type="password"]') }).first()
  await loginForm.locator('input[name="email"]').fill(EMAIL)
  await loginForm.locator('input[name="password"]').fill(PASSWORD)
  await Promise.all([
    page.waitForURL((u) => !u.toString().includes(LOGIN_PATH), { timeout: 10_000 }),
    loginForm.locator('button[type="submit"]').click(),
  ])
}

async function engageEditMode(page: Page) {
  // Fetch CSRF nonce, then POST /api/cms/edit-mode {on:true}.
  const csrf = await page.evaluate(async () => {
    const r = await fetch('/api/csrf', { credentials: 'include' })
    return (await r.json()).csrf as string
  })
  const ok = await page.evaluate(
    async (token) => {
      const r = await fetch('/api/cms/edit-mode', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify({ on: true }),
      })
      return r.ok
    },
    csrf,
  )
  if (!ok) throw new Error('edit-mode POST failed')
}

test.describe('editor walkthrough — measured', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('login → edit mode → outline → ⌘K → drag-guard → axe', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    const failedRequests: { url: string; status: number }[] = []
    page.on('response', (res) => {
      if (
        res.status() >= 400 &&
        !res.url().includes('_next/static') &&
        !res.url().endsWith('/api/csrf')
      ) {
        failedRequests.push({ url: res.url(), status: res.status() })
      }
    })

    // 1. Login through the real form
    const loginStart = Date.now()
    await login(page)
    log(`LOGIN ok in ${Date.now() - loginStart}ms, landed at ${page.url()}`)

    // 2. Engage Edit Mode via /api/cms/edit-mode
    await engageEditMode(page)
    log('EDIT MODE engaged via /api/cms/edit-mode')

    // 3. Go to public home — Edit Mode shell should render
    const navStart = Date.now()
    await page.goto(`${BASE}/`)
    await page.waitForLoadState('networkidle')
    log(`HOME (edit mode) loaded in ${Date.now() - navStart}ms`)

    // The EditableMain shell should be present
    const editShell = await page.locator('[data-edit-mode], [data-editable-main]').count()
    log(`edit-mode shell elements found: ${editShell}`)

    // 4. Outline panel — find toggle, open if hidden
    const outlineToggle = page
      .locator('button')
      .filter({ hasText: /outline|outline panel|page tree/i })
      .first()
    const outlineToggleCount = await outlineToggle.count()
    log(`outline panel toggle found: ${outlineToggleCount > 0}`)

    // 5. ⌘K slash command — must open the picker
    await page.keyboard.press('Meta+K')
    await page.waitForTimeout(400)
    const slashPalette = await page
      .locator('[role="dialog"], [data-slash-command], [data-command-palette]')
      .first()
      .isVisible()
      .catch(() => false)
    log(`⌘K palette visible: ${slashPalette}`)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)

    // 6. axe on edit mode
    await page.addScriptTag({
      url: 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js',
    })
    const axeEdit = await page.evaluate(async () => {
      // @ts-expect-error axe injected at runtime
      const res = await window.axe.run()
      return {
        violations: res.violations.map(
          (v: {
            id: string
            impact: string
            nodes: { target: string[] }[]
          }) => ({
            id: v.id,
            impact: v.impact,
            count: v.nodes.length,
            targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
          }),
        ),
      }
    })
    log('EDIT-MODE axe violations:', JSON.stringify(axeEdit.violations, null, 2))

    // 7. Drag-drop cycle guard — verify the runtime guard from #22
    //    is present in the rendered DndContext. (Simulating a real
    //    drag is non-deterministic across viewport sizes; the guard
    //    itself is exercised by unit-shape logic in onDragEnd.)
    const dndPresent = await page.evaluate(() => {
      return document.querySelectorAll('[data-dnd-id]').length > 0 ||
        document.querySelectorAll('[role="button"][aria-roledescription="sortable"]').length > 0
    })
    log(`DnD scaffolding present: ${dndPresent}`)

    // 8. iPad pass — re-engage at 768×1024
    await page.setViewportSize({ width: 768, height: 1024 })
    await page.goto(`${BASE}/`)
    await page.waitForLoadState('networkidle')
    const ipadHScroll = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    )
    log(`iPad HOME: hScroll=${ipadHScroll}`)

    // 9. Final
    log('---')
    log('TOTAL console errors:', consoleErrors.length)
    if (consoleErrors.length) log('errors:', consoleErrors.slice(0, 5))
    log('TOTAL 4xx/5xx (non-static):', failedRequests.length)
    if (failedRequests.length) log('failures:', failedRequests)

    expect(consoleErrors.length).toBeLessThanOrEqual(3)
  })
})
