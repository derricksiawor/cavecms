'use client'

import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Search,
  EyeOff,
  Compass,
  Share2,
  Code2,
  Ban,
} from 'lucide-react'
import clsx from 'clsx'
import { Input } from '@/components/ui/Input'
import { Switch } from '@/components/inline-edit/Switch'
import { Accordion } from '@/components/inline-edit/Accordion'
import { TagInput } from '@/components/inline-edit/TagInput'
import {
  runAnalysis,
  type RunAnalysisResult,
} from '@/lib/seo/analysis'
import type {
  ContentNode,
  ImageNode,
  LinkNode,
} from '@/lib/seo/analysis/types'
import {
  type PanelSeoMeta,
  normalizeSeoMeta,
} from '@/lib/cms/seoEditorFields'
import { AnalysisReadout } from '@/components/seo/AnalysisReadout'
import { SchemaPicker } from '@/components/seo/SchemaPicker'

export type { PanelSeoMeta }

// ─────────────────────────────────────────────────────────────────────
// PageSeoPanel — the reusable per-entity SEO analysis + advanced panel.
//
// Shared across all three CaveCMS content editors (pages / posts /
// projects). It is fully CONTROLLED: the editor owns every value + setter
// and threads them in, so the panel plugs into each editor's existing
// dirty → patch → version save flow without owning persistence. The only
// thing it owns is the LIVE analysis (debounced runAnalysis over the
// editor-supplied extractor output) and the score readout.
//
// Brand: copper / cream / Playfair, lucide icons, visual pickers (#0.59),
// no emojis, market-friendly copy. Mirrors the SeoCard / SettingsForm
// surface so it reads as the same admin the operator already knows.
// ─────────────────────────────────────────────────────────────────────

/** The structured content the analysis engine scores — exactly what the
 *  editor's extractor (extractFromBlocks / extractFromMarkdown / a
 *  minimal hand-built set) returns. */
export interface AnalysisContent {
  blocks: ContentNode[]
  links: LinkNode[]
  images: ImageNode[]
}

export interface PageSeoPanelProps {
  /** The entity's intrinsic title (page/post/project name) — the
   *  fallback when no SEO title override is set. */
  entityTitle: string
  /** SEO title override (what renders in <title>). */
  seoTitle: string
  /** SEO description override (the search snippet). */
  seoDescription: string
  /** Slug (last path segment) — drives keyphrase-in-slug. */
  slug: string
  /** Full public URL for the SERP preview + keyphrase-in-url. */
  url?: string

  // ── Controlled SEO-editor fields (migration 0032) ──
  focusKeyphrase: string
  onFocusKeyphraseChange: (v: string) => void
  robotsNoindex: boolean
  onRobotsNoindexChange: (v: boolean) => void
  robotsNofollow: boolean
  onRobotsNofollowChange: (v: boolean) => void
  canonicalUrl: string
  onCanonicalUrlChange: (v: string) => void
  cornerstone: boolean
  onCornerstoneChange: (v: boolean) => void
  seoMeta: PanelSeoMeta
  onSeoMetaChange: (next: PanelSeoMeta) => void

  /** Supplies the latest extractor output for analysis. Called ONLY at
   *  recompute time (inside the debounced timer) so the editor reads its
   *  current content state (block list / markdown / sections) lazily —
   *  the full extractor never runs on every parent render. */
  getAnalysisContent: () => AnalysisContent

  /** A CHEAP fingerprint of the scored body the editor already has on
   *  hand — e.g. `bodyMd.length` (posts), `blockList.length` + a light
   *  hash (pages), the sections-version sig (projects). Changing it
   *  re-arms the debounce. Avoids re-running the full `getAnalysisContent`
   *  extractor on every render just to detect an edit (#2 perf). When
   *  omitted, the panel falls back to extracting once for the signature. */
  contentSignal?: string | number

  /** Fires (debounced) whenever the analysis recomputes, so the editor
   *  can cache the latest scores and ship them on the next save. */
  onScores?: (seo: number, readability: number) => void

