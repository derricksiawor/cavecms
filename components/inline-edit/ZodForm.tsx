'use client'
import { useEffect, useMemo, useState } from 'react'
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
import { MenuBuilder } from './MenuBuilder'
import { SocialLinkRow, type SocialLinkValue } from './SocialLinkRow'
import { TEXT_MAX } from '@/lib/cms/limits'
import {
  ColorPickerField,
  FontFamilyPickerField,
  FontWeightPickerField,
  IconPickerField,
} from './pickers'
import { GradientPickerField } from './GradientPickerField'
import type { ColorToken, FontFamilyToken, FontWeightToken } from '@/lib/cms/designTokens'
import type { Gradient } from '@/lib/cms/gradient'

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
  // Structured gradient (kind + angle + 2–6 hex stops). Visual picker
  // with a live preview. Cleared value = undefined (no gradient). Used for
  // text gradients, section/column backgrounds, and button fills.
  | { kind: 'gradient'; key: string; label: string; help?: string }
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
  // Logo height slider with a live preview. Reads the sibling media
  // field named by `logoKey` off the parent record and renders that
  // image at the slider's current px height so the operator sees the
  // logo resize in real time as they drag. The persisted value is the
  // integer px height; cleared / unset falls back to `fallback`.
  | {
      kind: 'logoSize'
      key: string
      label: string
      logoKey: string
      min?: number
      max?: number
      fallback?: number
      help?: string
    }
  // Shared drag-and-drop menu builder for one-level menus (header nav with
  // dropdowns; footer columns with links). Config keys decouple the builder
  // from the raw value shape — see lib/cms/menuTree.ts MenuConfig.
  | {
      kind: 'menu_builder'
      key: string
      label: string
      help?: string
      // Parent label is always the `label` field (header link + footer column
      // heading both use it), so there's no parentLabelKey — only the child
      // label key varies ('label' vs 'text').
      parentHrefKey?: string
      childrenKey: string
      childLabelKey: string
      childHrefKey: string
      maxItems: number
      maxChildren: number
      parentNoun: string
      childNoun: string
    }

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

    case 'gradient':
      return (
        <GradientPickerField
          label={shape.label}
          help={shape.help}
          value={(value as Gradient | undefined) ?? undefined}
          onChange={onChange}
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

    case 'logoSize':
      return (
        <LogoSizeField
          label={shape.label}
          help={shape.help}
          value={typeof value === 'number' ? value : undefined}
          logo={parent[shape.logoKey] as { media_id: number; alt?: string } | undefined}
          min={shape.min ?? 24}
          max={shape.max ?? 96}
          fallback={shape.fallback ?? 40}
          onChange={onChange}
        />
      )
    case 'menu_builder':
      return (
        <MenuBuilder
          shape={shape}
          value={value as Array<Record<string, unknown>> | undefined}
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

// Logo height control — a slider plus a live preview that renders the
// sibling logo (resolved from the media id on the parent record) at the
// slider's current px height. The operator sees the logo grow/shrink in
// real time as they drag, on a checkerboard backdrop so transparent
// logos read clearly. Persists the integer px height.
function LogoSizeField({
  label,
  help,
  value,
  logo,
  min,
  max,
  fallback,
  onChange,
}: {
  label: string
  help?: string
  value: number | undefined
  logo: { media_id: number; alt?: string } | undefined
  min: number
  max: number
  fallback: number
  onChange: (v: unknown) => void
}) {
  const { resolveThumb, resolveThumbAsync } = useMediaPicker()
  const current = typeof value === 'number' ? value : fallback
  const mediaId = logo?.media_id
  // Seed from the sync LRU cache so a warmed thumb paints on first frame
  // (no flash). Fall back to the async fetch when the cache is cold
  // (settings logo is pre-set before the media modal ever opens).
  const [src, setSrc] = useState<string | null>(() =>
    mediaId ? resolveThumb(mediaId) : null,
  )
  useEffect(() => {
    let alive = true
    if (!mediaId) {
      setSrc(null)
      return
    }
    const cached = resolveThumb(mediaId)
    if (cached) {
      setSrc(cached)
      return
    }
    resolveThumbAsync(mediaId)
      .then((url) => {
        if (alive) setSrc(url)
      })
      .catch(() => {
        if (alive) setSrc(null)
      })
    return () => {
      alive = false
    }
  }, [mediaId, resolveThumb, resolveThumbAsync])
  return (
    <fieldset className="space-y-3 rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-4">
      <legend className="cavecms-sticky-legend sticky top-0 z-10 -mt-1 -ml-2 px-2 py-1 rounded-md backdrop-blur-md bg-cream-50/85">
        <FieldLabel>{label}</FieldLabel>
      </legend>
      {help && <FieldHelp>{help}</FieldHelp>}
      {/* Live preview — logo rendered at the chosen px height on a
         checkerboard so transparent logos stay legible. Empty state when
         no logo is set yet. */}
      <div
        className="flex items-center justify-center overflow-hidden rounded-xl border border-warm-stone/20 p-4 min-h-[7rem]"
        style={{
          backgroundColor: '#ffffff',
          backgroundImage:
            'linear-gradient(45deg, #efe9dd 25%, transparent 25%), linear-gradient(-45deg, #efe9dd 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #efe9dd 75%), linear-gradient(-45deg, transparent 75%, #efe9dd 75%)',
          backgroundSize: '16px 16px',
          backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
        }}
      >
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={logo?.alt || 'Logo preview'}
            style={{ height: `${current}px` }}
            className="w-auto max-w-full object-contain transition-all duration-quick"
          />
        ) : (
          <span className="text-center text-[11px] leading-relaxed text-warm-stone/70">
            Upload a logo above to preview its size here.
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={min}
          max={max}
          step={1}
          value={current}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={label}
          className="h-2 flex-1 cursor-pointer accent-copper-500"
        />
        <span className="w-14 shrink-0 text-right text-sm font-medium tabular-nums text-near-black">
          {current}px
        </span>
      </div>
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
    // Seed a new item with KIND-APPROPRIATE defaults. A blanket '' breaks any
    // non-string itemField: a present '' is validated as-is by the server Zod
    // schema (enum/boolean/number/array) and rejected, since `.default()` only
    // fills ABSENT keys. So text-like kinds get '', selects get their first
    // valid option, booleans false, arrays [], and every other kind is OMITTED
    // entirely — letting the schema's `.default()`/`.optional()` apply on save.
    const b: Record<string, unknown> = { __id: cryptoId() }
    for (const f of shape.itemFields) {
      switch (f.kind) {
        case 'string':
        case 'richtext':
          b[f.key] = ''
          break
        case 'string_array':
          b[f.key] = []
          break
        case 'boolean':
          b[f.key] = false
          break
        case 'select':
          if (f.options.length) b[f.key] = f.options[0]!.value
          break
        case 'number':
          // Seed a valid starting number (min, else 0) so a REQUIRED number
          // itemField with no schema default doesn't make the new item fail
          // validation on save (e.g. hotspot x/y, stat value, rating).
          b[f.key] = f.min ?? 0
          break
        default:
          // color, gradient, icon, media, link, object_array, font_family,
          // font_weight, menu_builder, visibility → omit (schema .default()/
          // .optional() applies on save).
          break
      }
    }
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

// Shared decoration controls (Elementor parity) appended to every section
// + column: border, box-shadow, sticky. Route to the Style tab (STYLE_KEYS).
const CONTAINER_DECORATION_SHAPES: FieldShape[] = [
  { kind: 'number', key: 'borderWidth', label: 'Border width (px)', min: 0, max: 40, step: 1, help: '0 = no border. Pairs with the style + colour below.' },
  {
    kind: 'select', key: 'borderStyle', label: 'Border style',
    options: [
      { value: 'solid', label: 'Solid' }, { value: 'dashed', label: 'Dashed' },
      { value: 'dotted', label: 'Dotted' }, { value: 'double', label: 'Double' },
    ],
  },
  { kind: 'color', key: 'borderColor', label: 'Border colour', tokens: [], allowCustom: true, allowAlpha: false },
  { kind: 'number', key: 'borderRadius', label: 'Corner radius (px)', min: 0, max: 200, step: 1, help: 'Rounds the corners (and clips children).' },
  {
    kind: 'select', key: 'boxShadow', label: 'Shadow',
    options: [
      { value: 'none', label: 'None' }, { value: 'sm', label: 'Small' }, { value: 'md', label: 'Medium' },
      { value: 'lg', label: 'Large' }, { value: 'xl', label: 'Extra large' }, { value: '2xl', label: 'Cinematic' },
    ],
  },
  { kind: 'color', key: 'boxShadowColor', label: 'Shadow colour (optional)', tokens: [], allowCustom: true, allowAlpha: false, help: 'Tints the shadow; default is a neutral black.' },
  {
    kind: 'select', key: 'sticky', label: 'Sticky on scroll',
    options: [
      { value: 'none', label: 'No' }, { value: 'top', label: 'Stick to top' }, { value: 'bottom', label: 'Stick to bottom' },
    ],
    help: 'Pins this block in view while the page scrolls past it.',
  },
  { kind: 'number', key: 'stickyOffset', label: 'Sticky offset (px)', min: 0, max: 400, step: 1, help: 'Gap from the viewport edge when sticky.' },
  {
    kind: 'select', key: 'motionEffect', label: 'Scroll motion effect',
    options: [
      { value: 'none', label: 'None' },
      { value: 'parallax', label: 'Parallax (drifts on scroll)' },
      { value: 'fade-scroll', label: 'Fade on scroll' },
      { value: 'zoom-scroll', label: 'Zoom on scroll' },
      { value: 'tilt', label: '3D tilt on mouse' },
    ],
    help: 'Motion as the visitor scrolls / moves the mouse. Respects reduced-motion.',
  },
  { kind: 'number', key: 'motionIntensity', label: 'Motion intensity', min: 1, max: 100, step: 1, help: '1–100. Default 30.' },
  { kind: 'number', key: 'hoverLift', label: 'Hover lift (px)', min: 0, max: 40, step: 1, help: 'Raises the card on hover (translate up). Great for feature cards.' },
  {
    kind: 'select', key: 'hoverShadow', label: 'Hover shadow',
    options: [
      { value: 'none', label: 'None' }, { value: 'sm', label: 'Small' }, { value: 'md', label: 'Medium' },
      { value: 'lg', label: 'Large' }, { value: 'xl', label: 'Extra large' }, { value: '2xl', label: 'Cinematic' },
    ],
    help: 'Grows the elevation on hover.',
  },
  { kind: 'color', key: 'hoverBorderColor', label: 'Hover border colour', tokens: [], allowCustom: true, allowAlpha: false, help: 'Border colour on hover (pairs with a border above).' },
  { kind: 'string', key: 'customCss', label: 'Custom CSS', multiline: true, maxLength: 1200, placeholder: 'e.g. backdrop-filter: blur(8px); letter-spacing: 1px;', help: 'CSS declarations applied to this block (no selectors/braces). Scoped + sanitised.' },
  { kind: 'string', key: 'customCssHover', label: 'Custom CSS · hover', multiline: true, maxLength: 1200, placeholder: 'e.g. transform: translateY(-4px);', help: 'Declarations applied on hover.' },
]

// Exact spacing with UNITS (E15) — per-side padding + margin accepting any
// CSS length (px/rem/em/%/vw/vh). Complements the quick px toolbar; these
// give full unit control. Appended to section + column.
const SPACING_LEN_PATTERN = /^-?\d*\.?\d+(?:px|rem|em|%|vw|vh)$/
const CONTAINER_SPACING_SHAPES: FieldShape[] = [
  { kind: 'string', key: 'paddingTop', label: 'Padding top', placeholder: 'e.g. 24px, 2rem, 5%', pattern: SPACING_LEN_PATTERN, patternError: 'Use a number + unit (px/rem/em/%/vw/vh).' },
  { kind: 'string', key: 'paddingRight', label: 'Padding right', placeholder: 'e.g. 24px, 2rem', pattern: SPACING_LEN_PATTERN, patternError: 'Use a number + unit.' },
  { kind: 'string', key: 'paddingBottom', label: 'Padding bottom', placeholder: 'e.g. 24px, 2rem', pattern: SPACING_LEN_PATTERN, patternError: 'Use a number + unit.' },
  { kind: 'string', key: 'paddingLeft', label: 'Padding left', placeholder: 'e.g. 24px, 2rem', pattern: SPACING_LEN_PATTERN, patternError: 'Use a number + unit.' },
  { kind: 'string', key: 'marginTop', label: 'Margin top', placeholder: 'e.g. 16px, 1rem', pattern: SPACING_LEN_PATTERN, patternError: 'Use a number + unit.' },
  { kind: 'string', key: 'marginRight', label: 'Margin right', placeholder: 'e.g. 16px, 1rem', pattern: SPACING_LEN_PATTERN, patternError: 'Use a number + unit.' },
  { kind: 'string', key: 'marginBottom', label: 'Margin bottom', placeholder: 'e.g. 16px, 1rem', pattern: SPACING_LEN_PATTERN, patternError: 'Use a number + unit.' },
  { kind: 'string', key: 'marginLeft', label: 'Margin left', placeholder: 'e.g. 16px, 1rem', pattern: SPACING_LEN_PATTERN, patternError: 'Use a number + unit.' },
]

// Section shape dividers (Elementor parity) — SVG separators on the top /
// bottom edges. Section-only.
const SHAPE_OPTIONS = [
  { value: 'none', label: 'None' }, { value: 'wave', label: 'Wave' },
  { value: 'tilt', label: 'Tilt' }, { value: 'curve', label: 'Curve' },
  { value: 'triangle', label: 'Triangle' }, { value: 'mountains', label: 'Mountains' },
  { value: 'split', label: 'Split' },
]
const SECTION_SHAPE_DIVIDER_SHAPES: FieldShape[] = [
  { kind: 'select', key: 'shapeTop', label: 'Top shape divider', options: SHAPE_OPTIONS, help: 'An SVG separator on the section’s top edge. Set its colour to the section above for a clean transition.' },
  { kind: 'color', key: 'shapeTopColor', label: 'Top divider colour', tokens: [], allowCustom: true, allowAlpha: false },
  { kind: 'number', key: 'shapeTopHeight', label: 'Top divider height (px)', min: 8, max: 400, step: 1 },
  { kind: 'boolean', key: 'shapeTopFlip', label: 'Flip top divider horizontally' },
  { kind: 'select', key: 'shapeBottom', label: 'Bottom shape divider', options: SHAPE_OPTIONS, help: 'An SVG separator on the section’s bottom edge.' },
  { kind: 'color', key: 'shapeBottomColor', label: 'Bottom divider colour', tokens: [], allowCustom: true, allowAlpha: false },
  { kind: 'number', key: 'shapeBottomHeight', label: 'Bottom divider height (px)', min: 8, max: 400, step: 1 },
  { kind: 'boolean', key: 'shapeBottomFlip', label: 'Flip bottom divider horizontally' },
]

// Widget entrance-animation timing (E16) — duration + delay (ms), applied to
// the block's reveal animation via the MotionTiming context. Appended to
// every widget (not sections/columns, which carry their own animation knobs).
const WIDGET_MOTION_SHAPES: FieldShape[] = [
  { kind: 'number', key: 'animationDuration', label: 'Animation duration (ms)', min: 0, max: 5000, step: 50, help: 'Entrance speed for this block’s on-scroll animation.' },
  { kind: 'number', key: 'animationDelay', label: 'Animation delay (ms)', min: 0, max: 5000, step: 50, help: 'Stagger the entrance — e.g. 100ms on each card in a row.' },
  { kind: 'string', key: 'customCss', label: 'Custom CSS', multiline: true, maxLength: 1200, placeholder: 'e.g. backdrop-filter: blur(8px);', help: 'CSS declarations for this block (no selectors/braces). Scoped + sanitised.' },
  { kind: 'string', key: 'customCssHover', label: 'Custom CSS · hover', multiline: true, maxLength: 1200, placeholder: 'e.g. transform: scale(1.03);', help: 'Declarations applied on hover.' },
]

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
      kind: 'color',
      key: 'backgroundColor',
      label: 'Exact background color (optional)',
      tokens: [],
      allowCustom: true,
      allowAlpha: false,
      help: 'Match a brand exactly with any hex color — overrides the tone above. Text contrast auto-adapts to its lightness. Leave empty to use the Background tone.',
    },
    { kind: 'gradient', key: 'backgroundGradient', label: 'Gradient background', help: 'A multi-stop gradient behind the whole section — overrides the tone + exact colour above. Toggle off to use a solid background.' },
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
      kind: 'media_array', key: 'backgroundSlides', label: 'Background slideshow (optional)',
      help: 'Add 2+ photos to cross-fade them as an animated slideshow behind the section (overrides the single background image above). Each slide fades through black with a counter-zoom. Up to 8 — only the first loads upfront, the rest stream in.',
    },
    {
      kind: 'select', key: 'kenBurns', label: 'Ken Burns motion',
      options: [
        { value: 'none', label: 'None (static)' },
        { value: 'zoom-in', label: 'Slow zoom in' },
        { value: 'zoom-out', label: 'Slow zoom out' },
        { value: 'pan-left', label: 'Pan left' },
        { value: 'pan-right', label: 'Pan right' },
        { value: 'zoom-pan', label: 'Zoom + pan' },
      ],
      help: 'A slow continuous camera move on the background photo (single image or each slide). Respects reduced-motion — it stops for visitors who ask for less animation.',
    },
    {
      kind: 'select', key: 'slideTransition', label: 'Slide transition',
      options: [
        { value: 'through-black', label: 'Through black (cinematic)' },
        { value: 'crossfade', label: 'Crossfade (counter-zoom)' },
        { value: 'fade', label: 'Fade (no zoom)' },
      ],
      help: 'How one slide gives way to the next. Through-black: the outgoing photo fades out zooming in while the next fades in zooming out, dipping through black.',
    },
    { kind: 'number', key: 'slideIntervalMs', label: 'Milliseconds per slide', min: 1000, max: 30000, step: 500, help: 'How long each slide shows before advancing, in milliseconds — 4000 = 4 seconds (Elementor-style). 1000–30000. Only applies with 2+ slides.' },
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
      kind: 'select', key: 'backgroundPosition', label: 'Image position',
      options: [
        { value: 'center', label: 'Center' }, { value: 'top', label: 'Top' }, { value: 'bottom', label: 'Bottom' },
        { value: 'left', label: 'Left' }, { value: 'right', label: 'Right' },
        { value: 'top left', label: 'Top left' }, { value: 'top right', label: 'Top right' },
        { value: 'bottom left', label: 'Bottom left' }, { value: 'bottom right', label: 'Bottom right' },
      ],
      help: 'Which part of the photo/video stays in frame when cropped (object-position).',
    },
    { kind: 'string', key: 'backgroundVideoUrl', label: 'Background video URL (optional)', placeholder: 'https://…/clip.mp4', help: 'A looping, muted, autoplay background video (https .mp4/.webm). Renders behind the content like a cover image.' },
    { kind: 'media', key: 'backgroundVideoPoster', label: 'Video poster image (optional)', help: 'Shown before the video loads (and on devices that block autoplay).' },
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
    {
      kind: 'select', key: 'contentMaxWidth', label: 'Content width',
      options: [
        { value: 'sm', label: 'Narrow — 768 px' },
        { value: 'md', label: 'Medium — 1024 px' },
        { value: 'lg', label: 'Wide — 1152 px' },
        { value: 'xl', label: 'Extra wide — 1280 px (default)' },
        { value: 'full', label: 'Full (edge to edge)' },
      ],
      help: 'Max width of the section’s inner content. Default is 1280px.',
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
    // Inline row primitive — lay this column's widgets horizontally
    // instead of the default vertical stack. Great for a row of buttons,
    // badges, logos or stats without splitting the section into columns.
    {
      kind: 'select', key: 'childLayout', label: 'Lay out items',
      options: [
        { value: 'stack', label: 'Stacked (vertical, default)' },
        { value: 'row', label: 'In a row (horizontal)' },
        { value: 'grid', label: 'In a grid (wrapping)' },
      ],
      help: 'Row = side by side, wraps. Grid = a wrapping card grid inside this column (a nested container).',
    },
    {
      kind: 'select', key: 'childColumns', label: 'Grid columns', valueAsNumber: true,
      options: [{ value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }, { value: '4', label: '4' }],
      help: 'Only applies in grid mode.',
    },
    { kind: 'number', key: 'childGap', label: 'Gap between items (px)', min: 0, max: 96, step: 1, help: 'Spacing between items in row/grid mode.' },
    {
      kind: 'select', key: 'childJustify', label: 'Row alignment',
      options: [
        { value: 'start', label: 'Left' },
        { value: 'center', label: 'Center' },
        { value: 'end', label: 'Right' },
        { value: 'between', label: 'Spaced apart' },
      ],
      help: 'Only applies in row mode — how the items distribute horizontally.',
    },
    {
      kind: 'color', key: 'backgroundColor', label: 'Card background color (optional)',
      tokens: [], allowCustom: true, allowAlpha: false,
      help: 'Give the column a solid background → it renders as a rounded, padded CARD (great for icon-less feature cards). Text contrast auto-adapts.',
    },
    { kind: 'gradient', key: 'backgroundGradient', label: 'Gradient background', help: 'A multi-stop gradient behind this column — overrides any solid column background.' },
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
    // Whole-card link. Makes the ENTIRE column one clickable target
    // (stretched-link overlay) while any button or link the operator
    // drops inside still works on its own — so you can build a custom
    // card (image + heading + text + your own styled button) AND make
    // the whole thing a link. Leave the target empty for no card link.
    {
      kind: 'link', key: 'cardLink', label: 'Link this whole card to…',
      help: 'Optional. Makes the entire column clickable. /relative paths, https://, mailto:, tel:. Buttons inside the card keep working independently.',
    },
    {
      kind: 'string', key: 'cardLinkLabel', label: 'Card link description',
      maxLength: 120,
      placeholder: 'e.g. View the Riverside project',
      help: 'Read by screen readers when the whole card is a link. Describe where it goes. Recommended whenever a card link is set.',
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
    { kind: 'gradient', key: 'textGradient', label: 'Gradient text', help: 'Fills the heading with a gradient (overrides the tone colour). Toggle off for a solid colour.' },
    { kind: 'string', key: 'fontSize', label: 'Exact font size (optional)', placeholder: 'e.g. 56px, 3.5rem, clamp(2.25rem,5vw,3.5rem)', help: 'Pixel-match a brand. Overrides the Visual size when set. A clamp() keeps it responsive.' },
    { kind: 'string', key: 'lineHeight', label: 'Exact line height (optional)', placeholder: 'e.g. 1.1 or 61px', help: 'A unitless number (1.1) or a length. Overrides the default tight leading.' },
    { kind: 'string', key: 'letterSpacing', label: 'Exact letter spacing (optional)', placeholder: 'e.g. -0.025em or -1.4px', help: 'Tightens or loosens tracking. Negative values pull letters together (display type).' },
    { kind: 'string', key: 'fontSizeTablet', label: '↳ Font size · tablet (≤1024px)', placeholder: 'e.g. 40px', help: 'Per-breakpoint override (responsive).' },
    { kind: 'string', key: 'fontSizeMobile', label: '↳ Font size · mobile (≤640px)', placeholder: 'e.g. 30px' },
    { kind: 'string', key: 'lineHeightTablet', label: '↳ Line height · tablet', placeholder: 'e.g. 1.15' },
    { kind: 'string', key: 'lineHeightMobile', label: '↳ Line height · mobile', placeholder: 'e.g. 1.2' },
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
    { kind: 'gradient', key: 'textGradient', label: 'Gradient text', help: 'Fills the text with a gradient (overrides the tone colour).' },
    { kind: 'string', key: 'fontSize', label: 'Exact font size (optional)', placeholder: 'e.g. 18px, 1.125rem', help: 'Overrides the Size when set — match a brand body ramp precisely.' },
    { kind: 'string', key: 'lineHeight', label: 'Exact line height (optional)', placeholder: 'e.g. 1.625 or 29px', help: 'A unitless number or a length.' },
    { kind: 'string', key: 'letterSpacing', label: 'Exact letter spacing (optional)', placeholder: 'e.g. 0.01em' },
    { kind: 'string', key: 'fontSizeTablet', label: '↳ Font size · tablet (≤1024px)', placeholder: 'e.g. 16px', help: 'Per-breakpoint override (responsive).' },
    { kind: 'string', key: 'fontSizeMobile', label: '↳ Font size · mobile (≤640px)', placeholder: 'e.g. 15px' },
    { kind: 'string', key: 'lineHeightTablet', label: '↳ Line height · tablet', placeholder: 'e.g. 1.6' },
    { kind: 'string', key: 'lineHeightMobile', label: '↳ Line height · mobile', placeholder: 'e.g. 1.55' },
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
      kind: 'select', key: 'variant', label: 'Style',
      options: [
        { value: 'badge', label: 'Badge (tinted pill)' },
        { value: 'plain', label: 'Plain (quiet label, no pill)' },
      ],
      help: 'Plain is a muted inline label (as-typed, no pill) for editorial section kickers; Badge is the tinted uppercase chip.',
    },
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
    { kind: 'gradient', key: 'textGradient', label: 'Gradient label', help: 'Paints the kicker text with a gradient (drops the pill tint for a clean gradient label).' },
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

  // ════════════════════════════════════════════════════════════════
  // ELEMENTOR-PARITY BLOCKS — field shapes for the new widgets.
  // ════════════════════════════════════════════════════════════════

  lx_carousel: [
    {
      kind: 'object_array', key: 'slides', label: 'Slides', addLabel: 'Add slide', itemNoun: 'slide', maxItems: 20,
      itemFields: [
        { kind: 'media', key: 'image', label: 'Image', accept: 'image' },
        { kind: 'string', key: 'caption', label: 'Caption', maxLength: TEXT_MAX.short },
        { kind: 'string', key: 'href', label: 'Link (optional)', maxLength: TEXT_MAX.url, placeholder: '/page or https://…' },
      ],
    },
    {
      kind: 'select', key: 'ratio', label: 'Aspect ratio',
      options: [
        { value: '21:9', label: 'Cinematic 21:9' },
        { value: '16:9', label: 'Widescreen 16:9' },
        { value: '4:3', label: 'Classic 4:3' },
        { value: '4:5', label: 'Portrait 4:5' },
        { value: '1:1', label: 'Square 1:1' },
      ],
    },
    { kind: 'boolean', key: 'autoplay', label: 'Autoplay', help: 'Disabled automatically for visitors who prefer reduced motion.' },
    { kind: 'number', key: 'intervalMs', label: 'Autoplay interval (ms)', min: 2000, max: 12000, step: 500 },
    { kind: 'boolean', key: 'loop', label: 'Loop' },
    { kind: 'boolean', key: 'showArrows', label: 'Show arrows' },
    { kind: 'boolean', key: 'showDots', label: 'Show dots' },
    { kind: 'color', key: 'tone', label: 'Arrow tone', tokens: ['obsidian', 'ivory'], allowCustom: false },
    {
      kind: 'select', key: 'animation', label: 'Animation',
      options: [
        { value: 'none', label: 'None (static)' },
        { value: 'fade-in', label: 'Fade in on scroll' },
        { value: 'slide-up', label: 'Slide up on scroll' },
      ],
    },
  ],

  lx_testimonial_carousel: [
    {
      kind: 'object_array', key: 'items', label: 'Testimonials', addLabel: 'Add testimonial', itemNoun: 'testimonial', maxItems: 12,
      itemFields: [
        { kind: 'string', key: 'quote', label: 'Quote', maxLength: TEXT_MAX.body, multiline: true },
        { kind: 'string', key: 'attribution', label: 'Name', maxLength: TEXT_MAX.caption },
        { kind: 'string', key: 'attribution_title', label: 'Role / title', maxLength: TEXT_MAX.caption },
        { kind: 'media', key: 'portrait', label: 'Portrait (optional)', accept: 'image' },
      ],
    },
    { kind: 'boolean', key: 'autoplay', label: 'Autoplay', help: 'Disabled automatically for visitors who prefer reduced motion.' },
    { kind: 'number', key: 'intervalMs', label: 'Autoplay interval (ms)', min: 2000, max: 12000, step: 500 },
    { kind: 'boolean', key: 'loop', label: 'Loop' },
    { kind: 'boolean', key: 'showArrows', label: 'Show arrows' },
    { kind: 'boolean', key: 'showDots', label: 'Show dots' },
    { kind: 'color', key: 'tone', label: 'Tone', tokens: ['obsidian', 'ivory'], allowCustom: true },
    {
      kind: 'select', key: 'animation', label: 'Animation',
      options: [
        { value: 'none', label: 'None (static)' },
        { value: 'fade-in', label: 'Fade in on scroll' },
        { value: 'slide-up', label: 'Slide up on scroll' },
      ],
    },
  ],

  lx_star_rating: [
    { kind: 'number', key: 'value', label: 'Rating', min: 0, max: 10, step: 0.5 },
    { kind: 'number', key: 'max', label: 'Out of', min: 1, max: 10, step: 1 },
    { kind: 'boolean', key: 'showValue', label: 'Show numeric value' },
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
    { kind: 'color', key: 'tone', label: 'Value tone', tokens: ['champagne', 'obsidian', 'ivory'], allowCustom: true },
    {
      kind: 'select', key: 'animation', label: 'Animation',
      options: [
        { value: 'none', label: 'None (static)' },
        { value: 'fade-in', label: 'Fade in on scroll' },
      ],
    },
  ],

  lx_pricing_table: [
    { kind: 'string', key: 'planName', label: 'Plan name', maxLength: TEXT_MAX.caption, placeholder: 'Professional' },
    { kind: 'string', key: 'price', label: 'Price', maxLength: TEXT_MAX.caption, placeholder: '$49' },
    { kind: 'string', key: 'period', label: 'Period', maxLength: TEXT_MAX.caption, placeholder: '/month' },
    { kind: 'string', key: 'description', label: 'Description', maxLength: TEXT_MAX.body, multiline: true },
    { kind: 'string_array', key: 'features', label: 'Features', placeholder: 'Type a feature, press Enter', maxItems: 20 },
    { kind: 'string', key: 'ctaLabel', label: 'Button label', maxLength: TEXT_MAX.ctaText, placeholder: 'Get started' },
    { kind: 'string', key: 'ctaHref', label: 'Button link', maxLength: TEXT_MAX.url, placeholder: '/contact' },
    { kind: 'boolean', key: 'ctaOpenInNew', label: 'Open button in a new tab' },
    { kind: 'boolean', key: 'featured', label: 'Featured (highlighted) plan' },
    { kind: 'string', key: 'featuredLabel', label: 'Featured badge text', maxLength: TEXT_MAX.caption, placeholder: 'Most popular' },
    { kind: 'color', key: 'tone', label: 'Tone', tokens: ['obsidian', 'ivory'], allowCustom: true },
    {
      kind: 'select', key: 'animation', label: 'Animation',
      options: [
        { value: 'none', label: 'None (static)' },
        { value: 'fade-in', label: 'Fade in on scroll' },
        { value: 'slide-up', label: 'Slide up on scroll' },
      ],
    },
  ],

  lx_pricing_list: [
    {
      kind: 'object_array', key: 'items', label: 'Items', addLabel: 'Add item', itemNoun: 'item', maxItems: 40,
      itemFields: [
        { kind: 'string', key: 'title', label: 'Title', maxLength: TEXT_MAX.caption },
        { kind: 'string', key: 'description', label: 'Description', maxLength: TEXT_MAX.body, multiline: true },
        { kind: 'string', key: 'price', label: 'Price', maxLength: TEXT_MAX.caption },
      ],
    },
    { kind: 'color', key: 'tone', label: 'Tone', tokens: ['obsidian', 'ivory'], allowCustom: true },
    {
      kind: 'select', key: 'animation', label: 'Animation',
      options: [
        { value: 'none', label: 'None (static)' },
        { value: 'fade-in', label: 'Fade in on scroll' },
        { value: 'slide-up', label: 'Slide up on scroll' },
      ],
    },
  ],

  lx_reviews: [
    {
      kind: 'object_array', key: 'items', label: 'Reviews', addLabel: 'Add review', itemNoun: 'review', maxItems: 24,
      itemFields: [
        { kind: 'string', key: 'author', label: 'Author', maxLength: TEXT_MAX.caption },
        { kind: 'number', key: 'rating', label: 'Rating (0–5)', min: 0, max: 5, step: 0.5 },
        { kind: 'string', key: 'text', label: 'Review', maxLength: TEXT_MAX.body, multiline: true },
        { kind: 'string', key: 'role', label: 'Role / company', maxLength: TEXT_MAX.caption },
        { kind: 'media', key: 'avatar', label: 'Avatar (optional)', accept: 'image' },
      ],
    },
    {
      kind: 'select', key: 'columns', label: 'Columns', valueAsNumber: true,
      options: [
        { value: '1', label: '1' },
        { value: '2', label: '2' },
        { value: '3', label: '3' },
      ],
    },
    { kind: 'color', key: 'tone', label: 'Tone', tokens: ['obsidian', 'ivory'], allowCustom: true },
    {
      kind: 'select', key: 'animation', label: 'Animation',
      options: [
        { value: 'none', label: 'None (static)' },
        { value: 'fade-in', label: 'Fade in on scroll' },
        { value: 'slide-up', label: 'Slide up on scroll' },
      ],
    },
  ],

  lx_progress_tracker: [
    {
      kind: 'object_array', key: 'steps', label: 'Steps', addLabel: 'Add step', itemNoun: 'step', maxItems: 12,
      itemFields: [
        { kind: 'string', key: 'title', label: 'Title', maxLength: TEXT_MAX.caption },
        { kind: 'string', key: 'description', label: 'Description', maxLength: TEXT_MAX.body, multiline: true },
        {
          kind: 'select', key: 'state', label: 'State',
          options: [
            { value: 'done', label: 'Done' },
            { value: 'current', label: 'Current' },
            { value: 'upcoming', label: 'Upcoming' },
          ],
        },
      ],
    },
    {
      kind: 'select', key: 'orientation', label: 'Orientation',
      options: [
        { value: 'vertical', label: 'Vertical' },
        { value: 'horizontal', label: 'Horizontal' },
      ],
    },
    { kind: 'color', key: 'tone', label: 'Tone', tokens: ['obsidian', 'ivory'], allowCustom: true },
    {
      kind: 'select', key: 'animation', label: 'Animation',
      options: [
        { value: 'none', label: 'None (static)' },
        { value: 'fade-in', label: 'Fade in on scroll' },
        { value: 'slide-up', label: 'Slide up on scroll' },
      ],
    },
  ],

  lx_animated_headline: [
    { kind: 'string', key: 'prefix', label: 'Prefix (static)', maxLength: TEXT_MAX.title, placeholder: 'We build' },
    { kind: 'string_array', key: 'words', label: 'Rotating words', placeholder: 'Add a word, press Enter', maxItems: 8 },
    { kind: 'string', key: 'suffix', label: 'Suffix (static)', maxLength: TEXT_MAX.title, placeholder: 'that lasts' },
    {
      kind: 'select', key: 'effect', label: 'Effect',
      options: [
        { value: 'rotate', label: 'Rotate (slide up)' },
        { value: 'fade', label: 'Fade' },
        { value: 'type', label: 'Typewriter' },
      ],
    },
    {
      kind: 'select', key: 'level', label: 'Semantic level',
      options: [
        { value: 'h1', label: 'H1' }, { value: 'h2', label: 'H2' }, { value: 'h3', label: 'H3' },
        { value: 'h4', label: 'H4' }, { value: 'h5', label: 'H5' }, { value: 'h6', label: 'H6' },
      ],
    },
    {
      kind: 'select', key: 'size', label: 'Visual size',
      options: [
        { value: 'display-2xl', label: 'Display 2XL' },
        { value: 'display-xl', label: 'Display XL' },
        { value: 'display-lg', label: 'Display LG' },
        { value: 'display-md', label: 'Display MD' },
        { value: 'display-sm', label: 'Display SM' },
      ],
    },
    {
      kind: 'select', key: 'alignment', label: 'Alignment',
      options: [
        { value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' },
      ],
    },
    { kind: 'number', key: 'intervalMs', label: 'Word interval (ms)', min: 1000, max: 8000, step: 100 },
    { kind: 'color', key: 'tone', label: 'Tone', tokens: ['obsidian', 'ivory', 'champagne'], allowCustom: true },
    { kind: 'font_family', key: 'family', label: 'Font family' },
    { kind: 'font_weight', key: 'weight', label: 'Font weight', familyKey: 'family' },
  ],

  lx_countdown: [
    {
      kind: 'string', key: 'target', label: 'Target date & time',
      maxLength: 40, placeholder: '2026-12-31T23:59',
      help: 'ISO format — e.g. 2026-12-31T23:59 (year-month-day, then T, then hour:minute).',
    },
    { kind: 'boolean', key: 'showDays', label: 'Show days' },
    { kind: 'boolean', key: 'showHours', label: 'Show hours' },
    { kind: 'boolean', key: 'showMinutes', label: 'Show minutes' },
    { kind: 'boolean', key: 'showSeconds', label: 'Show seconds' },
    { kind: 'string', key: 'expiredText', label: 'Expired message', maxLength: TEXT_MAX.caption, placeholder: 'This offer has ended.' },
    { kind: 'color', key: 'tone', label: 'Tone', tokens: ['obsidian', 'ivory'], allowCustom: true },
    {
      kind: 'select', key: 'animation', label: 'Animation',
      options: [
        { value: 'none', label: 'None (static)' },
        { value: 'fade-in', label: 'Fade in on scroll' },
      ],
    },
  ],

  lx_flip_box: [
    { kind: 'icon', key: 'frontIcon', label: 'Front icon (optional)' },
    { kind: 'media', key: 'frontImage', label: 'Front background image (optional)', accept: 'image' },
    { kind: 'string', key: 'frontHeadline', label: 'Front headline', maxLength: TEXT_MAX.title },
    { kind: 'string', key: 'frontBody', label: 'Front body', maxLength: TEXT_MAX.body, multiline: true },
    { kind: 'string', key: 'backHeadline', label: 'Back headline', maxLength: TEXT_MAX.title },
    { kind: 'string', key: 'backBody', label: 'Back body', maxLength: TEXT_MAX.body, multiline: true },
    { kind: 'string', key: 'backCtaLabel', label: 'Back button label', maxLength: TEXT_MAX.ctaText },
    { kind: 'string', key: 'backCtaHref', label: 'Back button link', maxLength: TEXT_MAX.url, placeholder: '/contact' },
    {
      kind: 'select', key: 'trigger', label: 'Flip on',
      options: [
        { value: 'hover', label: 'Hover / focus' },
        { value: 'tap', label: 'Tap / click' },
      ],
    },
    {
      kind: 'select', key: 'height', label: 'Height',
      options: [
        { value: 'sm', label: 'Small' }, { value: 'md', label: 'Medium' }, { value: 'lg', label: 'Large' },
      ],
    },
    { kind: 'color', key: 'tone', label: 'Tone', tokens: ['obsidian', 'ivory'], allowCustom: false },
    {
      kind: 'select', key: 'animation', label: 'Animation',
      options: [
        { value: 'none', label: 'None (static)' },
        { value: 'fade-in', label: 'Fade in on scroll' },
      ],
    },
  ],

  lx_hotspot: [
    { kind: 'media', key: 'image', label: 'Image', accept: 'image' },
    {
      kind: 'object_array', key: 'markers', label: 'Markers', addLabel: 'Add marker', itemNoun: 'marker', maxItems: 12,
      itemFields: [
        { kind: 'number', key: 'x', label: 'X position (%)', min: 0, max: 100, step: 1 },
        { kind: 'number', key: 'y', label: 'Y position (%)', min: 0, max: 100, step: 1 },
        { kind: 'string', key: 'label', label: 'Label', maxLength: TEXT_MAX.caption },
        { kind: 'string', key: 'body', label: 'Detail', maxLength: TEXT_MAX.body, multiline: true },
      ],
    },
    {
      kind: 'select', key: 'ratio', label: 'Aspect ratio',
      options: [
        { value: '21:9', label: 'Cinematic 21:9' },
        { value: '16:9', label: 'Widescreen 16:9' },
        { value: '4:3', label: 'Classic 4:3' },
        { value: '1:1', label: 'Square 1:1' },
        { value: 'auto', label: 'Original' },
      ],
    },
    { kind: 'color', key: 'tone', label: 'Tone', tokens: ['obsidian', 'ivory'], allowCustom: false },
    {
      kind: 'select', key: 'animation', label: 'Animation',
      options: [
        { value: 'none', label: 'None (static)' },
        { value: 'fade-in', label: 'Fade in on scroll' },
      ],
    },
  ],

  lx_progress: [
    {
      kind: 'object_array', key: 'items', label: 'Bars', addLabel: 'Add bar', itemNoun: 'bar', maxItems: 20,
      itemFields: [
        { kind: 'string', key: 'label', label: 'Label', maxLength: TEXT_MAX.caption },
        { kind: 'number', key: 'value', label: 'Value (%)', min: 0, max: 100, step: 1 },
      ],
    },
    { kind: 'boolean', key: 'showValue', label: 'Show percentage' },
    { kind: 'color', key: 'tone', label: 'Tone', tokens: ['obsidian', 'ivory'], allowCustom: true },
  ],

  lx_menu_anchor: [
    {
      kind: 'string', key: 'anchorId', label: 'Anchor id', maxLength: 64,
      placeholder: 'pricing', pattern: HTML_ID_PATTERN, patternError: HTML_ID_HELPER,
      help: 'Link to this from a nav item or button with "#" + your id.',
    },
  ],

  lx_toc: [
    { kind: 'string', key: 'title', label: 'Title (optional)', maxLength: TEXT_MAX.caption, placeholder: 'On this page' },
    {
      kind: 'object_array', key: 'items', label: 'Links', addLabel: 'Add link', itemNoun: 'link', maxItems: 30,
      itemFields: [
        { kind: 'string', key: 'label', label: 'Label', maxLength: TEXT_MAX.caption },
        {
          kind: 'string', key: 'anchor', label: 'Anchor id', maxLength: 64,
          placeholder: 'pricing', pattern: HTML_ID_PATTERN, patternError: HTML_ID_HELPER,
          help: 'The HTML id of the target block (set in its Advanced tab) or a Menu anchor.',
        },
      ],
    },
    { kind: 'color', key: 'tone', label: 'Tone', tokens: ['obsidian', 'ivory'], allowCustom: true },
    {
      kind: 'select', key: 'animation', label: 'Animation',
      options: [
        { value: 'none', label: 'None (static)' },
        { value: 'fade-in', label: 'Fade in on scroll' },
        { value: 'slide-up', label: 'Slide up on scroll' },
      ],
    },
  ],

  lx_share: [
    { kind: 'string', key: 'label', label: 'Label (optional)', maxLength: TEXT_MAX.caption, placeholder: 'Share' },
    { kind: 'boolean', key: 'shareX', label: 'X (Twitter)' },
    { kind: 'boolean', key: 'shareLinkedin', label: 'LinkedIn' },
    { kind: 'boolean', key: 'shareFacebook', label: 'Facebook' },
    { kind: 'boolean', key: 'shareEmail', label: 'Email' },
    { kind: 'boolean', key: 'shareCopy', label: 'Copy link' },
    {
      kind: 'select', key: 'size', label: 'Size',
      options: [
        { value: 'sm', label: 'Small' }, { value: 'md', label: 'Medium' }, { value: 'lg', label: 'Large' },
      ],
    },
    {
      kind: 'select', key: 'alignment', label: 'Alignment',
      options: [
        { value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' },
      ],
    },
    { kind: 'color', key: 'tone', label: 'Tone', tokens: ['obsidian', 'ivory', 'warm-stone'], allowCustom: true },
    {
      kind: 'select', key: 'animation', label: 'Animation',
      options: [
        { value: 'none', label: 'None (static)' },
        { value: 'fade-in', label: 'Fade in on scroll' },
      ],
    },
  ],

  lx_posts: [
    { kind: 'string', key: 'heading', label: 'Heading (optional)', maxLength: TEXT_MAX.title, placeholder: 'From the journal' },
    { kind: 'number', key: 'limit', label: 'Number of posts', min: 1, max: 12, step: 1 },
    {
      kind: 'select', key: 'layout', label: 'Layout',
      options: [
        { value: 'grid', label: 'Grid' },
        { value: 'list', label: 'List' },
      ],
    },
    {
      kind: 'select', key: 'columns', label: 'Columns', valueAsNumber: true,
      options: [
        { value: '2', label: '2' },
        { value: '3', label: '3' },
      ],
    },
    { kind: 'boolean', key: 'showExcerpt', label: 'Show excerpt' },
    { kind: 'boolean', key: 'showDate', label: 'Show date' },
    {
      kind: 'select', key: 'animation', label: 'Animation',
      options: [
        { value: 'none', label: 'None (static)' },
        { value: 'fade-in', label: 'Fade in on scroll' },
        { value: 'slide-up', label: 'Slide up on scroll' },
      ],
    },
  ],

  lx_embed: [
    {
      kind: 'string', key: 'embedUrl', label: 'Embed URL', maxLength: TEXT_MAX.url,
      placeholder: 'https://www.youtube.com/watch?v=…',
      help: 'Paste a share URL from YouTube, Vimeo, Spotify, CodePen, SoundCloud, or CodeSandbox.',
    },
    {
      kind: 'select', key: 'ratio', label: 'Aspect ratio',
      options: [
        { value: '21:9', label: 'Cinematic 21:9' },
        { value: '16:9', label: 'Widescreen 16:9' },
        { value: '4:3', label: 'Classic 4:3' },
        { value: '1:1', label: 'Square 1:1' },
        { value: 'auto', label: 'Tall (audio / embeds)' },
      ],
    },
    { kind: 'string', key: 'title', label: 'Accessible title', maxLength: TEXT_MAX.caption, placeholder: 'What this embed shows' },
  ],

  lx_code: [
    { kind: 'string', key: 'code', label: 'Code', maxLength: 8000, multiline: true, placeholder: 'Paste your code here' },
    {
      kind: 'select', key: 'language', label: 'Language',
      options: [
        { value: 'text', label: 'Plain text' },
        { value: 'ts', label: 'TypeScript' }, { value: 'tsx', label: 'TSX' },
        { value: 'js', label: 'JavaScript' }, { value: 'jsx', label: 'JSX' },
        { value: 'json', label: 'JSON' }, { value: 'html', label: 'HTML' },
        { value: 'css', label: 'CSS' }, { value: 'bash', label: 'Bash / shell' },
        { value: 'python', label: 'Python' }, { value: 'go', label: 'Go' },
        { value: 'rust', label: 'Rust' }, { value: 'sql', label: 'SQL' },
        { value: 'yaml', label: 'YAML' }, { value: 'markdown', label: 'Markdown' },
        { value: 'php', label: 'PHP' }, { value: 'java', label: 'Java' },
        { value: 'ruby', label: 'Ruby' }, { value: 'c', label: 'C' },
        { value: 'cpp', label: 'C++' }, { value: 'diff', label: 'Diff' },
      ],
    },
    { kind: 'boolean', key: 'showLineNumbers', label: 'Show line numbers' },
    { kind: 'boolean', key: 'copyable', label: 'Show copy button', help: 'One-click copy of the code in the block header.' },
    { kind: 'string', key: 'filename', label: 'Filename (optional)', maxLength: TEXT_MAX.caption, placeholder: 'example.ts' },
  ],

  lx_marquee: [
    {
      kind: 'select', key: 'mode', label: 'Mode',
      options: [
        { value: 'text', label: 'Scrolling text' },
        { value: 'logos', label: 'Logo strip' },
      ],
    },
    { kind: 'string', key: 'text', label: 'Text', maxLength: TEXT_MAX.title, placeholder: 'Trusted by teams everywhere' },
    { kind: 'media_array', key: 'logos', label: 'Logos', help: 'Used when Mode is Logo strip.' },
    {
      kind: 'select', key: 'speed', label: 'Speed',
      options: [
        { value: 'slow', label: 'Slow' }, { value: 'medium', label: 'Medium' }, { value: 'fast', label: 'Fast' },
      ],
    },
    {
      kind: 'select', key: 'direction', label: 'Direction',
      options: [
        { value: 'left', label: 'Left' }, { value: 'right', label: 'Right' },
      ],
    },
    { kind: 'color', key: 'tone', label: 'Tone', tokens: ['obsidian', 'ivory'], allowCustom: true },
  ],

  lx_before_after: [
    { kind: 'media', key: 'before', label: 'Before image', accept: 'image' },
    { kind: 'media', key: 'after', label: 'After image', accept: 'image' },
    { kind: 'string', key: 'beforeLabel', label: 'Before label', maxLength: TEXT_MAX.caption, placeholder: 'Before' },
    { kind: 'string', key: 'afterLabel', label: 'After label', maxLength: TEXT_MAX.caption, placeholder: 'After' },
    {
      kind: 'select', key: 'ratio', label: 'Aspect ratio',
      options: [
        { value: '16:9', label: 'Widescreen 16:9' },
        { value: '4:3', label: 'Classic 4:3' },
        { value: '3:2', label: 'Photo 3:2' },
        { value: '1:1', label: 'Square 1:1' },
      ],
    },
    { kind: 'color', key: 'tone', label: 'Tone', tokens: ['obsidian', 'ivory'], allowCustom: false },
  ],

  lx_icon_list: [
    {
      kind: 'object_array', key: 'items', label: 'Items', addLabel: 'Add item', itemNoun: 'item', maxItems: 12,
      itemFields: [
        { kind: 'icon', key: 'icon', label: 'Icon' },
        { kind: 'string', key: 'headline', label: 'Headline', maxLength: TEXT_MAX.title },
        { kind: 'string', key: 'body', label: 'Body (optional)', maxLength: TEXT_MAX.body, multiline: true },
        { kind: 'string', key: 'code', label: 'Command / code (optional)', maxLength: 400, placeholder: 'curl -fsSL https://… | sudo bash', help: 'Card mode only — shows a copyable mini terminal inside the card.' },
      ],
    },
    { kind: 'boolean', key: 'card', label: 'Card surface', help: 'Render each item on a filled rounded card (use with the Grid layout for a feature-card grid).' },
    {
      kind: 'select', key: 'variant', label: 'Layout',
      options: [
        { value: 'vertical', label: 'Vertical (icon above text)' },
        { value: 'grid', label: 'Grid (icon-top cards)' },
        { value: 'row', label: 'Row (icon beside text)' },
        { value: 'checklist', label: 'Checklist (small icon + line)' },
      ],
      help: 'Checklist = compact ✓-style feature list; pair with a green Icon colour.',
    },
    {
      kind: 'select', key: 'columns', label: 'Columns', valueAsNumber: true,
      options: [{ value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }],
    },
    {
      kind: 'select', key: 'alignment', label: 'Alignment',
      options: [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }],
    },
    { kind: 'color', key: 'tone', label: 'Text tone', tokens: ['obsidian', 'ivory', 'champagne'], allowCustom: true },
    {
      kind: 'color', key: 'iconColor', label: 'Icon colour (optional)',
      tokens: ['champagne', 'ivory'], allowCustom: true,
      help: 'Tints the icons (e.g. a green check). When set, the champagne glow is dropped. Leave empty for the signature glow.',
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

  lx_comparison_table: [
    { kind: 'string_array', key: 'columns', label: 'Plan columns (2–4)', placeholder: 'Add a plan, press Enter', maxItems: 4 },
    {
      kind: 'object_array', key: 'rows', label: 'Rows', addLabel: 'Add row', itemNoun: 'row', maxItems: 40,
      itemFields: [
        { kind: 'string', key: 'feature', label: 'Feature', maxLength: TEXT_MAX.caption },
        { kind: 'string', key: 'c1', label: 'Column 1', maxLength: TEXT_MAX.caption, placeholder: 'yes / no / text' },
        { kind: 'string', key: 'c2', label: 'Column 2', maxLength: TEXT_MAX.caption, placeholder: 'yes / no / text' },
        { kind: 'string', key: 'c3', label: 'Column 3', maxLength: TEXT_MAX.caption, placeholder: 'yes / no / text' },
        { kind: 'string', key: 'c4', label: 'Column 4', maxLength: TEXT_MAX.caption, placeholder: 'yes / no / text' },
      ],
    },
    { kind: 'number', key: 'highlightColumn', label: 'Highlight column (0-based, optional)', min: 0, max: 3, step: 1 },
    { kind: 'color', key: 'tone', label: 'Tone', tokens: ['obsidian', 'ivory'], allowCustom: true },
    {
      kind: 'color', key: 'accent', label: 'Accent colour',
      tokens: ['champagne', 'ivory'], allowCustom: true,
      help: 'Colours the ✓ checks + the highlighted column (header text + tint band). Set to your brand accent (e.g. a green) to match.',
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

  lx_timeline: [
    {
      kind: 'object_array', key: 'events', label: 'Events', addLabel: 'Add event', itemNoun: 'event', maxItems: 24,
      itemFields: [
        { kind: 'string', key: 'date', label: 'Date', maxLength: TEXT_MAX.caption, placeholder: '2024' },
        { kind: 'string', key: 'title', label: 'Title', maxLength: TEXT_MAX.title },
        { kind: 'string', key: 'body', label: 'Description', maxLength: TEXT_MAX.body, multiline: true },
        { kind: 'media', key: 'image', label: 'Image (optional)', accept: 'image' },
      ],
    },
    { kind: 'color', key: 'tone', label: 'Tone', tokens: ['obsidian', 'ivory'], allowCustom: true },
    {
      kind: 'select', key: 'animation', label: 'Animation',
      options: [
        { value: 'none', label: 'None (static)' },
        { value: 'fade-in', label: 'Fade in on scroll' },
        { value: 'slide-up', label: 'Slide up on scroll' },
      ],
    },
  ],

  lx_form: [
    { kind: 'string', key: 'heading', label: 'Heading', maxLength: TEXT_MAX.title, placeholder: 'Get in touch' },
    { kind: 'string', key: 'intro', label: 'Intro', maxLength: TEXT_MAX.body, multiline: true },
    {
      kind: 'object_array', key: 'fields', label: 'Fields', addLabel: 'Add field', itemNoun: 'field', maxItems: 20,
      itemFields: [
        { kind: 'string', key: 'name', label: 'Field name (slug)', maxLength: 40, placeholder: 'email', pattern: /^[a-z][a-z0-9_]{0,39}$/, patternError: 'lowercase letters, digits, underscore — start with a letter.' },
        { kind: 'string', key: 'label', label: 'Label', maxLength: TEXT_MAX.caption },
        {
          kind: 'select', key: 'type', label: 'Type',
          options: [
            { value: 'text', label: 'Text' }, { value: 'email', label: 'Email' }, { value: 'tel', label: 'Phone' },
            { value: 'textarea', label: 'Long text' }, { value: 'select', label: 'Dropdown' }, { value: 'checkbox', label: 'Checkbox' },
          ],
        },
        { kind: 'boolean', key: 'required', label: 'Required' },
        { kind: 'string', key: 'placeholder', label: 'Placeholder', maxLength: 120 },
        { kind: 'string_array', key: 'options', label: 'Dropdown options', placeholder: 'Add an option, press Enter', maxItems: 20 },
        {
          kind: 'select', key: 'role', label: 'Map to lead field',
          options: [
            { value: 'none', label: 'None' }, { value: 'name', label: 'Lead name' },
            { value: 'email', label: 'Lead email' }, { value: 'phone', label: 'Lead phone' },
          ],
          help: 'Maps this field to the lead row’s name/email/phone column.',
        },
      ],
    },
    { kind: 'string', key: 'submitLabel', label: 'Submit button label', maxLength: TEXT_MAX.ctaText },
    { kind: 'string', key: 'successHeadline', label: 'Success headline', maxLength: TEXT_MAX.title },
    { kind: 'string', key: 'successBody', label: 'Success message', maxLength: TEXT_MAX.body, multiline: true },
    { kind: 'color', key: 'tone', label: 'Tone', tokens: ['obsidian', 'ivory'], allowCustom: true },
  ],

  lx_icon: [
    { kind: 'icon', key: 'icon', label: 'Icon' },
    { kind: 'number', key: 'size', label: 'Size (px)', min: 8, max: 240, step: 1 },
    { kind: 'color', key: 'color', label: 'Colour', tokens: ['champagne', 'obsidian', 'ivory', 'warm-stone'], allowCustom: true },
    {
      kind: 'select', key: 'alignment', label: 'Alignment',
      options: [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }],
    },
    { kind: 'number', key: 'rotate', label: 'Rotate (deg)', min: 0, max: 360, step: 1 },
    {
      kind: 'select', key: 'shape', label: 'Background shape',
      options: [{ value: 'none', label: 'None' }, { value: 'circle', label: 'Circle' }, { value: 'square', label: 'Rounded square' }],
      help: 'Wrap the icon in a tinted chip.',
    },
    { kind: 'color', key: 'shapeColor', label: 'Chip colour (optional)', tokens: ['champagne', 'obsidian', 'ivory'], allowCustom: true, help: 'Default is a soft tint of the icon colour.' },
    { kind: 'link', key: 'link', label: 'Link (optional)', help: 'Make the icon a link. /relative, https://, mailto:, tel:.' },
    {
      kind: 'select', key: 'animation', label: 'Animation',
      options: [{ value: 'none', label: 'None' }, { value: 'fade-in', label: 'Fade in on scroll' }, { value: 'slide-up', label: 'Slide up on scroll' }],
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
      kind: 'color', key: 'fillColor', label: 'Fill colour (optional)',
      tokens: ['champagne', 'ivory', 'obsidian'], allowCustom: true,
      help: 'Solid button background — overrides the variant fill (e.g. #ffffff for a white button; the primary variant already has dark label text).',
    },
    { kind: 'number', key: 'radius', label: 'Corner radius (px)', min: 0, max: 64, step: 1, help: 'Leave blank for a full pill. 0 = square; e.g. 14 = rounded rectangle.' },
    { kind: 'number', key: 'radiusTopLeft', label: '↳ Top-left radius (px)', min: 0, max: 64, step: 1, help: 'Per-corner override of the radius above.' },
    { kind: 'number', key: 'radiusTopRight', label: '↳ Top-right radius (px)', min: 0, max: 64, step: 1 },
    { kind: 'number', key: 'radiusBottomRight', label: '↳ Bottom-right radius (px)', min: 0, max: 64, step: 1 },
    { kind: 'number', key: 'radiusBottomLeft', label: '↳ Bottom-left radius (px)', min: 0, max: 64, step: 1 },
    { kind: 'color', key: 'hoverFillColor', label: 'Hover fill colour', tokens: ['champagne', 'obsidian', 'ivory'], allowCustom: true, help: 'Button background on hover.' },
    { kind: 'color', key: 'hoverTextColor', label: 'Hover text colour', tokens: ['champagne', 'obsidian', 'ivory'], allowCustom: true },
    { kind: 'number', key: 'hoverScale', label: 'Hover scale (%)', min: 80, max: 140, step: 1, help: 'e.g. 105 grows the button slightly on hover.' },
    { kind: 'number', key: 'transitionMs', label: 'Transition (ms)', min: 50, max: 1200, step: 10, help: 'Hover transition speed.' },
    { kind: 'gradient', key: 'backgroundGradient', label: 'Gradient fill', help: 'Paints the button with a gradient background (overrides the variant fill + fill colour). Not used for the link-arrow variant.' },
    { kind: 'gradient', key: 'textGradient', label: 'Gradient label', help: 'Gradient on the label text — applies when no fill gradient is set.' },
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
    {
      kind: 'select', key: 'objectPosition', label: 'Crop focus',
      options: [
        { value: 'center', label: 'Center' }, { value: 'top', label: 'Top' }, { value: 'bottom', label: 'Bottom' },
        { value: 'left', label: 'Left' }, { value: 'right', label: 'Right' },
        { value: 'top left', label: 'Top left' }, { value: 'top right', label: 'Top right' },
        { value: 'bottom left', label: 'Bottom left' }, { value: 'bottom right', label: 'Bottom right' },
      ],
      help: 'Which part stays in frame when the image is cropped (Cover fit).',
    },
    { kind: 'boolean', key: 'hoverZoom', label: 'Zoom on hover', help: 'The image scales up slightly on hover (clipped to the frame).' },
    {
      kind: 'select', key: 'kenBurns', label: 'Ken Burns motion',
      options: [
        { value: 'none', label: 'None (static)' },
        { value: 'zoom-in', label: 'Slow zoom in' },
        { value: 'zoom-out', label: 'Slow zoom out' },
        { value: 'pan-left', label: 'Pan left' },
        { value: 'pan-right', label: 'Pan right' },
        { value: 'zoom-pan', label: 'Zoom + pan' },
      ],
      help: 'A slow continuous camera drift on the image (independent of hover). Respects reduced-motion.',
    },
    { kind: 'link', key: 'link', label: 'Link the image to… (optional)', help: 'Makes the whole image a link. /relative, https://, mailto:, tel:.' },
    { kind: 'boolean', key: 'lightbox', label: 'Open in lightbox on click', help: 'Click enlarges the image in a full-screen overlay. Ignored when a link is set.' },
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

  lx_divider: [
    {
      kind: 'select', key: 'style', label: 'Style',
      options: [
        { value: 'solid', label: 'Solid' }, { value: 'dashed', label: 'Dashed' },
        { value: 'dotted', label: 'Dotted' }, { value: 'fleuron', label: 'Fleuron (diamond)' },
      ],
    },
    {
      kind: 'select', key: 'width', label: 'Width',
      options: [
        { value: 'full', label: 'Full' }, { value: 'half', label: 'Half' },
        { value: 'quarter', label: 'Quarter' }, { value: 'short', label: 'Short (64px)' },
      ],
    },
    { kind: 'number', key: 'widthPercent', label: 'Exact width (%)', min: 5, max: 100, step: 1, help: 'Overrides the Width preset.' },
    {
      kind: 'select', key: 'thickness', label: 'Thickness',
      options: [{ value: 'hairline', label: 'Hairline' }, { value: '1px', label: '1px' }, { value: '2px', label: '2px' }],
    },
    { kind: 'number', key: 'thicknessPx', label: 'Exact thickness (px)', min: 1, max: 16, step: 1, help: 'Overrides the Thickness preset.' },
    { kind: 'color', key: 'tone', label: 'Colour', tokens: ['champagne', 'warm-stone', 'obsidian', 'ivory'], allowCustom: true },
    {
      kind: 'select', key: 'alignment', label: 'Alignment',
      options: [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }],
    },
    { kind: 'string', key: 'label', label: 'Centre label (optional)', maxLength: 48, placeholder: 'e.g. OR', help: 'Text centred on the rule. Leave empty for a plain divider.' },
    { kind: 'icon', key: 'labelIcon', label: 'Centre icon (optional)', help: 'An icon centred on the rule (takes precedence over the label).' },
    {
      kind: 'select', key: 'animation', label: 'Animation',
      options: [{ value: 'none', label: 'None' }, { value: 'fade-in', label: 'Fade in on scroll' }],
    },
  ],

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

  // Style fields for the icon box. Content (headline, body, link href)
  // is inline-editable on the page; these are the style knobs that have
  // no inline affordance, so the drawer is the only way to reach them.
  lx_icon_box: [
    {
      kind: 'icon',
      key: 'icon',
      label: 'Icon',
      help: 'Search 1,950+ Lucide icons — the pick renders with a champagne glow halo above the headline.',
    },
    {
      kind: 'select', key: 'accent', label: 'Accent style',
      options: [
        { value: 'champagne-outline', label: 'Champagne outline — section-aware (editorial default)' },
        { value: 'champagne-fill', label: 'Champagne fill — radial glow on a dark ground' },
        { value: 'cream-tint', label: 'Cream tint — soft surface on dark sections' },
      ],
      help: 'Champagne outline adapts to the section: a gold hairline card on dark sections, a quiet ivory fill on light ones.',
    },
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
      help: 'Obsidian for ivory/bone sections; ivory for obsidian/champagne sections.',
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
      kind: 'select', key: 'orientation', label: 'Number & label layout',
      options: [
        { value: 'vertical', label: 'Stacked — number above label (current)' },
        { value: 'horizontal', label: 'Inline — number beside label' },
      ],
      help: 'Stacked is the current look. Inline puts the number and label on one line — handy for a compact bed / bath / size facts row.',
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

  // ════════════════════════════════════════════════════════════════
  // PROJECT lead-form blocks — the only project-specific blocks. Their
  // intro copy is composed as separate primitive blocks by the
  // tree-builder; the form block itself carries optional heading/body
  // for the operator who wants the form's own copy. Everything else on
  // a project page is primitive blocks, edited like any other block.
  // ════════════════════════════════════════════════════════════════
  lx_inquiry_form: [
    { kind: 'string', key: 'heading', label: 'Heading', maxLength: 220, placeholder: 'Reach out about this project' },
    { kind: 'richtext', key: 'body_richtext', label: 'Intro copy', maxLength: 2000 },
    {
      kind: 'select', key: 'background', label: 'Section background (theme)',
      options: [
        { value: 'cream', label: 'Cream (current)' },
        { value: 'ivory', label: 'Ivory' },
        { value: 'bone', label: 'Bone' },
        { value: 'champagne', label: 'Champagne — gold' },
        { value: 'obsidian', label: 'Obsidian — dark' },
      ],
      help: 'The whole section’s colour, from your theme palette — headings, text, and the form adapt to stay legible. Obsidian is dark.',
    },
    {
      kind: 'select', key: 'card_surface', label: 'Form card background',
      options: [
        { value: 'panel', label: 'Card panel (current)' },
        { value: 'transparent', label: 'None — sits on the section' },
      ],
      help: 'Keep the form on a raised card (tinted to match the section theme), or let it sit directly on the section to match the brochure form.',
    },
    {
      kind: 'select', key: 'field_style', label: 'Input style',
      options: [
        { value: 'bordered', label: 'Bordered (current)' },
        { value: 'filled', label: 'Filled' },
      ],
      help: 'How the form inputs look. Match this to the brochure form for a consistent pair.',
    },
  ],

  lx_brochure_form: [
    {
      kind: 'richtext', key: 'gate_message_richtext', label: 'Gate message', maxLength: 2000,
      help: 'Shown beside the brochure request form. The PDF itself is set under Projects → Brochure.',
    },
    {
      kind: 'select', key: 'background', label: 'Section background (theme)',
      options: [
        { value: 'cream', label: 'Cream (current)' },
        { value: 'ivory', label: 'Ivory' },
        { value: 'bone', label: 'Bone' },
        { value: 'champagne', label: 'Champagne — gold' },
        { value: 'obsidian', label: 'Obsidian — dark' },
      ],
      help: 'The whole section’s colour, from your theme palette — headings, text, and the form adapt to stay legible. Obsidian is dark.',
    },
    {
      kind: 'select', key: 'card_surface', label: 'Form card background',
      options: [
        { value: 'transparent', label: 'None — sits on the section (current)' },
        { value: 'panel', label: 'Card panel — matches the inquiry form' },
      ],
      help: 'Wrap the brochure form in a raised card (tinted to match the section theme), or let it sit directly on the section.',
    },
    {
      kind: 'select', key: 'field_style', label: 'Input style',
      options: [
        { value: 'bordered', label: 'Bordered (current)' },
        { value: 'filled', label: 'Filled' },
      ],
      help: 'How the form inputs look. Match this to the inquiry form for a consistent pair.',
    },
  ],

  lx_gallery: [
    {
      kind: 'select', key: 'columns', label: 'Columns (desktop)',
      valueAsNumber: true,
      options: [
        { value: '2', label: '2 columns' },
        { value: '3', label: '3 columns (current)' },
        { value: '4', label: '4 columns' },
      ],
      help: 'How many columns the gallery uses on wide screens. 3 is the current layout.',
    },
    {
      kind: 'select', key: 'ratio', label: 'Image shape',
      options: [
        { value: '1:1', label: 'Square (1:1) (current)' },
        { value: '4:5', label: 'Portrait (4:5)' },
        { value: '4:3', label: 'Landscape (4:3)' },
        { value: '3:2', label: 'Wide (3:2)' },
      ],
      help: 'The aspect ratio each image is cropped to.',
    },
    {
      kind: 'select', key: 'animation', label: 'Entrance animation',
      options: [
        { value: 'none', label: 'None (current)' },
        { value: 'fade-in', label: 'Fade in' },
        { value: 'slide-up', label: 'Slide up' },
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
    const decoration =
      type === 'section' || type === 'column' ? CONTAINER_DECORATION_SHAPES : []
    const spacing =
      type === 'section' || type === 'column' ? CONTAINER_SPACING_SHAPES : []
    const dividers = type === 'section' ? SECTION_SHAPE_DIVIDER_SHAPES : []
    const motion = type !== 'section' && type !== 'column' ? WIDGET_MOTION_SHAPES : []
    out[type] = [...shapes, ...decoration, ...spacing, ...dividers, ...motion, ...identity]
  }
  return out
})()
