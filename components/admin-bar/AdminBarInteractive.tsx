'use client'

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefCallback,
} from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import {
  ChevronDown,
  FilePlus,
  FileText,
  FolderPlus,
  Layers,
  LayoutDashboard,
  LogOut,
  Menu as MenuIcon,
  Pencil,
  Plus,
  Upload,
  UserPlus,
  type LucideIcon,
} from 'lucide-react'
import type { Role } from '@/lib/auth/requireRole'
import { PillButton } from '@/components/admin/PillButton'
import { ToastProvider, useToast } from '@/components/inline-edit/Toast'
import { csrfFetch } from '@/lib/client/csrf'
import { adminRoutes } from '@/lib/admin-bar/adminRoutes'
import { safeStorage } from '@/lib/client/safeStorage'
import { BarLink } from './BarLink'

// Client island for the public-side admin bar. Receives serialised
// session context as props (no auth-touching code here) and owns:
//   - the "+ New" dropdown (desktop) + mobile "Admin" collapse
//   - the Sign-out POST + hard navigation
//   - the identity chip
//   - the local <ToastProvider> for sign-out failure feedback
//
// Skip-to-content + the bar's outer chrome live on the server side
// (AdminBarShell.tsx, SkipToContent.tsx) so signed-out visitors pay
// ZERO JS for this surface. The bundle here ships only when a session
// resolves and the bar actually renders.

interface EditTarget {
  kind: 'project' | 'post'
  id: number
  slug: string
  label: string
}

interface Props {
  email: string
  role: Role
  editTarget: EditTarget | null
  /** Whether this page render is in operator edit mode (server-read
   *  EDIT_MODE_COOKIE). The Outline-toggle pill renders ONLY when
   *  this is true — non-edit-mode operators don't need the toggle. */
  editMode: boolean
  canNewProject: boolean
  canNewPost: boolean
  canNewPage: boolean
  canUploadMedia: boolean
  canInviteUser: boolean
}

// ────────────────────────────────────────────────────────────────────
// Menu item models — links navigate, actions invoke, dividers separate.

interface MenuLink {
  kind: 'link'
  id: string
  href: string
  icon: LucideIcon
  label: string
  description?: string
}
interface MenuAction {
  kind: 'action'
  id: string
  icon: LucideIcon
  label: string
  description?: string
  destructive?: boolean
  onSelect: () => void | Promise<void>
}
interface MenuDivider {
  kind: 'divider'
  id: string
}
type MenuItem = MenuLink | MenuAction | MenuDivider

// ────────────────────────────────────────────────────────────────────
// Public export — wraps the bar in a local ToastProvider so signed-out
// public visitors never load the toast infrastructure.

export function AdminBarInteractive(props: Props) {
  return (
    <ToastProvider>
      <BarInner {...props} />
    </ToastProvider>
  )
}

// ────────────────────────────────────────────────────────────────────
// Bar body.

