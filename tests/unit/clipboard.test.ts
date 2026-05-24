import { describe, it, expect } from 'vitest'
import {
  CLIPBOARD_SCHEMA_VERSION,
  canPaste,
  type ClipboardSlot,
} from '@/lib/cms/clipboard'

// Fixtures: minimal valid slots of each kind. Real-world slots carry
// richer payloads; these are intentionally bare so the predicate is
// tested in isolation from data-shape concerns.
const sectionSlot: ClipboardSlot = {
  version: CLIPBOARD_SCHEMA_VERSION,
  kind: 'section',
  meta: { columns: 2, background: 'cream', padding: 'md' },
  columns: [],
  widgetCount: 0,
  copiedAt: 0,
}
const columnSlot: ClipboardSlot = {
  version: CLIPBOARD_SCHEMA_VERSION,
  kind: 'column',
  meta: {},
  widgets: [],
  copiedAt: 0,
}
const widgetSlot: ClipboardSlot = {
  version: CLIPBOARD_SCHEMA_VERSION,
  kind: 'widget',
  blockType: 'heading',
  data: { text: 'A', level: 'h2' },
  meta: {},
  copiedAt: 0,
}

describe('clipboard.canPaste — kind compatibility matrix', () => {
  it('null slot rejects every target', () => {
    expect(canPaste(null, 'section')).toBe(false)
    expect(canPaste(null, 'column')).toBe(false)
    expect(canPaste(null, 'widget')).toBe(false)
  })

  it('section slot pastes only at section targets (after)', () => {
    expect(canPaste(sectionSlot, 'section')).toBe(true)
    expect(canPaste(sectionSlot, 'column')).toBe(false)
    expect(canPaste(sectionSlot, 'widget')).toBe(false)
  })

  it('column slot has no V1 paste path — every target rejects', () => {
    expect(canPaste(columnSlot, 'section')).toBe(false)
    expect(canPaste(columnSlot, 'column')).toBe(false)
    expect(canPaste(columnSlot, 'widget')).toBe(false)
  })

  it('widget slot pastes into column targets and after widget targets', () => {
    expect(canPaste(widgetSlot, 'section')).toBe(false)
    expect(canPaste(widgetSlot, 'column')).toBe(true)
    expect(canPaste(widgetSlot, 'widget')).toBe(true)
  })

  it('schema-version mismatch rejects every target (forward-compat gate)', () => {
    // Cast simulates a slot serialised by a future deploy that bumped
    // the version. In real life the slot would never narrow back to
    // ClipboardSlot, but the runtime guard still has to refuse it.
    const stale = {
      ...sectionSlot,
      version: 99 as unknown as typeof CLIPBOARD_SCHEMA_VERSION,
    }
    expect(canPaste(stale, 'section')).toBe(false)
    expect(canPaste(stale, 'column')).toBe(false)
    expect(canPaste(stale, 'widget')).toBe(false)
  })

  it('unknown target kind returns false (defence against forged calls)', () => {
    expect(
      canPaste(sectionSlot, 'invalid' as unknown as 'section'),
    ).toBe(false)
  })
})
