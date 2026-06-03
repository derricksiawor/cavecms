import 'server-only'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZodRawShape } from 'zod'
import {
  MCP_TOOLS,
  toolEnabled,
  assertToolScope,
  ToolScopeError,
  type McpToolName,
} from './scope'
import {
  currentCtx,
  type McpRequestContext,
} from './requestContext'
import { getBlockTypeCatalog, getBlockCategories } from './blockCatalog'
import { getCapabilities } from './capabilities'
import { FONT_CATALOG, FONT_KEYS } from '@/lib/cms/fontCatalog'
import { SERVER_INSTRUCTIONS, DESIGN_GUIDE } from './designGuide'
import { callRoute, type PassthroughResult } from './passthrough'
import { checkCmsReadRate, checkCmsMutationRate } from '@/lib/auth/cmsRateLimit'
import {
  listPages,
  getPageForEdit,
  readSiteTheme,
} from '@/lib/cms/services/pageReads'
import {
  saveBlock,
  saveBlockMeta,
  StaleBlockVersionError,
  StalePageVersionError,
  NotFoundError,
  WrongKindError,
  InvalidMetaJsonError,
} from '@/lib/cms/saveBlock'
import {
  BatchBody,
  applyPageBatch,
  batchHasDelete,
} from '@/lib/cms/services/pageBatch'
import {
  SectionMetaSchema,
  ColumnMetaSchema,
  WidgetMetaSchema,
} from '@/lib/cms/blockMeta'
import { HttpError } from '@/lib/auth/requireRole'
// Route handlers reused in-process (single source of truth — same
// requireRole/requireScope/requireCsrf/rate as the HTTP API).
import { POST as pagesCreate } from '@/app/api/cms/pages/route'
import {
  PATCH as pagesUpdate,
  DELETE as pagesDelete,
} from '@/app/api/cms/pages/[id]/route'
import {
  GET as postsList,
  POST as postsCreate,
} from '@/app/api/cms/posts/route'
import {
  GET as postGet,
  PATCH as postUpdate,
  DELETE as postDelete,
} from '@/app/api/cms/posts/[id]/route'
import {
  GET as projectsList,
  POST as projectsCreate,
} from '@/app/api/cms/projects/route'
import {
  GET as projectGet,
  PATCH as projectUpdate,
  DELETE as projectDelete,
} from '@/app/api/cms/projects/[id]/route'
import { GET as mediaList } from '@/app/api/cms/media/route'
import {
  GET as mediaGet,
  DELETE as mediaDelete,
} from '@/app/api/cms/media/[id]/route'
import { GET as navGet, PUT as navPut } from '@/app/api/cms/nav/route'
import {
  GET as settingsGet,
  PATCH as settingsPatch,
} from '@/app/api/admin/settings/route'
import { POST as pageRestore } from '@/app/api/cms/pages/[id]/restore/route'
import { POST as pagePreviewToken } from '@/app/api/cms/pages/[id]/preview-token/route'
// Page draft lifecycle (draft → publish + server-side undo/redo).
import { GET as pageDraftStatus } from '@/app/api/cms/pages/[id]/draft-status/route'
import { POST as pagePublish } from '@/app/api/cms/pages/[id]/publish/route'
import { POST as pageUndo } from '@/app/api/cms/pages/[id]/undo/route'
import { POST as pageRedo } from '@/app/api/cms/pages/[id]/redo/route'
import { POST as pageDiscardDraft } from '@/app/api/cms/pages/[id]/discard-draft/route'
import { POST as postRestore } from '@/app/api/cms/posts/[id]/restore/route'
import { POST as projectRestore } from '@/app/api/cms/projects/[id]/restore/route'
import { POST as projectsReorder } from '@/app/api/cms/projects/reorder/route'
import { PATCH as projectSectionUpdate } from '@/app/api/cms/projects/[id]/sections/[sectionId]/route'
import { POST as projectPreviewToken } from '@/app/api/cms/projects/[id]/preview-token/route'
import { POST as blockCreate } from '@/app/api/cms/blocks/route'
import { DELETE as blockDelete } from '@/app/api/cms/blocks/[id]/route'
import { POST as blockDuplicate } from '@/app/api/cms/blocks/[id]/duplicate/route'
import { POST as blockRestore } from '@/app/api/cms/blocks/[id]/restore/route'
import { POST as blocksReorder } from '@/app/api/cms/blocks/reorder/route'
import { POST as mediaCreate } from '@/app/api/cms/media/route'
import {
  GET as savedBlocksList,
  POST as savedBlockCreate,
} from '@/app/api/cms/saved-blocks/route'
import {
  GET as savedBlockGet,
  DELETE as savedBlockDelete,
} from '@/app/api/cms/saved-blocks/[id]/route'
import { POST as savedBlockInstantiate } from '@/app/api/cms/saved-blocks/[id]/instantiate/route'
import { POST as templateInstantiate } from '@/app/api/cms/templates/instantiate/route'
// Sync route handlers (local↔remote content sync; admin + sync scope).
import {
  GET as syncTargetsList,
  PUT as syncTargetsPut,
  DELETE as syncTargetsDelete,
} from '@/app/api/cms/sync/targets/route'
import { POST as syncPull } from '@/app/api/cms/sync/pull/route'
import { POST as syncPush } from '@/app/api/cms/sync/push/route'
// Backup route handlers (cloud + local archive backups; admin + backups scope).
// callRoute dispatches a handler reference against any absolute app path, so the
// /api/admin/backups/* routes pass through the SAME requireRole/requireScope/
// requireCsrf(bearer-exempt)/rate chain as their /api/cms/* siblings.
import { POST as backupsCreate } from '@/app/api/admin/backups/create/route'
import { GET as backupsList } from '@/app/api/admin/backups/list/route'
import { GET as backupsStatus } from '@/app/api/admin/backups/status/route'
import { GET as backupsRemoteList } from '@/app/api/admin/backups/destinations/remote-list/route'
import { POST as backupsRestore } from '@/app/api/admin/backups/restore/route'
import { POST as backupsRestoreFromCloud } from '@/app/api/admin/backups/restore-from-cloud/route'
import { POST as backupsDelete } from '@/app/api/admin/backups/delete/route'
import { POST as backupsOptions } from '@/app/api/admin/backups/destinations/options/route'
import { POST as backupsConnect } from '@/app/api/admin/backups/destinations/connect/route'
import { POST as backupsConnectPoll } from '@/app/api/admin/backups/destinations/connect/poll/route'
import { POST as backupsDisconnect } from '@/app/api/admin/backups/destinations/disconnect/route'
// getSetting backs backup_configure's read-merge-write (the options route body
// is .strict() + fully-required, so a partial update must merge onto current).
import { getSetting } from '@/lib/cms/getSettings'

