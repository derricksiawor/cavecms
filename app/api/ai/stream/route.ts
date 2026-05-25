import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { rateLimit } from '@/lib/auth/rateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import {
  getActiveAiClient,
  AiDecryptError,
  AiDisabledError,
  AiUnconfiguredError,
} from '@/lib/ai/client'
import {
  createSseStream,
  sseHeaders,
  type SseErrorCode,
  type SseWriter,
} from '@/lib/ai/streaming'
import {
  InlineRequestSchema,
  persistInlineProposal,
  type InlineRequestBody,
} from '@/lib/ai/runProposal'
import {
  isInlineAiEligible,
  mergeFieldValues,
  resolveFieldValues,
  supportsSuggest,
} from '@/lib/ai/inlineEligibility'
import { buildInlineSystemPrompt } from '@/lib/ai/prompts/system'
import {
  buildIntent,
  parseFieldsResponse,
  parseSuggestResponse,
  type IntentArgs,
} from '@/lib/ai/prompts/inline'
import { parseAndSanitize } from '@/lib/cms/parse'
import { hydratePage } from '@/lib/cms/hydrate'
import { registry } from '@/lib/cms/settings-registry'
import { sanitizeRichText } from '@/lib/cms/sanitize'

// POST /api/ai/stream
//
// Server-Sent Events endpoint for the inline AI sparkle. Operator
// submits a small JSON body (intent + target block + tone/lang/free-
// text); we stream Gemini chunks back as SSE events so the live block
// preview animates in real time; on completion we INSERT an
// ai_proposals row with the validated + sanitized payload and emit
// `event: done` carrying the proposal token.
//
// SECURITY MODEL (mirrors /api/admin/ai/verify but wider):
//
//   - admin OR editor role (verify is admin-only; inline AI is
//     editor-usable so we widen here)
//   - CSRF required
//   - Dedicated bucket cms:ai-inline:user 30/min — generous enough
//     for an editor working through a page, tight enough that a
//     stolen session can't burn through the operator's Gemini quota
//   - Block must belong to pageId AND be in the inline allow-list
//   - Free-text input passes through the same UNSAFE_PROMPT_CHARS
//     filter as the verify route + the chat surface
//   - Every Gemini response is re-validated through parseAndSanitize
//     BEFORE the ai_proposals INSERT. A schema-conforming Gemini
//     output that smuggles unsafe HTML in a body_richtext field is
//     caught by DOMPurify inside parseAndSanitize, not by Gemini's
//     responseSchema awareness.
//   - 30s deadline on the Gemini call. Forwarded to Gemini via
//     `config.abortSignal` AND wired to the client-disconnect signal
//     so a cancelled fetch aborts the upstream call.
//
// NOTE: this route does NOT live under /api/admin — editors and
// admins both reach for it. The role gate inside requireRole(['admin',
// 'editor']) is the access boundary; the admin-only routes under
// /api/admin keep the verify + settings paths.

export const dynamic = 'force-dynamic'

// 30s — Gemini structured-output streams complete well inside this
// budget for the inline payload sizes (a single block's worth of
// rewrite/translate). Past that, the operator's wait crosses into
// "this is broken" territory.
const STREAM_DEADLINE_MS = 30_000

// Dedicated rate-limit bucket. Generous enough for an active editor
// (rewrite 4 blocks, translate 3, suggest 2 = 9 calls/min comfortably);
// tight enough that an attacker controlling a stolen session burns
// out fast.
const limitAiInline = rateLimit('cms:ai-inline:user', {
  limit: 30,
  windowSec: 60,
})

interface BlockRow {
  id: number
  page_id: number
  block_type: string
  data: string
  version: number
  kind: string
}

