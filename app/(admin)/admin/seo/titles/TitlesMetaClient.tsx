'use client'
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import {
  Home,
  File as FileIcon,
  Newspaper,
  Building2,
  Rss,
  LayoutGrid,
  AlertTriangle,
  type LucideIcon,
} from 'lucide-react'
import clsx from 'clsx'
import { csrfFetch } from '@/lib/client/csrf'
import { Switch } from '@/components/inline-edit/Switch'
import { useToast } from '@/components/inline-edit/Toast'
import { ConfirmModal } from '@/components/admin/ConfirmModal'
import { structuralEqual } from '@/lib/structuralEqual'
import { SeoCard } from '@/components/seo/SeoCard'
import { VariableInserter } from '@/components/seo/VariableInserter'
import { TemplatePreview, sampleContext } from '@/components/seo/TemplatePreview'
import type { TemplateContext } from '@/lib/seo/templates/types'

// ── Shapes mirroring the seo_titles + seo_indexing settings values ──
interface TemplatePair {
  title: string
  description: string
}
type ContentType =
  | 'home'
  | 'page'
  | 'post'
  | 'project'
  | 'blogIndex'
  | 'projectsIndex'

interface TitlesValue {
  separator: string
  home: TemplatePair
  page: TemplatePair
  post: TemplatePair
  project: TemplatePair
  blogIndex: TemplatePair
  projectsIndex: TemplatePair
}

interface IndexingValue {
  discourageSearchEngines: boolean
  noindexSearch: boolean
  noindexPaginated: boolean
}

// Each content type: its tile label, the lucide icon, a one-line "what
// this template controls" explainer, and the per-type sample fields the
// live SERP preview resolves against. Keeping the sample data here means
// every preview reads like a real page of that kind, not a generic stub.
const TYPE_META: Record<
  ContentType,
  {
    label: string
    icon: LucideIcon
    blurb: string
    sample: Partial<TemplateContext>
    /** A trailing URL fragment for the preview's green address line. */
    urlPath: string
  }
> = {
  home: {
    label: 'Home',
    icon: Home,
    blurb: 'The title and description for your front page.',
    sample: { title: 'Your Site' },
    urlPath: '',
  },
  page: {
    label: 'Pages',
    icon: FileIcon,
    blurb: 'Standard content pages — About, Services, Contact, and the like.',
    sample: { title: 'About Us', excerpt: 'The people and the story behind the work we do.' },
    urlPath: '/about',
  },
  post: {
    label: 'Blog posts',
    icon: Newspaper,
    blurb: 'Individual articles in your blog.',
    sample: {
      title: 'Five Lessons From a Year of Slow Design',
      excerpt: 'What a deliberate, unhurried approach taught us about craft and trust.',
      category: 'Journal',
      ptSingle: 'Post',
      ptPlural: 'Posts',
    },
    urlPath: '/blog/slow-design',
  },
  project: {
    label: 'Projects',
    icon: Building2,
    blurb: 'Individual entries in your project or portfolio gallery.',
    sample: {
      title: 'Atelier Rivière — Brand Identity',
      excerpt: 'A complete visual identity for a boutique Parisian perfumer.',
      category: 'Branding',
      ptSingle: 'Project',
      ptPlural: 'Projects',
    },
    urlPath: '/projects/atelier-riviere',
  },
  blogIndex: {
    label: 'Blog index',
    icon: Rss,
    blurb: 'The page that lists all of your blog posts.',
    sample: { title: 'Journal' },
    urlPath: '/blog',
  },
  projectsIndex: {
    label: 'Projects index',
    icon: LayoutGrid,
    blurb: 'The page that lists all of your projects.',
    sample: { title: 'Work' },
    urlPath: '/projects',
  },
}

const TYPE_ORDER: ContentType[] = [
  'home',
  'page',
  'post',
  'project',
  'blogIndex',
  'projectsIndex',
]

