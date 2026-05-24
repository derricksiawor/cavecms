import 'server-only'
import { jwtVerify } from 'jose'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { env } from '@/lib/env'
import {
  JWT_AUD_PREVIEW as AUD_PREVIEW,
  JWT_ISS_PREVIEW as ISS_PREVIEW,
} from '@/lib/auth/jwt-claims'
import type { PageRawRow } from './types'

// Preview-token verifier for the pages CMS (spec §4.7). Mints live in
// PR-3's `POST /api/cms/pages/[id]/preview-token`; this file verifies
// what that route emits.
//
// Signature: discriminated input — the caller commits to whether the
// URL is being rendered at `/{slug}` (a request slug must match the
// resolved page's slug strictly) or at `/` (the home page; resolution
// keys on `is_home=1` instead). Strict-slug match — NEVER follow
// slug_redirects in preview mode (would let a token minted for page A
// be replayed against page B through a redirect chain).
//
// Header attachment lives in the calling route (NOT here) so we keep
// `next/server` response concerns out of the data-layer.
//
// LOGGING DISCIPLINE (locked by spec §4.7 step 5): this helper does
// NOT log on its own. The calling route MUST emit exactly
// `level: 'info', msg: 'preview_token_rejected', requestSlug` (or the
// home-route equivalent with `isHome: true`) on any { ok: false }
// outcome. The route MUST NOT include the `reason` field in any log
// line, response body, or response header. The `reason` field below
// is for control-flow use only — never forward to logs or responses.

const PREVIEW_KEY = new TextEncoder().encode(env.PREVIEW_SECRET)

// JWT headers we refuse to honour — kid/jwk/jku/x5u/x5c would let an
// attacker (without the secret) point verification at a key under their
// control. Mirrors the session-JWT hardening at lib/auth/jwt.ts:28.
const FORBIDDEN_HEADERS = ['kid', 'jku', 'jwk', 'x5u', 'x5c'] as const

export type VerifyPreviewInput =
  | { token: string; requestSlug: string; isHome?: false }
  | { token: string; isHome: true; requestSlug?: undefined }

// `reason` is for control-flow ONLY. Routes MUST NOT forward it to
// logs or responses — that would expose the same enumeration vector
// §5.2 closes for slugs (distinguishing epoch_mismatch from no_match
// would let a probe infer the existence of an unpublished page).
export type VerifyPreviewResult =
  | { ok: true; page: PageRawRow }
  | {
      ok: false
      reason:
        | 'invalid_signature'
        | 'no_match'
        | 'sub_mismatch'
        | 'epoch_mismatch'
        | 'db_error'
    }

export async function verifyPreviewToken(
  input: VerifyPreviewInput,
): Promise<VerifyPreviewResult> {
  // 1. JWT verify with algorithm + issuer + audience pinned. Any
  //    failure (bad MAC, expired, wrong iss/aud, alg-confusion via
  //    `none` or RS256 swap) lands here as a throw.
  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload']
  let protectedHeader: Awaited<ReturnType<typeof jwtVerify>>['protectedHeader']
  try {
    const verified = await jwtVerify(input.token, PREVIEW_KEY, {
      algorithms: ['HS256'],
      issuer: ISS_PREVIEW,
      audience: AUD_PREVIEW,
      clockTolerance: '5s',
    })
    payload = verified.payload
    protectedHeader = verified.protectedHeader
  } catch {
    return { ok: false, reason: 'invalid_signature' }
  }
  for (const bad of FORBIDDEN_HEADERS) {
    if ((protectedHeader as Record<string, unknown>)[bad]) {
      return { ok: false, reason: 'invalid_signature' }
    }
  }
  // 2. Resolve the page. Strict-slug match for the `{slug}` branch;
  //    `is_home=1` lookup for the home branch. NEVER follow
  //    slug_redirects in preview mode.
  //
  //    NOTE on `is_home=0` filter: the slug-branch lookup does NOT
  //    carry `AND is_home=0`. Per spec §4.7 step 2 the rule is strict
  //    slug match only; sub binding (step 3) pins the resolved row to
  //    the token's mint-time id, so cross-page replay through a
  //    rename + repurpose is foreclosed.
  //
  //    DB failures are absorbed as `db_error` (fail-closed) — the
  //    calling route 404s on any non-ok result, preserving the spec's
  //    "any preview failure → 404" enumeration defence even when
  //    MariaDB is degraded.
  let resolvedPage: PageRawRow | undefined
  try {
    if (input.isHome === true) {
      const [rows] = (await db.execute(sql`
        SELECT * FROM pages WHERE is_home = 1 AND deleted_at IS NULL LIMIT 1
      `)) as unknown as [PageRawRow[]]
      resolvedPage = rows[0]
    } else {
      const [rows] = (await db.execute(sql`
        SELECT * FROM pages WHERE slug = ${input.requestSlug} AND deleted_at IS NULL LIMIT 1
      `)) as unknown as [PageRawRow[]]
      resolvedPage = rows[0]
    }
  } catch {
    return { ok: false, reason: 'db_error' }
  }
  if (!resolvedPage) {
    return { ok: false, reason: 'no_match' }
  }
  // 3. Sub binding — pins the token to the page id at mint time.
  //    After a rename / restore / system-row replacement the slug
  //    may now point at a different id; the token would still verify
  //    against the secret but the resolved row's id will diverge.
  //    Explicit `typeof === 'string'` guard: jose types `sub` as
  //    `string | undefined` but a maliciously-shaped (MAC-valid)
  //    token could carry a non-string sub. The strict-equality below
  //    rejects it anyway, but the guard makes the intent explicit
  //    and keeps the type-narrowing tight.
  const expectedSub = `page:${resolvedPage.id}`
  if (typeof payload.sub !== 'string' || payload.sub !== expectedSub) {
    return { ok: false, reason: 'sub_mismatch' }
  }
  // 4. Epoch binding — revokes any token after unpublish / slug rename
  //    / soft-delete / is_home flip (the route handlers bump
  //    preview_epoch in the same UPDATE statement as those field
  //    changes per spec §4.3 step 8). Snake_case column read because
  //    raw `db.execute(sql\`SELECT *\`)` returns mysql2 verbatim rows
  //    — codebase convention (see lib/cms/types.ts:PageRawRow rationale).
  const epoch = payload['epoch']
  if (typeof epoch !== 'number' || epoch !== resolvedPage.preview_epoch) {
    return { ok: false, reason: 'epoch_mismatch' }
  }
  return { ok: true, page: resolvedPage }
}
