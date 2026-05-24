import { test, expect } from '@playwright/test'

const LOGIN_PATH = process.env['LOGIN_PATH'] ?? 'baccess'

test('hidden login: wrong path returns 404', async ({ page }) => {
  const r = await page.goto('/does-not-exist', { waitUntil: 'commit' })
  expect(r?.status()).toBe(404)
})

test('unauthenticated /admin redirects to /', async ({ page }) => {
  const r = await page.goto('/admin', { waitUntil: 'commit' })
  expect(r?.url()).toMatch(/^http:\/\/localhost:3040\/?$/)
})

test('login → dashboard flow', async ({ page }) => {
  await page.goto(`/${LOGIN_PATH}`)
  await page.fill('input[name=email]', 'admin@bwc.test')
  await page.fill('input[name=password]', 'CorrectHorseBattery0!')
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST'),
    page.click('button[type=submit]'),
  ])
  expect(resp.status()).toBe(200)
  await page.waitForURL(/\/admin$/)
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
})
