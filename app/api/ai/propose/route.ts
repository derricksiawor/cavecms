import { z } from 'zod'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkAiChatRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import {
  createSseStream,
  sseHeaders,
  type SseErrorCode,
  type SseWriter,
} from '@/lib/ai/streaming'
import {
  runChatProposal,
  AiUnconfiguredError,
  AiDisabledError,
  AiDecryptError,
  ChatPageNotFoundError,
  ChatModelRequiredError,
} from '@/lib/ai/runChatProposal'
import {
  assertSafePrompt,
  UnsafePromptError,
} from '@/lib/ai/promptSafety'

// PR 4 audit fix (MEDIUM M5): per-user concurrency cap. The route's
// SSE handler can occupy a connection for the 60s deadline. Without
// a parallelism gate a compromised editor session can pin
// `checkAiChatRate` worth of SSE streams (10/min) × 60s = up to 10
// long-lived connections per user. Refuse a second concurrent chat
// per user so the most an authenticated editor can hold is ONE SSE
// stream at a time.
//
// Mounted on `globalThis` so dev hot-reload doesn't leak orphaned
// Sets (each HMR module evaluation re-uses the same singleton).
const __chatInFlightGlobal = globalThis as unknown as {
  __cavecmsChatInFlight?: Set<number>
}
const chatInFlight: Set<number> =
  __chatInFlightGlobal.__cavecmsChatInFlight ?? new Set<number>()
__chatInFlightGlobal.__cavecmsChatInFlight = chatInFlight

// POST /api/ai/propose
//
// Page Assistant chat surface. Body:
//   { pageId: number, userPrompt: string, conversationHistory?: [{role,text}] }
//
// SSE response shape:
//   event: progress  { stage: 'preparing' | 'generating' | 'finalizing' }
//   event: toolCall  { name, args, ok, summary?, error? }
//   event: text      { delta }     (final text reply, emitted once)
//   event: done      { token | null, changeset, modelText, model, usage,
//                      toolCalls, toolBudgetExhausted }
//   event: error     { code, detail? }   on any failure mid-stream
//
// Pre-stream auth / CSRF / rate-limit / shape failures return regular
// JSON 4xx; everything that happens AFTER the SSE response begins
// rides on event:error.
//
// Why SSE for the chat surface even though the underlying Gemini call
// is non-streaming: the tool-call loop can run for several seconds.
// Streaming the per-tool-call events keeps the chat panel feeling
// alive — the operator sees "Inspected the page" / "Edit hero
// heading" cards land as Gemini reasons through them, rather than a
// 10s spinner followed by a wall of text.

export const dynamic = 'force-dynamic'

// Per-turn deadline. Cap higher than inline (the tool loop can chain
// multiple Gemini calls) but bounded so a wedged turn can't hold the
// connection forever.
const CHAT_DEADLINE_MS = 60_000

const HistoryEntry = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string().max(8000),
})

const Body = z
  .object({
    pageId: z.number().int().positive(),
    userPrompt: z.string().min(1).max(2000),
    conversationHistory: z.array(HistoryEntry).max(40).optional(),
  })
  .strict()

type BodyShape = z.infer<typeof Body>

function failJson(
  status: number,
  code: string,
  requestId: string | null,
): Response {
  return new Response(
    JSON.stringify({ error: code, requestId: requestId ?? null }),
    {
      status,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    },
  )
}

function classifyError(
  err: unknown,
  abortSignal: AbortSignal,
): { code: SseErrorCode; detail: string } {
  if (abortSignal.aborted) {
    return { code: 'timeout', detail: 'Gemini did not respond in time.' }
  }
  const e = err as {
    status?: number
    message?: string
    cause?: { message?: string }
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
      return {
        code: 'unknown_model',
        detail: 'Gemini does not recognise the configured model.',
      }
    }
    if (e.status === 429) {
      return {
        code: 'rate_limited',
        detail: 'Gemini rate limit hit. Try again shortly.',
      }
    }
  }
  return { code: 'server_error', detail: 'Gemini returned an error.' }
}

