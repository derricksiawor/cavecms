import { describe, it, expect } from 'vitest'
import {
  SECTION_KEYS,
  EMPTY_SECTION_DATA,
  parseSectionData,
  sectionSchemas,
} from '@/lib/cms/project-section-registry'

describe('project-section-registry', () => {
  it('every EMPTY_SECTION_DATA payload parses under its schema', () => {
    // Auto-seed at create time relies on this — a failure here means
    // hydrateProject would 500 on a freshly-created project.
    for (const key of SECTION_KEYS) {
      expect(() => parseSectionData(key, EMPTY_SECTION_DATA[key])).not.toThrow()
    }
  })

  it('SECTION_KEYS has all ten declared keys in registry order', () => {
    expect(SECTION_KEYS).toEqual([
      'hero',
      'gallery',
      'floor_plans',
      'pricing',
      'amenities',
      'location',
      'brochure',
      'timeline',
      'testimonials',
      'inquiry',
    ])
    expect(Object.keys(sectionSchemas).length).toBe(10)
  })

  it('parseSectionData throws on unknown key', () => {
    expect(() => parseSectionData('not_a_section', {})).toThrow(
      /unknown_section_key/,
    )
  })

  it('hero rejects an empty alt when banner_image present', () => {
    expect(() =>
      parseSectionData('hero', {
        banner_image: { media_id: 1, alt: 'a'.repeat(321) },
      }),
    ).toThrow()
  })

  it('location rejects a non-google-maps embed URL', () => {
    expect(() =>
      parseSectionData('location', {
        map_embed_url: 'https://evil.example/embed?x=1',
        address: 'X',
        points_of_interest: [],
      }),
    ).toThrow()
  })
})
