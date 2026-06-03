'use client'

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  ExternalLink,
  Eye,
  AlertTriangle,
  Trash2,
  Lock,
  Plus,
  ArrowUp,
  ArrowDown,
  Copy,
  GripVertical,
  Type as TypeIcon,
  MousePointerClick,
  Quote as QuoteIcon,
  Image as ImageIcon,
  Images,
  Star,
  Layers as LayersIcon,
  type LucideIcon,
} from 'lucide-react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import clsx from 'clsx'
import { csrfFetch } from '@/lib/client/csrf'
import { Button } from '@/components/ui/Button'
import { CfSafeMailto } from '@/components/CfSafeMailto'
import { Input } from '@/components/ui/Input'
import { useToast } from '@/components/inline-edit/Toast'
import { ConfirmModal } from '@/components/admin/ConfirmModal'
import {
  RowActionsMenu,
  type RowActionItem,
} from '@/components/admin/RowActionsMenu'
import { Switch } from '@/components/inline-edit/Switch'
import { Accordion } from '@/components/inline-edit/Accordion'
import {
  PageSeoPanel,
  type AnalysisContent,
} from '@/components/seo/PageSeoPanel'
import {
  type PanelSeoMeta,
  parsePanelSeoMeta,
  isEmptySeoMeta,
} from '@/lib/cms/seoEditorFields'
import { extractFromBlocks } from '@/lib/seo/analysis/extract/blocks'
import { structuralEqual } from '@/lib/structuralEqual'
import { MediaPicker } from '@/components/inline-edit/MediaPicker'
import {
  MediaPickerProvider,
  type MediaRef,
} from '@/components/inline-edit/MediaPickerProvider'
import { formatRelativeSince } from '@/hooks/useAutoSave'
import { SLUG_RE, SLUG_MIN, SLUG_MAX } from '@/lib/cms/slug'
import { summariseBlockText } from '@/lib/ai/chatEligibility'
import { SEED_DATA } from '@/lib/cms/blockSeeds'
import { mapServerError } from '@/lib/cms/errorCopy'
import {
  readDraftBuffer,
  writeDraftBuffer,
  discardDraft,
  type BufferedDraft,
} from '@/lib/cms/draftBuffer'
import type { PageRawRow } from '@/lib/cms/types'
import type { Role } from '@/lib/auth/requireRole'

// ─── Block-card helpers ──────────────────────────────────────────────
// Map block type → Lucide icon. Default to a layered-stack icon for
// unknown types so a future block kind doesn't render an icon-less card.
const BLOCK_TYPE_ICON: Record<string, LucideIcon> = {
  // lx_* editorial primitives offered by the quick-add menu — so a
  // freshly-added block shows a meaningful card icon, not the generic
  // fallback. Every other registered block type still resolves through
  // the LayersIcon default below.
  lx_heading: TypeIcon,
  lx_text: TypeIcon,
  lx_action: MousePointerClick,
  lx_quote: QuoteIcon,
  image: ImageIcon,
  gallery: Images,
  hero: Star,
  featured_projects: Star,
}

function iconForBlock(blockType: string): LucideIcon {
  return BLOCK_TYPE_ICON[blockType] ?? LayersIcon
}

// Client-side parse + empty-bag check live in lib/cms/seoEditorFields
// (`parsePanelSeoMeta` / `isEmptySeoMeta`) — the ONE client parser shared
// with the blog + project editors (C2/C3). They produce the NORMALIZED
// shape (no `null` / empty keys) so the page editor's dirty-check is
// symmetric with the panel's clears (#3).

// Best-effort "what's in this block" excerpt for the admin editor card.
// Returns `null` if the block has no surfaceable signal (e.g. structural
// blocks like lx_divider / lx_space). The excerpt is purely cosmetic —
// never relied on for routing or storage.
//
// Collection blocks (gallery, featured projects, accordion, tabs, icon
// list, social icons) surface a count; everything else reuses
// summariseBlockText, the same chatEligibility FIELDS map that grounds
// the AI inspect_page summary — so the admin excerpt and the assistant's
// view of a block's copy stay in lockstep. summariseBlockText already
// strips HTML, collapses whitespace and truncates.
function excerptForBlock(blockType: string, data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>

  const count = (key: string, noun: string): string | null => {
    const arr = d[key]
    if (!Array.isArray(arr)) return null
    return `${arr.length} ${noun}${arr.length === 1 ? '' : 's'}`
  }

  switch (blockType) {
    case 'lx_gallery':
      return count('images', 'image')
    case 'lx_accordion':
    case 'lx_icon_list':
      return count('items', 'item')
    case 'lx_tabs':
      return count('tabs', 'tab')
    case 'lx_social_icons':
      return count('items', 'link')
  }

  const text = summariseBlockText(blockType, data, 96)
  return text.length > 0 ? text : null
}

// ─── Sortable block-row wrapper ───────────────────────────────────────
// Thin <li> wrapper that uses `useSortable` so each block in the
// admin-editor list participates in DndContext drag-and-drop reorder.
// The `<DragHandle/>` rendered inside the children gets the drag
// listeners via the `dragRef` render-prop; the rest of the <li>
// surface stays click-passive so kebab + Edit-inline buttons work as
// expected. `disabled` propagates from BlockMeta.blockKey (fixed slot)
// to lock down draggability for system-seeded blocks per spec §3.4.
function SortableBlockRow({
  id,
  disabled,
  className,
  index,
  children,
}: {
  id: number
  disabled?: boolean
  className?: string
  // Used for the stagger animation delay so the block list reads as a
  // gentle cascade on mount (Notion-like "blocks settle in") rather
  // than every row appearing simultaneously.
  index: number
  children: (args: {
    dragAttributes: ReturnType<typeof useSortable>['attributes']
    dragListeners: ReturnType<typeof useSortable>['listeners']
    isDragging: boolean
  }) => React.ReactNode
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled })
  return (
    <li
      ref={setNodeRef}
      // `data-block-row-id` lets the keyboard-shortcut handler at the
      // editor scope identify which block has focus without prop-
      // threading. Pair with tabIndex=0 below so the entire row can
      // receive Tab focus.
      data-block-row-id={id}
      tabIndex={0}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 20 : undefined,
        boxShadow: isDragging
          ? '0 24px 60px -22px rgba(5, 5, 5, 0.45)'
          : undefined,
        // Stagger the mount animation — each subsequent block delays
        // 60ms past the previous. Capped at 8 rows so a 30-block page
        // doesn't keep the operator waiting 1.8s for the last row.
        animationDelay: `${Math.min(index, 8) * 60}ms`,
      }}
      className={className}
    >
      {children({ dragAttributes: attributes, dragListeners: listeners, isDragging })}
    </li>
  )
}

// ─── Types ────────────────────────────────────────────────────────────

interface BlockMeta {
  id: number
  blockKey: string | null
  blockType: string
  position: number
  version: number
  /** Parsed block data — needed by the Duplicate action which reposts
   *  the same content under a new id. Opaque to the editor surface;
   *  the inline-edit drawer on the public page owns the shape. */
  data: unknown
}

interface AuditEntry {
  id: number
  action: string
  createdAt: Date | string
  email: string | null
}

// The dirty buffer the operator's actively editing. ALL fields are
// optional — only fields that have changed since last save go in.
// The 409 recovery banner serialises this whole shape as the `diff`
// payload in localStorage so on reload the operator can re-apply.
interface DirtyFields {
  title?: string
  slug?: string
  seoTitle?: string | null
  seoDescription?: string | null
  heroImageId?: number | null
  ogImageId?: number | null
  published?: boolean
  isHome?: boolean
  // Per-entity SEO fields (migration 0032).
  focusKeyphrase?: string | null
  robotsNoindex?: boolean
  robotsNofollow?: boolean
  canonicalUrl?: string | null
  cornerstone?: boolean
  seoScore?: number | null
  readabilityScore?: number | null
  seoMeta?: PanelSeoMeta | null
}

interface PageEditorProps {
  role: Role
  page: PageRawRow
  blocks: BlockMeta[]
  audit: AuditEntry[]
}

// ─── Component ────────────────────────────────────────────────────────

export function PageEditor(props: PageEditorProps) {
  return (
    <MediaPickerProvider>
      <PageEditorInner {...props} />
    </MediaPickerProvider>
  )
}

