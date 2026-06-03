'use client'

import { useRef, type ReactNode } from 'react'
import {
  Code2,
  Plus,
  Trash2,
  FileText,
  BookOpen,
  Newspaper,
  HelpCircle,
  ListChecks,
  Package,
  AppWindow,
  Globe,
  Ban,
  type LucideIcon,
} from 'lucide-react'
import clsx from 'clsx'
import { Input } from '@/components/ui/Input'
import {
  type PanelSeoMeta,
  type SchemaTypeValue,
  SCHEMA_TYPE_VALUES,
} from '@/lib/cms/seoEditorFields'

// ─────────────────────────────────────────────────────────────────────
// Schema picker sub-system — extracted from PageSeoPanel (M1). The visual
// tile grid (#0.59) + the per-type FAQ / HowTo repeatable sub-editors +
// the schemaData readers. Pure controlled UI: the panel threads the
// override bag + change handler in.
// ─────────────────────────────────────────────────────────────────────

// The 8 schema types rendered as a visual tile picker (#0.59). Each
// carries a lucide icon + plain-language label + one-line "what it's
// for" hint. `null` represents the "None" tile (page defaults). The tile
// list is DERIVED from the single-source-of-truth SCHEMA_TYPE_VALUES so
// it can never drift from the accepted enum.
const SCHEMA_TILE_META: Record<
  SchemaTypeValue,
  { label: string; hint: string; icon: LucideIcon }
> = {
  Article: { label: 'Article', hint: 'General editorial article', icon: FileText },
  BlogPosting: { label: 'Blog post', hint: 'A post on your blog', icon: BookOpen },
  NewsArticle: { label: 'News', hint: 'Time-sensitive news story', icon: Newspaper },
  FAQPage: { label: 'FAQ', hint: 'A list of questions & answers', icon: HelpCircle },
  HowTo: { label: 'How-to', hint: 'Step-by-step instructions', icon: ListChecks },
  Product: { label: 'Product', hint: 'A product for sale', icon: Package },
  SoftwareApplication: { label: 'App', hint: 'A software application', icon: AppWindow },
  WebPage: { label: 'Web page', hint: 'A standard web page', icon: Globe },
}

const SCHEMA_TILES: ReadonlyArray<{
  value: SchemaTypeValue
  label: string
  hint: string
  icon: LucideIcon
}> = SCHEMA_TYPE_VALUES.map((value) => ({ value, ...SCHEMA_TILE_META[value] }))

export function SchemaPicker({
  seoMeta,
  onSeoMetaChange,
  disabled,
}: {
  seoMeta: PanelSeoMeta
  onSeoMetaChange: (next: PanelSeoMeta) => void
  disabled?: boolean
}) {
  const selected = seoMeta.schemaType ?? null

  const selectType = (next: SchemaTypeValue | null) => {
    if (next === null) {
      // Clear both type + data — back to page defaults.
      const { schemaType: _t, schemaData: _d, ...rest } = seoMeta
      void _t
      void _d
      onSeoMetaChange(rest)
      return
    }
    onSeoMetaChange({ ...seoMeta, schemaType: next })
  }

  return (
    <div className="space-y-5">
      <p className="text-[12px] leading-relaxed text-warm-stone">
        Structured data helps search engines show rich results — like FAQ
        drop-downs or step lists. Leave it on{' '}
        <span className="font-medium text-near-black">None</span> and we
        pick a sensible default for you.
      </p>

      <div
        role="radiogroup"
        aria-label="Structured data type"
        className="grid grid-cols-3 gap-2.5 sm:grid-cols-3"
      >
        <SchemaTile
          selected={selected === null}
          label="None"
          hint="Use page defaults"
          icon={Ban}
          onSelect={() => selectType(null)}
          disabled={disabled}
        />
        {SCHEMA_TILES.map((t) => (
          <SchemaTile
            key={t.value}
            selected={selected === t.value}
            label={t.label}
            hint={t.hint}
            icon={t.icon}
            onSelect={() => selectType(t.value)}
            disabled={disabled}
          />
        ))}
      </div>

      {selected === 'FAQPage' && (
        <FaqEditor seoMeta={seoMeta} onSeoMetaChange={onSeoMetaChange} disabled={disabled} />
      )}
      {selected === 'HowTo' && (
        <HowToEditor seoMeta={seoMeta} onSeoMetaChange={onSeoMetaChange} disabled={disabled} />
      )}
      {selected !== null && selected !== 'FAQPage' && selected !== 'HowTo' && (
        <p className="flex items-start gap-2 rounded-xl bg-copper-50/60 px-4 py-3 text-[12px] leading-relaxed text-near-black/75">
          <Code2 size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-copper-600" />
          This page is tagged as{' '}
          <span className="font-medium">
            {SCHEMA_TILES.find((t) => t.value === selected)?.label}
          </span>
          . We build the structured data from this page’s own title,
          description, image and dates — no extra fields needed.
        </p>
      )}
    </div>
  )
}

