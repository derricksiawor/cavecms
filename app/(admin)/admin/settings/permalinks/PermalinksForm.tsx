'use client'

import { useMemo, useState } from 'react'
import { csrfFetch } from '@/lib/client/csrf'
import { Input } from '@/components/ui/Input'
import { useToast } from '@/components/inline-edit/Toast'
import { ConfirmModal } from '@/components/admin/ConfirmModal'
import { structuralEqual } from '@/lib/structuralEqual'

// Settings → Permalinks. Two independent cards (Blog + Projects), each with its
// own draft + optimistic-lock version + save. The base segment is validated
// INLINE (format / reserved / login-path / cross-collision) before save, with a
// live URL preview; on save an old→new confirm modal explains that existing
// links keep working (the server registers 301 redirects). The server PATCH
// guard (lib/security/patchGuards.guardPermalink) is the real boundary — this
// client validation is fast feedback, not the gate.

// Canonical slug shape (lib/cms/slug.SLUG_RE) — duplicated here so the client
// form has compile-time feedback without importing the server-only registry.
const SEGMENT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

type BlogStructure = 'postname' | 'year-month-postname' | 'flat'

interface Row {
  key: string
  value: unknown
  version: number
  updated_at: Date | string
}
interface BlogValue {
  segment: string
  structure: BlogStructure
}
interface ProjectsValue {
  segment: string
}

interface Props {
  initial: Row[]
  loginPath: string
  reservedWords: string[]
}

function byKey<T>(rows: Row[], k: string): { value: T; version: number } {
  const r = rows.find((x) => x.key === k)
  if (!r) throw new Error(`permalink row missing: ${k}`)
  return { value: r.value as T, version: r.version }
}

// A worked example slug shown in every preview so the operator sees a real URL,
// not an abstract template (#0.59 — render the actual produced thing).
const SAMPLE_SLUG = 'my-first-post'

/** Build the post-detail preview path for a structure (uses a fixed sample
 *  date so the year-month form is concrete). */
function postPreview(segment: string, structure: BlogStructure): string {
  const seg = segment || 'blog'
  if (structure === 'year-month-postname') return `/${seg}/2026/06/${SAMPLE_SLUG}`
  // 'flat' is treated as post-name today (collision safety — see the note).
  return `/${seg}/${SAMPLE_SLUG}`
}

interface StructureOption {
  value: BlogStructure
  label: string
  note?: string
}
const STRUCTURE_OPTIONS: StructureOption[] = [
  { value: 'postname', label: 'Post name' },
  { value: 'year-month-postname', label: 'Year, month & post name' },
  {
    value: 'flat',
    label: 'Post name at the root',
    note: 'Treated as “Post name” for now — kept here for a future release.',
  },
]

