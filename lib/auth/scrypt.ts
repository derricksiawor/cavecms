import 'server-only'
import { scrypt as scryptCb, randomBytes, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { SCRYPT_PARAMS, SCRYPT_KEY_LEN, SCRYPT_SALT_LEN } from './scrypt-params'

// `promisify(scryptCb)` returns a union typed signature that doesn't
// match the (pw, salt, keylen, opts) overload we use. node:util.promisify's
// type inference can't pick the right overload from node:crypto's scrypt
// — manually narrow to the exact shape we call. Single-step `as unknown`
// at the typing boundary, not the banned `as unknown as` chain.
const scrypt = promisify(scryptCb) as unknown as (
  pw: string,
  salt: Buffer,
  keyLen: number,
  opts: Record<string, number>,
) => Promise<Buffer>

const { N, r, p, maxmem: MAXMEM } = SCRYPT_PARAMS
const KEY_LEN = SCRYPT_KEY_LEN
const SALT_LEN = SCRYPT_SALT_LEN
const OPTS = SCRYPT_PARAMS

// Re-export so existing call sites keep working. Single source of truth
// lives in ./scrypt-params (which has no node imports, so other modules
// — instrumentation.ts boot gate — can import the constants without
// dragging node:crypto into their bundles).
export { SCRYPT_PARAMS, SCRYPT_KEY_LEN, SCRYPT_SALT_LEN }

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(SALT_LEN)
  const hash = await scrypt(pw, salt, KEY_LEN, OPTS)
  return `scrypt$N=${N}$r=${r}$p=${p}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const m = /^scrypt\$N=(\d+)\$r=(\d+)\$p=(\d+)\$([^$]+)\$([^$]+)$/.exec(stored)
  if (!m) return false
  const [, Nstr, rstr, pstr, saltB64, hashB64] = m
  if (!Nstr || !rstr || !pstr || !saltB64 || !hashB64) return false
  const salt = Buffer.from(saltB64, 'base64')
  const expected = Buffer.from(hashB64, 'base64')
  const actual = await scrypt(pw, salt, expected.length, {
    N: parseInt(Nstr, 10),
    r: parseInt(rstr, 10),
    p: parseInt(pstr, 10),
    maxmem: MAXMEM,
  })
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

// Lazy-initialised dummy hash used to keep verifyPassword timing flat for
// non-existent users. Computed on first use, then cached. Avoids paying the
// scrypt cost (~150ms) at module-load time. On rejection (e.g., transient
// maxmem pressure) we clear the cached promise so the NEXT call retries
// — otherwise a single failed init would permanently 500 every login.
let dummyHashPromise: Promise<string> | null = null

export function getDummyScryptHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(randomBytes(32).toString('base64url')).catch((err) => {
      dummyHashPromise = null
      throw err
    })
  }
  return dummyHashPromise
}

