import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { registry, type SettingsKey } from '@/lib/cms/settings-registry'
import { getResolvedLoginPath } from '@/lib/security/getResolvedLoginPath'
import { RESERVED } from '@/lib/cms/page-slug'
import { PermalinksForm } from './PermalinksForm'

// Admin-only permalink configuration (Settings → Permalinks). Two keys:
// permalink_blog ({segment, structure}) + permalink_projects ({segment}).
// Server component reads both rows (synthesizing the registry default when a
// row hasn't been seeded yet, like every other settings surface), the LIVE
// login path + the sibling segments (for inline collision validation), and the
// full reserved word list (so the client can show a reserved-word error before
// even hitting the server). The form is custom (not the generic SettingsForm)
// because each card needs a live URL-structure preview + an old→new confirm
// modal that the generic ZodForm widgets can't express.

const PERMALINK_KEYS: SettingsKey[] = ['permalink_blog', 'permalink_projects']

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

interface SettingRow {
  key: string
  value: unknown
  version: number
  updated_at: Date
}

export default async function PermalinksSettingsPage() {
  await requireRoleOrRedirect(['admin'])

  const [rawRows] = (await db.execute(sql`
    SELECT \`key\`, value, version, updated_at
    FROM settings
    WHERE \`key\` IN ('permalink_blog', 'permalink_projects')
    ORDER BY \`key\`
  `)) as unknown as [SettingRow[]]

  const parsed = rawRows.map((r) => ({
    ...r,
    value:
      typeof r.value === 'string'
        ? (() => {
            try {
              return JSON.parse(r.value as string)
            } catch {
              return r.value
            }
          })()
        : r.value,
  }))

  const byKey = new Map(parsed.map((r) => [r.key, r]))
  const synthesizedNow = new Date()
  const rows = PERMALINK_KEYS.map((k) => {
    const existing = byKey.get(k)
    if (existing) return existing
    return {
      key: k,
      value: registry[k].default,
      version: 0,
      updated_at: synthesizedNow,
    }
  })

  // The live login path + the full reserved-word set drive the client form's
  // INLINE validation (so the operator sees "reserved word" / "matches your
  // sign-in path" before saving). The server PATCH guard remains the real
  // gate — this is UX, not the security boundary.
  const loginPath = await getResolvedLoginPath()
  const reservedWords = [...RESERVED]

  return (
    <div className="max-w-4xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Site settings
      </p>
      <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl">
        Permalinks
      </h1>
      <p className="mt-4 max-w-2xl text-sm font-medium leading-relaxed text-warm-stone">
        Choose the web address your blog and projects live under. Change the base
        word, or how a post&rsquo;s date appears in its link. Existing links keep
        working &mdash; the old addresses redirect to the new ones automatically.
      </p>
      <PermalinksForm
        initial={rows}
        loginPath={loginPath}
        reservedWords={reservedWords}
      />
    </div>
  )
}