// ── Streaming partial-field extractor ─────────────────────────────
// Gemini's structured-output stream emits JSON-shaped chunks. We want
// to surface field-level previews to the operator as the values form,
// without the client seeing raw JSON. So on each chunk we scan the
// accumulated buffer for `"path": "value"` pairs (allowing incomplete
// trailing values) and emit deltas for any field that grew.
//
// The regex is liberal — it doesn't validate the JSON shape, just
// extracts key→value pairs that look like ours. The final
// JSON.parse on stream-complete is the strict gate.
const FIELD_PAIR_RE = /"((?:[^"\\]|\\.)+)"\s*:\s*"((?:[^"\\]|\\")*?)(?:"|$)/g

function extractFieldPartials(
  buffer: string,
  allowedPaths: ReadonlySet<string>,
): Map<string, string> {
  // The wrapping `{"fields": {` opens at some position; we want pairs
  // INSIDE that object. Anchor by finding the first `"fields":` then
  // scanning afterwards. Falls back to scanning the whole buffer if
  // the anchor isn't found yet (early chunks before Gemini emits the
  // wrapping key).
  const anchor = buffer.indexOf('"fields"')
  const scanFrom = anchor >= 0 ? anchor + '"fields"'.length : 0
  const tail = buffer.slice(scanFrom)
  FIELD_PAIR_RE.lastIndex = 0
  const out = new Map<string, string>()
  let match: RegExpExecArray | null
  while ((match = FIELD_PAIR_RE.exec(tail)) !== null) {
    const key = match[1] ?? ''
    const rawValue = match[2] ?? ''
    if (!allowedPaths.has(key)) continue
    // Resolve common JSON escapes so the operator sees a clean
    // streaming preview. We don't run JSON.parse on the fragment
    // (it's incomplete by design) — manual unescape covers \" \\
    // \n \r \t \/ \b \f \uXXXX. Anything else lands verbatim.
    out.set(key, unescapeJsonFragment(rawValue))
  }
  return out
}

function unescapeJsonFragment(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = raw[i + 1]
    if (next === undefined) {
      // Trailing backslash mid-stream — drop it; the next chunk will
      // restart the scan with the matched escape sequence.
      break
    }
    switch (next) {
      case '"':
      case '\\':
      case '/':
        out += next
        i++
        break
      case 'n':
        out += '\n'
        i++
        break
      case 'r':
        out += '\r'
        i++
        break
      case 't':
        out += '\t'
        i++
        break
      case 'b':
        out += '\b'
        i++
        break
      case 'f':
        out += '\f'
        i++
        break
      case 'u': {
        const hex = raw.slice(i + 2, i + 6)
        if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16))
          i += 5
        } else {
          // Partial unicode escape mid-stream — wait for next chunk.
          break
        }
        break
      }
      default:
        out += next
        i++
    }
  }
  return out
}

// ── Site context resolver ─────────────────────────────────────────
// Reads the default_seo + site_general settings for the system prompt.
// Both are best-effort — a fresh install without these set still
// generates a useful proposal, the system prompt just omits the lines.

interface SettingValueRow {
  value: unknown
}

async function readSiteContext(): Promise<{ siteName?: string; siteDescription?: string }> {
  try {
    const [rows] = (await db.execute(sql`
      SELECT \`key\`, value FROM settings
      WHERE \`key\` IN ('default_seo', 'site_general')
    `)) as unknown as [Array<{ key: string } & SettingValueRow>]
    let siteName: string | undefined
    let siteDescription: string | undefined
    for (const row of rows) {
      const raw =
        typeof row.value === 'string'
          ? (() => {
              try {
                return JSON.parse(row.value as string) as unknown
              } catch {
                return null
              }
            })()
          : row.value
      if (!raw || typeof raw !== 'object') continue
      const obj = raw as Record<string, unknown>
      if (row.key === 'default_seo') {
        if (typeof obj['title'] === 'string') {
          siteName = siteName ?? (obj['title'] as string)
        }
        if (typeof obj['description'] === 'string') {
          siteDescription = obj['description'] as string
        }
      } else if (row.key === 'site_general') {
        if (typeof obj['siteName'] === 'string') {
          siteName = obj['siteName'] as string
        }
      }
    }
    return { siteName, siteDescription }
  } catch {
    return {}
  }
}

