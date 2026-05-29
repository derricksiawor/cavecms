'use client'
import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { csrfFetch } from '@/lib/client/csrf'
import { structuralEqual } from '@/lib/structuralEqual'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { MediaPicker } from '@/components/inline-edit/MediaPicker'
import type { MediaRef } from '@/components/inline-edit/MediaPickerProvider'
import { ZodForm } from '@/components/inline-edit/ZodForm'
import { Accordion } from '@/components/inline-edit/Accordion'
import { Switch } from '@/components/inline-edit/Switch'
import { SlugInput } from '@/components/inline-edit/SlugInput'
import { SeoFields } from '@/components/inline-edit/SeoFields'
import { StickySaveBar } from '@/components/inline-edit/StickySaveBar'
import { useToast } from '@/components/inline-edit/Toast'
import { useAutoSave } from '@/hooks/useAutoSave'
import { SaveStatus } from '@/components/inline-edit/SaveStatus'
import { SECTION_SHAPES, SECTION_LABELS } from '@/lib/cms/project-section-shapes'

// Admin project editor. Three surfaces, all stitched into a single
// page with smooth section-by-section editing:
//
//   1. Project meta — name, slug, tagline, status, location, hero,
//      brochure, OG, SEO, publish toggle. PATCH /api/cms/projects/[id].
//   2. Section accordion — one panel per section_key (10 total).
//      Side rail nav lets the editor jump between sections without
//      scrolling. Premium expand/collapse motion, status dot beside
//      each title shows whether the section already has content.
//   3. Sticky save bar — visible whenever there are unsaved meta
//      changes, surfaces Preview + Discard alongside Save.
//
// Section data PATCHes /api/cms/projects/[id]/sections/[sectionId]
// unchanged. Server-side Zod is the trust boundary; the visual form is
// just the operator surface.

interface ProjectMeta {
  id: number
  slug: string
  name: string
  tagline: string | null
  status: string
  location: string | null
  hero_image_id: number | null
  brochure_pdf_id: number | null
  og_image_id: number | null
  featured_order: number | null
  published: number
  seo_title: string | null
  seo_description: string | null
  version: number
  deleted_at: Date | null
}

interface SectionEntry {
  id: number
  section_key: string
  position: number
  version: number
  data: Record<string, unknown>
}

interface MediaSummary {
  id: number
  alt: string
  thumbUrl: string | null
}

import { SLUG_RE } from '@/lib/cms/slug'

const STATUS_OPTIONS = [
  { value: 'coming_soon', label: 'Coming soon' },
  { value: 'under_construction', label: 'Under construction' },
  { value: 'selling', label: 'Selling now' },
  { value: 'sold_out', label: 'Sold out' },
] as const