// The site-wide separator glyphs offered as visual tiles (#0.59 — render
// the actual glyph, never a name in a dropdown). The label under each is
// only a name for screen-readers / keyboard users; the glyph is the
// primary affordance.
const SEPARATORS: { glyph: string; name: string }[] = [
  { glyph: '–', name: 'En dash' },
  { glyph: '—', name: 'Em dash' },
  { glyph: '·', name: 'Middle dot' },
  { glyph: '•', name: 'Bullet' },
  { glyph: '|', name: 'Pipe' },
  { glyph: '~', name: 'Tilde' },
  { glyph: '/', name: 'Slash' },
]

export function TitlesMetaClient({
  titles,
  indexing,
  defaults,
}: {
  titles: { value: unknown; version: number }
  indexing: { value: unknown; version: number }
  /** Registry defaults for the two keys, passed from the server page so
   *  this client never imports the server-only settings registry. */
  defaults: { seo_titles: TitlesValue; seo_indexing: IndexingValue }
}) {
  // Merge each stored value over its registry default so every key is
  // present + controlled regardless of the stored row shape (a fresh-
  // install default row may omit optional keys). The casts ride on the
  // merged object, so they're now backed by guaranteed-present keys.
  const titlesValue = {
    ...defaults.seo_titles,
    ...((titles.value as Partial<TitlesValue> | null) ?? {}),
  } as TitlesValue
  const indexingValue = {
    ...defaults.seo_indexing,
    ...((indexing.value as Partial<IndexingValue> | null) ?? {}),
  } as IndexingValue

  return (
    <section className="mt-10 space-y-6">
      <TitlesCard initial={titlesValue} version={titles.version} />
      <IndexingCard initial={indexingValue} version={indexing.version} />
    </section>
  )
}

// ───────────────────────── Titles & templates ─────────────────────────

