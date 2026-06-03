'use client'
import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  Image as ImageIcon,
  Type as TypeIcon,
  Building2,
  User,
  type LucideIcon,
} from 'lucide-react'
import clsx from 'clsx'
import { csrfFetch } from '@/lib/client/csrf'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/inline-edit/Switch'
import { useToast } from '@/components/inline-edit/Toast'
import { structuralEqual } from '@/lib/structuralEqual'
import { SeoCard } from '@/components/seo/SeoCard'

// ── Shapes mirroring seo_social + seo_schema ──
interface SocialValue {
  twitterCard: 'summary' | 'summary_large_image'
  twitterSite?: string
  twitterCreator?: string
  facebookAppId?: string
  ogLocale: string
}
interface SchemaValue {
  entityType: 'Organization' | 'Person'
  personName?: string
  breadcrumbsEnabled: boolean
  articleType: 'Article' | 'BlogPosting' | 'NewsArticle'
  websiteSearchAction: boolean
}

// A short, sensible set of common Open Graph locales. The registry
// accepts any well-formed ll or ll_CC code; this list covers the
// overwhelming majority of sites without becoming a country picker.
const OG_LOCALES: { value: string; label: string }[] = [
  { value: 'en_US', label: 'English (United States)' },
  { value: 'en_GB', label: 'English (United Kingdom)' },
  { value: 'en_CA', label: 'English (Canada)' },
  { value: 'en_AU', label: 'English (Australia)' },
  { value: 'fr_FR', label: 'French (France)' },
  { value: 'de_DE', label: 'German (Germany)' },
  { value: 'es_ES', label: 'Spanish (Spain)' },
  { value: 'es_MX', label: 'Spanish (Mexico)' },
  { value: 'it_IT', label: 'Italian (Italy)' },
  { value: 'pt_BR', label: 'Portuguese (Brazil)' },
  { value: 'pt_PT', label: 'Portuguese (Portugal)' },
  { value: 'nl_NL', label: 'Dutch (Netherlands)' },
  { value: 'sv_SE', label: 'Swedish (Sweden)' },
  { value: 'da_DK', label: 'Danish (Denmark)' },
  { value: 'pl_PL', label: 'Polish (Poland)' },
  { value: 'ja_JP', label: 'Japanese (Japan)' },
  { value: 'ko_KR', label: 'Korean (South Korea)' },
  { value: 'zh_CN', label: 'Chinese (Simplified)' },
  { value: 'zh_TW', label: 'Chinese (Traditional)' },
  { value: 'ar_AR', label: 'Arabic' },
]

const ARTICLE_TYPES: { value: SchemaValue['articleType']; label: string }[] = [
  { value: 'BlogPosting', label: 'Blog post' },
  { value: 'Article', label: 'Article' },
  { value: 'NewsArticle', label: 'News article' },
]

export function SocialSchemaClient({
  social,
  schema,
  defaults,
}: {
  social: { value: unknown; version: number }
  schema: { value: unknown; version: number }
  /** Registry defaults for the two keys, passed from the server page so
   *  this client never imports the server-only settings registry. */
  defaults: { seo_social: SocialValue; seo_schema: SchemaValue }
}) {
  // Merge each stored value over its registry default so every optional
  // key is present + controlled regardless of the stored row shape (a
  // fresh-install default row omits optional keys like twitterSite). The
  // casts ride on the merged object, so they're backed by present keys.
  const socialValue = {
    ...defaults.seo_social,
    ...((social.value as Partial<SocialValue> | null) ?? {}),
  } as SocialValue
  const schemaValue = {
    ...defaults.seo_schema,
    ...((schema.value as Partial<SchemaValue> | null) ?? {}),
  } as SchemaValue

  return (
    <section className="mt-10 space-y-6">
      <SocialCard initial={socialValue} version={social.version} />
      <SchemaCard initial={schemaValue} version={schema.version} />
    </section>
  )
}

// ───────────────────────────── Social ─────────────────────────────

