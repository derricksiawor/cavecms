// Derives the combined !-important Tailwind class string for a
// section / column / widget's per-side padding + margin meta. Pure
// value-layer (no client hooks, no server-only imports) so both the
// anonymous BlockTreeRenderer (server) and the editable
// EditableBlockTreeRenderer (client) read from the same derivation.
//
// Empty / partial meta returns '' so callers can clsx() it in without
// guarding. A missing side leaves the wrapper's natural padding in
// place — operators only override what they touch.

import {
  MARGIN_TIER_CLASS,
  PADDING_TIER_CLASS,
  isSpacingTier,
  type SpacingTier,
} from './spacingTokens'
import type { CSSProperties } from 'react'

// Per-axis value: either a named tier (compiled to a Tailwind class via
// PADDING_TIER_CLASS / MARGIN_TIER_CLASS) OR a raw pixel number. The
// pixel branch emits an inline `style` property because Tailwind JIT
// cannot detect dynamically-interpolated arbitrary values like
// `pt-[${n}px]` at build time. Operators reach for arbitrary px when
// the 7-tier scale (0/8/16/32/64/96/128) doesn't land their target
// value — e.g. 24px between two cards on a tight column.
export type SpacingValue = SpacingTier | number

export interface SpacingMeta {
  paddingTop?: SpacingValue
  paddingRight?: SpacingValue
  paddingBottom?: SpacingValue
  paddingLeft?: SpacingValue
  marginTop?: SpacingValue
  marginRight?: SpacingValue
  marginBottom?: SpacingValue
  marginLeft?: SpacingValue
}

/** Combined utility-class string for the 8 spacing axes (tier values
 *  only). Numeric axes are skipped here and surface via spacingStyle().
 *  Returns '' when no tier override is set. */
export function spacingClass(meta: SpacingMeta | null | undefined): string {
  if (!meta) return ''
  const parts: string[] = []
  if (isSpacingTier(meta.paddingTop)) parts.push(PADDING_TIER_CLASS.top[meta.paddingTop])
  if (isSpacingTier(meta.paddingRight)) parts.push(PADDING_TIER_CLASS.right[meta.paddingRight])
  if (isSpacingTier(meta.paddingBottom)) parts.push(PADDING_TIER_CLASS.bottom[meta.paddingBottom])
  if (isSpacingTier(meta.paddingLeft)) parts.push(PADDING_TIER_CLASS.left[meta.paddingLeft])
  if (isSpacingTier(meta.marginTop)) parts.push(MARGIN_TIER_CLASS.top[meta.marginTop])
  if (isSpacingTier(meta.marginRight)) parts.push(MARGIN_TIER_CLASS.right[meta.marginRight])
  if (isSpacingTier(meta.marginBottom)) parts.push(MARGIN_TIER_CLASS.bottom[meta.marginBottom])
  if (isSpacingTier(meta.marginLeft)) parts.push(MARGIN_TIER_CLASS.left[meta.marginLeft])
  return parts.join(' ')
}

/** Inline-style object for the numeric (px) axes. Returns `undefined`
 *  when no axis carries a numeric value so callers can spread without
 *  emitting an empty `style=""` attribute on every wrapper. The `!important`
 *  on each property mirrors the tier-class behaviour so a per-side
 *  override beats the wrapper's natural padding at every breakpoint. */
export function spacingStyle(
  meta: SpacingMeta | null | undefined,
): CSSProperties | undefined {
  if (!meta) return undefined
  const out: Record<string, string> = {}
  if (typeof meta.paddingTop === 'number') out.paddingTop = `${meta.paddingTop}px`
  if (typeof meta.paddingRight === 'number') out.paddingRight = `${meta.paddingRight}px`
  if (typeof meta.paddingBottom === 'number') out.paddingBottom = `${meta.paddingBottom}px`
  if (typeof meta.paddingLeft === 'number') out.paddingLeft = `${meta.paddingLeft}px`
  if (typeof meta.marginTop === 'number') out.marginTop = `${meta.marginTop}px`
  if (typeof meta.marginRight === 'number') out.marginRight = `${meta.marginRight}px`
  if (typeof meta.marginBottom === 'number') out.marginBottom = `${meta.marginBottom}px`
  if (typeof meta.marginLeft === 'number') out.marginLeft = `${meta.marginLeft}px`
  if (Object.keys(out).length === 0) return undefined
  return out as CSSProperties
}

/** True when any of the 8 spacing axes has an override. Used by the
 *  editor's SpacingOverlay to decide whether to render the per-edge
 *  paint at all (skip when nothing's overridden — overlay would
 *  match the natural padding which is misleading visual feedback).
 *
 *  NOTE on widget render-class duplication (Chunk E review L-G):
 *  The server BlockTreeRenderer + client EditableBlockTreeRenderer
 *  both call `spacingClass(parseWidgetMeta(meta))` inline. Pulling
 *  this into a shared `widgetOuterClass` helper here would create a
 *  circular import (blockMeta → spacingClasses for SpacingMeta;
 *  spacingClasses → blockMeta for parseWidgetMeta). A future third
 *  consumer should copy the inline pattern OR a fourth dedicated
 *  file (e.g. lib/cms/widgetClass.ts) should host the helper. */
export function hasSpacingOverride(meta: SpacingMeta | null | undefined): boolean {
  if (!meta) return false
  // `typeof v === 'string' || typeof v === 'number'` covers both
  // tier strings and px numbers; truthy-or-zero numbers (the operator
  // typing 0 to explicitly zero a side) count as overrides too.
  const isSet = (v: SpacingValue | undefined): boolean =>
    typeof v === 'string' || typeof v === 'number'
  return (
    isSet(meta.paddingTop) ||
    isSet(meta.paddingRight) ||
    isSet(meta.paddingBottom) ||
    isSet(meta.paddingLeft) ||
    isSet(meta.marginTop) ||
    isSet(meta.marginRight) ||
    isSet(meta.marginBottom) ||
    isSet(meta.marginLeft)
  )
}