function TitlesCard({
  initial,
  version: initialVersion,
}: {
  initial: TitlesValue
  version: number
}) {
  const toast = useToast()
  const [form, setForm] = useState<TitlesValue>(initial)
  const [pristine, setPristine] = useState<TitlesValue>(initial)
  const [version, setVersion] = useState(initialVersion)
  const [busy, setBusy] = useState(false)
  const [active, setActive] = useState<ContentType>('home')
  const dirty = useMemo(() => !structuralEqual(form, pristine), [form, pristine])

  // Which field the variable inserter targets — whichever of the active
  // type's title/description the operator focused last. The inserter
  // splices the token at the caret of THAT element.
  const titleRef = useRef<HTMLInputElement>(null)
  const descRef = useRef<HTMLTextAreaElement>(null)
  const [focusField, setFocusField] = useState<'title' | 'description'>('title')
  const targetRef = (
    focusField === 'title' ? titleRef : descRef
  ) as RefObject<HTMLInputElement | HTMLTextAreaElement | null>

  const pair = form[active]

  const setPair = useCallback(
    (next: Partial<TemplatePair>) => {
      setForm((f) => ({ ...f, [active]: { ...f[active], ...next } }))
    },
    [active],
  )

  // The inserter hands back the WHOLE new string for the focused field.
  const onInsertChange = useCallback(
    (nextValue: string) => {
      setPair({ [focusField]: nextValue })
    },
    [focusField, setPair],
  )

  const setSeparator = (glyph: string) =>
    setForm((f) => ({ ...f, separator: glyph }))

  // Preview context for the active type — site sample + the type's own
  // entity sample + the LIVE separator the operator has picked, so the
  // %sep% in the template resolves to exactly what's selected above.
  const ctx = useMemo(
    () =>
      sampleContext({
        siteName: 'Your Site',
        separator: form.separator,
        ...TYPE_META[active].sample,
      }),
    [active, form.separator],
  )
  const previewUrl = `your-site.com${TYPE_META[active].urlPath}`

  const save = useCallback(async () => {
    if (busy || !dirty) return
    setBusy(true)
    try {
      const r = await csrfFetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'seo_titles', value: form, version }),
      })
      if (r.status === 400 || r.status === 422) {
        toast.error('One of those templates looks off — check it and try again.')
        return
      }
      if (r.status === 409) {
        toast.error('Settings changed in another tab. Refresh to see them.')
        return
      }
      if (!r.ok) {
        toast.error("That didn't save. Try again in a moment.")
        return
      }
      // Adopt the authoritative server version (additive). A no-op save
      // returns 200 without bumping the DB version — blind v + 1 would
      // desync the client and 409 the next save.
      const respBody = (await r.json().catch(() => null)) as { version?: number } | null
      setPristine(form)
      setVersion(typeof respBody?.version === 'number' ? respBody.version : (v) => v + 1)
      toast.success('Title templates saved.')
    } finally {
      setBusy(false)
    }
  }, [busy, dirty, form, version, toast])

  // Per-type dirty marker for the tiles, so the operator sees which types
  // they've touched before saving.
  const typeIsDirty = (t: ContentType) =>
    !structuralEqual(form[t], pristine[t])

  return (
    <SeoCard
      title="Title & description templates"
      eyebrow="Titles & meta"
      help={
        <>
          These templates decide the headline and the snippet a search engine
          shows for each kind of page. Write them once with{' '}
          <code className="font-mono text-[12px]">%variables%</code> — like{' '}
          <code className="font-mono text-[12px]">%title%</code> or{' '}
          <code className="font-mono text-[12px]">%sitename%</code> — and every
          page of that kind fills itself in. The live preview shows exactly how
          a result will read.
        </>
      }
      dirty={dirty}
      busy={busy}
      onSave={() => void save()}
      onUndo={() => setForm(pristine)}
    >
      <div className="space-y-7">
        {/* Separator picker — visual glyph tiles. */}
        <div>
          <p className="text-sm font-medium text-near-black">Separator</p>
          <p className="mt-0.5 text-[13px] leading-relaxed text-warm-stone">
            The glyph that sits between the parts of a title wherever a template
            uses <code className="font-mono text-[12px]">%sep%</code>.
          </p>
          <div className="mt-3 flex flex-wrap gap-2.5">
            {SEPARATORS.map((s) => {
              const selected = form.separator === s.glyph
              return (
                <button
                  key={s.glyph}
                  type="button"
                  title={s.name}
                  aria-pressed={selected}
                  onClick={() => setSeparator(s.glyph)}
                  className={clsx(
                    'flex h-14 w-14 flex-col items-center justify-center rounded-xl border transition-all duration-quick ease-standard cavecms-focus-ring',
                    selected
                      ? 'border-copper-500 bg-copper-500/12 text-copper-700 shadow-[0_6px_18px_-10px_rgba(184,115,51,0.6)]'
                      : 'border-warm-stone/25 bg-cream-50/80 text-near-black hover:border-copper-400 hover:bg-copper-500/5',
                  )}
                >
                  <span className="font-serif text-2xl leading-none">{s.glyph}</span>
                  <span className="mt-1 text-[9px] uppercase tracking-[0.12em] text-warm-stone">
                    {s.name}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        {/* Content-type selector — visual tiles that swap the editor. */}
        <div>
          <p className="text-sm font-medium text-near-black">Choose a page type to edit</p>
          <div
            role="tablist"
            aria-label="Content type"
            className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4"
          >
            {TYPE_ORDER.map((t) => {
              const meta = TYPE_META[t]
              const Icon = meta.icon
              const isActive = active === t
              const touched = typeIsDirty(t)
              return (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActive(t)}
                  className={clsx(
                    'group relative flex flex-col items-start gap-2 rounded-xl border p-3 text-left transition-all duration-quick ease-standard cavecms-focus-ring',
                    isActive
                      ? 'border-copper-500 bg-copper-500/10 shadow-[0_8px_22px_-14px_rgba(184,115,51,0.7)]'
                      : 'border-warm-stone/20 bg-cream-50/70 hover:border-copper-400/70 hover:bg-copper-500/5',
                  )}
                >
                  <span
                    className={clsx(
                      'flex h-8 w-8 items-center justify-center rounded-lg transition-colors duration-quick',
                      isActive
                        ? 'bg-copper-500/15 text-copper-700'
                        : 'bg-cream-100/60 text-warm-stone group-hover:text-copper-700',
                    )}
                  >
                    <Icon size={17} strokeWidth={1.9} aria-hidden />
                  </span>
                  <span
                    className={clsx(
                      'text-[13px] font-semibold leading-tight',
                      isActive ? 'text-copper-800' : 'text-near-black',
                    )}
                  >
                    {meta.label}
                  </span>
                  {touched && (
                    <span
                      className="absolute right-2.5 top-2.5 inline-flex h-2 w-2 rounded-full bg-copper-500 animate-cavecms-pulse-copper"
                      title="Unsaved changes for this type"
                    />
                  )}
                </button>
              )
            })}
          </div>
        </div>

        {/* The active editor — title + description fields, inserter, preview. */}
        <div className="rounded-2xl bg-cream-100/35 p-5">
          <p className="text-[13px] leading-relaxed text-warm-stone">
            {TYPE_META[active].blurb}
          </p>

          <div className="mt-4 space-y-4">
            <label className="block">
              <span className="block text-sm font-medium text-near-black">
                Title template
              </span>
              <input
                ref={titleRef}
                value={pair.title}
                onChange={(e) => setPair({ title: e.target.value })}
                onFocus={() => setFocusField('title')}
                maxLength={220}
                spellCheck={false}
                placeholder="e.g. %title% %sep% %sitename%"
                className="mt-2 w-full rounded-xl border border-warm-stone/25 bg-cream-50/80 px-4 py-3 font-mono text-[13px] text-near-black placeholder:text-warm-stone/60 transition-all duration-quick ease-standard hover:border-warm-stone/40 focus:border-copper-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-copper-300/40 min-h-[44px]"
              />
            </label>

            <label className="block">
              <span className="block text-sm font-medium text-near-black">
                Description template
              </span>
              <textarea
                ref={descRef}
                value={pair.description}
                onChange={(e) => setPair({ description: e.target.value })}
                onFocus={() => setFocusField('description')}
                maxLength={360}
                rows={3}
                spellCheck={false}
                placeholder="e.g. %excerpt%"
                className="mt-2 w-full rounded-xl border border-warm-stone/25 bg-cream-50/80 px-4 py-3 font-mono text-[13px] leading-relaxed text-near-black placeholder:text-warm-stone/60 transition-all duration-quick ease-standard hover:border-warm-stone/40 focus:border-copper-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-copper-300/40"
              />
            </label>

            {/* Inserter — splices into whichever field is focused, at the
                caret. A small note tells the operator where a click lands. */}
            <div className="rounded-xl border border-warm-stone/20 bg-cream-50/60 p-4">
              <VariableInserter
                targetRef={targetRef}
                onChange={onInsertChange}
              />
              <p className="mt-3 text-[11px] leading-relaxed text-warm-stone">
                Clicking a variable inserts it into the{' '}
                <span className="font-semibold text-copper-700">
                  {focusField === 'title' ? 'title' : 'description'}
                </span>{' '}
                field at your cursor. Click into the other field first to insert
                there.
              </p>
            </div>

            <TemplatePreview
              titleTemplate={pair.title}
              descriptionTemplate={pair.description}
              context={ctx}
              url={previewUrl}
            />
          </div>
        </div>
      </div>
    </SeoCard>
  )
}

// ─────────────────────────── Indexing policy ───────────────────────────

function IndexingCard({
  initial,
  version: initialVersion,
}: {
  initial: IndexingValue
  version: number
}) {
  const toast = useToast()
  const [form, setForm] = useState<IndexingValue>(initial)
  const [pristine, setPristine] = useState<IndexingValue>(initial)
  const [version, setVersion] = useState(initialVersion)
  const [busy, setBusy] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const dirty = useMemo(() => !structuralEqual(form, pristine), [form, pristine])

  const discourage = form.discourageSearchEngines

  const save = useCallback(async () => {
    if (busy || !dirty) return
    setBusy(true)
    try {
      const r = await csrfFetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'seo_indexing', value: form, version }),
      })
      if (r.status === 400 || r.status === 422) {
        toast.error('Those settings look off — check them and try again.')
        return
      }
      if (r.status === 409) {
        toast.error('Settings changed in another tab. Refresh to see them.')
        return
      }
      if (!r.ok) {
        toast.error("That didn't save. Try again in a moment.")
        return
      }
      // Adopt the authoritative server version (additive) — no-op saves
      // don't bump the DB version, so blind v + 1 desyncs + 409s next.
      const respBody = (await r.json().catch(() => null)) as { version?: number } | null
      setPristine(form)
      setVersion(typeof respBody?.version === 'number' ? respBody.version : (v) => v + 1)
      toast.success('Indexing settings saved.')
    } finally {
      setBusy(false)
    }
  }, [busy, dirty, form, version, toast])

  // Turning the kill-switch ON routes through a confirm modal (never a
  // bare toggle) — it hides the WHOLE site from search. Turning it back
  // OFF is harmless, so that flips immediately.
  function onDiscourageToggle(next: boolean) {
    if (next) {
      setConfirmOpen(true)
    } else {
      setForm((f) => ({ ...f, discourageSearchEngines: false }))
    }
  }

  return (
    <>
      <SeoCard
        title="Search visibility"
        eyebrow="Indexing"
        help="Control whether search engines are allowed to list your pages. Most sites leave everything here on its default."
        dirty={dirty}
        busy={busy}
        onSave={() => void save()}
        onUndo={() => setForm(pristine)}
      >
        <div className="space-y-5">
          {/* The LOUD discourage kill-switch. Amber-tinted when off (it's a
              powerful control) and a hard red alarm state when on. */}
          <div
            className={clsx(
              'rounded-2xl border p-5 transition-colors duration-standard',
              discourage
                ? 'border-red-300/70 bg-red-50/50'
                : 'border-amber-300/50 bg-amber-50/30',
            )}
          >
            <div className="flex items-start gap-3">
              <span
                className={clsx(
                  'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl',
                  discourage
                    ? 'bg-red-500/15 text-red-700'
                    : 'bg-amber-500/15 text-amber-700',
                )}
              >
                <AlertTriangle size={19} strokeWidth={2} aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-near-black">
                  Hide my entire site from search engines
                </p>
                <p className="mt-1 text-[13px] leading-relaxed text-warm-stone">
                  This tells Google, Bing, and every other engine{' '}
                  <strong className="font-semibold text-near-black">
                    not to list any page of your site
                  </strong>
                  . Use it only while you&rsquo;re building privately. Leave it
                  off once you&rsquo;re ready to be found.
                </p>
                {discourage && (
                  <p className="mt-3 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.16em] text-red-700">
                    <span className="inline-flex h-2 w-2 rounded-full bg-red-500 animate-cavecms-pulse-copper" />
                    Your whole site is currently hidden from search
                  </p>
                )}
                <div className="mt-4">
                  <Switch
                    label={discourage ? 'Site is hidden' : 'Keep my site visible'}
                    checked={discourage}
                    onChange={onDiscourageToggle}
                  />
                </div>
              </div>
            </div>
          </div>

          <Switch
            label="Keep search result pages out of search"
            help="Your on-site search results pages are usually thin and duplicative — most sites hide them from Google. Recommended on."
            checked={form.noindexSearch}
            onChange={(v) => setForm((f) => ({ ...f, noindexSearch: v }))}
          />

          <Switch
            label="Keep paginated pages out of search"
            help="Pages 2, 3, 4… of a long list. Hiding them avoids near-duplicate listings. Off by default — turn on only if you see duplicate pages in search."
            checked={form.noindexPaginated}
            onChange={(v) => setForm((f) => ({ ...f, noindexPaginated: v }))}
          />
        </div>
      </SeoCard>

      <ConfirmModal
        open={confirmOpen}
        destructive
        title="Hide your whole site from search?"
        description="No page on your site will be listed by Google or any other search engine until you turn this back off and save. This is meant for private, pre-launch sites."
        confirmLabel="Yes, hide my site"
        cancelLabel="Keep it visible"
        onConfirm={() => {
          setForm((f) => ({ ...f, discourageSearchEngines: true }))
          setConfirmOpen(false)
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  )
}
