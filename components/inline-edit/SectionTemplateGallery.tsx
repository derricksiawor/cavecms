'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Image from 'next/image'
import { motion } from 'framer-motion'
import { X } from 'lucide-react'
import { csrfFetch } from '@/lib/client/csrf'
import { ALL_TEMPLATES, type SectionTemplate } from '@/lib/cms/sectionTemplates'
import { mapServerError } from '@/lib/cms/errorCopy'
import { useToast } from './Toast'
import { useRecordCommand, useUndoActions } from './UndoStackProvider'
import type { Command } from '@/lib/cms/undoStack'
import { useRouter } from 'next/navigation'

// Recursive flat-block count for a section template. The card meta
// label uses this to show "N sections · M blocks" so the operator
// can predict the OutlinePanel impact of an insert. Without this
// the card showed e.g. "3 blocks" for a template that actually
// instantiated 15 (1 section + 1 column + 3 widgets per layer, etc).
// Audit finding E3 (Chunk K).
function countTemplateBlocks(template: SectionTemplate): number {
  let n = 0
  for (const section of template.blocks) {
    n += 1
    for (const column of section.columns) {
      n += 1
      n += column.widgets.length
    }
  }
  return n
}

// Chunk J — section-template gallery modal.
//
// Industry survey informing this design (full notes at top of
// lib/cms/undoStack.ts):
//   - Notion         — public template gallery off-app; in-app the
//                      closest analogue is database templates.
//   - Webflow        — Components panel renders thumbnails of the
//                      component's first frame.
//   - Wix            — Add Section panel groups presets by category;
//                      each preset is an auto-generated PNG thumbnail
//                      of the rendered section.
//   - Figma          — Assets panel renders live thumbnails of the
//                      component frame.
//   - Google Docs    — Template gallery uses screenshot thumbnails.
//
// Our V1 picks the Wix shape (in-app section presets) and uses hand-
// drawn SVG schematics rather than live thumbnails because (a) we
// don't have a hosted render pipeline; (b) schematics communicate
// "this is a starter shape, customize it" better than a fully-styled
// thumbnail; (c) bundle cost is ~600 B per SVG.
//
// Behaviour
// ─────────
//   - Backdrop click closes (no focus restore — operator already chose
//     a target with their click).
//   - Esc closes (with focus restore to the element that opened the
//     gallery).
//   - Tab cycles inside the modal (focus trap).
//   - Insert: POST /api/cms/templates/instantiate → toast with inline
//     Undo button (5s window) → router.refresh() pulls the new tree.
//   - Insert participates in the undo stack: a single ⌘Z removes the
//     entire instantiated tree (children cascade via the existing
//     DELETE soft-delete recursive CTE).

const TITLE_ID = 'cavecms-section-template-gallery-title'

interface Props {
  pageId: number
  afterBlockId?: number
  /** Explicit focus target for close. When provided, overrides the
   *  document.activeElement snapshot — callers that mount the
   *  gallery AS another modal closes (slash-palette → gallery
   *  handoff) need to pass the original opener's focus target,
   *  because by the time the gallery mount-effect runs, the
   *  outgoing modal has already unmounted and activeElement is
   *  document.body. Post-agent-review D1 (Chunk K). */
  returnFocus?: HTMLElement | null
  onClose: () => void
}

