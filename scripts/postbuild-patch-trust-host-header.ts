// Post-build patch for the standalone server.js bundle.
//
// `experimental.trustHostHeader` is a runtime-supported config flag in
// Next.js 15.5 (Vercel sets it automatically via `hasNextSupport`) but
// it's NOT in Next's public `config-schema.js`. When `loadConfig`
// validates next.config.ts against that schema, the key gets silently
// stripped — even though we cast it to `NextConfig['experimental']`
// in source. The bundled `.next/standalone/server.js` ends up with
// `"trustHostHeader":false` baked into its embedded nextConfig JSON.
//
// Without trustHostHeader=true, middleware rewrites behind a reverse
// proxy (nginx / Apache) hit a same-origin mismatch in resolve-routes:
//   - middleware's NextResponse.rewrite URL carries Host header origin
//   - initUrl is built from the bound listener (127.0.0.1:PORT,
//     normalized to localhost:PORT by NextURL)
// Origins differ → resolve-routes treats it as an EXTERNAL rewrite →
// fires an internal HTTP proxy that loops out through Cloudflare and
// re-enters the middleware's `refuseInternalPageRoute` guard on the
// `/_page/<slug>` path, returning 404. Every CMS-slug page (/rooms
// /dining /story etc) was 404ing in 0.1.38 for exactly this reason.
//
// Fix: flip the value in the bundled JSON config. This script runs as
// part of the `postbuild` chain so the patch lands BEFORE the release
// zip is built. Idempotent — no-op if the value is already true OR if
// the standalone bundle isn't present (e.g. dev builds).

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const STANDALONE_SERVER = join(process.cwd(), '.next', 'standalone', 'server.js')
const FROM = '"trustHostHeader":false'
const TO = '"trustHostHeader":true'

function main(): void {
  if (!existsSync(STANDALONE_SERVER)) {
    console.log(
      '[postbuild-patch-trust-host-header] no .next/standalone/server.js — skipping (non-standalone build).',
    )
    return
  }

  const original = readFileSync(STANDALONE_SERVER, 'utf8')

  if (original.includes(TO)) {
    console.log(
      '[postbuild-patch-trust-host-header] already patched (trustHostHeader=true). OK.',
    )
    return
  }

  if (!original.includes(FROM)) {
    // Either Next changed the embedded JSON shape, or schema validation
    // started preserving the key (unlikely without a Next release). Either
    // way, fail loudly — a silent skip here would let a broken release
    // ship with the same 404 bug we're patching.
    console.error(
      '[postbuild-patch-trust-host-header] FATAL: neither true nor false trustHostHeader found in standalone/server.js. ' +
        'Inspect the bundled nextConfig JSON and update this patcher.',
    )
    process.exit(1)
  }

  const patched = original.replace(FROM, TO)
  if (patched === original || !patched.includes(TO)) {
    console.error(
      '[postbuild-patch-trust-host-header] FATAL: replace produced no change. Check FROM/TO constants.',
    )
    process.exit(1)
  }

  writeFileSync(STANDALONE_SERVER, patched, 'utf8')
  console.log(
    '[postbuild-patch-trust-host-header] standalone/server.js patched: trustHostHeader → true.',
  )
}

main()