export const POST = withError(async (req: Request) => {
  const auditMeta = auditMetaFromRequest(req)
  const requestId = auditMeta.requestId

  // ── Pre-stream guards. JSON 4xx on failures. ─────────────────────
  const ctx = await requireRole(['admin', 'editor'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  if (!checkAiChatRate(ctx.userId)) {
    return failJson(429, 'rate_limited', requestId)
  }
  if (chatInFlight.has(ctx.userId)) {
    return failJson(429, 'chat_already_in_flight', requestId)
  }

  const raw = await readJsonBody(req)
  let body: BodyShape
  try {
    body = Body.parse(raw)
  } catch {
    return failJson(400, 'invalid_request', requestId)
  }
  try {
    assertSafePrompt(body.userPrompt, 'userPrompt')
    for (const t of body.conversationHistory ?? []) {
      assertSafePrompt(t.text, 'conversationHistory')
    }
  } catch (e) {
    if (e instanceof UnsafePromptError) {
      return failJson(400, 'invalid_request', requestId)
    }
    throw e
  }

  // ── Open SSE. From here errors ride on event:error. ──────────────
  const timeoutSignal = AbortSignal.timeout(CHAT_DEADLINE_MS)
  const combinedAbort = new AbortController()
  const onAbort = () => combinedAbort.abort()
  if (req.signal.aborted) combinedAbort.abort()
  else req.signal.addEventListener('abort', onAbort, { once: true })
  if (timeoutSignal.aborted) combinedAbort.abort()
  else timeoutSignal.addEventListener('abort', onAbort, { once: true })

  const { stream, writer } = createSseStream({
    onCancel: () => {
      combinedAbort.abort()
    },
  })

  chatInFlight.add(ctx.userId)
  const userIdForInFlight = ctx.userId
  void runProducer({
    writer,
    body,
    userId: ctx.userId,
    ip: auditMeta.ip,
    userAgent: auditMeta.userAgent,
    requestId,
    abortSignal: combinedAbort.signal,
  }).finally(() => {
    chatInFlight.delete(userIdForInFlight)
  })

  return new Response(stream, { status: 200, headers: sseHeaders() })
})

interface ProducerArgs {
  writer: SseWriter
  body: BodyShape
  userId: number
  ip: string | null
  userAgent: string | null
  requestId: string | null
  abortSignal: AbortSignal
}

async function runProducer(args: ProducerArgs): Promise<void> {
  try {
    args.writer.progress('generating')
    let result
    try {
      result = await runChatProposal({
        pageId: args.body.pageId,
        userId: args.userId,
        userPrompt: args.body.userPrompt,
        conversationHistory: args.body.conversationHistory,
        ip: args.ip,
        userAgent: args.userAgent,
        requestId: args.requestId,
        abortSignal: args.abortSignal,
        onToolCall: ({ name, args: callArgs, result: callResult }) => {
          if (args.writer.closed) return
          const r = callResult as
            | { ok: true; summary?: string }
            | { ok: false; error: string; detail?: unknown }
          args.writer.field({
            // The streaming helper has no dedicated `toolCall` event,
            // so we ride it on `field` with a structured payload. The
            // client switches on payload.kind. (Adding a true `toolCall`
            // method to SseWriter would force every consumer to update;
            // riding `field` keeps the inline route's contract intact.)
            path: '__toolCall',
            value: JSON.stringify({
              name,
              args: callArgs,
              ok: r.ok,
              ...(r.ok && r.summary ? { summary: r.summary } : {}),
              ...(!r.ok ? { error: r.error } : {}),
            }),
          })
        },
      })
    } catch (err) {
      if (args.writer.closed) return
      if (err instanceof AiUnconfiguredError) {
        args.writer.error(err.code)
        return
      }
      if (err instanceof AiDisabledError) {
        args.writer.error('ai_disabled')
        return
      }
      if (err instanceof AiDecryptError) {
        args.writer.error('ai_key_decrypt_failed')
        return
      }
      if (err instanceof ChatPageNotFoundError) {
        args.writer.error('invalid_request', 'Page not found.')
        return
      }
      if (err instanceof ChatModelRequiredError) {
        args.writer.error('unknown_model', 'Chat model not configured.')
        return
      }
      if (err instanceof UnsafePromptError) {
        args.writer.error('invalid_request', 'Prompt contains unsafe characters.')
        return
      }
      const { code, detail } = classifyError(err, args.abortSignal)
      args.writer.error(code, detail)
      return
    }

    if (args.writer.closed) return

    // Stream the model's final text reply as one delta. (Could be
    // chunked for richer animation, but the Gemini SDK already
    // returned the text in one piece by the time we get here.)
    if (result.modelText.length > 0) {
      args.writer.chunk({ delta: result.modelText, sofar: result.modelText })
    }

    args.writer.progress('finalizing')
    args.writer.done({
      token: result.token,
      changeset: result.changeset,
      modelText: result.modelText,
      model: result.model,
      usage: result.usage,
      toolCalls: result.toolCalls,
      toolBudgetExhausted: result.toolBudgetExhausted,
    })
  } catch (err) {
    if (!args.writer.closed) {
      args.writer.error('server_error', 'Chat request failed.')
    }
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'ai_chat_producer_unhandled',
        request_id: args.requestId,
        err_name: err instanceof Error ? err.name : 'unknown',
      }),
    )
  } finally {
    if (!args.writer.closed) args.writer.close()
  }
}
