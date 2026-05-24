'use client'
import { CSRF_COOKIE_NAME } from '@/lib/auth/cookie-names'

export function readCsrf(): string {
  if (typeof document === 'undefined') return ''
  const prefix = `${CSRF_COOKIE_NAME}=`
  const c = document.cookie.split('; ').find((row) => row.startsWith(prefix))
  return c ? c.slice(prefix.length) : ''
}

export async function refreshCsrf(): Promise<string> {
  const r = await fetch('/api/csrf', {
    credentials: 'include',
    signal: AbortSignal.timeout(10_000),
  })
  if (!r.ok) throw new Error('csrf_refresh_failed')
  const j = (await r.json()) as { csrf: string }
  return j.csrf
}

export interface CsrfFetchInit extends RequestInit {
  /** Per-call timeout in ms. Defaults to 30 000. Pass Infinity to disable (not recommended). */
  timeoutMs?: number
}

export async function csrfFetch(
  input: string,
  init: CsrfFetchInit = {},
): Promise<Response> {
  const { timeoutMs = 30_000, signal: callerSignal, ...rest } = init

  const composeSignal = (): AbortSignal | undefined => {
    if (callerSignal) return callerSignal
    if (timeoutMs === Infinity) return undefined
    return AbortSignal.timeout(timeoutMs)
  }

  let token = readCsrf()
  const doFetch = (t: string) =>
    fetch(input, {
      ...rest,
      credentials: 'include',
      signal: composeSignal(),
      headers: { ...(rest.headers ?? {}), 'x-csrf-token': t },
    })
  let res = await doFetch(token)
  if (res.status === 403) {
    // Drain the body before retry — modern fetch implementations GC
    // unread streams eventually, but timing varies and a burst of 403s
    // under network pressure can pile up multiple unread streams that
    // keep their sockets/buffers warm longer than necessary. Explicit
    // text() drain releases the resource on the next tick. Wrapped in
    // catch — drain failure is harmless, we're about to issue a fresh
    // request anyway.
    await res.text().catch(() => {})
    token = await refreshCsrf()
    res = await doFetch(token)
  }
  // Session-eviction sentinel — when ANY csrfFetch call gets a 401, the
  // operator's session has gone (JWT auto-expired during a closed tab,
  // cookie evicted by Safari ITP, server-side jti revocation). Clear
  // local clipboard so the next operator on this browser doesn't
  // inherit the prior operator's most-recent Copy slot.
  // localStorage is the only persistent surface that survives the
  // logout sentinel; sessionStorage is per-tab. Best-effort try/catch
  // covers Safari Private Mode + locked-down enterprise browsers.
  if (res.status === 401) {
    try {
      window.localStorage.removeItem('bwc:clipboard')
    } catch {
      // ignore — Safari Private Mode / disabled storage
    }
  }
  return res
}
