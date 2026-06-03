import { z } from 'zod'
import diff from 'microdiff'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError, requireScope } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkCmsMutationRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import { parseProjectSectionAndSanitize } from '@/lib/cms/parse'
import {
  collectMediaPaths,
  type MediaRefPath,
} from '@/lib/cms/mediaRefs'
import { assertMediaAvailable } from '@/lib/cms/mediaCheck'
import { capAuditDiff, type DiffOp } from '@/lib/cms/saveBlock'
import { AUDIT_KIND } from '@/lib/cms/auditKinds'
import { enqueueRevalidate, drainRevalidate } from '@/lib/cache/durableRevalidate'
import { tag } from '@/lib/cache/tags'

// Optimistic-lock token accepted under either `version` (the canonical
// name used by projects/posts/settings routes) or the legacy
// `expectedVersion` alias. New clients should send `version`; the alias
// stays so older builds + the projects/blocks/reorder endpoints keep
// working. Exactly one must be present (.refine below).
const Body = z
  .object({
    version: z.number().int().nonnegative().optional(),
    expectedVersion: z.number().int().nonnegative().optional(),
    data: z.unknown(),
  })
  .strict()
  .refine(
    (b) => b.version !== undefined || b.expectedVersion !== undefined,
    'version_required',
  )
  .transform((b) => ({
    data: b.data,
    version: (b.version ?? b.expectedVersion) as number,
  }))

const ID_PATTERN = /^[1-9][0-9]{0,9}$/
function parseId(raw: string): number {
  if (!ID_PATTERN.test(raw)) throw new HttpError(400, 'invalid_id')
  return Number(raw)
}

type RouteCtx = { params: Promise<{ id: string; sectionId: string }> }

interface SectionJoinRow {
  id: number
  section_key: string
  data: string
  version: number
  project_id: number
  slug: string
}

interface ExistingRefRow {
  media_id: number
  field: string
}