// The MCP session is long-lived but the acting authority is RE-RESOLVED on every
// HTTP request (the route enters mcpCtxStore.run with a freshly authenticated
// context per request). So:
//   • tool REGISTRATION uses the INIT snapshot (decides which tools appear);
//   • tool EXECUTION reads currentCtx() (the live per-request ALS context) — a
//     revoke or scope-narrowing between requests takes effect on the NEXT call,
//     even though the cached tool list is stale. Same "stale list, fresh
//     enforcement" contract as scope.ts. Reading via ALS (not a shared mutable
//     ref) keeps concurrent same-session requests from clobbering each other's
//     audit attribution (ip/userAgent/requestId).

const SERVER_INFO = { name: 'cavecms', version: '1.0.0' } as const

function ok(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  }
}
function fail(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true as const,
  }
}
function respond(r: PassthroughResult) {
  if (r.status >= 400) {
    return fail(`HTTP ${r.status}: ${JSON.stringify(r.data)}`)
  }
  return ok(r.data)
}

// Map a thrown service/scope error to a readable isError result — never a stack.
function mapError(e: unknown) {
  if (e instanceof ToolScopeError) {
    return fail(
      `forbidden_scope: this token may not call "${e.toolName}". Ask the operator to widen the token's scopes.`,
    )
  }
  if (e instanceof StaleBlockVersionError) {
    return fail(
      'stale_block_version: the block changed since you read it. Call get_page again and retry with the fresh expectedBlockVersion.',
    )
  }
  if (e instanceof StalePageVersionError) {
    return fail(
      'stale_page_version: the page changed since you read it. Call get_page again and retry with the fresh expectedPageVersion.',
    )
  }
  if (e instanceof NotFoundError) {
    return fail('not_found: no such page/block, or it was deleted.')
  }
  if (e instanceof WrongKindError) {
    return fail('wrong_kind: that operation does not apply to this block kind.')
  }
  if (e instanceof InvalidMetaJsonError) {
    return fail('invalid_meta: the meta payload is not valid for this block.')
  }
  if (e instanceof HttpError) {
    return fail(`${e.status}: ${e.code}`)
  }
  if (e instanceof z.ZodError) {
    return fail(`invalid_input: ${JSON.stringify(e.issues)}`)
  }
  const msg = e instanceof Error ? e.message : 'unknown_error'
  return fail(`error: ${msg}`)
}

// Destructive-op gate: explicit confirm arg OR an MCP elicitation prompt when
// the client supports it. Returns true only on an affirmative confirmation.
async function confirmDestructive(
  server: McpServer,
  alreadyConfirmed: boolean,
  what: string,
): Promise<boolean> {
  if (alreadyConfirmed) return true
  try {
    const r = await server.server.elicitInput({
      message: `Confirm: ${what} Proceed?`,
      requestedSchema: {
        type: 'object',
        properties: {
          confirm: {
            type: 'boolean',
            title: 'Proceed',
            description: 'Set true to perform this action.',
          },
        },
        required: ['confirm'],
      },
    })
    return r.action === 'accept' && (r.content as { confirm?: boolean })?.confirm === true
  } catch {
    // Any failure (client lacks elicitation capability, OR a transient
    // transport/timeout error) → fail CLOSED. The agent's recourse is the same
    // in every case: re-call with the explicit {"confirm": true} arg. We never
    // let a failed confirmation become an accidental destructive action.
    return false
  }
}

