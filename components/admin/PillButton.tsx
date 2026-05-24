'use client'

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import clsx from 'clsx'
import {
  PILL_BASE,
  VARIANT_CLASS,
  SIZE_CLASS,
  ICON_SIZE,
  type PillVariant,
  type PillSize,
} from './pillStyle'

// Reusable pill-shaped button used across admin row actions, bulk
// action bars, and table action cells. The previous codebase repeated
// the same `inline-flex w-fit items-center gap-1 rounded-full border …`
// chain in 11+ places with subtle drift between callsites; this
// component is the single source of truth for clickable pill chrome.
//
// Variant + size matrices live in `./pillStyle` so non-button consumers
// (e.g., public admin-bar links) can compose the same chrome onto a
// different semantic element without duplicating Tailwind class strings.

export type { PillVariant, PillSize }

interface PillButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  icon?: LucideIcon
  variant?: PillVariant
  size?: PillSize
  className?: string
  /** Optional explicit aria-label. When children are visible text the
   *  default button label is fine; on icon-only pills pass this. */
  ariaLabel?: string
  children?: ReactNode
}

export const PillButton = forwardRef<HTMLButtonElement, PillButtonProps>(
  function PillButton(
    {
      icon: Icon,
      variant = 'subtle',
      size = 'sm',
      className,
      ariaLabel,
      children,
      type,
      ...rest
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type ?? 'button'}
        aria-label={ariaLabel}
        className={clsx(
          PILL_BASE,
          VARIANT_CLASS[variant],
          SIZE_CLASS[size],
          className,
        )}
        {...rest}
      >
        {Icon && <Icon size={ICON_SIZE[size]} strokeWidth={2.2} />}
        {children}
      </button>
    )
  },
)
