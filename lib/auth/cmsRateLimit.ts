import 'server-only'
import { HttpError } from './requireRole'
import { rateLimit } from './rateLimit'

// CMS-write throttle. Per-user sliding window — keyed by userId rather
// than IP because authenticated admins/editors typically share a single
// office NAT. Two-tier:
//
//  - mutations  300/min  PATCH/POST/DELETE/restore/reorder on blocks
//  - uploads    10/min   POST /api/cms/media (image processing is heavy)
//
// Both buckets are independent; an editor uploading 10 images doesn't
// exhaust their block-edit budget. Either bucket overflow → 429.
//
// The mutation budget was raised from 60 to 300/min to accommodate the
// AdminTable bulk-action surface — a bulk delete of 100 rows fans out
// 100 csrfFetch calls (concurrency-bounded at 4), and even at the
// previous 60/min limit a single bulk + a few inline edits could trip
// the budget. The underlying actions remain CSRF + role + auth gated;
// the rate limit is the last line of defense, not the first.
const limitMutations = rateLimit('cms:mutation:user', {
  limit: 300,
  windowSec: 60,
})
const limitUploads = rateLimit('cms:upload:user', {
  limit: 10,
  windowSec: 60,
})
// Reads (e.g. media list cursor-walk) are higher-volume than mutations
// but should still have a ceiling so a stolen-cookie attacker can't
// dump the entire table at single-request speed. 120/min per user is
// comfortable for an admin UI that lazy-loads media grids.
const limitReads = rateLimit('cms:read:user', {
  limit: 120,
  windowSec: 60,
})
// CSV export bucket — much tighter because each call buffers a
// keyset-batched stream over up to LEADS_EXPORT_MAX_ROWS rows and
// holds a DB connection for the duration. Five exports per minute
// per operator is generous for a human workflow and prevents a
// stolen-cookie attacker from chaining exports to OOM the node
// process.
const limitExports = rateLimit('cms:export:user', {
  limit: 5,
  windowSec: 60,
})
// AI provider verify bucket — tightest of all. Each call makes an
// outbound request to the operator's Gemini account, BURNING THEIR
// QUOTA + revealing key-validity to whoever holds the admin session.
// Without this, a compromised editor session could probe arbitrary
// Gemini keys at 300/min through the operator's box (the generic
// mutation bucket). 5/min keeps the verify-flow human-paced.
const limitAiVerify = rateLimit('cms:ai-verify:user', {
  limit: 5,
  windowSec: 60,
})

// PR 4 — Page Assistant chat bucket. Chat turns are heavier than
// inline rewrites (tool-call loops, multi-block context) so the
// budget is tighter than the inline bucket (30/min). 10/min still
// supports an editor having a back-and-forth conversation while
// hard-capping a runaway client.
const limitAiChat = rateLimit('cms:ai-chat:user', {
  limit: 10,
  windowSec: 60,
})

export function checkMutationRate(userId: number): void {
  if (!limitMutations(String(userId))) {
    throw new HttpError(429, 'rate_limited')
  }
}

// Per-TOKEN mutation budget — keyed by token id so an automated agent
// (MCP / script) cannot starve the human operator's per-user bucket. Higher
// ceiling than the human bucket (300/min) because agents legitimately batch
// fast; still a hard cap so a runaway client trips at a bounded rate.
const limitTokenMutations = rateLimit('cms:mutation:token', {
  limit: 600,
  windowSec: 60,
})

export function checkMutationRateForToken(tokenId: number): void {
  if (!limitTokenMutations(`t${tokenId}`)) {
    throw new HttpError(429, 'rate_limited')
  }
}

// Single dispatcher every CMS mutation route calls. Token requests draw on
// the per-token bucket; cookie sessions on the per-user bucket. This is the
// drop-in replacement for `checkMutationRate(ctx.userId)` at mutation sites.
export function checkCmsMutationRate(ctx: {
  userId: number
  viaApiToken: boolean
  tokenId: number | null
}): void {
  if (ctx.viaApiToken && ctx.tokenId !== null) {
    checkMutationRateForToken(ctx.tokenId)
  } else {
    checkMutationRate(ctx.userId)
  }
}

// Per-TOKEN upload budget — the upload path is heavier (sharp/disk) so it
// stays tighter than the mutation bucket, but a token gets its OWN upload
// budget so an agent's uploads don't starve the minting human's per-user
// upload bucket (10/min, the tightest CMS bucket).
const limitTokenUploads = rateLimit('cms:upload:token', {
  limit: 30,
  windowSec: 60,
})

export function checkUploadRateForToken(tokenId: number): void {
  if (!limitTokenUploads(`t${tokenId}`)) {
    throw new HttpError(429, 'rate_limited')
  }
}

// Dispatcher for the media-upload route: token requests draw on the per-token
// upload bucket; cookie sessions on the per-user upload bucket.
export function checkCmsUploadRate(ctx: {
  userId: number
  viaApiToken: boolean
  tokenId: number | null
}): void {
  if (ctx.viaApiToken && ctx.tokenId !== null) {
    checkUploadRateForToken(ctx.tokenId)
  } else {
    checkUploadRate(ctx.userId)
  }
}

export function checkUploadRate(userId: number): void {
  if (!limitUploads(String(userId))) {
    throw new HttpError(429, 'rate_limited')
  }
}

export function checkReadRate(userId: number): void {
  if (!limitReads(String(userId))) {
    throw new HttpError(429, 'rate_limited')
  }
}

// Per-TOKEN read budget — keyed by token id so an automated agent (MCP /
// script) walking pages/themes cannot starve the human operator's per-user
// read bucket (which the dashboard's lazy-loaded grids draw on). Higher
// ceiling than the human bucket because agents legitimately batch reads;
// still a hard cap so a runaway client trips at a bounded rate.
const limitTokenReads = rateLimit('cms:read:token', {
  limit: 240,
  windowSec: 60,
})

export function checkReadRateForToken(tokenId: number): void {
  if (!limitTokenReads(`t${tokenId}`)) {
    throw new HttpError(429, 'rate_limited')
  }
}

// Dispatcher every CMS read site calls: token requests draw on the per-token
// read bucket; cookie sessions on the per-user read bucket. Drop-in for
// `checkReadRate(ctx.userId)` at read sites.
export function checkCmsReadRate(ctx: {
  userId: number
  viaApiToken: boolean
  tokenId: number | null
}): void {
  if (ctx.viaApiToken && ctx.tokenId !== null) {
    checkReadRateForToken(ctx.tokenId)
  } else {
    checkReadRate(ctx.userId)
  }
}

export function checkExportRate(userId: number): void {
  if (!limitExports(String(userId))) {
    throw new HttpError(429, 'rate_limited')
  }
}

export function checkAiVerifyRate(userId: number): void {
  if (!limitAiVerify(String(userId))) {
    throw new HttpError(429, 'rate_limited')
  }
}

/** PR 4 — Page Assistant chat bucket. Routes return 429 + 'rate_limited'
 *  before opening the SSE stream when the operator overshoots the
 *  per-minute budget. */
export function checkAiChatRate(userId: number): boolean {
  return limitAiChat(String(userId))
}

// Status-poll bucket (ported from main's backup/update progress polling). A
// generous ceiling so a 1/s poll never trips, while still capping a stolen
// cookie on an endpoint that leaks nothing.
const limitStatusPoll = rateLimit('cms:status-poll:user', {
  limit: 240,
  windowSec: 60,
})
export function checkStatusPollRate(userId: number): void {
  if (!limitStatusPoll(String(userId))) {
    throw new HttpError(429, 'rate_limited')
  }
}