function PageEditorInner({ role, page, blocks, audit }: PageEditorProps) {
  const router = useRouter()
  const toast = useToast()
  const isAdmin = role === 'admin'
  const isReadOnly = role === 'viewer'

  // Server-authoritative version. Bumps after every successful PATCH;
  // the optimistic-lock token sent on the next save.
  const [version, setVersion] = useState(page.version)

  // Local form state. Bound to the inputs; the dirty diff is derived
  // from comparing each value against the loaded `page` row.
  const [title, setTitle] = useState(page.title)
  const [slug, setSlug] = useState(page.slug)
  const [seoTitle, setSeoTitle] = useState<string | null>(page.seo_title)
  const [seoDescription, setSeoDescription] = useState<string | null>(
    page.seo_description,
  )
  const [heroImageId, setHeroImageId] = useState<number | null>(
    page.hero_image_id,
  )
  const [ogImageId, setOgImageId] = useState<number | null>(page.og_image_id)
  const [published, setPublished] = useState<boolean>(page.published === 1)

  // Per-entity SEO fields (migration 0032). `page.seo_meta` is the raw
  // JSON string (MariaDB JSON ≡ LONGTEXT) — parse it defensively here on
  // the client (the server-only parseSeoMeta can't be imported into a
  // client component).
  const initialSeoMeta = useMemo(
    () => parsePanelSeoMeta(page.seo_meta),
    [page.seo_meta],
  )
  const [focusKeyphrase, setFocusKeyphrase] = useState(
    page.focus_keyphrase ?? '',
  )
  const [robotsNoindex, setRobotsNoindex] = useState(page.robots_noindex === 1)
  const [robotsNofollow, setRobotsNofollow] = useState(
    page.robots_nofollow === 1,
  )
  const [canonicalUrl, setCanonicalUrl] = useState(page.canonical_url ?? '')
  const [cornerstone, setCornerstone] = useState(page.cornerstone === 1)
  const [seoMeta, setSeoMeta] = useState<PanelSeoMeta>(initialSeoMeta)
  // Latest analysis scores, cached so a SEO save ships them too.
  const scoresRef = useRef<{ seo: number; readability: number } | null>(null)
  const onScores = useCallback((seo: number, readability: number) => {
    scoresRef.current = { seo, readability }
  }, [])

  const [seoOpen, setSeoOpen] = useState(false)
  const [savingFields, setSavingFields] = useState<Set<string>>(new Set())
  // Wall-clock time of the most recent successful save in this editor
  // session. `null` before the first save — the header pill falls back
  // to `page.updated_at` (i.e. when the server thinks the page was last
  // edited). Ticking once per 15s via the useEffect below keeps "Saved
  // 2m ago" honest without re-rendering the rest of the editor.
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const [, forceRelativeRerender] = useState(0)
  useEffect(() => {
    const t = setInterval(() => forceRelativeRerender((n) => n + 1), 15_000)
    return () => clearInterval(t)
  }, [])

  // Delete-page modal state.
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Blocks-section state: local block list (so mutations update inline
  // without a full re-fetch), kebab busy state, per-block delete confirm.
  const [blockList, setBlockList] = useState<BlockMeta[]>(blocks)
  // Sync local block state when the server-rendered props change (e.g.
  // after router.refresh()). React's setState short-circuits on
  // reference equality, so passing the new prop is enough — the
  // identity changes on every server render.
  useEffect(() => {
    setBlockList(blocks)
  }, [blocks])
  const [busyBlockId, setBusyBlockId] = useState<number | null>(null)
  const [confirmBlockDelete, setConfirmBlockDelete] = useState<BlockMeta | null>(
    null,
  )

  // 409 recovery banner state.
  const [recoveredDrafts, setRecoveredDrafts] = useState<BufferedDraft[]>([])
  const rotationToastShownRef = useRef(false)

  const dirty = useMemo<DirtyFields>(() => {
    const d: DirtyFields = {}
    if (title !== page.title) d.title = title
    if (slug !== page.slug) d.slug = slug
    if (seoTitle !== page.seo_title) d.seoTitle = seoTitle
    if (seoDescription !== page.seo_description) d.seoDescription = seoDescription
    if (heroImageId !== page.hero_image_id) d.heroImageId = heroImageId
    if (ogImageId !== page.og_image_id) d.ogImageId = ogImageId
    if (published !== (page.published === 1)) d.published = published
    return d
  }, [
    page,
    title,
    slug,
    seoTitle,
    seoDescription,
    heroImageId,
    ogImageId,
    published,
  ])

  // ── SEO-panel field diff (migration 0032) ──
  // Computed separately from `dirty` (which feeds the 409 recovery
  // buffer) so the buffered-recovery payload shape stays as it was.
  // These save via a dedicated debounced batch so rapid keyphrase /
  // toggle / schema edits coalesce into ONE PATCH + ONE version bump
  // (avoiding the 409 races a per-field blur-save would cause).
  const seoFieldsDirty = useMemo<DirtyFields>(() => {
    const d: DirtyFields = {}
    if ((focusKeyphrase || null) !== page.focus_keyphrase) {
      d.focusKeyphrase = focusKeyphrase === '' ? null : focusKeyphrase
    }
    if (robotsNoindex !== (page.robots_noindex === 1)) {
      d.robotsNoindex = robotsNoindex
    }
    if (robotsNofollow !== (page.robots_nofollow === 1)) {
      d.robotsNofollow = robotsNofollow
    }
    if ((canonicalUrl || null) !== page.canonical_url) {
      d.canonicalUrl = canonicalUrl === '' ? null : canonicalUrl
    }
    if (cornerstone !== (page.cornerstone === 1)) {
      d.cornerstone = cornerstone
    }
    if (!structuralEqual(seoMeta, initialSeoMeta)) {
      d.seoMeta = isEmptySeoMeta(seoMeta) ? null : seoMeta
    }
    return d
  }, [
    page,
    initialSeoMeta,
    focusKeyphrase,
    robotsNoindex,
    robotsNofollow,
    canonicalUrl,
    cornerstone,
    seoMeta,
  ])

  // ─── 409 recovery banner: mount-time draft enumeration ───────────────
  // Reads the HMAC-signed localStorage entries for this pageId and
  // surfaces any whose baseVersion is BEHIND the current server
  // version (otherwise the diff would conflict with the current state
  // anyway — surface only relevant entries). Session-rotation drops
  // surface a one-time toast per spec §3.5 + §11.33.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const outcome = await readDraftBuffer(page.id)
      if (cancelled) return
      if (outcome.kind === 'rotated') {
        if (!rotationToastShownRef.current) {
          rotationToastShownRef.current = true
          toast.info(
            'Recovered drafts from before this session were discarded for security.',
          )
        }
        return
      }
      if (outcome.kind === 'ok' && outcome.drafts.length > 0) {
        // Surface drafts whose baseVersion is AT-OR-BEFORE the current
        // server version. A draft buffered at the same version means
        // the operator was editing at the current state when the 409
        // hit (typically: two-tab simultaneous save where the OTHER
        // tab landed first, advancing version then back-to-current
        // before this tab reloaded); applying re-launches the work
        // from that state. A draft buffered AHEAD of the current
        // version is impossible under normal flow (the server bumps
        // version monotonically) and would represent a tampered or
        // corrupted entry — drop it.
        const relevant = outcome.drafts.filter(
          (d) => d.baseVersion <= version,
        )
        if (relevant.length > 0) setRecoveredDrafts(relevant)
      }
      // 'no-key' is silent — happens on logged-out RSC render etc.
    })()
    return () => {
      cancelled = true
    }
    // We only want this on mount + when version changes (page reload
    // after save). page.id is in scope for the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id, version])

  // ─── Save / 409 recovery write path ──────────────────────────────────
  const trackSave = (field: string) =>
    setSavingFields((prev) => new Set(prev).add(field))
  const untrackSave = (field: string) =>
    setSavingFields((prev) => {
      const next = new Set(prev)
      next.delete(field)
      return next
    })

  // Centralised PATCH. Sends ONLY the changed fields plus the current
  // optimistic-lock token. On success: bumps version, refreshes the
  // route. On 409: writes the dirty buffer to localStorage with HMAC
  // and surfaces the recovery banner on next mount; the operator's
  // local form state stays as-is so they can copy values out manually
  // if the buffer write itself failed.
  const patch = useCallback(
    async (fields: DirtyFields, fieldKey: string): Promise<void> => {
      if (Object.keys(fields).length === 0) return
      trackSave(fieldKey)
      try {
        const body = { ...fields, version }
        const r = await csrfFetch(`/api/cms/pages/${page.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (r.status === 409) {
          // 409 surfaces from FIVE distinct server codes; only
          // `stale_version` is recoverable via the draft-buffer
          // re-apply flow (the operator's edits are still meaningful
          // against the now-advanced page state). The other 409 codes
          // (system_slug_locked / cannot_unset_home / slug_in_use /
          // slug_redirect_collision / home_race_retry) describe a
          // server-state conflict that no amount of operator
          // re-application will fix — buffering would just trip the
          // SAME 409 on next mount. Route each to its specific toast
          // and SKIP the buffer write.
          let conflictCode: string | null = null
          try {
            const j = (await r.clone().json()) as { error?: unknown }
            if (typeof j.error === 'string') conflictCode = j.error
          } catch {
            // Non-JSON 409 — fall through as if `stale_version`.
          }
          switch (conflictCode) {
            case 'system_slug_locked':
              toast.error(
                'This system page’s web address can’t be renamed. Delete and re-create to change it.',
              )
              setSlug(page.slug)
              return
            case 'cannot_unset_home':
              toast.error(
                'Set another page as Home first — every site needs one Home page.',
              )
              setPublished(page.published === 1)
              return
            case 'slug_in_use':
              toast.error(
                'That web address is already in use by another page.',
              )
              setSlug(page.slug)
              return
            case 'slug_redirect_collision':
              toast.error(
                'Another page’s redirect already points at that web address.',
              )
              setSlug(page.slug)
              return
            case 'home_race_retry':
              toast.error(
                'Another admin just changed the homepage. Refresh and try again.',
              )
              return
            default:
              // `stale_version` (canonical recoverable case) or null
              // body → buffer the diff and surface the recovery banner
              // on next mount. The localStorage write may itself fail
              // (quota / no-key); the helper reports back so we surface
              // the right operator message.
              break
          }
          // Buffer the operator's unsaved edits so the recovery banner
          // can re-apply them after reload. The SEO save path lives in a
          // SEPARATE dirty bag (`seoFieldsDirty`) than the blur-save bag
          // (`dirty`); a 409 on the SEO batch must buffer the SEO fields
          // too, or the operator's keyphrase / robots / canonical /
          // schema edits are SILENTLY DROPPED (#1). Merge both bags on
          // the SEO path so nothing is lost.
          const bufferDiff: DirtyFields =
            fieldKey === 'seo' ? { ...dirty, ...seoFieldsDirty } : dirty
          const write = await writeDraftBuffer(page.id, version, bufferDiff)
          if (write.kind === 'too-large') {
            toast.error(
              'Your unsaved edits are too large to preserve locally — copy them out manually before reloading.',
            )
          } else if (write.kind === 'quota-fallback') {
            toast.error(
              'Local recovery storage is full — keep this tab open until you re-apply.',
            )
          } else if (write.kind === 'no-key') {
            toast.error(
              'Your session changed — copy any unsaved edits manually then reload.',
            )
          } else {
            toast.error(
              'Page changed in another tab — your unsaved edits are preserved. Reload to continue.',
            )
          }
          return
        }
        if (!r.ok) {
          let errCode: string | null = null
          try {
            const j = (await r.json()) as { error?: unknown }
            if (typeof j?.error === 'string') errCode = j.error
          } catch {
            // Non-JSON — fall through to generic message.
          }
          // Map a few well-known server codes to friendly copy. The
          // rest land as a generic save error.
          switch (errCode) {
            case 'slug_invalid':
              toast.error(
                'That web address is not valid. Use lowercase letters, numbers, and dashes.',
              )
              return
            case 'slug_in_use':
              toast.error(
                'That web address is already in use by another page.',
              )
              return
            case 'slug_redirect_collision':
              toast.error(
                'Another page’s redirect already points at that web address.',
              )
              return
            case 'system_slug_locked':
              toast.error(
                'This system page’s web address can’t be renamed. Delete and re-create to change it.',
              )
              // Snap the slug input back to the server value.
              setSlug(page.slug)
              return
            case 'cannot_unset_home':
              toast.error(
                'Set another page as Home first — every site needs one Home page.',
              )
              setPublished(page.published === 1)
              return
            case 'home_race_retry':
              toast.error(
                'Another admin just changed the homepage. Refresh and try again.',
              )
              return
            case 'forbidden':
              toast.error(
                'You don’t have permission to change that field. An admin must save it.',
              )
              return
            default:
              toast.error('That didn’t save. Try again in a moment.')
              return
          }
        }
        const j = (await r.json()) as { version: number }
        setVersion(j.version)
        setLastSavedAt(Date.now())
        toast.success('Saved.')
        router.refresh()
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : 'Network error — try again.',
        )
      } finally {
        untrackSave(fieldKey)
      }
    },
    [dirty, seoFieldsDirty, page, router, toast, version],
  )

  // ─── Blur-save serializer (migration 0032 race fix, #1) ──────────────
  // A field-blur save (title / slug / hero / og / publish) must not fire
  // while the SEO batch — or any other save — is in flight: they share
  // one `version` token, so an overlapping PATCH 409s. `requestBlurSave`
  // is the single entry point for every blur handler: it fires
  // immediately when no save is running, otherwise it QUEUES the
  // (fields, key) so the edit is NEVER dropped. The flush effect below
  // drains the queue once the in-flight save settles (savingFields →
  // empty) against the now-fresh version. Last-write-wins per fieldKey
  // (a Map) so rapid re-blurs of the same field coalesce.
  const pendingBlurRef = useRef<Map<string, DirtyFields>>(new Map())
  const requestBlurSave = useCallback(
    (fields: DirtyFields, fieldKey: string) => {
      if (savingFields.size > 0) {
        pendingBlurRef.current.set(fieldKey, fields)
        return
      }
      void patch(fields, fieldKey)
    },
    [savingFields, patch],
  )
  // Drain queued blur-saves once every in-flight save has settled. Fires
  // them one at a time (the first dispatch repopulates savingFields, so
  // the next drain waits for it) — serial, no overlap, no lost edits.
  useEffect(() => {
    if (savingFields.size > 0) return
    if (pendingBlurRef.current.size === 0) return
    const [key, fields] = pendingBlurRef.current.entries().next().value as [
      string,
      DirtyFields,
    ]
    pendingBlurRef.current.delete(key)
    void patch(fields, key)
  }, [savingFields, patch])

  // ─── SEO-panel debounced batch save (migration 0032) ─────────────────
  // Coalesce rapid keyphrase / toggle / canonical / schema edits into a
  // single PATCH so we never fire a burst that 409s on its own version
  // bumps. 900ms after the last change (and not while a save is already
  // in flight), ship the whole SEO diff + the latest cached scores. The
  // latest diff is held in a ref so the timer always sends current
  // values even if it was scheduled an edit ago.
  const seoDirtyRef = useRef(seoFieldsDirty)
  useEffect(() => {
    seoDirtyRef.current = seoFieldsDirty
  }, [seoFieldsDirty])
  const seoDirtyCount = Object.keys(seoFieldsDirty).length
  // Single in-flight gate. The page editor saves SEO through this
  // debounced batch AND saves title / slug / hero / og / publish via
  // per-field blur. All share one `version` token with no DB-level
  // mutex, so an overlapping send 409s. To serialize WITHOUT losing
  // edits, the SEO batch holds off while ANY save is in flight (not just
  // a prior 'seo' one) — a blur-save in progress will bump `version` +
  // router.refresh(), which re-renders this effect (savingFields shrinks
  // back to 0) and re-arms the SEO batch against the fresh version (#1).
  const savesInFlight = savingFields.size > 0
  useEffect(() => {
    if (isReadOnly) return
    if (seoDirtyCount === 0) return
    if (savesInFlight) return
    const t = setTimeout(() => {
      const diff = seoDirtyRef.current
      if (Object.keys(diff).length === 0) return
      const payload: DirtyFields = { ...diff }
      if (scoresRef.current) {
        payload.seoScore = scoresRef.current.seo
        payload.readabilityScore = scoresRef.current.readability
      }
      void patch(payload, 'seo')
    }, 900)
    return () => clearTimeout(t)
    // Re-arm whenever the diff content changes OR an in-flight save
    // clears (savesInFlight flips false) — the gate above prevents
    // overlap with any concurrent blur-save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seoDirtyCount, focusKeyphrase, robotsNoindex, robotsNofollow, canonicalUrl, cornerstone, seoMeta, isReadOnly, savesInFlight])

  // ─── Field-blur save handlers ────────────────────────────────────────

  // Every blur-save routes through requestBlurSave so it serializes with
  // an in-flight SEO batch (or another blur-save) instead of racing it
  // into a 409 (#1).
  const saveTitleOnBlur = () => {
    if (title === page.title) return
    requestBlurSave({ title }, 'title')
  }
  const saveSlugOnBlur = () => {
    if (slug === page.slug) return
    if (slug.length < SLUG_MIN || slug.length > SLUG_MAX) {
      toast.error(
        `Web address must be between ${SLUG_MIN} and ${SLUG_MAX} characters.`,
      )
      setSlug(page.slug)
      return
    }
    if (!SLUG_RE.test(slug)) {
      toast.error(
        'Web address can only use lowercase letters, numbers, and single hyphens.',
      )
      setSlug(page.slug)
      return
    }
    requestBlurSave({ slug }, 'slug')
  }
  const saveSeoTitleOnBlur = () => {
    if (seoTitle === page.seo_title) return
    requestBlurSave({ seoTitle }, 'seoTitle')
  }
  const saveSeoDescriptionOnBlur = () => {
    if (seoDescription === page.seo_description) return
    requestBlurSave({ seoDescription }, 'seoDescription')
  }
  const saveHeroImage = (v: MediaRef | undefined) => {
    const newId = v?.media_id ?? null
    setHeroImageId(newId)
    if (newId !== page.hero_image_id) {
      requestBlurSave({ heroImageId: newId }, 'heroImageId')
    }
  }
  const saveOgImage = (v: MediaRef | undefined) => {
    const newId = v?.media_id ?? null
    setOgImageId(newId)
    if (newId !== page.og_image_id) {
      requestBlurSave({ ogImageId: newId }, 'ogImageId')
    }
  }
  const togglePublish = (v: boolean) => {
    if (!isAdmin) return
    setPublished(v)
    requestBlurSave({ published: v }, 'published')
  }

  // ─── Preview / view-live ─────────────────────────────────────────────
  const publicUrl = page.url_path ?? `/${page.slug}`
  const openPublic = () => window.open(publicUrl, '_blank', 'noopener')
  const openPreview = async () => {
    const r = await csrfFetch(`/api/cms/pages/${page.id}/preview-token`, {
      method: 'POST',
    })
    if (!r.ok) {
      toast.error('Couldn’t mint a preview link.')
      return
    }
    const j = (await r.json()) as { token: string }
    window.open(
      `${publicUrl}?preview=${encodeURIComponent(j.token)}`,
      '_blank',
      'noopener',
    )
    toast.info(
      'Preview links expire in 15 minutes. Mint a new one if you share it.',
    )
  }

  // ─── Move to Trash ──────────────────────────────────────────────────
  const onConfirmDelete = async () => {
    setDeleting(true)
    try {
      const r = await csrfFetch(`/api/cms/pages/${page.id}`, {
        method: 'DELETE',
      })
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string }
        toast.error(
          mapServerError(j.error, "We couldn't move that page to Trash. Try again in a moment."),
        )
        return
      }
      toast.success('Moved to Trash.')
      router.push('/admin/pages')
    } finally {
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  // ─── Block CRUD: add / reorder / duplicate / delete ──────────────────
  //
  // The canonical editor at /admin/pages/[id] is a fallback per spec §7
  // — the primary edit surface for block bodies remains the public-side
  // inline drawer. These actions cover the cases that don't fit the
  // inline drawer cleanly (bulk reorder, type-picker creation, kebab
  // duplicate). All flow through the existing /api/cms/blocks endpoints
  // which enforce role + CSRF + rate.

  const reorderBlocks = useCallback(
    async (newOrder: BlockMeta[]) => {
      const r = await csrfFetch('/api/cms/blocks/reorder', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pageId: page.id,
          blocks: newOrder.map((b) => ({ id: b.id, version: b.version })),
        }),
      })
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string }
        throw new Error(
          mapServerError(j.error, "We couldn't save the new order. Refresh and try again."),
        )
      }
      // The reorder endpoint bumps every row's version by 1 and reassigns
      // positions at 1000, 2000, …. Mirror that locally so the next
      // reorder/save doesn't 409 against the now-stale versions.
      setBlockList(
        newOrder.map((b, i) => ({
          ...b,
          version: b.version + 1,
          position: (i + 1) * 1000,
        })),
      )
      router.refresh()
    },
    [page.id, router],
  )

  // ─── DnD sensors + drag-end handler ──────────────────────────────────
  // Pointer + keyboard sensors. PointerSensor's `activationConstraint`
  // (distance 4px) prevents accidental drags on light clicks — the
  // operator must move the pointer at least 4px before drag activates,
  // so a click that briefly grazes the handle still works as a click.
  // KeyboardSensor wires arrow-key drag for accessibility.
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  const onBlockDragEnd = useCallback(
    async (e: DragEndEvent) => {
      if (!e.over || e.active.id === e.over.id) return
      const oldIdx = blockList.findIndex((b) => b.id === e.active.id)
      const newIdx = blockList.findIndex((b) => b.id === e.over!.id)
      if (oldIdx < 0 || newIdx < 0) return
      const next = arrayMove(blockList, oldIdx, newIdx)
      const prev = blockList
      setBlockList(next)
      try {
        await reorderBlocks(next)
      } catch (e) {
        setBlockList(prev)
        toast.error(
          e instanceof Error ? e.message : 'Couldn’t save the new order.',
        )
      }
    },
    [blockList, reorderBlocks, toast],
  )

  const moveBlock = async (index: number, dir: -1 | 1): Promise<void> => {
    const targetIndex = index + dir
    if (targetIndex < 0 || targetIndex >= blockList.length) return
    const block = blockList[index]!
    setBusyBlockId(block.id)
    try {
      const next = [...blockList]
      const a = next[index]!
      const b = next[targetIndex]!
      next[index] = b
      next[targetIndex] = a
      await reorderBlocks(next)
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : 'Couldn’t move that block.',
      )
    } finally {
      setBusyBlockId(null)
    }
  }

  const duplicateBlock = async (block: BlockMeta): Promise<void> => {
    if (busyBlockId !== null) return
    setBusyBlockId(block.id)
    try {
      const r = await csrfFetch('/api/cms/blocks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pageId: page.id,
          blockType: block.blockType,
          data: block.data,
        }),
      })
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string }
        throw new Error(
          mapServerError(j.error, "We couldn't duplicate that block. Try again in a moment."),
        )
      }
      toast.success('Block duplicated.')
      router.refresh()
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : 'Couldn’t duplicate that block.',
      )
    } finally {
      setBusyBlockId(null)
    }
  }

  const onConfirmBlockDelete = async () => {
    const block = confirmBlockDelete
    if (!block) return
    setBusyBlockId(block.id)
    try {
      const r = await csrfFetch(`/api/cms/blocks/${block.id}`, {
        method: 'DELETE',
      })
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string }
        toast.error(
          mapServerError(j.error, "We couldn't remove that block. Try again in a moment."),
        )
        return
      }
      toast.success('Block moved to Trash.')
      setBlockList((prev) => prev.filter((b) => b.id !== block.id))
      router.refresh()
    } finally {
      setBusyBlockId(null)
      setConfirmBlockDelete(null)
    }
  }

  // Keyboard shortcuts on the editor surface. When a SortableBlockRow
  // has focus (via Tab or after a click), the operator can:
  //   ⌘↑ / Ctrl↑   — move the block up
  //   ⌘↓ / Ctrl↓   — move the block down
  //   ⌘D / Ctrl D  — duplicate
  //   ⌘⌫ / Del     — open the trash confirmation modal
  //
  // The handler runs at the window level so a focused row anywhere on
  // the page picks up the shortcut. We bail early when:
  //   - the operator is read-only (viewer role)
  //   - the active element is an input / textarea / contenteditable
  //     (else ⌘D would clash with the browser's "bookmark page")
  //   - the focused element isn't inside a [data-block-row-id] row
  useEffect(() => {
    if (isReadOnly) return
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      if (!meta) return
      const ae = document.activeElement as HTMLElement | null
      if (
        ae &&
        (ae.tagName === 'INPUT' ||
          ae.tagName === 'TEXTAREA' ||
          ae.getAttribute('contenteditable') === 'true')
      ) {
        return
      }
      const focused = ae?.closest('[data-block-row-id]') as
        | HTMLElement
        | null
      if (!focused) return
      const blockId = Number(focused.getAttribute('data-block-row-id'))
      const idx = blockList.findIndex((b) => b.id === blockId)
      if (idx < 0) return
      const b = blockList[idx]!
      const isFixed = b.blockKey !== null
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (!isFixed && busyBlockId === null) void moveBlock(idx, -1)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (!isFixed && busyBlockId === null) void moveBlock(idx, 1)
      } else if (e.key === 'd' || e.key === 'D') {
        e.preventDefault()
        if (!isFixed && busyBlockId === null) void duplicateBlock(b)
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        if (!isFixed && busyBlockId === null) setConfirmBlockDelete(b)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // moveBlock / duplicateBlock are stable for the editor's lifetime
    // — re-binding the listener on every blockList change keeps the
    // closure honest about the current list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockList, busyBlockId, isReadOnly])

  // Stubs ship just enough data to pass each block's Zod schema at the
  // POST boundary. Operator fills in real content via the inline drawer
  // after creation. The payloads are pulled straight from SEED_DATA —
  // the SAME schema-validated source the public-page picker uses — so a
  // quick-add here can never drift from blockSchemas (the legacy purge
  // dropped text/cta/quote/about_history/services_intro; adding any of
  // those produced a schema-less block that dropped at render).
  //
  // The quick-menu is intentionally limited to the four no-data
  // editorial primitives that seed cleanly without a media-picker
  // round-trip (lx_heading / lx_text / lx_action / lx_quote). Media,
  // gallery, hero, and featured-projects blocks are added from the
  // public-page inline editor where the full Widget picker (with its
  // MediaPicker flow) lives.
  const blockStubs: Record<string, { label: string; data: unknown }> = {
    lx_heading: { label: 'Heading', data: SEED_DATA.lx_heading },
    lx_text: { label: 'Text', data: SEED_DATA.lx_text },
    lx_action: { label: 'Action', data: SEED_DATA.lx_action },
    lx_quote: { label: 'Quote', data: SEED_DATA.lx_quote },
  }

  // Best-effort rollback of an auto-created host section (cascades its
  // child column server-side). Swallows its own errors — the operator
  // can delete an empty section by hand if this misses.
  const rollbackAutoSection = async (sectionId: number | null): Promise<void> => {
    if (sectionId === null) return
    await csrfFetch(`/api/cms/blocks/${sectionId}`, { method: 'DELETE' }).catch(
      () => {},
    )
  }

  const addBlockOfType = async (type: string): Promise<void> => {
    const stub = blockStubs[type]
    if (!stub) return
    // Widgets must never land loose at the top level — every quick-add
    // builds a host section + column and nests the widget inside it (the
    // section→column→widget contract the public-page inline editor also
    // enforces). The section create is one atomic TX (section + 1
    // column); if the widget POST then fails, the empty host section is
    // rolled back so nothing is stranded on the page.
    let autoSectionId: number | null = null
    try {
      const wrap = await csrfFetch('/api/cms/blocks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pageId: page.id,
          kind: 'section',
          // SectionMetaSchema is strict + requires these — omitting meta
          // 400s with err_kind zod. Default cream/standard; the operator
          // retunes via the section settings drawer.
          meta: { columns: 1, background: 'cream', padding: 'md' },
          withColumns: 1,
        }),
      })
      if (!wrap.ok) {
        const j = (await wrap.json().catch(() => ({}))) as { error?: string }
        throw new Error(
          mapServerError(j.error, "We couldn't set up a section for that block. Try again in a moment."),
        )
      }
      const wj = (await wrap.json().catch(() => ({}))) as {
        id?: number
        columnIds?: number[]
      }
      if (typeof wj.id === 'number') autoSectionId = wj.id
      const columnId = wj.columnIds?.[0]
      if (typeof columnId !== 'number') {
        await rollbackAutoSection(autoSectionId)
        throw new Error('Couldn’t set up a section for that block.')
      }
      const r = await csrfFetch('/api/cms/blocks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pageId: page.id,
          blockType: type,
          data: stub.data,
          parentId: columnId,
        }),
      })
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string }
        // Roll back the empty host section so a failed widget insert
        // never strands a section on the page.
        await rollbackAutoSection(autoSectionId)
        if (j.error === 'block_type_reserved_for_fixed_slot') {
          toast.error(
            "This block is part of the page template, so you can't add another one here.",
          )
          return
        }
        throw new Error(
          mapServerError(j.error, "We couldn't add that block. Try again in a moment."),
        )
      }
      toast.success(`${stub.label} block added — click it on the public page to edit.`)
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Couldn’t add that block.')
    }
  }

  // ─── Recovery banner actions ─────────────────────────────────────────
  const applyDraft = (draft: BufferedDraft) => {
    const d = draft.diff as DirtyFields
    if (d.title !== undefined) setTitle(d.title)
    if (d.slug !== undefined) setSlug(d.slug)
    if (d.seoTitle !== undefined) setSeoTitle(d.seoTitle)
    if (d.seoDescription !== undefined) setSeoDescription(d.seoDescription)
    if (d.heroImageId !== undefined) setHeroImageId(d.heroImageId)
    if (d.ogImageId !== undefined) setOgImageId(d.ogImageId)
    if (d.published !== undefined && isAdmin) setPublished(d.published)
    // Per-entity SEO fields (migration 0032). The SEO-batch 409 path
    // buffers these alongside the blur-save fields, so the recovery
    // banner must re-apply them too — otherwise a keyphrase / robots /
    // canonical / schema edit caught in a 409 is silently lost (#1).
    if (d.focusKeyphrase !== undefined) {
      setFocusKeyphrase(d.focusKeyphrase ?? '')
    }
    if (d.robotsNoindex !== undefined) setRobotsNoindex(d.robotsNoindex)
    if (d.robotsNofollow !== undefined) setRobotsNofollow(d.robotsNofollow)
    if (d.canonicalUrl !== undefined) setCanonicalUrl(d.canonicalUrl ?? '')
    if (d.cornerstone !== undefined) setCornerstone(d.cornerstone)
    if (d.seoMeta !== undefined) setSeoMeta(d.seoMeta ?? {})
    discardDraft(page.id, draft.baseVersion)
    setRecoveredDrafts((prev) =>
      prev.filter((p) => p.baseVersion !== draft.baseVersion),
    )
    toast.info(
      'Edits re-applied. Review and click out of each field to save.',
    )
  }
  const dismissDraft = (draft: BufferedDraft) => {
    discardDraft(page.id, draft.baseVersion)
    setRecoveredDrafts((prev) =>
      prev.filter((p) => p.baseVersion !== draft.baseVersion),
    )
  }

  // ─── Render ─────────────────────────────────────────────────────────
  const slugDisabled = isReadOnly || !isAdmin || (page.system === 1 && page.is_home === 0)
  const publishDisabled = isReadOnly || !isAdmin

  // Page bodies are CMS block trees — the analysis engine scores the
  // extracted prose / links / images. blockList carries {blockType,data}
  // in render order, which is exactly extractFromBlocks' BlockLike shape.
  const getAnalysisContent = useCallback(
    (): AnalysisContent => extractFromBlocks(blockList),
    [blockList],
  )
  // A CHEAP fingerprint of the scored body for the panel's debounce —
  // block count + each block's id:version. Block CONTENT is edited via
  // the public inline drawer (not here); a content save bumps the row's
  // version + router.refresh()es new props, so the version roll-up
  // detects body edits without re-running the full extractor in render
  // (#2). Cheap: a flat join over the block metas already in memory.
  const contentSignal = useMemo(
    () => `${blockList.length}:${blockList.map((b) => `${b.id}.${b.version}`).join(',')}`,
    [blockList],
  )

  return (
    <section className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_320px]">
      <div className="space-y-8">
        {recoveredDrafts.length > 0 && (
          <RecoveryBanner
            drafts={recoveredDrafts}
            onApply={applyDraft}
            onDismiss={dismissDraft}
          />
        )}

        {/* Top bar */}
        <header className="sticky top-0 z-10 -mx-4 rounded-2xl border border-warm-stone/20 bg-cream-50/95 px-4 py-4 backdrop-blur-md sm:mx-0 sm:px-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-6">
            <div className="flex-1 min-w-0 space-y-2">
              <label className="block">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
                  Title
                </span>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onBlur={saveTitleOnBlur}
                  disabled={isReadOnly}
                  maxLength={220}
                  className="mt-1 text-2xl font-serif font-bold tracking-tight"
                />
              </label>
              <label className="block">
                <span className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
                  Web address
                  {slugDisabled && !isReadOnly && (
                    <span className="inline-flex items-center gap-1 text-warm-stone/80">
                      <Lock size={10} strokeWidth={2} />
                      {page.system === 1 ? 'System page' : 'Admin only'}
                    </span>
                  )}
                </span>
                <Input
                  value={slug}
                  onChange={(e) => setSlug(e.target.value.toLowerCase())}
                  onBlur={saveSlugOnBlur}
                  disabled={slugDisabled}
                  maxLength={SLUG_MAX}
                  className="mt-1 font-mono"
                />
                <span className="mt-1 block text-[11px] text-warm-stone">
                  Renaming creates a 308 redirect from the old address.
                </span>
              </label>
            </div>
            <div className="flex flex-col items-stretch gap-3 sm:items-end">
              <Switch
                checked={published}
                onChange={togglePublish}
                disabled={publishDisabled}
                label={published ? 'Live' : 'Draft'}
                help={
                  publishDisabled && !isReadOnly
                    ? 'Admin only'
                    : published
                      ? 'Visible on the public site'
                      : 'Hidden until you publish'
                }
              />
              <div className="flex gap-2">
                {published ? (
                  <button
                    type="button"
                    onClick={openPublic}
                    className="inline-flex w-fit items-center gap-1.5 rounded-full border border-warm-stone/30 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-near-black transition-colors hover:border-copper-400"
                  >
                    <ExternalLink size={11} strokeWidth={2.2} />
                    View live
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={openPreview}
                    className="inline-flex w-fit items-center gap-1.5 rounded-full border border-warm-stone/30 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-near-black transition-colors hover:border-copper-400"
                  >
                    <Eye size={11} strokeWidth={2.2} />
                    Preview
                  </button>
                )}
              </div>
            </div>
          </div>
          {/* Save-status pill — lives in the sticky header so the
              operator always sees the editor's current persistence
              state. Three modes:
                - Saving: copper accent + spinner-style label
                - Saved (in-session): copper accent + relative time
                - Idle (no in-session save yet): warm-stone "Last
                  edited" stamp from `page.updated_at` so the editor
                  doesn't read as "unsaved" right after open. */}
          <div className="mt-3 flex items-center gap-3 text-[10px] font-semibold uppercase tracking-[0.18em]">
            {savingFields.size > 0 ? (
              <span className="inline-flex items-center gap-1.5 text-copper-700">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-copper-500" aria-hidden="true" />
                Saving {Array.from(savingFields).join(', ')}…
              </span>
            ) : lastSavedAt !== null ? (
              <span className="inline-flex items-center gap-1.5 text-copper-700">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-copper-500" aria-hidden="true" />
                Saved · {formatRelativeSince(lastSavedAt)}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-warm-stone">
                Last edited {formatRelativeSince(new Date(page.updated_at).getTime())}
              </span>
            )}
          </div>
        </header>

        {/* SEO + hero accordion */}
        <Accordion
          title="SEO & social"
          subtitle="Search title, description, focus keyphrase, analysis"
          open={seoOpen}
          onToggle={setSeoOpen}
          hasContent={
            !!seoTitle ||
            !!seoDescription ||
            heroImageId !== null ||
            ogImageId !== null ||
            !!focusKeyphrase ||
            !isEmptySeoMeta(seoMeta)
          }
        >
          <div className="space-y-6">
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
                SEO title (max 180)
              </span>
              <Input
                value={seoTitle ?? ''}
                onChange={(e) =>
                  setSeoTitle(e.target.value === '' ? null : e.target.value)
                }
                onBlur={saveSeoTitleOnBlur}
                disabled={isReadOnly}
                maxLength={180}
                className="mt-1.5"
                placeholder="Optional — defaults to page title"
              />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
                SEO description (max 320)
              </span>
              <textarea
                value={seoDescription ?? ''}
                onChange={(e) =>
                  setSeoDescription(
                    e.target.value === '' ? null : e.target.value,
                  )
                }
                onBlur={saveSeoDescriptionOnBlur}
                disabled={isReadOnly}
                maxLength={320}
                rows={3}
                className="mt-1.5 block w-full rounded-lg border border-warm-stone/30 bg-cream-50 px-3 py-2 text-sm text-near-black focus:border-copper-400 focus:outline-none disabled:opacity-60"
                placeholder="Optional — the snippet that shows in search results"
              />
            </label>
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <MediaPicker
                value={
                  heroImageId !== null
                    ? { media_id: heroImageId, alt: '' }
                    : undefined
                }
                onChange={saveHeroImage}
                label="Hero image"
                help="The featured image used in the page header."
              />
              <MediaPicker
                value={
                  ogImageId !== null
                    ? { media_id: ogImageId, alt: '' }
                    : undefined
                }
                onChange={saveOgImage}
                label="Social card image"
                help="Used when the page is shared on social or chat."
              />
            </div>

            {/* Live SEO analysis + advanced / social / schema controls.
                Saves through the page editor's own patch flow via the
                debounced SEO batch above. */}
            <div className="border-t border-warm-stone/15 pt-6">
              <PageSeoPanel
                entityTitle={title}
                seoTitle={seoTitle ?? ''}
                seoDescription={seoDescription ?? ''}
                slug={slug}
                url={publicUrl}
                focusKeyphrase={focusKeyphrase}
                onFocusKeyphraseChange={setFocusKeyphrase}
                robotsNoindex={robotsNoindex}
                onRobotsNoindexChange={setRobotsNoindex}
                robotsNofollow={robotsNofollow}
                onRobotsNofollowChange={setRobotsNofollow}
                canonicalUrl={canonicalUrl}
                onCanonicalUrlChange={setCanonicalUrl}
                cornerstone={cornerstone}
                onCornerstoneChange={setCornerstone}
                seoMeta={seoMeta}
                onSeoMetaChange={setSeoMeta}
                getAnalysisContent={getAnalysisContent}
                contentSignal={contentSignal}
                onScores={onScores}
                disabled={isReadOnly}
              />
            </div>
          </div>
        </Accordion>

        {/* Blocks region — full CRUD: Add (type picker), Move up/down,
            Duplicate, Move to Trash. Inline edit of block CONTENTS still
            happens via the public-side drawer per spec §7. Fixed-slot
            blocks (block_key non-null) cannot be deleted or duplicated
            — the API refuses, and we disable the kebab items to match. */}
        <section>
          <header className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-serif text-xl font-semibold tracking-tight text-near-black">
                Blocks
              </h2>
              <p className="mt-1 text-sm text-warm-stone">
                {blockList.length === 0
                  ? 'This page has no blocks yet. Add one below, or open the public page in edit mode.'
                  : 'Edit block contents inline on the public page. Reorder and add from here.'}
              </p>
            </div>
            {!isReadOnly && (
              <AddBlockPopover
                stubs={blockStubs}
                onAdd={addBlockOfType}
                label="Add block"
              />
            )}
          </header>
          {blockList.length > 0 && (
            <DndContext
              sensors={dndSensors}
              collisionDetection={closestCenter}
              onDragEnd={onBlockDragEnd}
            >
              <SortableContext
                items={blockList.map((b) => b.id)}
                strategy={verticalListSortingStrategy}
              >
                <ol className="mt-4 space-y-2">
                  {blockList.map((b, i) => {
                    const isFixed = b.blockKey !== null
                    const kebabItems: RowActionItem[] = [
                  {
                    id: 'edit',
                    label: 'Edit on public page',
                    icon: ExternalLink,
                    onSelect: () => {
                      window.open(
                        `${publicUrl}?edit=1#block-${b.id}`,
                        '_blank',
                        'noopener',
                      )
                    },
                  },
                ]
                if (!isReadOnly) {
                  kebabItems.push(
                    {
                      id: 'move-up',
                      label: 'Move up',
                      icon: ArrowUp,
                      disabled: i === 0 || busyBlockId !== null,
                      onSelect: () => void moveBlock(i, -1),
                    },
                    {
                      id: 'move-down',
                      label: 'Move down',
                      icon: ArrowDown,
                      disabled:
                        i === blockList.length - 1 || busyBlockId !== null,
                      onSelect: () => void moveBlock(i, 1),
                    },
                    {
                      id: 'duplicate',
                      label: 'Duplicate',
                      icon: Copy,
                      disabled: isFixed || busyBlockId !== null,
                      description: isFixed
                        ? 'Fixed slots can’t be duplicated'
                        : undefined,
                      onSelect: () => void duplicateBlock(b),
                    },
                    {
                      id: 'trash',
                      label: 'Move to Trash',
                      icon: Trash2,
                      destructive: true,
                      disabled: isFixed || busyBlockId !== null,
                      description: isFixed
                        ? 'Fixed slots can’t be deleted'
                        : undefined,
                      onSelect: () => setConfirmBlockDelete(b),
                    },
                  )
                }
                const BlockIcon = iconForBlock(b.blockType)
                const excerpt = excerptForBlock(b.blockType, b.data)
                const inlineEditHref = `${publicUrl}?edit=1#block-${b.id}`
                return (
                  <SortableBlockRow
                    key={b.id}
                    id={b.id}
                    index={i}
                    disabled={isFixed || isReadOnly}
                    className="group/blockrow flex items-start gap-3 rounded-2xl border border-warm-stone/20 bg-cream-50 px-4 py-3 transition-all duration-quick ease-standard hover:border-warm-stone/40 hover:shadow-[0_12px_30px_-22px_rgba(5,5,5,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/40 motion-reduce:transition-none animate-cavecms-rise"
                  >
                    {({ dragAttributes, dragListeners, isDragging }) => (
                      <>
                        {/* Drag handle — visible on row hover. Disabled
                            for fixed slots + viewer role. Carries the
                            useSortable attributes/listeners so the
                            entire button surface is grabbable. */}
                        <button
                          type="button"
                          {...dragAttributes}
                          {...dragListeners}
                          disabled={isFixed || isReadOnly}
                          aria-label={
                            isFixed
                              ? 'Fixed slot — not reorderable'
                              : `Drag to reorder ${b.blockType.replace(/_/g, ' ')} block`
                          }
                          className={clsx(
                            'inline-flex h-9 w-6 shrink-0 items-center justify-center self-stretch rounded-lg text-warm-stone/60 transition-all motion-reduce:transition-none',
                            isFixed || isReadOnly
                              ? 'cursor-not-allowed opacity-30'
                              : isDragging
                                ? 'cursor-grabbing bg-copper-50 text-copper-500 opacity-100'
                                : 'cursor-grab opacity-0 hover:bg-warm-stone/8 hover:text-near-black group-hover/blockrow:opacity-100 focus-visible:opacity-100',
                          )}
                        >
                          <GripVertical size={13} strokeWidth={2} />
                        </button>
                        <span
                          aria-hidden="true"
                          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-warm-stone/10 text-near-black transition-colors group-hover/blockrow:bg-copper-500/15 group-hover/blockrow:text-copper-500"
                        >
                          <BlockIcon size={15} strokeWidth={1.8} />
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col gap-1">
                          <span className="flex items-center gap-2 text-xs">
                            <span className="font-mono text-[10px] text-warm-stone">
                              #{i + 1}
                            </span>
                            <span className="truncate font-semibold capitalize text-near-black">
                              {b.blockType.replace(/_/g, ' ')}
                            </span>
                            {isFixed && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-warm-stone/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-warm-stone">
                                <Lock size={9} strokeWidth={2.2} />
                                Fixed slot
                              </span>
                            )}
                          </span>
                          {excerpt ? (
                            <span className="line-clamp-2 text-[12px] leading-relaxed text-warm-stone">
                              {excerpt}
                            </span>
                          ) : (
                            <span className="text-[11px] italic text-warm-stone/70">
                              No content yet — open this page on the public site
                              to edit inline.
                            </span>
                          )}
                        </span>
                        <a
                          href={inlineEditHref}
                          target="_blank"
                          rel="noopener"
                          title="Open inline editor in a new tab"
                          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-warm-stone/30 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-near-black opacity-0 transition-all hover:border-copper-400 hover:bg-copper-50/30 hover:text-copper-700 focus-visible:opacity-100 group-hover/blockrow:opacity-100 motion-reduce:transition-none"
                        >
                          <ExternalLink size={11} strokeWidth={2.2} />
                          Edit inline
                        </a>
                        <RowActionsMenu
                          items={kebabItems}
                          ariaLabel={`Actions for ${b.blockType} block`}
                        />
                      </>
                    )}
                  </SortableBlockRow>
                )
              })}
                </ol>
              </SortableContext>
            </DndContext>
          )}
          {!isReadOnly && blockList.length > 0 && (
            <div className="mt-4 flex justify-center">
              <AddBlockPopover
                stubs={blockStubs}
                onAdd={addBlockOfType}
                label="Add block below"
                compact
              />
            </div>
          )}
        </section>
      </div>

      {/* Right metadata strip */}
      <aside className="space-y-6">
        <article className="rounded-2xl border border-warm-stone/20 bg-cream-50 p-5">
          <h3 className="font-serif text-base font-semibold tracking-tight text-near-black">
            Details
          </h3>
          <dl className="mt-4 space-y-3 text-xs">
            <div className="flex justify-between gap-3">
              <dt className="text-warm-stone">Status</dt>
              <dd className="font-medium text-near-black">
                {page.deleted_at
                  ? 'In Trash'
                  : published
                    ? 'Live'
                    : 'Draft'}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-warm-stone">Home page</dt>
              <dd className="font-medium text-near-black">
                {page.is_home === 1 ? 'Yes' : 'No'}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-warm-stone">System</dt>
              <dd className="font-medium text-near-black">
                {page.system === 1 ? 'Seeded' : 'Operator-created'}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-warm-stone">Block count</dt>
              <dd className="font-medium text-near-black">{blockList.length}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-warm-stone">Last edited</dt>
              <dd className="font-medium text-near-black">
                {new Date(page.updated_at).toISOString().slice(0, 10)}
              </dd>
            </div>
          </dl>
        </article>

        <article className="rounded-2xl border border-warm-stone/20 bg-cream-50 p-5">
          <h3 className="font-serif text-base font-semibold tracking-tight text-near-black">
            Recent activity
          </h3>
          {audit.length === 0 ? (
            <p className="mt-3 text-xs text-warm-stone">
              No audit history yet.
            </p>
          ) : (
            // Vertical-timeline list. Each entry: small status dot in
            // an action-keyed tone, action label (Create / Update /
            // Publish / Unpublish / Rename / Delete / Restore), relative
            // time (live-ticking via the same `formatRelativeSince`
            // helper as the save-status pill), and operator email.
            <ol className="mt-4 space-y-3">
              {audit.map((a, idx) => {
                const isLast = idx === audit.length - 1
                const actionLabel = a.action.replace(/_/g, ' ')
                const tone =
                  a.action === 'delete'
                    ? 'bg-red-500'
                    : a.action === 'publish' || a.action === 'restore'
                      ? 'bg-emerald-500'
                      : a.action === 'unpublish'
                        ? 'bg-warm-stone'
                        : a.action === 'create'
                          ? 'bg-copper-500'
                          : 'bg-near-black'
                const ts = new Date(a.createdAt).getTime()
                const dateLabel = new Date(a.createdAt).toLocaleString(
                  undefined,
                  {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  },
                )
                return (
                  <li
                    key={a.id}
                    className="relative flex gap-3 pl-6"
                  >
                    {/* Connector line (skipped on last item) */}
                    {!isLast && (
                      <span
                        aria-hidden="true"
                        className="absolute left-[7px] top-3 h-full w-px bg-warm-stone/15"
                      />
                    )}
                    <span
                      aria-hidden="true"
                      className={clsx(
                        'absolute left-0 top-[5px] inline-block h-3.5 w-3.5 rounded-full ring-2 ring-cream-50',
                        tone,
                      )}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-xs font-semibold capitalize text-near-black">
                        {actionLabel}
                      </span>
                      <span
                        className="text-[11px] text-warm-stone"
                        title={dateLabel}
                      >
                        {/* Relative time is computed from the clock, so the
                            server-rendered value and the value at client
                            hydration can differ (e.g. "44s ago" vs "47s ago")
                            for very recent entries — suppressHydrationWarning
                            keeps that legitimate drift from throwing React
                            #418. The absolute timestamp is on the title attr. */}
                        <span suppressHydrationWarning>
                          {formatRelativeSince(ts)}
                        </span>
                        {' · '}
                        {a.email ? (
                          <CfSafeMailto email={a.email} linked={false} />
                        ) : (
                          '—'
                        )}
                      </span>
                    </span>
                  </li>
                )
              })}
            </ol>
          )}
          <Link
            href={`/admin/activity?resource_type=page&resource_id=${page.id}`}
            className="mt-4 inline-flex text-[10px] font-semibold uppercase tracking-[0.18em] text-warm-stone transition-colors hover:text-near-black"
          >
            View full activity →
          </Link>
        </article>

        {isAdmin && (
          <Button
            type="button"
            variant="danger"
            onClick={() => setConfirmDelete(true)}
            disabled={deleting || page.deleted_at !== null}
            className={clsx('w-full justify-center')}
          >
            <span className="inline-flex items-center gap-2">
              <Trash2 size={13} strokeWidth={2.2} />
              Move page to Trash
            </span>
          </Button>
        )}
      </aside>

      <ConfirmModal
        open={confirmDelete}
        title="Move this page to Trash?"
        description={
          page.is_home === 1
            ? 'This is your homepage. Visitors will see a placeholder until you restore it or set another page as Home.'
            : 'It will be hidden from the public site and held in Trash for 30 days. You can restore it at any time.'
        }
        confirmLabel="Move to Trash"
        destructive
        busy={deleting}
        onConfirm={onConfirmDelete}
        onCancel={() => {
          if (!deleting) setConfirmDelete(false)
        }}
      />
      <ConfirmModal
        open={confirmBlockDelete !== null}
        title="Move this block to Trash?"
        description={
          confirmBlockDelete
            ? `The "${confirmBlockDelete.blockType.replace(/_/g, ' ')}" block will be hidden from the public site and cleaned up in 30 days.`
            : ''
        }
        confirmLabel="Move to Trash"
        destructive
        busy={busyBlockId === confirmBlockDelete?.id}
        onConfirm={onConfirmBlockDelete}
        onCancel={() => {
          if (busyBlockId === null) setConfirmBlockDelete(null)
        }}
      />
    </section>
  )
}

