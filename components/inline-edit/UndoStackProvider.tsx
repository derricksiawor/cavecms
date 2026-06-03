'use client'

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
  type Dispatch,
  type ReactNode,
} from 'react'
import { useRouter } from 'next/navigation'
import { csrfFetch } from '@/lib/client/csrf'
import { assertNever } from '@/lib/typeUtils'
import { useToast } from './Toast'
import {
  EMPTY_STACK,
  applyExec,
  applyRedo,
  applyUndo,
  canRedo,
  canUndo,
  clear,
  peekRedo,
  peekUndo,
  push,
  type Command,
  type HttpStep,
  type UndoStackState,
} from '@/lib/cms/undoStack'

// Chunk J — React provider for the undo stack + the centralised
// executor that runs cmd.inverse / cmd.forward and commits the cursor.
//
// Why ONE provider owns both state AND executor (instead of state here
// and executor in UndoRedoController): the inline-Undo button on each
// success toast needs to invoke the SAME path the ⌘Z keyboard handler
// does — commit the cursor, refresh, surface a result toast. Earlier
// split had every inline-Undo onClick fire `csrfFetch(inverse)`
// directly without touching the cursor; the agent-review HIGH finding
// caught that a subsequent ⌘Z would then re-undo the same command
// against an already-restored row → 404/409. Centralising the executor
// here forces both surfaces through the same cursor-aware path.
//
// State shape
// ───────────
//   stack    : UndoStackState (commands[] + cursor) — from lib/cms/undoStack
//
// Action surface
// ──────────────
//   record(cmd) — push a freshly-captured command on top.
//   runUndo()   — async, executes the cursor command's inverse, commits
//                 cursor, refreshes router, surfaces toast. Used by BOTH
//                 ⌘Z (UndoRedoController) and every inline-Undo button.
//   runRedo()   — symmetric to runUndo.
//   reset()     — wipe the stack.

// ── Path allowlist for the executor ──
// The stack is in-memory and the call sites use literal strings, but
// the executor has no business invoking a path it didn't validate.
// Defence-in-depth against forged Commands (XSS sink, malicious browser
// extension dispatch). Constrains to CMS namespace.
const ALLOWED_PATH_PREFIXES = ['/api/cms/blocks', '/api/cms/templates/'] as const

function isPathAllowed(path: string): boolean {
  if (!path.startsWith('/')) return false
  return ALLOWED_PATH_PREFIXES.some((p) => path.startsWith(p))
}

interface ExecOutcome {
  ok: boolean
  body?: Record<string, unknown>
  error?: string
  staleVersion?: boolean
}

async function execStep(step: HttpStep): Promise<ExecOutcome> {
  if (!isPathAllowed(step.path)) {
    if (process.env.NODE_ENV !== 'production') {
      console.error(
        '[UndoStackProvider] refusing non-allowlisted path:',
        step.path,
      )
    }
    return { ok: false, error: 'forbidden_path' }
  }
  try {
    const init: RequestInit = { method: step.method }
    if (step.body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(step.body)
    }
    const res = await csrfFetch(step.path, init)
    if (res.status === step.expects) {
      const ctype = res.headers.get('content-type') ?? ''
      if (res.status === 204 || !ctype.includes('json')) {
        return { ok: true, body: {} }
      }
      const body = (await res.json().catch(() => ({}))) as
        | Record<string, unknown>
        | undefined
      return { ok: true, body: body ?? {} }
    }
    const j = (await res.json().catch(() => ({}))) as { error?: string }
    const staleVersion =
      res.status === 409 &&
      (j.error === 'stale_block_version' || j.error === 'stale_page_version')
    return { ok: false, error: j.error ?? `http_${res.status}`, staleVersion }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'network_error',
    }
  }
}

/** Derive the rebind patch needed to keep the NEXT round-trip targeting
 *  correct after a successful step. See chunk-J architecture notes for
 *  why each verb kind needs (or doesn't need) rebinding. */