async function readAiConfigVoice(): Promise<{
  voicePreset: 'default' | 'editorial' | 'friendly' | 'professional' | 'playful' | 'custom'
  customVoiceNotes?: string
}> {
  try {
    const [rows] = (await db.execute(sql`
      SELECT value FROM settings WHERE \`key\` = 'ai_config'
    `)) as unknown as [SettingValueRow[]]
    if (!rows[0]) return { voicePreset: 'default' }
    const raw = rows[0].value
    const obj =
      typeof raw === 'string'
        ? (() => {
            try {
              return JSON.parse(raw) as unknown
            } catch {
              return null
            }
          })()
        : raw
    const parseResult = registry.ai_config.schema.safeParse(obj)
    if (!parseResult.success) return { voicePreset: 'default' }
    return {
      voicePreset: parseResult.data.voicePreset,
      customVoiceNotes: parseResult.data.customVoiceNotes,
    }
  } catch {
    return { voicePreset: 'default' }
  }
}

// Collect short text snippets from up to 3 sibling widgets for tone
// context. Skips media-only blocks and the target block itself.
function pickNeighbourText(
  blocks: ReadonlyArray<{ id: number; blockType: string; data: unknown }>,
  excludeBlockId: number,
  limit = 3,
): string[] {
  const out: string[] = []
  for (const b of blocks) {
    if (b.id === excludeBlockId) continue
    if (out.length >= limit) break
    const resolved = resolveFieldValues(b.blockType, b.data)
    for (const r of resolved) {
      const v = r.value.trim()
      if (v.length === 0) continue
      out.push(v.length > 240 ? `${v.slice(0, 239)}…` : v)
      break // one excerpt per block
    }
  }
  return out
}

// ── Friendly JSON error helper for pre-stream failures ─────────────
// The first auth/rate-limit/csrf failure should produce a normal
// JSON 4xx response, not an SSE event-stream. Once we've opened the
// SSE stream we never go back — any later error rides on `event: error`.

