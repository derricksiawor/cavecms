'use client'
import { useMemo } from 'react'
import { assertNever } from '@/lib/typeUtils'
import { Share2, Layers, ListChecks } from 'lucide-react'
import { EmptyState } from './EmptyState'
import { MediaPicker } from './MediaPicker'
import { useMediaPicker } from './MediaPickerProvider'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Switch } from './Switch'
import { Stepper } from './Stepper'
import { TagInput } from './TagInput'
import { RichTextEditor } from './RichTextEditor'
import { DatePicker } from './DatePicker'
import { SortableList, DragHandle } from './SortableList'
import { SocialLinkRow, type SocialLinkValue } from './SocialLinkRow'
import { TEXT_MAX } from '@/lib/cms/limits'
import {
  ColorPickerField,
  FontFamilyPickerField,
  FontWeightPickerField,
  IconPickerField,
} from './pickers'
import type { ColorToken, FontFamilyToken, FontWeightToken } from '@/lib/cms/designTokens'

// Visual-form renderer. The `kind` discriminator drives which premium
// widget the field uses. Server-side Zod schemas validate the final
// payload; this renderer is the operator-facing surface — never raw
// JSON, never a mono-font textarea.
//
// New kinds added in this iteration:
//   - `date`       : real <input type="date"> with luxury skin.
//   - `slug`       : delegated to <SlugInput>; not used here directly
//                    (slug lives on top-level meta forms, not inside
//                    section data shapes).
//   - `social_link`: pre-set platform + URL with platform icons.
//   - `cta` kept   : but now with cleaner field layout.

export type FieldShape =
  | {
      kind: 'string'
      key: string
      label: string
      maxLength?: number
      multiline?: boolean
      placeholder?: string
      help?: string
      // Optional regex-validation hint for plain-text inputs. When set,
      // the input is marked aria-invalid + shows `patternError` as a
      // helper string until the value satisfies the pattern (or is
      // empty). Empty string is always considered valid here so the
      // operator can clear the field — the Zod schema upstream may
      // independently require the field via .min(1).
      pattern?: RegExp
      patternError?: string
    }
  | { kind: 'richtext'; key: string; label: string; maxLength?: number; placeholder?: string; help?: string }
  | { kind: 'media'; key: string; label: string; accept?: 'image' | 'pdf'; help?: string }
  | { kind: 'cta'; key: string; label: string }
  // Same shape as 'cta' minus the `text` field — for blocks whose link
  // wraps a different visual (e.g. IconBox's whole-box click target).
  // The value is { href, openInNew } | undefined; a cleared href maps
  // to undefined so the optional schema accepts no-link state.
  | { kind: 'link'; key: string; label: string; help?: string }
  | { kind: 'media_array'; key: string; label: string; help?: string }
  | { kind: 'string_array'; key: string; label: string; placeholder?: string; maxItems?: number; help?: string }
  | { kind: 'number'; key: string; label: string; min?: number; max?: number; step?: number; help?: string }
  | { kind: 'boolean'; key: string; label: string; help?: string }
  | { kind: 'select'; key: string; label: string; valueAsNumber?: boolean; options: Array<{ value: string; label: string }>; help?: string }
  | { kind: 'date'; key: string; label: string; min?: string; max?: string; help?: string }
  | { kind: 'social_link'; key: string; label: string }
  | { kind: 'social_link_array'; key: string; label: string; addLabel?: string; maxItems?: number; help?: string }
  | {
      kind: 'object_array'
      key: string
      label: string
      itemFields: FieldShape[]
      itemTitle?: (item: Record<string, unknown>, i: number) => string
      // Used in the "Add your first {itemNoun}" empty-state copy.
      // Operator-facing — required for fluent English (the prior
      // heuristic produced "amenity lis"). Singular form, lowercase.
      itemNoun?: string
      addLabel?: string
      maxItems?: number
      help?: string
    }
  // ─── Elementor-parity picker kinds (Chunk M) ──────────────────────
  // Token-or-hex colour. `tokens` is an optional subset of ColorToken
  // (defaults to all 6). `allowCustom=false` locks the picker to brand
  // swatches only — useful for tone fields. `allowAlpha=false` hides
  // the alpha strip for opaque-only surfaces.
  | {
      kind: 'color'
      key: string
      label: string
      tokens?: ReadonlyArray<ColorToken>
      allowCustom?: boolean
      allowAlpha?: boolean
      help?: string
    }
  // Display vs Body brand-family override. Picker shows every option
  // styled in its own face. Cleared value = renderer default.
  | { kind: 'font_family'; key: string; label: string; help?: string }
  // Numeric font-weight token. The picker greys out weights the
  // associated family doesn't ship — pass `familyKey` to read the
  // sibling family field's value off the parent record for the
  // shipped-weight filter.
  | { kind: 'font_weight'; key: string; label: string; familyKey?: string; help?: string }
  // Lucide icon name (kebab-case). Trigger button opens a full Lucide
  // library modal with search, recents, and a curated "common" set.
  | { kind: 'icon'; key: string; label: string; help?: string }
  // Per-device hide flags (mobile / tablet / desktop). Renders as a
  // fieldset with three checkboxes. The persisted value is a sparse
  // `{ hideOnMobile?, hideOnTablet?, hideOnDesktop? }` object — axes
  // that are unset are DROPPED (not stored as `false`) so the persisted
  // meta stays lean. When all three flags are on the field surfaces a
  // soft warning ("This block won't display on any device"). Read back
  // defensively — a malformed value or undefined parent meta falls
  // through to "nothing hidden" without throwing.
  | { kind: 'visibility'; key: string; label: string; help?: string }

export function ZodForm({
  shapes,
  value,
  onChange,
}: {
  shapes: FieldShape[]
  value: Record<string, unknown>
  onChange: (v: Record<string, unknown>) => void
}) {
  return (
    <form className="space-y-5" onSubmit={(e) => e.preventDefault()}>
      {shapes.map((s) => (
        <FieldRenderer
          key={s.key}
          shape={s}
          value={value[s.key]}
          parent={value}
          onChange={(v) => onChange({ ...value, [s.key]: v })}
        />
      ))}
    </form>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
      {children}
    </span>
  )
}

function FieldHelp({ children }: { children: React.ReactNode }) {
  return <span className="mt-1 block text-[11px] text-warm-stone/80">{children}</span>
}

