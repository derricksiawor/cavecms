import type { ReactNode } from 'react'

// Project blocks render CONTAINED inside their section→column container,
// exactly like every other CMS block. An earlier version broke each band
// out to the full viewport width (`w-screen` + margin/translate) to
// mimic the legacy edge-to-edge project page, but that spilled the band
// OUT of the editable section frame — over the container outline in the
// editor and past the block boundary on the page. Project content must
// live IN THE BLOCKS, so this wrapper is now a passthrough; full-width
// tint, when wanted, comes from the host section's background (section
// meta), not from a per-block breakout.
//
// Kept as a thin wrapper (rather than deleted from all 11 renderers) so
// the contain-vs-bleed decision lives in one place if it ever changes.
export function ProjectFullBleed({ children }: { children: ReactNode }) {
  return <>{children}</>
}
