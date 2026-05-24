import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub getSetting so resolveMetadata sees a deterministic default_seo
// without touching the DB. registry-keyed responses keep the mock
// aligned with the real SettingsValue<K> shape.
vi.mock('@/lib/cms/getSettings', () => {
  return {
    getSetting: vi.fn(async (key: string) => {
      const map: Record<string, unknown> = {
        default_seo: {
          title: 'DefT',
          description: 'DefD',
          ogImagePath: '/og-default.jpg',
        },
        organization_json_ld: {
          name: 'Org',
          logoUrl: '/logo.svg',
          sameAs: [],
        },
        contact_info: {
          phone: '1',
          email: 'e@e.com',
          address: 'A',
          hours: 'H',
        },
        footer: { tagline: 't', columns: [] },
        social_links: [],
      }
      return map[key]
    }),
  }
})

import { resolveMetadata } from '@/lib/seo/resolve'
import { organizationLd, residenceLd, breadcrumbLd } from '@/lib/seo/jsonLd'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('resolveMetadata fallback chain', () => {
  it('uses entity-level title when provided', async () => {
    const m = await resolveMetadata({ title: 'Entity', canonicalPath: '/x' })
    expect(m.title).toBe('Entity')
    expect(m.openGraph?.title).toBe('Entity')
  })

  it('falls back to fallbackTitle when entity is null', async () => {
    const m = await resolveMetadata({
      title: null,
      fallbackTitle: 'FB',
      canonicalPath: '/x',
    })
    expect(m.title).toBe('FB')
  })

  it('falls back to default_seo.title when both are absent', async () => {
    const m = await resolveMetadata({ canonicalPath: '/x' })
    expect(m.title).toBe('DefT')
    expect(m.description).toBe('DefD')
  })

  it('treats empty string as absent for title and description', async () => {
    const m = await resolveMetadata({
      title: '   ',
      description: '',
      fallbackTitle: 'FB',
      canonicalPath: '/x',
    })
    expect(m.title).toBe('FB')
    expect(m.description).toBe('DefD')
  })

  it('sets canonical from canonicalPath', async () => {
    const m = await resolveMetadata({ canonicalPath: '/about' })
    expect(m.alternates?.canonical).toBe('/about')
  })

  it('uses default ogImagePath when entity has none', async () => {
    const m = await resolveMetadata({ canonicalPath: '/x' })
    expect(m.openGraph?.images).toBeTruthy()
  })
})

describe('JSON-LD builders', () => {
  it('organizationLd emits Organization with address + contact', async () => {
    const ld = await organizationLd()
    expect(ld['@type']).toBe('Organization')
    expect(ld.name).toBe('Org')
    expect((ld.address as { streetAddress: string }).streetAddress).toBe('A')
  })

  it('residenceLd uses absolute URL', () => {
    const ld = residenceLd({ name: 'X', slug: 'x', tagline: 't', heroImage: '/h.jpg' })
    expect(ld['@type']).toBe('Residence')
    expect(ld.url).toBe('https://bestworldcompany.com/projects/x')
    expect(ld.description).toBe('t')
  })

  it('breadcrumbLd indexes items from position 1', () => {
    const ld = breadcrumbLd([
      { name: 'A', url: '/a' },
      { name: 'B', url: '/b' },
    ])
    const items = ld.itemListElement as Array<{ position: number; name: string }>
    expect(items[0]!.position).toBe(1)
    expect(items[1]!.position).toBe(2)
  })
})