function SocialCard({
  initial,
  version: initialVersion,
}: {
  initial: SocialValue
  version: number
}) {
  const toast = useToast()
  const [form, setForm] = useState<SocialValue>(initial)
  const [pristine, setPristine] = useState<SocialValue>(initial)
  const [version, setVersion] = useState(initialVersion)
  const [busy, setBusy] = useState(false)
  const dirty = useMemo(() => !structuralEqual(form, pristine), [form, pristine])

  const save = useCallback(async () => {
    if (busy || !dirty) return
    setBusy(true)
    try {
      // Normalise blank handles / app id to undefined so the schema's
      // "blank → unset" transforms apply cleanly.
      const payload: SocialValue = {
        twitterCard: form.twitterCard,
        ogLocale: form.ogLocale,
      }
      const site = (form.twitterSite ?? '').trim()
      const creator = (form.twitterCreator ?? '').trim()
      const appId = (form.facebookAppId ?? '').trim()
      if (site) payload.twitterSite = site
      if (creator) payload.twitterCreator = creator
      if (appId) payload.facebookAppId = appId

      const r = await csrfFetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'seo_social', value: payload, version }),
      })
      if (r.status === 400 || r.status === 422) {
        toast.error('One of those values looks off — check your handles and app ID.')
        return
      }
      if (r.status === 409) {
        toast.error('Settings changed in another tab. Refresh to see them.')
        return
      }
      if (!r.ok) {
        toast.error("That didn't save. Try again in a moment.")
        return
      }
      // Adopt the authoritative server version (additive). A no-op save
      // returns 200 without bumping the DB version — blind v + 1 desyncs
      // the client and 409s the next save.
      const respBody = (await r.json().catch(() => null)) as { version?: number } | null
      setForm(payload)
      setPristine(payload)
      setVersion(typeof respBody?.version === 'number' ? respBody.version : (v) => v + 1)
      toast.success('Social settings saved.')
    } finally {
      setBusy(false)
    }
  }, [busy, dirty, form, version, toast])

  return (
    <SeoCard
      title="Social sharing"
      eyebrow="Open Graph & X (Twitter)"
      help="How a link to your site looks when someone shares it on X, Facebook, LinkedIn, or in a chat — the card style, your account handles, and the language."
      dirty={dirty}
      busy={busy}
      onSave={() => void save()}
      onUndo={() => setForm(pristine)}
    >
      <div className="space-y-7">
        {/* Twitter card — two visual preview tiles, not a dropdown. */}
        <div>
          <p className="text-sm font-medium text-near-black">Card style on X</p>
          <p className="mt-0.5 text-[13px] leading-relaxed text-warm-stone">
            How your shared link previews on X. A large image draws more
            attention; a small card is more compact.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <CardChoiceTile
              selected={form.twitterCard === 'summary_large_image'}
              onSelect={() =>
                setForm((f) => ({ ...f, twitterCard: 'summary_large_image' }))
              }
              title="Large image"
              caption="Big, edge-to-edge preview image"
              variant="large"
            />
            <CardChoiceTile
              selected={form.twitterCard === 'summary'}
              onSelect={() => setForm((f) => ({ ...f, twitterCard: 'summary' }))}
              title="Small card"
              caption="Compact thumbnail beside the text"
              variant="small"
            />
          </div>
        </div>

        {/* Handles. */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <HandleField
            label="Your site’s X account"
            help="The account that owns the site."
            value={form.twitterSite ?? ''}
            onChange={(v) => setForm((f) => ({ ...f, twitterSite: v }))}
            placeholder="yoursite"
          />
          <HandleField
            label="Default author account"
            help="Credited on shared posts when no author is set."
            value={form.twitterCreator ?? ''}
            onChange={(v) => setForm((f) => ({ ...f, twitterCreator: v }))}
            placeholder="yourname"
          />
        </div>

        {/* Locale + Facebook app id. */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="block text-sm font-medium text-near-black">
              Content language
            </span>
            <div className="mt-2">
              <Select
                value={form.ogLocale}
                options={OG_LOCALES}
                onChange={(v) => setForm((f) => ({ ...f, ogLocale: v }))}
                aria-label="Content language"
              />
            </div>
            <span className="mt-1 block text-[11px] text-warm-stone">
              Tells social platforms what language your pages are written in.
            </span>
          </label>

          <label className="block">
            <span className="block text-sm font-medium text-near-black">
              Facebook App ID
            </span>
            <Input
              className="mt-2"
              inputMode="numeric"
              value={form.facebookAppId ?? ''}
              maxLength={40}
              placeholder="Optional — numbers only"
              onChange={(e) =>
                setForm((f) => ({ ...f, facebookAppId: e.target.value }))
              }
            />
            <span className="mt-1 block text-[11px] text-warm-stone">
              Only needed if you use Facebook’s insights for shared links.
            </span>
          </label>
        </div>

        {/* Pointer to the default OG image (lives elsewhere — don't duplicate). */}
        <div className="flex items-start gap-3 rounded-xl bg-cream-100/40 p-4">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-copper-500/12 text-copper-700">
            <ImageIcon size={16} strokeWidth={1.9} aria-hidden />
          </span>
          <p className="text-[13px] leading-relaxed text-warm-stone">
            The default image shown on shared links is set under{' '}
            <Link
              href="/admin/settings"
              className="font-medium text-copper-700 underline-offset-2 hover:underline"
            >
              Settings → SEO
            </Link>
            . It’s used whenever a page doesn’t have its own share image.
          </p>
        </div>
      </div>
    </SeoCard>
  )
}

// A single visual tile for the X card-style choice. Renders a tiny mock
// of the resulting card so the operator SEES the difference (#0.59).
function CardChoiceTile({
  selected,
  onSelect,
  title,
  caption,
  variant,
}: {
  selected: boolean
  onSelect: () => void
  title: string
  caption: string
  variant: 'large' | 'small'
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={clsx(
        'flex flex-col gap-3 rounded-2xl border p-4 text-left transition-all duration-quick ease-standard cavecms-focus-ring',
        selected
          ? 'border-copper-500 bg-copper-500/8 shadow-[0_10px_26px_-16px_rgba(184,115,51,0.7)]'
          : 'border-warm-stone/25 bg-cream-50/70 hover:border-copper-400/70 hover:bg-copper-500/4',
      )}
    >
      {/* Mini mock of the card. */}
      <span
        className="block overflow-hidden rounded-xl border border-warm-stone/20 bg-white"
        aria-hidden
      >
        {variant === 'large' ? (
          <>
            <span className="flex h-16 w-full items-center justify-center bg-gradient-to-br from-cream-100 to-warm-stone/15 text-warm-stone">
              <ImageIcon size={20} strokeWidth={1.6} />
            </span>
            <span className="block px-3 py-2">
              <span className="block h-2 w-3/4 rounded-full bg-near-black/70" />
              <span className="mt-1.5 block h-1.5 w-full rounded-full bg-warm-stone/30" />
              <span className="mt-1 block h-1.5 w-2/3 rounded-full bg-warm-stone/25" />
            </span>
          </>
        ) : (
          <span className="flex items-center gap-2.5 p-3">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-cream-100 to-warm-stone/15 text-warm-stone">
              <ImageIcon size={16} strokeWidth={1.6} />
            </span>
            <span className="block flex-1">
              <span className="block h-2 w-3/4 rounded-full bg-near-black/70" />
              <span className="mt-1.5 block h-1.5 w-full rounded-full bg-warm-stone/30" />
              <span className="mt-1 block h-1.5 w-1/2 rounded-full bg-warm-stone/25" />
            </span>
          </span>
        )}
      </span>
      <span>
        <span
          className={clsx(
            'block text-sm font-semibold',
            selected ? 'text-copper-800' : 'text-near-black',
          )}
        >
          {title}
        </span>
        <span className="mt-0.5 block text-[12px] leading-snug text-warm-stone">
          {caption}
        </span>
      </span>
    </button>
  )
}

// A handle input with a fixed leading "@" affordance so the operator
// types just the name. Stored with or without the @ — the renderer
// normalises either way (the schema accepts both).
function HandleField({
  label,
  help,
  value,
  onChange,
  placeholder,
}: {
  label: string
  help: string
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-near-black">{label}</span>
      <span className="mt-2 flex items-stretch overflow-hidden rounded-xl border border-warm-stone/25 bg-cream-50/80 transition-all duration-quick ease-standard focus-within:border-copper-400 focus-within:bg-white focus-within:ring-2 focus-within:ring-copper-300/40 hover:border-warm-stone/40">
        <span className="flex select-none items-center pl-4 pr-1 font-mono text-sm text-warm-stone">
          @
        </span>
        <input
          value={value.replace(/^@/, '')}
          maxLength={30}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value.replace(/^@/, ''))}
          className="min-h-[44px] flex-1 bg-transparent py-3 pr-4 text-sm text-near-black placeholder:text-warm-stone/60 focus:outline-none"
        />
      </span>
      <span className="mt-1 block text-[11px] text-warm-stone">{help}</span>
    </label>
  )
}

