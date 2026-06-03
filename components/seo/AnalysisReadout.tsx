'use client'

import { useMemo } from 'react'
import {
  Search,
  BookOpen,
  CircleCheck,
  CircleDot,
  CircleAlert,
  type LucideIcon,
} from 'lucide-react'
import clsx from 'clsx'
import type {
  AnalysisResult,
  Assessment,
  Rating,
} from '@/lib/seo/analysis/types'

// ─────────────────────────────────────────────────────────────────────
// Analysis readout cluster — extracted from PageSeoPanel (M1). Two
// grouped traffic-light lists + score rings, plus the rating-dot,
// score-ring and skeleton primitives they compose. Pure presentational;
// the panel owns the live analysis state and threads results in.
// ─────────────────────────────────────────────────────────────────────

export function AnalysisReadout({
  seo,
  readability,
  pending,
  hasKeyphrase,
}: {
  seo: AnalysisResult | null
  readability: AnalysisResult | null
  pending: boolean
  hasKeyphrase: boolean
}) {
  return (
    <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <ScorerGroup
        icon={Search}
        title="SEO analysis"
        result={seo}
        pending={pending && !seo}
        emptyHint={
          hasKeyphrase
            ? 'Add more content to analyze.'
            : 'Set a focus keyphrase to grade your content.'
        }
      />
      <ScorerGroup
        icon={BookOpen}
        title="Readability"
        result={readability}
        pending={pending && !readability}
        emptyHint="Add more content to analyze."
      />
    </section>
  )
}

function ScorerGroup({
  icon: Icon,
  title,
  result,
  pending,
  emptyHint,
}: {
  icon: LucideIcon
  title: string
  result: AnalysisResult | null
  pending: boolean
  emptyHint: string
}) {
  // Sort bad → ok → good so the most actionable checks sit at the top.
  const ordered = useMemo(() => {
    if (!result) return []
    const rank: Record<Rating, number> = { bad: 0, ok: 1, good: 2 }
    return [...result.assessments].sort(
      (a, b) => rank[a.rating] - rank[b.rating],
    )
  }, [result])

  const empty = !result || result.assessments.length === 0

  return (
    <article className="rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-5 backdrop-blur-sm">
      <header className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-near-black/[0.04] text-near-black/70"
          >
            <Icon size={15} strokeWidth={1.9} />
          </span>
          <h3 className="font-serif text-base font-semibold tracking-tight text-near-black">
            {title}
          </h3>
        </span>
        <ScoreRing score={result?.score ?? null} rating={result?.rating ?? null} />
      </header>

      <div className="mt-4">
        {pending && empty ? (
          <SkeletonRows />
        ) : empty ? (
          <p className="rounded-xl bg-near-black/[0.03] px-4 py-6 text-center text-[12px] text-warm-stone">
            {emptyHint}
          </p>
        ) : (
          <ul className="space-y-2.5">
            {ordered.map((a, i) => (
              <AssessmentRow key={a.id} assessment={a} index={i} />
            ))}
          </ul>
        )}
      </div>
    </article>
  )
}

function AssessmentRow({
  assessment,
  index,
}: {
  assessment: Assessment
  index: number
}) {
  return (
    <li
      className="flex items-start gap-3 animate-cavecms-fade-in"
      style={{ animationDelay: `${Math.min(index, 10) * 35}ms` }}
    >
      <TrafficDot rating={assessment.rating} />
      <span className="text-[12.5px] leading-relaxed text-near-black/80">
        {assessment.text}
      </span>
    </li>
  )
}

// Rating indicator. Colour stays on-brand (good → copper, ok → amber,
// bad → red), but the rating is NO LONGER conveyed by colour alone
// (WCAG 1.4.1, M2): each rating has a DISTINCT lucide glyph AND a
// visually-hidden text label, so the rating reads for screen readers and
// for anyone who can't distinguish the hues. A soft halo keeps the
// jewel-like read of the original dot.
const RATING_META: Record<
  Rating,
  { icon: LucideIcon; label: string; tone: string; halo: string }
> = {
  good: {
    icon: CircleCheck,
    label: 'Good',
    tone: 'text-copper-600',
    halo: 'shadow-[0_0_0_3px_rgba(184,115,51,0.16)]',
  },
  ok: {
    icon: CircleDot,
    label: 'Needs work',
    tone: 'text-amber-600',
    halo: 'shadow-[0_0_0_3px_rgba(245,158,11,0.16)]',
  },
  bad: {
    icon: CircleAlert,
    label: 'Problem',
    tone: 'text-red-600',
    halo: 'shadow-[0_0_0_3px_rgba(239,68,68,0.16)]',
  },
}

export function TrafficDot({ rating }: { rating: Rating }) {
  const meta = RATING_META[rating]
  const Icon = meta.icon
  return (
    <span
      className={clsx(
        'mt-[3px] inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
        meta.tone,
        meta.halo,
      )}
    >
      <Icon size={14} strokeWidth={2.4} aria-hidden />
      <span className="sr-only">{meta.label}: </span>
    </span>
  )
}

// Circular score ring (0–100) drawn with two stacked conic gradients so
// it stays crisp at any size without an SVG asset. Copper for good,
// amber for ok, red for bad — same scale as the dots.
function ScoreRing({
  score,
  rating,
}: {
  score: number | null
  rating: Rating | null
}) {
  const value = score ?? 0
  const color =
    rating === 'good'
      ? '#B87333'
      : rating === 'ok'
        ? '#F59E0B'
        : rating === 'bad'
          ? '#EF4444'
          : '#C9BBA8'
  const textColor =
    rating === 'good'
      ? 'text-copper-700'
      : rating === 'ok'
        ? 'text-amber-700'
        : rating === 'bad'
          ? 'text-red-700'
          : 'text-warm-stone'
  return (
    <span
      className="relative inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full"
      style={{
        background: `conic-gradient(${color} ${value * 3.6}deg, rgba(110,102,90,0.14) 0deg)`,
        transition: 'background var(--duration-standard) var(--ease-standard)',
      }}
      role="img"
      aria-label={score === null ? 'Not scored yet' : `Score ${value} out of 100`}
    >
      <span className="absolute inset-[3px] flex items-center justify-center rounded-full bg-cream-50">
        <span
          className={clsx(
            'text-[13px] font-semibold tabular-nums tracking-tight',
            textColor,
          )}
        >
          {score === null ? '—' : value}
        </span>
      </span>
    </span>
  )
}

function SkeletonRows() {
  return (
    <ul className="space-y-3">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="flex items-center gap-3">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-warm-stone/20" />
          <span
            className="h-3 flex-1 rounded-full bg-warm-stone/12"
            style={{ maxWidth: `${90 - i * 12}%` }}
          />
        </li>
      ))}
    </ul>
  )
}
