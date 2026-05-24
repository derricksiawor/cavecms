// Plain-constant scrypt parameters. Extracted from lib/auth/scrypt.ts so
// instrumentation.ts can warm up scrypt with the EXACT same tunables as
// the login path WITHOUT importing scrypt.ts (which statically pulls
// `node:crypto` and `node:util`, breaking webpack's Edge build of
// instrumentation when it tries to bundle the import chain).
//
// Drift guard: if the values here change, scrypt.ts re-exports them via
// SCRYPT_PARAMS / SCRYPT_KEY_LEN / SCRYPT_SALT_LEN — single source of
// truth lives here. The instrumentation boot gate verifies scrypt
// genuinely takes >50ms with these params; if a future maintainer
// halves N here, the gate refuses to boot.

const N = 1 << 17
const r = 8
const p = 1
const MAXMEM = 256 * 1024 * 1024

export const SCRYPT_KEY_LEN = 64
export const SCRYPT_SALT_LEN = 16
export const SCRYPT_PARAMS = { N, r, p, maxmem: MAXMEM } as const
