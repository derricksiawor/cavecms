'use client'

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  LayoutGrid,
  Rows3,
  Square,
  SquareStack,
  Newspaper,
  Columns2,
  Columns3,
  Minus,
  ListOrdered,
  MousePointerClick,
  RectangleHorizontal,
} from 'lucide-react'
import { csrfFetch } from '@/lib/client/csrf'
import { Button } from '@/components/ui/Button'
import { Switch } from '@/components/inline-edit/Switch'
import { useToast } from '@/components/inline-edit/Toast'
import { structuralEqual } from '@/lib/structuralEqual'

// Settings → Blog. One card writing the single `blog_settings` row.
// Standard settings mechanics (mirrors EmailSettingsClient): a draft `form`
// + a `pristine` baseline + an optimistic-lock `version`; Save PATCHes
// /api/admin/settings with { key, value, version }; 409 → "changed in
// another tab" + reload hint; success bumps version + rebases pristine.
//
// Per #0.59, every visual choice is a VISUAL control: layout + columns are
// segmented tiles that render what they produce, the three on/off fields are
// real copper toggles, and the three counts are bounded number steppers with
// a one-line helper each — never a <select> wall of names.

// blog_settings value shape (mirrors the registry Zod schema). Duplicated
// here so the client form is fully typed without importing the server-only
// settings-registry. Bounds match the registry exactly.
interface BlogSettings {
  postsPerPage: number
  layout: 'grid' | 'list'
  template: 'grid' | 'cards' | 'list' | 'magazine'
  columns: 1 | 2 | 3 | 4
  showExcerpt: boolean
  showDate: boolean
  showAuthor: boolean
  showCategory: boolean
  showReadingTime: boolean
  showReadMore: boolean
  readMoreLabel: string
  excerptClamp: number
  cardStyle: 'flat' | 'soft' | 'elevated'
  spacing: 'tight' | 'comfortable' | 'airy'
  imageAspect: '16:9' | '4:3' | '3:2' | '1:1' | '4:5'
  pagination: 'numbered' | 'load-more' | 'none'
  feedItemCount: number
  relatedPostsCount: number
}

interface Props {
  initial: {
    value: BlogSettings
    version: number
  }
}

// Field bounds — kept in lockstep with registry['blog_settings'].schema. The
// server Zod gate is the real validator; these clamp the stepper UI so the
// operator can't even produce an out-of-range draft.
const BOUNDS = {
  postsPerPage: { min: 1, max: 50 },
  excerptClamp: { min: 0, max: 6 },
  feedItemCount: { min: 1, max: 50 },
  relatedPostsCount: { min: 0, max: 6 },
} as const

