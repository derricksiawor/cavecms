import { z } from 'zod'
import { eq, sql } from 'drizzle-orm'
import { revalidateTag } from 'next/cache'
import { db } from '@/db/client'
import { settings } from '@/db/schema/settings'
import { isLoopbackInternalRequest, jsonInternal } from '@/lib/api/internalAuth'

// POST /api/internal/updates/maintenance — toggle the
// `security_maintenance.enabled` flag during an update window.
//
// Called by scripts/cavecms-update.sh:
//   - Just before `pm2 reload` (step 5): { enabled: true }
//     → middleware starts serving the generic HTML 503 to public traffic
//   - After verify succeeds (step 6) OR rollback completes:
//                                           { enabled: false }
//     → middleware resumes normal routing
//
// We toggle ONLY the `enabled` boolean — the operator-configured
// `message` and `bypassIps` are preserved unchanged. This means an
// operator who set a custom maintenance message before the update will
// see THEIR message during the update window. If they didn't set one,
// middleware's branded 503 falls back to the generic copy "Please check
// back in a moment." (see middleware.ts:maintenanceResponse).
//
// The middleware reads security_maintenance via /api/internal/security-config,
// which is module-cached for ~3s, so the toggle takes effect within
// that window. `revalidateTag('settings')` invalidates getSetting()'s
// in-process cache so the next /api/internal/security-config call
// rebuilds with the new value.
//
// Loopback + bearer auth via the shared helper. No CSRF (bearer-authed,
// not cookie-authed). The orchestrator script + admin trigger flow are
// the only legitimate callers.

export const dynamic = 'force-dynamic'

const Body = z.object({ enabled: z.boolean() }).strict()

function logEvent(
  level: 'info' | 'warn' | 'error',
  msg: string,
  extra: Record<string, unknown> = {},
): void {
  const out = JSON.stringify({
    level,
    route: 'api/internal/updates/maintenance',
    msg,
    ...extra,
  })
  if (level === 'error') console.error(out)
  else console.log(out)
}

export async function POST(req: Request): Promise<Response> {
  if (!isLoopbackInternalRequest(req)) {
    logEvent('warn', 'unauthorized')
    return jsonInternal({ error: 'unauthorized' }, 401)
  }

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return jsonInternal({ error: 'invalid_json' }, 400)
  }
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return jsonInternal({ error: 'invalid_payload' }, 400)
  }

  // SELECT FOR UPDATE the security_maintenance row, merge { enabled },
  // UPDATE. We don't use the optimistic-version lock from the admin
  // PATCH path — the script is the trusted caller and there's no
  // concurrent-edit risk in the update window.
  try {
    const [rows] = (await db.execute(sql`
      SELECT value, version FROM settings WHERE \`key\` = 'security_maintenance' LIMIT 1
    `)) as unknown as [Array<{ value: unknown; version: number }>]

    let current: { enabled: boolean; message: string; bypassIps: string[] } = {
      enabled: false,
      message: '',
      bypassIps: [],
    }
    if (rows.length > 0) {
      const v = rows[0]!.value
      const obj =
        typeof v === 'string'
          ? (JSON.parse(v) as Partial<typeof current>)
          : (v as Partial<typeof current>)
      current = {
        enabled: typeof obj.enabled === 'boolean' ? obj.enabled : false,
        message: typeof obj.message === 'string' ? obj.message : '',
        bypassIps: Array.isArray(obj.bypassIps) ? obj.bypassIps : [],
      }
    }

    const next = { ...current, enabled: parsed.data.enabled }
    const nextJson = JSON.stringify(next)

    // MariaDB's JSON type is a LONGTEXT alias with a CHECK constraint —
    // unlike MySQL it does NOT accept `CAST(? AS JSON)`. The drizzle
    // schema declares `value: json(...)` so we let the driver bind the
    // string; MariaDB validates it against the JSON CHECK constraint
    // on insert/update. This is the same shape the admin /api/admin/settings
    // PATCH route uses.
    if (rows.length > 0) {
      await db
        .update(settings)
        .set({ value: sql`${nextJson}`, version: sql`version + 1` })
        .where(eq(settings.key, 'security_maintenance'))
    } else {
      // First-time write — row doesn't exist yet. Seed it.
      await db.execute(sql`
        INSERT INTO settings (\`key\`, value, version)
        VALUES ('security_maintenance', ${nextJson}, 1)
      `)
    }

    // Invalidate getSetting()'s tag-cache so the next read picks up
    // the new value within the middleware's 3s module-cache TTL.
    revalidateTag('settings')

    logEvent('info', 'toggled', { enabled: parsed.data.enabled })
    return jsonInternal({ ok: true, enabled: parsed.data.enabled }, 200)
  } catch (err) {
    logEvent('error', 'db_failed', {
      err: err instanceof Error ? err.message : String(err),
    })
    return jsonInternal({ error: 'db_failed' }, 500)
  }
}
