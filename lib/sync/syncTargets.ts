import 'server-only'
import { getSetting } from '@/lib/cms/getSettings'
import { updateSettingValue } from '@/lib/cms/writeSetting'
import {
  encryptSecret,
  decryptSecret,
  AAD_SYNC_TARGET_TOKEN,
} from '@/lib/security/secretCipher'

// Named local→remote sync targets. The bearer token for each target is stored
// AES-256-GCM encrypted-at-rest in the `sync_targets` setting; it is decrypted
// ONLY here, only at transfer time, and never logged or returned to a caller.
// This module is the single read/write boundary for that key — the dedicated
// /api/cms/sync/targets route + the push/pull orchestrator are its only users.

export class TargetNotFoundError extends Error {
  constructor(name: string) {
    super(`sync_target_not_found:${name}`)
  }
}
export class TargetTokenUnreadableError extends Error {
  constructor(name: string) {
    super(`sync_target_token_unreadable:${name}`)
  }
}

// A target as shown to an operator/agent — NEVER carries the token.
export interface RedactedTarget {
  name: string
  url: string
  last4?: string
  accountLabel?: string
  addedAt?: string
  isDefault: boolean
}

// A target resolved for an actual transfer — carries the DECRYPTED token. Stays
// in server memory for the duration of one push/pull; never serialized out.
export interface ResolvedTarget {
  name: string
  url: string
  token: string
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/** Redacted list for display (no tokens). */
export async function listTargets(): Promise<{
  targets: RedactedTarget[]
  defaultName: string | null
}> {
  const cfg = await getSetting('sync_targets')
  return {
    defaultName: cfg.defaultName ?? null,
    targets: cfg.targets.map((t) => ({
      name: t.name,
      url: t.url,
      last4: t.last4,
      accountLabel: t.accountLabel,
      addedAt: t.addedAt,
      isDefault: cfg.defaultName === t.name,
    })),
  }
}

/**
 * Resolve a target to push/pull against. `ref` is a configured target NAME, or
 * a raw http(s) URL (one-off, requires `explicitToken`). Returns the decrypted
 * token. Throws TargetNotFoundError / TargetTokenUnreadableError.
 */
export async function resolveTarget(
  ref: string,
  explicitToken?: string,
): Promise<ResolvedTarget> {
  const trimmed = ref.trim()
  // Raw-URL form: caller supplies the token inline (never persisted).
  if (/^https?:\/\//i.test(trimmed)) {
    if (!explicitToken || !explicitToken.trim()) {
      throw new TargetNotFoundError(trimmed)
    }
    return { name: trimmed, url: normalizeUrl(trimmed), token: explicitToken.trim() }
  }
  const cfg = await getSetting('sync_targets')
  const t = cfg.targets.find((x) => x.name.toLowerCase() === trimmed.toLowerCase())
  if (!t) throw new TargetNotFoundError(trimmed)
  if (explicitToken && explicitToken.trim()) {
    // Inline override of a stored target's token (e.g. just-rotated).
    return { name: t.name, url: normalizeUrl(t.url), token: explicitToken.trim() }
  }
  let token: string
  try {
    token = decryptSecret(t.token, AAD_SYNC_TARGET_TOKEN)
  } catch {
    throw new TargetTokenUnreadableError(t.name)
  }
  return { name: t.name, url: normalizeUrl(t.url), token }
}

/** Resolve the default target (or the only one), for a no-arg push/pull. */
export async function resolveDefaultTarget(): Promise<ResolvedTarget> {
  const cfg = await getSetting('sync_targets')
  const name =
    cfg.defaultName ?? (cfg.targets.length === 1 ? cfg.targets[0]!.name : null)
  if (!name) throw new TargetNotFoundError('(default)')
  return resolveTarget(name)
}

/**
 * Create or update a named target. Encrypts the token at rest, stores a
 * non-secret last4 for display, and marks it the default when it's the first.
 * Returns the redacted view of the saved target.
 */
export async function upsertTarget(
  input: { name: string; url: string; token: string; accountLabel?: string },
  userId: number | null,
): Promise<RedactedTarget> {
  const name = input.name.trim()
  const url = normalizeUrl(input.url)
  const token = input.token.trim()
  const envelope = encryptSecret(token, AAD_SYNC_TARGET_TOKEN)
  const last4 = token.length >= 4 ? token.slice(-4) : undefined
  const addedAt = new Date().toISOString()
  const next = await updateSettingValue(
    'sync_targets',
    (cur) => {
      const targets = cur.targets.filter(
        (t) => t.name.toLowerCase() !== name.toLowerCase(),
      )
      targets.push({
        name,
        url,
        token: envelope,
        last4,
        accountLabel: input.accountLabel,
        addedAt,
      })
      return {
        targets,
        // First target becomes the default automatically.
        defaultName: cur.defaultName ?? name,
      }
    },
    userId,
  )
  const isDefault = next.defaultName === name
  return { name, url, last4, accountLabel: input.accountLabel, addedAt, isDefault }
}

/** Remove a named target; clears the default if it pointed there. */
export async function removeTarget(
  name: string,
  userId: number | null,
): Promise<{ removed: boolean }> {
  let removed = false
  await updateSettingValue(
    'sync_targets',
    (cur) => {
      const targets = cur.targets.filter((t) => {
        const hit = t.name.toLowerCase() === name.trim().toLowerCase()
        if (hit) removed = true
        return !hit
      })
      let defaultName = cur.defaultName
      if (defaultName && defaultName.toLowerCase() === name.trim().toLowerCase()) {
        defaultName = targets[0]?.name ?? null
      }
      return { targets, defaultName }
    },
    userId,
  )
  return { removed }
}

/** Mark a target the default for no-arg push/pull. */
export async function setDefaultTarget(
  name: string,
  userId: number | null,
): Promise<{ ok: boolean }> {
  let ok = false
  await updateSettingValue(
    'sync_targets',
    (cur) => {
      const exists = cur.targets.some(
        (t) => t.name.toLowerCase() === name.trim().toLowerCase(),
      )
      if (!exists) return cur
      ok = true
      const canonical = cur.targets.find(
        (t) => t.name.toLowerCase() === name.trim().toLowerCase(),
      )!.name
      return { ...cur, defaultName: canonical }
    },
    userId,
  )
  return { ok }
}
