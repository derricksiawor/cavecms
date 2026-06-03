'use client'

import { useCallback, useRef, useState } from 'react'
import { structuralEqual } from '@/lib/structuralEqual'
import {
  type PanelSeoMeta,
  isEmptySeoMeta,
} from '@/lib/cms/seoEditorFields'

// ─────────────────────────────────────────────────────────────────────
// useSeoFields — the ONE place the per-entity SEO editor fields (migration
// 0032) live for the blog + project editors. Both editors copy-pasted the
// same six useState pairs, the scoresRef + onScores callback, the pristine
// snapshot, the dirty-compare, the buildPatch fragment, the
// reset-on-save, the discard, and a literally-duplicated `isEmptySeoMeta`.
// This hook owns all of it so the empty-bag + null logic lives once
// (alongside the panel's normalized representation, #3 / C3).
//
// The PAGE editor keeps its own debounced SAVE trigger (a justified
// divergence — pages save per-field on blur + a coalesced SEO batch, not
// through useAutoSave's single buildPatch path), but it consumes the SAME
// `isEmptySeoMeta` from lib/cms/seoEditorFields so the empty-bag rule is
// shared there too.
// ─────────────────────────────────────────────────────────────────────

export { isEmptySeoMeta }

/** The initial (server-loaded) SEO field values. Booleans already coerced
 *  from TINYINT by the server page; `seoMeta` already parsed + normalized
 *  by parseSeoMeta. */
export interface SeoFieldsInitial {
  focusKeyphrase: string | null
  robotsNoindex: boolean
  robotsNofollow: boolean
  canonicalUrl: string | null
  cornerstone: boolean
  seoMeta: PanelSeoMeta
}

export interface UseSeoFields {
  values: {
    focusKeyphrase: string
    robotsNoindex: boolean
    robotsNofollow: boolean
    canonicalUrl: string
    cornerstone: boolean
    seoMeta: PanelSeoMeta
  }
  setters: {
    setFocusKeyphrase: (v: string) => void
    setRobotsNoindex: (v: boolean) => void
    setRobotsNofollow: (v: boolean) => void
    setCanonicalUrl: (v: string) => void
    setCornerstone: (v: boolean) => void
    setSeoMeta: (v: PanelSeoMeta) => void
  }
  /** Latest analysis scores, cached in a ref so a recompute never
   *  re-renders the editor. Passed to `onScores`. */
  scoresRef: React.MutableRefObject<{ seo: number; readability: number } | null>
  /** Stable callback handed to PageSeoPanel.onScores. */
  onScores: (seo: number, readability: number) => void
  /** True when any SEO field diverges from the last-saved snapshot. */
  dirty: boolean
  /** Merge the changed SEO fields (+ cached scores) into the editor's
   *  outgoing PATCH body. Mirrors the per-field delta detection the
   *  editors used inline: only changed fields are added; an empty
   *  override bag clears the column (null). */
  buildSeoPatch: (patch: Record<string, unknown>) => Record<string, unknown>
  /** After a successful save, snap the pristine snapshot to the current
   *  values so the bar returns to "all saved". */
  resetPristine: () => void
  /** Restore every SEO field to the last-saved snapshot (Discard). */
  discard: () => void
}

export function useSeoFields(initial: SeoFieldsInitial): UseSeoFields {
  const [focusKeyphrase, setFocusKeyphrase] = useState(
    initial.focusKeyphrase ?? '',
  )
  const [robotsNoindex, setRobotsNoindex] = useState(initial.robotsNoindex)
  const [robotsNofollow, setRobotsNofollow] = useState(initial.robotsNofollow)
  const [canonicalUrl, setCanonicalUrl] = useState(initial.canonicalUrl ?? '')
  const [cornerstone, setCornerstone] = useState(initial.cornerstone)
  const [seoMeta, setSeoMeta] = useState<PanelSeoMeta>(initial.seoMeta)

  const scoresRef = useRef<{ seo: number; readability: number } | null>(null)
  const onScores = useCallback((seo: number, readability: number) => {
    scoresRef.current = { seo, readability }
  }, [])

  // Pristine snapshot — the saved baseline the dirty marker compares to.
  const [pristine, setPristine] = useState({
    focusKeyphrase: initial.focusKeyphrase ?? '',
    robotsNoindex: initial.robotsNoindex,
    robotsNofollow: initial.robotsNofollow,
    canonicalUrl: initial.canonicalUrl ?? '',
    cornerstone: initial.cornerstone,
    seoMeta: initial.seoMeta,
  })

  const seoMetaDirty = !structuralEqual(seoMeta, pristine.seoMeta)
  const dirty =
    focusKeyphrase !== pristine.focusKeyphrase ||
    robotsNoindex !== pristine.robotsNoindex ||
    robotsNofollow !== pristine.robotsNofollow ||
    canonicalUrl !== pristine.canonicalUrl ||
    cornerstone !== pristine.cornerstone ||
    seoMetaDirty

  const buildSeoPatch = (
    patch: Record<string, unknown>,
  ): Record<string, unknown> => {
    if (focusKeyphrase !== pristine.focusKeyphrase) {
      patch.focusKeyphrase = focusKeyphrase === '' ? null : focusKeyphrase
    }
    if (robotsNoindex !== pristine.robotsNoindex) {
      patch.robotsNoindex = robotsNoindex
    }
    if (robotsNofollow !== pristine.robotsNofollow) {
      patch.robotsNofollow = robotsNofollow
    }
    if (canonicalUrl !== pristine.canonicalUrl) {
      patch.canonicalUrl = canonicalUrl === '' ? null : canonicalUrl
    }
    if (cornerstone !== pristine.cornerstone) {
      patch.cornerstone = cornerstone
    }
    if (seoMetaDirty) {
      // An empty override bag clears the column; otherwise ship the bag.
      patch.seoMeta = isEmptySeoMeta(seoMeta) ? null : seoMeta
    }
    // Cache the latest analysis scores alongside any SEO-affecting change
    // so listing / overview surfaces have a fresh number without re-running
    // the engine server-side.
    if (scoresRef.current) {
      patch.seoScore = scoresRef.current.seo
      patch.readabilityScore = scoresRef.current.readability
    }
    return patch
  }

  const resetPristine = () => {
    setPristine({
      focusKeyphrase,
      robotsNoindex,
      robotsNofollow,
      canonicalUrl,
      cornerstone,
      seoMeta,
    })
  }

  const discard = () => {
    setFocusKeyphrase(pristine.focusKeyphrase)
    setRobotsNoindex(pristine.robotsNoindex)
    setRobotsNofollow(pristine.robotsNofollow)
    setCanonicalUrl(pristine.canonicalUrl)
    setCornerstone(pristine.cornerstone)
    setSeoMeta(pristine.seoMeta)
  }

  return {
    values: {
      focusKeyphrase,
      robotsNoindex,
      robotsNofollow,
      canonicalUrl,
      cornerstone,
      seoMeta,
    },
    setters: {
      setFocusKeyphrase,
      setRobotsNoindex,
      setRobotsNofollow,
      setCanonicalUrl,
      setCornerstone,
      setSeoMeta,
    },
    scoresRef,
    onScores,
    dirty,
    buildSeoPatch,
    resetPristine,
    discard,
  }
}
