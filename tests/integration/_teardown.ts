// Vitest globalSetup for the integration suite. singleFork:true means every
// integration file runs in the same worker and shares the
// globalThis.__bwcMysqlPool from db/client-node.ts. Per-file afterAll
// blocks calling pool.end() race against the next file — whichever runs
// first kills the second. The teardown returned from this setup runs ONCE
// after every file completes — one orderly shutdown.

import { pool } from '@/db/client'

export default async function setup(): Promise<() => Promise<void>> {
  return async () => {
    await pool.end().catch(() => {})
  }
}
