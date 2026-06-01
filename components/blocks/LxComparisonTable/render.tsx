import clsx from 'clsx'
import { Check, Minus } from 'lucide-react'
import { MotionTarget } from '@/components/motion/MotionTarget'
import type { BlockData } from '@/lib/cms/block-registry'
import { isColorToken, resolveColorValue } from '@/lib/cms/designTokens'

// Comparison / feature matrix ("even better than Elementor"). Up to 4
// plan columns. Each row cell (c1..c4) is a plain string: "yes"/"true"/
// "✓" renders a champagne check, "no"/"false"/"-"/"" renders a dash,
// anything else renders as text. Horizontal-scrolls on mobile. Server
// component.

const TONE_TEXT: Record<string, string> = { obsidian: 'text-obsidian', ivory: 'text-ivory' }
const TRUE_SET = new Set(['yes', 'true', '✓', 'y', '✔', 'check'])
const FALSE_SET = new Set(['no', 'false', '-', '—', 'x', '✗', 'n', ''])

function Cell({ value }: { value: string | undefined }) {
  const v = (value ?? '').trim().toLowerCase()
  if (TRUE_SET.has(v)) return <Check className="mx-auto h-5 w-5 text-champagne" strokeWidth={2.5} aria-label="Yes" />
  if (FALSE_SET.has(v)) return <Minus className="mx-auto h-5 w-5 text-warm-stone/40" strokeWidth={2} aria-label="No" />
  return <span className="font-sans text-sm">{value}</span>
}

export function LxComparisonTable({
  data,
  outerClass,
}: {
  data: BlockData<'lx_comparison_table'>
  outerClass?: string
}) {
  const isToken = isColorToken(data.tone)
  const textClass = isToken ? TONE_TEXT[data.tone] : undefined
  const custom = !isToken ? resolveColorValue(data.tone) : undefined
  const cols = data.columns
  const cellKeys = ['c1', 'c2', 'c3', 'c4'] as const

  const composed = (
    <div className={clsx('mx-auto w-full max-w-4xl overflow-x-auto', outerClass)}>
      <table className={clsx('w-full border-collapse text-center', textClass)} style={custom ? { color: custom } : undefined}>
        <thead>
          <tr className="border-b border-champagne/30">
            <th className="px-4 py-4 text-left font-sans text-xs font-semibold uppercase tracking-eyebrow text-warm-stone">
              <span className="sr-only">Feature</span>
            </th>
            {cols.map((c, i) => (
              <th
                key={i}
                className={clsx(
                  'px-4 py-4 font-serif text-base font-bold tracking-tight',
                  data.highlightColumn === i && 'bg-champagne/10',
                )}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, ri) => (
            <tr key={ri} className="border-b border-warm-stone/15">
              <td className="px-4 py-3.5 text-left font-sans text-sm font-medium">{row.feature}</td>
              {cols.map((_, ci) => (
                <td
                  key={ci}
                  className={clsx('px-4 py-3.5', data.highlightColumn === ci && 'bg-champagne/[0.06]')}
                >
                  <Cell value={row[cellKeys[ci]!]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  if (data.animation === 'none') return composed
  return <MotionTarget preset={data.animation}>{composed}</MotionTarget>
}
