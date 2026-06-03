import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { adminPolicy } from '@/lib/auth/adminPolicy'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate, checkReadRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import { isDuplicateKey } from '@/lib/db/errors'
import { AUDIT_KIND } from '@/lib/cms/auditKinds'
import type { BlockKind } from '@/lib/cms/blockMeta'
import { tagsForPageCreate } from '@/lib/cache/tags'
import { enqueueRevalidate, drainRevalidate } from '@/lib/cache/durableRevalidate'
import { CreatePageEditorBody, CreatePageAdminBody } from '@/lib/cms/page-shapes'
import { validatePageSlug } from '@/lib/cms/page-slug'
// blog-system worktree (Phase 5): a page slug can't claim a custom permalink
// segment (the segment rewrite would shadow it). 'blog'/'projects' are already
// in the static RESERVED set; this covers custom segments.
import { getCustomSegmentReservedSet } from '@/lib/blog/resolveSegments'
import { parseAndSanitize } from '@/lib/cms/parse'
import { collectMediaPaths } from '@/lib/cms/mediaRefs'
import { assertMediaAvailable } from '@/lib/cms/mediaCheck'
import { env } from '@/lib/env'

// POST /api/cms/pages — create. Per spec §4.1.
//
// Body shape is role-branched: editors send CreatePageEditorBody (no
// `published`); admins send CreatePageAdminBody (with `published`).
// .strict() on both schemas rejects unknown fields — an editor sneaking
// `published: true` trips a ZodError that we route to the rbac_field_reject
// audit + 403 before the create runs. The slug is server-validated via
// `validatePageSlug` even though Zod already checked SLUG_RE — the
// page-slug helper layers RESERVED + LOGIN_PATH + NFKC on top.
//
// Template clone (§4.1):
//   - 'blank' → no content_blocks created.
//   - 'clone-{about|services|contact}' → SELECTs blocks from the system
//     row with that slug under REPEATABLE READ + CONSISTENT SNAPSHOT (no
//     FOR SHARE — that would deadlock against concurrent saveBlock on
//     the source). Re-Zod-parses each block via parseAndSanitize so a
//     pre-existing source block that no longer matches the current
//     schema surfaces as 422 clone_schema_mismatch, not a corruption
//     downstream. Reconciles media_references for every cloned block.

interface InsertResult {
  insertId: number
}
interface BlockRow {
  id: number
  parent_id: number | null
  kind: BlockKind
  block_key: string | null
  block_type: string
  position: number
  data: string
  meta: string | null
}

// Map the clone-* template enum to the system slug it reads from.
// The (system=1, slug=:templateSlug, deleted_at IS NULL) lookup is the
// single source of truth — adding a new clone template means adding
// the slug here AND wiring the enum value in lib/cms/page-shapes.ts.
const TEMPLATE_SLUGS: Record<string, string> = {
  'clone-about': 'about',
  'clone-services': 'services',
  'clone-contact': 'contact',
}

