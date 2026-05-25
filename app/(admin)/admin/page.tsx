import Link from 'next/link'
import { unstable_cache } from 'next/cache'
import { sql } from 'drizzle-orm'
import { Inbox, Mail, Building2, type LucideIcon } from 'lucide-react'
import { db } from '@/db/client'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { humaniseAuditAction, humaniseResourceType } from '@/lib/admin/humanise'
import { UpdateAvailableCard } from '@/components/admin/UpdateAvailableCard'
import { getCurrentVersion } from '@/lib/updates/getCurrentVersion'

export const dynamic = 'force-dynamic'

// 60s revalidate: dashboard reads aggregate over the whole project +
// audit_log + notification_failures. Stale-by-a-minute is fine; the
// numbers exist to draw the operator toward a deeper page, not to
// trigger a workflow on the dashboard itself.
//
// IMPORTANT: this cache is GLOBAL (no per-role key). The cached
// payload must therefore be safe to surface to any role allowed on
// /admin (viewer included). `recent` rows DO NOT contain user_email
// — viewers shouldn't see which operator did which mutation. Per-
// role caching would explode the cache surface for a 60s page, so
// we trim PII at the SELECT instead.
const loadStats = unstable_cache(
  async () => {
    const [newLeadsRows] = (await db.execute(
      sql`SELECT COUNT(*) AS n FROM leads WHERE created_at > NOW(3) - INTERVAL 7 DAY`,
    )) as unknown as [Array<{ n: number | string }>]
    // Surface unresolved SMTP forensic rows + enqueue failures —
    // these are what /admin/activity?kind=smtp will display. Counting
    // notification_failures (not pending_emails directly) keeps the
    // dashboard semantics aligned with the operator-facing alerts
    // page; a "live but stuck" pending_emails row that hasn't yet
    // exhausted retries shouldn't alarm the operator.
    const [failedEmailsRows] = (await db.execute(
      sql`SELECT COUNT(*) AS n FROM notification_failures
          WHERE resolved_at IS NULL
            AND kind IN ('smtp_send','smtp_breaker_open','lead_email_enqueue_failed')`,
    )) as unknown as [Array<{ n: number | string }>]
    const [publishedProjectsRows] = (await db.execute(
      sql`SELECT COUNT(*) AS n FROM projects WHERE published = TRUE AND deleted_at IS NULL`,
    )) as unknown as [Array<{ n: number | string }>]
    // No JOIN to users — the dashboard intentionally omits the
    // operator email so this cache is safe to share with viewers.
    // Operators who need the email column should visit /admin/activity
    // which is admin-gated.
    const [recentRows] = (await db.execute(
      sql`SELECT id, action, resource_type, resource_id, created_at
          FROM audit_log
          ORDER BY id DESC LIMIT 10`,
    )) as unknown as [
      Array<{
        id: number
        action: string
        resource_type: string
        resource_id: string | null
        // drizzle's `db.execute(sql\`...\`)` returns datetime columns as
        // ISO-ish strings ("YYYY-MM-DD HH:MM:SS.sss"), unlike the query
        // builder which returns Date. Normalise at the call site.
        created_at: string | Date
      }>,
    ]
    return {
      // COUNT(*) returns a BIGINT which the mysql2 driver surfaces as
      // string when the value crosses Number.MAX_SAFE_INTEGER; coerce
      // here so the UI never renders "[object Object]" on a
      // particularly active database.
      newLeads7d: Number(newLeadsRows[0]?.n ?? 0),
      failedEmails: Number(failedEmailsRows[0]?.n ?? 0),
      publishedProjects: Number(publishedProjectsRows[0]?.n ?? 0),
      recent: recentRows,
    }
  },
  ['admin', 'dashboard', 'stats', 'v1'],
  { revalidate: 60, tags: ['admin-dashboard'] },
)

