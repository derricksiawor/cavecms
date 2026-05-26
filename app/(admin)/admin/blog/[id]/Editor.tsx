'use client'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { csrfFetch } from '@/lib/client/csrf'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { MediaPicker } from '@/components/inline-edit/MediaPicker'
import { ConfirmModal } from '@/components/admin/ConfirmModal'
import { Switch } from '@/components/inline-edit/Switch'
import { SlugInput } from '@/components/inline-edit/SlugInput'
import { SeoFields } from '@/components/inline-edit/SeoFields'
import { MarkdownEditor } from '@/components/inline-edit/MarkdownEditor'
import { StickySaveBar } from '@/components/inline-edit/StickySaveBar'
import { useToast } from '@/components/inline-edit/Toast'
import { useAutoSave } from '@/hooks/useAutoSave'
import { SaveStatus } from '@/components/inline-edit/SaveStatus'
import type { MediaRef } from '@/components/inline-edit/MediaPickerProvider'
import { previewMarkdown } from './preview/action'

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
}

import { SLUG_RE } from '@/lib/cms/slug'

// Blog post editor. The body is now a full markdown editor with a
// toolbar and live preview pane — no more raw mono-font textarea. SEO
// fields show a Google snippet preview with character counters. Slug
// has a live URL preview and an auto-suggest toggle from the title.
export function Editor({
  post,
  canPublish,
  readonly,
}: {
  post: EditorPost
  canPublish: boolean
  readonly: boolean
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
  const [version, setVersion] = useState(post.version)
  const [busy, setBusy] = useState(false)
  const [pendingDelete, setPendingDelete] = useState(false)

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
    published !== pristine.published

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
    if (slugInvalid) {
      toast.error(slugInvalid)
      return { ok: false }
    }
    setBusy(true)
    try {
      const res = await csrfFetch(`/api/cms/posts/${post.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildPatch()),
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
      })
      return { ok: true }
    } finally {
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
          <span
            className={`inline-flex items-center rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] ${
              published
                ? 'bg-copper-500 text-cream-50'
                : 'border border-warm-stone/30 text-warm-stone'
            }`}
          >
            {published ? 'Published' : 'Draft'}
          </span>
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
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
              Body
            </span>
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
          {canPublish && (
            <div className="rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-5">
              <Switch
                checked={published}
                onChange={setPublished}
                label="Show on the public blog"
                help={published ? 'Live for visitors.' : 'Hidden — only the team can see it.'}
              />
            </div>
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
