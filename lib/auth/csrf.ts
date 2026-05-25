import 'server-only'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { env } from '@/lib/env'

const KEY = env.CSRF_SECRET

function b64u(buf: Buffer): string { return buf.toString('base64url') }
function fromB64u(s: string): Buffer { return Buffer.from(s, 'base64url') }

// Positional encoder — independent of JS engine object-iteration order.
// `JSON.stringify({...})` would also work today (V8 preserves insertion
// order for string keys) but the spec doesn't guarantee it forever; a
// future engine change could silently invalidate every outstanding CSRF
// token. Pipe-delimited fields are encoded with a length prefix to remove
// any chance of injection between fields.
function macInput(nonce: string, ts: number, jti: string, sub: string): string {
  const enc = (s: string) => `${s.length}:${s}`
  return `v=1|${enc(nonce)}|ts=${ts}|${enc(jti)}|${enc(sub)}`
}

export async function issueCsrf(
  ctx: { jti: string; sub: string },
  opts: { nowSec?: number } = {},
): Promise<string> {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000)
  const nonce = b64u(randomBytes(16))
  const mac = createHmac('sha256', KEY).update(macInput(nonce, now, ctx.jti, ctx.sub)).digest()
  return [nonce, b64u(Buffer.from(String(now))), b64u(mac)].join('.')
}

export async function verifyCsrf(
  token: string,
  ctx: { jti: string; sub: string },
): Promise<boolean> {
  const parts = token.split('.')
  if (parts.length !== 3) return false
  const [nonce, tsB64, macB64] = parts
  if (!nonce || !tsB64 || !macB64) return false
  const tsStr = fromB64u(tsB64).toString('utf8')
  // Strict parse: reject any token whose timestamp segment carries garbage
  // after the digits AND reject leading zeros so each timestamp has exactly
  // one canonical wire encoding. Without this, '01700000000' and
  // '1700000000' both parse to the same int and both verify against the
  // same MAC, producing two on-the-wire tokens for one logical CSRF.
  if (!/^(0|[1-9][0-9]*)$/.test(tsStr)) return false
  const ts = Number(tsStr)
  if (!Number.isSafeInteger(ts)) return false
  // CSRF TTL comes from settings.session_config (DB-driven, cached
  // by unstable_cache). Per-request overhead is microseconds after
  // the first read.
  const { getSetting } = await import('@/lib/cms/getSettings')
  const sessCfg = await getSetting('session_config')
  if (Math.floor(Date.now() / 1000) - ts > sessCfg.csrfTtlSec) return false
  const expectedMac = createHmac('sha256', KEY).update(macInput(nonce, ts, ctx.jti, ctx.sub)).digest()
  const actualMac = fromB64u(macB64)
  if (actualMac.length !== expectedMac.length) return false
  return timingSafeEqual(actualMac, expectedMac)
}
