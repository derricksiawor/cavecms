import Link from 'next/link'
import { unstable_cache } from 'next/cache'
import { sql } from 'drizzle-orm'
import { Sparkles } from 'lucide-react'
import { db } from '@/db/client'
import { estimateCostUsd, GEMINI_PRICING } from '@/lib/ai/pricing'
import { getSetting } from '@/lib/cms/getSettings'

// Compact dashboard card surfacing this month's AI activity:
//   - Proposals created (total + accepted)
//   - Tokens used (prompt + output, monthly aggregate)
//   - Estimated USD cost rolled up per model
//
// Gated on:
//   1. `role === 'admin'` (passed in by the parent — financial spend
//      telemetry must not leak to editor / viewer roles, which share
//      the dashboard route).
//   2. `ai_config.enabled === true` (no card on installs that haven't
//      configured AI).
//
// Fail-soft: any error in setting-read or SQL returns null so a
// transient DB blip doesn't 500 the whole dashboard. Errors are
// logged structured so operators can chase them via PM2 logs.
//
// Cached for 60s alongside the dashboard's other stats — keeps the
// admin home responsive even under repeat refresh and avoids a
// per-request scan of `ai_proposals`.

const CACHE_REVALIDATE_SEC = 60

interface UsageRow {
  model: string
  total: number | string | bigint
  accepted: number | string | bigint
  prompt_tokens: number | string | null | bigint
  output_tokens: number | string | null | bigint
}

interface UsageAggregate {
  total: number
  accepted: number
  promptTokens: number
  outputTokens: number
  costUsd: number
}

// Pre-computed for the cost-row tooltip. Stable across renders — no
// reason to rebuild this string per request.
const PRICING_TOOLTIP = Object.entries(GEMINI_PRICING)
  .map(
    ([id, p]) =>
      `${id}: $${p.inputPer1M.toFixed(2)} in · $${p.outputPer1M.toFixed(2)} out per 1M tokens`,
  )
  .join('\n')

function asNum(v: number | string | null | bigint | undefined): number {
  if (v === null || v === undefined) return 0
  // mysql2 returns BIGINT / DECIMAL as string when the value crosses
  // Number.MAX_SAFE_INTEGER. For dashboard aggregates we don't expect
  // to cross 2^53, but coerce defensively all the same. A negative
  // SUM (rejected by GREATEST in SQL) also flows through here.
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? Math.max(0, n) : 0
  }
  return Number.isFinite(v) ? Math.max(0, v) : 0
}

