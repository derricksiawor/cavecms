import { forwardRef, type ButtonHTMLAttributes } from 'react'
import clsx from 'clsx'

// Luxury button primitive. Three variants cover every admin surface:
//   - primary  : copper-on-cream pill, the default save action.
//   - ghost    : outlined, used for secondary actions (Preview, Cancel).
//   - danger   : tinted red for destructive confirmations.
//
// 44px+ touch targets, copper focus rings, subtle motion on hover.
export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'primary' | 'ghost' | 'danger'
    size?: 'sm' | 'md' | 'lg'
  }
>(function Button({ className, variant = 'primary', size = 'md', ...rest }, ref) {
  return (
    <button
      ref={ref}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-full font-semibold uppercase tracking-[0.22em] transition-all duration-standard ease-standard disabled:opacity-40 disabled:cursor-not-allowed bwc-focus-ring select-none w-fit',
        size === 'sm' && 'px-4 py-2 text-[10px] min-h-[36px]',
        size === 'md' && 'px-6 py-3 text-[11px] min-h-[44px]',
        size === 'lg' && 'px-8 py-4 text-xs min-h-[52px]',
        variant === 'primary' &&
          'bg-near-black text-cream-50 hover:bg-copper-700 hover:shadow-[0_8px_24px_-12px_rgba(184,115,51,0.45)] hover:-translate-y-px active:translate-y-0',
        variant === 'ghost' &&
          'border border-warm-stone/30 bg-transparent text-near-black hover:border-copper-400 hover:text-copper-700 hover:bg-cream-50',
        variant === 'danger' &&
          'border border-red-300/60 bg-transparent text-red-700 hover:border-red-500 hover:bg-red-50/40',
        className,
      )}
      {...rest}
    />
  )
})
