'use client'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useRouter } from 'next/navigation'
import { Command } from 'cmdk'
import {
  Building2,
  FileText,
  ImagePlus,
  Inbox,
  LayoutDashboard,
  Library,
  Mail,
  Newspaper,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
} from 'lucide-react'

// Global Cmd+K palette. cmdk handles a11y, keyboard nav, and the
// portal; we own the fuzzy match + the result set. The catalog of
// editable records is fetched once per open (cheap, admin-only,
// rate-limited via /api/admin/search). Static actions and nav links
// are always available even when the network call is pending.

interface DirectoryItem {
  type: 'project' | 'page' | 'post'
  id: number
  title: string
  slug: string
  published: number
}

interface Directory {
  role: 'admin' | 'editor' | 'viewer'
  projects: DirectoryItem[]
  pages: DirectoryItem[]
  posts: DirectoryItem[]
}

interface CommandPaletteCtx {
  open: boolean
  setOpen: (v: boolean) => void
  toggle: () => void
}

const Ctx = createContext<CommandPaletteCtx | null>(null)

export function useCommandPalette(): CommandPaletteCtx {
  const c = useContext(Ctx)
  if (!c) {
    // Provider-less environments (storybook, tests) shouldn't crash.
    return {
      open: false,
      setOpen: () => undefined,
      toggle: () => undefined,
    }
  }
  return c
}

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [dir, setDir] = useState<Directory | null>(null)
  const [loadErr, setLoadErr] = useState(false)
  const [query, setQuery] = useState('')
  const router = useRouter()
  const fetchedAt = useRef<number>(0)

  const toggle = useCallback(() => setOpen((v) => !v), [])

  // Hotkey: Cmd+K / Ctrl+K opens, ESC closes (cmdk handles ESC).
  // `e.code === 'KeyK'` checks the PHYSICAL key so non-US keyboard
  // layouts (Dvorak, Colemak, AZERTY) still trigger.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.code !== 'KeyK' && e.key.toLowerCase() !== 'k') return
      e.preventDefault()
      setOpen((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Reset transient state when the palette closes so a fresh open
  // starts on a clean slate.
  useEffect(() => {
    if (!open) {
      setLoadErr(false)
      setQuery('')
    }
  }, [open])

  // Fetch on open AND on each query change. Below 2 chars we ask the
  // server for the recent-items list (no `q`); at 2+ chars we ask for a
  // server-side LIKE match. Debounced to one fetch per ~180ms of typing
  // — fast enough to feel live, slow enough to avoid SQL spam.
  useEffect(() => {
    if (!open) return
    const isSearching = query.trim().length >= 2
    // On open with no query, honour the 60s freshness window so toggling
    // the palette doesn't refetch on every keystroke that ends in zero
    // chars. The search path always refetches because the result set
    // depends on q.
    if (!isSearching) {
      const age = Date.now() - fetchedAt.current
      if (dir && age < 60_000) return
    }
    const ctrl = new AbortController()
    setLoadErr(false)
    const delay = isSearching ? 180 : 0
    const timer = setTimeout(() => {
      const qs = isSearching ? `?q=${encodeURIComponent(query.trim())}` : ''
      fetch(`/api/admin/search${qs}`, {
        credentials: 'include',
        signal: ctrl.signal,
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((j: Directory) => {
          if (ctrl.signal.aborted) return
          setDir(j)
          if (!isSearching) fetchedAt.current = Date.now()
        })
        .catch((err) => {
          if (err instanceof DOMException && err.name === 'AbortError') return
          if (ctrl.signal.aborted) return
          setLoadErr(true)
        })
    }, delay)
    return () => {
      clearTimeout(timer)
      ctrl.abort()
    }
    // `dir` is intentionally excluded — including it would refetch every
    // time setDir resolves, even without an open/query change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query])

  const navigate = useCallback(
    (href: string) => {
      setOpen(false)
      router.push(href)
    },
    [router],
  )

  const ctx = useMemo(() => ({ open, setOpen, toggle }), [open, toggle])

  return (
    <Ctx.Provider value={ctx}>
      {children}
      <Command.Dialog
        open={open}
        onOpenChange={setOpen}
        label="Command Palette"
        className="fixed inset-0 z-[120] flex items-start justify-center p-4 sm:p-10"
      >
        <button
          type="button"
          aria-label="Close"
          onClick={() => setOpen(false)}
          className="absolute inset-0 bg-near-black/40 backdrop-blur-[2px] animate-cavecms-fade-in"
        />
        <div className="relative mt-[8vh] w-full max-w-2xl overflow-hidden rounded-2xl border border-warm-stone/25 bg-cream-50 shadow-[0_40px_80px_-30px_rgba(5,5,5,0.55)] animate-cavecms-fade-in">
          <div className="flex items-center gap-3 border-b border-warm-stone/15 px-5 py-4">
            <Search size={16} strokeWidth={2.2} className="text-copper-600" />
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="Search projects, pages, posts, or jump anywhere…"
              className="flex-1 bg-transparent text-base text-near-black placeholder:text-warm-stone/70 focus:outline-none"
            />
            <kbd className="hidden rounded border border-warm-stone/30 px-1.5 py-0.5 text-[10px] font-semibold text-warm-stone sm:inline-flex">
              ESC
            </kbd>
          </div>
          <Command.List className="max-h-[60vh] overflow-y-auto p-2">
            <Command.Empty className="px-5 py-10 text-center text-sm text-warm-stone">
              {loadErr ? "We can't search right now. Try again in a moment." : 'No matches yet — try a different word.'}
            </Command.Empty>

            <Group heading="Navigate">
              <Item
                icon={LayoutDashboard}
                label="Dashboard"
                keywords="home overview"
                onSelect={() => navigate('/admin')}
              />
              <Item
                icon={Building2}
                label="Projects"
                keywords="developments listings"
                onSelect={() => navigate('/admin/projects')}
              />
              <Item
                icon={Newspaper}
                label="Pages"
                onSelect={() => navigate('/admin/pages')}
              />
              <Item
                icon={FileText}
                label="Blog posts"
                keywords="articles"
                onSelect={() => navigate('/admin/blog')}
              />
              <Item
                icon={Library}
                label="Media"
                keywords="images photos uploads files library"
                onSelect={() => navigate('/admin/media')}
              />
              <Item
                icon={Inbox}
                label="Leads"
                keywords="inquiries enquiries contacts"
                onSelect={() => navigate('/admin/leads')}
              />
              <Item
                icon={Mail}
                label="Newsletter"
                onSelect={() => navigate('/admin/newsletter')}
              />
              <Item
                icon={Settings}
                label="Site settings"
                keywords="configuration"
                onSelect={() => navigate('/admin/settings')}
              />
              <Item
                icon={ShieldCheck}
                label="Activity"
                keywords="history audit log"
                onSelect={() => navigate('/admin/activity')}
              />
              <Item
                icon={Trash2}
                label="Trash"
                keywords="deleted recycle bin"
                onSelect={() => navigate('/admin/trash')}
              />
            </Group>

            {dir && dir.role !== 'viewer' && (
              <Group heading="Create">
                <Item
                  icon={Plus}
                  label="New page"
                  keywords="add landing marketing"
                  onSelect={() => navigate('/admin/pages/new')}
                />
                <Item
                  icon={Plus}
                  label="New blog post"
                  keywords="add article"
                  onSelect={() => navigate('/admin/blog/new')}
                />
                <Item
                  icon={Plus}
                  label="New project"
                  keywords="add development"
                  onSelect={() => navigate('/admin/projects?new=1')}
                />
                <Item
                  icon={ImagePlus}
                  label="Upload a file"
                  keywords="image photo pdf"
                  onSelect={() => navigate('/admin/media?upload=1')}
                />
              </Group>
            )}

            {dir && dir.projects.length > 0 && (
              <Group heading="Projects">
                {dir.projects.map((p) => (
                  <Item
                    key={`proj-${p.id}`}
                    icon={Building2}
                    label={p.title}
                    description={`/projects/${p.slug}`}
                    keywords={`${p.slug} ${p.published ? 'published live' : 'draft'}`}
                    badge={p.published ? 'Live' : 'Draft'}
                    onSelect={() => navigate(`/admin/projects/${p.id}`)}
                  />
                ))}
              </Group>
            )}

            {dir && dir.pages.length > 0 && (
              <Group heading="Pages">
                {dir.pages.map((p) => (
                  <Item
                    key={`page-${p.id}`}
                    icon={Newspaper}
                    label={p.title || `/${p.slug}`}
                    description={`/${p.slug}`}
                    keywords={p.slug}
                    onSelect={() => navigate(`/admin/pages/${p.id}`)}
                  />
                ))}
              </Group>
            )}

            {dir && dir.posts.length > 0 && (
              <Group heading="Blog posts">
                {dir.posts.map((p) => (
                  <Item
                    key={`post-${p.id}`}
                    icon={FileText}
                    label={p.title}
                    description={`/blog/${p.slug}`}
                    keywords={`${p.slug} ${p.published ? 'published live' : 'draft'}`}
                    badge={p.published ? 'Live' : 'Draft'}
                    onSelect={() => navigate(`/admin/blog/${p.id}`)}
                  />
                ))}
              </Group>
            )}
          </Command.List>
          <div className="flex items-center justify-between gap-3 border-t border-warm-stone/15 bg-cream/60 px-5 py-2.5 text-[10px] uppercase tracking-[0.18em] text-warm-stone">
            <span className="flex items-center gap-3">
              <Hint k="↵" label="Open" />
              <Hint k="↑↓" label="Navigate" />
            </span>
            <span className="hidden sm:inline">CaveCMS · admin</span>
          </div>
        </div>
      </Command.Dialog>
    </Ctx.Provider>
  )
}

function Hint({ k, label }: { k: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <kbd className="rounded border border-warm-stone/30 bg-cream-50 px-1.5 py-0.5 text-[10px] font-semibold text-near-black">
        {k}
      </kbd>
      {label}
    </span>
  )
}

function Group({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <Command.Group
      heading={
        <span className="px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-warm-stone">
          {heading}
        </span>
      }
    >
      {children}
    </Command.Group>
  )
}

function Item({
  icon: Icon,
  label,
  description,
  badge,
  keywords,
  onSelect,
}: {
  icon: typeof Search
  label: string
  description?: string
  badge?: string
  keywords?: string
  onSelect: () => void
}) {
  return (
    <Command.Item
      value={`${label} ${keywords ?? ''} ${description ?? ''}`}
      onSelect={onSelect}
      className="group flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-near-black aria-selected:bg-copper-50/70 aria-selected:text-near-black"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-cream-50 text-copper-700 ring-1 ring-warm-stone/15 group-aria-selected:bg-copper-500 group-aria-selected:text-cream-50 group-aria-selected:ring-copper-500 transition-colors">
        <Icon size={14} strokeWidth={2.2} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{label}</span>
        {description && (
          <span className="truncate text-[11px] text-warm-stone">
            {description}
          </span>
        )}
      </span>
      {badge && (
        <span
          className={
            'inline-flex shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] ' +
            (badge === 'Live'
              ? 'bg-copper-500/15 text-copper-700'
              : 'bg-warm-stone/15 text-warm-stone')
          }
        >
          {badge}
        </span>
      )}
    </Command.Item>
  )
}

// Trigger button for the topbar — clicking opens the palette. Renders
// the ⌘K hotkey as a visual hint so operators discover the shortcut.
export function CommandPaletteTrigger() {
  const { setOpen } = useCommandPalette()
  // Default to ⌘ during SSR so a Mac admin doesn't see "Ctrl" flash
  // before hydration; reconciled to the real platform on mount.
  // `navigator.platform` is deprecated; prefer `userAgentData.platform`
  // when available, fall back to a UA-string sniff for Safari and
  // older browsers. The hint is purely cosmetic — both Cmd+K and
  // Ctrl+K trigger the palette via the e.code listener.
  const [mac, setMac] = useState(true)
  useEffect(() => {
    type UADBrand = { platform?: string }
    const uad = (navigator as Navigator & { userAgentData?: UADBrand })
      .userAgentData
    if (uad?.platform) {
      setMac(/mac/i.test(uad.platform))
      return
    }
    setMac(/Mac|iPhone|iPad/i.test(navigator.userAgent))
  }, [])
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Open command palette"
      className="group flex items-center gap-2 rounded-full border border-warm-stone/25 bg-cream-50/80 px-3 py-1.5 text-xs font-medium text-warm-stone transition-all hover:border-copper-400 hover:text-near-black"
    >
      <Search size={13} strokeWidth={2.2} className="text-copper-600 group-hover:text-copper-700" />
      <span className="hidden sm:inline">Search or jump anywhere…</span>
      <span className="sm:hidden">Search</span>
      <span className="ml-1 hidden items-center gap-0.5 sm:inline-flex">
        <kbd className="rounded border border-warm-stone/30 bg-cream-50 px-1 py-px text-[9px] font-semibold text-near-black">
          {mac ? '⌘' : 'Ctrl'}
        </kbd>
        <kbd className="rounded border border-warm-stone/30 bg-cream-50 px-1 py-px text-[9px] font-semibold text-near-black">
          K
        </kbd>
      </span>
    </button>
  )
}
