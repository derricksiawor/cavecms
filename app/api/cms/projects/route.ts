import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError, requireScope } from '@/lib/auth/requireRole'
import { adminPolicy } from '@/lib/auth/adminPolicy'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkCmsMutationRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import { isDuplicateKey } from '@/lib/db/errors'
import { AUDIT_KIND } from '@/lib/cms/auditKinds'
import { tagsForProjectCreate } from '@/lib/cache/tags'
import { enqueueRevalidate, drainRevalidate } from '@/lib/cache/durableRevalidate'
import {
  SECTION_KEYS,
  EMPTY_SECTION_DATA,
} from '@/lib/cms/project-section-registry'
import { insertProjectPageTree } from '@/lib/cms/migrateProjectsToBlocks'

import { SLUG_RE } from '@/lib/cms/slug'
// projects.slug DB column is varchar(120) — narrower than the
// canonical SLUG_MAX (140 mirrors pages/posts). Keep the local
// upper bound aligned with the column.
const SLUG_MAX = 120

const CreateBody = z
  .object({
    name: z.string().min(1).max(120),
    slug: z
      .string()
      .min(2)
      .max(SLUG_MAX)
      .regex(SLUG_RE, 'slug_invalid_format'),
    status: z.enum([
      'coming_soon',
      'under_construction',
      'selling',
      'sold_out',
    ]),
  })
  .strict()

interface InsertResult {
  insertId: number
}

// POST is admin-only. Creating a project bakes 10 section rows in the
// same TX so the public render path can always assume the full set —
// no "section missing" edge case in hydrateProject.
//
// Also DELETEs any stale slug_redirects row whose old_slug equals
// the new slug. Without this, a project formerly at slug X that was
// renamed to Y leaves an X→Y redirect; creating a new project at X
// means the public page's `slug_redirects` lookup would 308 visitors
// to Y before they ever see the new project at X (the renderer
// only consults redirects when hydrate returns null, e.g.
// unpublished + preview-token flow). Clean the slot at create time.
export const POST = withError(async (req) => {
  const ctx = await requireRole(adminPolicy('createProject'))
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  requireScope(ctx, 'projects', 'write')
  checkCmsMutationRate(ctx)

  const body = CreateBody.parse(await readJsonBody(req))
  const meta = auditMetaFromRequest(req)

  try {
    const txResult = await db.transaction(async (tx) => {
      // Pre-clean any stale redirect whose old_slug equals the new
      // slug. Same-TX so a crash mid-create leaves no half-state.
      await tx.execute(sql`
        DELETE FROM slug_redirects
        WHERE resource_type = 'project' AND old_slug = ${body.slug}
      `)

      const [insertArr] = (await tx.execute(sql`
        INSERT INTO projects (slug, name, status, version)
        VALUES (${body.slug}, ${body.name}, ${body.status}, 0)
      `)) as unknown as [InsertResult]
      const projectId = Number(insertArr.insertId)

      // Auto-seed all 10 section rows in registry order at positions
      // 1000, 2000, 3000... Kept as a rollback-safety hedge (a manual
      // downgrade to a pre-block-render version still renders the project
      // via the legacy branch) + the data source the backfill would read
      // were the page tree ever absent. The CMS render ignores these —
      // the block tree below is the live source. They retire with the
      // legacy branch next release.
      let pos = 1000
      for (const key of SECTION_KEYS) {
        await tx.execute(sql`
          INSERT INTO project_sections (project_id, section_key, position, data, version)
          VALUES (${projectId}, ${key}, ${pos}, ${JSON.stringify(EMPTY_SECTION_DATA[key])}, 0)
        `)
        pos += 1000
      }

      // Create the project's CMS block tree (pages row + content_blocks)
      // from the same empty section seeds, IN THIS TX, so the project is
      // block-driven + front-end inline-editable from the moment it's
      // created — no backfill round-trip. The page is created unpublished
      // (the new project is a draft); admins reach + edit the unpublished
      // block tree on the live page (the project route relaxes its page
      // lookup for editors/preview). insertProjectPageTree validates
      // every band before inserting, so a failure rolls the whole
      // project creation back (atomic create).
      await insertProjectPageTree(
        tx,
        {
          id: projectId,
          slug: body.slug,
          name: body.name,
          status: body.status,
          location: null,
          published: 0,
          brochure_pdf_id: null,
        },
        SECTION_KEYS.map((key) => ({
          sectionKey: key as string,
          data: EMPTY_SECTION_DATA[key],
        })),
        'inherit',
      )

      await tx.insert(auditLog).values({
        userId: ctx.userId,
        tokenId: ctx.tokenId,
        action: 'create',
        resourceType: 'project',
        resourceId: String(projectId),
        diff: {
          kind: AUDIT_KIND.create,
          data: {
            name: body.name,
            slug: body.slug,
            status: body.status,
          },
        } as unknown as object,
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      })

      // Invalidate the bar's slug-resolver cache for this slug.
      // A visitor who hit /projects/X BEFORE this insert would have
      // primed the resolver with `null`; without this revalidate
      // the Edit link stays missing for up to 5 minutes after
      // the operator creates the project.
      const tags = tagsForProjectCreate(body.slug).tags
      const queueRowId = await enqueueRevalidate(tx, tags)
      return { insertId: projectId, queueRowId, tags }
    })

    queueMicrotask(() => {
      void drainRevalidate(txResult.queueRowId, txResult.tags)
    })

    return new Response(JSON.stringify({ id: txResult.insertId, slug: body.slug }), {
      status: 201,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      },
    })
  } catch (err: unknown) {
    if (isDuplicateKey(err)) throw new HttpError(409, 'slug_taken')
    throw err
  }
})

// GET serves the admin projects list. Editors and viewers see the
// same row set (no PII / no token leakage here); pagination is
// intentionally absent — the BWP catalog is small (<50 projects).
interface ProjectListRow {
  id: number
  slug: string
  name: string
  status: string
  featured_order: number | null
  published: number
  deleted_at: Date | null
  updated_at: Date
}

export const GET = withError(async (req) => {
  await requireRole(['admin', 'editor', 'viewer'])
  const url = new URL(req.url)
  const showArchived = url.searchParams.get('archived') === '1'

  const [rows] = (await db.execute(
    showArchived
      ? sql`
          SELECT id, slug, name, status, featured_order, published, deleted_at, updated_at
          FROM projects
          ORDER BY featured_order IS NULL, featured_order, name
        `
      : sql`
          SELECT id, slug, name, status, featured_order, published, deleted_at, updated_at
          FROM projects
          WHERE deleted_at IS NULL
          ORDER BY featured_order IS NULL, featured_order, name
        `,
  )) as unknown as [ProjectListRow[]]

  return new Response(JSON.stringify({ items: rows }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
})
