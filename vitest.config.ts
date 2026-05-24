import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { readFileSync, existsSync } from 'node:fs'

const root = path.resolve(import.meta.dirname, '.')
const envFile = path.join(root, '.env.local')
if (existsSync(envFile)) {
  for (const rawLine of readFileSync(envFile, 'utf-8').split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line)
    if (!m) continue
    const [, key, value] = m
    if (!key) continue
    // Unwrap matching outer quotes — `.env.local` follows dotenv's
    // convention where `KEY='"Display" <addr@host>'` should yield
    // `"Display" <addr@host>` (the OUTER single quotes are syntax,
    // the inner double quotes are part of the value). Without this,
    // SMTP_FROM lands in process.env with surrounding quote chars
    // and lib/env.ts's Zod display-form regex rejects it.
    let v = value ?? ''
    if (v.length >= 2) {
      const first = v[0]
      const last = v[v.length - 1]
      if ((first === '"' || first === "'") && first === last) {
        v = v.slice(1, -1)
      }
    }
    if (!(key in process.env)) process.env[key] = v
  }
}

export default defineConfig({
  resolve: {
    alias: {
      '@': root,
      'server-only': path.join(root, 'tests/_stubs/server-only.ts'),
    },
  },
  css: { postcss: { plugins: [] } },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    pool: 'forks',
    setupFiles: ['./tests/setup.ts'],
  },
})