export function BlogSettingsForm({ initial }: Props) {
  const toast = useToast()
  const [form, setForm] = useState<BlogSettings>(initial.value)
  const [pristine, setPristine] = useState<BlogSettings>(initial.value)
  const [version, setVersion] = useState(initial.version)
  const [saving, setSaving] = useState(false)

  const dirty = useMemo(
    () => !structuralEqual(form, pristine),
    [form, pristine],
  )

  const set = useCallback(
    <K extends keyof BlogSettings>(key: K, value: BlogSettings[K]) => {
      setForm((f) => ({ ...f, [key]: value }))
    },
    [],
  )

  // Clamp + integer-coerce a count field on every change so a draft can never
  // hold a NaN / fractional / out-of-range value that the server would reject.
  const setCount = useCallback(
    (key: 'postsPerPage' | 'excerptClamp' | 'feedItemCount' | 'relatedPostsCount', raw: string) => {
      const { min, max } = BOUNDS[key]
      const n = Number.parseInt(raw, 10)
      // Empty / non-numeric input → snap to min so the field never goes blank
      // mid-edit and the stored value stays valid. (The stepper buttons keep
      // the common case one-click anyway.)
      const clamped = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min
      setForm((f) => ({ ...f, [key]: clamped }))
    },
    [],
  )

  const handleSave = useCallback(async () => {
    if (saving || !dirty) return
    setSaving(true)
    try {
      const r = await csrfFetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'blog_settings', value: form, version }),
      })
      if (r.status === 400) {
        toast.error('Some fields look off — check them and try again.')
        return
      }
      if (r.status === 409) {
        // Optimistic-lock conflict — another tab/admin saved first. Reloading
        // pulls the winning row so the operator edits from the latest state.
        toast.error('Settings changed in another tab. Refresh to see them.')
        return
      }
      if (!r.ok) {
        toast.error("That didn't save. Try again in a moment.")
        return
      }
      setVersion((v) => v + 1)
      setPristine(form)
      toast.success('Blog settings saved.')
    } finally {
      setSaving(false)
    }
  }, [saving, dirty, form, version, toast])

  return (
    <section className="mt-10 space-y-6">
      <article className="rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-6 backdrop-blur-sm">
        <header>
          <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-600">
            Reading
          </p>
          <h2 className="mt-1 font-serif text-xl font-bold tracking-tight text-near-black">
            How your blog reads
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-warm-stone">
            These control how your blog index and category/tag archives display
            posts. The page-size setting also seeds new Blog Loop blocks; a block
            can set its own posts-per-page if you need a different count.
          </p>
        </header>

        <div className="mt-8 space-y-8">
          {/* Posts per page */}
          <Field
            label="Posts per page"
            help="How many posts the Blog Loop shows before paging to the next set."
          >
            <NumberStepper
              value={form.postsPerPage}
              min={BOUNDS.postsPerPage.min}
              max={BOUNDS.postsPerPage.max}
              onChange={(n) => set('postsPerPage', n)}
              onType={(s) => setCount('postsPerPage', s)}
              unit="posts"
            />
          </Field>

          {/* Layout (template) — visual tiles that render what they produce (#0.59).
              `layout` is kept in sync (grid/list) for back-compat. */}
          <Field
            label="Default layout"
            help="The default arrangement for your blog index and archives. Each post widget you place can override this."
          >
            <SegmentedControl
              value={form.template}
              onChange={(v) => {
                set('template', v)
                // Keep the legacy grid|list switch in lockstep so an old
                // consumer reading `layout` still resolves sensibly.
                set('layout', v === 'list' ? 'list' : 'grid')
              }}
              options={[
                { value: 'grid' as const, label: 'Grid', icon: <LayoutGrid className="h-5 w-5" strokeWidth={1.75} /> },
                { value: 'cards' as const, label: 'Cards', icon: <SquareStack className="h-5 w-5" strokeWidth={1.75} /> },
                { value: 'list' as const, label: 'List', icon: <Rows3 className="h-5 w-5" strokeWidth={1.75} /> },
                { value: 'magazine' as const, label: 'Magazine', icon: <Newspaper className="h-5 w-5" strokeWidth={1.75} /> },
              ]}
            />
          </Field>

          {/* Columns — 1–4; not meaningful for list (dimmed) */}
          <Field
            label="Columns"
            help={
              form.template === 'list'
                ? 'Columns apply to grid, cards and magazine. List is always one column.'
                : 'How many cards sit side by side on a wide screen.'
            }
          >
            <SegmentedControl
              value={form.columns}
              onChange={(v) => set('columns', v)}
              disabled={form.template === 'list'}
              options={[
                { value: 1 as const, label: 'One', icon: <Minus className="h-5 w-5" strokeWidth={1.75} /> },
                { value: 2 as const, label: 'Two', icon: <Columns2 className="h-5 w-5" strokeWidth={1.75} /> },
                { value: 3 as const, label: 'Three', icon: <Columns3 className="h-5 w-5" strokeWidth={1.75} /> },
                { value: 4 as const, label: 'Four', icon: <LayoutGrid className="h-5 w-5" strokeWidth={1.75} /> },
              ]}
            />
          </Field>

          {/* Card style preset */}
          <Field
            label="Card style"
            help="Flat shows just the image and text; Soft adds a subtle panel; Elevated adds a soft shadow that lifts on hover."
          >
            <SegmentedControl
              value={form.cardStyle}
              onChange={(v) => set('cardStyle', v)}
              options={[
                { value: 'flat' as const, label: 'Flat', icon: <Square className="h-5 w-5" strokeWidth={1.75} /> },
                { value: 'soft' as const, label: 'Soft', icon: <SquareStack className="h-5 w-5" strokeWidth={1.75} /> },
                { value: 'elevated' as const, label: 'Elevated', icon: <RectangleHorizontal className="h-5 w-5" strokeWidth={1.75} /> },
              ]}
            />
          </Field>

          {/* Spacing preset */}
          <Field label="Spacing" help="How much breathing room sits between cards.">
            <SegmentedControl
              value={form.spacing}
              onChange={(v) => set('spacing', v)}
              options={[
                { value: 'tight' as const, label: 'Tight', icon: <Rows3 className="h-5 w-5" strokeWidth={1.75} /> },
                { value: 'comfortable' as const, label: 'Comfortable', icon: <LayoutGrid className="h-5 w-5" strokeWidth={1.75} /> },
                { value: 'airy' as const, label: 'Airy', icon: <SquareStack className="h-5 w-5" strokeWidth={1.75} /> },
              ]}
            />
          </Field>

          {/* Image aspect ratio */}
          <Field label="Image shape" help="The aspect ratio of each post’s featured image.">
            <SegmentedControl
              value={form.imageAspect}
              onChange={(v) => set('imageAspect', v)}
              options={[
                { value: '16:9' as const, label: '16:9', icon: <RectangleHorizontal className="h-5 w-5" strokeWidth={1.75} /> },
                { value: '4:3' as const, label: '4:3', icon: <RectangleHorizontal className="h-5 w-5" strokeWidth={1.75} /> },
                { value: '3:2' as const, label: '3:2', icon: <RectangleHorizontal className="h-5 w-5" strokeWidth={1.75} /> },
                { value: '1:1' as const, label: '1:1', icon: <Square className="h-5 w-5" strokeWidth={1.75} /> },
                { value: '4:5' as const, label: '4:5', icon: <Square className="h-5 w-5" strokeWidth={1.75} /> },
              ]}
            />
          </Field>

          {/* Pagination */}
          <Field
            label="Pagination"
            help="How readers move through the archive. Numbered is best for SEO; Load more appends in place; None hides paging."
          >
            <SegmentedControl
              value={form.pagination}
              onChange={(v) => set('pagination', v)}
              options={[
                { value: 'numbered' as const, label: 'Numbered', icon: <ListOrdered className="h-5 w-5" strokeWidth={1.75} /> },
                { value: 'load-more' as const, label: 'Load more', icon: <MousePointerClick className="h-5 w-5" strokeWidth={1.75} /> },
                { value: 'none' as const, label: 'None', icon: <Minus className="h-5 w-5" strokeWidth={1.75} /> },
              ]}
            />
          </Field>

          {/* Card content toggles */}
          <Field label="On each post card">
            <div className="space-y-4">
              <Switch
                checked={form.showExcerpt}
                onChange={(v) => set('showExcerpt', v)}
                label="Show excerpt"
                help="The short summary under the title."
              />
              <Switch
                checked={form.showDate}
                onChange={(v) => set('showDate', v)}
                label="Show date"
                help="The day the post was published."
              />
              <Switch
                checked={form.showAuthor}
                onChange={(v) => set('showAuthor', v)}
                label="Show author"
                help="The writer’s name with a monogram."
              />
              <Switch
                checked={form.showCategory}
                onChange={(v) => set('showCategory', v)}
                label="Show category"
                help="Category links on each card."
              />
              <Switch
                checked={form.showReadingTime}
                onChange={(v) => set('showReadingTime', v)}
                label="Show reading time"
                help="An estimated “X min read”, based on the post’s length."
              />
              <Switch
                checked={form.showReadMore}
                onChange={(v) => set('showReadMore', v)}
                label="Show “read more” link"
                help="A read-more affordance under the excerpt."
              />
            </div>
          </Field>

          {/* Read-more label + excerpt line limit */}
          <Field label="Read-more label" help="The text of the read-more link (when shown).">
            <input
              type="text"
              value={form.readMoreLabel}
              maxLength={40}
              onChange={(e) => set('readMoreLabel', e.target.value)}
              placeholder="Read more"
              className="h-11 w-full max-w-xs rounded-xl border border-warm-stone/25 bg-cream-50 px-4 text-sm font-medium text-near-black placeholder:text-warm-stone/50 focus:border-copper-400 focus:outline-none focus:ring-2 focus:ring-copper-300/40"
            />
          </Field>

          <Field label="Excerpt line limit" help="Maximum lines of excerpt before it’s trimmed. 0 = no limit.">
            <NumberStepper
              value={form.excerptClamp}
              min={BOUNDS.excerptClamp.min}
              max={BOUNDS.excerptClamp.max}
              onChange={(n) => set('excerptClamp', n)}
              onType={(s) => setCount('excerptClamp', s)}
              unit="lines"
            />
          </Field>

          {/* Feed item count */}
          <Field
            label="Feed item count"
            help="How many of the most recent posts appear in your RSS/Atom feed."
          >
            <NumberStepper
              value={form.feedItemCount}
              min={BOUNDS.feedItemCount.min}
              max={BOUNDS.feedItemCount.max}
              onChange={(n) => set('feedItemCount', n)}
              onType={(s) => setCount('feedItemCount', s)}
              unit="items"
            />
          </Field>

          {/* Related posts count */}
          <Field
            label="Related posts"
            help="How many related posts to suggest at the bottom of a post. Set to 0 to hide the rail."
          >
            <NumberStepper
              value={form.relatedPostsCount}
              min={BOUNDS.relatedPostsCount.min}
              max={BOUNDS.relatedPostsCount.max}
              onChange={(n) => set('relatedPostsCount', n)}
              onType={(s) => setCount('relatedPostsCount', s)}
              unit="posts"
            />
          </Field>
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSave()}
            disabled={saving || !dirty}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
          {dirty && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setForm(pristine)}
              disabled={saving}
            >
              Undo changes
            </Button>
          )}
          {dirty && (
            <span className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-copper-700">
              <span className="inline-flex h-2 w-2 rounded-full bg-copper-500 animate-cavecms-pulse-copper" />
              Unsaved changes
            </span>
          )}
        </div>
      </article>
    </section>
  )
}

