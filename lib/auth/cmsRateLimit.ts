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
// Status-poll bucket — for the backup/restore progress modals + the
// updates banner, which poll a status endpoint continuously for the
// duration of a known long-running operation (a backup/restore can run
// for minutes; the modal polls every 1–2 s, and React StrictMode double-
// mounts the poller in dev). These polls return ONLY progress state
// ({state, step, …}) — no table data, no PII — so they don't belong in
// the general 120/min `cms:read` bucket they would otherwise exhaust,
// starving that bucket's media-grid / list reads AND tripping the modal
// into its faster error-cadence (a 429 feedback loop: a 429 is read as a
// network error, which speeds the poll up, which causes more 429s). A
// dedicated, generous ceiling keeps polling smooth while still capping a
// stolen cookie: 240/min is ~4× the busiest prod poll rate (1/s) and ~2×
// the dev-doubled rate, yet bounds abuse of an endpoint that leaks nothing.
const limitStatusPoll = rateLimit('cms:status-poll:user', {
  limit: 240,
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

export function checkStatusPollRate(userId: number): void {
  if (!limitStatusPoll(String(userId))) {
    throw new HttpError(429, 'rate_limited')
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
