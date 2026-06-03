// SVG section shape dividers (Elementor parity). Rendered absolutely at the
// top or bottom edge of a section, full-bleed, with preserveAspectRatio
// 'none' so the shape stretches to the section width at any viewport. The
// colour is the operator's choice (usually the adjacent section's bg) so the
// shape reads as a transition between two bands. Server component — pure SVG.

import type { ShapeDividerType } from '@/lib/cms/blockMeta'

// Each path is authored in a 0 0 1200 120 viewBox. preserveAspectRatio
// 'none' lets it stretch horizontally without distorting perceived height.
const PATHS: Record<Exclude<ShapeDividerType, 'none'>, string> = {
  wave: 'M0,40 C150,100 350,0 600,40 C850,80 1050,10 1200,50 L1200,120 L0,120 Z',
  tilt: 'M0,120 L1200,0 L1200,120 Z',
  curve: 'M0,120 C300,0 900,0 1200,120 Z',
  triangle: 'M0,120 L600,20 L1200,120 Z',
  mountains:
    'M0,120 L200,50 L380,95 L560,30 L760,90 L960,40 L1200,100 L1200,120 Z',
  split: 'M0,120 L0,60 C300,90 450,60 600,60 C750,60 900,90 1200,60 L1200,120 Z',
}

export function ShapeDivider({
  type,
  position,
  height = 80,
  color = '#ffffff',
  flipX = false,
}: {
  type: ShapeDividerType
  position: 'top' | 'bottom'
  height?: number
  color?: string
  flipX?: boolean
}) {
  if (type === 'none') return null
  // Top dividers are flipped vertically so the shape "hangs" from the top
  // edge into the section; flipX mirrors horizontally. Both via scale().
  const sx = flipX ? -1 : 1
  const sy = position === 'top' ? -1 : 1
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 z-[1] overflow-hidden leading-none"
      style={{ [position]: 0, height: `${height}px` }}
    >
      <svg
        viewBox="0 0 1200 120"
        preserveAspectRatio="none"
        className="block h-full w-full"
        style={{ transform: `scale(${sx}, ${sy})` }}
      >
        <path d={PATHS[type]} fill={color} />
      </svg>
    </div>
  )
}
