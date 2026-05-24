import { forwardRef, type InputHTMLAttributes } from 'react'
import clsx from 'clsx'

// Premium input with copper focus state, generous touch target, and
// cream surface that reads on both white and cream backgrounds.
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={clsx(
          'w-full rounded-xl border border-warm-stone/25 bg-cream-50/80 px-4 py-3 text-sm text-near-black placeholder:text-warm-stone/60 transition-all duration-quick ease-standard',
          'hover:border-warm-stone/40',
          'focus:border-copper-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-copper-300/40',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          'min-h-[44px]',
          className,
        )}
        {...rest}
      />
    )
  },
)
