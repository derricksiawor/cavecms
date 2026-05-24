'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { csrfFetch } from '@/lib/client/csrf'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { SlugInput } from '@/components/inline-edit/SlugInput'
import { useToast } from '@/components/inline-edit/Toast'
import { SLUG_RE, SLUG_MIN, SLUG_MAX } from '@/lib/cms/slug'
import type { Role } from '@/lib/auth/requireRole'

// /admin/pages/new submit form. Branches its visible options on role:
//   - admin: all template options, publish-immediately radio.
//   - editor: same template options (per spec §3.4 — clone-* is admin
//     ONLY though). Status forced to Draft.
//   - viewer: server-side 404; never reaches this form.

type Template = 'blank' | 'clone-about' | 'clone-services' | 'clone-contact'

export function NewPageForm({ role }: { role: Role }) {
  const router = useRouter()
  const toast = useToast()
  const isAdmin = role === 'admin'
  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState('')
  const [template, setTemplate] = useState<Template>('blank')
  const [publishNow, setPublishNow] = useState(false)
  const [busy, setBusy] = useState(false)

  // Submit validation mirrors the server-side validatePageSlug rules
  // — the API also enforces NFKC + RESERVED + LOGIN_PATH but the
  // client-side check catches the common cases inline so the operator
  // doesn't pay a round-trip for an obviously bad slug.
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (title.trim().length === 0) {
      toast.error('Please add a title.')
      return
    }
    if (slug.length < SLUG_MIN || slug.length > SLUG_MAX) {
      toast.error(
        `The web address must be between ${SLUG_MIN} and ${SLUG_MAX} characters.`,
      )
      return
    }
    if (!SLUG_RE.test(slug)) {
      toast.error(
        'The web address can only use lowercase letters, numbers, and single hyphens — no spaces.',
      )
      return
    }
    setBusy(true)
    try {
      const body: {
        title: string
        slug: string
        template?: Template
        published?: boolean
      } = { title: title.trim(), slug }
      if (template !== 'blank') body.template = template
      if (isAdmin && publishNow) body.published = true

      const res = await csrfFetch('/api/cms/pages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        const { id } = (await res.json()) as { id: number }
        toast.success(publishNow ? 'Page published.' : 'Draft created.')
        router.push(`/admin/pages/${id}`)
        return
      }
      const j = (await res.json().catch(() => ({}))) as { error?: string }
      const code = j.error ?? ''
      switch (code) {
        case 'slug_in_use':
          toast.error(
            'That web address is already in use by another page. Try a different one.',
          )
          return
        case 'slug_invalid':
          toast.error(
            'That web address is not valid. Use lowercase letters, numbers, and dashes (e.g. about-us).',
          )
          return
        case 'clone_source_missing':
          toast.error(
            'The selected template page is not available. Pick a different template or Blank.',
          )
          return
        case 'clone_source_trashed':
          toast.error(
            'The selected template page is in Trash. Restore it or pick a different template.',
          )
          return
        case 'clone_schema_mismatch':
          toast.error(
            'The selected template has blocks that don’t match the current schema. Edit the source page first.',
          )
          return
        case 'forbidden':
          toast.error(
            'Editors can save drafts only — an admin must publish.',
          )
          return
        default:
          toast.error("We couldn’t create that page. Try again in a moment.")
          return
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-6">
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
          placeholder="A clear, descriptive page title"
        />
        <p className="mt-1 text-[11px] text-warm-stone">
          We&rsquo;ll suggest a web address from the title until you
          change it yourself.
        </p>
      </label>

      <div>
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
          Web address
        </span>
        <div className="mt-1.5">
          <SlugInput
            value={slug}
            onChange={setSlug}
            source={title}
            baseUrl="bestworldcompany.com/"
          />
        </div>
        <p className="mt-1 text-[11px] text-warm-stone">
          Renaming later creates a 308 redirect from the old web address
          so existing bookmarks still work.
        </p>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
          Template
        </legend>
        {/* Visual cards. Each carries a small SVG mock illustrating the
            block layout that template starts with. Sized so all four
            (or the editor's one) fit two-per-row on md+. */}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <TemplateCard
            value="blank"
            label="Blank page"
            description="Start with no blocks. Build the layout from scratch in the editor."
            preview={<BlankPreview />}
            checked={template === 'blank'}
            onSelect={() => setTemplate('blank')}
          />
          {isAdmin && (
            <>
              <TemplateCard
                value="clone-about"
                label="Clone “About”"
                description="Copy every block from the About page as a starting point."
                preview={<ClonePreview rows={['lead', 'paragraph', 'milestones', 'cta']} />}
                checked={template === 'clone-about'}
                onSelect={() => setTemplate('clone-about')}
              />
              <TemplateCard
                value="clone-services"
                label="Clone “Services”"
                description="Copy every block from the Services page as a starting point."
                preview={<ClonePreview rows={['lead', 'grid', 'grid', 'cta']} />}
                checked={template === 'clone-services'}
                onSelect={() => setTemplate('clone-services')}
              />
              <TemplateCard
                value="clone-contact"
                label="Clone “Contact”"
                description="Copy every block from the Contact page as a starting point."
                preview={<ClonePreview rows={['lead', 'form', 'form', 'cta']} />}
                checked={template === 'clone-contact'}
                onSelect={() => setTemplate('clone-contact')}
              />
            </>
          )}
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
          Status
        </legend>
        {isAdmin ? (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <label className="flex items-start gap-3 rounded-xl border border-warm-stone/25 bg-cream-50 p-4 transition-colors hover:border-copper-400 has-[:checked]:border-copper-500 has-[:checked]:bg-copper-50/50">
              <input
                type="radio"
                name="status"
                checked={!publishNow}
                onChange={() => setPublishNow(false)}
                className="mt-1 accent-copper-600"
              />
              <div>
                <p className="text-sm font-semibold text-near-black">Draft</p>
                <p className="mt-1 text-xs text-warm-stone">
                  Save and edit privately. Publish from the editor when ready.
                </p>
              </div>
            </label>
            <label className="flex items-start gap-3 rounded-xl border border-warm-stone/25 bg-cream-50 p-4 transition-colors hover:border-copper-400 has-[:checked]:border-copper-500 has-[:checked]:bg-copper-50/50">
              <input
                type="radio"
                name="status"
                checked={publishNow}
                onChange={() => setPublishNow(true)}
                className="mt-1 accent-copper-600"
              />
              <div>
                <p className="text-sm font-semibold text-near-black">
                  Publish immediately
                </p>
                <p className="mt-1 text-xs text-warm-stone">
                  Make the page live on the public site as soon as it&rsquo;s
                  created.
                </p>
              </div>
            </label>
          </div>
        ) : (
          <p className="rounded-xl border border-warm-stone/25 bg-cream-50 p-4 text-xs text-warm-stone">
            Editors can save drafts only — an admin must publish.
          </p>
        )}
      </fieldset>

      <div className="flex gap-3">
        <Button type="submit" disabled={busy}>
          {busy
            ? 'Creating…'
            : publishNow && isAdmin
              ? 'Create and publish'
              : 'Create draft'}
        </Button>
      </div>
    </form>
  )
}

// ─── Template card ───────────────────────────────────────────────────
// One template tile. Wraps the radio input so the entire surface is
// the click target — easier than aiming at a 16px radio dot. The
// `has-[:checked]` selector lights the copper border when selected,
// matching the operator's other admin-form patterns. Preview SVG sits
// at the top with consistent aspect so visual rhythm is maintained
// across the four tiles.

function TemplateCard({
  value,
  label,
  description,
  preview,
  checked,
  onSelect,
}: {
  value: string
  label: string
  description: string
  preview: React.ReactNode
  checked: boolean
  onSelect: () => void
}) {
  return (
    <label className="group relative flex cursor-pointer flex-col gap-3 overflow-hidden rounded-2xl border border-warm-stone/25 bg-cream-50 p-3 transition-all hover:-translate-y-0.5 hover:border-copper-400 hover:shadow-[0_18px_40px_-24px_rgba(5,5,5,0.35)] has-[:checked]:border-copper-500 has-[:checked]:bg-copper-50/40 has-[:checked]:shadow-[0_20px_44px_-22px_rgba(160,90,40,0.45)] motion-reduce:transition-none motion-reduce:hover:translate-y-0">
      <input
        type="radio"
        name="template"
        value={value}
        checked={checked}
        onChange={onSelect}
        className="sr-only"
      />
      <div className="overflow-hidden rounded-xl bg-cream p-3 ring-1 ring-warm-stone/15 transition-all group-has-[:checked]:ring-copper-400/50">
        <div className="aspect-[4/2.4]">{preview}</div>
      </div>
      <div className="flex flex-1 flex-col gap-1 px-1 pb-1">
        <p className="flex items-center gap-2 text-sm font-semibold text-near-black">
          {label}
          {checked && (
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-copper-500" aria-hidden="true" />
          )}
        </p>
        <p className="text-xs leading-relaxed text-warm-stone">
          {description}
        </p>
      </div>
    </label>
  )
}

// Blank-template preview — empty rectangle with a dashed border to read
// as "nothing yet, pick your own". The "+" mark in the centre signals
// "you'll add blocks here".
function BlankPreview() {
  return (
    <svg
      viewBox="0 0 200 120"
      className="h-full w-full"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <rect
        x="14"
        y="14"
        width="172"
        height="92"
        rx="8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray="4 4"
        className="text-warm-stone/40"
      />
      <line x1="100" y1="52" x2="100" y2="68" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-warm-stone/60" />
      <line x1="92" y1="60" x2="108" y2="60" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-warm-stone/60" />
    </svg>
  )
}

// Clone-template preview — small stacked sections sized by row "kind".
// Lead = a wide bold bar (looks like a headline).
// Paragraph = stacked thin lines (body copy).
// Milestones = three small inline pills (year markers).
// Grid = a 3-column grid (service cards).
// Form = labeled input rows.
// Cta = a pill button alone, right-aligned.
function ClonePreview({
  rows,
}: {
  rows: Array<'lead' | 'paragraph' | 'milestones' | 'grid' | 'form' | 'cta'>
}) {
  // Layout: stack `rows` vertically inside the 200x120 viewbox with
  // 10px outer padding and 8px between rows. Each row gets a slot
  // height of `(120 - 20 - 8*(n-1)) / n`.
  const padX = 14
  const padY = 14
  const gap = 8
  const totalH = 120 - padY * 2 - gap * (rows.length - 1)
  const slotH = totalH / rows.length
  return (
    <svg
      viewBox="0 0 200 120"
      className="h-full w-full"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {rows.map((kind, i) => {
        const y = padY + i * (slotH + gap)
        const w = 200 - padX * 2
        switch (kind) {
          case 'lead':
            return (
              <g key={i}>
                <rect x={padX} y={y + slotH * 0.15} width={w * 0.6} height={slotH * 0.35} rx="2" className="fill-near-black/70" />
                <rect x={padX} y={y + slotH * 0.6} width={w * 0.85} height={slotH * 0.2} rx="2" className="fill-warm-stone/40" />
              </g>
            )
          case 'paragraph':
            return (
              <g key={i}>
                <rect x={padX} y={y + slotH * 0.1} width={w} height={slotH * 0.18} rx="2" className="fill-warm-stone/35" />
                <rect x={padX} y={y + slotH * 0.4} width={w * 0.92} height={slotH * 0.18} rx="2" className="fill-warm-stone/35" />
                <rect x={padX} y={y + slotH * 0.7} width={w * 0.78} height={slotH * 0.18} rx="2" className="fill-warm-stone/35" />
              </g>
            )
          case 'milestones': {
            const pillW = (w - 16) / 3
            return (
              <g key={i}>
                {[0, 1, 2].map((p) => (
                  <rect
                    key={p}
                    x={padX + p * (pillW + 8)}
                    y={y + slotH * 0.2}
                    width={pillW}
                    height={slotH * 0.6}
                    rx={slotH * 0.3}
                    className="fill-copper-500/25 stroke-copper-500/50"
                    strokeWidth="0.8"
                  />
                ))}
              </g>
            )
          }
          case 'grid': {
            const cellW = (w - 16) / 3
            return (
              <g key={i}>
                {[0, 1, 2].map((c) => (
                  <rect
                    key={c}
                    x={padX + c * (cellW + 8)}
                    y={y + slotH * 0.1}
                    width={cellW}
                    height={slotH * 0.8}
                    rx="3"
                    className="fill-warm-stone/15"
                  />
                ))}
              </g>
            )
          }
          case 'form':
            return (
              <g key={i}>
                <rect x={padX} y={y + slotH * 0.1} width={w * 0.3} height={slotH * 0.2} rx="2" className="fill-warm-stone/35" />
                <rect x={padX} y={y + slotH * 0.4} width={w} height={slotH * 0.5} rx="3" className="fill-warm-stone/15 stroke-warm-stone/35" strokeWidth="0.8" />
              </g>
            )
          case 'cta':
            return (
              <g key={i}>
                <rect
                  x={padX + w - 70}
                  y={y + slotH * 0.25}
                  width={70}
                  height={slotH * 0.55}
                  rx={slotH * 0.27}
                  className="fill-near-black"
                />
              </g>
            )
        }
      })}
    </svg>
  )
}