function FieldRenderer({
  shape,
  value,
  parent,
  onChange,
}: {
  shape: FieldShape
  value: unknown
  // Sibling field values on the same form record. Cross-field pickers
  // (e.g. font-weight greying out weights the chosen font-family
  // doesn't ship) read related field values from here.
  parent: Record<string, unknown>
  onChange: (v: unknown) => void
}) {
  switch (shape.kind) {
    case 'string': {
      const current = String(value ?? '')
      // Pattern-gated text inputs (e.g. htmlId — letter-leading,
      // letters/digits/hyphens/underscores). Empty string is always
      // considered valid here so the operator can clear the field;
      // upstream Zod may independently require .min(1) via the
      // schema. When invalid the input is marked aria-invalid and
      // the patternError replaces the help text so the operator
      // sees the constraint inline.
      const patternInvalid =
        shape.pattern !== undefined &&
        current !== '' &&
        !shape.pattern.test(current)
      const helperId = `${shape.key}-help`
      return (
        <label className="block">
          <FieldLabel>{shape.label}</FieldLabel>
          {shape.multiline ? (
            <textarea
              className="mt-1.5 w-full rounded-xl border border-warm-stone/25 bg-cream-50/80 px-4 py-3 text-sm text-near-black placeholder:text-warm-stone/60 transition-all duration-quick hover:border-warm-stone/40 focus:border-copper-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-copper-300/40 min-h-[6rem] resize-y"
              maxLength={shape.maxLength}
              placeholder={shape.placeholder}
              value={current}
              onChange={(e) => onChange(e.target.value)}
            />
          ) : (
            <Input
              className="mt-1.5"
              maxLength={shape.maxLength}
              placeholder={shape.placeholder}
              value={current}
              onChange={(e) => onChange(e.target.value)}
              aria-invalid={patternInvalid || undefined}
              aria-describedby={
                shape.help || patternInvalid ? helperId : undefined
              }
            />
          )}
          {patternInvalid ? (
            <span
              id={helperId}
              className="mt-1 block text-[11px] text-red-500"
            >
              {shape.patternError ?? 'Invalid format.'}
            </span>
          ) : (
            shape.help && (
              <span id={helperId}>
                <FieldHelp>{shape.help}</FieldHelp>
              </span>
            )
          )}
        </label>
      )
    }

    case 'richtext':
      return (
        <div>
          <FieldLabel>{shape.label}</FieldLabel>
          <div className="mt-1.5">
            <RichTextEditor
              value={String(value ?? '')}
              onChange={(html) => onChange(html)}
              placeholder={shape.placeholder ?? 'Write something…'}
              maxLength={shape.maxLength}
            />
          </div>
          {shape.help && <FieldHelp>{shape.help}</FieldHelp>}
        </div>
      )

    case 'media':
      return (
        <div>
          <MediaPicker
            label={shape.label}
            accept={shape.accept}
            help={shape.help}
            value={value as { media_id: number; alt: string } | undefined}
            onChange={(m) => onChange(m)}
          />
        </div>
      )

    case 'cta':
      return <CtaField label={shape.label} value={value as CtaValue | undefined} onChange={onChange} />

    case 'link':
      return (
        <LinkField
          label={shape.label}
          help={shape.help}
          value={value as LinkValue | undefined}
          onChange={onChange}
        />
      )

    case 'number':
      return (
        <label className="block">
          <FieldLabel>{shape.label}</FieldLabel>
          <div className="mt-1.5">
            <Stepper
              value={typeof value === 'number' ? value : undefined}
              onChange={(v) => onChange(v)}
              min={shape.min}
              max={shape.max}
              step={shape.step ?? 1}
            />
          </div>
          {shape.help && <FieldHelp>{shape.help}</FieldHelp>}
        </label>
      )

    case 'boolean':
      // Container blends with the dark drawer — the Switch itself
      // carries ivory label + warm-cream help colours via the dark-tone
      // cascade so labels stay readable on the obsidian surface. The
      // previous "light island inside dark drawer" pattern lost the
      // labels entirely on screenshot inspection — operator could see
      // toggles but not what they were for.
      return (
        <div className="rounded-xl border border-ivory/15 bg-ivory/[0.04] px-4 py-3">
          <Switch
            checked={Boolean(value)}
            onChange={onChange}
            label={shape.label}
            help={shape.help}
          />
        </div>
      )

    case 'select': {
      const current = String(value ?? '')
      // Custom listbox-style Select primitive — the native <select>
      // popup is rendered by the OS in its own chrome (bright Mac-
      // blue selection, system fonts) which clashes with the dark
      // EditDrawer surface. The Select primitive at components/ui
      // mirrors the field's value type so an integer-flagged shape
      // still receives the same Number() coercion the prior <select>
      // applied via valueAsNumber. Audit follow-up "dropdowns are
      // terrible".
      return (
        <div className="block">
          <FieldLabel>{shape.label}</FieldLabel>
          <div className="mt-1.5">
            <Select
              value={current === '' ? null : current}
              options={shape.options}
              placeholder="Choose…"
              aria-label={shape.label}
              onChange={(v) => {
                if (shape.valueAsNumber) {
                  // Defensive guard against empty-string / whitespace-only
                  // option values AND any non-numeric string that would
                  // otherwise become NaN. Propagate undefined instead so
                  // the field falls back to whatever default the Zod
                  // schema specifies. Post-agent-review R5 + post-round-2
                  // NEW-4 (Chunk K).
                  if (v.trim() === '') {
                    onChange(undefined)
                  } else {
                    const n = Number(v)
                    onChange(Number.isFinite(n) ? n : undefined)
                  }
                } else {
                  onChange(v)
                }
              }}
            />
          </div>
          {shape.help && <FieldHelp>{shape.help}</FieldHelp>}
        </div>
      )
    }

    case 'date':
      return (
        <label className="block">
          <FieldLabel>{shape.label}</FieldLabel>
          <div className="mt-1.5">
            <DatePicker
              value={typeof value === 'string' && value !== '' ? value : undefined}
              onChange={(v) => onChange(v ?? '')}
              min={shape.min}
              max={shape.max}
            />
          </div>
          {shape.help && <FieldHelp>{shape.help}</FieldHelp>}
        </label>
      )

    case 'social_link': {
      const v = (value as Partial<SocialLinkValue> | undefined) ?? { platform: '', url: '' }
      return (
        <div>
          <FieldLabel>{shape.label}</FieldLabel>
          <div className="mt-1.5">
            <SocialLinkRow
              value={{ platform: v.platform ?? '', url: v.url ?? '' }}
              onChange={(next) => onChange(next)}
            />
          </div>
        </div>
      )
    }

    case 'media_array':
      return (
        <MediaArrayField
          shape={shape}
          value={value as Array<{ media_id: number; alt: string; caption?: string }> | undefined}
          onChange={onChange}
        />
      )

    case 'string_array':
      return (
        <div>
          <FieldLabel>{shape.label}</FieldLabel>
          <div className="mt-1.5">
            <TagInput
              value={Array.isArray(value) ? (value as string[]) : []}
              onChange={(v) => onChange(v)}
              placeholder={shape.placeholder}
              maxItems={shape.maxItems}
            />
          </div>
          {shape.help && <FieldHelp>{shape.help}</FieldHelp>}
        </div>
      )

    case 'object_array':
      return (
        <ObjectArrayField
          shape={shape}
          value={value as Array<Record<string, unknown>> | undefined}
          onChange={onChange}
        />
      )

    case 'social_link_array':
      return (
        <SocialLinkArrayField
          shape={shape}
          value={value as SocialLinkValue[] | undefined}
          onChange={onChange}
        />
      )

    case 'color':
      return (
        <ColorPickerField
          label={shape.label}
          help={shape.help}
          value={typeof value === 'string' ? value : undefined}
          onChange={onChange}
          tokens={shape.tokens}
          allowAlpha={shape.allowAlpha}
          allowCustom={shape.allowCustom}
        />
      )

    case 'font_family':
      return (
        <FontFamilyPickerField
          label={shape.label}
          help={shape.help}
          value={
            typeof value === 'string'
              ? (value as FontFamilyToken)
              : undefined
          }
          onChange={(v) => onChange(v)}
        />
      )

    case 'font_weight': {
      const fam =
        shape.familyKey && typeof parent[shape.familyKey] === 'string'
          ? (parent[shape.familyKey] as FontFamilyToken)
          : undefined
      return (
        <FontWeightPickerField
          label={shape.label}
          help={shape.help}
          value={
            typeof value === 'string'
              ? (value as FontWeightToken)
              : undefined
          }
          onChange={(v) => onChange(v)}
          family={fam}
        />
      )
    }

    case 'icon':
      return (
        <IconPickerField
          label={shape.label}
          help={shape.help}
          value={typeof value === 'string' ? value : undefined}
          onChange={onChange}
        />
      )

    case 'visibility':
      return (
        <VisibilityField
          label={shape.label}
          help={shape.help}
          value={value}
          onChange={onChange}
        />
      )
    default:
      // Exhaustiveness gate — a new FieldShape variant lands as a TS
      // error here so the form picker can't silently skip a new kind.
      return assertNever(shape)
  }
}