export function SectionTemplateGallery({ pageId, afterBlockId, returnFocus, onClose }: Props) {
  const toast = useToast()
  const recordCommand = useRecordCommand()
  const { runUndo } = useUndoActions()
  const router = useRouter()

  const [busyTemplateId, setBusyTemplateId] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const firstFocusableRef = useRef<HTMLButtonElement | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  // Snapshot the focus target on mount so Esc / explicit close can
  // return focus to the element that opened the gallery (matches
  // SlashCommandProvider's focus-restore semantics for parity).
  // Explicit `returnFocus` prop wins when provided — the slash-palette
  // → gallery handoff requires this because the palette unmounts as
  // the gallery mounts (activeElement → body, prior snapshot was
  // useless). D1 (Chunk K).
  useEffect(() => {
    returnFocusRef.current = returnFocus ?? ((document.activeElement as HTMLElement) ?? null)
    // Defer the focus call one rAF past portal mount so Safari doesn't
    // drop it (same Safari rationale as SlashCommandPalette).
    const raf = requestAnimationFrame(() => {
      firstFocusableRef.current?.focus()
    })
    return () => {
      cancelAnimationFrame(raf)
      const target = returnFocusRef.current
      if (target && document.contains(target)) {
        try {
          target.focus()
        } catch {
          /* ignore — Safari edge case */
        }
      }
    }
    // `returnFocus` is read ONCE here at mount + then mirrored by
    // the effect below so the ref tracks subsequent prop changes
    // without re-firing the cleanup-restore (which would refocus the
    // OLD target). Adding `returnFocus` to deps would cause the
    // cleanup to fire on every prop change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep returnFocusRef in sync with the prop across re-renders
  // WITHOUT re-running the mount/unmount focus dance above. Covers
  // the AnimatePresence re-entry case (host's `{openState && (...)}`
  // unmount can be deferred during an exit animation; if `open()` is
  // called again BEFORE the exit completes, the component instance
  // is reused, the empty-deps effect above doesn't re-fire, and the
  // FIRST opener's returnFocus would stick. Post-round-2 NEW-3 /
  // Scenario 4.
  //
  // Truthy guard (NOT `!== undefined`): the host passes
  // `returnFocus={openState.returnFocus ?? null}`, so the prop is
  // always non-undefined. A blanket `!== undefined` write would
  // clobber the mount effect's `?? document.activeElement` fallback
  // for callers that DIDN'T pass returnFocus (OutlinePanel +
  // EmptyState), breaking their focus restoration. Only mirror when
  // the caller passes a real element.
  useEffect(() => {
    if (returnFocus) {
      returnFocusRef.current = returnFocus
    }
  }, [returnFocus])

  // Esc + focus trap.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const focusables = panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (focusables.length === 0) return
      const first = focusables[0]!
      const last = focusables[focusables.length - 1]!
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (active === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown, { capture: true })
    return () =>
      document.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [onClose])

  const handleInsert = useCallback(
    async (template: SectionTemplate) => {
      if (busyTemplateId) return
      setBusyTemplateId(template.id)
      try {
        const body: Record<string, unknown> = {
          pageId,
          templateId: template.id,
        }
        if (typeof afterBlockId === 'number') body.afterBlockId = afterBlockId
        const res = await csrfFetch('/api/cms/templates/instantiate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string }
          toast.error(mapServerError(j.error, "We couldn't add that layout. Refresh the page and try again."))
          return
        }
        const data = (await res.json().catch(() => ({}))) as {
          rootBlockId?: number
          createdBlockIds?: number[]
          positionFallback?: boolean
        }
        const rootId = data.rootBlockId
        const allIds = data.createdBlockIds ?? []
        if (typeof rootId !== 'number') {
          toast.error("That layout was added but didn't load cleanly — refreshing to show it.")
          return
        }
        // Build the undo command. Inverse is a DELETE of the root
        // section — its children cascade via the soft-delete recursive
        // CTE in DELETE /api/cms/blocks/[id]. Forward (redo) re-runs
        // the instantiate with the same template id.
        const cmd: Command = {
          kind: 'instantiate-template',
          label: `Inserted ${template.name}`,
          timestamp: Date.now(),
          forward: {
            method: 'POST',
            path: '/api/cms/templates/instantiate',
            body,
            expects: 201,
          },
          inverse: {
            method: 'DELETE',
            path: `/api/cms/blocks/${rootId}`,
            expects: 200,
          },
          captures: {
            rootBlockId: rootId,
            createdBlockIds: allIds,
            templateId: template.id,
          },
        }
        recordCommand(cmd)
        router.refresh()
        // Surface the position-fallback signal so the operator
        // understands why the template landed at the page tail rather
        // than at their requested insertion point.
        if (data.positionFallback) {
          toast.info(
            'Inserted at bottom — couldn’t fit at the requested position.',
          )
        }
        toast.success(`Inserted ${template.name}`, {
          label: 'Undo',
          // Routes through runUndo (cursor-aware) so a subsequent ⌘Z
          // targets the next command on the stack, not the just-undone
          // template insert.
          onClick: () => void runUndo(),
        })
        onClose()
      } finally {
        setBusyTemplateId(null)
      }
    },
    [pageId, afterBlockId, busyTemplateId, toast, recordCommand, runUndo, router, onClose],
  )

  // ALL_TEMPLATES is module-scope Object.freeze()d — no useMemo needed.
  const sorted = ALL_TEMPLATES

  // Exit animation is owned by SectionTemplateGalleryHost's
  // AnimatePresence (it controls the conditional mount). Here we just
  // animate IN — exit happens after the host unmounts this subtree.
  return createPortal(
    <>
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18, ease: [0.2, 0.7, 0.2, 1] }}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
        className="fixed inset-0 z-[95] flex items-start justify-center bg-near-black/60 backdrop-blur-sm px-4 pt-[10vh] motion-reduce:transition-none"
      >
        <motion.div
          ref={panelRef}
          onMouseDown={(e) => e.stopPropagation()}
          initial={{ opacity: 0, y: 12, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.98 }}
          transition={{ duration: 0.22, ease: [0.2, 0.7, 0.2, 1] }}
          className="w-full max-w-[920px] overflow-hidden rounded-2xl border border-cream-50/12 bg-near-black/[0.97] shadow-[0_30px_70px_-20px_rgba(0,0,0,0.7)] motion-reduce:transition-none"
        >
          <header className="flex items-center justify-between border-b border-cream-50/10 px-6 py-4">
            <div>
              <h2 id={TITLE_ID} className="text-base font-semibold tracking-tight text-cream-50">
                Section templates
              </h2>
              <p className="mt-0.5 text-[12px] text-cream-50/55">
                Drop a multi-block starter onto the page. You can customise
                everything after insert.
              </p>
            </div>
            <button
              ref={firstFocusableRef}
              type="button"
              onClick={onClose}
              aria-label="Close gallery"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full text-cream-50/55 transition-colors hover:bg-cream-50/10 hover:text-cream-50 focus-visible:bg-cream-50/10 focus-visible:outline-none"
            >
              <X size={16} strokeWidth={2} />
            </button>
          </header>

          <div className="max-h-[70vh] overflow-y-auto px-6 py-5">
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {sorted.map((template) => {
                const busy = busyTemplateId === template.id
                return (
                  <li key={template.id}>
                    <button
                      type="button"
                      onClick={() => void handleInsert(template)}
                      disabled={busy || busyTemplateId !== null}
                      aria-label={`Insert ${template.name}`}
                      className="group flex w-full min-h-[44px] flex-col overflow-hidden rounded-xl border border-cream-50/12 bg-near-black/40 text-left transition-all hover:border-copper-300/60 hover:bg-near-black/60 focus-visible:border-copper-300 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <div className="relative aspect-[16/9] w-full bg-cream-50/[0.04]">
                        <Image
                          src={template.previewImage}
                          alt=""
                          fill
                          sizes="(max-width: 640px) 100vw, 440px"
                          className="object-cover"
                        />
                      </div>
                      <div className="flex flex-col gap-1 px-4 py-3">
                        <span className="text-sm font-semibold text-cream-50">
                          {template.name}
                        </span>
                        <span className="text-[12px] leading-relaxed text-cream-50/55">
                          {template.description}
                        </span>
                        <span className="mt-2 text-[10px] uppercase tracking-[0.18em] text-copper-300/80">
                          {busy
                            ? 'Inserting…'
                            : (() => {
                                const sections = template.blocks.length
                                const blocks = countTemplateBlocks(template)
                                return `${sections} section${sections === 1 ? '' : 's'} · ${blocks} block${blocks === 1 ? '' : 's'}`
                              })()}
                        </span>
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        </motion.div>
      </motion.div>
    </>,
    document.body,
  )
}
