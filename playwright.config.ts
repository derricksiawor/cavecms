// DEV-ONLY: refuse to run in production (project standards rule #0.55).
if (process.env['NODE_ENV'] === 'production') {
  console.error('[playwright.config] refusing to run with NODE_ENV=production.')
  process.exit(1)
}

import { defineConfig } from '@playwright/test'
import * as dotenv from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Load .env.local into the test-runner process so the spec can reach
// DATABASE_URL and other secrets. Next.js loads .env.local for the
// dev-server child process, but Playwright's test runner is a separate
// process and only picks up the plain `.env` file by default.
// dotenv.config does NOT override vars already present in process.env
// (i.e. CI-injected vars take precedence), which is the correct behaviour.
// __dirname is undefined under ESM; derive it from import.meta.url.
const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(__dirname, '.env.local') })

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://localhost:3040',
    extraHTTPHeaders: { 'x-real-ip': '127.0.0.1' },
  },
  webServer: {
    command: 'pnpm dev',
    port: 3040,
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
})
