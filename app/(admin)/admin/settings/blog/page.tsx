import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { registry } from '@/lib/cms/settings-registry'
import { BlogSettingsForm } from './BlogSettingsForm'

// Admin-only blog reading settings (Settings → Blog). WordPress
// "Reading"-style page that writes the single `blog_settings` row:
// posts-per-page, default Blog Loop layout/columns, excerpt vs full,
// show date / reading time, feed item count, related-posts count.
//
// The Blog Loop block (lx_posts in loop mode) reads layout / columns /
// showExcerpt / showDate / showReadingTime AUTHORITATIVELY from this row —
// Settings → Blog is the single source of truth for the blog index +
// archive display (these five have schema defaults that can't be cleanly
// per-block-overridden, so the setting wins; see lib/cms/hydrate.ts).
// postsPerPage stays block-overridable (optional, no default). feedItemCount
// + relatedPostsCount are consumed by the feed + related rail (Phase 7).
//
// Standard settings page pattern: server reads the row + version, the
// client form saves via PATCH /api/admin/settings (CSRF + optimistic lock).
// blog_settings is NOT a credential/reauth key, so a plain admin + CSRF save.

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

interface SettingRow {
  key: string
  value: unknown
  version: number
  updated_at: Date | string
}

export default async function BlogSettingsPage() {
  await requireRoleOrRedirect(['admin'])

  const [rows] = (await db.execute(sql`
    SELECT \`key\`, value, version, updated_at
    FROM settings
    WHERE \`key\` = 'blog_settings'
    LIMIT 1
  `)) as unknown as [SettingRow[]]

  const raw = rows[0]
  // mysql2 returns JSON columns as strings via raw SQL — parse once, fall
  // back to the registry default on a missing row or a tampered/corrupt
  // cell (same fail-closed-to-default contract as every other settings
  // surface). The Zod gate on the PATCH route remains the real validator.
  const parsedValue =
    raw && typeof raw.value === 'string'
      ? (() => {
          try {
            return JSON.parse(raw.value as string)
          } catch {
            return registry.blog_settings.default
          }
        })()
      : (raw?.value ?? registry.blog_settings.default)

  // Re-validate through the registry schema so the client form always
  // starts from a fully-shaped value (every field present, defaults filled)
  // even if the stored row predates a field or partially failed.
  const validated = registry.blog_settings.schema.safeParse(parsedValue)
  const value = validated.success
    ? validated.data
    : registry.blog_settings.default

  const initial = {
    value,
    version: raw?.version ?? 0,
  }

  return (
    <div className="max-w-4xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Site settings
      </p>
      <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl">
        Blog
      </h1>
      <p className="mt-4 max-w-2xl text-sm font-medium leading-relaxed text-warm-stone">
        Set how your blog reads by default — how many posts per page, the
        layout of the Blog Loop, and what shows on each card. The Blog Loop
        block uses these as its defaults; you can still override any of them on
        an individual block.
      </p>

      <BlogSettingsForm initial={initial} />
    </div>
  )
}