// One section row → one PATCH. Mirrors saveBlock's pattern, with two
// improvements specific to project sections:
//
//   * Authoritative media_references reconciliation. If the prior
//     `data` JSON cell is corrupt (post-DB-restore, manual SQL
//     INSERT, schema bump), JSON.parse silently returned `{}` and
//     the diff treated old refs as empty — orphaning the actual
//     media_references rows that point at this section. We now
//     fall back to SELECTing the existing rows directly so the
//     DELETE step still purges what's really there.
//
//   * Batched DELETE/INSERT. Section payloads can carry many more
//     media refs than blocks (gallery up to 384 images). Per-row
//     statements held the FOR-UPDATE lock for too long. One
//     DELETE...WHERE (media_id, field) IN (...) plus one
//     INSERT IGNORE...VALUES (...), (...), ... collapses the loop.
export const PATCH = withError<RouteCtx>(async (req, { params }) => {
  const { id: rawProjectId, sectionId: rawSectionId } = await params
  const projectId = parseId(rawProjectId)
  const sectionId = parseId(rawSectionId)

  const ctx = await requireRole(['admin', 'editor'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  requireScope(ctx, 'projects', 'write')
  checkCmsMutationRate(ctx)

  const body = Body.parse(await readJsonBody(req))
  const meta = auditMetaFromRequest(req)

  const txResult = await db.transaction(async (tx) => {
    // Single locked SELECT joins the project so a parallel project
    // DELETE (which sets deleted_at) is visible to us before we
    // commit.
    const [rows] = (await tx.execute(sql`
      SELECT s.id, s.section_key, s.data, s.version, s.project_id, p.slug
      FROM project_sections s
      JOIN projects p ON p.id = s.project_id
      WHERE s.id = ${sectionId}
        AND s.project_id = ${projectId}
        AND p.deleted_at IS NULL
      FOR UPDATE
    `)) as unknown as [SectionJoinRow[]]
    const row = rows[0]
    if (!row) throw new HttpError(404, 'not_found')
    if (row.version !== body.version) {
      throw new HttpError(409, 'stale_version')
    }

    const parsed = parseProjectSectionAndSanitize(row.section_key, body.data)
    const newVersion = row.version + 1
    const parsedJson = JSON.stringify(parsed)

    await tx.execute(sql`
      UPDATE project_sections
      SET data = ${parsedJson},
          version = ${newVersion},
          updated_by = ${ctx.userId}
      WHERE id = ${row.id}
    `)

    // Stored JSON comes back as a string under raw SQL. Try to
    // parse it for the standard diff path; if it fails, fall back
    // to the authoritative media_references rows so we don't
    // orphan stale pointers when an attacker corrupted the cell.
    let oldData: unknown
    let oldDataParsed = true
    try {
      oldData = typeof row.data === 'string' ? JSON.parse(row.data) : row.data
    } catch {
      oldData = {}
      oldDataParsed = false
    }

    let oldRefs: MediaRefPath[]
    if (oldDataParsed) {
      oldRefs = collectMediaPaths(oldData)
    } else {
      // Source of truth when JSON parse failed: media_references
      // table itself. We may lose the path information for refs
      // that the data no longer describes — but we KNOW media_id +
      // field are correct because that's what was committed last
      // time.
      const [refRows] = (await tx.execute(sql`
        SELECT media_id, field FROM media_references
        WHERE referent_type = 'project_section' AND referent_id = ${row.id}
      `)) as unknown as [ExistingRefRow[]]
      oldRefs = refRows.map((r) => ({ mediaId: r.media_id, field: r.field }))
    }

    const newRefs = collectMediaPaths(parsed)
    const oldKeys = new Set(oldRefs.map((r) => `${r.mediaId}::${r.field}`))
    const newKeys = new Set(newRefs.map((r) => `${r.mediaId}::${r.field}`))

    // Verify any media_id being NEWLY referenced is alive before
    // we commit.
    const newMediaIds = [
      ...new Set(
        newRefs
          .filter((r) => !oldKeys.has(`${r.mediaId}::${r.field}`))
          .map((r) => r.mediaId),
      ),
    ]
    await assertMediaAvailable(tx, newMediaIds)

    const toDelete = oldRefs.filter(
      (r) => !newKeys.has(`${r.mediaId}::${r.field}`),
    )
    const toInsert = newRefs.filter(
      (r) => !oldKeys.has(`${r.mediaId}::${r.field}`),
    )

    // Batched DELETE — one statement, one round trip, one lock
    // window regardless of N.
    if (toDelete.length > 0) {
      const pairs = sql.join(
        toDelete.map((r) => sql`(${r.mediaId}, ${r.field})`),
        sql.raw(','),
      )
      await tx.execute(sql`
        DELETE FROM media_references
        WHERE referent_type = 'project_section'
          AND referent_id = ${row.id}
          AND (media_id, field) IN (${pairs})
      `)
    }

    // Batched INSERT IGNORE — one statement, N value tuples.
    if (toInsert.length > 0) {
      const values = sql.join(
        toInsert.map(
          (r) =>
            sql`(${r.mediaId}, 'project_section', ${row.id}, ${r.field})`,
        ),
        sql.raw(','),
      )
      await tx.execute(sql`
        INSERT IGNORE INTO media_references (media_id, referent_type, referent_id, field)
        VALUES ${values}
      `)
    }

    const patch = diff(
      (oldData as object) ?? {},
      (parsed as object) ?? {},
    ) as DiffOp[]
    const cappedDiff = capAuditDiff(patch)
    const auditDiff = Array.isArray(cappedDiff)
      ? {
          kind: AUDIT_KIND.patch,
          ops: cappedDiff,
          section_key: row.section_key,
          old_data_parsed: oldDataParsed,
        }
      : {
          ...(cappedDiff as object),
          kind: AUDIT_KIND.patchTruncated,
          section_key: row.section_key,
          old_data_parsed: oldDataParsed,
        }
    await tx.insert(auditLog).values({
      userId: ctx.userId,
      tokenId: ctx.tokenId,
      action: 'update',
      resourceType: 'project_section',
      resourceId: String(row.id),
      diff: auditDiff,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    })

    const tags = [tag.project(row.slug)]
    const queueRowId = await enqueueRevalidate(tx, tags)
    return { version: newVersion, queueRowId, tags }
  })

  queueMicrotask(() => {
    void drainRevalidate(txResult.queueRowId, txResult.tags)
  })

  return new Response(JSON.stringify({ version: txResult.version }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
})
