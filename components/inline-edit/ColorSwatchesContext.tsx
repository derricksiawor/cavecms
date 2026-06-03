'use client'

import { createContext, useContext, type ReactNode } from 'react'

// Operator-defined global colour swatches (E18). Loaded from the
// `theme_swatches` setting at the editor root and surfaced as quick-pick
// chips in every ColorPickerField. "Define once, reuse everywhere."
export interface BrandSwatch {
  label: string
  color: string
}

const ColorSwatchesContext = createContext<BrandSwatch[]>([])

export function ColorSwatchesProvider({
  swatches,
  children,
}: {
  swatches: BrandSwatch[]
  children: ReactNode
}) {
  return (
    <ColorSwatchesContext.Provider value={swatches}>{children}</ColorSwatchesContext.Provider>
  )
}

export function useColorSwatches(): BrandSwatch[] {
  return useContext(ColorSwatchesContext)
}