function deriveRebind(
  cmd: Command,
  ranSide: 'forward' | 'inverse',
  body: Record<string, unknown>,
): Parameters<typeof applyExec>[2] | null {
  switch (cmd.kind) {
    case 'add':
    case 'duplicate':
    case 'paste': {
      if (ranSide !== 'forward') return null
      const newId =
        typeof body['id'] === 'number' ? (body['id'] as number) : null
      if (newId === null) return null
      return {
        captures: { newBlockId: newId },
        inverse: { path: `/api/cms/blocks/${newId}` },
      }
    }
    case 'edit-data':
    case 'edit-meta': {
      const bv =
        typeof body['blockVersion'] === 'number'
          ? (body['blockVersion'] as number)
          : null
      const pv =
        typeof body['pageVersion'] === 'number'
          ? (body['pageVersion'] as number)
          : null
      if (bv === null || pv === null) return null
      // Update BOTH sides' expected-version pair so multi-cycle
      // ⌘Z → ⌘⇧Z → ⌘Z works (agent-review HIGH finding — single-side
      // rebind would break on the third hop). The just-ran side's
      // expected-version pair carried the PRE-run value; after running,
      // the server has bumped to (bv, pv) on top of that — so the
      // next run of THIS side must also start from (bv, pv).
      const forwardBody = {
        ...(cmd.forward.body ?? {}),
        blockVersion: bv,
        pageVersion: pv,
      }
      const inverseBody = {
        ...(cmd.inverse.body ?? {}),
        blockVersion: bv,
        pageVersion: pv,
      }
      return {
        forward: { body: forwardBody },
        inverse: { body: inverseBody },
        captures: { blockVersion: bv, pageVersion: pv },
      }
    }
    case 'reorder': {
      const blocks = Array.isArray(body['blocks'])
        ? (body['blocks'] as Array<Record<string, unknown>>)
        : null
      if (!blocks) return null
      const newVersionById = new Map<number, number>()
      for (const b of blocks) {
        const id = typeof b['id'] === 'number' ? (b['id'] as number) : null
        const v =
          typeof b['version'] === 'number' ? (b['version'] as number) : null
        if (id !== null && v !== null) newVersionById.set(id, v)
      }
      const updateBody = (
        step: HttpStep,
      ): Record<string, unknown> => {
        const b = { ...(step.body ?? {}) }
        const arr = Array.isArray(b['blocks'])
          ? (b['blocks'] as Array<Record<string, unknown>>).map((row) => {
              const id =
                typeof row['id'] === 'number' ? (row['id'] as number) : null
              if (id === null) return row
              const fresh = newVersionById.get(id)
              return fresh !== undefined ? { ...row, version: fresh } : row
            })
          : b['blocks']
        b.blocks = arr
        return b
      }
      // Same rationale as edit-data — both sides' expected versions
      // advance so multi-cycle works.
      return {
        forward: { body: updateBody(cmd.forward) },
        inverse: { body: updateBody(cmd.inverse) },
      }
    }
    case 'delete-widget':
    case 'delete-container':
    case 'instantiate-template':
      if (ranSide === 'inverse' && cmd.kind === 'delete-widget') {
        const newId =
          typeof body['id'] === 'number' ? (body['id'] as number) : null
        if (newId === null) return null
        return {
          captures: { recreatedBlockId: newId },
          forward: { path: `/api/cms/blocks/${newId}` },
        }
      }
      if (ranSide === 'forward' && cmd.kind === 'instantiate-template') {
        const ids = Array.isArray(body['createdBlockIds'])
          ? (body['createdBlockIds'] as number[])
          : null
        if (!ids) return null
        return {
          captures: { createdBlockIds: ids },
          inverse:
            typeof ids[0] === 'number'
              ? { path: `/api/cms/blocks/${ids[0]}` }
              : {},
        }
      }
      return null
    default:
      // Exhaustiveness gate — a new CommandKind variant lands as a TS
      // compile error here. Without it, an unhandled variant returns
      // undefined from this function and the rebind is silently
      // skipped, breaking multi-cycle undo/redo with no diagnostic.
      return assertNever(cmd.kind)
  }
}

interface ProviderProps {
  children: ReactNode
}

type Action =
  | { type: 'record'; command: Command }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'rebind'; index: number; patch: Parameters<typeof applyExec>[2] }
  | { type: 'reset' }

function reducer(state: UndoStackState, action: Action): UndoStackState {
  switch (action.type) {
    case 'record':
      return push(state, action.command)
    case 'undo':
      return applyUndo(state)
    case 'redo':
      return applyRedo(state)
    case 'rebind':
      return applyExec(state, action.index, action.patch)
    case 'reset':
      return clear(state)
    default:
      // Exhaustiveness gate — a new Action variant lands as a TS error
      // here instead of silently returning `undefined` and crashing the
      // reducer on dispatch.
      return assertNever(action)
  }
}

