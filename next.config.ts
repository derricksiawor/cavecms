import type { NextConfig } from 'next'
import path from 'node:path'

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  output: 'standalone',
  images: { remotePatterns: [] },
  // Silence the "multiple lockfiles detected" warning — pin the workspace
  // root explicitly to this project's directory.
  outputFileTracingRoot: path.resolve(import.meta.dirname),
  turbopack: { root: path.resolve(import.meta.dirname) },
  // Native Node deps that webpack can't / shouldn't bundle. sharp ships
  // platform-specific binaries; isomorphic-dompurify pulls in jsdom which
  // includes asset files (default-stylesheet.css) webpack rewrites the
  // path of, then fails to copy at page-data collection; nodemailer pulls
  // a deep chain of Node built-in `require('stream')` / `require('fs')`
  // calls that webpack tries to polyfill and fails on. Turbopack handles
  // these transparently — webpack needs the explicit allowlist. Marking
  // them external keeps them as runtime requires.
  // mysql2 + drizzle-orm are listed externals so:
  //   (1) the Next standalone build leaves them as runtime requires
  //       instead of inlining them into webpack chunks, AND
  //   (2) they get copied to .next/standalone/node_modules/ at build
  //       time — `scripts/install-migrate.mjs` (a standalone Node script
  //       outside the Next route graph, run by `npx create-cavecms`)
  //       resolves them from there via `createRequire`. Without these
  //       in the externals list, the release zip ships without mysql2,
  //       and the first `npx create-cavecms` install dies at step 6
  //       with "mysql2 not found — looked in […]".
  serverExternalPackages: ['sharp', 'isomorphic-dompurify', 'jsdom', 'nodemailer', 'mysql2', 'drizzle-orm'],
  // instrumentation.ts runs only on Node (`if (NEXT_RUNTIME !== 'nodejs') return`
  // at the top of register()) but webpack still tries to BUNDLE it for the
  // Edge runtime, where `await import('node:crypto')` (and the chain of
  // node:fs, node:path) trips UnhandledSchemeError. Turbopack treats these
  // as cosmetic warnings; webpack treats them as hard errors. The
  // ignore-warnings filter below downgrades the build behaviour to match
  // Turbopack so `pnpm dev:web` works cleanly. Runtime-safe because the
  // runtime guard short-circuits before any node:* path is invoked.
  webpack: (config, { nextRuntime }) => {
    if (nextRuntime === 'edge') {
      config.ignoreWarnings = [
        ...(config.ignoreWarnings ?? []),
        // The compile error this silences is the one Turbopack reports
        // as a warning. Either way the runtime guard at the top of
        // instrumentation.ts ensures node:* paths never execute on Edge.
        /node:(crypto|fs|path|fs\/promises)/,
      ]
      // Tell webpack that node:* schemes (and the bare-name node
      // builtins mysql2 / nodemailer / drizzle's internals use) are
      // externally available. The runtime guard in instrumentation.ts
      // ensures none of these paths actually execute on Edge — they
      // only appear in the dependency graph because of dynamic
      // `await import('@/db/client')` calls in the Node-only branch.
      const NODE_BUILTINS = new Set([
        'crypto',
        'fs',
        'fs/promises',
        'path',
        'stream',
        'net',
        'tls',
        'dns',
        'os',
        'http',
        'https',
        'zlib',
        'buffer',
        'util',
        'url',
        'querystring',
        'events',
        'assert',
        'string_decoder',
      ])
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : [config.externals]),
        ({ request }: { request?: string }, callback: (err?: Error | null, result?: string) => void) => {
          if (!request) return callback()
          if (/^node:/.test(request)) return callback(null, `commonjs ${request}`)
          if (NODE_BUILTINS.has(request)) return callback(null, `commonjs ${request}`)
          // mysql2 + drizzle-orm/mysql2 are Node-only; mark them external
          // so the Edge bundle stops following the require chain into
          // their auth-plugin code that calls bare `require('crypto')`.
          if (request === 'mysql2' || request.startsWith('mysql2/')) {
            return callback(null, `commonjs ${request}`)
          }
          if (request.startsWith('drizzle-orm/mysql2')) {
            return callback(null, `commonjs ${request}`)
          }
          callback()
        },
      ]
    }
    return config
  },
  // /admin/help renders docs/admin-help.md at request time. Without an
  // explicit trace include, Next.js's standalone build doesn't bundle
  // the docs/ folder, and the route 500s with ENOENT in production
  // (cwd of the standalone server is .next/standalone/, not the repo
  // root). Forcing the trace puts the file alongside the bundled
  // routes so process.cwd() resolves it.
  outputFileTracingIncludes: {
    // /admin/help renders docs/admin-help.md at request time — the
    // standalone bundle needs the markdown copied alongside.
    '/admin/help': ['./docs/admin-help.md'],
    // db/schema-fingerprint.txt is read by instrumentation.ts at
    // process boot via `path.resolve(process.cwd(), 'db/schema-
    // fingerprint.txt')`. Standalone cwd is `.next/standalone/`, so
    // the file must land at `.next/standalone/db/schema-fingerprint.txt`.
    // Including under '/' attaches it to the root route's bundle
    // which gets pulled in by every standalone server boot. Without
    // this, both `pnpm start` and PM2 fatal on boot with
    // `schema_fingerprint_check_failed: ENOENT`.
    '/': ['./db/schema-fingerprint.txt'],
  },
  // No experimental flags needed — middleware.ts uses Web Crypto API
  // (universal) and runs on the default Edge runtime. Previously we set
  // `experimental.nodeMiddleware: true` to allow `node:crypto.randomBytes`,
  // but that produced a "Unrecognized key: 'nodeMiddleware'" warning from
  // Next 15.5's config validator on every startup. Switching middleware to
  // Web Crypto removed the need; the flag is dropped, the warning is gone.
  async headers() {
    const isProd = process.env.NODE_ENV === 'production'
    // HSTS is HTTPS-only. Sending it on the dev server (HTTP localhost) makes
    // Safari pin localhost to HTTPS for `max-age` seconds — once cached, every
    // subsequent dev session in Safari upgrades http://localhost:3040 to
    // https://, the dev server has no TLS, every asset 404s, the page renders
    // unstyled. Chrome ignores HSTS on localhost; Safari does not. Skip in dev.
    // (project standards "Security Standards" — HSTS mandated in production; the
    // skip is dev-only and does not affect the live site.)
    const securityHeaders = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
    ]
    if (isProd) {
      securityHeaders.push({
        key: 'Strict-Transport-Security',
        value: 'max-age=63072000; includeSubDomains; preload',
      })
    }
    return [{ source: '/(.*)', headers: securityHeaders }]
  },
}

export default config
