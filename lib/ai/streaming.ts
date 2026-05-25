import 'server-only'

// Server-sent-events helper for the inline AI sparkle stream.
//
// The /api/ai/stream route uses Gemini's `generateContentStream` to
// produce structured-output JSON one chunk at a time. We forward each
// chunk to the browser as an SSE event so the operator sees the
// rewrite appearing live in the streaming preview overlay, then send
// a final `event: done` carrying the validated proposal token + the
// final changeset, or `event: error` with a stable code on failure.
//
// Why SSE instead of fetch+ReadableStream JSON: SSE has built-in
// event framing (event:/data:/id: per record), implicit keepalive via
// blank lines, and Next.js + nginx + Cloudflare all handle it as a
// first-class transport (no buffering surprises). The browser side is
// a one-line EventSource OR a fetch with manual line parsing — we go
// with manual parsing in the client because EventSource doesn't
// support POST.
//
// Headers we always set on the Response:
//   content-type: text/event-stream
//   cache-control: no-store
//   x-accel-buffering: no            (nginx: disables proxy_buffering)
//   connection: keep-alive
//
// Event vocabulary:
//   - `event: chunk`    data: { delta: string, sofar?: string }
//   - `event: progress` data: { stage: 'preparing' | 'generating' | 'finalizing' }
//   - `event: done`     data: { token, changeset, modelText, model, usage }
//   - `event: error`    data: { code, detail? }
//
// `code` on error events is one of:
//   unauthorized | unknown_model | rate_limited | timeout
//   | network_error | validation_failed | not_eligible | invalid_request

export type SseStage = 'preparing' | 'generating' | 'finalizing'

export type SseErrorCode =
  | 'unauthorized'
  | 'unknown_model'
  | 'rate_limited'
  | 'timeout'
  | 'network_error'
  | 'validation_failed'
  | 'not_eligible'
  | 'invalid_request'
  | 'server_error'
  | 'ai_disabled'
  | 'ai_not_configured'
  | 'ai_key_missing'
  | 'ai_key_decrypt_failed'

/** Build the framed-bytes representation of one SSE event. Trailing
 *  blank line is required by the spec so the browser's event parser
 *  fires the dispatch boundary. */
export function formatSse(event: string, data: unknown): string {
  const json = JSON.stringify(data)
  // Defence: SSE forbids `\n` inside a single data: line. JSON.stringify
  // never emits raw newlines (it escapes them as `\n`) so this is
  // structurally safe — the assertion documents the invariant for any
  // future caller that hand-rolls a payload.
  if (json.includes('\n')) {
    throw new Error('formatSse: data must not contain raw newlines')
  }
  return `event: ${event}\ndata: ${json}\n\n`
}

/** Headers helper — every SSE response wears the same set. */
export function sseHeaders(): Headers {
  const h = new Headers()
  h.set('content-type', 'text/event-stream; charset=utf-8')
  h.set('cache-control', 'no-store, no-transform')
  h.set('connection', 'keep-alive')
  // nginx default `proxy_buffering on;` would hold the stream until
  // the underlying upstream closed — which defeats the entire reason
  // we're using SSE. This header tells nginx to flush each write.
  // Cloudflare honours it too.
  h.set('x-accel-buffering', 'no')
  return h
}

/** A live writer wired to a single SSE response. Created via
 *  `createSseStream()` — see the helper for the typical usage shape.
 *  Each method enqueues exactly one framed event onto the underlying
 *  ReadableStream. Calls after `done()` / `error()` / `close()` are
 *  no-ops so a late call can't corrupt the stream or throw. */
export interface SseWriter {
  /** Raw Gemini chunk delta — opaque to the client, included for
   *  debugging / future use. The client preview ignores this when
   *  `field` events are firing. */
  chunk: (data: { delta: string; sofar?: string }) => void
  /** Per-field partial value extracted server-side. The client renders
   *  these onto the live block in the streaming preview overlay so
   *  the operator sees the text grow without exposing JSON internals. */
  field: (data: { path: string; value: string }) => void
  progress: (stage: SseStage) => void
  done: (data: unknown) => void
  error: (code: SseErrorCode, detail?: string) => void
  /** True after done/error/close has fired. Lets the producer skip
   *  expensive work once the consumer disconnected. */
  readonly closed: boolean
  /** Close without emitting a done/error event. Used by the
   *  abort-from-client path where the consumer already disconnected
   *  and emitting more bytes would just be discarded. */
  close: () => void
}

/** Wrap a ReadableStream + writer pair so the route handler can do:
 *
 *   const { stream, writer } = createSseStream()
 *   ... fire writer.chunk(...) / writer.done(...) ...
 *   return new Response(stream, { headers: sseHeaders() })
 *
 *  The stream's start() runs synchronously when the Response begins
 *  serialising, so all writer methods are safe to call immediately
 *  after creation — the underlying controller is set inside start
 *  before the consumer reads the first byte. */
export function createSseStream(opts?: {
  /** Called once when the consumer disconnects (req.signal.aborted).
   *  The writer's `closed` flag flips true regardless; this hook is
   *  for the producer to also cancel the upstream Gemini call. */
  onCancel?: () => void
}): { stream: ReadableStream<Uint8Array>; writer: SseWriter } {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  let closed = false
  let onCancelFired = false

  const safeEnqueue = (frame: string): void => {
    if (closed || !controller) return
    try {
      controller.enqueue(encoder.encode(frame))
    } catch {
      // The consumer closed the stream out from under us (browser
      // navigated, network died). Mark closed so subsequent calls
      // short-circuit; the cancel callback already fired (or will
      // fire imminently via the ReadableStream's cancel hook).
      closed = true
    }
  }

  const safeClose = (): void => {
    if (closed || !controller) {
      closed = true
      return
    }
    closed = true
    try {
      controller.close()
    } catch {
      // Already closed by the consumer cancel path.
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
    cancel() {
      // Consumer disconnect — flip the flag + fire the producer hook
      // exactly once so the upstream Gemini call can be aborted.
      closed = true
      if (!onCancelFired) {
        onCancelFired = true
        opts?.onCancel?.()
      }
    },
  })

  const writer: SseWriter = {
    chunk: (data) => {
      if (closed) return
      safeEnqueue(formatSse('chunk', data))
    },
    field: (data) => {
      if (closed) return
      safeEnqueue(formatSse('field', data))
    },
    progress: (stage) => {
      if (closed) return
      safeEnqueue(formatSse('progress', { stage }))
    },
    done: (data) => {
      if (closed) return
      safeEnqueue(formatSse('done', data))
      safeClose()
    },
    error: (code, detail) => {
      if (closed) return
      safeEnqueue(formatSse('error', detail ? { code, detail } : { code }))
      safeClose()
    },
    close: () => {
      safeClose()
    },
    get closed() {
      return closed
    },
  }

  return { stream, writer }
}