// Per-device hide-flag fieldset. Reads the persisted `{ hideOnMobile,
// hideOnTablet, hideOnDesktop }` shape defensively (a malformed value
// — e.g. a stale row that stored `null` or a string) collapses to
// "nothing hidden" without throwing). On change, axes set to true
// are persisted; axes set to false are DROPPED from the object so
// the saved meta stays lean (matches readVisibilityMeta in
// lib/cms/blockMeta.ts which only emits the truthy keys).
function VisibilityField({
  label,
  help,
  value,
  onChange,
}: {
  label: string
  help?: string
  value: unknown
  onChange: (v: unknown) => void
}) {
  const v: { hideOnMobile?: boolean; hideOnTablet?: boolean; hideOnDesktop?: boolean } =
    value !== null && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {}
  const flags = {
    hideOnMobile: v.hideOnMobile === true,
    hideOnTablet: v.hideOnTablet === true,
    hideOnDesktop: v.hideOnDesktop === true,
  }
  const setFlag = (axis: keyof typeof flags, next: boolean) => {
    const merged = { ...flags, [axis]: next }
    const persisted: Record<string, boolean> = {}
    if (merged.hideOnMobile) persisted.hideOnMobile = true
    if (merged.hideOnTablet) persisted.hideOnTablet = true
    if (merged.hideOnDesktop) persisted.hideOnDesktop = true
    // Empty -> undefined so the parent meta doesn't carry an empty
    // `{}` through every block (matches blockMeta.ts parser).
    onChange(Object.keys(persisted).length === 0 ? undefined : persisted)
  }
  const allHidden =
    flags.hideOnMobile && flags.hideOnTablet && flags.hideOnDesktop
  return (
    <fieldset className="space-y-3 rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-4">
      <legend className="cavecms-sticky-legend sticky top-0 z-10 -mt-1 -ml-2 px-2 py-1 rounded-md backdrop-blur-md bg-cream-50/85">
        <FieldLabel>{label}</FieldLabel>
      </legend>
      {help && <FieldHelp>{help}</FieldHelp>}
      <div className="space-y-2 rounded-xl border border-ivory/15 bg-ivory/[0.04] px-4 py-3">
        <Switch
          checked={flags.hideOnMobile}
          onChange={(next) => setFlag('hideOnMobile', next)}
          label="Hide on mobile (<640px)"
        />
        <Switch
          checked={flags.hideOnTablet}
          onChange={(next) => setFlag('hideOnTablet', next)}
          label="Hide on tablet (640–1023px)"
        />
        <Switch
          checked={flags.hideOnDesktop}
          onChange={(next) => setFlag('hideOnDesktop', next)}
          label="Hide on desktop (≥1024px)"
        />
      </div>
      {allHidden && (
        <p
          role="alert"
          className="rounded-xl border border-amber-400/40 bg-amber-50 px-3 py-2 text-[11px] font-medium text-amber-800"
        >
          This block won&rsquo;t display on any device.
        </p>
      )}
    </fieldset>
  )
}

function SocialLinkArrayField({
  shape,
  value,
  onChange,
}: {
  shape: FieldShape & { kind: 'social_link_array' }
  value?: SocialLinkValue[]
  onChange: (v: unknown) => void
}) {
  // Defensive against a stale DB row that stored a non-array (e.g.
  // pre-migration where social_links was an object). Coercing to []
  // beats a 500 in admin — the form will still let the operator save
  // a fresh array shape that the Zod schema accepts.
  const arr = Array.isArray(value) ? value : []
  const canAdd = shape.maxItems === undefined || arr.length < shape.maxItems
  return (
    <fieldset className="space-y-3 rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-4">
      <legend className="cavecms-sticky-legend sticky top-0 z-10 -mt-1 -ml-2 px-2 py-1 rounded-md backdrop-blur-md bg-cream-50/85">
        <FieldLabel>{shape.label}</FieldLabel>
      </legend>
      {shape.help && <FieldHelp>{shape.help}</FieldHelp>}

      {arr.length === 0 ? (
        <EmptyState
          icon={Share2}
          title="Connect your social profiles"
          description="Your Instagram, Facebook, LinkedIn, YouTube, TikTok or X handles show up in the footer and feed Google’s knowledge panel."
          example="e.g. instagram.com/yourdomain"
          size="sm"
        />
      ) : (
        <SortableList<SocialLinkValue & { __id?: string }>
          items={arr as Array<SocialLinkValue & { __id?: string }>}
          onChange={(next) => onChange(next)}
          getId={(item, i) => item.__id ?? `s-${item.platform}-${i}`}
          renderItem={(item, i, helpers) => (
            <div className="cavecms-repeater-item flex items-start gap-2 rounded-xl border border-warm-stone/20 bg-white p-3 shadow-[0_4px_14px_-10px_rgba(5,5,5,0.18)]">
              <DragHandle handleProps={helpers.handleProps} />
              <div className="flex-1 min-w-0">
                <SocialLinkRow
                  value={{ platform: item.platform ?? '', url: item.url ?? '' }}
                  onChange={(next) => {
                    const list = [...arr]
                    list[i] = { ...list[i]!, ...next }
                    onChange(list)
                  }}
                />
              </div>
              <ItemControls
                isFirst={helpers.isFirst}
                isLast={helpers.isLast}
                onUp={helpers.moveUp}
                onDown={helpers.moveDown}
                onRemove={helpers.remove}
              />
            </div>
          )}
        />
      )}

      {canAdd && (
        <button
          type="button"
          onClick={() =>
            onChange([
              ...arr,
              { platform: '', url: '', __id: cryptoId() } as SocialLinkValue & {
                __id?: string
              },
            ])
          }
          className="inline-flex items-center gap-2 rounded-full border border-warm-stone/30 bg-cream-50 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-near-black transition-all hover:border-copper-400 hover:text-copper-700"
        >
          <PlusIcon />
          {shape.addLabel ?? 'Add social profile'}
        </button>
      )}
    </fieldset>
  )
}