  /** Disables every control (viewer role). Analysis still renders. */
  disabled?: boolean

  /** Locale tag for the rule pack. Defaults to 'en'. */
  locale?: string
}

export function PageSeoPanel(props: PageSeoPanelProps) {
  const {
    entityTitle,
    seoTitle,
    seoDescription,
    slug,
    url,
    focusKeyphrase,
    onFocusKeyphraseChange,
    robotsNoindex,
    onRobotsNoindexChange,
    robotsNofollow,
    onRobotsNofollowChange,
    canonicalUrl,
    onCanonicalUrlChange,
    cornerstone,
    onCornerstoneChange,
    seoMeta,
    onSeoMetaChange,
    getAnalysisContent,
    contentSignal,
    onScores,
    disabled = false,
    locale = 'en',
  } = props

  // The panel owns a NORMALIZED view of the override bag so its dirty
  // contract with the editor is symmetric: writing a normalized bag
  // upward means the editor's pristine (also produced by the normalized
  // parser) compares key-for-key. Wraps onSeoMetaChange so every clear /
  // edit path drops "no override" keys in ONE place (#3).
  const emitSeoMeta = (next: PanelSeoMeta) => onSeoMetaChange(normalizeSeoMeta(next))

  // Resolved values that feed both the analysis and the SERP preview.
  const resolvedTitle = (seoTitle || entityTitle || '').trim()
  const resolvedDescription = seoDescription.trim()
  const extraKeyphrases = seoMeta.extraKeyphrases ?? []

  // ── Live analysis (debounced) ──
  // We recompute ~400ms after the latest change to any analysis input.
  // The extractor output is pulled lazily via getAnalysisContent() at
  // recompute time so the editor's current content is always scored.
  const [result, setResult] = useState<RunAnalysisResult | null>(null)
  const [pending, setPending] = useState(false)

  // Keep the freshest callbacks in refs so the debounce effect doesn't
  // re-subscribe (and reset its timer) on every parent render.
  const getContentRef = useRef(getAnalysisContent)
  const onScoresRef = useRef(onScores)
  useEffect(() => {
    getContentRef.current = getAnalysisContent
    onScoresRef.current = onScores
  })

  // A cheap signature of the content body so the debounce only fires
  // when the SCORED inputs actually change (not on unrelated re-renders).
  // We use the editor-supplied `contentSignal` (e.g. bodyMd.length, the
  // blockList signature, the sections-version sig) — a CHEAP value the
  // editor already has — instead of re-running the full extractor in
  // render (#2). The authoritative extraction happens once, inside the
  // debounced timer below. Only when no signal is supplied do we fall
  // back to extracting once for the fingerprint.
  const contentSig =
    contentSignal !== undefined
      ? String(contentSignal)
      : (() => {
          const c = getAnalysisContent()
          const blocksLen = c.blocks.reduce((n, b) => n + b.text.length, 0)
          return `${c.blocks.length}:${blocksLen}:${c.links.length}:${c.images.length}`
        })()

  // The synonym chips drive the debounce dep AND feed the analyzer as
  // SYNONYMS. A chip can contain spaces ("lakeside venue"), so we must
  // NOT round-trip the array through a space-join (that splits multi-word
  // synonyms). `synonymsKey` is a value-stable string used ONLY as a
  // debounce dep (an array literal is a fresh ref every render); the
  // analyzer receives the ARRAY itself, intact (L3).
  const synonymsKey = extraKeyphrases.join(' ')
  // Hold the live synonyms array in a ref so the debounce effect (keyed
  // on the value-stable `synonymsKey`) reads the CURRENT array — with
  // multi-word phrases intact — at fire time.
  const synonymsRef = useRef(extraKeyphrases)
  synonymsRef.current = extraKeyphrases

  useEffect(() => {
    setPending(true)
    const t = setTimeout(() => {
      // The extractor (getAnalysisContent) is CALLER-SUPPLIED and differs
      // across the 3 editors (blocks / markdown / sections). A throwing
      // extractor — or a runAnalysis edge case on malformed content — must
      // NOT leave the readout stuck on the spinner forever. Wrap the whole
      // body: on throw, keep the last good result + log a structured line;
      // ALWAYS clear pending in finally so the UI recovers. (Mirrors the
      // page editor's other debounced timer.)
      try {
        const content = getContentRef.current()
        const next = runAnalysis(
          {
            title: resolvedTitle,
            metaDescription: resolvedDescription,
            slug,
            url,
            keyphrase: focusKeyphrase.trim(),
            synonyms: synonymsRef.current,
            blocks: content.blocks,
            links: content.links,
            images: content.images,
            locale,
            cornerstone,
          },
        )
        setResult(next)
        onScoresRef.current?.(next.seo.score, next.readability.score)
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            msg: 'seo_panel_analysis_failed',
            err_name: err instanceof Error ? err.name : 'unknown',
          }),
        )
        // Keep the last good `result` (don't blank the readout) — the
        // finally clears `pending` so the spinner stops.
      } finally {
        setPending(false)
      }
    }, 400)
    return () => clearTimeout(t)
  }, [
    resolvedTitle,
    resolvedDescription,
    slug,
    url,
    focusKeyphrase,
    synonymsKey,
    cornerstone,
    locale,
    contentSig,
  ])

  // ── seoMeta field helpers ──
  // Routes through emitSeoMeta so a cleared field (null / '' / []) is
  // DROPPED rather than persisted as an empty key — keeps the editor's
  // dirty contract symmetric (#3).
  const setMetaField = <K extends keyof PanelSeoMeta>(
    key: K,
    value: PanelSeoMeta[K],
  ) => {
    emitSeoMeta({ ...seoMeta, [key]: value })
  }

  // Mirror the server refine in lib/cms/seoEditorFields.ts: a leading slash
  // must NOT be followed by another (rejects protocol-relative `//evil.com`),
  // so the UI never shows an attacker-host canonical as "valid".
  const canonicalValid =
    canonicalUrl.trim() === '' ||
    /^(https?:\/\/|\/(?!\/))/.test(canonicalUrl.trim())

  const hasSocialOverride =
    !!seoMeta.ogTitle ||
    !!seoMeta.ogDescription ||
    !!seoMeta.twitterTitle ||
    !!seoMeta.twitterDescription
  const hasAdvanced =
    robotsNoindex || robotsNofollow || cornerstone || canonicalUrl.trim() !== ''
  const hasSchema = !!seoMeta.schemaType

  // Accordion open state.
  const [openAdvanced, setOpenAdvanced] = useState(false)
  const [openSocial, setOpenSocial] = useState(false)
  const [openSchema, setOpenSchema] = useState(false)

  return (
    <div className="space-y-6">
      {/* ── Focus keyphrase ── */}
      <section className="rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-5 backdrop-blur-sm">
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-copper-500/12 text-copper-600"
          >
            <Search size={16} strokeWidth={1.9} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="font-serif text-base font-semibold tracking-tight text-near-black">
              Focus keyphrase
            </h3>
            <p className="mt-0.5 text-[12px] leading-relaxed text-warm-stone">
              The one search phrase you most want this to rank for. The
              checks below grade your content against it.
            </p>
            <div className="mt-3">
              <Input
                value={focusKeyphrase}
                onChange={(e) => onFocusKeyphraseChange(e.target.value)}
                placeholder="e.g. lakeside wedding venue"
                maxLength={160}
                disabled={disabled}
              />
            </div>
            <div className="mt-4">
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
                Related keyphrases
                <span className="ml-1.5 font-normal normal-case tracking-normal text-warm-stone/70">
                  optional · up to 5
                </span>
              </span>
              <div className="mt-1.5">
                <TagInput
                  value={extraKeyphrases}
                  onChange={(v) => setMetaField('extraKeyphrases', v)}
                  placeholder="Add a synonym and press Enter"
                  maxItems={5}
                  maxLength={160}
                  disabled={disabled}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Live analysis ── */}
      <AnalysisReadout
        seo={result?.seo ?? null}
        readability={result?.readability ?? null}
        pending={pending}
        hasKeyphrase={focusKeyphrase.trim().length > 0}
      />

      {/* ── SERP preview ── */}
      <SerpPreview
        title={resolvedTitle || entityTitle || 'Your page title'}
        description={
          resolvedDescription ||
          seoMeta.ogDescription ||
          'Add a description so search engines show a tidy snippet.'
        }
        url={url}
        noindex={robotsNoindex}
      />

      {/* ── Advanced (robots / canonical / cornerstone) ── */}
      <Accordion
        title="Advanced"
        subtitle="Indexing, canonical address, cornerstone"
        open={openAdvanced}
        onToggle={setOpenAdvanced}
        hasContent={hasAdvanced}
      >
        <div className="space-y-5">
          <div className="rounded-xl border border-warm-stone/15 bg-cream-50/70 p-4">
            <Switch
              checked={robotsNoindex}
              onChange={onRobotsNoindexChange}
              disabled={disabled}
              label="Hide from search engines"
              help="When on, this page won't appear in Google or other search results."
            />
            {robotsNoindex && (
              <p className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50/70 px-3 py-2 text-[11px] leading-relaxed text-amber-800">
                <EyeOff size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
                Search engines are asked not to list this page. Visitors with
                the direct link can still open it.
              </p>
            )}
          </div>

          <div className="rounded-xl border border-warm-stone/15 bg-cream-50/70 p-4">
            <Switch
              checked={robotsNofollow}
              onChange={onRobotsNofollowChange}
              disabled={disabled}
              label="Don't pass ranking to linked pages"
              help="Tells search engines not to follow the links on this page."
            />
          </div>

          <div className="rounded-xl border border-warm-stone/15 bg-cream-50/70 p-4">
            <Switch
              checked={cornerstone}
              onChange={onCornerstoneChange}
              disabled={disabled}
              label="Cornerstone content"
              help="Mark this as a key, pillar page. It raises the recommended content length the checks expect."
            />
          </div>

          <label className="block">
            <span className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
              <Compass size={12} strokeWidth={2} />
              Canonical address
            </span>
            <Input
              value={canonicalUrl}
              onChange={(e) => onCanonicalUrlChange(e.target.value)}
              placeholder="Leave blank to use this page's own address"
              maxLength={500}
              disabled={disabled}
              className={clsx(
                'mt-1.5 font-mono text-[13px]',
                !canonicalValid &&
                  'border-red-300 focus:border-red-400 focus:ring-red-200/50',
              )}
            />
            {canonicalValid ? (
              <span className="mt-1.5 block text-[11px] text-warm-stone">
                Point search engines at the original when the same content
                lives at more than one address.
              </span>
            ) : (
              <span className="mt-1.5 flex items-center gap-1.5 text-[11px] font-medium text-red-600">
                <AlertTriangle size={12} strokeWidth={2} />
                Enter a full web address (https://…) or a path that starts
                with a slash.
              </span>
            )}
          </label>
        </div>
      </Accordion>

      {/* ── Social overrides ── */}
      <Accordion
        title="Social sharing"
        subtitle="Custom title & text for shared links"
        open={openSocial}
        onToggle={setOpenSocial}
        hasContent={hasSocialOverride}
        meta={
          <span aria-hidden className="text-warm-stone/70">
            <Share2 size={15} strokeWidth={1.8} />
          </span>
        }
      >
        <div className="space-y-5">
          <p className="text-[12px] leading-relaxed text-warm-stone">
            Leave any field blank to reuse the SEO title and description when
            this is shared on Facebook, LinkedIn, X, WhatsApp or iMessage.
          </p>
          <OverrideField
            label="Facebook / LinkedIn title"
            value={seoMeta.ogTitle ?? ''}
            onChange={(v) => setMetaField('ogTitle', v === '' ? null : v)}
            placeholder={resolvedTitle || entityTitle}
            maxLength={180}
            disabled={disabled}
          />
          <OverrideField
            label="Facebook / LinkedIn description"
            value={seoMeta.ogDescription ?? ''}
            onChange={(v) =>
              setMetaField('ogDescription', v === '' ? null : v)
            }
            placeholder={resolvedDescription || 'Reuses the SEO description'}
            maxLength={320}
            multiline
            disabled={disabled}
          />
          <OverrideField
            label="X (Twitter) title"
            value={seoMeta.twitterTitle ?? ''}
            onChange={(v) => setMetaField('twitterTitle', v === '' ? null : v)}
            placeholder={
              seoMeta.ogTitle || resolvedTitle || entityTitle
            }
            maxLength={180}
            disabled={disabled}
          />
          <OverrideField
            label="X (Twitter) description"
            value={seoMeta.twitterDescription ?? ''}
            onChange={(v) =>
              setMetaField('twitterDescription', v === '' ? null : v)
            }
            placeholder={
              seoMeta.ogDescription ||
              resolvedDescription ||
              'Reuses the SEO description'
            }
            maxLength={320}
            multiline
            disabled={disabled}
          />
        </div>
      </Accordion>

      {/* ── Schema (structured data) ── */}
      <Accordion
        title="Structured data"
        subtitle="How search engines understand this page"
        open={openSchema}
        onToggle={setOpenSchema}
        hasContent={hasSchema}
        meta={
          <span aria-hidden className="text-warm-stone/70">
            <Code2 size={15} strokeWidth={1.8} />
          </span>
        }
      >
        <SchemaPicker
          seoMeta={seoMeta}
          onSeoMetaChange={emitSeoMeta}
          disabled={disabled}
        />
      </Accordion>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// SERP preview — a Google-style snippet of the resolved title / desc.
// ─────────────────────────────────────────────────────────────────────

function SerpPreview({
  title,
  description,
  url,
  noindex,
}: {
  title: string
  description: string
  url?: string
  noindex: boolean
}) {
  const pretty = prettifyUrl(url)
  return (
    <section className="rounded-2xl border border-warm-stone/20 bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-warm-stone">
          Search preview
        </p>
        {noindex && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-700">
            <Ban size={10} strokeWidth={2.4} />
            Hidden from search
          </span>
        )}
      </div>
      <div className="mt-3 max-w-xl">
        {pretty && <p className="truncate text-xs text-near-black/70">{pretty}</p>}
        <p className="mt-1 truncate text-lg font-medium leading-tight text-[#1a0dab]">
          {title}
        </p>
        <p className="mt-1 line-clamp-2 text-sm text-near-black/70">
          {description}
        </p>
      </div>
    </section>
  )
}

