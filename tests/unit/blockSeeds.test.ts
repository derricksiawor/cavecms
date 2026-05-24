import { describe, it, expect } from 'vitest'
import {
  SEED_DATA,
  SEED_ENTRIES,
  type SeedBlockType,
} from '@/lib/cms/blockSeeds'
import { parseBlockData } from '@/lib/cms/block-registry'

// Round-trip every seed payload through its widget's Zod schema. This
// is the CI pin promised in lib/cms/blockSeeds.ts — when a new widget
// type adds a required field to its schema (e.g. a new `level` on
// Heading), the matching SEED_DATA entry MUST update or this test
// fails at build time. Without this pin, the four picker UIs that
// POST a seed would 422 silently and the operator would see "Add
// failed" with no path forward.
//
// Chunk G change: SeedEntry now carries an optional `data?:` override
// so two picker entries can share a block_type (e.g. Counter and
// Stats Row both seed `stats_row` with different defaults). The
// round-trip uses entry.data when present, falling back to
// SEED_DATA[entry.type] otherwise. Duplicate types in SEED_ENTRIES
// are NO LONGER an error — but every distinct type must still have
// a SEED_DATA fallback, and every label must be unique (it's used
// as the React key + busy-state identifier in the pickers).

describe('blockSeeds round-trip', () => {
  for (const entry of SEED_ENTRIES) {
    it(`SEED entry "${entry.label}" parses cleanly through parseBlockData(${entry.type})`, () => {
      const raw = entry.data ?? SEED_DATA[entry.type]
      expect(raw).toBeDefined()
      // parseBlockData throws on Zod failure — wrapping in expect(...).not.toThrow
      // surfaces the actual error in test output if a seed drifts.
      expect(() => parseBlockData(entry.type, raw)).not.toThrow()
    })
  }

  it('SEED_ENTRIES unique types and SEED_DATA keys cover the same set', () => {
    const entryTypes = Array.from(new Set(SEED_ENTRIES.map((e) => e.type))).sort()
    const dataTypes = (Object.keys(SEED_DATA) as SeedBlockType[]).sort()
    expect(entryTypes).toEqual(dataTypes)
  })

  it('every entry has a unique label (used as React key + busy id in pickers)', () => {
    const labels = SEED_ENTRIES.map((e) => e.label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('SEED_DATA fallback payload parses for every distinct block type', () => {
    for (const type of Object.keys(SEED_DATA) as SeedBlockType[]) {
      const raw = SEED_DATA[type]
      expect(() => parseBlockData(type, raw)).not.toThrow()
    }
  })
})
