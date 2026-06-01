import 'server-only'
import { randomUUID } from 'node:crypto'
import { ZodError } from 'zod'
import { HttpError } from '@/lib/auth/requireRole'
import { UnknownBlockTypeError } from '@/lib/cms/block-registry'
import { env } from '@/lib/env'

export function jsonError(status: number, error: string, requestId: string): Response {
  return new Response(JSON.stringify({ error, requestId }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

// WeakMap-backed request-id accessor. withError stashes the UUID it
// generated for log correlation here; handlers read it via getRequestId
// so audit rows can join 1:1 against log lines. WeakMap so the entry GCs
// when the Request object does.
const requestIds = new WeakMap<Request, string>()

// Operator-controlled inbound `x-request-id` is OPTIONAL — when present
// and well-formed we honour it (so an upstream proxy / load balancer
// can correlate end-to-end across services); when absent OR malformed
// we fall back to the freshly-generated UUID stored in the WeakMap.
// Constraint: ASCII letters/digits/underscore/hyphen, 1..64 chars.
// Anything else (spaces, JSON, control bytes, unreasonable length) is
// untrusted and silently discarded with a warn-level structured log so
// a misbehaving upstream is observable but cannot poison audit_log /
// log-aggregator joins by injecting fake request ids.
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

export function getRequestId(req: Request): string | null {
  const generated = requestIds.get(req) ?? null
  const inbound = req.headers.get('x-request-id')
  if (inbound === null || inbound === '') return generated
  if (REQUEST_ID_PATTERN.test(inbound)) return inbound
  // Malformed inbound — fall back to the generated UUID and signal
  // the upstream misbehaviour. Not fatal: the generated id still
  // correlates this request internally.
  console.warn(JSON.stringify({
    level: 'warn',
    msg: 'inbound_request_id_rejected',
    inbound_len: inbound.length,
    requestId: generated,
  }))
  return generated
}

// Generic over the Next.js 15 route-handler context. Static routes call
// `withError(async (req) => ...)` and TCtx falls back to `unknown` — which
// satisfies Next's RouteHandlerConfig validator (function param types are
// contravariant; `{ params: Promise<{}> }` is a subtype of `unknown` so the
// wrapper is assignable to the framework's stricter handler shape).
// Dynamic routes pass `withError<{ params: Promise<{ id: string }> }>(async (req, { params }) => ...)`
// to get typed params. The wrapper forwards ctx to the handler unchanged.
export function withError<TCtx = unknown>(
  handler: (req: Request, ctx: TCtx) => Promise<Response>,
  // Per-route overrides. `timeoutMs` raises the wall-clock budget for handlers
  // that legitimately run long (e.g. the sync cutover: a content mysqldump +
  // the swap transaction can exceed the 15s default on a large site). Defaults
  // to env.HANDLER_TIMEOUT_MS for every existing route — opt-in only.
  opts?: { timeoutMs?: number },
) {
  return async (req: Request, ctx: TCtx): Promise<Response> => {
    const requestId = randomUUID()
    requestIds.set(req, requestId)
    let timer: NodeJS.Timeout | undefined
    const timeoutPromise = new Promise<Response>((_, reject) => {
      timer = setTimeout(
        () => reject(new HttpError(504, 'handler_timeout')),
        opts?.timeoutMs ?? env.HANDLER_TIMEOUT_MS,
      )
      timer.unref()
    })
    // Capture the handler promise so we can attach a .catch that ABSORBS any
    // POST-RACE rejection — preventing the orphaned-handler-after-timeout
    // unhandled rejection that instrumentation.ts treats as fatal.
    // The `raceSettled` flag ensures the inline .catch only fires AFTER the
    // race has resolved (otherwise we'd double-log a normal handler rejection,
    // which is also caught by the outer try/catch below).
    let raceSettled = false
    const handlerPromise = handler(req, ctx)
    handlerPromise.catch((postRaceErr: unknown) => {
      if (!raceSettled) return
      console.error(JSON.stringify({
        level: 'warn',
        msg: 'handler_post_race_rejection',
        requestId,
        err_name: postRaceErr instanceof Error ? postRaceErr.name : 'unknown',
      }))
    })
    try {
      const result = await Promise.race([handlerPromise, timeoutPromise])
      raceSettled = true
      return result
    } catch (err: unknown) {
      raceSettled = true
      // Log only structural fields, never the raw error message — third-party
      // libraries have historically embedded connection strings, secrets, or
      // stack traces with PII into Error.message. Stack lands behind a flag.
      const safe: Record<string, unknown> = { level: 'error', requestId }
      // MySQL-driven rollback signals — surface as retryable 409 so the
      // client can re-issue the save instead of seeing a generic 500.
      // Detected via mysql2's `err.code` string OR numeric errno fallback
      // for connector swaps (mariadb driver, undici-mysql, planetscale)
      // that may surface only one. Both codes are transient by definition
      // (deadlock victim picked at random, lock-wait expired).
      const errObj =
        typeof err === 'object' && err !== null
          ? (err as { code?: unknown; errno?: unknown })
          : null
      const mysqlCode = errObj?.code
      const mysqlErrno = errObj?.errno
      const isLockConflict =
        mysqlCode === 'ER_LOCK_DEADLOCK' ||
        mysqlCode === 'ER_LOCK_WAIT_TIMEOUT' ||
        mysqlErrno === 1213 || // ER_LOCK_DEADLOCK
        mysqlErrno === 1205 // ER_LOCK_WAIT_TIMEOUT

      if (err instanceof HttpError) {
        safe['err_kind'] = 'http'
        safe['status'] = err.status
        safe['code'] = err.code
      } else if (err instanceof UnknownBlockTypeError) {
        // Structured: attacker-controlled blockType is a bounded field,
        // never interpolated into err.message. Truncate defensively.
        safe['err_kind'] = 'unknown_block_type'
        safe['block_type'] = String(err.blockType).slice(0, 60)
      } else if (isLockConflict) {
        safe['err_kind'] = 'lock_conflict'
        safe['mysql_code'] = String(mysqlCode)
      } else if (err instanceof ZodError) {
        safe['err_kind'] = 'zod'
      } else if (err instanceof Error) {
        safe['err_kind'] = 'error'
        safe['err_name'] = err.name
        if (env.NODE_ENV !== 'production') safe['err_message'] = err.message
      } else {
        safe['err_kind'] = 'unknown'
      }
      console.error(JSON.stringify(safe))
      if (err instanceof HttpError) return jsonError(err.status, err.code, requestId)
      if (err instanceof UnknownBlockTypeError) return jsonError(400, 'unknown_block_type', requestId)
      if (isLockConflict) {
        // Retryable: tell the client to back off briefly and re-issue.
        return new Response(
          JSON.stringify({ error: 'lock_conflict', requestId }),
          {
            status: 409,
            headers: {
              'content-type': 'application/json',
              'cache-control': 'no-store',
              'retry-after': '1',
            },
          },
        )
      }
      if (err instanceof ZodError) return jsonError(400, 'invalid_request', requestId)
      return jsonError(500, 'server_error', requestId)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