// ─── AddBlockPopover ──────────────────────────────────────────────────
// Small inline popover so the type picker doesn't pull in a full Menu
// primitive. Click the trigger → reveal a list of buttons → pick one →
// onAdd fires with the type, popover closes. Escape + outside click
// dismiss. Compact variant trims padding for the between-blocks "Add
// block below" trigger so it doesn't dominate the layout.

function AddBlockPopover({
  stubs,
  onAdd,
  label,
  compact,
}: {
  stubs: Record<string, { label: string; data: unknown }>
  onAdd: (type: string) => void | Promise<void>
  label: string
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  // Edge-aware placement. Default opens DOWN + RIGHT-aligned to trigger.
  // Flips to UP when not enough room below the trigger; flips to
  // LEFT-aligned when not enough room left of the trigger (right-align
  // would clip the panel off the viewport-left edge for a trigger that
  // lives in the leftmost columns).
  const [placement, setPlacement] = useState<{
    v: 'down' | 'up'
    h: 'right' | 'left'
  }>({ v: 'down', h: 'right' })
  const ref = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Re-measure on open. Compute initial best-guess placement using a
  // panel-size ESTIMATE so first paint is already close to final; the
  // second effect refines using the real rect after the panel mounts.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const PANEL_W = 256 // w-64
    const PANEL_H = 320 // approximate full menu height
    const GUTTER = 12
    const tr = triggerRef.current.getBoundingClientRect()
    const vh = window.innerHeight
    // Vertical: prefer DOWN. If would clip AND there's room ABOVE, flip up.
    const wouldClipBottom = tr.bottom + 8 + PANEL_H > vh - GUTTER
    const roomAbove = tr.top - 8 - PANEL_H >= GUTTER
    const v: 'down' | 'up' = wouldClipBottom && roomAbove ? 'up' : 'down'
    // Horizontal: prefer RIGHT-align (panel's right at trigger's right).
    // If that would clip off the viewport-left, flip to LEFT-align
    // (panel's left at trigger's left).
    const rightAlignedLeft = tr.right - PANEL_W
    const h: 'right' | 'left' = rightAlignedLeft < GUTTER ? 'left' : 'right'
    setPlacement({ v, h })
  }, [open])

  // Refine using actual panel rect. If the panel STILL clips after the
  // estimate-based flip, try the opposite direction. (Edge case: a
  // trigger in the middle of a viewport with a panel taller than EITHER
  // side has room. Pick the side with MORE space.)
  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !panelRef.current) return
    const tr = triggerRef.current.getBoundingClientRect()
    const pr = panelRef.current.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const GUTTER = 12
    let v = placement.v
    let h = placement.h
    if (v === 'down' && pr.bottom > vh - GUTTER) {
      const realH = pr.height
      if (tr.top - 8 - realH >= GUTTER) v = 'up'
    } else if (v === 'up' && pr.top < GUTTER) {
      const realH = pr.height
      if (tr.bottom + 8 + realH <= vh - GUTTER) v = 'down'
    }
    if (h === 'right' && pr.left < GUTTER) {
      h = 'left'
    } else if (h === 'left' && pr.right > vw - GUTTER) {
      h = 'right'
    }
    if (v !== placement.v || h !== placement.h) {
      setPlacement({ v, h })
    }
  }, [open, placement])

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={clsx(
          'inline-flex w-fit items-center gap-2 rounded-full border border-warm-stone/30 text-near-black transition-colors hover:border-copper-400',
          compact
            ? 'px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em]'
            : 'px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.22em]',
        )}
      >
        <Plus size={compact ? 11 : 13} strokeWidth={2.2} />
        {label}
      </button>
      {open && (
        <div
          ref={panelRef}
          role="menu"
          className={clsx(
            'absolute z-20 w-64 rounded-2xl border border-warm-stone/20 bg-cream-50 py-2 shadow-[0_20px_50px_-20px_rgba(5,5,5,0.4)] animate-cavecms-fade-in',
            placement.h === 'right' ? 'right-0' : 'left-0',
            placement.v === 'down' ? 'mt-2' : 'bottom-full mb-2',
          )}
        >
          <p className="px-4 pb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
            Pick a block type
          </p>
          {Object.entries(stubs).map(([type, info]) => (
            <button
              key={type}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                void onAdd(type)
              }}
              className="block w-full px-4 py-2 text-left text-sm text-near-black transition-colors hover:bg-warm-stone/10"
            >
              {info.label}
              <span className="ml-2 text-[10px] font-mono text-warm-stone">
                {type}
              </span>
            </button>
          ))}
          <p className="px-4 pt-2 text-[10px] text-warm-stone">
            These are quick adds. The full block library — images, gallery,
            stats, testimonials, and more — lives in the public-page inline
            editor.
          </p>
        </div>
      )}
    </div>
  )
}