function prettifyUrl(url?: string): string | null {
  if (!url) return null
  // Strip the scheme + show host › path-segments like Google's breadcrumb.
  try {
    const u = new URL(url, 'https://example.com')
    const host = url.includes('://') ? u.host : ''
    const segs = u.pathname.split('/').filter(Boolean)
    const crumb = segs.join(' › ')
    return [host, crumb].filter(Boolean).join(' › ') || url
  } catch {
    return url
  }
}

// ─────────────────────────────────────────────────────────────────────
// Override field — a labelled input/textarea that shows the inherited
// value as its placeholder.
// ─────────────────────────────────────────────────────────────────────

function OverrideField({
  label,
  value,
  onChange,
  placeholder,
  maxLength,
  multiline,
  disabled,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder: string
  maxLength: number
  multiline?: boolean
  disabled?: boolean
}) {
  return (
    <label className="block">
      <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
        {label}
      </span>
      <div className="mt-1.5">
        {multiline ? (
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            maxLength={maxLength}
            rows={2}
            disabled={disabled}
            className="block w-full rounded-xl border border-warm-stone/25 bg-cream-50/80 px-4 py-3 text-sm text-near-black placeholder:text-warm-stone/55 transition-all duration-quick ease-standard hover:border-warm-stone/40 focus:border-copper-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-copper-300/40 disabled:opacity-50"
          />
        ) : (
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            maxLength={maxLength}
            disabled={disabled}
          />
        )}
      </div>
    </label>
  )
}