export function buildServer(init: McpRequestContext): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions: SERVER_INSTRUCTIONS,
  })

  // Per-session gate: the agent MUST call `design_guide` before any content
  // mutation. Set once by the design_guide tool; checked by every write/
  // destructive tool. This makes "build a page without reading the design
  // standard" structurally impossible over MCP.
  let designAck = false

  // Register a tool iff the INIT token permits it (progressive disclosure).
  // The handler re-asserts against the LIVE per-request ctx (fresh role+scopes).
  function reg(
    key: McpToolName,
    inputSchema: ZodRawShape,
    handler: (args: Record<string, unknown>) => Promise<ReturnType<typeof ok>>,
  ): void {
    const t = MCP_TOOLS[key]
    if (!toolEnabled(init.role, init.scopes, t)) return
    server.registerTool(
      t.name,
      { description: t.summary, inputSchema },
      async (args: Record<string, unknown>) => {
        try {
          // HARD GATE: no content mutation until the design guide has been read.
          if ((t.tier === 'write' || t.tier === 'destructive') && !designAck) {
            return fail(
              'design_guide_required: call the `design_guide` tool first — it is the mandatory ultra-premium design standard, and every create/edit/delete/upload/settings tool is locked until you do. Building blind produces ugly, unbranded pages.',
            )
          }
          const c = currentCtx()
          assertToolScope(c.role, c.scopes, t)
          return await handler(args ?? {})
        } catch (e) {
          return mapError(e)
        }
      },
    )
  }

  // Destructive variant: appends a `confirm` flag + gates execution behind it.
  function regDestructive(
    key: McpToolName,
    inputSchema: ZodRawShape,
    handler: (args: Record<string, unknown>) => Promise<ReturnType<typeof ok>>,
  ): void {
    const t = MCP_TOOLS[key]
    reg(
      key,
      {
        ...inputSchema,
        confirm: z
          .boolean()
          .optional()
          .describe('Must be true to execute this destructive action.'),
      },
      async (args) => {
        const okToGo = await confirmDestructive(
          server,
          args.confirm === true,
          t.summary,
        )
        if (!okToGo) {
          return fail(
            `Not confirmed. Re-call ${t.name} with {"confirm": true} to proceed. (${t.summary})`,
          )
        }
        return handler(args)
      },
    )
  }

  const num = () => z.number().int().positive()
  const fields = (what: string) =>
    z
      .record(z.string(), z.unknown())
      .describe(`${what} (validated server-side; call get_* first to see shape).`)

  // ═══ meta / reference (always available) ═══
  reg('whoami', {}, async () => {
    const c = currentCtx()
    return ok({
      userId: c.userId,
      email: c.email,
      role: c.role,
      scopes: c.scopes,
      tokenId: c.tokenId,
    })
  })
  reg('describe_block_types', {}, async () =>
    ok({ categories: getBlockCategories(), blockTypes: getBlockTypeCatalog() }),
  )
  // design_guide UNLOCKS the content-mutating tools for this session (the gate).
  reg('design_guide', {}, async () => {
    designAck = true
    return ok({ guide: DESIGN_GUIDE })
  })
  reg('get_theme', {}, async () => {
    // DB-backed read — charge a read tick so it's bounded like the other
    // read tools (static meta tools whoami/capabilities/design_guide aren't).
    checkCmsReadRate(currentCtx())
    const theme = await readSiteTheme()
    // Fonts grouped by kind so the agent can pick a brand-matching pairing and
    // set it via update_settings('typography', { heading, body }).
    const availableFonts: Record<string, string[]> = {}
    for (const k of FONT_KEYS) {
      const kind = FONT_CATALOG[k].kind
      ;(availableFonts[kind] ??= []).push(k)
    }
    return ok({
      theme,
      currentTypography: (theme as { typography?: unknown }).typography ?? { heading: null, body: null },
      availableFonts,
      note: 'Match the brand: set theme_palette (colors), the header/footer logo, AND typography (font pairing) to the brand’s real assets via update_settings before composing. Headings + body each pick a font key from availableFonts.',
    })
  })
  reg('capabilities', {}, async () => ok(getCapabilities()))

  // ═══ pages (reads + block editing = explicit services) ═══
  reg(
    'list_pages',
    { trashed: z.boolean().optional().describe('List the 30-day trash.') },
    async (args) => {
      checkCmsReadRate(currentCtx())
      return ok({ items: await listPages({ trashed: args.trashed === true }) })
    },
  )
  reg('get_page', { pageId: num() }, async (args) => {
    const c = currentCtx()
    checkCmsReadRate(c)
    const result = await getPageForEdit(args.pageId as number)
    if (!result) return fail('not_found: no page with that id.')
    const deletedAt = (result.page as { deleted_at?: unknown }).deleted_at
    if (deletedAt != null && c.role === 'viewer') {
      return fail('not_found: no page with that id.')
    }
    return ok(result)
  })
  reg(
    'create_page',
    { fields: fields('New page fields: title, slug, seoTitle, seoDescription, etc.') },
    async (args) =>
      respond(
        await callRoute(pagesCreate, {
          method: 'POST',
          path: '/api/cms/pages',
          body: args.fields,
        }),
      ),
  )
  reg(
    'update_page',
    {
      id: num(),
      fields: fields('Page fields to change: title, slug, published, isHome, SEO'),
    },
    async (args) =>
      respond(
        await callRoute(pagesUpdate, {
          method: 'PATCH',
          path: `/api/cms/pages/${args.id}`,
          params: { id: String(args.id) },
          body: args.fields,
        }),
      ),
  )
  regDestructive('delete_page', { id: num() }, async (args) =>
    respond(
      await callRoute(pagesDelete, {
        method: 'DELETE',
        path: `/api/cms/pages/${args.id}`,
        params: { id: String(args.id) },
      }),
    ),
  )

  // ═══ blocks (explicit services) ═══
  reg(
    'update_block',
    {
      pageId: num(),
      blockId: num(),
      expectedBlockVersion: z.number().int().nonnegative(),
      expectedPageVersion: z.number().int().nonnegative(),
      data: z
        .record(z.string(), z.unknown())
        .describe('Complete replacement data for the block (matches its block_type).'),
    },
    async (args) => {
      const c = currentCtx()
      checkCmsMutationRate(c)
      const res = await saveBlock({
        blockId: args.blockId as number,
        userId: c.userId,
        tokenId: c.tokenId,
        ip: c.ip,
        userAgent: c.userAgent,
        requestId: c.requestId,
        pageId: args.pageId as number,
        expectedBlockVersion: args.expectedBlockVersion as number,
        expectedPageVersion: args.expectedPageVersion as number,
        data: args.data,
      })
      return ok({ ok: true, blockId: args.blockId, ...res })
    },
  )
  reg(
    'update_block_meta',
    {
      pageId: num(),
      blockId: num(),
      expectedKind: z.enum(['section', 'column', 'widget']),
      expectedBlockVersion: z.number().int().nonnegative(),
      expectedPageVersion: z.number().int().nonnegative(),
      meta: z
        .record(z.string(), z.unknown())
        .describe('Complete replacement meta object for the block.'),
    },
    async (args) => {
      const c = currentCtx()
      checkCmsMutationRate(c)
      // Validate the complete-replacement meta against the kind's strict
      // write-schema BEFORE persisting — identical contract to edit_page's
      // patchMeta(full) branch. Without this, saveBlockMeta stores raw
      // metaJson verbatim, so a misshapen payload (wrong key casing, an
      // extra field, a slide missing `media_id`) persisted with ok:true
      // and was then SILENTLY dropped by the renderer's defensive parse —
      // the caller saw success while the page rendered wrong. Now an
      // invalid shape fails loud with the exact offending paths, and the
      // STORED meta is the canonical parsed form (normalised, no junk).
      const metaSchema =
        args.expectedKind === 'section'
          ? SectionMetaSchema
          : args.expectedKind === 'column'
            ? ColumnMetaSchema
            : WidgetMetaSchema
      const parsedMeta = metaSchema.safeParse(args.meta ?? {})
      if (!parsedMeta.success) {
        return fail(
          `invalid_meta: ${parsedMeta.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ')}`,
        )
      }
      const res = await saveBlockMeta({
        blockId: args.blockId as number,
        userId: c.userId,
        tokenId: c.tokenId,
        ip: c.ip,
        userAgent: c.userAgent,
        requestId: c.requestId,
        pageId: args.pageId as number,
        expectedBlockVersion: args.expectedBlockVersion as number,
        expectedPageVersion: args.expectedPageVersion as number,
        expectedKind: args.expectedKind as 'section' | 'column' | 'widget',
        metaJson: JSON.stringify(parsedMeta.data),
      })
      return ok({ ok: true, blockId: args.blockId, ...res })
    },
  )
  reg(
    'edit_page',
    {
      pageId: num(),
      pageVersion: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Optimistic lock for the whole batch (omit = last-write-wins).'),
      ops: z
        .array(z.record(z.string(), z.unknown()))
        .min(1)
        .describe(
          'Block ops: {op:"create"|"patchData"|"patchMeta"|"reorderChildren"|"delete", ...}. See the page-batch contract.',
        ),
      confirm: z
        .boolean()
        .optional()
        .describe('Required true when the batch contains any delete op.'),
    },
    async (args) => {
      const c = currentCtx()
      // Validate precisely with the SAME schema the HTTP route uses.
      const parsed = BatchBody.parse({
        pageVersion: args.pageVersion,
        ops: args.ops,
      })
      // edit_page confirms CONDITIONALLY (only when a delete op is present), so
      // it can't use regDestructive's unconditional gate — it hand-rolls the
      // confirm here instead.
      // Per-op scope, mirroring the route: write for any non-delete, delete for
      // any delete op. assertToolScope already cleared blocks:write (edit_page's
      // catalog action); a delete op additionally needs blocks:delete.
      if (batchHasDelete(parsed.ops)) {
        assertToolScope(c.role, c.scopes, {
          ...MCP_TOOLS.edit_page,
          action: 'delete',
        })
        const okToGo = await confirmDestructive(
          server,
          args.confirm === true,
          'This batch includes delete op(s) that move blocks to trash.',
        )
        if (!okToGo) {
          return fail(
            'Batch contains delete op(s). Re-call edit_page with {"confirm": true} to proceed.',
          )
        }
      }
      // Charge the mutation limiter ONE tick PER OP — parity with the HTTP batch
      // route (closes the amplification gap where a 50-op batch would otherwise
      // cost a single tick). Before any DB work, so an over-budget batch 429s
      // without touching the page.
      for (let i = 0; i < parsed.ops.length; i += 1) checkCmsMutationRate(c)
      const res = await applyPageBatch({
        pageId: args.pageId as number,
        userId: c.userId,
        tokenId: c.tokenId,
        ops: parsed.ops,
        pageVersion: parsed.pageVersion,
        ip: c.ip,
        userAgent: c.userAgent,
        requestId: c.requestId,
      })
      return ok(res)
    },
  )

  // ═══ posts (passthrough) ═══
  reg(
    'list_posts',
    { archived: z.boolean().optional().describe('Include archived posts.') },
    async (args) =>
      respond(
        await callRoute(postsList, {
          method: 'GET',
          path: '/api/cms/posts',
          query: { archived: args.archived ? 1 : undefined },
        }),
      ),
  )
  reg('get_post', { id: num() }, async (args) =>
    respond(
      await callRoute(postGet, {
        method: 'GET',
        path: `/api/cms/posts/${args.id}`,
        params: { id: String(args.id) },
      }),
    ),
  )
  reg('create_post', { fields: fields('New post fields: title, slug, status, etc.') }, async (args) =>
    respond(
      await callRoute(postsCreate, {
        method: 'POST',
        path: '/api/cms/posts',
        body: args.fields,
      }),
    ),
  )
  reg(
    'update_post',
    { id: num(), fields: fields('Post fields to change') },
    async (args) =>
      respond(
        await callRoute(postUpdate, {
          method: 'PATCH',
          path: `/api/cms/posts/${args.id}`,
          params: { id: String(args.id) },
          body: args.fields,
        }),
      ),
  )
  regDestructive('delete_post', { id: num() }, async (args) =>
    respond(
      await callRoute(postDelete, {
        method: 'DELETE',
        path: `/api/cms/posts/${args.id}`,
        params: { id: String(args.id) },
      }),
    ),
  )

  // ═══ projects (passthrough) ═══
  reg(
    'list_projects',
    { archived: z.boolean().optional().describe('Include archived projects.') },
    async (args) =>
      respond(
        await callRoute(projectsList, {
          method: 'GET',
          path: '/api/cms/projects',
          query: { archived: args.archived ? 1 : undefined },
        }),
      ),
  )
  reg('get_project', { id: num() }, async (args) =>
    respond(
      await callRoute(projectGet, {
        method: 'GET',
        path: `/api/cms/projects/${args.id}`,
        params: { id: String(args.id) },
      }),
    ),
  )
  reg(
    'create_project',
    { fields: fields('New project fields: title, slug, status, etc.') },
    async (args) =>
      respond(
        await callRoute(projectsCreate, {
          method: 'POST',
          path: '/api/cms/projects',
          body: args.fields,
        }),
      ),
  )
  reg(
    'update_project',
    { id: num(), fields: fields('Project fields to change') },
    async (args) =>
      respond(
        await callRoute(projectUpdate, {
          method: 'PATCH',
          path: `/api/cms/projects/${args.id}`,
          params: { id: String(args.id) },
          body: args.fields,
        }),
      ),
  )
  regDestructive('delete_project', { id: num() }, async (args) =>
    respond(
      await callRoute(projectDelete, {
        method: 'DELETE',
        path: `/api/cms/projects/${args.id}`,
        params: { id: String(args.id) },
      }),
    ),
  )

  // ═══ media (passthrough; binary upload stays on the dashboard) ═══
  reg(
    'list_media',
    {
      cursor: z.string().optional().describe('Pagination cursor from a prior call.'),
      limit: z.number().int().positive().max(100).optional(),
    },
    async (args) =>
      respond(
        await callRoute(mediaList, {
          method: 'GET',
          path: '/api/cms/media',
          query: {
            cursor: args.cursor as string | undefined,
            limit: args.limit as number | undefined,
          },
        }),
      ),
  )
  reg('get_media', { id: num() }, async (args) =>
    respond(
      await callRoute(mediaGet, {
        method: 'GET',
        path: `/api/cms/media/${args.id}`,
        params: { id: String(args.id) },
      }),
    ),
  )
  regDestructive('delete_media', { id: num() }, async (args) =>
    respond(
      await callRoute(mediaDelete, {
        method: 'DELETE',
        path: `/api/cms/media/${args.id}`,
        params: { id: String(args.id) },
      }),
    ),
  )

  // ═══ nav (passthrough) ═══
  reg('get_nav', {}, async () =>
    respond(await callRoute(navGet, { method: 'GET', path: '/api/cms/nav' })),
  )
  reg(
    'update_nav',
    { fields: fields('Full nav payload: header + footer menu trees') },
    async (args) =>
      respond(
        await callRoute(navPut, {
          method: 'PUT',
          path: '/api/cms/nav',
          body: args.fields,
        }),
      ),
  )

  // ═══ settings (passthrough) ═══
  reg('get_settings', {}, async () =>
    respond(
      await callRoute(settingsGet, {
        method: 'GET',
        path: '/api/admin/settings',
      }),
    ),
  )
  reg(
    'update_settings',
    { settings: fields('Content/branding setting keys to update (allowlisted)') },
    async (args) =>
      respond(
        await callRoute(settingsPatch, {
          method: 'PATCH',
          path: '/api/admin/settings',
          body: args.settings,
        }),
      ),
  )

  // ═══ pages: lifecycle extras (passthrough) ═══
  reg('restore_page', { id: num() }, async (args) =>
    respond(
      await callRoute(pageRestore, {
        method: 'POST',
        path: `/api/cms/pages/${args.id}/restore`,
        params: { id: String(args.id) },
      }),
    ),
  )
  reg('page_preview_token', { id: num() }, async (args) =>
    respond(
      await callRoute(pagePreviewToken, {
        method: 'POST',
        path: `/api/cms/pages/${args.id}/preview-token`,
        params: { id: String(args.id) },
        body: {},
      }),
    ),
  )

  // ═══ pages: draft lifecycle (draft → publish + server-side undo/redo) ═══
  // The canonical authoring sequence over MCP: edit_page writes to the page's
  // DRAFT overlay → page_preview_token to preview the unpublished draft →
  // get_page_draft_status to see what's pending → publish_page to go live.
  // undo_page/redo_page step the draft; discard_page_draft throws it all away.
  reg('get_page_draft_status', { pageId: num() }, async (args) =>
    respond(
      await callRoute(pageDraftStatus, {
        method: 'GET',
        path: `/api/cms/pages/${args.pageId}/draft-status`,
        params: { id: String(args.pageId) },
      }),
    ),
  )
  reg('publish_page', { pageId: num() }, async (args) =>
    respond(
      await callRoute(pagePublish, {
        method: 'POST',
        path: `/api/cms/pages/${args.pageId}/publish`,
        params: { id: String(args.pageId) },
        body: {},
      }),
    ),
  )
  reg('undo_page', { pageId: num() }, async (args) =>
    respond(
      await callRoute(pageUndo, {
        method: 'POST',
        path: `/api/cms/pages/${args.pageId}/undo`,
        params: { id: String(args.pageId) },
        body: {},
      }),
    ),
  )
  reg('redo_page', { pageId: num() }, async (args) =>
    respond(
      await callRoute(pageRedo, {
        method: 'POST',
        path: `/api/cms/pages/${args.pageId}/redo`,
        params: { id: String(args.pageId) },
        body: {},
      }),
    ),
  )
  regDestructive('discard_page_draft', { pageId: num() }, async (args) =>
    respond(
      await callRoute(pageDiscardDraft, {
        method: 'POST',
        path: `/api/cms/pages/${args.pageId}/discard-draft`,
        params: { id: String(args.pageId) },
        body: {},
      }),
    ),
  )

  // ═══ posts: lifecycle extras (passthrough) ═══
  reg('restore_post', { id: num() }, async (args) =>
    respond(
      await callRoute(postRestore, {
        method: 'POST',
        path: `/api/cms/posts/${args.id}/restore`,
        params: { id: String(args.id) },
      }),
    ),
  )

  // ═══ projects: lifecycle extras (passthrough) ═══
  reg('restore_project', { id: num() }, async (args) =>
    respond(
      await callRoute(projectRestore, {
        method: 'POST',
        path: `/api/cms/projects/${args.id}/restore`,
        params: { id: String(args.id) },
      }),
    ),
  )
  reg(
    'reorder_projects',
    { fields: fields('Reorder payload (the full ordered project id set)') },
    async (args) =>
      respond(
        await callRoute(projectsReorder, {
          method: 'POST',
          path: '/api/cms/projects/reorder',
          body: args.fields,
        }),
      ),
  )
  reg(
    'update_project_section',
    {
      id: num(),
      sectionId: num(),
      fields: fields('Section fields to change'),
    },
    async (args) =>
      respond(
        await callRoute(projectSectionUpdate, {
          method: 'PATCH',
          path: `/api/cms/projects/${args.id}/sections/${args.sectionId}`,
          params: { id: String(args.id), sectionId: String(args.sectionId) },
          body: args.fields,
        }),
      ),
  )
  reg('project_preview_token', { id: num() }, async (args) =>
    respond(
      await callRoute(projectPreviewToken, {
        method: 'POST',
        path: `/api/cms/projects/${args.id}/preview-token`,
        params: { id: String(args.id) },
        body: {},
      }),
    ),
  )

  // ═══ blocks: single-block ops (passthrough) ═══
  reg(
    'create_block',
    { fields: fields('New block: pageId, kind, blockType, parent, data, meta') },
    async (args) =>
      respond(
        await callRoute(blockCreate, {
          method: 'POST',
          path: '/api/cms/blocks',
          body: args.fields,
        }),
      ),
  )
  regDestructive('delete_block', { id: num() }, async (args) =>
    respond(
      await callRoute(blockDelete, {
        method: 'DELETE',
        path: `/api/cms/blocks/${args.id}`,
        params: { id: String(args.id) },
      }),
    ),
  )
  reg(
    'duplicate_block',
    { id: num(), fields: fields('Optional duplicate options').optional() },
    async (args) =>
      respond(
        await callRoute(blockDuplicate, {
          method: 'POST',
          path: `/api/cms/blocks/${args.id}/duplicate`,
          params: { id: String(args.id) },
          body: args.fields ?? {},
        }),
      ),
  )
  reg('restore_block', { id: num() }, async (args) =>
    respond(
      await callRoute(blockRestore, {
        method: 'POST',
        path: `/api/cms/blocks/${args.id}/restore`,
        params: { id: String(args.id) },
        body: {},
      }),
    ),
  )
  reg(
    'reorder_blocks',
    { fields: fields('Reorder payload: parent + the full ordered child id set') },
    async (args) =>
      respond(
        await callRoute(blocksReorder, {
          method: 'POST',
          path: '/api/cms/blocks/reorder',
          body: args.fields,
        }),
      ),
  )

  // ═══ media: upload (multipart) ═══
  reg(
    'upload_media',
    {
      fileBase64: z.string().describe('Base64-encoded file bytes.'),
      filename: z.string().min(1).describe('Original filename (e.g. hero.png).'),
      mimeType: z.string().min(1).describe('MIME type (e.g. image/png).'),
      alt: z.string().min(1).describe('Alt text (required).'),
    },
    async (args) => {
      // Cheap pre-decode guard: reject oversize payloads BEFORE buffering +
      // base64-decoding (the route's authoritative byteLength cap is 25 MB for
      // PDF / 10 MB image; base64 inflates ~4/3). ~34 MB of base64 chars ≈ 25 MB
      // decoded — anything past that can't pass the route, so refuse early.
      const b64 = args.fileBase64 as string
      if (b64.length > 35_000_000) {
        return fail('too_large: file exceeds the upload size limit (25 MB).')
      }
      const buf = Buffer.from(b64, 'base64')
      const blob = new Blob([buf], { type: args.mimeType as string })
      const fd = new FormData()
      fd.append('file', blob, args.filename as string)
      fd.append('alt', args.alt as string)
      return respond(
        await callRoute(mediaCreate, {
          method: 'POST',
          path: '/api/cms/media',
          formData: fd,
        }),
      )
    },
  )

  // ═══ saved blocks (reusable library — `blocks` resource) ═══
  reg('list_saved_blocks', {}, async () =>
    respond(
      await callRoute(savedBlocksList, {
        method: 'GET',
        path: '/api/cms/saved-blocks',
      }),
    ),
  )
  reg('get_saved_block', { id: num() }, async (args) =>
    respond(
      await callRoute(savedBlockGet, {
        method: 'GET',
        path: `/api/cms/saved-blocks/${args.id}`,
        params: { id: String(args.id) },
      }),
    ),
  )
  reg(
    'create_saved_block',
    { fields: fields('Saved-block payload: name + source block id/subtree') },
    async (args) =>
      respond(
        await callRoute(savedBlockCreate, {
          method: 'POST',
          path: '/api/cms/saved-blocks',
          body: args.fields,
        }),
      ),
  )
  regDestructive('delete_saved_block', { id: num() }, async (args) =>
    respond(
      await callRoute(savedBlockDelete, {
        method: 'DELETE',
        path: `/api/cms/saved-blocks/${args.id}`,
        params: { id: String(args.id) },
      }),
    ),
  )
  reg(
    'instantiate_saved_block',
    { id: num(), fields: fields('Target: pageId + parent block id/null + position') },
    async (args) =>
      respond(
        await callRoute(savedBlockInstantiate, {
          method: 'POST',
          path: `/api/cms/saved-blocks/${args.id}/instantiate`,
          params: { id: String(args.id) },
          body: args.fields,
        }),
      ),
  )

  // ═══ templates (passthrough) ═══
  reg(
    'instantiate_template',
    { fields: fields('Template instantiation: template id/key + target pageId') },
    async (args) =>
      respond(
        await callRoute(templateInstantiate, {
          method: 'POST',
          path: '/api/cms/templates/instantiate',
          body: args.fields,
        }),
      ),
  )

  // ═══ sync (local↔remote content sync; passthrough — admin + sync scope) ═══
  reg('sync_list_targets', {}, async () =>
    respond(
      await callRoute(syncTargetsList, {
        method: 'GET',
        path: '/api/cms/sync/targets',
      }),
    ),
  )
  reg(
    'sync_configure_target',
    {
      name: z.string().min(1).max(60).describe('Target name (e.g. "production").'),
      url: z.string().min(1).max(300).describe('Target site URL (http/https).'),
      token: z.string().min(1).max(512).describe('Admin API token for the target (stored encrypted; never echoed back).'),
      accountLabel: z.string().max(120).optional().describe('Optional human label for the target account.'),
    },
    async (args) =>
      respond(
        await callRoute(syncTargetsPut, {
          method: 'PUT',
          path: '/api/cms/sync/targets',
          body: {
            name: args.name,
            url: args.url,
            token: args.token,
            accountLabel: args.accountLabel,
          },
        }),
      ),
  )
  reg(
    'sync_remove_target',
    { name: z.string().min(1).max(60).describe('Target name to remove.') },
    async (args) =>
      respond(
        await callRoute(syncTargetsDelete, {
          method: 'DELETE',
          path: '/api/cms/sync/targets',
          body: { name: args.name },
        }),
      ),
  )
  // sync_pull OVERWRITES this install's content with a remote's — wholesale
  // replace of every page/post/project/setting. There is NO read-only variant
  // (no dryRun), so a real pull ALWAYS requires an explicit confirm, exactly
  // like a destructive op. Hand-rolled (not regDestructive) only so the confirm
  // copy can name what gets replaced.
  reg(
    'sync_pull',
    {
      from: z
        .string()
        .min(1)
        .max(300)
        .optional()
        .describe('Configured target name OR a raw http(s) URL. Omit = the default target.'),
      token: z
        .string()
        .min(1)
        .max(512)
        .optional()
        .describe('Inline token override (raw-URL form, or a just-rotated target).'),
      confirm: z
        .boolean()
        .optional()
        .describe('Required true — pull REPLACES this install’s entire content with the source’s.'),
    },
    async (args) => {
      const okToGo = await confirmDestructive(
        server,
        args.confirm === true,
        'This REPLACES this install’s entire content (pages, posts, projects, settings) with the source’s.',
      )
      if (!okToGo) {
        return fail(
          'Not confirmed. Re-call sync_pull with {"confirm": true} to overwrite this install with the source’s content.',
        )
      }
      return respond(
        await callRoute(syncPull, {
          method: 'POST',
          path: '/api/cms/sync/pull',
          body: { from: args.from, token: args.token },
        }),
      )
    },
  )
  // sync_push REPLACES the target's content, so it confirms like a destructive
  // op — EXCEPT dryRun, which writes nothing. Like edit_page it can't use
  // regDestructive's unconditional gate; it hand-rolls a conditional confirm so a
  // dry run (validate-only) needs no confirmation while a real push does.
  reg(
    'sync_push',
    {
      to: z
        .string()
        .min(1)
        .max(300)
        .optional()
        .describe('Configured target name OR a raw http(s) URL. Omit = the default target.'),
      token: z
        .string()
        .min(1)
        .max(512)
        .optional()
        .describe('Inline token override (raw-URL form, or a just-rotated target).'),
      force: z
        .boolean()
        .optional()
        .describe('Overwrite even if the target drifted since this bundle’s baseline.'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Validate against the target only; writes nothing. No confirmation needed.'),
      confirm: z
        .boolean()
        .optional()
        .describe('Required true for a real push (ignored for dryRun, which writes nothing).'),
    },
    async (args) => {
      // A dry run writes nothing → skip the destructive confirm entirely. A real
      // push REPLACES the target's content → require an explicit confirm (or an
      // accepted elicitation prompt) before dispatching.
      if (args.dryRun !== true) {
        const okToGo = await confirmDestructive(
          server,
          args.confirm === true,
          'This REPLACES the remote target’s content with this install’s content.',
        )
        if (!okToGo) {
          return fail(
            'Not confirmed. Re-call sync_push with {"confirm": true} to replace the target, or {"dryRun": true} to validate without writing.',
          )
        }
      }
      return respond(
        await callRoute(syncPush, {
          method: 'POST',
          path: '/api/cms/sync/push',
          body: {
            to: args.to,
            token: args.token,
            force: args.force,
            dryRun: args.dryRun,
          },
        }),
      )
    },
  )

  // ═══ backups (cloud + local archive; passthrough — admin + backups scope) ═══
  reg(
    'backup_now',
    {
      includeEnv: z
        .boolean()
        .optional()
        .describe('Bundle secrets for full disaster recovery (needs a passphrase for cloud destinations).'),
    },
    async (args) =>
      respond(
        await callRoute(backupsCreate, {
          method: 'POST',
          path: '/api/admin/backups/create',
          body: { includeEnv: args.includeEnv },
        }),
      ),
  )
  reg('backup_list', {}, async () =>
    respond(
      await callRoute(backupsList, {
        method: 'GET',
        path: '/api/admin/backups/list',
      }),
    ),
  )
  reg(
    'backup_status',
    {
      kind: z
        .enum(['backup', 'restore'])
        .optional()
        .describe('Which operation to inspect (default "backup").'),
    },
    async (args) =>
      respond(
        await callRoute(backupsStatus, {
          method: 'GET',
          path: '/api/admin/backups/status',
          query: { kind: args.kind as string | undefined },
        }),
      ),
  )
  reg(
    'backup_remote_list',
    { provider: z.enum(['gdrive', 'onedrive']).describe('Connected cloud provider to list.') },
    async (args) =>
      respond(
        await callRoute(backupsRemoteList, {
          method: 'GET',
          path: '/api/admin/backups/destinations/remote-list',
          query: { provider: args.provider as string },
        }),
      ),
  )
  regDestructive(
    'backup_restore',
    {
      file: z.string().min(1).max(200).describe('Local backup archive basename to restore from.'),
      restoreEnv: z
        .boolean()
        .optional()
        .describe('DANGER: also overwrite the install’s secrets/env from the archive. Default false — leave it false unless you mean to.'),
    },
    async (args) =>
      respond(
        await callRoute(backupsRestore, {
          method: 'POST',
          path: '/api/admin/backups/restore',
          body: { file: args.file, restoreEnv: args.restoreEnv === true },
        }),
      ),
  )
  regDestructive(
    'backup_restore_from_cloud',
    {
      provider: z.enum(['gdrive', 'onedrive']).describe('Cloud provider holding the backup.'),
      remoteId: z.string().min(1).max(400).describe('Remote backup id (from backup_remote_list).'),
      restoreEnv: z
        .boolean()
        .optional()
        .describe('DANGER: also overwrite the install’s secrets/env from the archive. Default false — leave it false unless you mean to.'),
    },
    async (args) =>
      respond(
        await callRoute(backupsRestoreFromCloud, {
          method: 'POST',
          path: '/api/admin/backups/restore-from-cloud',
          body: {
            provider: args.provider,
            remoteId: args.remoteId,
            restoreEnv: args.restoreEnv === true,
          },
        }),
      ),
  )
  regDestructive(
    'backup_delete',
    { file: z.string().min(1).max(200).describe('Local backup archive basename to trash.') },
    async (args) =>
      respond(
        await callRoute(backupsDelete, {
          method: 'POST',
          path: '/api/admin/backups/delete',
          body: { file: args.file },
        }),
      ),
  )
  // backup_configure: the options route body is .strict() AND every field is
  // REQUIRED, so a partial update would 400. Read the current `backups` setting
  // and merge the provided fields onto it before calling — only what the caller
  // passes changes, everything else is preserved. (passphrase nests under
  // encryption in storage but the route takes a flat write-only passphrase /
  // passphraseEnabled; never read the stored passphrase back out.)
  reg(
    'backup_configure',
    {
      destination: z.enum(['local', 'gdrive', 'onedrive']).optional().describe('Where backups go.'),
      remoteRetention: z.number().int().min(1).max(100).optional().describe('How many remote backups to keep.'),
      keepLocalCopy: z.boolean().optional().describe('Keep a local copy alongside a cloud upload.'),
      passphraseEnabled: z.boolean().optional().describe('Encrypt backups with a passphrase.'),
      passphrase: z.string().min(12).max(400).optional().describe('New passphrase (≥12 chars). Omit to keep the existing one.'),
      schedule: z.enum(['off', 'daily', 'weekly']).optional().describe('Automatic backup schedule.'),
      scheduleHour: z.number().int().min(0).max(23).optional().describe('Hour of day (0–23) for scheduled backups.'),
      scheduleWeekday: z.number().int().min(0).max(6).optional().describe('Weekday (0=Sun…6=Sat) for a weekly schedule.'),
    },
    async (args) => {
      // Current config is the base; provided fields override. The route requires
      // the FULL flat body, so reconstruct every field from cur + args.
      const cur = await getSetting('backups')
      const body = {
        destination: (args.destination as string | undefined) ?? cur.destination,
        remoteRetention:
          (args.remoteRetention as number | undefined) ?? cur.remoteRetention,
        keepLocalCopy:
          args.keepLocalCopy === undefined ? cur.keepLocalCopy : args.keepLocalCopy === true,
        passphraseEnabled:
          args.passphraseEnabled === undefined
            ? cur.encryption.passphraseEnabled
            : args.passphraseEnabled === true,
        schedule: (args.schedule as string | undefined) ?? cur.schedule,
        scheduleHour: (args.scheduleHour as number | undefined) ?? cur.scheduleHour,
        scheduleWeekday:
          (args.scheduleWeekday as number | undefined) ?? cur.scheduleWeekday,
        // Write-only: passed only when the caller supplies a new passphrase.
        // Omitted → the route keeps the existing encrypted passphrase.
        ...(typeof args.passphrase === 'string' && args.passphrase.length > 0
          ? { passphrase: args.passphrase }
          : {}),
      }
      return respond(
        await callRoute(backupsOptions, {
          method: 'POST',
          path: '/api/admin/backups/destinations/options',
          body,
        }),
      )
    },
  )
  reg(
    'backup_connect_drive',
    { provider: z.enum(['gdrive', 'onedrive']).describe('Cloud provider to connect.') },
    async (args) =>
      respond(
        await callRoute(backupsConnect, {
          method: 'POST',
          path: '/api/admin/backups/destinations/connect',
          body: { provider: args.provider },
        }),
      ),
  )
  reg(
    'backup_connect_poll',
    { provider: z.enum(['gdrive', 'onedrive']).describe('Cloud provider whose pending connect to poll.') },
    async (args) =>
      respond(
        await callRoute(backupsConnectPoll, {
          method: 'POST',
          path: '/api/admin/backups/destinations/connect/poll',
          body: { provider: args.provider },
        }),
      ),
  )
  reg(
    'backup_disconnect_drive',
    { provider: z.enum(['gdrive', 'onedrive']).describe('Cloud provider to disconnect.') },
    async (args) =>
      respond(
        await callRoute(backupsDisconnect, {
          method: 'POST',
          path: '/api/admin/backups/destinations/disconnect',
          body: { provider: args.provider },
        }),
      ),
  )

  return server
}
