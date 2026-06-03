'use client'
import { useState, type ReactNode } from 'react'
import { Accordion } from '@/components/inline-edit/Accordion'

// An elegant numbered guide, collapsed inside an Accordion so a page can
// stack several engine guides without overwhelming the operator. Each
// step is a numbered copper coin + a title + body, and may carry an extra
// slot (a CopyField for the verification tag, a link to the console, a
// nested note). Used for the per-engine Google / Bing / Yandex
// verification walkthroughs on Connect & Verify.
//
// Two ways to use it:
//   • <SetupGuide title=… steps=… />            — self-contained accordion
//   • <SetupGuideSteps steps=… />               — just the numbered list,
//     when the caller already provides its own container/heading.

export interface GuideStep {
  title: string
  body: ReactNode
  /** Optional extra below the body — a CopyField, a link, a callout. */
  extra?: ReactNode
}

export function SetupGuide({
  title,
  subtitle,
  steps,
  /** Optional leading visual (an engine logo) rendered in the trigger. */
  leading,
  /** Open on first render. Defaults to collapsed. */
  defaultOpen = false,
}: {
  title: string
  subtitle?: ReactNode
  steps: GuideStep[]
  leading?: ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <Accordion
      title={title}
      subtitle={subtitle}
      open={open}
      onToggle={setOpen}
      hasContent
      meta={leading}
    >
      <SetupGuideSteps steps={steps} />
    </Accordion>
  )
}

export function SetupGuideSteps({ steps }: { steps: GuideStep[] }) {
  return (
    <ol className="space-y-5">
      {steps.map((step, i) => (
        <li key={i} className="flex gap-4">
          <span
            aria-hidden
            className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-copper-500/12 font-serif text-sm font-bold text-copper-700"
          >
            {i + 1}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-near-black">
              {step.title}
            </p>
            <div className="mt-1 text-sm leading-relaxed text-warm-stone">
              {step.body}
            </div>
            {step.extra && <div className="mt-3">{step.extra}</div>}
          </div>
        </li>
      ))}
    </ol>
  )
}
