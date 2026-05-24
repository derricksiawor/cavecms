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

export function checkExportRate(userId: number): void {
  if (!limitExports(String(userId))) {
    throw new HttpError(429, 'rate_limited')
  }
}
