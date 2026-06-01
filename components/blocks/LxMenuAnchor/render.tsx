import clsx from 'clsx'
import type { BlockData } from '@/lib/cms/block-registry'

// Menu anchor (Elementor: Menu Anchor) — an invisible in-page jump
// target. Other blocks / nav links point at `#<anchorId>`. scroll-mt-24
// keeps a sticky header from covering the landing position. Renders
// nothing visible. Server component.

export function LxMenuAnchor({
  data,
  outerClass,
}: {
  data: BlockData<'lx_menu_anchor'>
  outerClass?: string
}) {
  return (
    <span
      id={data.anchorId}
      aria-hidden="true"
      className={clsx('block h-0 w-0 scroll-mt-24', outerClass)}
    />
  )
}
