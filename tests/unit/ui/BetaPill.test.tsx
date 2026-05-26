import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import { BetaPill, betaPillStorageKey } from '@/components/ui/BetaPill'

// BetaPill carries dismiss state in localStorage which we can't
// exercise from the node-environment unit-test pool without a DOM
// shim. The test surface here is intentionally narrow:
//   1. Storage-key shape — feature-scoped, kebab-safe, mirrors the
//      contract documented in the help doc + on the component itself.
//   2. SSR-safe rendering — renderToString must produce the un-
//      dismissed "Beta" pill markup without touching localStorage
//      (would crash in node) AND without throwing.
// Interactive dismiss/restore is covered by the Playwright walkthrough
// in PR 5 — `tests/e2e/*.spec.ts` runs against a real browser.

describe('betaPillStorageKey', () => {
  it('namespaces under cavecms.beta and suffixes .dismissed', () => {
    expect(betaPillStorageKey('ai-sparkle')).toBe(
      'cavecms.beta.ai-sparkle.dismissed',
    )
  })

  it('keeps different features distinct', () => {
    expect(betaPillStorageKey('a')).not.toBe(betaPillStorageKey('b'))
  })

  it('preserves feature key verbatim (no normalisation)', () => {
    // We intentionally don't lowercase / strip — callers are expected
    // to pass a stable kebab-case key, and silently rewriting would
    // strand previously-dismissed users on a different key.
    expect(betaPillStorageKey('Mixed_Case-1')).toBe(
      'cavecms.beta.Mixed_Case-1.dismissed',
    )
  })
})

describe('BetaPill SSR', () => {
  it('renders the full "Beta" label on the server', () => {
    const html = renderToString(<BetaPill feature="ai-sparkle" />)
    expect(html).toMatch(/Beta/)
  })

  it('renders without dismiss button when not dismissible', () => {
    const html = renderToString(<BetaPill feature="ai-sparkle" />)
    expect(html).not.toMatch(/aria-label="Dismiss the Beta indicator"/)
  })

  it('renders dismiss button when dismissible', () => {
    const html = renderToString(
      <BetaPill feature="ai-sparkle" dismissible />,
    )
    expect(html).toMatch(/aria-label="Dismiss the Beta indicator"/)
  })

  it('does not throw or read localStorage during SSR', () => {
    // If the component touched window.localStorage at render time we
    // would get a ReferenceError under node. The assertion is the
    // absence of throw.
    expect(() =>
      renderToString(<BetaPill feature="ai-page-assistant" dismissible />),
    ).not.toThrow()
  })

  it('size="md" produces taller padding than the default sm', () => {
    const smHtml = renderToString(<BetaPill feature="x" size="sm" />)
    const mdHtml = renderToString(<BetaPill feature="x" size="md" />)
    expect(smHtml).toContain('py-1')
    expect(mdHtml).toContain('py-1.5')
  })
})
