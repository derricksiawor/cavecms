import { describe, it, expect } from 'vitest'
import { isValidStatusTransition } from '@/lib/cms/projectStatus'

describe('projectStatus.isValidStatusTransition', () => {
  it('allows declared forward transitions', () => {
    expect(isValidStatusTransition('coming_soon', 'under_construction')).toBe(true)
    expect(isValidStatusTransition('coming_soon', 'selling')).toBe(true)
    expect(isValidStatusTransition('under_construction', 'selling')).toBe(true)
    expect(isValidStatusTransition('under_construction', 'sold_out')).toBe(true)
    expect(isValidStatusTransition('selling', 'sold_out')).toBe(true)
  })

  it('allows reopening sold_out → selling (re-list event)', () => {
    // The only legal "backward" move — a unit cancellation puts a project
    // back on the market after it had sold out. Bookings UX depends on it.
    expect(isValidStatusTransition('sold_out', 'selling')).toBe(true)
  })

  it('rejects backward transitions to coming_soon', () => {
    expect(isValidStatusTransition('under_construction', 'coming_soon')).toBe(false)
    expect(isValidStatusTransition('selling', 'coming_soon')).toBe(false)
    expect(isValidStatusTransition('sold_out', 'coming_soon')).toBe(false)
  })

  it('rejects skipping back to under_construction', () => {
    expect(isValidStatusTransition('selling', 'under_construction')).toBe(false)
    expect(isValidStatusTransition('sold_out', 'under_construction')).toBe(false)
  })

  it('allows same-state (no-op PATCH that includes status)', () => {
    expect(isValidStatusTransition('coming_soon', 'coming_soon')).toBe(true)
    expect(isValidStatusTransition('under_construction', 'under_construction')).toBe(true)
    expect(isValidStatusTransition('selling', 'selling')).toBe(true)
    expect(isValidStatusTransition('sold_out', 'sold_out')).toBe(true)
  })

  it('rejects unknown source status', () => {
    expect(isValidStatusTransition('archived', 'selling')).toBe(false)
  })
})
