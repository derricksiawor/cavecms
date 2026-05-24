import { describe, it, expect } from 'vitest'
import { capAuditDiff, AUDIT_DIFF_CAP, type DiffOp } from '@/lib/cms/saveBlock'

describe('capAuditDiff', () => {
  it('returns the raw patch when serialized size is at or under the cap', () => {
    const tiny: DiffOp[] = [
      { type: 'CHANGE', path: ['title'] },
      { type: 'REMOVE', path: ['cta', 'href'] },
    ]
    const out = capAuditDiff(tiny)
    expect(out).toEqual(tiny)
  })

  it('returns a truncation marker when the serialized size exceeds 64KB', () => {
    // Synthesize >64KB by pushing thousands of CHANGE ops whose payload is
    // dominated by the path field (microdiff's actual output shape uses
    // strings here, so JSON.stringify length grows linearly).
    const huge: DiffOp[] = []
    const filler = 'x'.repeat(60)
    for (let i = 0; i < 2000; i++) {
      huge.push({ type: 'CHANGE', path: [`segment-${filler}-${i}`] })
    }
    expect(JSON.stringify(huge).length).toBeGreaterThan(AUDIT_DIFF_CAP)
    const out = capAuditDiff(huge)
    expect(out).toMatchObject({
      truncated: true,
      byteSize: expect.any(Number),
      opCount: 2000,
      opKinds: expect.arrayContaining(['CHANGE']),
    })
  })

  it('summary opKinds dedups the three microdiff op types', () => {
    const mixed: DiffOp[] = []
    const filler = 'y'.repeat(60)
    // Inflate past the cap with all three kinds represented.
    for (let i = 0; i < 700; i++) {
      mixed.push({ type: 'CREATE', path: [`a-${filler}-${i}`] })
      mixed.push({ type: 'CHANGE', path: [`b-${filler}-${i}`] })
      mixed.push({ type: 'REMOVE', path: [`c-${filler}-${i}`] })
    }
    expect(JSON.stringify(mixed).length).toBeGreaterThan(AUDIT_DIFF_CAP)
    const out = capAuditDiff(mixed)
    expect(out).toMatchObject({
      truncated: true,
      opKinds: expect.arrayContaining(['CREATE', 'CHANGE', 'REMOVE']),
    })
    expect((out as { opKinds: string[] }).opKinds).toHaveLength(3)
  })

  it('preserves zero-op patches at and below the cap', () => {
    expect(capAuditDiff([])).toEqual([])
  })
})