export const POST = withError(async (req) => {
  const ctx = await requireRole(adminPolicy('createPage'))
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)

  const raw = await readJsonBody(req)
  const Schema = ctx.role === 'admin' ? CreatePageAdminBody : CreatePageEditorBody
  const meta = auditMetaFromRequest(req)

  let body: { title: string; slug: string; template?: string; published?: boolean }
  try {
    body = Schema.parse(raw) as typeof body
  } catch (e) {
    // RBAC visibility audit: editor sent admin-only fields (`published`
    // OR a non-'blank' clone template per spec §3.4). Both vectors are
    // rejected by `.strict()` and the editor template schema; we
    // additionally inspect the raw body to capture the OFFENDING KEY
    // NAMES (never values) so forensic triage can distinguish a
    // privilege-escalation probe from an accidentally-stale client.
    // Mirrors the posts route's PATCH RBAC pattern at
    // app/api/cms/posts/[id]/route.ts:203-247.
    if (ctx.role === 'editor' && raw && typeof raw === 'object') {
      const rawObj = raw as Record<string, unknown>
      const offending: string[] = []
      if ('published' in rawObj) offending.push('published')
      // The template field exists on both schemas but the editor schema
      // permits ONLY 'blank' as the literal value. A clone-* template
      // from an editor is a real privilege-escalation attempt — record
      // it as such (key+offending-value omitted because value-logging
      // is the enumeration vector we close).
      if (
        'template' in rawObj &&
        typeof rawObj.template === 'string' &&
        rawObj.template !== 'blank'
      ) {
        offending.push('template')
      }
      if (offending.length > 0) {
        await db.insert(auditLog).values({
          userId: ctx.userId,
          action: 'rbac_field_reject',
          resourceType: 'page',
          resourceId: '0',
          diff: {
            kind: AUDIT_KIND.rbacFieldReject,
            keys: offending,
          } as unknown as object,
          ip: meta.ip,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
        })
        throw new HttpError(403, 'forbidden')
      }
    }
    throw e
  }

  // Server-side slug validation — the Zod schema already runs SLUG_RE +
  // length, but the helper layers NFKC + ASCII + RESERVED + LOGIN_PATH
  // and is the single source of truth (§5.2). Public code collapses to
  // `slug_invalid` regardless of which granular reason fired.
  const slugCheck = validatePageSlug(
    body.slug,
    env.LOGIN_PATH,
    await getCustomSegmentReservedSet(),
  )
  if (!slugCheck.ok) {
    console.info(
      JSON.stringify({
        level: 'info',
        msg: 'slug_validation_failed',
        reason: slugCheck.reason,
        candidate: body.slug,
      }),
    )
    throw new HttpError(422, 'slug_invalid')
  }

  const wantPublished = ctx.role === 'admin' && body.published === true
  const template = body.template ?? 'blank'

  try {
    const txResult = await db.transaction(async (tx) => {
      // Clean any stale slug_redirects row whose old_slug equals the new
      // slug — mirrors the posts/projects POST pattern. Without this,
      // recycling a retired slug would 308 visitors away from the new
      // page before they ever see it.
      await tx.execute(sql`
        DELETE FROM slug_redirects
        WHERE resource_type = 'page' AND old_slug = ${body.slug}
      `)

      // INSERT the page row. `url_path` is a STORED generated column —
      // omitted intentionally; MariaDB computes it from (is_home, slug)
      // and refuses an explicit value (ER_BAD_GENERATED_COLUMN_VALUE).
      const publishedAt = wantPublished ? sql`NOW(3)` : sql`NULL`
      const [insertRes] = (await tx.execute(sql`
        INSERT INTO pages (
          slug, title, is_home, system, published, published_at,
          preview_epoch, version, updated_by
        ) VALUES (
          ${body.slug}, ${body.title}, 0, 0, ${wantPublished ? 1 : 0},
          ${publishedAt}, 0, 0, ${ctx.userId}
        )
      `)) as unknown as [InsertResult]
      const pageId = Number(insertRes.insertId)

      // Template-clone branch. REPEATABLE READ + CONSISTENT SNAPSHOT
      // gives the TX a single point-in-time view of the source page's
      // blocks for the duration of the clone (no FOR SHARE — that
      // would deadlock against concurrent saveBlock on the source per
      // spec §4.1).
      let clonedBlockCount = 0
      if (template !== 'blank') {
        const templateSlug = TEMPLATE_SLUGS[template]
        if (!templateSlug) throw new HttpError(422, 'clone_source_missing')

        // Source page lookup: system=1 + slug + deleted_at IS NULL.
        // Missing → 422 clone_source_missing. Trashed → 422 clone_source_trashed.
        // The lookup runs WITHOUT FOR UPDATE so it doesn't lock the source row;
        // the consistent-snapshot below pins the blocks we read.
        const [srcRows] = (await tx.execute(sql`
          SELECT id, deleted_at FROM pages
          WHERE system = 1 AND slug = ${templateSlug}
        `)) as unknown as [Array<{ id: number; deleted_at: Date | string | null }>]
        const src = srcRows[0]
        if (!src) throw new HttpError(422, 'clone_source_missing')
        if (src.deleted_at !== null) throw new HttpError(422, 'clone_source_trashed')
        const sourceId = src.id

        // Spec §4.1 specifies `SET SESSION TRANSACTION ISOLATION LEVEL
        // REPEATABLE READ; START TRANSACTION WITH CONSISTENT SNAPSHOT`
        // — but that combination requires running BEFORE Drizzle starts
        // the transaction. Inside an active TX, `SET TRANSACTION
        // ISOLATION LEVEL` is rejected by MariaDB with
        // `ERROR 1568 (25001) Transaction characteristics can't be
        // changed while a transaction is in progress`.
        //
        // MariaDB / InnoDB's DEFAULT isolation level is REPEATABLE READ,
        // and Drizzle does not override it. So inside the auto-started
        // `db.transaction()`, the clone reads ALREADY run under the
        // REPEATABLE READ snapshot the spec requires — no explicit
        // SET is needed (or possible) here. The non-locking SELECTs
        // below therefore see a single point-in-time view of the
        // source page's blocks for the duration of this TX.
        //
        // If a future deploy ever changes the server's default
        // isolation (`tx_isolation` session var) the contract above
        // would break; the `scripts/post-migrate-asserts.ts` gate is
        // the place to assert `@@transaction_isolation = 'REPEATABLE-READ'`
        // — out-of-scope for PR-3 but flagged in deploy notes.

        // Tree-aware clone (post-migration-0011). The source page may
        // contain section / column container rows alongside widget rows;
        // the SELECT pulls `parent_id`, `kind`, and `meta` so we can
        // rebuild the tree on the new page with fresh ids. Walked in
        // position order — sections (parent_id IS NULL) sort first by
        // position, then their child columns, then their child widgets,
        // because position is per-parent and sections live at the top
        // level. The Map<oldId,newId> below maps source ids to the
        // freshly-inserted destination ids so child rows can resolve
        // their new parent. Pre-Chunk-K legacy "loose" widgets (kind
        // 'widget', parent_id NULL) still clone — their parent is NULL
        // on both sides so the Map lookup short-circuits.
        const [srcBlocksRaw] = (await tx.execute(sql`
          SELECT id, parent_id, kind, block_key, block_type, position, data, meta
          FROM content_blocks
          WHERE page_id = ${sourceId} AND deleted_at IS NULL
          ORDER BY COALESCE(parent_id, 0), position
        `)) as unknown as [BlockRow[]]

        const oldToNewId = new Map<number, number>()
        for (const b of srcBlocksRaw) {
          // Widgets parse + sanitize through the CURRENT schema (a
          // source page that pre-dates a schema bump fails LOUD here →
          // 422 clone_schema_mismatch). Section + column rows are
          // containers — their `data` is the empty-object placeholder
          // and they have no widget schema; we pass the JSON through
          // verbatim and don't try to validate `parsed` for media refs.
          let parsedForRefs: unknown = null
          let newDataJson: string
          if (b.kind === 'widget') {
            try {
              const sourceData: unknown = JSON.parse(b.data)
              parsedForRefs = parseAndSanitize(b.block_type, sourceData)
            } catch {
              throw new HttpError(422, 'clone_schema_mismatch')
            }
            newDataJson = JSON.stringify(parsedForRefs)
          } else {
            // section / column — keep the empty-object placeholder the
            // schema expects (the renderer never reads section/column
            // `data`; the source of truth is `meta`).
            newDataJson = '{}'
          }
          // Map source parent → new parent. Top-level rows (parent_id
          // NULL) stay NULL. A child with a parent_id we haven't seen
          // yet means the ORDER BY didn't visit the parent first — the
          // COALESCE(parent_id, 0) above guarantees parent rows (NULL
          // parent) sort before their children, but if a child somehow
          // pre-dates its parent in the source page (a corrupt write)
          // the lookup returns undefined and we throw rather than land
          // a dangling row.
          let newParentId: number | null = null
          if (b.parent_id !== null) {
            const mapped = oldToNewId.get(b.parent_id)
            if (mapped === undefined) {
              throw new HttpError(422, 'clone_schema_mismatch')
            }
            newParentId = mapped
          }
          // INSERT the cloned block with version=0 (fresh history).
          // block_key is INTENTIONALLY dropped for clones — the source
          // may carry a non-null block_key (fixed-slot marker on a
          // system page) which would (a) trip the
          // UNIQUE(page_id, block_key) constraint if the destination
          // page already had a sibling with that key and (b) make the
          // cloned row resist deletion via the cannot_delete_fixed_block
          // gate, which is wrong for an operator-authored clone. Fixed-
          // slot semantics belong to system pages only.
          const [bRes] = (await tx.execute(sql`
            INSERT INTO content_blocks (
              page_id, parent_id, kind, block_key, block_type, position,
              data, meta, version, updated_by
            ) VALUES (
              ${pageId}, ${newParentId}, ${b.kind}, NULL, ${b.block_type},
              ${b.position}, ${newDataJson}, ${b.meta}, 0,
              ${ctx.userId}
            )
          `)) as unknown as [InsertResult]
          const newBlockId = Number(bRes.insertId)
          oldToNewId.set(b.id, newBlockId)

          // Reconcile media_references for the cloned widget. Same
          // shape as saveBlock: walk the runtime tree, INSERT IGNORE
          // rows bound to (media_id, 'content_block', newBlockId,
          // field). Containers (section/column) carry no media refs —
          // skip the walk on those.
          if (b.kind === 'widget') {
            const refs = collectMediaPaths(parsedForRefs)
            if (refs.length > 0) {
              const uniqueMediaIds = [...new Set(refs.map((r) => r.mediaId))]
              await assertMediaAvailable(tx, uniqueMediaIds)
              for (const r of refs) {
                await tx.execute(sql`
                  INSERT IGNORE INTO media_references (media_id, referent_type, referent_id, field)
                  VALUES (${r.mediaId}, 'content_block', ${newBlockId}, ${r.field})
                `)
              }
            }
          }
          clonedBlockCount++
        }
      }

      await tx.insert(auditLog).values({
        userId: ctx.userId,
        action: 'create',
        resourceType: 'page',
        resourceId: String(pageId),
        diff: {
          kind: AUDIT_KIND.create,
          data: {
            slug: body.slug,
            title: body.title,
            template,
            published: wantPublished,
            cloned_block_count: clonedBlockCount,
          },
        } as unknown as object,
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      })

      const tags = tagsForPageCreate(body.slug, { published: wantPublished }).tags
      const queueRowId = await enqueueRevalidate(tx, tags)
      return { insertId: pageId, queueRowId, tags }
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
    if (err instanceof HttpError) throw err
    if (isDuplicateKey(err)) throw new HttpError(409, 'slug_in_use')
    throw err
  }
})

interface PageListRow {
  id: number
  slug: string
  title: string
  is_home: number
  system: number
  published: number
  published_at: Date | string | null
  deleted_at: Date | string | null
  updated_at: Date | string
  updated_by_email: string | null
  url_path: string | null
}

// GET /api/cms/pages — admin list (also surfaces ?trashed=1 view).
// Role gate: admin + editor only. Viewer is 404 on /admin/pages per
// spec §3.2 / §0 role matrix; the API matches the FE-surface
// invisibility so a viewer with a valid session can't `curl` the
// endpoint to enumerate operator-created pages, slugs, or
// updated_by emails. (Posts/projects' list APIs admit viewer
// because the role matrix exposes viewer to those surfaces.)
//
// Pagination: cap at 50 like posts. The 4 seed rows + a handful of
// operator-created pages will never approach that cap; if the page count
// ever does, switch to keyset pagination keyed on (updated_at, id).
export const GET = withError(async (req) => {
  const ctx = await requireRole(['admin', 'editor'])
  checkReadRate(ctx.userId)

  const url = new URL(req.url)
  const trashed = url.searchParams.get('trashed') === '1'

  const [rows] = (await db.execute(
    trashed
      ? sql`
          SELECT p.id, p.slug, p.title, p.is_home, p.system, p.published,
                 p.published_at, p.deleted_at, p.updated_at, p.url_path,
                 u.email AS updated_by_email
          FROM pages p
          LEFT JOIN users u ON u.id = p.updated_by
          WHERE p.deleted_at IS NOT NULL
            AND p.deleted_at > NOW(3) - INTERVAL 30 DAY
            -- Hidden post-body pages (kind='post_body') never appear in the
            -- generic Pages admin list (spec §4.4).
            AND p.kind = 'page'
          ORDER BY p.deleted_at DESC, p.id DESC
          LIMIT 50
        `
      : sql`
          SELECT p.id, p.slug, p.title, p.is_home, p.system, p.published,
                 p.published_at, p.deleted_at, p.updated_at, p.url_path,
                 u.email AS updated_by_email
          FROM pages p
          LEFT JOIN users u ON u.id = p.updated_by
          WHERE p.deleted_at IS NULL
            AND p.kind = 'page'
          ORDER BY p.is_home DESC, p.updated_at DESC, p.id DESC
          LIMIT 50
        `,
  )) as unknown as [PageListRow[]]

  return new Response(JSON.stringify({ items: rows }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
})