function BarInner({
  email,
  role,
  editTarget,
  editMode,
  canNewProject,
  canNewPost,
  canNewPage,
  canUploadMedia,
  canInviteUser,
}: Props) {
  const editHref = useMemo(() => {
    if (!editTarget) return null
    return editTarget.kind === 'project'
      ? adminRoutes.editProject(editTarget.id)
      : adminRoutes.editPost(editTarget.id)
  }, [editTarget])

  // Sign-out: shared by desktop pill, mobile icon-only pill, AND the
  // mobile-menu action item. Single source of truth for the logout
  // POST + post-response navigation.
  const { error, info } = useToast()
  const [signingOut, setSigningOut] = useState(false)
  const signOut = useCallback(async () => {
    if (signingOut) return
    setSigningOut(true)
    try {
      const res = await csrfFetch('/api/auth/logout', { method: 'POST' })
      if (res.ok) {
        // 200: signed out cleanly. Hard navigation (NOT router.push)
        // because router.refresh does not reliably re-evaluate the
        // root layout's getSession() across Next 15 App Router
        // transitions when the auth cookie was just cleared. Leave
        // `signingOut` true — the hard nav unmounts this component
        // before any re-render can fire a second request.
        //
        // Wipe the inline-editor clipboard before navigating so a
        // subsequent operator on the same browser doesn't inherit the
        // signed-out operator's most-recent Copy slot. localStorage is
        // origin-scoped, not user-scoped — this is the defence-in-depth
        // closing that gap. Wrapped in try/catch because Safari Private
        // Mode + enterprise lockdown profiles throw on storage access;
        // a failure here must NOT block the navigation.
        try {
          window.localStorage.removeItem('cavecms:clipboard')
        } catch {
          // private browsing / locked storage — non-fatal
        }
        window.location.href = '/'
        return
      }
      if (res.status === 401) {
        // Server has nothing to revoke for this token (already gone).
        // The cookie is also gone from this browser. We say "Session
        // ended" rather than "Already signed out" because the server
        // had no opportunity to revoke other live devices for the
        // same user — that would need a fresh-session re-login.
        try {
          window.localStorage.removeItem('cavecms:clipboard')
        } catch {
          // private browsing / locked storage — non-fatal
        }
        info('Session ended')
        window.location.href = '/'
        return
      }
      error("We couldn't sign you out — please try again.")
      // Reset only on the genuine-error path so the user can retry.
      setSigningOut(false)
    } catch {
      error("We couldn't sign you out — please try again.")
      setSigningOut(false)
    }
  }, [signingOut, error, info])

  // ──────────────────────────────────────────────────────────────────
  // Item lists — role-filtered at the server layer (canNew*) so we
  // just consume the booleans here.

  const newItems = useMemo<MenuItem[]>(() => {
    const items: MenuItem[] = []
    // Order: page → post → project. Reflects how often each is
    // reached for — pages are the most-frequent marketing artifact;
    // projects are the rarer big-deal create.
    if (canNewPage) {
      items.push({
        kind: 'link',
        id: 'new-page',
        href: adminRoutes.newPage(),
        icon: FilePlus,
        label: 'New page',
        description: 'Add a marketing or landing page',
      })
    }
    if (canNewPost) {
      items.push({
        kind: 'link',
        id: 'new-post',
        href: adminRoutes.newPost(),
        icon: FileText,
        label: 'New post',
        description: 'Draft an article',
      })
    }
    if (canNewProject) {
      items.push({
        kind: 'link',
        id: 'new-project',
        href: adminRoutes.newProject(),
        icon: FolderPlus,
        label: 'New project',
        description: 'Start a development',
      })
    }
    if (canUploadMedia) {
      items.push({
        kind: 'link',
        id: 'upload-media',
        href: adminRoutes.uploadMedia(),
        icon: Upload,
        label: 'Upload media',
        description: 'Add to the library',
      })
    }
    if (canInviteUser) {
      items.push({
        kind: 'link',
        id: 'invite-user',
        href: adminRoutes.inviteUser(),
        icon: UserPlus,
        label: 'Invite user',
        description: 'Add an operator',
      })
    }
    return items
  }, [canNewProject, canNewPost, canNewPage, canUploadMedia, canInviteUser])

  const showNewTrigger = newItems.length > 0

  // Mobile menu: Dashboard, Edit (if any), all role-filtered "New"
  // items, divider, Sign out. Divider is only emitted when there's
  // something above it (other than the bare Dashboard) — otherwise
  // [Dashboard, divider, Sign out] looks awkward and the rule reads
  // as a visual error.
  const mobileItems = useMemo<MenuItem[]>(() => {
    const items: MenuItem[] = [
      {
        kind: 'link',
        id: 'dashboard',
        href: adminRoutes.dashboard(),
        icon: LayoutDashboard,
        label: 'Dashboard',
      },
    ]
    if (editTarget && editHref) {
      items.push({
        kind: 'link',
        id: 'edit',
        href: editHref,
        icon: Pencil,
        label: editTarget.label,
      })
    }
    for (const ni of newItems) items.push(ni)
    const hasContentAboveDivider =
      (!!editTarget && !!editHref) || newItems.length > 0
    if (hasContentAboveDivider) {
      items.push({ kind: 'divider', id: 'div-signout' })
    }
    items.push({
      kind: 'action',
      id: 'signout',
      icon: LogOut,
      label: 'Sign out',
      onSelect: signOut,
    })
    return items
  }, [editTarget, editHref, newItems, signOut])

  return (
    <>
      {/* Desktop layout — md+ only. */}
      <div className="hidden flex-1 items-center gap-2 md:flex">
        <BarLink href={adminRoutes.dashboard()} icon={LayoutDashboard}>
          Dashboard
        </BarLink>
        {showNewTrigger && (
          <Dropdown
            align="right"
            width={240}
            ariaLabel="New"
            items={newItems}
            renderTrigger={({ ref, onClick, onKeyDown, ...aria }) => (
              <PillButton
                ref={ref}
                onClick={onClick}
                onKeyDown={onKeyDown}
                aria-haspopup={aria['aria-haspopup']}
                aria-expanded={aria['aria-expanded']}
                aria-controls={aria['aria-controls']}
                variant="bar"
                size="bar"
              >
                <Plus size={13} strokeWidth={1.8} aria-hidden />
                New
                <ChevronDown size={11} strokeWidth={1.8} aria-hidden />
              </PillButton>
            )}
          />
        )}
        {editTarget && editHref && (
          <BarLink href={editHref} icon={Pencil}>
            {editTarget.label}
          </BarLink>
        )}
        {editMode && <OutlineTogglePill />}
        <div className="ml-auto flex items-center gap-3">
          <Identity email={email} role={role} />
          <PillButton
            variant="bar"
            size="bar"
            onClick={signOut}
            disabled={signingOut}
          >
            <LogOut size={13} strokeWidth={1.8} aria-hidden />
            Sign out
          </PillButton>
        </div>
      </div>

      {/* Mobile layout — below md. */}
      <div className="flex flex-1 items-center gap-2 md:hidden">
        <Dropdown
          align="left"
          width={280}
          ariaLabel="Open admin menu"
          items={mobileItems}
          renderTrigger={({ ref, onClick, onKeyDown, ...aria }) => (
            <PillButton
              ref={ref}
              onClick={onClick}
              onKeyDown={onKeyDown}
              aria-haspopup={aria['aria-haspopup']}
              aria-expanded={aria['aria-expanded']}
              aria-controls={aria['aria-controls']}
              variant="bar"
              size="bar"
            >
              <MenuIcon size={14} strokeWidth={1.8} aria-hidden />
              Admin
              <ChevronDown size={11} strokeWidth={1.8} aria-hidden />
            </PillButton>
          )}
        />
        <div className="ml-auto flex items-center gap-2">
          <RolePill role={role} />
          <PillButton
            variant="bar"
            size="bar"
            ariaLabel="Sign out"
            onClick={signOut}
            disabled={signingOut}
            className="px-2.5"
          >
            <LogOut size={14} strokeWidth={1.8} aria-hidden />
          </PillButton>
        </div>
      </div>
    </>
  )
}