function SchemaTile({
  selected,
  label,
  hint,
  icon: Icon,
  onSelect,
  disabled,
}: {
  selected: boolean
  label: string
  hint: string
  icon: LucideIcon
  onSelect: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={`${label} — ${hint}`}
      title={hint}
      onClick={onSelect}
      disabled={disabled}
      className={clsx(
        'group/tile flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-center transition-all duration-quick ease-standard cavecms-focus-ring disabled:cursor-not-allowed disabled:opacity-50',
        selected
          ? 'border-copper-400 bg-copper-50/70 shadow-[0_8px_22px_-14px_rgba(184,115,51,0.5)]'
          : 'border-warm-stone/20 bg-cream-50/70 hover:border-copper-300/70 hover:bg-cream-100/60',
      )}
    >
      <span
        aria-hidden
        className={clsx(
          'inline-flex h-9 w-9 items-center justify-center rounded-lg transition-colors',
          selected
            ? 'bg-copper-500 text-cream-50'
            : 'bg-near-black/[0.05] text-near-black/70 group-hover/tile:bg-copper-500/15 group-hover/tile:text-copper-600',
        )}
      >
        <Icon size={16} strokeWidth={1.9} />
      </span>
      <span
        className={clsx(
          'text-[11px] font-semibold leading-tight',
          selected ? 'text-copper-800' : 'text-near-black',
        )}
      >
        {label}
      </span>
    </button>
  )
}

// Graceful cap on FAQ items / HowTo steps. Mirrors the render-side
// MAX_SCHEMA_ITEMS in lib/seo/schema/forPage.ts so the operator can never
// author past what the JSON-LD will emit. At the cap the Add control is
// disabled and the count badge reads "50 / 50" (#0.251 graceful cap — no
// silent failure, the operator sees exactly why Add is unavailable).
const MAX_SCHEMA_ITEMS = 50

// ── Stable client ids for repeatable rows (L1) ───────────────────────
// FAQ items / HowTo steps live in seoMeta.schemaData (persisted) and have
// no intrinsic id. Keying rows by array index makes React reuse the wrong
// input on insert/remove (the deleted row's text bleeds into its
// neighbour). `useRowIds` keeps a parallel id list — sized to the current
// item count — so each row gets a stable client-only key for its lifetime
// without polluting the persisted data shape. Ids are minted lazily and
// trimmed when the count shrinks.
function useRowIds(count: number): string[] {
  const idsRef = useRef<string[]>([])
  const seqRef = useRef(0)
  const ids = idsRef.current
  if (ids.length < count) {
    while (ids.length < count) ids.push(`row-${seqRef.current++}`)
  } else if (ids.length > count) {
    ids.length = count
  }
  // Return a copy so the render reads a stable snapshot.
  return [...ids]
}

// ── FAQ sub-editor — writes seoMeta.schemaData.items = [{question,answer}].
// forPage.buildFaq reads `items` (or `faqs`) → {question, answer}.

interface FaqItem {
  question: string
  answer: string
}

function readFaqItems(data: Record<string, unknown> | null | undefined): FaqItem[] {
  const raw = data && Array.isArray(data.items) ? data.items : []
  return raw.map((r) => {
    const rec = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
    return {
      question: typeof rec.question === 'string' ? rec.question : '',
      answer: typeof rec.answer === 'string' ? rec.answer : '',
    }
  })
}

