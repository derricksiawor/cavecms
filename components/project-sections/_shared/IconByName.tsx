'use client'
import { DynamicIcon, iconNames, type IconName } from 'lucide-react/dynamic'
import { Check } from 'lucide-react'
import { iconForAmenity } from './amenityIcons'

// Render-time resolver that bridges three eras of icon strings:
//
//  1. Legacy amenity keys ("pool", "smart-home", "elevator") — these
//     are aliases mapped to specific Lucide components by the curated
//     amenityIcons.ts registry. Predates the icon picker.
//  2. New picker output — Lucide kebab-case names ("waves", "arrow-up-
//     right", "shield-check") fed directly from
//     components/inline-edit/pickers/IconPicker.tsx (the picker enumerates
//     `iconNames` from lucide-react/dynamic).
//  3. Unknown / cleared — falls back to Check.
//
// Resolution order:
//   - empty / null → Check
//   - normalised key matches a Lucide kebab name → DynamicIcon (lazy-
//     imports the icon chunk on first paint, cached after)
//   - normalised key matches an amenity alias → static Lucide component
//     bundled at build time (no async)
//   - else → Check
//
// Lucide is checked FIRST because:
//   - It's the universe of names operators see in the picker (1952 vs
//     ~70 in the amenity registry).
//   - For names that happen to exist in both ("waves", "wifi"), both
//     paths resolve to the same component — no semantic drift.

const LUCIDE_NAME_SET = new Set<string>(iconNames as ReadonlyArray<string>)

function normaliseKey(name: string): string {
  return name.toLowerCase().trim().replace(/[\s_]+/g, '-')
}

type IconForwardProps = {
  name: string | null | undefined
  className?: string
  strokeWidth?: number | string
  size?: number | string
  'aria-hidden'?: boolean | 'true' | 'false'
}

export function IconByName({
  name,
  className,
  strokeWidth,
  size,
  'aria-hidden': ariaHidden,
}: IconForwardProps) {
  const shared = { className, strokeWidth, size, 'aria-hidden': ariaHidden }
  if (!name) return <Check {...shared} />
  const key = normaliseKey(name)

  // 1) Direct Lucide hit — fast path. Pass a `fallback` render-fn so
  // the SSR pass AND the async-import window both render the Check
  // glyph synchronously instead of an empty box. Without this, every
  // Lucide icon used in server-rendered content (IconList rows,
  // IconBox, LxChannelCard) flashed as a blank square until the per-
  // icon chunk resolved on the client — a Lighthouse/CLS regression
  // vs. the statically-bundled iconForAmenity it replaced.
  //
  // The fallback signature is `() => JSX.Element | null` (a thunk,
  // not a component), so we wrap Check in an arrow. The same `shared`
  // props (className/strokeWidth/etc.) flow into Check via closure so
  // the placeholder respects the consumer's sizing.
  if (LUCIDE_NAME_SET.has(key)) {
    const FallbackCheck = () => <Check {...shared} />
    return (
      <DynamicIcon
        name={key as IconName}
        fallback={FallbackCheck}
        {...shared}
      />
    )
  }

  // 2) Amenity alias — the existing curated registry. Returns a
  // statically-bundled Lucide component, or Check as the legacy
  // fallback. Either way it's safe to render synchronously.
  const Static = iconForAmenity(key)
  return <Static {...shared} />
}
