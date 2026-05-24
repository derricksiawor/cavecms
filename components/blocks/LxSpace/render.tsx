import clsx from 'clsx'
import type { BlockData } from '@/lib/cms/block-registry'

// Luxury vertical spacer. Renders an aria-hidden div whose height is
// drawn from the editorial spacing scale (--spacing-section-* in
// globals.css). Tailwind v4 derives `h-section-md` etc. from those
// custom properties automatically.
//
// Use sparingly inside sections — section padding handles most
// vertical rhythm. Spacers exist for the rare case where a
// composition needs an extra breath between two flowed widgets.

const SIZE_CLASS: Record<BlockData<'lx_space'>['size'], string> = {
  'section-xs': 'h-section-xs',
  'section-sm': 'h-section-sm',
  'section-md': 'h-section-md',
  'section-lg': 'h-section-lg',
  'section-xl': 'h-section-xl',
  'section-2xl': 'h-section-2xl',
}

export function LxSpace({
  data,
  outerClass,
}: {
  data: BlockData<'lx_space'>
  outerClass?: string
}) {
  return (
    <div
      aria-hidden="true"
      className={clsx(SIZE_CLASS[data.size], outerClass)}
    />
  )
}
