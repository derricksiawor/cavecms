import { z } from 'zod'
import { withError, getRequestId } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError, requireScope } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkCmsMutationRate } from '@/lib/auth/cmsRateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { drainRevalidate } from '@/lib/cache/durableRevalidate'
import {
  duplicateBlock,
  DuplicateNotFoundError,
  DuplicatePageNotFoundError,
  DuplicateColumnCountExceededError,
  DuplicateSubtreeTooLargeError,
  DuplicatePositionGapExhaustedError,
  DuplicateSourceInvalidError,
  DuplicateBlockTypeReservedError,
  DuplicateCycleDetectedError,
  MAX_DUPLICATE_SUBTREE_SIZE,
} from '@/lib/cms/duplicateBlock'

// POST /api/cms/blocks/[id]/duplicate (Chunk H)
// Recursive duplicate of a content_blocks row + every living descendant
// in ONE TX. See lib/cms/duplicateBlock.ts for the lock-order rationale
// and the recursive-CTE walk.
//
// Body envelope carries only pageId. The source id is in the path. The
// pageId field is defense-in-depth so a forged source id targeting a
// foreign page surfaces as 404 (the duplicateBlock helper enforces the
// match in the locked TX; the route layer doesn't trust it for routing
// or auth — only for the body-vs-path consistency check).

const PostBody = z
  .object({
    pageId: z.number().int().positive(),
  })
  .strict()

const ID_PATTERN = /^[1-9][0-9]{0,9}$/

export const POST = withError<{ params: Promise<{ id: string }> }>(
  async (req, { params }) => {
    const { id: rawId } = await params
    if (!ID_PATTERN.test(rawId)) throw new HttpError(400, 'invalid_id')
    const sourceId = Number(rawId)

    const ctx = await requireRole(['admin', 'editor'])
    await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
    // checkCmsMutationRate uses the per-user mutation bucket — same as
    // POST / PATCH / DELETE. A single duplicate request can amplify
    // to MAX_DUPLICATE_SUBTREE_SIZE (256) INSERTs internally, so each
    // request consumes one bucket slot but generates up to 256× the
    // DB load of a single PATCH. The subtree cap bounds the blast
    // radius — sustained abuse is throttled by the bucket. If
    // duplicate becomes a measurable vector, add a dedicated
    // checkDuplicationRate bucket with a tighter per-minute cap.
    requireScope(ctx, 'blocks', 'write')
    checkCmsMutationRate(ctx)

    const body = PostBody.parse(await readJsonBody(req))

    const headerObj: Record<string, string | undefined> = {}
    req.headers.forEach((v, k) => {
      headerObj[k] = v
    })
    const ip = clientIpFromHeaders(headerObj, '127.0.0.1')
    const userAgent = (headerObj['user-agent'] ?? '').slice(0, 255) || null
    const requestId = getRequestId(req)

    let result
    try {
      result = await duplicateBlock({
        sourceId,
        userId: ctx.userId,
        pageId: body.pageId,
        ip,
        userAgent,
        requestId,
      })
    } catch (e) {
      // Distinct codes per failure class so the FE toast can route
      // ("section is at column maximum" vs "we couldn't save"). No
      // info-leak between not_found variants — cross-page parent and
      // missing source both surface as 404 not_found.
      if (e instanceof DuplicatePageNotFoundError) {
        throw new HttpError(404, 'page_not_found')
      }
      if (e instanceof DuplicateNotFoundError) {
        throw new HttpError(404, 'not_found')
      }
      if (e instanceof DuplicateColumnCountExceededError) {
        throw new HttpError(409, 'column_count_exceeded')
      }
      if (e instanceof DuplicateSubtreeTooLargeError) {
        // F7: include the offending subtree size + the registry cap
        // so the FE toast can be specific ("This block has N items —
        // exceeds the 256 limit") instead of the generic "try
        // duplicating its parts" guidance the audit caught as
        // unactionable. The error class already carries the size;
        // surface it in the JSON envelope. Status code stays 409 to
        // preserve the FE switch in EditableBlock duplicate handler.
        return new Response(
          JSON.stringify({
            error: 'subtree_too_large',
            descendantCount: e.size,
            limit: MAX_DUPLICATE_SUBTREE_SIZE,
            requestId,
          }),
          {
            status: 409,
            headers: {
              'content-type': 'application/json',
              'cache-control': 'private, no-store',
            },
          },
        )
      }
      if (e instanceof DuplicatePositionGapExhaustedError) {
        throw new HttpError(409, 'position_gap_exhausted')
      }
      if (e instanceof DuplicateBlockTypeReservedError) {
        throw new HttpError(409, 'block_type_reserved_for_fixed_slot')
      }
      if (e instanceof DuplicateSourceInvalidError) {
        throw new HttpError(409, 'source_invalid')
      }
      if (e instanceof DuplicateCycleDetectedError) {
        // 500 — the underlying tree is corrupt; operator can't recover
        // by retrying. Distinct from the 409 codes so admin tooling
        // can surface it to operators differently (and the verifier
        // cron should pick up the FK-cycle audit signal).
        throw new HttpError(500, 'cycle_detected')
      }
      throw e
    }

    // Drain after commit. queueRowId may be null when tagsForBlockSave
    // returned an empty set (defensive — the page tag is always present
    // for block_type='widget' / 'section' / 'column', so this is
    // effectively unreachable, but mirrors saveBlock's null guard).
    if (result.queueRowId !== null) {
      queueMicrotask(() => {
        void drainRevalidate(result.queueRowId!, result.tags)
      })
    }

    return new Response(
      JSON.stringify({ id: result.newTopId, version: 0 }),
      {
        status: 201,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'private, no-store',
        },
      },
    )
  },
)