export default async function AdminHome() {
  const ctx = await requireRoleOrRedirect(['admin', 'editor', 'viewer'])
  const s = await loadStats()
  return (
    <div className="max-w-5xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Overview
      </p>
      <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl">
        Dashboard
      </h1>

      {/* Hero update card — only admins can act on updates. Server-
          resolves the running version so the card can skip the
          /check round-trip entirely on local-dev installs (where
          updates are disabled anyway). */}
      {ctx.role === 'admin' && (
        <div className="mt-12">
          <UpdateAvailableCard currentSha={getCurrentVersion().sha} />
        </div>
      )}

      <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        <Card
          icon={Inbox}
          label="New leads · 7d"
          value={s.newLeads7d}
          href="/admin/leads"
        />
        <Card
          icon={Mail}
          label="Email alerts"
          value={s.failedEmails}
          href="/admin/activity?kind=smtp"
          tone={s.failedEmails > 0 ? 'alert' : 'neutral'}
        />
        <Card
          icon={Building2}
          label="Published projects"
          value={s.publishedProjects}
          href="/admin/projects"
        />
      </div>

      <section className="mt-16">
        <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
          Recent activity
        </p>
        <h2 className="mt-3 font-serif text-2xl font-bold tracking-tight text-near-black">
          What&rsquo;s been happening
        </h2>
        <div className="mt-6 overflow-hidden rounded-2xl border border-warm-stone/20 bg-cream-50/60 backdrop-blur-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-warm-stone/20 text-left text-[10px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
                <th className="px-5 py-4">When</th>
                <th className="px-5 py-4">What happened</th>
                <th className="px-5 py-4">Where</th>
              </tr>
            </thead>
            <tbody>
              {s.recent.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-5 py-6 text-warm-stone">
                    Nothing has happened yet. As soon as you or your team make changes, they will show up here.
                  </td>
                </tr>
              ) : (
                s.recent.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-warm-stone/10 last:border-b-0"
                  >
                    <td className="px-5 py-4 text-xs text-warm-stone">
                      {new Date(r.created_at)
                        .toISOString()
                        .slice(0, 16)
                        .replace('T', ' ')}
                    </td>
                    <td className="px-5 py-4 text-xs font-medium text-near-black">
                      {humaniseAuditAction(r.action)}
                    </td>
                    <td className="px-5 py-4 text-xs text-warm-stone">
                      {humaniseResourceType(r.resource_type)}
                      {r.resource_id ? ` · ${r.resource_id}` : ''}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function Card({
  icon: Icon,
  label,
  value,
  href,
  tone = 'neutral',
}: {
  icon: LucideIcon
  label: string
  value: number
  href: string
  tone?: 'neutral' | 'alert'
}) {
  const alert = tone === 'alert' && value > 0
  const valueClass = alert
    ? 'mt-4 font-serif text-4xl font-bold tracking-tight text-copper-700'
    : 'mt-4 font-serif text-4xl font-bold tracking-tight text-near-black'
  return (
    <Link
      href={href}
      className="group relative block overflow-hidden rounded-2xl border border-warm-stone/20 bg-cream-50/60 px-6 py-6 backdrop-blur-sm transition-all duration-standard hover:-translate-y-1 hover:border-copper-400 hover:shadow-[0_24px_50px_-22px_rgba(196,124,68,0.45)]"
    >
      {/* Soft copper glow halo behind the icon for that premium depth. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -top-12 -right-10 h-32 w-32 rounded-full bg-copper-300/20 blur-2xl"
      />
      <span
        aria-hidden="true"
        className="absolute inset-x-6 -bottom-px h-px bg-copper-500 opacity-0 transition-opacity group-hover:opacity-100"
      />
      <span
        className={`relative inline-flex h-11 w-11 items-center justify-center rounded-full ring-1 ${
          alert
            ? 'bg-copper-500/15 text-copper-700 ring-copper-300/40'
            : 'bg-cream-50 text-copper-700 ring-warm-stone/15'
        }`}
      >
        <Icon size={20} strokeWidth={1.8} />
      </span>
      <p className="relative mt-5 text-[10px] font-semibold uppercase tracking-[0.28em] text-warm-stone">
        {label}
      </p>
      <p className={`relative ${valueClass}`}>{value}</p>
    </Link>
  )
}
