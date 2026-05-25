// DEV-ONLY: refuse to run in production (project standards rule #0.55).
if (process.env['NODE_ENV'] === 'production') {
  throw new Error('walkthrough-customer.spec.ts must NOT run in production.')
}

import { test } from '@playwright/test'

const BASE = 'http://localhost:3040'

const log = (...args: unknown[]) => console.log('[customer]', ...args)

test.describe('customer walkthrough — measured', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('full visitor journey with axe + metrics + form submit', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    const failedRequests: { url: string; status: number }[] = []
    page.on('response', (res) => {
      if (res.status() >= 400 && !res.url().includes('_next/static')) {
        failedRequests.push({ url: res.url(), status: res.status() })
      }
    })

    // 1. Cold home
    const startNav = Date.now()
    await page.goto(`${BASE}/`)
    await page.waitForLoadState('networkidle')
    const homeNavMs = Date.now() - startNav
    const fcp = await page.evaluate(() => {
      const p = performance.getEntriesByType('paint').find((x) => x.name === 'first-contentful-paint')
      return p ? Math.round(p.startTime) : null
    })
    const h1 = await page.locator('h1').first().textContent().catch(() => null)
    const h1srOnly = await page.locator('h1').first().evaluate((el) => el.classList.contains('sr-only')).catch(() => null)
    log(`HOME: nav=${homeNavMs}ms fcp=${fcp}ms h1="${h1}" srOnly=${h1srOnly}`)

    // 2. axe-core scan via cdn injection
    await page.addScriptTag({ url: 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js' })
    const homeAxe = await page.evaluate(async () => {
      // @ts-expect-error axe injected at runtime
      const res = await window.axe.run()
      return {
        violations: res.violations.map((v: { id: string; impact: string; nodes: { target: string[] }[] }) => ({
          id: v.id, impact: v.impact, count: v.nodes.length,
          targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
        })),
      }
    })
    log('HOME axe violations:', JSON.stringify(homeAxe.violations, null, 2))

    // 3. Click into Projects
    await page.locator('header').getByRole('link', { name: 'Projects' }).click()
    await page.waitForURL('**/projects')
    await page.waitForLoadState('networkidle')
    log('PROJECTS: title=', await page.title())

    // 4. Click first project card
    const firstProject = page.locator('a[href^="/projects/"]').first()
    const projectHref = await firstProject.getAttribute('href')
    await firstProject.click()
    await page.waitForURL(`**${projectHref}`)
    await page.waitForLoadState('networkidle')
    log('PROJECT DETAIL: title=', await page.title())
    const detailH2 = await page.locator('h2').first().textContent().catch(() => null)
    log('PROJECT DETAIL: first h2=', detailH2)

    // 5. Submit the inquiry form (scoped to the form, not the footer newsletter)
    const inquiryForm = page.locator('form').filter({ has: page.locator('textarea[name="message"]') }).first()
    if (await inquiryForm.count() > 0) {
      await inquiryForm.locator('input[name="name"]').fill('Walkthrough Test')
      await inquiryForm.locator('input[name="email"]').fill('walkthrough@cavecms.test')
      await inquiryForm.locator('input[name="phone"]').fill('+233 24 000 0000')
      await inquiryForm.locator('textarea[name="message"]').fill('Automated walkthrough verification. Please ignore.')
      const submitBtn = inquiryForm.getByRole('button', { name: /Send inquiry|Submit/i })
      if (await submitBtn.count() > 0) {
        await submitBtn.click()
        await page.waitForTimeout(2000)
        const inquirySuccess = await page.locator('text=/thank|received|sent|got it/i').first().isVisible().catch(() => false)
        log('INQUIRY: submit visible-success=', inquirySuccess)
      }
    }

    // 6. Contact page — separate form
    await page.goto(`${BASE}/contact`)
    await page.waitForLoadState('networkidle')
    const contactForm = page.locator('form').filter({ has: page.locator('textarea[name="message"]') }).first()
    await contactForm.locator('input[name="name"]').fill('Walk Customer')
    await contactForm.locator('input[name="email"]').fill('customer@cavecms.test')
    await contactForm.locator('input[name="phone"]').fill('+233 24 000 1111')
    await contactForm.locator('textarea[name="message"]').fill('Hello from customer walkthrough.')
    await contactForm.getByRole('button', { name: /Send message/i }).click()
    await page.waitForTimeout(2000)
    const contactState = await page.locator('text=/thank|received|sent|success|got it/i').first().isVisible().catch(() => false)
    log('CONTACT: visible-success=', contactState)

    // 7. axe on /contact
    await page.addScriptTag({ url: 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js' })
    const contactAxe = await page.evaluate(async () => {
      // @ts-expect-error axe injected at runtime
      const res = await window.axe.run()
      return { violations: res.violations.map((v: { id: string; impact: string; nodes: { target: string[] }[] }) => ({ id: v.id, impact: v.impact, count: v.nodes.length })) }
    })
    log('CONTACT axe violations:', JSON.stringify(contactAxe.violations, null, 2))

    // 8. Keyboard journey — Tab from body, capture first 8 focus stops + ring color
    await page.goto(`${BASE}/`)
    await page.evaluate(() => document.body.focus())
    const focusStops: { tag: string; text: string; outlineColor: string }[] = []
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab')
      const stop = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null
        if (!el) return null
        const cs = getComputedStyle(el)
        return {
          tag: el.tagName,
          text: (el.innerText || el.getAttribute('aria-label') || '').slice(0, 40),
          outlineColor: cs.outlineColor,
          outlineStyle: cs.outlineStyle,
          outlineWidth: cs.outlineWidth,
          boxShadow: cs.boxShadow.slice(0, 80),
        }
      })
      if (stop) focusStops.push(stop)
    }
    log('FOCUS journey (8 stops):', JSON.stringify(focusStops, null, 2))

    // 9. Mobile viewport repeat
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${BASE}/`)
    await page.waitForLoadState('networkidle')
    const mobileHScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    const mobileH1 = await page.locator('h1').first().textContent().catch(() => null)
    log(`MOBILE HOME: hScroll=${mobileHScroll} h1="${mobileH1}"`)

    // 10. Final summary
    log('---')
    log('TOTAL console errors:', consoleErrors.length)
    if (consoleErrors.length) log('errors:', consoleErrors)
    log('TOTAL 4xx/5xx (non-static):', failedRequests.length)
    if (failedRequests.length) log('failures:', failedRequests)
  })
})