// ─── Recovery banner ──────────────────────────────────────────────────

function RecoveryBanner({
  drafts,
  onApply,
  onDismiss,
}: {
  drafts: BufferedDraft[]
  onApply: (d: BufferedDraft) => void
  onDismiss: (d: BufferedDraft) => void
}) {
  return (
    <aside
      role="alert"
      className="rounded-2xl border border-copper-300 bg-copper-50/60 p-5"
    >
      <header className="flex items-start gap-3">
        <AlertTriangle
          size={18}
          strokeWidth={2}
          className="mt-0.5 shrink-0 text-copper-700"
        />
        <div>
          <p className="font-serif text-base font-semibold tracking-tight text-near-black">
            {drafts.length} recovered edit{drafts.length === 1 ? '' : 's'}{' '}
            from before the conflict
          </p>
          <p className="mt-1 text-xs text-warm-stone">
            Someone else saved this page while you were editing. Review
            each set of unsaved edits below — re-apply to overwrite the
            current values, or discard to drop them.
          </p>
        </div>
      </header>
      <ul className="mt-4 space-y-3">
        {drafts.map((d) => {
          const fields = describeDraftFields(d.diff)
          return (
            <li
              key={d.baseVersion}
              className="rounded-xl border border-copper-200/70 bg-cream-50 p-4"
            >
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
                From version {d.baseVersion} ·{' '}
                {new Date(d.createdAt).toLocaleString()}
              </p>
              <p className="mt-2 text-xs text-near-black">
                Changes: {fields.length > 0 ? fields.join(', ') : 'none'}
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => onApply(d)}
                  className="rounded-lg bg-near-black px-4 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-cream-50 transition-colors hover:bg-copper-700"
                >
                  Re-apply
                </button>
                <button
                  type="button"
                  onClick={() => onDismiss(d)}
                  className="rounded-lg border border-warm-stone/30 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-near-black transition-colors hover:border-copper-400"
                >
                  Discard
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}

// Lists which fields are present in a buffered diff. Used by the
// recovery banner for an operator-friendly preview. Snake-case-style
// labels match the public form fields.
function describeDraftFields(diff: unknown): string[] {
  if (!diff || typeof diff !== 'object') return []
  const o = diff as Record<string, unknown>
  const out: string[] = []
  if ('title' in o) out.push('title')
  if ('slug' in o) out.push('web address')
  if ('seoTitle' in o) out.push('SEO title')
  if ('seoDescription' in o) out.push('SEO description')
  if ('heroImageId' in o) out.push('hero image')
  if ('ogImageId' in o) out.push('social card image')
  if ('published' in o) out.push('publish')
  if ('isHome' in o) out.push('home page')
  // Per-entity SEO fields (migration 0032) — buffered on a SEO-batch 409
  // and re-applied by the banner, so surface them in the preview too.
  if ('focusKeyphrase' in o) out.push('focus keyphrase')
  if ('robotsNoindex' in o) out.push('search visibility')
  if ('robotsNofollow' in o) out.push('link following')
  if ('canonicalUrl' in o) out.push('canonical address')
  if ('cornerstone' in o) out.push('cornerstone')
  if ('seoMeta' in o) out.push('social & structured data')
  return out
}
