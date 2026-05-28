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
  // CaveCMS deploys behind a reverse proxy (nginx / Apache) that proxies
  // to the Node listener on 127.0.0.1:<PORT>. Without trustHostHeader,
  // Next.js builds the initUrl for middleware rewrites from the BOUND
  // HOSTNAME:PORT (e.g. `https://localhost:8201`) instead of the
  // forwarded Host header (`test.derricksiawor.com`). When middleware
  // rewrites `/dining` → `/_page/dining`, the resulting
  // `x-middleware-rewrite` header carries the bound origin, and Next's
  // router-server sees the host as "external" relative to the request
  // origin, then proxies via http-proxy with `target=https://localhost:8201`
  // (because X-Forwarded-Proto=https). The Node listener is plain HTTP,
  // so the SSL handshake fails with EPROTO ssl3_get_record:wrong version
  // number — every CMS-slug page 500s. trustHostHeader makes Next build
  // initUrl from req.headers.host, so middleware rewrites stay
  // same-origin and Next handles them as internal rewrites.
  // trustHostHeader is a runtime-supported experimental flag in
  // Next 15.5 (Vercel sets it automatically via `hasNextSupport`) but
  // the public TS types only expose a stable subset of `experimental`.
  // The cast keeps the flag in the runtime nextConfig payload that
  // the standalone server reads at boot.
  experimental: {
    trustHostHeader: true,
  } as NextConfig['experimental'],
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
    // HSTS is intentionally NOT set here. It is host-gated in middleware
    // so laptop / cpanel / LAN installs (NODE_ENV=production but served
    // over plain HTTP on localhost / 127.0.0.1 / private IP) don't pin
    // Safari to HTTPS and render every page unstyled. See
    // middleware.ts (search "Strict-Transport-Security") and
    // ~/.claude/CLAUDE.md #0.19 for the full mechanism.
    const securityHeaders = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
    ]
    return [{ source: '/(.*)', headers: securityHeaders }]
  },
}

export default config