function FaqEditor({
  seoMeta,
  onSeoMetaChange,
  disabled,
}: {
  seoMeta: PanelSeoMeta
  onSeoMetaChange: (next: PanelSeoMeta) => void
  disabled?: boolean
}) {
  const items = readFaqItems(seoMeta.schemaData)
  const rowIds = useRowIds(items.length)

  const write = (next: FaqItem[]) => {
    onSeoMetaChange({
      ...seoMeta,
      schemaData: { ...(seoMeta.schemaData ?? {}), items: next },
    })
  }

  const update = (i: number, patch: Partial<FaqItem>) => {
    write(items.map((it, j) => (j === i ? { ...it, ...patch } : it)))
  }
  const add = () => {
    // Graceful cap — never write past MAX_SCHEMA_ITEMS (the Add button is
    // also disabled at the cap, this guard is belt-and-braces).
    if (items.length >= MAX_SCHEMA_ITEMS) return
    write([...items, { question: '', answer: '' }])
  }
  const remove = (i: number) => write(items.filter((_, j) => j !== i))

  return (
    <RepeatableEditor
      title="Questions & answers"
      help="Each pair can show as a drop-down in search results."
      itemCount={items.length}
      maxItems={MAX_SCHEMA_ITEMS}
      onAdd={add}
      addLabel="Add a question"
      disabled={disabled}
      emptyLabel="No questions yet. Add your first to enable the FAQ rich result."
    >
      {items.map((it, i) => (
        <RepeatableRow key={rowIds[i]} index={i} onRemove={() => remove(i)} disabled={disabled}>
          <Input
            value={it.question}
            onChange={(e) => update(i, { question: e.target.value })}
            placeholder="Question"
            maxLength={300}
            disabled={disabled}
          />
          <textarea
            value={it.answer}
            onChange={(e) => update(i, { answer: e.target.value })}
            placeholder="Answer"
            rows={2}
            maxLength={1000}
            disabled={disabled}
            className="mt-2 block w-full rounded-xl border border-warm-stone/25 bg-cream-50/80 px-4 py-2.5 text-sm text-near-black placeholder:text-warm-stone/55 transition-all duration-quick focus:border-copper-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-copper-300/40 disabled:opacity-50"
          />
        </RepeatableRow>
      ))}
    </RepeatableEditor>
  )
}

// ── HowTo sub-editor — writes seoMeta.schemaData.steps = [{name,text}].
// forPage.buildHowTo reads `steps` → {name, text|description}.

interface HowToStep {
  name: string
  text: string
}

function readHowToSteps(
  data: Record<string, unknown> | null | undefined,
): HowToStep[] {
  const raw = data && Array.isArray(data.steps) ? data.steps : []
  return raw.map((r) => {
    const rec = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
    return {
      name: typeof rec.name === 'string' ? rec.name : '',
      text:
        typeof rec.text === 'string'
          ? rec.text
          : typeof rec.description === 'string'
            ? rec.description
            : '',
    }
  })
}

