'use client'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'

// Premium accordion with a chevron-driven open/close, animated max-height
// expand, and an optional status dot in the trigger. Used instead of raw
// <details>/<summary> so editors get smooth motion + a richer trigger.
export function Accordion({
  id,
  title,
  subtitle,
  open,
  onToggle,
  hasContent,
  meta,
  children,
}: {
  id?: string
  title: string
  subtitle?: ReactNode
  open: boolean
  onToggle: (next: boolean) => void
  hasContent?: boolean
  meta?: ReactNode
  children: ReactNode
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [maxH, setMaxH] = useState<number | undefined>(open ? undefined : 0)

  // Resize observer so content height changes (e.g. user adds an item to
  // an object_array) trigger a smooth height transition rather than a
  // sudden jump.
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    if (!open) {
      setMaxH(0)
      return
    }
    const update = () => setMaxH(el.scrollHeight)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [open])

  return (
    <article
      id={id}
      className={clsx(
        'rounded-2xl border bg-cream-50/60 backdrop-blur-sm transition-all duration-standard',
        open ? 'border-copper-300/60 shadow-[0_12px_32px_-20px_rgba(184,115,51,0.35)]' : 'border-warm-stone/20',
      )}
    >
      <button
        type="button"
        onClick={() => onToggle(!open)}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-cream-100/60 cavecms-focus-ring rounded-2xl"
        aria-expanded={open}
      >
        <span className="flex items-center gap-3 min-w-0">
          <StatusDot active={Boolean(hasContent)} />
          <span className="min-w-0">
            <span className="block font-serif text-base font-semibold tracking-tight text-near-black truncate">
              {title}
            </span>
            {subtitle && (
              <span className="mt-0.5 block text-[11px] text-warm-stone truncate">
                {subtitle}
              </span>
            )}
          </span>
        </span>
        <span className="flex items-center gap-3 shrink-0">
          {meta}
          <Chevron open={open} />
        </span>
      </button>
      <div
        style={{
          maxHeight: maxH,
          transition: 'max-height var(--duration-standard) var(--ease-decelerate)',
        }}
        className="overflow-hidden"
      >
        <div ref={bodyRef} className="border-t border-warm-stone/15 px-5 py-5">
          {children}
        </div>
      </div>
    </article>
  )
}

function StatusDot({ active }: { active: boolean }) {
  return (
    <span
      aria-hidden
      className={clsx(
        'inline-flex h-2.5 w-2.5 shrink-0 rounded-full transition-colors',
        active ? 'bg-copper-500 shadow-[0_0_0_3px_rgba(184,115,51,0.18)]' : 'bg-warm-stone/30',
      )}
    />
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={clsx(
        'text-warm-stone transition-transform duration-standard ease-standard',
        open ? 'rotate-180' : 'rotate-0',
      )}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}