function ObjectArrayField({
  shape,
  value,
  onChange,
}: {
  shape: FieldShape & { kind: 'object_array' }
  value?: Array<Record<string, unknown>>
  onChange: (v: unknown) => void
}) {
  const arr = useMemo(() => (Array.isArray(value) ? value : []), [value])
  const blank = useMemo(() => {
    const b: Record<string, unknown> = { __id: cryptoId() }
    for (const f of shape.itemFields) b[f.key] = ''
    return b
  }, [shape.itemFields])
  const canAdd = shape.maxItems === undefined || arr.length < shape.maxItems
  return (
    <fieldset className="space-y-3 rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-4">
      <legend className="cavecms-sticky-legend sticky top-0 z-10 -mt-1 -ml-2 px-2 py-1 rounded-md backdrop-blur-md bg-cream-50/85">
        <FieldLabel>{shape.label}</FieldLabel>
      </legend>
      {shape.help && <FieldHelp>{shape.help}</FieldHelp>}

      {arr.length === 0 ? (
        <EmptyState
          icon={shape.label.toLowerCase().includes('column') ? Layers : ListChecks}
          title={
            shape.itemNoun
              ? `Add your first ${shape.itemNoun}`
              : `Add the first item`
          }
          description={
            shape.help ??
            'You can drag items to reorder them and remove any with one click.'
          }
          size="sm"
        />
      ) : (
        <SortableList<Record<string, unknown>>
          items={arr}
          onChange={(next) => onChange(next)}
          getId={(item, i) => (item.__id as string) || `i-${i}`}
          renderItem={(item, i, helpers) => (
            <div className="cavecms-repeater-item rounded-xl border border-warm-stone/20 bg-white shadow-[0_4px_14px_-10px_rgba(5,5,5,0.18)]">
              <div className="cavecms-repeater-item-header flex items-center gap-2 border-b border-warm-stone/10 px-2 py-2">
                <DragHandle handleProps={helpers.handleProps} />
                <span className="flex-1 truncate text-[11px] font-medium uppercase tracking-[0.18em] text-warm-stone">
                  {shape.itemTitle
                    ? shape.itemTitle(item, i)
                    : `Item ${i + 1}`}
                </span>
                <ItemControls
                  isFirst={helpers.isFirst}
                  isLast={helpers.isLast}
                  onUp={helpers.moveUp}
                  onDown={helpers.moveDown}
                  onRemove={helpers.remove}
                />
              </div>
              <div className="space-y-4 p-4">
                {shape.itemFields.map((f) => (
                  <FieldRenderer
                    key={f.key}
                    shape={f}
                    value={item[f.key]}
                    parent={item}
                    onChange={(v) => {
                      const next = [...arr]
                      next[i] = { ...next[i]!, [f.key]: v }
                      onChange(next)
                    }}
                  />
                ))}
              </div>
            </div>
          )}
        />
      )}

      {canAdd && (
        <button
          type="button"
          onClick={() => onChange([...arr, { ...blank, __id: cryptoId() }])}
          className="inline-flex items-center gap-2 rounded-full border border-warm-stone/30 bg-cream-50 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-near-black transition-all hover:border-copper-400 hover:text-copper-700"
        >
          <PlusIcon />
          {shape.addLabel ?? 'Add item'}
        </button>
      )}
    </fieldset>
  )
}

function ItemControls({
  isFirst,
  isLast,
  onUp,
  onDown,
  onRemove,
}: {
  isFirst: boolean
  isLast: boolean
  onUp: () => void
  onDown: () => void
  onRemove: () => void
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={onUp}
        disabled={isFirst}
        aria-label="Move up"
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-warm-stone hover:bg-cream-100 hover:text-near-black disabled:opacity-30 transition-colors"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="18 15 12 9 6 15" />
        </svg>
      </button>
      <button
        type="button"
        onClick={onDown}
        disabled={isLast}
        aria-label="Move down"
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-warm-stone hover:bg-cream-100 hover:text-near-black disabled:opacity-30 transition-colors"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove"
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-warm-stone hover:bg-red-50 hover:text-red-600 transition-colors"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          <line x1="10" y1="11" x2="10" y2="17" />
          <line x1="14" y1="11" x2="14" y2="17" />
        </svg>
      </button>
    </div>
  )
}

interface CtaValue {
  text: string
  href: string
  openInNew?: boolean
}
function CtaField({
  label,
  value,
  onChange,
}: {
  label: string
  value: CtaValue | undefined
  onChange: (v: unknown) => void
}) {
  const v: CtaValue = value ?? { text: '', href: '', openInNew: false }
  return (
    <fieldset className="space-y-3 rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-4">
      <legend className="cavecms-sticky-legend sticky top-0 z-10 -mt-1 -ml-2 px-2 py-1 rounded-md backdrop-blur-md bg-cream-50/85">
        <FieldLabel>{label}</FieldLabel>
      </legend>
      <label className="block">
        <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-warm-stone">
          Button text
        </span>
        <Input
          className="mt-1.5"
          placeholder="e.g. Schedule a tour"
          maxLength={TEXT_MAX.ctaText}
          value={v.text}
          onChange={(e) => onChange({ ...v, text: e.target.value })}
        />
      </label>
      <label className="block">
        <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-warm-stone">
          Link target
        </span>
        <Input
          className="mt-1.5"
          placeholder="/contact  or  https://…"
          maxLength={TEXT_MAX.url}
          value={v.href}
          onChange={(e) => onChange({ ...v, href: e.target.value })}
        />
      </label>
      <Switch
        checked={!!v.openInNew}
        onChange={(checked) => onChange({ ...v, openInNew: checked })}
        label="Open in a new tab"
        help="Recommended for external links."
      />
    </fieldset>
  )
}

interface LinkValue {
  href: string
  openInNew?: boolean
}
function LinkField({
  label,
  help,
  value,
  onChange,
}: {
  label: string
  help?: string
  value: LinkValue | undefined
  onChange: (v: unknown) => void
}) {
  // value === undefined means "no link" — the parent block's schema is
  // .optional() so omitting the field is valid. A cleared href maps
  // back to undefined so an empty input cleanly removes the link.
  const v: LinkValue = value ?? { href: '', openInNew: false }
  const setHref = (next: string) => {
    // Trim leading/trailing whitespace before persist. Operators often
    // paste from clipboards that auto-pad with whitespace; without this
    // trim, `CTA_HREF_RE` (anchored at `^`) rejects the value and the
    // operator sees "Reverting your edit" with no hint that whitespace
    // was the cause. URLs themselves contain no literal whitespace so
    // trimming is lossless.
    const trimmed = next.trim()
    if (trimmed === '') onChange(undefined)
    else onChange({ ...v, href: trimmed })
  }
  return (
    <fieldset className="space-y-3 rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-4">
      <legend className="cavecms-sticky-legend sticky top-0 z-10 -mt-1 -ml-2 px-2 py-1 rounded-md backdrop-blur-md bg-cream-50/85">
        <FieldLabel>{label}</FieldLabel>
      </legend>
      {help && <FieldHelp>{help}</FieldHelp>}
      <label className="block">
        <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-warm-stone">
          Link target
        </span>
        <Input
          className="mt-1.5"
          placeholder="/contact  or  https://…  (leave empty for no link)"
          maxLength={TEXT_MAX.url}
          value={v.href}
          onChange={(e) => setHref(e.target.value)}
        />
      </label>
      {v.href.trim() !== '' && (
        <Switch
          checked={!!v.openInNew}
          onChange={(checked) => onChange({ ...v, openInNew: checked })}
          label="Open in a new tab"
          help="Recommended for external links."
        />
      )}
    </fieldset>
  )
}

interface MediaArrayItem {
  media_id: number
  alt: string
  caption?: string
  __id?: string
}

