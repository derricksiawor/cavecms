'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ExternalLink } from 'lucide-react'
import { csrfFetch } from '@/lib/client/csrf'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { MediaPicker } from '@/components/inline-edit/MediaPicker'
import { ConfirmModal } from '@/components/admin/ConfirmModal'
import { SlugInput } from '@/components/inline-edit/SlugInput'
import { SeoFields } from '@/components/inline-edit/SeoFields'
import { MarkdownEditor } from '@/components/inline-edit/MarkdownEditor'
import { StickySaveBar } from '@/components/inline-edit/StickySaveBar'
import { useToast } from '@/components/inline-edit/Toast'
import { useAutoSave } from '@/hooks/useAutoSave'
import { SaveStatus } from '@/components/inline-edit/SaveStatus'
import type { MediaRef } from '@/components/inline-edit/MediaPickerProvider'
import { previewMarkdown } from './preview/action'
import { TaxonomyChips, type TermOption } from './TaxonomyChips'
import { ScheduleControl } from './ScheduleControl'
import { derivePostStatus } from '@/lib/cms/postStatus'
// F15: build the "Edit content" public-page URL from the operator's configured
// permalink segments (resolved server-side, passed in) instead of hardcoding
// /blog/<slug> — so a custom blog base / post structure opens the right URL.
import { postUrl as buildPostUrl, type PermalinkSegments } from '@/lib/blog/urls'

export interface EditorPost {
  id: number
  slug: string
  title: string
  excerpt: string | null
  body_md: string
  hero: MediaRef | null
  og: MediaRef | null
  seo_title: string | null
  seo_description: string | null
  version: number
  published: boolean
  // Phase 8: the post's current published_at (ISO string or null) so the editor
  // can show the live status (Draft/Scheduled/Published) AND let an admin
  // reschedule a post that's already scheduled.
  published_at: string | null
}

import { SLUG_RE } from '@/lib/cms/slug'

// Order-independent signature of an id set — sorted + comma-joined. Used to
// detect taxonomy dirtiness with a cheap string compare instead of Set diffing
// on every render.
function sigOf(ids: number[]): string {
  return [...ids].sort((a, b) => a - b).join(',')
}