// ───────────────────────────── Schema ─────────────────────────────

function SchemaCard({
  initial,
  version: initialVersion,
}: {
  initial: SchemaValue
  version: number
}) {
  const toast = useToast()
  const [form, setForm] = useState<SchemaValue>(initial)
  const [pristine, setPristine] = useState<SchemaValue>(initial)
  const [version, setVersion] = useState(initialVersion)
  const [busy, setBusy] = useState(false)
  const dirty = useMemo(() => !structuralEqual(form, pristine), [form, pristine])

  const isPerson = form.entityType === 'Person'

  const save = useCallback(async () => {
    if (busy || !dirty) return
    setBusy(true)
    try {
      const payload: SchemaValue = {
        entityType: form.entityType,
        breadcrumbsEnabled: form.breadcrumbsEnabled,
        articleType: form.articleType,
        websiteSearchAction: form.websiteSearchAction,
      }
      // personName only matters for the Person entity; send it trimmed,
      // omit when blank.
      if (form.entityType === 'Person') {
        const name = (form.personName ?? '').trim()
        if (name) payload.personName = name
      }

      const r = await csrfFetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'seo_schema', value: payload, version }),
      })
      if (r.status === 400 || r.status === 422) {
        toast.error('Those structured-data settings look off — check them and try again.')
        return
      }
      if (r.status === 409) {
        toast.error('Settings changed in another tab. Refresh to see them.')
        return
      }
      if (!r.ok) {
        toast.error("That didn't save. Try again in a moment.")
        return
      }
      // Adopt the authoritative server version (additive) — no-op saves
      // don't bump the DB version, so blind v + 1 desyncs + 409s next.
      const respBody = (await r.json().catch(() => null)) as { version?: number } | null
      setForm(payload)
      setPristine(payload)
      setVersion(typeof respBody?.version === 'number' ? respBody.version : (v) => v + 1)
      toast.success('Structured-data settings saved.')
    } finally {
      setBusy(false)
    }
  }, [busy, dirty, form, version, toast])

  return (
    <SeoCard
      title="Structured data"
      eyebrow="Schema.org"
      help="Background information that helps Google understand who you are and how your content is organised. It powers richer search results."
      dirty={dirty}
      busy={busy}
      onSave={() => void save()}
      onUndo={() => setForm(pristine)}
    >
      <div className="space-y-7">
        {/* Entity type — visual Org / Person toggle tiles. */}
        <div>
          <p className="text-sm font-medium text-near-black">
            Who is behind this site?
          </p>
          <p className="mt-0.5 text-[13px] leading-relaxed text-warm-stone">
            Choose a company for a business or brand, or a person for a personal
            or portfolio site.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <EntityTile
              icon={Building2}
              title="A company or brand"
              caption="Business, agency, shop, or organisation"
              selected={form.entityType === 'Organization'}
              onSelect={() =>
                setForm((f) => ({ ...f, entityType: 'Organization' }))
              }
            />
            <EntityTile
              icon={User}
              title="A person"
              caption="Personal site, portfolio, or creator"
              selected={isPerson}
              onSelect={() => setForm((f) => ({ ...f, entityType: 'Person' }))}
            />
          </div>

          {isPerson && (
            <label className="mt-4 block animate-cavecms-slide-up">
              <span className="block text-sm font-medium text-near-black">
                Your name
              </span>
              <Input
                className="mt-2"
                value={form.personName ?? ''}
                maxLength={180}
                placeholder="e.g. Alex Rivera"
                onChange={(e) =>
                  setForm((f) => ({ ...f, personName: e.target.value }))
                }
              />
              <span className="mt-1 block text-[11px] text-warm-stone">
                Shown to search engines as the person this site represents.
              </span>
            </label>
          )}
        </div>

        {/* Article type select. */}
        <label className="block">
          <span className="block text-sm font-medium text-near-black">
            Default type for blog posts
          </span>
          <div className="mt-2 max-w-sm">
            <Select
              value={form.articleType}
              options={ARTICLE_TYPES}
              onChange={(v) =>
                setForm((f) => ({
                  ...f,
                  articleType: v as SchemaValue['articleType'],
                }))
              }
              aria-label="Default article type"
            />
          </div>
          <span className="mt-1 block text-[11px] text-warm-stone">
            How Google should categorise your posts. “Blog post” fits most
            sites; choose “News article” only if you publish journalism.
          </span>
        </label>

        {/* Switches. */}
        <Switch
          label="Show the path to each page (breadcrumbs)"
          help="Lets Google show a tidy “Home › Section › Page” trail under your result instead of a raw URL. Recommended on."
          checked={form.breadcrumbsEnabled}
          onChange={(v) => setForm((f) => ({ ...f, breadcrumbsEnabled: v }))}
        />

        <Switch
          label="Google sitelinks search box"
          help="Lets Google add a small search box for your site directly in its results. Turn on if you have site search and want this to appear."
          checked={form.websiteSearchAction}
          onChange={(v) =>
            setForm((f) => ({ ...f, websiteSearchAction: v }))
          }
        />

        {/* Pointer to the Organization fields (live elsewhere). */}
        <div className="flex items-start gap-3 rounded-xl bg-cream-100/40 p-4">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-copper-500/12 text-copper-700">
            <TypeIcon size={16} strokeWidth={1.9} aria-hidden />
          </span>
          <p className="text-[13px] leading-relaxed text-warm-stone">
            Your organisation’s name, logo, and social profiles live under{' '}
            <Link
              href="/admin/settings"
              className="font-medium text-copper-700 underline-offset-2 hover:underline"
            >
              Settings → Organization
            </Link>
            . They feed the same structured data and only need to be entered
            once.
          </p>
        </div>
      </div>
    </SeoCard>
  )
}