function MediaArrayField({
  shape,
  value,
  onChange,
}: {
  shape: FieldShape & { kind: 'media_array' }
  value?: MediaArrayItem[]
  onChange: (v: unknown) => void
}) {
  const { open } = useMediaPicker()
  const arr = Array.isArray(value) ? value : []
  return (
    <fieldset className="space-y-3 rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-4">
      <legend className="cavecms-sticky-legend sticky top-0 z-10 -mt-1 -ml-2 px-2 py-1 rounded-md backdrop-blur-md bg-cream-50/85">
        <FieldLabel>{shape.label}</FieldLabel>
      </legend>
      {shape.help && <FieldHelp>{shape.help}</FieldHelp>}

      {arr.length === 0 ? (
        <div className="rounded-xl border border-dashed border-warm-stone/25 bg-cream-50/40 px-4 py-6 text-center">
          <p className="text-sm text-warm-stone">
            No images yet. Click Add image below to get started.
          </p>
        </div>
      ) : (
        <SortableList<MediaArrayItem>
          items={arr}
          onChange={(next) => onChange(next)}
          getId={(item, i) => item.__id ?? `m-${item.media_id}-${i}`}
          renderItem={(item, i, helpers) => (
            <div className="cavecms-repeater-item flex items-stretch gap-2 rounded-xl border border-warm-stone/20 bg-white p-2 shadow-[0_4px_14px_-10px_rgba(5,5,5,0.18)]">
              <DragHandle handleProps={helpers.handleProps} />
              <div className="flex-1 min-w-0">
                <MediaPicker
                  label={`Image ${i + 1}`}
                  value={item}
                  onChange={(m) => {
                    const next = [...arr]
                    if (!m) {
                      onChange(next.filter((_, j) => j !== i))
                      return
                    }
                    next[i] = { ...next[i]!, ...m }
                    onChange(next)
                  }}
                />
                <label className="mt-2 block">
                  <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-warm-stone">
                    Caption (optional)
                  </span>
                  <Input
                    className="mt-1.5"
                    placeholder="A short caption"
                    maxLength={TEXT_MAX.short}
                    value={item.caption ?? ''}
                    onChange={(e) => {
                      const next = [...arr]
                      next[i] = { ...next[i]!, caption: e.target.value }
                      onChange(next)
                    }}
                  />
                </label>
              </div>
              <ItemControls
                isFirst={helpers.isFirst}
                isLast={helpers.isLast}
                onUp={helpers.moveUp}
                onDown={helpers.moveDown}
                onRemove={helpers.remove}
              />
            </div>
          )}
        />
      )}

      <button
        type="button"
        onClick={() =>
          open(undefined, (m) =>
            onChange([...arr, { ...m, __id: cryptoId() }]),
          )
        }
        className="inline-flex items-center gap-2 rounded-full border border-warm-stone/30 bg-cream-50 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-near-black transition-all hover:border-copper-400 hover:text-copper-700"
      >
        <PlusIcon />
        Add image
      </button>
    </fieldset>
  )
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

// Stable id for sortable rows. Falls back to a counter when
// crypto.randomUUID isn't available (older Safari < 15.4 etc.).
let idSeq = 1
function cryptoId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `id-${Date.now()}-${idSeq++}`
}

// ─── Identity & visibility shared FieldShape entries ────────────────
// Every Section + Column + Widget gets the same trio (sections +
// columns get `label`; widgets are identified by inline content and
// skip it). EditDrawer.tsx routes these keys to the Advanced tab via
// ADVANCED_KEYS — see the cross-file integration note in the parent
// agent's diff. The htmlId pattern mirrors HtmlIdSchema in
// lib/cms/blockMeta.ts so the in-drawer validation hint matches the
// API write-boundary regex exactly.
const HTML_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/
const HTML_ID_HELPER =
  'Must start with a letter; letters, digits, hyphens, underscores only.'

const CONTAINER_IDENTITY_SHAPES: FieldShape[] = [
  {
    kind: 'string',
    key: 'label',
    label: 'Label',
    maxLength: 64,
    placeholder: 'Untitled section',
    help: 'Operator-only name shown in the outline + drawer header. Not rendered on the page.',
  },
  {
    kind: 'string',
    key: 'htmlId',
    label: 'HTML id (anchor)',
    maxLength: 64,
    placeholder: 'section-id',
    pattern: HTML_ID_PATTERN,
    patternError: HTML_ID_HELPER,
    help: 'Linkable anchor target (e.g. "#" + your-id). Reserved ids (header, footer, nav, main, aside, page, app, root) are rejected.',
  },
  {
    kind: 'visibility',
    key: 'visibility',
    label: 'Visibility',
    help: 'Hide this block at specific viewport ranges. Hidden surfaces still ship in the page HTML (search engines + screen readers may still find them) — use sparingly.',
  },
]

// Column identity reuses the same trio but with a column-flavoured
// label placeholder so the empty-state hint matches the container kind.
const COLUMN_IDENTITY_SHAPES: FieldShape[] = CONTAINER_IDENTITY_SHAPES.map((s) =>
  s.key === 'label'
    ? {
        ...s,
        placeholder: 'Untitled column',
      }
    : s,
)

// Widget identity — htmlId + visibility, no label. Widgets are
// identified by their inline content (see IDENTITY_TEXT_KEYS in
// EditDrawer.tsx); adding a label here would create two competing
// identifiers for the same block.
const WIDGET_IDENTITY_SHAPES: FieldShape[] = [
  {
    kind: 'string',
    key: 'htmlId',
    label: 'HTML id (anchor)',
    maxLength: 64,
    placeholder: 'block-id',
    pattern: HTML_ID_PATTERN,
    patternError: HTML_ID_HELPER,
    help: 'Linkable anchor target (e.g. "#" + your-id). Reserved ids (header, footer, nav, main, aside, page, app, root) are rejected.',
  },
  {
    kind: 'visibility',
    key: 'visibility',
    label: 'Visibility',
    help: 'Hide this block at specific viewport ranges. Hidden surfaces still ship in the page HTML — use sparingly.',
  },
]