function HowToEditor({
  seoMeta,
  onSeoMetaChange,
  disabled,
}: {
  seoMeta: PanelSeoMeta
  onSeoMetaChange: (next: PanelSeoMeta) => void
  disabled?: boolean
}) {
  const steps = readHowToSteps(seoMeta.schemaData)
  const rowIds = useRowIds(steps.length)

  const write = (next: HowToStep[]) => {
    onSeoMetaChange({
      ...seoMeta,
      schemaData: { ...(seoMeta.schemaData ?? {}), steps: next },
    })
  }
  const update = (i: number, patch: Partial<HowToStep>) => {
    write(steps.map((it, j) => (j === i ? { ...it, ...patch } : it)))
  }
  const add = () => {
    // Graceful cap — never write past MAX_SCHEMA_ITEMS (the Add button is
    // also disabled at the cap, this guard is belt-and-braces).
    if (steps.length >= MAX_SCHEMA_ITEMS) return
    write([...steps, { name: '', text: '' }])
  }
  const remove = (i: number) => write(steps.filter((_, j) => j !== i))

  return (
    <RepeatableEditor
      title="Steps"
      help="List the steps in order. Each needs a short name and instructions."
      itemCount={steps.length}
      maxItems={MAX_SCHEMA_ITEMS}
      onAdd={add}
      addLabel="Add a step"
      disabled={disabled}
      emptyLabel="No steps yet. Add your first to enable the How-to rich result."
    >
      {steps.map((it, i) => (
        <RepeatableRow
          key={rowIds[i]}
          index={i}
          onRemove={() => remove(i)}
          disabled={disabled}
          badge={`Step ${i + 1}`}
        >
          <Input
            value={it.name}
            onChange={(e) => update(i, { name: e.target.value })}
            placeholder="Step name"
            maxLength={120}
            disabled={disabled}
          />
          <textarea
            value={it.text}
            onChange={(e) => update(i, { text: e.target.value })}
            placeholder="What to do in this step"
            rows={2}
            maxLength={1000}
            disabled={disabled}
            className="mt-2 block w-full rounded-xl border border-warm-stone/25 bg-cream-50/80 px-4 py-2.5 text-sm text-near-black placeholder:text-warm-stone/55 transition-all duration-quick focus:border-copper-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-copper-300/40 disabled:opacity-50"
          />
        </RepeatableRow>
      ))}
    </RepeatableEditor>
  )
}

// Shared shell for the FAQ / HowTo repeatable editors.
function RepeatableEditor({
  title,
  help,
  itemCount,
  maxItems,
  onAdd,
  addLabel,
  emptyLabel,
  disabled,
  children,
}: {
  title: string
  help: string
  itemCount: number
  /** Graceful cap: at this count the Add control is disabled and the badge
   *  reads "N / max" (#0.251). */
  maxItems: number
  onAdd: () => void
  addLabel: string
  emptyLabel: string
  disabled?: boolean
  children: ReactNode
}) {
  const atCap = itemCount >= maxItems
  return (
    <div className="rounded-xl border border-warm-stone/15 bg-cream-50/70 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-near-black">{title}</h4>
          <p className="mt-0.5 text-[11px] leading-relaxed text-warm-stone">{help}</p>
        </div>
        {/* Count badge. Shows the bare count until the operator nears the
            cap, then surfaces "N / max" so the ceiling is visible BEFORE
            Add disables — no silent failure (#0.251). */}
        <span
          className={clsx(
            'shrink-0 rounded-full px-2.5 py-1 text-[10px] font-semibold tabular-nums',
            atCap
              ? 'bg-copper-500/15 text-copper-700'
              : 'bg-near-black/[0.05] text-warm-stone',
          )}
        >
          {itemCount >= maxItems - 5 ? `${itemCount} / ${maxItems}` : itemCount}
        </span>
      </div>
      <div className="mt-4 space-y-3">
        {itemCount === 0 ? (
          <p className="rounded-lg bg-near-black/[0.03] px-4 py-5 text-center text-[12px] text-warm-stone">
            {emptyLabel}
          </p>
        ) : (
          children
        )}
      </div>
      <button
        type="button"
        onClick={onAdd}
        disabled={disabled || atCap}
        title={atCap ? `You've reached the maximum of ${maxItems}.` : undefined}
        className="mt-3 inline-flex w-fit items-center gap-2 rounded-full border border-warm-stone/30 px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-near-black transition-colors hover:border-copper-400 hover:text-copper-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Plus size={12} strokeWidth={2.2} />
        {addLabel}
      </button>
      {atCap && (
        <p className="mt-2 text-[11px] leading-relaxed text-copper-700">
          You’ve reached the maximum of {maxItems}. Remove one to add another.
        </p>
      )}
    </div>
  )
}

function RepeatableRow({
  index,
  onRemove,
  disabled,
  badge,
  children,
}: {
  index: number
  onRemove: () => void
  disabled?: boolean
  badge?: string
  children: ReactNode
}) {
  return (
    <div
      className="rounded-xl border border-warm-stone/15 bg-white/60 p-3 animate-cavecms-fade-in"
      style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-copper-600">
          {badge ?? `#${index + 1}`}
        </span>
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          aria-label="Remove"
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-warm-stone transition-colors hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Trash2 size={13} strokeWidth={2} />
        </button>
      </div>
      {children}
    </div>
  )
}
