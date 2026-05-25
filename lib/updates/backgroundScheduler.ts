import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { getSetting } from '@/lib/cms/getSettings'
import { getCurrentVersion } from './getCurrentVersion'
import { checkLatestRelease } from './checkLatestRelease'
import { notifyUpdateAvailable } from './notifyUpdateAvailable'

// Background scheduler for the Updates feature. Pulled into its own
// module so the nodemailer + DB transitive imports never reach the
// edge-runtime bundle via instrumentation.ts's static analysis —
// instrumentation.ts can dynamically import THIS module at runtime
// under a Node-runtime guard, and webpack's static walker stops here.

interface RunArgs {
  /** Override the GitHub owner (test seam + private fork support). */
  owner?: string
  /** Override the GitHub repo. */
  repo?: string
}

/**
 * Run one iteration of the update-check loop:
 *   1. Skip if running locally (CAVECMS_COMMIT === 'unknown' → 'dev').
 *   2. Fetch latest release from upstream.
 *   3. Stamp `updates_state.lastCheckedAt` so the dashboard can show
 *      "Last checked X ago".
 *   4. If there's a NEW release AND `notificationEmail` is configured,
 *      send the email via the SMTP transport (DB-first, env-fallback).
 *      `notifyUpdateAvailable` is idempotent against `lastNotifiedSha`,
 *      so back-to-back polls between releases are no-ops.
 *
 * Returns a small status object useful for tests and ops logging.
 */
export async function runUpdateCheck(args: RunArgs = {}): Promise<{
  skipped?: 'dev' | 'check_failed'
  current?: string
  available?: string
  notified?: boolean
}> {
  const current = getCurrentVersion()
  if (current.sha === 'dev') return { skipped: 'dev' }

  const owner = args.owner ?? process.env.CAVECMS_REPO_OWNER ?? 'derricksiawor'
  const repo = args.repo ?? process.env.CAVECMS_REPO_NAME ?? 'cavecms'

  let latest
  try {
    latest = await checkLatestRelease({ owner, repo })
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'update_check_fetch_failed',
        err: err instanceof Error ? err.message.slice(0, 200) : String(err),
      }),
    )
    return { skipped: 'check_failed' }
  }

  // Stamp lastCheckedAt regardless of result.
  const state = await getSetting('updates_state')
  const newState = {
    ...state,
    lastCheckedAt: new Date().toISOString(),
  }
  await db.execute(sql`
    INSERT INTO settings (\`key\`, value, version, updated_by)
    VALUES ('updates_state', ${JSON.stringify(newState)}, 1, NULL)
    ON DUPLICATE KEY UPDATE
      value = VALUES(value),
      version = version + 1
  `)

  // Up to date — no email.
  if (latest.sha.startsWith(current.sha)) {
    return { current: current.sha, available: undefined }
  }

  // New release. Email if configured (notifyUpdateAvailable handles
  // the "no email configured" + "already notified" guards itself).
  const result = await notifyUpdateAvailable(latest)
  return {
    current: current.sha,
    available: latest.sha,
    notified: result.sent,
  }
}