function formatUsd(n: number): string {
  if (n <= 0) return '$0.00'
  if (n < 0.01) return '< $0.01'
  return '$' + n.toFixed(2)
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

// Compute the first-of-month boundary in UTC so the card's "this
// month" semantics don't drift with the DB server's @@time_zone (a
// container restart in a different TZ could otherwise shift the
// window by hours). The MariaDB column `ai_proposals.created_at` is
// a TIMESTAMP — stored UTC, compared in UTC against this constant.
function utcMonthStartIso(): string {
  const now = new Date()
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
  )
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

const loadUsage = unstable_cache(
  async (since: string): Promise<UsageAggregate> => {
    // CAST AS SIGNED (then GREATEST 0) so a stray negative value in
    // tokens_usage doesn't wrap to ~2^64 and break the dashboard.
    // Gemini never emits negatives today; defensive.
    const [rows] = (await db.execute(sql`
      SELECT
        model,
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
        SUM(
          GREATEST(0, CAST(
            COALESCE(JSON_UNQUOTE(JSON_EXTRACT(tokens_usage, '$.promptTokens')), '0')
            AS SIGNED
          ))
        ) AS prompt_tokens,
        SUM(
          GREATEST(0, CAST(
            COALESCE(JSON_UNQUOTE(JSON_EXTRACT(tokens_usage, '$.outputTokens')), '0')
            AS SIGNED
          ))
        ) AS output_tokens
      FROM ai_proposals
      WHERE created_at >= ${since}
      GROUP BY model
    `)) as unknown as [UsageRow[]]

    let total = 0
    let accepted = 0
    let promptTokens = 0
    let outputTokens = 0
    let costUsd = 0
    for (const r of rows) {
      const rowTotal = asNum(r.total)
      const rowAccepted = asNum(r.accepted)
      const rowPrompt = asNum(r.prompt_tokens)
      const rowOutput = asNum(r.output_tokens)
      total += rowTotal
      accepted += rowAccepted
      promptTokens += rowPrompt
      outputTokens += rowOutput
      costUsd += estimateCostUsd(r.model, rowPrompt, rowOutput)
    }
    return { total, accepted, promptTokens, outputTokens, costUsd }
  },
  ['ai-usage-card', 'monthly'],
  { revalidate: CACHE_REVALIDATE_SEC, tags: ['admin-dashboard'] },
)

export async function AiUsageCard({ role }: { role: 'admin' | 'editor' | 'viewer' }) {
  // Admin-only — operational + financial telemetry not for editors /
  // viewers. The dashboard's other widgets (which DO render for those
  // roles) intentionally strip PII at the SELECT layer; this card
  // surfaces token + cost numbers, which editor/viewer roles should
  // not see.
  if (role !== 'admin') return null

  // Fail-soft: any DB / setting failure returns null so the rest of
  // the dashboard renders normally. Without this wrap a transient
  // network blip 500s the whole admin home.
  let agg: UsageAggregate
  try {
    const aiConfig = (await getSetting('ai_config')) as { enabled?: boolean }
    if (!aiConfig.enabled) return null
    agg = await loadUsage(utcMonthStartIso())
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'ai_usage_card_failed',
        err: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      }),
    )
    return null
  }

  return (
    <Link
      href="/admin/activity?resource_type=ai_proposal"
      className="group relative block overflow-hidden rounded-2xl border border-warm-stone/20 bg-cream-50/60 px-6 py-6 backdrop-blur-sm transition-all duration-standard hover:-translate-y-1 hover:border-copper-400 hover:shadow-[0_24px_50px_-22px_rgba(196,124,68,0.45)]"
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -top-12 -right-10 h-32 w-32 rounded-full bg-copper-300/20 blur-2xl"
      />
      <span
        aria-hidden="true"
        className="absolute inset-x-6 -bottom-px h-px bg-copper-500 opacity-0 transition-opacity group-hover:opacity-100"
      />
      <header className="flex items-center justify-between gap-3">
        <span className="relative inline-flex h-11 w-11 items-center justify-center rounded-full bg-cream-50 text-copper-700 ring-1 ring-warm-stone/15">
          <Sparkles size={20} strokeWidth={1.8} aria-hidden="true" />
        </span>
        <span className="rounded-full bg-copper-100/70 px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.2em] text-copper-700">
          This month
        </span>
      </header>
      <p className="relative mt-5 text-[10px] font-semibold uppercase tracking-[0.28em] text-warm-stone">
        AI proposals
      </p>
      <p className="relative mt-2 font-serif text-4xl font-bold tracking-tight text-near-black">
        {agg.total}
        <span className="ml-2 text-[12px] font-medium tracking-tight text-warm-stone">
          ({agg.accepted} accepted)
        </span>
      </p>
      <dl className="relative mt-5 grid grid-cols-2 gap-3 text-[11px]">
        <div>
          <dt className="font-semibold uppercase tracking-[0.18em] text-warm-stone">
            Tokens
          </dt>
          <dd className="mt-1 font-medium text-near-black">
            {formatTokens(agg.promptTokens)} in / {formatTokens(agg.outputTokens)} out
          </dd>
        </div>
        <div>
          <dt
            className="font-semibold uppercase tracking-[0.18em] text-warm-stone"
            title={PRICING_TOOLTIP}
          >
            Estimated cost
          </dt>
          <dd
            className="mt-1 font-medium text-near-black"
            title={PRICING_TOOLTIP}
          >
            {formatUsd(agg.costUsd)}{' '}
            <span className="text-warm-stone/70">(approx.)</span>
          </dd>
        </div>
      </dl>
    </Link>
  )
}