// Base FieldShape entries per block type — the content/style fields
// each block owns. Identity & visibility (htmlId, label, visibility)
// are appended below in `SHAPES_FOR_BLOCK` so the trio doesn't have
// to be repeated in every block definition.
const BASE_SHAPES_FOR_BLOCK: Record<string, FieldShape[]> = {
  // Container kinds (migration 0011). The EditDrawer dispatches kind on
  // the prop, sending `meta` in the PATCH body instead of `data`. Both
  // shape sets land on the Style tab via the STYLE_KEYS lookup.
  section: [
    {
      kind: 'select',
      key: 'background',
      label: 'Background tone',
      options: [
        // Luxury palette — primary set for new sections.
        { value: 'obsidian', label: 'Obsidian' },
        { value: 'ivory', label: 'Ivory' },
        { value: 'champagne', label: 'Champagne' },
        { value: 'bone', label: 'Bone' },
        // Legacy palette — kept selectable so unmigrated pages can
        // still be edited without losing their original tone.
        { value: 'cream', label: 'Cream (legacy)' },
        { value: 'near-black', label: 'Near black (legacy)' },
        { value: 'copper-tint', label: 'Copper tint (legacy)' },
      ],
      help: 'Sets the section background and adjusts text color for contrast.',
    },
    {
      kind: 'select',
      key: 'padding',
      label: 'Vertical padding',
      options: [
        { value: 'sm', label: 'Compact' },
        { value: 'md', label: 'Standard' },
        { value: 'lg', label: 'Spacious' },
        // Editorial padding tiers — luxury system.
        { value: 'xl', label: 'Editorial (160px)' },
        { value: '2xl', label: 'Cinematic (192px)' },
      ],
    },
    // Cover-image background — Elementor-parity feature. When set,
    // the section renders the image edge-to-edge behind its content
    // with an optional overlay tint for text legibility. Three knobs:
    // image picker, overlay preset, minimum height.
    { kind: 'media', key: 'backgroundImage', label: 'Background image (optional)', help: 'Set a cover photo behind this section. Widgets in the section compose on top of the image.' },
    {
      kind: 'select', key: 'backgroundOverlay', label: 'Overlay tint',
      options: [
        { value: 'none', label: 'None' },
        { value: 'darken', label: 'Darken (subtle, 35%)' },
        { value: 'darken-strong', label: 'Darken (strong, 60%)' },
        { value: 'gradient-bottom', label: 'Gradient — dark at the bottom' },
        { value: 'champagne', label: 'Champagne wash' },
      ],
      help: 'Tint that composites between the photo and the content. Pick darken-strong if a heading sits on a busy mid-tone photo.',
    },
    {
      kind: 'select', key: 'backgroundFit', label: 'Image fit',
      options: [
        { value: 'cover', label: 'Cover (fill box, crop overflow)' },
        { value: 'contain', label: 'Contain (fit inside, no crop)' },
        { value: 'fill', label: 'Fill (stretch to box)' },
        { value: 'scale-down', label: 'Scale down (no upscale)' },
        { value: 'none', label: 'None (original size)' },
      ],
      help: 'How the photo fills the box. Cover is the hero default — Contain when the image must show in full.',
    },
    {
      kind: 'select', key: 'minHeight', label: 'Minimum height',
      options: [
        { value: 'none', label: 'None (content drives height)' },
        { value: 'sm', label: 'Small — 320 px' },
        { value: 'md', label: 'Medium — 420 px' },
        { value: 'lg', label: 'Large — 540 px (hero)' },
        { value: 'xl', label: 'Extra-large — 680 px' },
        { value: 'screen', label: 'Full viewport (100vh)' },
      ],
      help: 'Keeps the section from collapsing to a thin band on landscape screens. Set Large+ for hero sections.',
    },
    // Column count lives on `meta.columns` and is set at section
    // creation time via the InsertSectionHere shape picker, then
    // adjusted by the section toolbar's "Add column" / per-column
    // "Delete column" actions. NOT exposed in the settings drawer
    // because changing it without also creating/deleting column ROWS
    // produces a renderer mismatch (grid cells with no children).
  ],
  column: [
    {
      kind: 'number',
      key: 'width',
      label: 'Width (grid units)',
      min: 1,
      max: 12,
      step: 1,
      help: 'Optional override (1-12). Leave blank for an even split with sibling columns.',
    },
    // Cover-image background — same triad as the section. Lets the
    // operator build "split hero" layouts (text column next to a
    // photo column with full bleed inside that column). Columns are
    // already rounded-2xl when a bg image is set so the photo reads
    // as a card rather than a section bleed.
    { kind: 'media', key: 'backgroundImage', label: 'Background image (optional)', help: 'Photo behind this column. Useful for split layouts — text in one column, photo column next to it.' },
    {
      kind: 'select', key: 'backgroundOverlay', label: 'Overlay tint',
      options: [
        { value: 'none', label: 'None' },
        { value: 'darken', label: 'Darken (subtle, 35%)' },
        { value: 'darken-strong', label: 'Darken (strong, 60%)' },
        { value: 'gradient-bottom', label: 'Gradient — dark at the bottom' },
        { value: 'champagne', label: 'Champagne wash' },
      ],
    },
    {
      kind: 'select', key: 'minHeight', label: 'Minimum height',
      options: [
        { value: 'none', label: 'None (content drives height)' },
        { value: 'sm', label: 'Small — 320 px' },
        { value: 'md', label: 'Medium — 420 px' },
        { value: 'lg', label: 'Large — 540 px' },
        { value: 'xl', label: 'Extra-large — 680 px' },
        { value: 'screen', label: 'Full viewport (100vh)' },
      ],
    },
  ],

  // ════════════════════════════════════════════════════════════════
  // LUXURY REDESIGN — lx_* widget shape declarations.
  //
  // Every lx_* widget has its primary scalar registered as inline-
  // editable in lib/cms/inlineEditableFields.ts (text / body_richtext
  // / label / quote). Drawer shapes here cover EVERY OTHER FIELD so
  // the operator can tune visual / animation / link knobs.
  // ════════════════════════════════════════════════════════════════

  lx_heading: [
    { kind: 'string', key: 'text', label: 'Heading text', maxLength: TEXT_MAX.title, placeholder: 'Editorial heading copy' },
    {
      kind: 'select', key: 'level', label: 'Semantic level',
      options: [
        { value: 'h1', label: 'H1' }, { value: 'h2', label: 'H2' },
        { value: 'h3', label: 'H3' }, { value: 'h4', label: 'H4' },
        { value: 'h5', label: 'H5' }, { value: 'h6', label: 'H6' },
      ],
      help: 'Drives screen-reader + SEO outline. Default h2 — change to h1 only when the heading IS the page title.',
    },
    {
      kind: 'select', key: 'size', label: 'Visual size',
      options: [
        { value: 'display-2xl', label: 'Display 2XL (80px)' },
        { value: 'display-xl', label: 'Display XL (64px)' },
        { value: 'display-lg', label: 'Display LG (48px)' },
        { value: 'display-md', label: 'Display MD (36px)' },
        { value: 'display-sm', label: 'Display SM (28px)' },
      ],
    },
    {
      kind: 'select', key: 'alignment', label: 'Alignment',
      options: [
        { value: 'left', label: 'Left' },
        { value: 'center', label: 'Center' },
        { value: 'right', label: 'Right' },
      ],
    },
    {
      kind: 'color',
      key: 'tone',
      label: 'Tone',
      tokens: ['obsidian', 'ivory', 'champagne'],
      allowCustom: true,
      allowAlpha: false,
      help: 'Pick a brand token (globe icon turns blue when bound) — or open the picker to dial in a custom luxury hue.',
    },
    {
      kind: 'font_family',
      key: 'family',
      label: 'Font family',
      help: 'Leave on default to inherit the renderer\'s baseline (Display for headings).',
    },
    {
      kind: 'font_weight',
      key: 'weight',
      label: 'Font weight',
      familyKey: 'family',
      help: 'Weights the chosen family doesn\'t ship are greyed out.',
    },
    { kind: 'boolean', key: 'italic', label: 'Italic', help: 'Fraunces italic axis — for editorial emphasis.' },
    {
      kind: 'select', key: 'animation', label: 'Animation',
      options: [
        { value: 'none', label: 'None (static)' },
        { value: 'fade-in', label: 'Fade in on scroll' },
        { value: 'slide-up', label: 'Slide up on scroll' },
        { value: 'line-reveal', label: 'Line reveal (hero — use sparingly)' },
      ],
      help: 'Line reveal is the signature luxury motion — reserve it for the canonical hero heading per page.',
    },
  ],

  lx_text: [
    { kind: 'richtext', key: 'body_richtext', label: 'Body text', maxLength: TEXT_MAX.richtextLong, placeholder: 'Body paragraph' },
    {
      kind: 'select', key: 'size', label: 'Size',
      options: [
        { value: 'body-lg', label: 'Lead (20px)' },
        { value: 'body-md', label: 'Body (16px)' },
        { value: 'body-sm', label: 'Small (14px)' },
      ],
    },
    {
      kind: 'select', key: 'alignment', label: 'Alignment',
      options: [
        { value: 'left', label: 'Left' },
        { value: 'center', label: 'Center' },
      ],
      help: 'Justified text creates rivers on the web — intentionally not offered.',
    },
    {
      kind: 'color',
      key: 'tone',
      label: 'Tone',
      tokens: ['obsidian', 'ivory', 'warm-stone'],
      allowCustom: true,
      allowAlpha: false,
    },
    {
      kind: 'font_family',
      key: 'family',
      label: 'Font family',
      help: 'Leave on default to inherit the renderer\'s baseline (Body for editorial paragraphs).',
    },
    {
      kind: 'font_weight',
      key: 'weight',
      label: 'Font weight',
      familyKey: 'family',
    },
    {
      kind: 'select', key: 'maxWidth', label: 'Editorial measure',
      options: [
        { value: 'narrow', label: 'Narrow (45ch)' },
        { value: 'medium', label: 'Medium (60ch)' },
        { value: 'wide', label: 'Wide (75ch)' },
        { value: 'full', label: 'Full (no max)' },
      ],
      help: 'Web typography research suggests 45–75 characters per line for editorial body.',
    },
    {
      kind: 'select', key: 'animation', label: 'Animation',
      options: [
        { value: 'none', label: 'None (static)' },
        { value: 'fade-in', label: 'Fade in on scroll' },
        { value: 'slide-up', label: 'Slide up on scroll' },
      ],
    },
  ],

  lx_eyebrow: [
    { kind: 'string', key: 'text', label: 'Kicker text', maxLength: TEXT_MAX.caption, placeholder: 'KICKER LABEL' },
    {
      kind: 'select', key: 'prefix', label: 'Prefix',
      options: [
        { value: 'none', label: 'None' },
        { value: 'rule', label: 'Gold rule' },
      ],
      help: 'Gold rule prefix is the signature editorial kicker glyph.',
    },
    {
      kind: 'color',
      key: 'tone',
      label: 'Tone',
      tokens: ['champagne', 'obsidian', 'ivory', 'warm-stone'],
      allowCustom: true,
      allowAlpha: false,
      help: 'Champagne is the signature editorial kicker tone.',
    },
    {
      kind: 'font_weight',
      key: 'weight',
      label: 'Font weight',
      help: 'Eyebrows traditionally sit at semibold/bold for crisp uppercase.',
    },
    {
      kind: 'select', key: 'alignment', label: 'Alignment',
      options: [
        { value: 'left', label: 'Left' },
        { value: 'center', label: 'Center' },
        { value: 'right', label: 'Right' },
      ],
    },
    {
      kind: 'select', key: 'animation', label: 'Animation',
      options: [
        { value: 'none', label: 'None (static)' },
        { value: 'fade-in', label: 'Fade in on scroll' },
        { value: 'slide-up', label: 'Slide up on scroll' },
      ],
    },
  ],

  lx_action: [
    { kind: 'string', key: 'label', label: 'Action label', maxLength: TEXT_MAX.ctaText, placeholder: 'e.g. Schedule a viewing' },
    {
      kind: 'string', key: 'href', label: 'Link target', maxLength: TEXT_MAX.url, placeholder: '/contact  or  https://…',
      help: 'Allowed schemes: http, https, mailto, tel, /relative paths.',
    },
    { kind: 'boolean', key: 'openInNew', label: 'Open in a new tab', help: 'Recommended for external links.' },
    {
      kind: 'select', key: 'variant', label: 'Variant',
      options: [
        { value: 'primary-gold', label: 'Primary (champagne fill)' },
        { value: 'secondary-outline', label: 'Secondary (gold outline)' },
        { value: 'ghost', label: 'Ghost (type only)' },
        { value: 'link-arrow', label: 'Link with arrow' },
      ],
    },
    {
      kind: 'select', key: 'size', label: 'Size',
      options: [
        { value: 'sm', label: 'Small' },
        { value: 'md', label: 'Medium' },
        { value: 'lg', label: 'Large' },
      ],
    },
    {
      kind: 'select', key: 'alignment', label: 'Alignment',
      options: [
        { value: 'left', label: 'Left' },
        { value: 'center', label: 'Center' },
        { value: 'right', label: 'Right' },
      ],
    },
    {
      kind: 'select', key: 'animation', label: 'Animation',
      options: [
        { value: 'none', label: 'None (static)' },
        { value: 'fade-in', label: 'Fade in on scroll' },
        { value: 'slide-up', label: 'Slide up on scroll' },
        { value: 'magnetic', label: 'Magnetic hover (hero CTA only)' },
      ],
      help: 'Reserve magnetic hover for the canonical single hero CTA — multiple magnetic buttons read as gimmicky.',
    },
  ],

  lx_figure: [
    { kind: 'media', key: 'image', label: 'Image' },
    {
      kind: 'select', key: 'ratio', label: 'Aspect ratio',
      options: [
        { value: '21:9', label: '21:9 (cinematic)' },
        { value: '16:9', label: '16:9 (standard)' },
        { value: '4:5', label: '4:5 (editorial portrait)' },
        { value: '1:1', label: '1:1 (square)' },
      ],
    },
    {
      kind: 'select', key: 'fit', label: 'Fit',
      options: [
        { value: 'cover', label: 'Cover (fill the frame)' },
        { value: 'contain', label: 'Contain (fit inside)' },
      ],
    },
    { kind: 'string', key: 'caption', label: 'Caption', maxLength: TEXT_MAX.short },
    { kind: 'boolean', key: 'goldOverlay', label: 'Champagne gradient overlay', help: 'Soft gold gradient over the bottom of the image for brand cohesion.' },
    {
      kind: 'select', key: 'corners', label: 'Corners',
      options: [
        { value: 'sharp', label: 'Sharp (architectural)' },
        { value: 'soft', label: 'Soft (8px radius)' },
      ],
      help: 'Sharp is the editorial standard — soft reads as consumer-app.',
    },
    {
      kind: 'select', key: 'animation', label: 'Animation',
      options: [
        { value: 'none', label: 'None (static)' },
        { value: 'fade-in', label: 'Fade in on scroll' },
        { value: 'slide-up', label: 'Slide up on scroll' },
        { value: 'parallax', label: 'Parallax (image scales across viewport)' },
      ],
    },
  ],

  lx_cover_image: [
    { kind: 'media', key: 'image', label: 'Cover image' },
    {
      kind: 'select', key: 'ratio', label: 'Aspect ratio',
      options: [
        { value: '21:9', label: '21:9 (cinematic)' },
        { value: '16:9', label: '16:9 (standard widescreen)' },
        { value: '4:3', label: '4:3 (classic)' },
        { value: '3:2', label: '3:2 (photo)' },
        { value: '4:5', label: '4:5 (portrait)' },
        { value: 'auto', label: 'Auto (min-height drives the box)' },
      ],
    },
    {
      kind: 'select', key: 'minHeight', label: 'Minimum height',
      options: [
        { value: 'none', label: 'None (let ratio decide)' },
        { value: 'sm', label: 'Small — 320 px' },
        { value: 'md', label: 'Medium — 420 px' },
        { value: 'lg', label: 'Large — 540 px' },
        { value: 'xl', label: 'Extra-large — 680 px' },
        { value: 'screen', label: 'Full viewport (100vh)' },
      ],
      help: 'Floor for the cover height so it never collapses to a thin band on landscape screens.',
    },
    {
      kind: 'select', key: 'overlay', label: 'Overlay tint',
      options: [
        { value: 'none', label: 'None' },
        { value: 'darken', label: 'Darken (subtle)' },
        { value: 'darken-strong', label: 'Darken (strong)' },
        { value: 'gradient-bottom', label: 'Gradient — dark at the bottom' },
        { value: 'champagne', label: 'Champagne wash' },
      ],
      help: 'Pick an overlay if text will sit on top of the image — keeps the heading legible.',
    },
    {
      kind: 'select', key: 'animation', label: 'Animation',
      options: [
        { value: 'none', label: 'None (static)' },
        { value: 'fade-in', label: 'Fade in on scroll' },
        { value: 'parallax', label: 'Parallax (image scales across viewport)' },
      ],
    },
  ],

  lx_image_pair: [
    { kind: 'media', key: 'leftImage', label: 'Left image' },
    { kind: 'media', key: 'rightImage', label: 'Right image' },
    {
      kind: 'select', key: 'layout', label: 'Which side lifts',
      options: [
        { value: 'lift-left', label: 'Left image lifts (front)' },
        { value: 'lift-right', label: 'Right image lifts (front)' },
      ],
      help: 'The lifted side sits in front with a stronger shadow; the other tucks underneath.',
    },
    {
      kind: 'select', key: 'overlap', label: 'Overlap',
      options: [
        { value: 'sm', label: 'Small (subtle overlap)' },
        { value: 'md', label: 'Medium (editorial overlap)' },
        { value: 'lg', label: 'Large (bold overlap)' },
      ],
    },
    {
      kind: 'select', key: 'ratio', label: 'Aspect ratio',
      options: [
        { value: '3:4', label: '3:4 (portrait)' },
        { value: '4:5', label: '4:5 (editorial portrait)' },
        { value: '1:1', label: '1:1 (square)' },
      ],
      help: 'Both images share the ratio so the composition stays balanced.',
    },
    {
      kind: 'select', key: 'animation', label: 'Animation',
      options: [
        { value: 'none', label: 'None (static)' },
        { value: 'fade-in', label: 'Fade in on scroll' },
        { value: 'slide-up', label: 'Slide up on scroll' },
      ],
    },
  ],

  lx_map: [
    {
      kind: 'string',
      key: 'embedUrl',
      label: 'Google Maps embed URL',
      maxLength: TEXT_MAX.url,
      multiline: true,
      placeholder: 'https://www.google.com/maps/embed?pb=…',
      help: 'In Google Maps, open the place → Share → Embed a map → copy the iframe src URL. Either the share-dialog form (www.google.com/maps/embed?pb=…) or the keyless query form (maps.google.com/maps?…&output=embed) is accepted.',
    },
    {
      kind: 'select',
      key: 'ratio',
      label: 'Aspect ratio',
      options: [
        { value: '21:9', label: '21:9 (cinematic)' },
        { value: '16:9', label: '16:9 (standard)' },
        { value: '4:5', label: '4:5 (editorial portrait)' },
        { value: '1:1', label: '1:1 (square)' },
      ],
    },
    {
      kind: 'string',
      key: 'caption',
      label: 'Caption (optional)',
      maxLength: TEXT_MAX.short,
      placeholder: 'Street address or short location note',
    },
    {
      kind: 'boolean',
      key: 'goldOverlay',
      label: 'Champagne gradient overlay',
      help: 'Soft gold gradient over the bottom of the map for brand cohesion. Leave off for crisp legibility.',
    },
    {
      kind: 'select',
      key: 'animation',
      label: 'Animation',
      options: [
        { value: 'none', label: 'None (static)' },
        { value: 'fade-in', label: 'Fade in on scroll' },
        { value: 'slide-up', label: 'Slide up on scroll' },
      ],
    },
  ],

  // lx_rule shape removed — widget retired (no borders/lines).

  lx_space: [
    {
      kind: 'select', key: 'size', label: 'Vertical space',
      options: [
        { value: 'section-xs', label: 'XS (48px)' },
        { value: 'section-sm', label: 'SM (64px)' },
        { value: 'section-md', label: 'MD (96px)' },
        { value: 'section-lg', label: 'LG (128px)' },
        { value: 'section-xl', label: 'XL (160px)' },
        { value: 'section-2xl', label: '2XL (192px)' },
      ],
      help: 'Use sparingly — section padding handles most vertical rhythm.',
    },
  ],

  lx_channel_card: [
    { kind: 'string', key: 'label', label: 'Kicker label', maxLength: TEXT_MAX.caption, placeholder: 'EMAIL / PHONE / ADDRESS' },
    { kind: 'string', key: 'value', label: 'Display value', maxLength: TEXT_MAX.caption, placeholder: 'hello@yourdomain.com' },
    { kind: 'string', key: 'description', label: 'Description', maxLength: TEXT_MAX.body, multiline: true, placeholder: 'Brief supporting copy' },
    {
      kind: 'string', key: 'href', label: 'Link target (optional)', maxLength: TEXT_MAX.url, placeholder: 'mailto:… or tel:… or https://…',
      help: 'When set, the whole tile becomes a click target. Leave blank for cards (e.g. an address) that aren’t clickable.',
    },
    {
      kind: 'icon',
      key: 'icon',
      label: 'Icon',
      help: 'Search 1,950+ Lucide icons — picks dropped here render with a champagne glow halo.',
    },
    {
      kind: 'color',
      key: 'tone',
      label: 'Tone',
      tokens: ['obsidian', 'ivory'],
      allowCustom: true,
      allowAlpha: false,
      help: 'Obsidian for ivory/bone sections; ivory for obsidian/champagne sections.',
    },
  ],

  lx_stat: [
    { kind: 'number', key: 'value', label: 'Number', step: 1 },
    { kind: 'string', key: 'prefix', label: 'Prefix', maxLength: 8, placeholder: 'e.g. $' },
    { kind: 'string', key: 'suffix', label: 'Suffix', maxLength: 8, placeholder: 'e.g. + or %' },
    { kind: 'string', key: 'label', label: 'Label', maxLength: TEXT_MAX.caption },
    { kind: 'number', key: 'duration_ms', label: 'Count-up duration (ms)', min: 0, max: 10000, step: 100, help: 'Default 1800ms. 0 disables the count-up (number renders at final value immediately).' },
    {
      kind: 'select', key: 'alignment', label: 'Alignment',
      options: [
        { value: 'left', label: 'Left' },
        { value: 'center', label: 'Center' },
        { value: 'right', label: 'Right' },
      ],
    },
    {
      kind: 'color',
      key: 'tone',
      label: 'Tone',
      tokens: ['obsidian', 'ivory', 'champagne'],
      allowCustom: true,
      allowAlpha: false,
    },
    {
      kind: 'font_family',
      key: 'family',
      label: 'Font family',
    },
    {
      kind: 'font_weight',
      key: 'weight',
      label: 'Font weight',
      familyKey: 'family',
    },
  ],

  lx_quote: [
    { kind: 'string', key: 'quote', label: 'Quote', maxLength: TEXT_MAX.body, multiline: true, placeholder: 'A short, signature closing thought.' },
    { kind: 'string', key: 'attribution', label: 'Attribution', maxLength: TEXT_MAX.caption, placeholder: 'Author / company' },
    {
      kind: 'select', key: 'alignment', label: 'Alignment',
      options: [
        { value: 'left', label: 'Left' },
        { value: 'center', label: 'Center' },
      ],
    },
    {
      kind: 'color',
      key: 'tone',
      label: 'Tone',
      tokens: ['obsidian', 'ivory'],
      allowCustom: true,
      allowAlpha: false,
    },
    {
      kind: 'font_family',
      key: 'family',
      label: 'Font family',
    },
    {
      kind: 'font_weight',
      key: 'weight',
      label: 'Font weight',
      familyKey: 'family',
    },
    {
      kind: 'select', key: 'animation', label: 'Animation',
      options: [
        { value: 'none', label: 'None (static)' },
        { value: 'fade-in', label: 'Fade in on scroll' },
        { value: 'slide-up', label: 'Slide up on scroll' },
        { value: 'line-reveal', label: 'Line reveal (signature)' },
      ],
    },
  ],
  lx_featured_projects: [
    { kind: 'string', key: 'heading', label: 'Heading', maxLength: TEXT_MAX.title, placeholder: 'Selected work' },
    {
      kind: 'select', key: 'columns', label: 'Columns', valueAsNumber: true,
      options: [
        { value: '2', label: '2' },
        { value: '3', label: '3' },
        { value: '4', label: '4' },
      ],
    },
    // No tone field — the grid auto-contrasts the section background.
    {
      kind: 'select', key: 'animation', label: 'Animation',
      options: [
        { value: 'none', label: 'None (static)' },
        { value: 'fade-in', label: 'Fade in on scroll' },
        { value: 'slide-up', label: 'Slide up on scroll' },
      ],
    },
  ],
}

// Merge identity & visibility entries onto every registered block.
// Sections + columns get the full trio (label + htmlId + visibility);
// widgets get htmlId + visibility (no label — widgets are identified
// by inline content). EditDrawer.tsx routes these keys to the Advanced
// tab via ADVANCED_KEYS so they don't crowd the Content surface.
export const SHAPES_FOR_BLOCK: Record<string, FieldShape[]> = (() => {
  const out: Record<string, FieldShape[]> = {}
  for (const [type, shapes] of Object.entries(BASE_SHAPES_FOR_BLOCK)) {
    const identity =
      type === 'section'
        ? CONTAINER_IDENTITY_SHAPES
        : type === 'column'
          ? COLUMN_IDENTITY_SHAPES
          : WIDGET_IDENTITY_SHAPES
    out[type] = [...shapes, ...identity]
  }
  return out
})()
