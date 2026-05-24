import { describe, it, expect } from 'vitest'
import {
  push,
  peekUndo,
  peekRedo,
  applyUndo,
  applyRedo,
  applyExec,
  clear,
  canUndo,
  canRedo,
  EMPTY_STACK,
  STACK_LIMIT,
  type Command,
} from '@/lib/cms/undoStack'

// Pure data-layer tests for the chunk J undo/redo stack. No HTTP, no
// React, no DOM — the executor (UndoRedoController.tsx) tests the
// integration path separately. These tests pin the stack semantics:
//
//   • push truncates the redo portion
//   • undo/redo cursor moves are reciprocal
//   • cap at STACK_LIMIT drops from the head, not the tail
//   • empty-stack undo/redo are no-ops (return same state)
//   • applyExec rebinds captures on a redo without disturbing cursor

function mk(
  label: string,
  kind: Command['kind'] = 'add',
  captures: Record<string, unknown> = {},
): Command {
  return {
    kind,
    label,
    timestamp: 0,
    forward: { method: 'POST', path: '/forward', expects: 201 },
    inverse: { method: 'DELETE', path: '/inverse', expects: 204 },
    captures,
  }
}

describe('undoStack', () => {
  describe('push', () => {
    it('appends to an empty stack and sets cursor to 0', () => {
      const s = push(EMPTY_STACK, mk('A'))
      expect(s.commands.map((c) => c.label)).toEqual(['A'])
      expect(s.cursor).toBe(0)
    })

    it('appends a second command and advances cursor', () => {
      let s = push(EMPTY_STACK, mk('A'))
      s = push(s, mk('B'))
      expect(s.commands.map((c) => c.label)).toEqual(['A', 'B'])
      expect(s.cursor).toBe(1)
    })

    it('truncates the redo portion after an undo + push', () => {
      // A, B → undo → cursor=0 (B is redo-able) → push C → B should be
      // dropped and C lands at index 1.
      let s = push(EMPTY_STACK, mk('A'))
      s = push(s, mk('B'))
      s = applyUndo(s)
      expect(s.cursor).toBe(0)
      s = push(s, mk('C'))
      expect(s.commands.map((c) => c.label)).toEqual(['A', 'C'])
      expect(s.cursor).toBe(1)
    })

    it('truncates EVERY pending redo command, not just the next one', () => {
      // A, B, C, D → undo twice (cursor=1) → push E → C + D should both
      // be discarded (text-editor behaviour — entering a new mutation
      // path forfeits the old redo branch).
      let s = EMPTY_STACK
      for (const lbl of ['A', 'B', 'C', 'D']) s = push(s, mk(lbl))
      s = applyUndo(s)
      s = applyUndo(s)
      expect(s.cursor).toBe(1)
      s = push(s, mk('E'))
      expect(s.commands.map((c) => c.label)).toEqual(['A', 'B', 'E'])
      expect(s.cursor).toBe(2)
    })

    it('caps the stack at STACK_LIMIT and drops the OLDEST entry', () => {
      let s = EMPTY_STACK
      for (let i = 0; i < STACK_LIMIT + 5; i += 1) {
        s = push(s, mk(`c${i}`))
      }
      expect(s.commands).toHaveLength(STACK_LIMIT)
      // First 5 (c0..c4) dropped; c5 is now at the head.
      expect(s.commands[0]?.label).toBe('c5')
      expect(s.commands[STACK_LIMIT - 1]?.label).toBe(`c${STACK_LIMIT + 4}`)
      expect(s.cursor).toBe(STACK_LIMIT - 1)
    })
  })

  describe('undo / redo cursor math', () => {
    it('undo decrements cursor when there is something to undo', () => {
      let s = push(EMPTY_STACK, mk('A'))
      expect(s.cursor).toBe(0)
      s = applyUndo(s)
      expect(s.cursor).toBe(-1)
    })

    it('redo increments cursor when there is something to redo', () => {
      let s = push(EMPTY_STACK, mk('A'))
      s = applyUndo(s)
      expect(s.cursor).toBe(-1)
      s = applyRedo(s)
      expect(s.cursor).toBe(0)
    })

    it('undo/redo are reciprocal across a 4-command stack', () => {
      let s = EMPTY_STACK
      for (const lbl of ['A', 'B', 'C', 'D']) s = push(s, mk(lbl))
      expect(s.cursor).toBe(3)
      for (let i = 0; i < 4; i += 1) s = applyUndo(s)
      expect(s.cursor).toBe(-1)
      for (let i = 0; i < 4; i += 1) s = applyRedo(s)
      expect(s.cursor).toBe(3)
    })
  })

  describe('empty-stack no-ops', () => {
    it('undo on empty stack returns the same state', () => {
      const s = applyUndo(EMPTY_STACK)
      expect(s).toBe(EMPTY_STACK)
    })

    it('redo on empty stack returns the same state', () => {
      const s = applyRedo(EMPTY_STACK)
      expect(s).toBe(EMPTY_STACK)
    })

    it('redo past the tail returns same state', () => {
      const s = push(EMPTY_STACK, mk('A'))
      const s2 = applyRedo(s)
      // Cursor was already at the tail (0) — redo cannot advance.
      expect(s2.cursor).toBe(s.cursor)
      expect(s2.commands).toBe(s.commands)
    })
  })

  describe('peek', () => {
    it('peekUndo returns the command at cursor', () => {
      let s = push(EMPTY_STACK, mk('A'))
      s = push(s, mk('B'))
      expect(peekUndo(s)?.label).toBe('B')
      s = applyUndo(s)
      expect(peekUndo(s)?.label).toBe('A')
    })

    it('peekUndo returns null on empty stack', () => {
      expect(peekUndo(EMPTY_STACK)).toBeNull()
    })

    it('peekRedo returns the command at cursor+1 after an undo', () => {
      let s = push(EMPTY_STACK, mk('A'))
      s = push(s, mk('B'))
      s = applyUndo(s)
      expect(peekRedo(s)?.label).toBe('B')
    })

    it('peekRedo returns null when cursor at tail', () => {
      const s = push(EMPTY_STACK, mk('A'))
      expect(peekRedo(s)).toBeNull()
    })
  })

  describe('canUndo / canRedo', () => {
    it('reflect cursor position', () => {
      let s = EMPTY_STACK
      expect(canUndo(s)).toBe(false)
      expect(canRedo(s)).toBe(false)
      s = push(s, mk('A'))
      expect(canUndo(s)).toBe(true)
      expect(canRedo(s)).toBe(false)
      s = applyUndo(s)
      expect(canUndo(s)).toBe(false)
      expect(canRedo(s)).toBe(true)
    })
  })

  describe('applyExec', () => {
    it('rebinds captures on the command at index without moving cursor', () => {
      const s0 = push(EMPTY_STACK, mk('A', 'add', { newBlockId: 7 }))
      const s1 = applyExec(s0, 0, { captures: { newBlockId: 99 } })
      expect(s1.cursor).toBe(s0.cursor)
      expect(s1.commands[0]?.captures.newBlockId).toBe(99)
    })

    it('rebinds forward/inverse step partials', () => {
      const s0 = push(EMPTY_STACK, mk('A'))
      const s1 = applyExec(s0, 0, {
        inverse: { path: '/api/cms/blocks/99' },
      })
      expect(s1.commands[0]?.inverse.path).toBe('/api/cms/blocks/99')
      // Other fields preserved.
      expect(s1.commands[0]?.inverse.method).toBe('DELETE')
    })

    it('out-of-range index is a no-op (returns same reference)', () => {
      const s0 = push(EMPTY_STACK, mk('A'))
      const s1 = applyExec(s0, 5, { captures: { x: 1 } })
      expect(s1).toBe(s0)
    })

    it('produces a new commands array reference so React picks up the change', () => {
      const s0 = push(EMPTY_STACK, mk('A', 'add', { newBlockId: 7 }))
      const s1 = applyExec(s0, 0, { captures: { newBlockId: 99 } })
      expect(s1.commands).not.toBe(s0.commands)
    })
  })

  describe('clear', () => {
    it('returns EMPTY_STACK regardless of prior state', () => {
      let s = EMPTY_STACK
      for (const lbl of ['A', 'B', 'C']) s = push(s, mk(lbl))
      const cleared = clear(s)
      expect(cleared.commands).toHaveLength(0)
      expect(cleared.cursor).toBe(-1)
    })
  })

  describe('scenario: undo, push, redo blocked', () => {
    // Real-world flow: operator adds A, adds B, undoes B, then adds C.
    // After this sequence, redo MUST be blocked because B was discarded
    // when C pushed. Matches every text editor in the industry survey.
    it('redo is blocked after a new push following an undo', () => {
      let s = EMPTY_STACK
      s = push(s, mk('A'))
      s = push(s, mk('B'))
      s = applyUndo(s)
      s = push(s, mk('C'))
      expect(canRedo(s)).toBe(false)
      expect(peekRedo(s)).toBeNull()
    })
  })

  describe('scenario: cap-overflow keeps cursor at tail', () => {
    // After STACK_LIMIT+N pushes the cursor must still point to the
    // tail. A regression here would mean recent commands can't be
    // undone because the cursor drifted into the trimmed-away region.
    it('cursor remains at tail after head trim', () => {
      let s = EMPTY_STACK
      for (let i = 0; i < STACK_LIMIT + 3; i += 1) s = push(s, mk(`c${i}`))
      expect(s.cursor).toBe(STACK_LIMIT - 1)
      expect(peekUndo(s)?.label).toBe(`c${STACK_LIMIT + 2}`)
    })
  })
})