// A labelled field row — eyebrow-ish label + one-line helper + the control.
function Field({
  label,
  help,
  children,
}: {
  label: string
  help?: string
  children: ReactNode
}) {
  return (
    <div>
      <p className="text-sm font-semibold text-near-black">{label}</p>
      {help && (
        <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-warm-stone">
          {help}
        </p>
      )}
      <div className="mt-3">{children}</div>
    </div>
  )
}

// Segmented control — visual tiles, each rendering the icon for what it
// produces plus a short label (#0.59: render the visual, not a name dropdown).
// Generic over the option value so both the string `layout` and numeric
// `columns` fields reuse it with full type-safety.
function SegmentedControl<T extends string | number>({
  value,
  onChange,
  options,
  disabled,
}: {
  value: T
  onChange: (v: T) => void
  options: ReadonlyArray<{ value: T; label: string; icon: ReactNode }>
  disabled?: boolean
}) {
  return (
    <div
      role="radiogroup"
      className={clsx(
        'inline-flex flex-wrap gap-2',
        disabled && 'opacity-50',
      )}
    >
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => !disabled && onChange(o.value)}
            className={clsx(
              'inline-flex w-[112px] flex-col items-center gap-2 rounded-xl border px-4 py-4 transition-all duration-standard ease-standard cavecms-focus-ring',
              disabled ? 'cursor-not-allowed' : 'cursor-pointer',
              active
                ? 'border-copper-500 bg-copper-500/[0.08] text-copper-700 ring-1 ring-copper-400/40'
                : 'border-warm-stone/25 bg-cream-50 text-warm-stone hover:border-warm-stone/40 hover:text-near-black',
            )}
          >
            <span className={active ? 'text-copper-600' : 'text-warm-stone'}>
              {o.icon}
            </span>
            <span className="text-xs font-semibold tracking-wide">{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}

// Bounded number stepper — −/+ buttons plus a typeable field. Clamps to
// [min, max] on every interaction so the draft is always server-valid.
function NumberStepper({
  value,
  min,
  max,
  onChange,
  onType,
  unit,
}: {
  value: number
  min: number
  max: number
  onChange: (n: number) => void
  onType: (raw: string) => void
  unit?: string
}) {
  const dec = () => onChange(Math.max(min, value - 1))
  const inc = () => onChange(Math.min(max, value + 1))
  return (
    <div className="inline-flex items-center gap-3">
      <div className="inline-flex items-center rounded-xl border border-warm-stone/25 bg-cream-50">
        <button
          type="button"
          onClick={dec}
          disabled={value <= min}
          aria-label="Decrease"
          className="flex h-11 w-11 items-center justify-center rounded-l-xl text-lg font-semibold text-warm-stone transition-colors hover:text-near-black disabled:opacity-40 disabled:hover:text-warm-stone cavecms-focus-ring"
        >
          −
        </button>
        <input
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onType(e.target.value)}
          className="h-11 w-16 border-x border-warm-stone/25 bg-transparent text-center text-sm font-semibold text-near-black focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <button
          type="button"
          onClick={inc}
          disabled={value >= max}
          aria-label="Increase"
          className="flex h-11 w-11 items-center justify-center rounded-r-xl text-lg font-semibold text-warm-stone transition-colors hover:text-near-black disabled:opacity-40 disabled:hover:text-warm-stone cavecms-focus-ring"
        >
          +
        </button>
      </div>
      {unit && (
        <span className="text-[12px] font-medium uppercase tracking-eyebrow text-warm-stone">
          {unit}
        </span>
      )}
    </div>
  )
}
