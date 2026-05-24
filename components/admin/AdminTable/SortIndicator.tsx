import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react'
import type { SortDirection } from './helpers'

// Tiny tri-state chevron used in desktop column headers + as a visual
// affordance that the header is clickable when no sort is active.

export function SortIndicator({ state }: { state: SortDirection | null }) {
  if (state === 'asc') return <ChevronUp size={13} strokeWidth={2.2} />
  if (state === 'desc') return <ChevronDown size={13} strokeWidth={2.2} />
  return <ChevronsUpDown size={12} strokeWidth={1.8} className="opacity-60" />
}