// ────────────────────────────────────────────────────────────────────
// Identity chip — email · ROLE on desktop. Email hidden on mobile.

// OutlineTogglePill — toggles the OutlinePanel's dismiss state.
//
// State lives in localStorage `cavecms:outline-dismissed` ('true' /
// 'false'). The OutlinePanel reads the same key + listens for a
// `cavecms:outline-visibility` CustomEvent so toggling here re-mounts
// it in the same tab (the native `storage` event only fires
// cross-tab; same-tab needs the custom event).
//
// Pill labels reflect current state — "Show outline" when dismissed,
// "Hide outline" when visible. Click flips the flag + dispatches.
function OutlineTogglePill() {
  const [dismissed, setDismissed] = useState<boolean | null>(null)
  useEffect(() => {
    setDismissed(safeStorage.get('cavecms:outline-dismissed') === 'true')
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<{ dismissed?: boolean }>).detail
      if (detail && typeof detail.dismissed === 'boolean') {
        setDismissed(detail.dismissed)
      } else {
        setDismissed(safeStorage.get('cavecms:outline-dismissed') === 'true')
      }
    }
    window.addEventListener('cavecms:outline-visibility', onChange)
    return () =>
      window.removeEventListener('cavecms:outline-visibility', onChange)
  }, [])
  // SSR + first-render: render the pill in a stable state (treats
  // unknown as "visible" → label "Hide outline"). After mount the
  // saved value resolves and the label updates. The pill remains
  // clickable throughout — no flash of disabled state.
  const isDismissed = dismissed === true
  const toggle = () => {
    if (typeof window === 'undefined') return
    const next = !isDismissed
    safeStorage.set('cavecms:outline-dismissed', String(next))
    window.dispatchEvent(
      new CustomEvent('cavecms:outline-visibility', {
        detail: { dismissed: next },
      }),
    )
    setDismissed(next)
  }
  return (
    <PillButton
      variant="bar"
      size="bar"
      onClick={toggle}
      ariaLabel={isDismissed ? 'Show outline' : 'Hide outline'}
      className="px-2.5"
    >
      <Layers size={14} strokeWidth={1.8} aria-hidden />
    </PillButton>
  )
}