export function ProjectEditor({
  role,
  project,
  sections,
  media,
  sectionKeys,
  hasCmsPage,
}: {
  role: 'admin' | 'editor'
  project: ProjectMeta
  sections: SectionEntry[]
  media: MediaSummary[]
  sectionKeys: readonly string[]
  // True once the project has been migrated to a CMS block tree (a live
  // `pages` row at its slug). The legacy section accordion is then
  // hidden — body content is edited on the live page through the inline
  // editor, and the accordion would otherwise write project_sections
  // that the CMS render ignores.
  hasCmsPage: boolean
}) {
  const toast = useToast()
  const canPublishAndSlug = role === 'admin'
  const mediaMap = useMemo(() => new Map(media.map((m) => [m.id, m])), [media])
  const mediaRefFromId = (id: number | null): MediaRef | null => {
    if (id == null) return null
    const m = mediaMap.get(id)
    return m ? { media_id: m.id, alt: m.alt } : { media_id: id, alt: '' }
  }
  const thumbForId = (id: number | null): string | null => {
    if (id == null) return null
    return mediaMap.get(id)?.thumbUrl ?? null
  }

  // Meta-form state
  const [name, setName] = useState(project.name)
  const [slug, setSlug] = useState(project.slug)
  const [tagline, setTagline] = useState(project.tagline ?? '')
  const [status, setStatus] = useState(project.status)
  const [location, setLocation] = useState(project.location ?? '')
  const [hero, setHero] = useState<MediaRef | null>(
    mediaRefFromId(project.hero_image_id),
  )
  const [brochure, setBrochure] = useState<MediaRef | null>(
    mediaRefFromId(project.brochure_pdf_id),
  )
  const [og, setOg] = useState<MediaRef | null>(mediaRefFromId(project.og_image_id))
  const [published, setPublished] = useState(project.published === 1)
  const [seoTitle, setSeoTitle] = useState(project.seo_title ?? '')
  const [seoDescription, setSeoDescription] = useState(project.seo_description ?? '')
  const [version, setVersion] = useState(project.version)
  const [metaBusy, setMetaBusy] = useState(false)
  const [metaErr, setMetaErr] = useState<string | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)

  // Pristine snapshot — the dirty marker compares to this so a Save +
  // version bump resets the bar to "all saved".
  const [pristine, setPristine] = useState({
    name: project.name,
    slug: project.slug,
    tagline: project.tagline ?? '',
    status: project.status,
    location: project.location ?? '',
    hero: project.hero_image_id,
    brochure: project.brochure_pdf_id,
    og: project.og_image_id,
    published: project.published === 1,
    seoTitle: project.seo_title ?? '',
    seoDescription: project.seo_description ?? '',
  })

  const dirty =
    name !== pristine.name ||
    slug !== pristine.slug ||
    tagline !== pristine.tagline ||
    status !== pristine.status ||
    location !== pristine.location ||
    (hero?.media_id ?? null) !== pristine.hero ||
    (brochure?.media_id ?? null) !== pristine.brochure ||
    (og?.media_id ?? null) !== pristine.og ||
    published !== pristine.published ||
    seoTitle !== pristine.seoTitle ||
    seoDescription !== pristine.seoDescription

  const slugInvalid =
    canPublishAndSlug && slug !== pristine.slug && !SLUG_RE.test(slug)
      ? 'The web address can only use lowercase letters, numbers, and single hyphens — no spaces.'
      : null

  const buildPatch = (): Record<string, unknown> => {
    // All PATCH routes now accept `version` as the canonical
    // optimistic-lock token (legacy `expectedVersion` alias still works
    // on the routes that historically used it — see those route files).
    const patch: Record<string, unknown> = { version }
    if (name !== pristine.name) patch.name = name
    if (tagline !== pristine.tagline) {
      patch.tagline = tagline === '' ? null : tagline
    }
    if (status !== pristine.status) patch.status = status
    if (location !== pristine.location) {
      patch.location = location === '' ? null : location
    }
    if ((hero?.media_id ?? null) !== pristine.hero) {
      patch.heroImageId = hero?.media_id ?? null
    }
    if ((brochure?.media_id ?? null) !== pristine.brochure) {
      patch.brochurePdfId = brochure?.media_id ?? null
    }
    if ((og?.media_id ?? null) !== pristine.og) {
      patch.ogImageId = og?.media_id ?? null
    }
    if (seoTitle !== pristine.seoTitle) {
      patch.seoTitle = seoTitle === '' ? null : seoTitle
    }
    if (seoDescription !== pristine.seoDescription) {
      patch.seoDescription = seoDescription === '' ? null : seoDescription
    }
    if (canPublishAndSlug) {
      if (slug !== pristine.slug) patch.slug = slug
      if (published !== pristine.published) patch.published = published
    }
    return patch
  }

  // Single source of truth for the PATCH. Used both by the manual
  // Save button and by the auto-save hook. Returns { ok } so the
  // hook can surface the status without knowing the contract details.
  const persistMeta = async (): Promise<{ ok: boolean }> => {
    if (slugInvalid) {
      setMetaErr(slugInvalid)
      toast.error(slugInvalid)
      return { ok: false }
    }
    setMetaErr(null)
    setMetaBusy(true)
    try {
      const res = await csrfFetch(`/api/cms/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildPatch()),
      })
      if (res.status === 409) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        const msg =
          j.error === 'slug_taken'
            ? 'That web address is already in use by another project. Try a different one.'
            : "Someone else just updated this project — refresh the page so you don't overwrite their work."
        setMetaErr(msg)
        toast.error(msg)
        return { ok: false }
      }
      if (!res.ok) {
        const msg = "That didn't save. Try again in a moment."
        setMetaErr(msg)
        toast.error(msg)
        return { ok: false }
      }
      const j = (await res.json()) as { version: number }
      setVersion(j.version)
      setPristine({
        name,
        slug,
        tagline,
        status,
        location,
        hero: hero?.media_id ?? null,
        brochure: brochure?.media_id ?? null,
        og: og?.media_id ?? null,
        published,
        seoTitle,
        seoDescription,
      })
      return { ok: true }
    } finally {
      setMetaBusy(false)
    }
  }

  // Auto-save: 900ms debounce after each meta change, plus Cmd/Ctrl+S
  // force-flush. We don't auto-save invalid slugs (slugInvalid blocks
  // persistMeta) — those wait for the operator to correct.
  const autoMeta = useAutoSave({
    dirty: dirty && !slugInvalid,
    save: persistMeta,
  })

  const saveMeta = async () => {
    // Use the actual save result, NOT the React `metaErr` state — the
    // setMetaErr inside persistMeta is async and won't reflect in this
    // closure. Reading `metaErr` directly would fire a false-success
    // toast on every 409.
    const r = await persistMeta()
    if (r.ok) toast.success('Project details saved.')
  }

  const discardMeta = () => {
    setName(pristine.name)
    setSlug(pristine.slug)
    setTagline(pristine.tagline)
    setStatus(pristine.status)
    setLocation(pristine.location)
    setHero(mediaRefFromId(pristine.hero))
    setBrochure(mediaRefFromId(pristine.brochure))
    setOg(mediaRefFromId(pristine.og))
    setPublished(pristine.published)
    setSeoTitle(pristine.seoTitle)
    setSeoDescription(pristine.seoDescription)
    toast.info('Changes undone.')
  }

  const openPreview = async () => {
    if (previewBusy) return
    setPreviewBusy(true)
    try {
      const res = await csrfFetch(
        `/api/cms/projects/${project.id}/preview-token`,
        { method: 'POST' },
      )
      if (!res.ok) {
        toast.error("We couldn't open a preview link right now. Try again in a moment.")
        return
      }
      const j = (await res.json()) as { url: string }
      window.open(j.url, '_blank', 'noopener,noreferrer')
    } finally {
      setPreviewBusy(false)
    }
  }

  // Side-rail nav state — which section is open. We allow only one
  // section open at a time so the page stays focused. "Expand all" /
  // "Collapse all" gestures are first-class.
  const [openSection, setOpenSection] = useState<string | null>(null)

  const projectUrl = `yourdomain.com/projects/${slug || pristine.slug}`

  return (
    <>
      {/* Meta form */}
      <section className="mt-10">
        <header className="flex items-center justify-between">
          <div>
            <h2 className="font-serif text-2xl font-bold tracking-tight text-near-black">
              Project details
            </h2>
            <p className="mt-1 text-xs text-warm-stone">
              The basics that show up on listing cards, the project banner, and in Google.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <SaveStatus
              status={autoMeta.status}
              lastSavedAt={autoMeta.lastSavedAt}
              manualDirty={dirty && autoMeta.status === 'pending'}
            />
          </div>
        </header>

        <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-5">
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
              Project name
            </span>
            <Input
              className="mt-1.5"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              required
              placeholder="e.g. Cedar Heights"
            />
          </label>
          {canPublishAndSlug && (
            <div>
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
                Web address
              </span>
              <div className="mt-1.5">
                <SlugInput
                  value={slug}
                  onChange={(v) => setSlug(v)}
                  source={name}
                  baseUrl="yourdomain.com/projects/"
                  invalidMessage={slugInvalid ?? undefined}
                />
              </div>
              <p className="mt-1 text-[11px] text-warm-stone">
                If you rename this, the old link will redirect to the new one — visitors won&rsquo;t get a broken page.
              </p>
            </div>
          )}
          <label className="block lg:col-span-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
              Tagline
            </span>
            <Input
              className="mt-1.5"
              value={tagline}
              onChange={(e) => setTagline(e.target.value)}
              maxLength={220}
              placeholder="A short line that captures the project"
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
              Status
            </span>
            <div className="relative mt-1.5">
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="w-full appearance-none rounded-xl border border-warm-stone/25 bg-cream-50/80 px-4 py-3 pr-10 text-sm text-near-black transition-all hover:border-warm-stone/40 focus:border-copper-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-copper-300/40 min-h-[44px]"
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              <span aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-warm-stone">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </span>
            </div>
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
              Location
            </span>
            <Input
              className="mt-1.5"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              maxLength={180}
              placeholder="e.g. neighbourhood, city"
            />
          </label>
        </div>

        <div className="mt-6 space-y-5">
          <MediaPicker
            label="Cover photo"
            value={hero ?? undefined}
            thumbUrl={thumbForId(hero?.media_id ?? null)}
            onChange={(m) => setHero(m ?? null)}
          />
          <MediaPicker
            label="Brochure (PDF)"
            accept="pdf"
            help="Visitors download this PDF after sharing their email on the brochure card."
            value={brochure ?? undefined}
            onChange={(m) => setBrochure(m ?? null)}
          />
          <MediaPicker
            label="Social share image"
            help="Shown when someone shares this project on Facebook, X, WhatsApp, LinkedIn or iMessage. Best size is 1200 by 630 pixels."
            value={og ?? undefined}
            thumbUrl={thumbForId(og?.media_id ?? null)}
            onChange={(m) => setOg(m ?? null)}
          />
        </div>

        <div className="mt-8">
          <SeoFields
            title={seoTitle}
            description={seoDescription}
            onTitleChange={setSeoTitle}
            onDescriptionChange={setSeoDescription}
            placeholderTitle={name}
            placeholderDescription={tagline || 'No description set'}
            url={projectUrl}
          />
        </div>

        {canPublishAndSlug && (
          <div className="mt-8 rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-5">
            <Switch
              checked={published}
              onChange={setPublished}
              label="Show on the public site"
              help={
                published
                  ? 'Live for visitors. Switch off to hide the project without deleting it.'
                  : 'Hidden from visitors. Save your changes, then switch this on to go live.'
              }
            />
          </div>
        )}

        {metaErr && (
          <p className="mt-4 text-sm font-medium text-red-700">{metaErr}</p>
        )}
      </section>

      {/* Sections */}
      <section className="mt-16">
        {hasCmsPage ? (
          // Migrated to a CMS block tree — body content is edited on the
          // live page through the inline editor, so the legacy section
          // accordion is retired for this project. The meta form above
          // (name / slug / status / hero / brochure / SEO / publish)
          // stays — that's still where project metadata is edited.
          <div className="rounded-2xl border border-copper-200 bg-copper-50/50 p-6 sm:p-8">
            <h2 className="font-serif text-2xl font-bold tracking-tight text-near-black">
              Page content
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-warm-stone">
              This project’s page content — hero, gallery, floor plans,
              pricing, amenities, and the rest — is now built from editable
              blocks. Open the live page and click any section to edit it in
              place, just like any other page.
            </p>
            <a
              href={`/projects/${project.slug}?edit=1`}
              className="mt-5 inline-flex w-fit items-center gap-2 rounded-full bg-near-black px-6 py-3 text-sm font-semibold tracking-wide text-cream-50 transition-colors hover:bg-copper-700"
            >
              Edit page content on the live page
            </a>
          </div>
        ) : (
        <>
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-serif text-2xl font-bold tracking-tight text-near-black">
              Page sections
            </h2>
            <p className="mt-1 text-xs text-warm-stone max-w-2xl">
              Open a section to edit it. Your changes save themselves as you type — no need to click Save.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setOpenSection(null)}
              className="rounded-full border border-warm-stone/25 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-warm-stone hover:border-copper-400 hover:text-copper-700 transition-colors"
            >
              Collapse all
            </button>
          </div>
        </header>

        <div className="mt-6 grid grid-cols-1 lg:grid-cols-[200px_1fr] gap-6">
          {/* Side rail */}
          <nav
            aria-label="Sections"
            className="hidden lg:block sticky top-24 self-start"
          >
            <ul className="space-y-1">
              {sectionKeys.map((key) => {
                const sec = sections.find((s) => s.section_key === key)
                if (!sec) return null
                const label = SECTION_LABELS[key] ?? key
                const hasContent = sectionHasContent(sec.data)
                return (
                  <li key={key}>
                    <button
                      type="button"
                      onClick={() => setOpenSection(key)}
                      className={clsx(
                        'flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                        openSection === key
                          ? 'bg-near-black text-cream-50'
                          : 'text-near-black hover:bg-cream-100',
                      )}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <span
                          aria-hidden
                          className={clsx(
                            'inline-flex h-2 w-2 shrink-0 rounded-full',
                            hasContent ? 'bg-copper-500' : 'bg-warm-stone/30',
                          )}
                        />
                        <span className="truncate">{label}</span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </nav>

          {/* Accordion stack */}
          <div className="space-y-3">
            {sectionKeys.map((key) => {
              const section = sections.find((s) => s.section_key === key)
              if (!section) return null
              return (
                <SectionCard
                  key={section.id}
                  projectId={project.id}
                  section={section}
                  open={openSection === key}
                  onToggle={(next) => setOpenSection(next ? key : null)}
                />
              )
            })}
          </div>
        </div>
        </>
        )}
      </section>

      <StickySaveBar
        dirty={dirty}
        busy={metaBusy}
        onSave={saveMeta}
        onDiscard={discardMeta}
        onPreview={openPreview}
        saveLabel="Save details"
        busyLabel="Saving…"
        hint={previewBusy ? 'Opening preview…' : undefined}
      />
    </>
  )
}

function sectionHasContent(data: Record<string, unknown> | null): boolean {
  if (!data) return false
  for (const v of Object.values(data)) {
    if (v == null) continue
    if (typeof v === 'string' && v.trim().length > 0) return true
    if (typeof v === 'number') return true
    if (typeof v === 'boolean' && v) return true
    if (Array.isArray(v) && v.length > 0) return true
    if (typeof v === 'object' && Object.keys(v as object).length > 0) return true
  }
  return false
}

function SectionCard({
  projectId,
  section,
  open,
  onToggle,
}: {
  projectId: number
  section: SectionEntry
  open: boolean
  onToggle: (next: boolean) => void
}) {
  const toast = useToast()
  const shapes = SECTION_SHAPES[section.section_key]
  const label =
    SECTION_LABELS[section.section_key] ??
    section.section_key.replace(/_/g, ' ')

  const [data, setData] = useState<Record<string, unknown>>(section.data ?? {})
  const [pristine, setPristine] = useState<Record<string, unknown>>(section.data ?? {})
  const [version, setVersion] = useState(section.version)
  const [busy, setBusy] = useState(false)

  // Structural short-circuit equality — returns on the first divergent
  // key instead of stringifying the whole section payload twice per
  // keystroke (gallery + floor_plans can carry 50+ items).
  const dirty = useMemo(
    () => !structuralEqual(data, pristine),
    [data, pristine],
  )

  // Browser-level unsaved-changes warning while a section has dirty
  // state. Without this, refreshing/closing the tab silently throws
  // out edits.
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  const persist = async (): Promise<{ ok: boolean }> => {
    setBusy(true)
    try {
      const res = await csrfFetch(
        `/api/cms/projects/${projectId}/sections/${section.id}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data, version }),
        },
      )
      if (res.status === 409) {
        toast.error("Someone else just updated this section — refresh the page and try again.")
        return { ok: false }
      }
      if (res.status === 400) {
        toast.error('Some fields look off — check them and try again.')
        return { ok: false }
      }
      if (!res.ok) {
        toast.error("That didn't save. Try again in a moment.")
        return { ok: false }
      }
      const j = (await res.json()) as { version: number }
      setVersion(j.version)
      setPristine(data)
      return { ok: true }
    } finally {
      setBusy(false)
    }
  }

  // Auto-save section data when the panel is open and dirty. We only
  // schedule when `open` so a stale debounce can't fire on a section
  // the operator has navigated away from.
  const auto = useAutoSave({
    dirty: dirty && open,
    save: persist,
  })

  const save = async () => {
    const r = await persist()
    if (r.ok) toast.success(`${label} saved.`)
  }

  const discard = () => {
    setData(pristine)
    toast.info('Changes undone.')
  }

  // Flush any pending auto-save BEFORE the panel closes — otherwise
  // toggling to another section silently drops dirty edits, because
  // useAutoSave's `dirty && open` input flips false the moment `open`
  // becomes false. The browser-level beforeunload listener (line ~607)
  // is per-section and won't fire if the operator has already switched
  // away to a clean section.
  const handleToggle = (next: boolean) => {
    if (!next && dirty) auto.flush()
    onToggle(next)
  }

  return (
    <Accordion
      id={`section-${section.section_key}`}
      title={label}
      open={open}
      onToggle={handleToggle}
      hasContent={sectionHasContent(pristine)}
      meta={
        <SaveStatus
          status={auto.status}
          lastSavedAt={auto.lastSavedAt}
          manualDirty={dirty && auto.status === 'pending'}
        />
      }
    >
      {shapes ? (
        <ZodForm shapes={shapes} value={data} onChange={setData} />
      ) : (
        <p className="text-xs text-red-700">
          This section type doesn&rsquo;t have a form yet. Please let an admin know so it can be added.
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" onClick={save} disabled={busy || !dirty}>
          {busy ? 'Saving…' : 'Save section'}
        </Button>
        {dirty && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={discard}
            disabled={busy}
          >
            Undo changes
          </Button>
        )}
      </div>
    </Accordion>
  )
}