interface CtxValue {
  state: UndoStackState
  dispatch: Dispatch<Action>
  /** Centralised inverse runner — used by BOTH ⌘Z and every inline-
   *  Undo toast button. Commits the cursor on success so subsequent
   *  ⌘Z presses target the next command (not the same one). */
  runUndo: () => Promise<void>
  /** Symmetric forward runner. */
  runRedo: () => Promise<void>
}

const Ctx = createContext<CtxValue | null>(null)

export function UndoStackProvider({ children }: ProviderProps) {
  const [state, dispatch] = useReducer(reducer, EMPTY_STACK)
  const toast = useToast()
  const router = useRouter()

  // Read state via ref inside the run callbacks so a keyrepeat firing
  // between dispatch and the next render commit reads the CURRENT
  // state, not a stale closure snapshot.
  const stateRef = useRef(state)
  stateRef.current = state

  const inFlightRef = useRef(false)

  const runUndo = useCallback(async () => {
    if (inFlightRef.current) return
    const live = stateRef.current
    if (live.cursor < 0) return
    const cmd = live.commands[live.cursor]
    if (!cmd) return
    const cmdIndex = live.cursor
    inFlightRef.current = true
    try {
      let out = await execStep(cmd.inverse)
      // Track whether the cron-purge fallback fired so we can suppress
      // the generic "Undone: …" success toast at the bottom (the
      // fallback emits its own more-informative toast). Without this
      // suppression the operator sees two stacked toasts for a single
      // ⌘Z.
      let purgeFallbackFired = false
      // Cron-purge fallback. After 30 days the block row is hard-deleted
      // and /restore returns `block_purged` per the server contract
      // (app/api/cms/blocks/[id]/restore/route.ts). The original delete-
      // widget command captured priorData/priorMeta/blockType/parentId/
      // pageId at delete time, so we can recover by re-creating a fresh
      // block from the snapshot. The new row gets a fresh id; we still
      // dispatch the rebind so subsequent redo targets it.
      if (
        !out.ok &&
        out.error === 'block_purged' &&
        cmd.kind === 'delete-widget'
      ) {
        const c = cmd.captures
        const blockType = typeof c['blockType'] === 'string' ? c['blockType'] : null
        const pageId = typeof c['pageId'] === 'number' ? c['pageId'] : null
        if (blockType && pageId !== null) {
          const fallbackBody: Record<string, unknown> = {
            pageId,
            kind: 'widget',
            blockType,
            data: c['priorData'] ?? {},
          }
          if (typeof c['parentId'] === 'number') {
            fallbackBody.parentId = c['parentId']
          }
          out = await execStep({
            method: 'POST',
            path: '/api/cms/blocks',
            // POST /api/cms/blocks returns 201 (not 200) — execStep
            // strict-matches the status, so 200 here would render the
            // success path as failure and surface "Couldn't undo
            // (http_201)" while the row IS created server-side. Each
            // subsequent ⌘Z would orphan another row.
            body: fallbackBody,
            expects: 201,
          })
          if (out.ok) {
            // Rebind BOTH sides of the command so a subsequent
            // ⌘⇧Z (redo) targets the freshly-created row instead of
            // re-attempting DELETE on the long-purged ORIGINAL_ID, and
            // a follow-up ⌘Z (undo of the redo) targets /restore on
            // the new id rather than the purged one. Without this,
            // every redo+undo cycle on a delete-widget that hit the
            // purge fallback would orphan a new block.
            const newId =
              typeof out.body?.['id'] === 'number'
                ? (out.body?.['id'] as number)
                : null
            if (newId !== null) {
              dispatch({
                type: 'rebind',
                index: cmdIndex,
                patch: {
                  captures: { recreatedBlockId: newId },
                  forward: { path: `/api/cms/blocks/${newId}` },
                  inverse: { path: `/api/cms/blocks/${newId}/restore` },
                },
              })
            }
            toast.info(
              `Restored from snapshot — the original was purged. Appended at end of the column.`,
            )
            purgeFallbackFired = true
          }
        }
      }
      if (!out.ok) {
        // Any failed undo is recoverable — the server state is intact. Re-sync
        // to it and tell the operator gently. NEVER surface a raw server code
        // (stale_version, drift, …) to a designer.
        toast.error('Hmm — that didn’t undo. We refreshed the page; try again.')
        dispatch({ type: 'undo' })
        router.refresh()
        return
      }
      // Skip deriveRebind on the fallback path — the rebind dispatch in
      // the fallback block above is more accurate (it sets BOTH forward
      // and inverse for the new id). deriveRebind's generic
      // 'delete-widget' inverse rebind only sets the forward path,
      // which would double-dispatch with no semantic gain.
      if (!purgeFallbackFired) {
        const patch = deriveRebind(cmd, 'inverse', out.body ?? {})
        if (patch) dispatch({ type: 'rebind', index: cmdIndex, patch })
      }
      dispatch({ type: 'undo' })
      router.refresh()
      // Suppress the generic success toast when the fallback already
      // emitted its own (more informative) toast — operator sees ONE
      // toast per gesture instead of two stacked.
      if (!purgeFallbackFired) {
        toast.success(`Undone: ${cmd.label}`)
      }
    } finally {
      inFlightRef.current = false
    }
  }, [toast, router])

  const runRedo = useCallback(async () => {
    if (inFlightRef.current) return
    const live = stateRef.current
    const idx = live.cursor + 1
    if (idx >= live.commands.length) return
    const cmd = live.commands[idx]
    if (!cmd) return
    inFlightRef.current = true
    try {
      const out = await execStep(cmd.forward)
      if (!out.ok) {
        // Recoverable; never surface a raw server code to a designer.
        toast.error('Hmm — that didn’t redo. We refreshed the page; try again.')
        dispatch({ type: 'redo' })
        router.refresh()
        return
      }
      const patch = deriveRebind(cmd, 'forward', out.body ?? {})
      if (patch) dispatch({ type: 'rebind', index: idx, patch })
      dispatch({ type: 'redo' })
      router.refresh()
      toast.success(`Redone: ${cmd.label}`)
    } finally {
      inFlightRef.current = false
    }
  }, [toast, router])

  const value = useMemo<CtxValue>(
    () => ({ state, dispatch, runUndo, runRedo }),
    [state, runUndo, runRedo],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

const PROD = process.env.NODE_ENV === 'production'

const PLACEHOLDER: CtxValue = {
  state: EMPTY_STACK,
  dispatch: () => undefined,
  runUndo: async () => undefined,
  runRedo: async () => undefined,
}

let warnedOutsideProvider = false

function useUndoCtx(): CtxValue {
  const v = useContext(Ctx)
  if (v === null) {
    if (!PROD) {
      throw new Error(
        'useUndoStack / useRecordCommand / useUndoActions called outside UndoStackProvider — wrap the consumer in EditableMain’s provider chain.',
      )
    }
    if (!warnedOutsideProvider) {
      warnedOutsideProvider = true
      console.warn(
        '[UndoStackProvider] consumer outside provider; undo will not function.',
      )
    }
    return PLACEHOLDER
  }
  return v
}

/** Returns the current stack state. */
export function useUndoStack(): UndoStackState {
  return useUndoCtx().state
}

/** Returns a stable `record(cmd)` function. */
export function useRecordCommand(): (cmd: Command) => void {
  const { dispatch } = useUndoCtx()
  return useCallback(
    (cmd) => dispatch({ type: 'record', command: cmd }),
    [dispatch],
  )
}

/** Returns the centralised runUndo / runRedo functions. Used by:
 *   - UndoRedoController (⌘Z / ⇧⌘Z keyboard handler)
 *   - Every inline-Undo toast button (so the cursor moves consistently)
 *
 *  Both functions are cursor-aware: they target whichever command is
 *  at the cursor at INVOCATION time, not at recordCommand time. This
 *  matches Gmail's "Undo send" semantics — the snackbar's Undo button
 *  reverses the most recent action, same as ⌘Z. */
export function useUndoActions() {
  const { runUndo, runRedo } = useUndoCtx()
  return useMemo(() => ({ runUndo, runRedo }), [runUndo, runRedo])
}

/** Cursor-only operations. Reset clears the stack on navigation away. */
export function useUndoCursorActions() {
  const { dispatch } = useUndoCtx()
  return useMemo(
    () => ({
      reset: () => dispatch({ type: 'reset' }),
    }),
    [dispatch],
  )
}

export function useCanUndo(): boolean {
  return canUndo(useUndoCtx().state)
}

export function useCanRedo(): boolean {
  return canRedo(useUndoCtx().state)
}

export function usePeekUndo(): Command | null {
  return peekUndo(useUndoCtx().state)
}

export function usePeekRedo(): Command | null {
  return peekRedo(useUndoCtx().state)
}