// Blog post editor. The body is now a full markdown editor with a
// toolbar and live preview pane — no more raw mono-font textarea. SEO
// fields show a Google snippet preview with character counters. Slug
// has a live URL preview and an auto-suggest toggle from the title.
export function Editor({
  post,
  canPublish,
  readonly,
  categoryOptions: initialCategoryOptions,
  tagOptions: initialTagOptions,
  assignedCategoryIds,
  assignedTagIds,
  segments,
}: {
  post: EditorPost
  canPublish: boolean
  readonly: boolean
  categoryOptions: TermOption[]
  tagOptions: TermOption[]
  assignedCategoryIds: number[]
  assignedTagIds: number[]
  /** Resolved permalink segments (blog base + post structure), threaded from the
   *  server editor page so the "Edit content" button opens the correctly-
   *  segmented public URL (F15). */
  segments: PermalinkSegments
}) {
  const toast = useToast()
  const router = useRouter()

  const [title, setTitle] = useState(post.title)
  const [slug, setSlug] = useState(post.slug)
  const [excerpt, setExcerpt] = useState(post.excerpt ?? '')
  const [bodyMd, setBodyMd] = useState(post.body_md)
  const [hero, setHero] = useState<MediaRef | null>(post.hero)
  const [og, setOg] = useState<MediaRef | null>(post.og)
  const [seoTitle, setSeoTitle] = useState(post.seo_title ?? '')
  const [seoDescription, setSeoDescription] = useState(post.seo_description ?? '')
  const [published, setPublished] = useState(post.published)
  // Phase 8 scheduling. `scheduledAtIso` is the explicit publish instant ONLY
  // when the post is scheduled for the FUTURE; for a published-now or draft post
  // it's null (the server stamps NOW() on first publish / preserves the original
  // on re-publish). Seeded from the post's current published_at iff that date is
  // in the future, so opening a scheduled post shows the picker pre-filled.
  const initialScheduledIso =
    post.published &&
    post.published_at !== null &&
    new Date(post.published_at).getTime() > Date.now()
      ? post.published_at
      : null
  const [scheduledAtIso, setScheduledAtIso] = useState<string | null>(
    initialScheduledIso,
  )
  // The post's CURRENT effective published_at (ISO | null), tracked locally so
  // it stays accurate across saves (the post prop is immutable; the PATCH
  // response only returns the new version). Drives the header status pill +
  // the "was this scheduled in the future?" check in buildPatch.
  const [currentPublishedAtIso, setCurrentPublishedAtIso] = useState<
    string | null
  >(post.published_at)
  const [version, setVersion] = useState(post.version)
  const [busy, setBusy] = useState(false)
  // Synchronous in-flight guard. `busy` is React state, so the button's
  // `disabled={busy}` only takes effect after a re-render — a rapid double
  // click (or autosave racing a manual Save) can fire a SECOND request before
  // the DOM disables. The second request re-uses the same single-use CSRF
  // token the first already consumed → a 403. A ref flips synchronously inside
  // the handler so the racing duplicate is dropped before it ever hits the
  // network. (Covers manual Save, Cmd+S flush, and autosave — they all funnel
  // through persist().)
  const savingRef = useRef(false)
  const [pendingDelete, setPendingDelete] = useState(false)

  // Taxonomy chip state. `categoryOptions` / `tagOptions` are mutable so an
  // inline-created term is appended to the catalog. Selected-id Sets drive the
  // chips; the pristine copies (sorted arrays) detect dirtiness + reset on
  // discard.
  const [categoryOptions, setCategoryOptions] = useState<TermOption[]>(
    initialCategoryOptions,
  )
  const [tagOptions, setTagOptions] = useState<TermOption[]>(initialTagOptions)
  const [categoryIds, setCategoryIds] = useState<Set<number>>(
    () => new Set(assignedCategoryIds),
  )
  const [tagIds, setTagIds] = useState<Set<number>>(
    () => new Set(assignedTagIds),
  )

  const [pristine, setPristine] = useState({
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt ?? '',
    bodyMd: post.body_md,
    hero: post.hero?.media_id ?? null,
    og: post.og?.media_id ?? null,
    seoTitle: post.seo_title ?? '',
    seoDescription: post.seo_description ?? '',
    published: post.published,
    // Phase 8: pristine schedule instant for dirty-detection + discard reset.
    scheduledAtIso: initialScheduledIso,
    // Pristine id arrays for the chip pickers. dirty-detection compares the
    // order-independent signature (cheap); discard resets the Sets from these.
    categoryIdsArr: assignedCategoryIds,
    tagIdsArr: assignedTagIds,
  })

  const dirty =
    title !== pristine.title ||
    slug !== pristine.slug ||
    excerpt !== pristine.excerpt ||
    bodyMd !== pristine.bodyMd ||
    (hero?.media_id ?? null) !== pristine.hero ||
    (og?.media_id ?? null) !== pristine.og ||
    seoTitle !== pristine.seoTitle ||
    seoDescription !== pristine.seoDescription ||
    published !== pristine.published ||
    scheduledAtIso !== pristine.scheduledAtIso ||
    sigOf([...categoryIds]) !== sigOf(pristine.categoryIdsArr) ||
    sigOf([...tagIds]) !== sigOf(pristine.tagIdsArr)

  const slugInvalid = useMemo(() => {
    if (!canPublish) return null
    if (slug === pristine.slug) return null
    if (!SLUG_RE.test(slug)) return 'The web address can only use lowercase letters, numbers, and single hyphens — no spaces.'
    return null
  }, [canPublish, slug, pristine.slug])

  const buildPatch = (): Record<string, unknown> => {
    const patch: Record<string, unknown> = { version }
    if (title !== pristine.title) patch.title = title
    if (excerpt !== pristine.excerpt) {
      patch.excerpt = excerpt === '' ? null : excerpt
    }
    if (bodyMd !== pristine.bodyMd) patch.bodyMd = bodyMd
    if (seoTitle !== pristine.seoTitle) {
      patch.seoTitle = seoTitle === '' ? null : seoTitle
    }
    if (seoDescription !== pristine.seoDescription) {
      patch.seoDescription = seoDescription === '' ? null : seoDescription
    }
    if ((hero?.media_id ?? null) !== pristine.hero) {
      patch.heroImageId = hero?.media_id ?? null
    }
    if ((og?.media_id ?? null) !== pristine.og) {
      patch.ogImageId = og?.media_id ?? null
    }
    if (canPublish) {
      if (slug !== pristine.slug) patch.slug = slug
      if (published !== pristine.published) patch.published = published
      // Phase 8 scheduling. Only admins (canPublish) send publishedAt.
      if (published) {
        const futureIso =
          scheduledAtIso !== null &&
          new Date(scheduledAtIso).getTime() > Date.now()
            ? scheduledAtIso
            : null
        if (futureIso !== null) {
          // Scheduling / rescheduling to an explicit future instant.
          patch.publishedAt = futureIso
        } else {
          // "Publish now" path. If the post is CURRENTLY scheduled for the
          // future (its stored published_at is ahead of now) and the operator
          // switched to publish-now, we must stamp NOW explicitly — otherwise
          // the server's COALESCE(published_at, NOW) preserves the stale future
          // date and the post stays hidden. For a brand-new publish or a
          // re-publish of an already-live post, we OMIT publishedAt so the
          // server keeps its first-publish-stamps-now / preserve-original rule.
          const wasFutureScheduled =
            currentPublishedAtIso !== null &&
            new Date(currentPublishedAtIso).getTime() > Date.now()
          if (wasFutureScheduled) {
            patch.publishedAt = new Date().toISOString()
          }
        }
      }
    }
    // Taxonomy: send the FULL desired id set for an axis only when it changed
    // (the API leaves an unsent axis untouched). categoryIds/tagIds are an
    // editor capability (not gated on canPublish).
    if (sigOf([...categoryIds]) !== sigOf(pristine.categoryIdsArr)) {
      patch.categoryIds = [...categoryIds]
    }
    if (sigOf([...tagIds]) !== sigOf(pristine.tagIdsArr)) {
      patch.tagIds = [...tagIds]
    }
    return patch
  }

  // Browser-level unsaved warning while there are pending changes.
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
    if (readonly) return { ok: false }
    // Drop a re-entrant call synchronously (double-click Save, or an autosave
    // tick landing on top of a manual Save) before it consumes a fresh CSRF
    // token the in-flight request is already using → avoids the 403 race.
    if (savingRef.current) return { ok: false }
    if (slugInvalid) {
      toast.error(slugInvalid)
      return { ok: false }
    }
    savingRef.current = true
    setBusy(true)
    const patch = buildPatch()
    try {
      const res = await csrfFetch(`/api/cms/posts/${post.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (res.status === 409) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        const msg =
          j.error === 'slug_taken'
            ? 'That web address is already in use by another post. Try a different one.'
            : j.error === 'stale_version'
              ? "Someone else just updated this post — refresh the page so you don't overwrite their work."
              : 'The page is out of date. Refresh and try again.'
        toast.error(msg)
        return { ok: false }
      }
      if (!res.ok) {
        toast.error("That didn't save. Try again in a moment.")
        return { ok: false }
      }
      const j = (await res.json()) as { version: number }
      setVersion(j.version)
      // Recompute the new effective published_at locally: if the patch carried
      // an explicit publishedAt the server honoured it; otherwise the value is
      // unchanged (first-publish-now is stamped server-side, but for status
      // purposes "published with no future date" already reads as Published via
      // the null→now fallback in derivePostStatus). Keep currentPublishedAtIso +
      // scheduledAtIso pristine in sync so a follow-up save diffs correctly.
      const sentPublishedAt =
        typeof patch.publishedAt === 'string' ? patch.publishedAt : undefined
      const nextPublishedAtIso =
        sentPublishedAt !== undefined ? sentPublishedAt : currentPublishedAtIso
      setCurrentPublishedAtIso(nextPublishedAtIso)
      // Re-derive the "scheduled in the future?" pristine from the new effective
      // date so switching schedule→now→schedule across saves stays consistent.
      const nextScheduledPristine =
        published &&
        nextPublishedAtIso !== null &&
        new Date(nextPublishedAtIso).getTime() > Date.now()
          ? nextPublishedAtIso
          : null
      setScheduledAtIso(nextScheduledPristine)
      setPristine({
        title,
        slug,
        excerpt,
        bodyMd,
        hero: hero?.media_id ?? null,
        og: og?.media_id ?? null,
        seoTitle,
        seoDescription,
        published,
        scheduledAtIso: nextScheduledPristine,
        categoryIdsArr: [...categoryIds],
        tagIdsArr: [...tagIds],
      })
      return { ok: true }
    } finally {
      savingRef.current = false
      setBusy(false)
    }
  }

  const auto = useAutoSave({
    dirty: dirty && !slugInvalid && !readonly,
    save: persist,
  })

  const save = async () => {
    const r = await persist()
    if (r.ok) toast.success('Post saved.')
  }

  const discard = () => {
    setTitle(pristine.title)
    setSlug(pristine.slug)
    setExcerpt(pristine.excerpt)
    setBodyMd(pristine.bodyMd)
    setHero(pristine.hero !== null ? { media_id: pristine.hero, alt: post.hero?.alt ?? '' } : null)
    setOg(pristine.og !== null ? { media_id: pristine.og, alt: post.og?.alt ?? '' } : null)
    setSeoTitle(pristine.seoTitle)
    setSeoDescription(pristine.seoDescription)
    setPublished(pristine.published)
    setScheduledAtIso(pristine.scheduledAtIso)
    setCategoryIds(new Set(pristine.categoryIdsArr))
    setTagIds(new Set(pristine.tagIdsArr))
    toast.info('Changes undone.')
  }

  const confirmDelete = async () => {
    if (!canPublish || busy) return
    setBusy(true)
    try {
      const res = await csrfFetch(`/api/cms/posts/${post.id}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 204) {
        toast.error("We couldn't move that post to Trash. Try again in a moment.")
        return
      }
      toast.success('Post moved to Trash.')
      router.push('/admin/blog')
    } finally {
      setBusy(false)
      setPendingDelete(false)
    }
  }

  const fieldset = readonly ? 'opacity-60 pointer-events-none' : ''
  const postUrl = `yourdomain.com/blog/${slug || pristine.slug}`

  return (
    <section className={`space-y-8 ${fieldset}`}>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
            Edit post
          </p>
          <h1 className="mt-2 font-serif text-3xl font-bold tracking-tight text-near-black">
            {title || post.title}
          </h1>
          <p className="mt-1 text-xs text-warm-stone font-mono">/blog/{slug}</p>
        </div>
        <div className="flex items-center gap-3">
          <SaveStatus
            status={auto.status}
            lastSavedAt={auto.lastSavedAt}
            manualDirty={dirty && auto.status === 'pending'}
          />
          {(() => {
            // Header status pill — derived from the SAME helper the public gate
            // + admin list use, so the editor never claims a status the public
            // wouldn't see. A future schedule reads "Scheduled". For the
            // publish-now case (published, no future date) we feed the EFFECTIVE
            // published_at the server will stamp (NOW) instead of null — after
            // F7 a null published_at on a published row derives to 'draft', so
            // passing now keeps the live "Published" preview accurate.
            const status = derivePostStatus({
              published,
              published_at: published ? (scheduledAtIso ?? new Date()) : null,
              deleted_at: null,
            })
            const cls =
              status === 'published'
                ? 'bg-copper-500 text-cream-50'
                : status === 'scheduled'
                  ? 'bg-near-black text-cream-50'
                  : 'border border-warm-stone/30 text-warm-stone'
            const label =
              status === 'published'
                ? 'Published'
                : status === 'scheduled'
                  ? 'Scheduled'
                  : 'Draft'
            return (
              <span
                className={`inline-flex items-center rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] ${cls}`}
              >
                {label}
              </span>
            )
          })()}
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-6">
        <div className="space-y-6">
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
              Title
            </span>
            <Input
              className="mt-1.5"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={220}
              placeholder="The post headline"
            />
          </label>

          {canPublish && (
            <div>
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
                Web address
              </span>
              <div className="mt-1.5">
                <SlugInput
                  value={slug}
                  onChange={setSlug}
                  source={title}
                  baseUrl="yourdomain.com/blog/"
                  invalidMessage={slugInvalid ?? undefined}
                />
              </div>
              <p className="mt-1 text-[11px] text-warm-stone">
                If you rename this, the old link will redirect to the new one — visitors won&rsquo;t get a broken page.
              </p>
            </div>
          )}

          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
              Excerpt
            </span>
            <Input
              className="mt-1.5"
              value={excerpt}
              onChange={(e) => setExcerpt(e.target.value)}
              maxLength={320}
              placeholder="A short summary that shows on the blog list"
            />
            <p className="mt-1 text-[11px] text-warm-stone">
              Shows on the blog index card and is used as the search-result description if you leave the SEO description blank.
            </p>
          </label>

          <div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
                Body
              </span>
              {/* Edit-content affordance — opens the post's PUBLIC page in
                  Wix-style edit mode (`?edit=1`), where the SAME inline-edit
                  drawer that pages use edits the body blocks in place. Shown
                  only for admin/editor (readonly = viewer hides it), matching
                  the page editor's "Edit on public page" gating. Uses the
                  PERSISTED slug (pristine.slug) — the public URL only resolves
                  the saved slug, so an unsaved rename can't produce a dead
                  link. */}
              {!readonly && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-fit gap-2"
                  onClick={() =>
                    window.open(
                      // F15: segment-aware public URL (honors a custom blog base
                      // + post structure). Uses the PERSISTED slug + the post's
                      // published_at (year-month structures need it) so the link
                      // matches the real route. ?edit=1 enters inline-edit mode.
                      `${buildPostUrl(pristine.slug, segments, post.published_at)}?edit=1`,
                      '_blank',
                      'noopener',
                    )
                  }
                >
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  Edit content
                </Button>
              )}
            </div>
            <p className="mt-1 text-[11px] text-warm-stone">
              Use <span className="font-semibold">Edit content</span> to lay out
              the body with the visual editor — headings, images, galleries and
              more — directly on the live page. The box below is the original
              markdown body, kept as a fallback.
            </p>
            <div className="mt-1.5">
              <MarkdownEditor
                value={bodyMd}
                onChange={setBodyMd}
                onRenderPreview={previewMarkdown}
                maxLength={180_000}
                disabled={readonly}
                placeholder="Write your post here — use the toolbar above for headings, links, lists, and more."
              />
            </div>
          </div>
        </div>

        <aside className="space-y-6">
          <MediaPicker
            label="Cover photo"
            value={hero ?? undefined}
            thumbUrl={null}
            onChange={(m) => setHero(m ?? null)}
          />
          <MediaPicker
            label="Social share image"
            help="Shown when this post is shared on Facebook, X, WhatsApp, LinkedIn or iMessage."
            value={og ?? undefined}
            onChange={(m) => setOg(m ?? null)}
          />

          <div className="rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-5 space-y-5">
            <TaxonomyChips
              kind="category"
              label="Categories"
              help="The main sections this post belongs to."
              options={categoryOptions}
              selectedIds={categoryIds}
              onChange={setCategoryIds}
              onTermCreated={(term) => {
                setCategoryOptions((prev) => [...prev, term])
                setCategoryIds((prev) => new Set(prev).add(term.id))
              }}
              disabled={readonly}
            />
            <TaxonomyChips
              kind="tag"
              label="Tags"
              help="Lighter labels to connect related posts."
              options={tagOptions}
              selectedIds={tagIds}
              onChange={setTagIds}
              onTermCreated={(term) => {
                setTagOptions((prev) => [...prev, term])
                setTagIds((prev) => new Set(prev).add(term.id))
              }}
              disabled={readonly}
            />
          </div>

          {canPublish && (
            <ScheduleControl
              published={published}
              scheduledAtIso={scheduledAtIso}
              onChange={(next) => {
                setPublished(next.published)
                setScheduledAtIso(next.scheduledAtIso)
              }}
              disabled={readonly}
            />
          )}
        </aside>
      </div>

      <SeoFields
        title={seoTitle}
        description={seoDescription}
        onTitleChange={setSeoTitle}
        onDescriptionChange={setSeoDescription}
        placeholderTitle={title}
        placeholderDescription={excerpt || 'No description set'}
        url={postUrl}
      />

      <StickySaveBar
        dirty={dirty}
        busy={busy}
        onSave={save}
        onDiscard={discard}
        saveLabel="Save post"
        extras={
          canPublish && (
            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={() => setPendingDelete(true)}
              disabled={busy}
            >
              Delete
            </Button>
          )
        }
      />

      <ConfirmModal
        open={pendingDelete}
        title="Move this post to Trash?"
        description={`"${post.title}" will be moved to Trash and hidden from the public blog. You have 30 days to restore it from Trash before it is removed for good.`}
        confirmLabel="Move to Trash"
        destructive
        busy={busy}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(false)}
      />
    </section>
  )
}