export function PermalinksForm({ initial, loginPath, reservedWords }: Props) {
  const toast = useToast()
  const reserved = useMemo(
    () => new Set(reservedWords.map((w) => w.toLowerCase())),
    [reservedWords],
  )

  const blogInit = byKey<BlogValue>(initial, 'permalink_blog')
  const projInit = byKey<ProjectsValue>(initial, 'permalink_projects')

  const [blog, setBlog] = useState<BlogValue>(blogInit.value)
  const [blogVer, setBlogVer] = useState(blogInit.version)
  const [blogPristine, setBlogPristine] = useState<BlogValue>(blogInit.value)

  const [proj, setProj] = useState<ProjectsValue>(projInit.value)
  const [projVer, setProjVer] = useState(projInit.version)
  const [projPristine, setProjPristine] = useState<ProjectsValue>(projInit.value)

  const [busy, setBusy] = useState<string | null>(null)
  // Confirm modal state — which card is awaiting confirm (old→new copy).
  const [confirming, setConfirming] = useState<'blog' | 'projects' | null>(null)

  // ─── Inline validation ───
  // A segment must: match the slug shape, not be a reserved word (other than
  // its OWN canonical word — 'blog' for blog, 'projects' for projects — which
  // is reserved precisely because it IS this surface), not equal the login
  // path, and not equal the OTHER surface's CURRENT segment.
  function segmentError(
    candidate: string,
    canonical: 'blog' | 'projects',
    otherSegment: string,
  ): string | null {
    const v = candidate.trim().toLowerCase()
    if (v.length < 2) return 'Use at least 2 characters.'
    if (v.length > 40) return 'Keep it under 40 characters.'
    if (!SEGMENT_RE.test(v)) {
      return 'Use lowercase letters, numbers and single dashes (no spaces).'
    }
    if (v !== canonical && reserved.has(v)) {
      return 'That word is reserved by the system. Pick a different one.'
    }
    if (loginPath && v === loginPath.toLowerCase()) {
      return 'That matches your admin sign-in path. Pick a different word.'
    }
    if (v === otherSegment.trim().toLowerCase()) {
      const otherLabel = canonical === 'blog' ? 'Projects' : 'Blog'
      return `That base is already used by ${otherLabel}. They need different bases.`
    }
    return null
  }

  const blogErr = segmentError(blog.segment, 'blog', proj.segment)
  const projErr = segmentError(proj.segment, 'projects', blog.segment)

  const blogDirty = !structuralEqual(blog, blogPristine)
  const projDirty = !structuralEqual(proj, projPristine)

  // Did the BASE SEGMENT change (vs a structure-only save)? The server only
  // registers old→new 301 redirects when the segment actually moved — a
  // structure-only change (postname↔year-month) registers none (the post's
  // canonical URL via postUrl already points at the configured structure, so
  // search engines dedupe). The confirm/toast copy is tied to this so we never
  // promise a 301-redirect that wasn't registered (#0.036 — accurate copy).
  const blogSegmentChanged = blog.segment !== blogPristine.segment
  const projSegmentChanged = proj.segment !== projPristine.segment

  // ─── Save (post-confirm) ───
  async function commit(
    key: 'permalink_blog' | 'permalink_projects',
    value: BlogValue | ProjectsValue,
    version: number,
    setVersion: (v: number) => void,
    setPristine: (v: never) => void,
    segmentChanged: boolean,
  ): Promise<void> {
    setBusy(key)
    try {
      const r = await csrfFetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, value, version }),
      })
      if (r.status === 422) {
        const j = (await r.json().catch(() => null)) as { error?: string; message?: string } | null
        toast.error(j?.message ?? 'That base can’t be used. Pick a different one.')
        return
      }
      if (r.status === 400) {
        toast.error('Some fields look off — check them and try again.')
        return
      }
      if (r.status === 409) {
        toast.error('Someone else just saved this in another tab. Reload to see their changes.')
        return
      }
      if (!r.ok) {
        toast.error("That didn't save. Try again in a moment.")
        return
      }
      setVersion(version + 1)
      setPristine(value as never)
      // Only the base-segment change registers 301 redirects. A structure-only
      // save changes the link FORMAT for new posts; existing links keep working
      // because the post's canonical URL updates automatically.
      toast.success(
        segmentChanged
          ? 'Saved. Old links now redirect to the new ones.'
          : 'Saved. New posts use the new address format; existing links keep working.',
      )
    } finally {
      setBusy(null)
      setConfirming(null)
    }
  }

  return (
    <section className="mt-10 space-y-6">
      {/* ─── Blog card ─── */}
      <Card
        title="Blog"
        subtitle="The base your blog index, posts, categories and tags live under."
      >
        <div className="space-y-6">
          <Field
            label="Base"
            help="e.g. “blog”, “news”, “journal”."
            prefix="/"
            value={blog.segment}
            onChange={(v) => setBlog((b) => ({ ...b, segment: v }))}
            error={blogErr}
            disabled={busy !== null}
          />

          {/* Live preview of the produced index + post URL. */}
          <Preview
            rows={[
              { label: 'Index', path: `/${blog.segment || 'blog'}` },
              { label: 'Post', path: postPreview(blog.segment, blog.structure) },
              {
                label: 'Category',
                path: `/${blog.segment || 'blog'}/category/news`,
              },
            ]}
          />

          {/* URL-structure picker — visual tiles, each rendering the ACTUAL URL
              it produces (not a bare label) so the operator sees the result. */}
          <fieldset>
            <legend className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-warm-stone">
              How a post’s link looks
            </legend>
            <div className="grid gap-3 sm:grid-cols-3">
              {STRUCTURE_OPTIONS.map((opt) => {
                const selected = blog.structure === opt.value
                return (
                  <button
                    key={opt.value}
                    type="button"
                    disabled={busy !== null}
                    onClick={() => setBlog((b) => ({ ...b, structure: opt.value }))}
                    aria-pressed={selected}
                    className={[
                      'flex flex-col items-start gap-2 rounded-2xl border p-4 text-left transition-all duration-quick',
                      selected
                        ? 'border-copper-400 bg-copper-500/8 ring-2 ring-copper-300/40'
                        : 'border-warm-stone/25 bg-cream-50/60 hover:border-warm-stone/45',
                      busy !== null && 'cursor-not-allowed opacity-60',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-near-black">
                      {opt.label}
                    </span>
                    <code className="break-all rounded-md bg-near-black/[0.04] px-2 py-1 font-mono text-[11px] text-copper-700">
                      {postPreview(blog.segment, opt.value)}
                    </code>
                    {opt.note && (
                      <span className="text-[10px] leading-snug text-warm-stone">
                        {opt.note}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </fieldset>

          <SaveRow
            dirty={blogDirty}
            disabled={busy !== null || !!blogErr}
            busy={busy === 'permalink_blog'}
            onSave={() => setConfirming('blog')}
            onDiscard={() => setBlog(blogPristine)}
          />
        </div>
      </Card>

      {/* ─── Projects card ─── */}
      <Card
        title="Projects"
        subtitle="The base your projects index and each project page live under."
      >
        <div className="space-y-6">
          <Field
            label="Base"
            help="e.g. “projects”, “work”, “portfolio”."
            prefix="/"
            value={proj.segment}
            onChange={(v) => setProj({ segment: v })}
            error={projErr}
            disabled={busy !== null}
          />
          <Preview
            rows={[
              { label: 'Index', path: `/${proj.segment || 'projects'}` },
              {
                label: 'Project',
                path: `/${proj.segment || 'projects'}/lakeside-villa`,
              },
            ]}
          />
          <SaveRow
            dirty={projDirty}
            disabled={busy !== null || !!projErr}
            busy={busy === 'permalink_projects'}
            onSave={() => setConfirming('projects')}
            onDiscard={() => setProj(projPristine)}
          />
        </div>
      </Card>

      {/* ─── Confirm modals ─── */}
      {/* Blog: copy is conditional on whether the BASE SEGMENT moved. A segment
          change registers old→new 301 redirects; a structure-only change does
          not (the post's canonical URL updates automatically), so we never
          promise a redirect that wasn't registered. */}
      <ConfirmModal
        open={confirming === 'blog'}
        title={blogSegmentChanged ? 'Change your blog address?' : 'Change your post link format?'}
        description={
          blogSegmentChanged
            ? `Your blog moves from “/${blogPristine.segment}” to “/${blog.segment}”. Existing links keep working — the old addresses 301-redirect to the new ones automatically.`
            : 'New posts will use the new address format. Existing links keep working — each post’s canonical URL updates automatically.'
        }
        confirmLabel={blogSegmentChanged ? 'Change address' : 'Change format'}
        busy={busy === 'permalink_blog'}
        onConfirm={() =>
          commit(
            'permalink_blog',
            blog,
            blogVer,
            setBlogVer,
            setBlogPristine as (v: never) => void,
            blogSegmentChanged,
          )
        }
        onCancel={() => setConfirming(null)}
      />
      {/* Projects: only a base segment exists, so a save here is always a
          segment change (the card has no structure picker). */}
      <ConfirmModal
        open={confirming === 'projects'}
        title="Change your projects address?"
        description={`Your projects move from “/${projPristine.segment}” to “/${proj.segment}”. Existing links keep working — the old addresses 301-redirect to the new ones automatically.`}
        confirmLabel="Change address"
        busy={busy === 'permalink_projects'}
        onConfirm={() =>
          commit(
            'permalink_projects',
            proj,
            projVer,
            setProjVer,
            setProjPristine as (v: never) => void,
            projSegmentChanged,
          )
        }
        onCancel={() => setConfirming(null)}
      />
    </section>
  )
}

// ─── Presentational sub-components ───

function Card({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-3xl border border-warm-stone/20 bg-white/70 p-7 shadow-[0_24px_60px_-40px_rgba(5,5,5,0.4)] sm:p-9">
      <h2 className="font-serif text-2xl font-bold tracking-tight text-near-black">{title}</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-warm-stone">{subtitle}</p>
      <div className="mt-7">{children}</div>
    </div>
  )
}

function Field({
  label,
  help,
  prefix,
  value,
  onChange,
  error,
  disabled,
}: {
  label: string
  help: string
  prefix: string
  value: string
  onChange: (v: string) => void
  error: string | null
  disabled: boolean
}) {
  return (
    <div>
      <label className="block text-xs font-semibold uppercase tracking-[0.2em] text-warm-stone">
        {label}
      </label>
      <div className="mt-2 flex items-center gap-2">
        <span className="select-none font-mono text-sm text-warm-stone">{prefix}</span>
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
          disabled={disabled}
          spellCheck={false}
          autoCapitalize="none"
          aria-invalid={!!error}
          className={error ? 'border-copper-500/60 focus:border-copper-500' : undefined}
        />
      </div>
      {error ? (
        <p className="mt-2 text-xs font-medium text-copper-700">{error}</p>
      ) : (
        <p className="mt-2 text-xs text-warm-stone/80">{help}</p>
      )}
    </div>
  )
}

function Preview({ rows }: { rows: Array<{ label: string; path: string }> }) {
  return (
    <div className="rounded-2xl bg-near-black/[0.03] p-4">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-warm-stone">
        Preview
      </p>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.label} className="flex items-baseline gap-3">
            <span className="w-16 shrink-0 text-[11px] font-medium uppercase tracking-wide text-warm-stone/80">
              {r.label}
            </span>
            <code className="break-all font-mono text-xs text-copper-700">{r.path}</code>
          </li>
        ))}
      </ul>
    </div>
  )
}

function SaveRow({
  dirty,
  disabled,
  busy,
  onSave,
  onDiscard,
}: {
  dirty: boolean
  disabled: boolean
  busy: boolean
  onSave: () => void
  onDiscard: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-warm-stone/15 pt-5">
      <span className="text-xs font-medium text-warm-stone">
        {dirty ? 'Unsaved changes' : 'All changes saved'}
      </span>
      <div className="flex items-center gap-3">
        {dirty && (
          <button
            type="button"
            onClick={onDiscard}
            disabled={busy}
            className="inline-flex w-fit items-center justify-center rounded-full border border-warm-stone/30 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-near-black transition-colors hover:border-copper-400 hover:text-copper-700 disabled:opacity-50"
          >
            Discard
          </button>
        )}
        <button
          type="button"
          onClick={onSave}
          disabled={disabled || !dirty}
          className="inline-flex w-fit items-center justify-center rounded-full bg-near-black px-6 py-2.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-cream-50 transition-all hover:bg-copper-700 disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  )
}