function Identity({ email, role }: { email: string; role: Role }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="max-w-[14rem] truncate text-[11px] font-medium text-cream-50/85"
        title={email}
      >
        {email}
      </span>
      <span aria-hidden className="text-cream-50/30">
        ·
      </span>
      <RolePill role={role} />
    </span>
  )
}

function RolePill({ role }: { role: Role }) {
  return (
    <span className="inline-flex items-center rounded-full bg-copper-500/15 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.2em] text-copper-300 ring-1 ring-copper-400/30">
      {role}
    </span>
  )
}

// ────────────────────────────────────────────────────────────────────
// Dropdown — anchored portal menu with full keyboard navigation.
//
// Built once, used twice (desktop "+ New" and mobile "Admin"). The
// existing RowActionsMenu was close in spirit but ships only
// click-activation; this one adds WAI-ARIA APG menu semantics:
//   - ArrowDown/ArrowUp navigate, wrap at ends
//   - Home/End jump to bounds
//   - Tab / Shift+Tab close the menu and let browser move focus
//     normally (APG convention — NOT a focus trap)
//   - Escape closes + restores focus to the trigger
//   - Click outside closes; scroll / resize close

interface TriggerProps {
  ref: RefCallback<HTMLButtonElement>
  onClick: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
  'aria-haspopup': 'menu'
  'aria-expanded': boolean
  'aria-controls': string
}