// A visual entity-type tile (company vs person) — icon + label + caption,
// copper-ringed when selected (#0.59).
function EntityTile({
  icon: Icon,
  title,
  caption,
  selected,
  onSelect,
}: {
  icon: LucideIcon
  title: string
  caption: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={clsx(
        'flex items-start gap-3 rounded-2xl border p-4 text-left transition-all duration-quick ease-standard cavecms-focus-ring',
        selected
          ? 'border-copper-500 bg-copper-500/8 shadow-[0_10px_26px_-16px_rgba(184,115,51,0.7)]'
          : 'border-warm-stone/25 bg-cream-50/70 hover:border-copper-400/70 hover:bg-copper-500/4',
      )}
    >
      <span
        className={clsx(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors duration-quick',
          selected
            ? 'bg-copper-500/15 text-copper-700'
            : 'bg-cream-100/60 text-warm-stone',
        )}
      >
        <Icon size={20} strokeWidth={1.8} aria-hidden />
      </span>
      <span>
        <span
          className={clsx(
            'block text-sm font-semibold',
            selected ? 'text-copper-800' : 'text-near-black',
          )}
        >
          {title}
        </span>
        <span className="mt-0.5 block text-[12px] leading-snug text-warm-stone">
          {caption}
        </span>
      </span>
    </button>
  )
}
