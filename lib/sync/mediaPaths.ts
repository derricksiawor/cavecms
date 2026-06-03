// Shared, pure media-ref path helpers for the sync feature. No DB, no
// server-only imports — usable in the serializer (server), preflight
// validator (server), and media remap (server), and unit-testable.
//
// A "field" is a collectMediaPaths path: dot for nested objects, `[N]` for
// array indices, and the sentinel 'media_id' for a root-level binding.
// Examples: "image", "gallery[2]", "sections[0].hero.image".

export type Json = Record<string, unknown>

// Reserved keys that would let an attacker-controlled `_mediaRefs` field walk
// onto the prototype chain and pollute Object.prototype. The bundle uploader
// fully controls `_mediaRefs` keys (z.record(z.string())), so EVERY path
// segment is validated against these before traversal/assignment.
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

// True if `field` is a safe collectMediaPaths-shaped path (no prototype walk).
export function isSafeMediaField(field: string): boolean {
  if (field === 'media_id') return true
  for (const token of field.split('.')) {
    const m = /^([^[]+)((?:\[\d+\])*)$/.exec(token)
    if (!m) return false
    if (DANGEROUS_KEYS.has(m[1]!)) return false
  }
  return true
}

// Resolve the object that holds (or should hold) media_id at `field`.
// Returns null if any path segment is missing, not an own-property object, or
// names a prototype-chain key (__proto__ / constructor / prototype).
export function navigateHolder(root: Json, field: string): Json | null {
  if (field === 'media_id') return root
  let cur: unknown = root
  for (const token of field.split('.')) {
    const m = /^([^[]+)((?:\[\d+\])*)$/.exec(token)
    if (!m) return null
    const key = m[1]!
    if (DANGEROUS_KEYS.has(key)) return null
    // Own-property only — never follow an inherited/prototype property.
    if (!Object.prototype.hasOwnProperty.call(cur as object, key)) return null
    cur = (cur as Json)[key]
    const indices = m[2]!.match(/\d+/g)
    if (indices) {
      for (const i of indices) cur = (cur as unknown[] | undefined)?.[Number(i)]
    }
    if (cur == null) return null
  }
  return cur && typeof cur === 'object' && !Array.isArray(cur)
    ? (cur as Json)
    : null
}

// Set media_id at the holder for `field`. Returns true if applied.
export function setMediaIdAtPath(root: Json, field: string, mediaId: number): boolean {
  const holder = navigateHolder(root, field)
  if (!holder) return false
  holder.media_id = mediaId
  return true
}

type Step = { kind: 'key'; key: string } | { kind: 'idx'; idx: number }

function tokenize(field: string): Step[] | null {
  const steps: Step[] = []
  for (const seg of field.split('.')) {
    const m = /^([^[]+)((?:\[\d+\])*)$/.exec(seg)
    if (!m) return null
    if (DANGEROUS_KEYS.has(m[1]!)) return null
    steps.push({ kind: 'key', key: m[1]! })
    const idxs = m[2]!.match(/\d+/g)
    if (idxs) for (const i of idxs) steps.push({ kind: 'idx', idx: Number(i) })
  }
  return steps
}

// Remove the entire holder object/array-element at `field` (used when a media
// ref is dangling — a partial `{alt}` left in place would fail block validation
// in a confusing way; an absent field validates cleanly for optional media and
// fails with a clear "required" error for required media).
export function deleteAtPath(root: Json, field: string): boolean {
  if (field === 'media_id') {
    delete root.media_id
    return true
  }
  const steps = tokenize(field)
  if (!steps || steps.length === 0) return false
  let cur: unknown = root
  for (let i = 0; i < steps.length - 1; i++) {
    const s = steps[i]!
    if (s.kind === 'key') {
      if (!Object.prototype.hasOwnProperty.call(cur as object, s.key)) return false
      cur = (cur as Json)[s.key]
    } else {
      cur = (cur as unknown[] | undefined)?.[s.idx]
    }
    if (cur == null || typeof cur !== 'object') return false
  }
  const last = steps[steps.length - 1]!
  if (last.kind === 'key') {
    delete (cur as Json)[last.key]
    return true
  }
  if (Array.isArray(cur)) {
    cur.splice(last.idx, 1)
    return true
  }
  return false
}