function Dropdown({
  align,
  width,
  ariaLabel,
  items,
  renderTrigger,
}: {
  align: 'left' | 'right'
  width: number
  ariaLabel: string
  items: MenuItem[]
  renderTrigger: (props: TriggerProps) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [layout, setLayout] = useState<
    { top: number; left: number; width: number } | null
  >(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<Array<HTMLElement | null>>([])
  const id = useId()

  const setTriggerRef = useCallback<RefCallback<HTMLButtonElement>>((el) => {
    triggerRef.current = el
  }, [])

  // Stable per-index ref setter — avoids the inline-arrow recreate
  // pattern that triggers detach/attach cycles on every render.
  const itemRefSetters = useMemo(() => {
    const setters: Array<RefCallback<HTMLElement>> = []
    return (idx: number): RefCallback<HTMLElement> => {
      let fn = setters[idx]
      if (!fn) {
        fn = (el) => {
          itemRefs.current[idx] = el
        }
        setters[idx] = fn
      }
      return fn
    }
  }, [])

  const close = useCallback(() => {
    setOpen(false)
    setLayout(null)
    // Synchronous focus restore — the trigger element is still
    // mounted (only the portal unmounts), no rAF needed. rAF was
    // previously here defensively but creates a race where browsers
    // can scroll-to-body in the interim frame.
    triggerRef.current?.focus()
  }, [])

  // Position the panel relative to the trigger every time we open.
  // Coordinates live in document space (viewport rect + scroll
  // offset) so the portal renders in the right place even on a
  // scrolled page. effectiveWidth clamps the rendered width to the
  // viewport so a 280px panel never overshoots a 296px viewport.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const vw = window.innerWidth
    const effectiveWidth = Math.min(width, vw - 16)
    let left =
      align === 'left'
        ? rect.left + window.scrollX
        : rect.right + window.scrollX - effectiveWidth
    if (left < 8) left = 8
    if (left + effectiveWidth > vw - 8) left = vw - effectiveWidth - 8
    const top = rect.bottom + window.scrollY + 6
    setLayout({ top, left, width: effectiveWidth })
  }, [open, align, width])

  // Outside click + Escape both close.
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node | null
      if (!t) return
      if (panelRef.current?.contains(t)) return
      if (triggerRef.current?.contains(t)) return
      setOpen(false)
      setLayout(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  // Scroll / resize close — repositioning a floating panel during
  // a scroll feels cheap; closing matches the established admin
  // pattern (RowActionsMenu).
  useEffect(() => {
    if (!open) return
    const onChange = () => {
      setOpen(false)
      setLayout(null)
    }
    window.addEventListener('scroll', onChange, true)
    window.addEventListener('resize', onChange)
    return () => {
      window.removeEventListener('scroll', onChange, true)
      window.removeEventListener('resize', onChange)
    }
  }, [open])

  // Focus the first focusable menuitem on open. Use the post-render
  // microtask so the portal has actually mounted.
  const firstFocusableIdx = useMemo(
    () => items.findIndex((i) => i.kind !== 'divider'),
    [items],
  )
  useEffect(() => {
    if (!open) return
    if (firstFocusableIdx === -1) return
    const t = setTimeout(() => itemRefs.current[firstFocusableIdx]?.focus(), 0)
    return () => clearTimeout(t)
  }, [open, firstFocusableIdx])

  // ArrowUp/ArrowDown navigate among non-divider items, with wrap.
  // Home/End jump to bounds. Tab and Shift+Tab close the menu and
  // let the browser move focus normally (WAI-ARIA APG convention —
  // NOT a focus trap).
  const focusableIndices = useMemo(
    () =>
      items
        .map((it, idx) => (it.kind === 'divider' ? -1 : idx))
        .filter((i) => i !== -1),
    [items],
  )
  const onPanelKey = (e: React.KeyboardEvent) => {
    if (focusableIndices.length === 0) return
    const active = document.activeElement as HTMLElement | null
    const currentIdx = itemRefs.current.findIndex((el) => el === active)
    const pos = focusableIndices.indexOf(currentIdx)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const next =
        pos === -1
          ? focusableIndices[0]!
          : focusableIndices[(pos + 1) % focusableIndices.length]!
      itemRefs.current[next]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const prev =
        pos === -1
          ? focusableIndices[focusableIndices.length - 1]!
          : focusableIndices[
              (pos - 1 + focusableIndices.length) % focusableIndices.length
            ]!
      itemRefs.current[prev]?.focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      itemRefs.current[focusableIndices[0]!]?.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      itemRefs.current[focusableIndices[focusableIndices.length - 1]!]?.focus()
    } else if (e.key === 'Tab') {
      // APG convention: Tab moves focus out of the menu and closes
      // it. We shift focus to the trigger BEFORE the browser
      // processes the default Tab action — without this, the menu
      // item's portal unmount causes focus to fall back to body,
      // and Tab then advances from body to the first focusable
      // element on the page (the skip link), NOT the bar item
      // after the trigger. Moving focus to the trigger first means
      // the browser's default Tab/Shift+Tab continues forward/
      // backward from the trigger's natural position.
      triggerRef.current?.focus()
      setOpen(false)
      setLayout(null)
    }
  }

  // Trigger keyboard: ArrowDown/ArrowUp opens the panel (the open
  // effect then auto-focuses first/last item). Enter / Space on the
  // trigger fires the native button click which toggles open.
  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) setOpen(true)
    }
  }

  return (
    <>
      {renderTrigger({
        ref: setTriggerRef,
        onClick: () => setOpen((v) => !v),
        onKeyDown: onTriggerKey,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        // Stable aria-controls regardless of open state — toggling
        // it confuses some AT (NVDA + Firefox) into skipping the
        // relationship announcement. `aria-expanded` carries the
        // open/closed state on its own.
        'aria-controls': id,
      })}
      {open && layout !== null && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={panelRef}
              id={id}
              role="menu"
              aria-label={ariaLabel}
              aria-orientation="vertical"
              onKeyDown={onPanelKey}
              style={{
                position: 'absolute',
                top: layout.top,
                left: layout.left,
                width: layout.width,
              }}
              className="z-[70] rounded-2xl border border-cream-50/15 bg-near-black/95 py-1.5 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.6)] backdrop-blur-md animate-cavecms-fade-in motion-reduce:animate-none forced-colors:border-CanvasText forced-colors:bg-Canvas forced-colors:text-CanvasText"
            >
              {items.map((item, idx) => {
                if (item.kind === 'divider') {
                  return (
                    <div
                      key={item.id}
                      role="separator"
                      className="my-1 h-px bg-cream-50/10"
                    />
                  )
                }
                if (item.kind === 'link') {
                  const Icon = item.icon
                  return (
                    // Plain <a> rather than next/link — see BarLink.tsx
                    // for the same reason: the bar's links cross the
                    // public ↔ (admin) route-group boundary, and a
                    // soft Link nav tears down the shared root layout
                    // chrome in transit. Hard nav is the correct
                    // semantics for "navigate to a different admin
                    // surface".
                    <a
                      key={item.id}
                      href={item.href}
                      role="menuitem"
                      ref={itemRefSetters(idx)}
                      onClick={() => {
                        setOpen(false)
                        setLayout(null)
                      }}
                      className="mx-1 flex items-start gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-cream-50/85 transition-colors hover:bg-cream-50/10 hover:text-copper-200 focus:bg-cream-50/10 focus:text-copper-200 focus:outline-none motion-reduce:transition-none forced-colors:text-CanvasText"
                    >
                      <Icon
                        size={15}
                        strokeWidth={1.8}
                        className="mt-0.5 shrink-0"
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium leading-tight">
                          {item.label}
                        </span>
                        {item.description ? (
                          <span className="mt-0.5 block text-[11px] text-cream-50/65">
                            {item.description}
                          </span>
                        ) : null}
                      </span>
                    </a>
                  )
                }
                // action
                const Icon = item.icon
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    ref={itemRefSetters(idx)}
                    onClick={() => {
                      setOpen(false)
                      setLayout(null)
                      // Microtask-defer so setOpen commits before
                      // the action runs (matches RowActionsMenu).
                      queueMicrotask(() => void item.onSelect())
                    }}
                    className={clsx(
                      'mx-1 flex w-[calc(100%-0.5rem)] items-start gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors focus:outline-none motion-reduce:transition-none',
                      item.destructive
                        ? 'text-red-300 hover:bg-red-500/15 hover:text-red-200 focus:bg-red-500/15 focus:text-red-200'
                        : 'text-cream-50/85 hover:bg-cream-50/10 hover:text-copper-200 focus:bg-cream-50/10 focus:text-copper-200 forced-colors:text-CanvasText',
                    )}
                  >
                    <Icon
                      size={15}
                      strokeWidth={1.8}
                      className="mt-0.5 shrink-0"
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium leading-tight">
                        {item.label}
                      </span>
                      {item.description ? (
                        <span className="mt-0.5 block text-[11px] text-cream-50/65">
                          {item.description}
                        </span>
                      ) : null}
                    </span>
                  </button>
                )
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