function failJson(status: number, code: string, requestId: string | null): Response {
  return new Response(JSON.stringify({ error: code, requestId: requestId ?? null }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

// Map an SDK error inside the SSE stream to a stable SseErrorCode +
// short detail. Mirrors the verify route's classifier so the client-
// side error handler is symmetric.
function classifyGeminiError(
  err: unknown,
  signal: AbortSignal,
): { code: SseErrorCode; detail: string } {
  if (signal.aborted) {
    return { code: 'timeout', detail: 'Gemini did not respond in time.' }
  }
  const e = err as {
    status?: number
    message?: string
    name?: string
    cause?: { name?: string; message?: string }
  }
  const msg = (e?.message ?? '').toLowerCase()
  const causeMsg = (e?.cause?.message ?? '').toLowerCase()
  if (
    msg.includes('fetch failed') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('etimedout') ||
    causeMsg.includes('econnrefused') ||
    causeMsg.includes('enotfound')
  ) {
    return { code: 'network_error', detail: 'Could not reach Gemini.' }
  }
  if (typeof e?.status === 'number') {
    if (e.status === 401 || e.status === 403) {
      return { code: 'unauthorized', detail: 'Gemini rejected the API key.' }
    }
    if (e.status === 404) {
      return { code: 'unknown_model', detail: 'Gemini does not recognise the configured model.' }
    }
    if (e.status === 429) {
      return { code: 'rate_limited', detail: 'Gemini rate limit hit. Try again shortly.' }
    }
  }
  return { code: 'server_error', detail: 'Gemini returned an error.' }
}

export const POST = withError(async (req: Request) => {
  const auditMeta = auditMetaFromRequest(req)
  const requestId = auditMeta.requestId
  // ── Pre-stream guards. Failures here surface as normal JSON 4xx. ──
  const ctx = await requireRole(['admin', 'editor'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  if (!limitAiInline(String(ctx.userId))) {
    return failJson(429, 'rate_limited', requestId)
  }

  const raw = await readJsonBody(req)
  let body: InlineRequestBody
  try {
    body = InlineRequestSchema.parse(raw)
  } catch {
    return failJson(400, 'invalid_request', requestId)
  }

  // Resolve the active Gemini client + ai_config. Failures map to
  // clean 422 codes so the operator sees an actionable toast.
  let aiClient: Awaited<ReturnType<typeof getActiveAiClient>>
  try {
    aiClient = await getActiveAiClient()
  } catch (err) {
    if (err instanceof AiUnconfiguredError) {
      return failJson(422, err.code, requestId)
    }
    if (err instanceof AiDisabledError) {
      return failJson(422, 'ai_disabled', requestId)
    }
    if (err instanceof AiDecryptError) {
      return failJson(422, 'ai_key_decrypt_failed', requestId)
    }
    throw err
  }
  if (!aiClient.config.inlineEnabled) {
    return failJson(422, 'ai_disabled', requestId)
  }
  const model = aiClient.config.models?.inline
  if (!model) {
    return failJson(422, 'inline_model_required_when_inline_enabled', requestId)
  }

  // Verify the block exists, belongs to the page, is a widget, and
  // is inline-AI-eligible. Single SELECT (raw — we want page_id +
  // version atomically).
  const [blockRows] = (await db.execute(sql`
    SELECT id, page_id, block_type, data, version, kind
    FROM content_blocks
    WHERE id = ${body.blockId}
      AND page_id = ${body.pageId}
      AND deleted_at IS NULL
    LIMIT 1
  `)) as unknown as [BlockRow[]]
  const block = blockRows[0]
  if (!block) {
    return failJson(404, 'block_not_found', requestId)
  }
  if (block.kind !== 'widget') {
    return failJson(422, 'not_eligible', requestId)
  }
  if (!isInlineAiEligible(block.block_type)) {
    return failJson(422, 'not_eligible', requestId)
  }

  // Suggest gating: only on blocks with a single primary scalar.
  if (body.intent === 'suggest' && !supportsSuggest(block.block_type)) {
    return failJson(422, 'not_eligible', requestId)
  }

  // Parse current block data through parseForRead — defence in depth
  // against a corrupted row. We need the parsed object to merge
  // Gemini's reply into.
  let currentData: unknown
  try {
    currentData = JSON.parse(block.data)
  } catch {
    return failJson(422, 'validation_failed', requestId)
  }
  let parsedCurrent: unknown
  try {
    parsedCurrent = parseAndSanitize(block.block_type, currentData)
  } catch {
    return failJson(422, 'validation_failed', requestId)
  }

  // Resolve eligible fields and their current values.
  const fields = resolveFieldValues(block.block_type, parsedCurrent)
  if (fields.length === 0) {
    return failJson(422, 'not_eligible', requestId)
  }
  const allowedPaths = new Set(fields.map((f) => f.path))
  // Per-field richtext map — drives both the streaming `field` event's
  // per-chunk sanitization AND the post-merge data sanitization before
  // the SSE `done` event. Indexed paths (items[0].body_richtext) all
  // share the schema kind of their base path (items[].body_richtext),
  // so we strip the [N] before lookup.
  const richtextPaths = new Set(
    fields.filter((f) => f.kind === 'richtext').map((f) => f.path),
  )

  // Build prompts.
  const intentArgs: IntentArgs =
    body.intent === 'rewrite'
      ? { intent: 'rewrite', fields, toneChip: body.toneChip, freeText: body.freeText }
      : body.intent === 'translate'
        ? {
            intent: 'translate',
            fields,
            language: body.language!,
            freeText: body.freeText,
          }
        : body.intent === 'suggest'
          ? { intent: 'suggest', fields, freeText: body.freeText }
          : { intent: 'fillin', fields, freeText: body.freeText }
  const built = buildIntent(intentArgs)

  // Site context + voice preset.
  const [siteCtx, voice] = await Promise.all([
    readSiteContext(),
    readAiConfigVoice(),
  ])

  // Sibling text for tone reference. hydratePage hits the DB once;
  // its result includes parsed widget data for every block on the
  // page. We could optimise to a smaller query later, but for now
  // the same primitive every block-edit save uses keeps the code
  // shape consistent.
  let neighbours: string[] = []
  try {
    const hydrated = await hydratePage(body.pageId)
    if (hydrated) {
      neighbours = pickNeighbourText(
        hydrated.blocks.map((b) => ({
          id: b.id,
          blockType: b.blockType,
          data: b.data,
        })),
        block.id,
      )
    }
  } catch {
    // Tone context is non-essential — proceed without it.
  }

  const systemPrompt = buildInlineSystemPrompt({
    voicePreset: voice.voicePreset,
    customVoiceNotes: voice.customVoiceNotes,
    siteName: siteCtx.siteName,
    siteDescription: siteCtx.siteDescription,
    blockType: block.block_type,
    fields,
    neighbours,
  })

  // ── Open the SSE stream. ALL subsequent errors ride on event:error. ──
  // The request signal carries the client-disconnect notification;
  // chaining it with our timeout AbortSignal so EITHER trigger aborts
  // the Gemini call cleanly.
  const timeoutSignal = AbortSignal.timeout(STREAM_DEADLINE_MS)
  const combinedAbort = new AbortController()
  const onAbort = () => combinedAbort.abort()
  if (req.signal.aborted) combinedAbort.abort()
  else req.signal.addEventListener('abort', onAbort, { once: true })
  if (timeoutSignal.aborted) combinedAbort.abort()
  else timeoutSignal.addEventListener('abort', onAbort, { once: true })

  const { stream, writer } = createSseStream({
    onCancel: () => {
      // Browser disconnected. Abort the upstream Gemini call so we
      // stop burning the operator's quota for a stream nobody is
      // watching.
      combinedAbort.abort()
    },
  })

  // Run the producer asynchronously — return the Response immediately
  // so the client sees the stream begin while we work.
  void runProducer({
    writer,
    aiClient: aiClient.client,
    model,
    systemPrompt,
    userMessage: built.userMessage,
    responseSchema: built.responseSchema,
    intent: body.intent,
    toneChip: body.toneChip,
    language: body.language,
    freeText: body.freeText,
    blockType: block.block_type,
    blockId: block.id,
    blockVersion: block.version,
    pageId: block.page_id,
    parsedCurrent,
    allowedPaths,
    abortSignal: combinedAbort.signal,
    userId: ctx.userId,
    ip: auditMeta.ip,
    userAgent: auditMeta.userAgent,
    requestId,
    richtextPaths,
  })

  return new Response(stream, { status: 200, headers: sseHeaders() })
})

// Strip [N] index notation from a concrete path so it can be looked up
// in the schema-level richtext-path set. 'items[0].body_richtext' →
// 'items[].body_richtext'.
function basePath(concretePath: string): string {
  return concretePath.replace(/\[\d+\]/g, '[]')
}

interface ProducerArgs {
  writer: SseWriter
  aiClient: Awaited<ReturnType<typeof getActiveAiClient>>['client']
  model: string
  systemPrompt: string
  userMessage: string
  responseSchema: unknown
  intent: 'rewrite' | 'translate' | 'suggest' | 'fillin'
  toneChip?: string
  language?: string
  freeText?: string
  blockType: string
  blockId: number
  blockVersion: number
  pageId: number
  parsedCurrent: unknown
  allowedPaths: ReadonlySet<string>
  abortSignal: AbortSignal
  userId: number
  ip: string | null
  userAgent: string | null
  requestId: string | null
  /** Schema-level set of richtext field paths (with `[]` notation).
   *  Concrete `items[N].body_richtext` paths from the stream are
   *  normalised to `items[].body_richtext` before lookup. */
  richtextPaths: ReadonlySet<string>
}

async function runProducer(args: ProducerArgs): Promise<void> {
  const startedAt = Date.now()
  const lastEmitted = new Map<string, string>()

  args.writer.progress('preparing')

  let accumulated = ''
  let usage: {
    promptTokens: number
    outputTokens: number
    latencyMs: number
  } = { promptTokens: 0, outputTokens: 0, latencyMs: 0 }

  // Wrap the entire producer in an outer try so an unhandled rejection
  // doesn't crash the worker (instrumentation.ts treats unhandled
  // rejections as fatal per the withError comment). Every failure
  // surfaces as `event: error` on the SSE stream + the writer closes.
  try {
   try {
    args.writer.progress('generating')
    const stream = await args.aiClient.models.generateContentStream({
      model: args.model,
      contents: args.userMessage,
      config: {
        systemInstruction: args.systemPrompt,
        responseMimeType: 'application/json',
        // Cast — Gemini SDK's SchemaUnion accepts plain-object schemas;
        // our buildIntent emits objects with a few extension fields
        // (description, maxLength) that the SDK forwards intact.
        responseSchema: args.responseSchema as never,
        abortSignal: args.abortSignal,
        // Generous output cap — block field max-lengths already gate
        // the result. 4K tokens is comfortably above any reasonable
        // block payload + chrome.
        maxOutputTokens: 4096,
        // Temperature 0.7 is the sweet spot for writing tasks per
        // Gemini docs — too low produces robotic output, too high
        // hallucinates. Operator does not configure this (#0.058
        // expose-with-reason rule); a creator-locked default is right.
        temperature: 0.7,
      },
    })

    for await (const chunk of stream) {
      if (args.writer.closed) {
        // Consumer disconnected — bail out of the loop without further
        // emits. The abort signal already fired through onCancel.
        break
      }
      const delta = typeof chunk.text === 'string' ? chunk.text : ''
      if (delta.length > 0) {
        accumulated += delta
        args.writer.chunk({ delta, sofar: accumulated })
        // Per-field partial extraction — emit any field whose visible
        // value grew since last chunk. The client uses these to update
        // the streaming preview overlay on the live block.
        if (args.intent !== 'suggest') {
          const partials = extractFieldPartials(accumulated, args.allowedPaths)
          for (const [path, value] of partials) {
            // Sanitize richtext partials BEFORE emitting so a Gemini
            // emission that smuggled `<script>` / `onerror=` /
            // `<iframe>` can never reach the client's preview overlay.
            // Plain-text fields are unchanged. The schema check on the
            // base path (items[0].body_richtext → items[].body_richtext)
            // covers both top-level and per-item richtext fields.
            const safeValue = args.richtextPaths.has(basePath(path))
              ? sanitizeRichText(value)
              : value
            if (lastEmitted.get(path) === safeValue) continue
            lastEmitted.set(path, safeValue)
            // Dedicated `field` event so the client doesn't have to
            // disambiguate from raw Gemini chunks.
            args.writer.field({ path, value: safeValue })
          }
        }
      }
      // Each chunk MAY carry usage metadata; the final chunk usually
      // does. Update each time so we capture the latest non-empty
      // reading.
      const um = chunk.usageMetadata
      if (um) {
        usage = {
          promptTokens: um.promptTokenCount ?? usage.promptTokens,
          outputTokens: um.candidatesTokenCount ?? usage.outputTokens,
          latencyMs: 0,
        }
      }
    }
  } catch (err) {
    if (args.writer.closed) return
    const { code, detail } = classifyGeminiError(err, args.abortSignal)
    args.writer.error(code, detail)
    return
  }
  usage.latencyMs = Date.now() - startedAt

  if (args.writer.closed) return
  if (accumulated.trim().length === 0) {
    args.writer.error('server_error', 'Gemini returned an empty response.')
    return
  }

  args.writer.progress('finalizing')

  // Parse + validate the accumulated response.
  if (args.intent === 'suggest') {
    const parsed = parseSuggestResponse(accumulated)
    if (!parsed) {
      args.writer.error('validation_failed', 'Could not parse model output.')
      return
    }
    // For Suggest we don't persist a proposal at stream-end — the
    // operator picks ONE option then we mint a proposal for that
    // single choice. Emit `done` with the 3 options + a callback the
    // client uses for "Apply this one".
    //
    // To keep the apply pipeline uniform, we persist all 3 candidate
    // proposals up front, return all 3 tokens, and the client calls
    // apply on whichever the operator picks. The unpicked two
    // auto-expire after 30 min.
    const primary = resolveFieldValues(args.blockType, args.parsedCurrent).find(
      (f) => f.primary,
    )
    if (!primary) {
      args.writer.error('not_eligible', 'Block has no primary field for suggest.')
      return
    }
    const proposals: Array<{ option: string; token: string }> = []
    for (const option of parsed.options) {
      const merged = mergeFieldValues(args.parsedCurrent, { [primary.path]: option })
      try {
        const persisted = await persistInlineProposal({
          userId: args.userId,
          pageId: args.pageId,
          intent: 'suggest',
          freeText: args.freeText,
          model: args.model,
          modelText: option,
          usage,
          op: {
            op: 'edit',
            blockId: args.blockId,
            blockType: args.blockType,
            data: merged,
            expectedBlockVersion: args.blockVersion,
          },
          ip: args.ip,
          userAgent: args.userAgent,
          requestId: args.requestId,
        })
        proposals.push({ option, token: persisted.token })
      } catch (err) {
        if (err instanceof HttpError && err.status === 422) {
          args.writer.error('validation_failed', 'Model produced invalid output.')
          return
        }
        throw err
      }
    }
    args.writer.done({
      intent: 'suggest',
      blockId: args.blockId,
      primaryPath: primary.path,
      options: proposals,
      model: args.model,
      usage,
    })
    return
  }

  // rewrite / translate / fillin: single proposal, single op.
  const parsed = parseFieldsResponse(accumulated, args.allowedPaths)
  if (!parsed) {
    args.writer.error('validation_failed', 'Could not parse model output.')
    return
  }
  // Sanitize richtext fields BEFORE merging — so the merged blob
  // emitted on the `done` event has DOMPurify-clean HTML in every
  // richtext slot. parseAndSanitize re-runs inside persistInlineProposal
  // on the DB path; this pre-pass exists so the SSE client never
  // sees attacker HTML even briefly. Plain-text fields pass through
  // unchanged.
  const safeFields: Record<string, string> = {}
  for (const [path, value] of Object.entries(parsed.fields)) {
    safeFields[path] = args.richtextPaths.has(basePath(path))
      ? sanitizeRichText(value)
      : value
  }
  const merged = mergeFieldValues(args.parsedCurrent, safeFields)
  try {
    const persisted = await persistInlineProposal({
      userId: args.userId,
      pageId: args.pageId,
      intent: args.intent,
      toneChip: args.toneChip,
      language: args.language,
      freeText: args.freeText,
      model: args.model,
      modelText: accumulated,
      usage,
      op: {
        op: 'edit',
        blockId: args.blockId,
        blockType: args.blockType,
        data: merged,
        expectedBlockVersion: args.blockVersion,
      },
      ip: args.ip,
      userAgent: args.userAgent,
      requestId: args.requestId,
    })
    args.writer.done({
      intent: args.intent,
      blockId: args.blockId,
      token: persisted.token,
      proposedData: merged,
      changedFields: safeFields,
      model: args.model,
      usage,
    })
  } catch (err) {
    if (err instanceof HttpError && err.status === 422) {
      args.writer.error('validation_failed', 'Model produced invalid output.')
      return
    }
    throw err
  }
  } catch (err) {
    // Outer catch-all. Anything that escapes the inner try/catch blocks
    // (DB outage inside persistInlineProposal, unexpected throw from
    // the stream loop, anything else) surfaces as a clean error event
    // + the writer closes so the consumer doesn't hang. WITHOUT this
    // wrapper, an unhandled rejection from the `void runProducer(...)`
    // call site would propagate to instrumentation.ts's unhandled-
    // rejection handler, which is treated as fatal.
    if (!args.writer.closed) {
      // Generic detail — do NOT echo Gemini SDK errors verbatim
      // (they sometimes contain key fragments / endpoint URLs).
      args.writer.error('server_error', 'AI request failed.')
    }
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'ai_stream_producer_unhandled',
        request_id: args.requestId,
        err_name: err instanceof Error ? err.name : 'unknown',
      }),
    )
  } finally {
    if (!args.writer.closed) args.writer.close()
  }
}

