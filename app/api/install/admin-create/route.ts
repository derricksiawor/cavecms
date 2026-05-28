import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { users } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { HttpError } from '@/lib/auth/requireRole'
import { hashPassword } from '@/lib/auth/scrypt'
import { hasAnyActiveAdmin } from '@/lib/install/installState'
import { requireInstallToken } from '@/lib/install/installEndpointHelpers'
import { safeRevalidate } from '@/lib/cache/revalidate'
import { tag } from '@/lib/cache/tags'
import { rateLimit } from '@/lib/auth/rateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'

// POST /api/install/admin-create — creates the FIRST admin user.
//
// Locked once an active admin exists:
//   - isInstalled() guard at the top returns 410 Gone
//   - DB-level guard via INSERT-only-when-no-active-user query so a
//     race between two concurrent /install requests can't create two
//     admins
//
// Rate-limited per IP to slow down anyone who finds /install before
// the legitimate operator does. We deliberately don't add a separate
// install token — install.sh on a fresh box hands the operator a
// URL, and the middleware install-gate restricts /install to the
// pre-install window only.

export const dynamic = 'force-dynamic'

const Body = z
  .object({
    email: z.string().email().max(180),
    name: z.string().min(1).max(180),
    password: z
      .string()
      .min(12, 'min_12_chars')
      .max(200, 'max_200_chars'),
  })
  .strict()

// 5 attempts per 5 min per IP. Tight because there should only ever
// be ONE install-wizard click in the lifetime of a CaveCMS install.
const installLimit = rateLimit('install:admin', { limit: 5, windowSec: 300 })

interface CountRow {
  n: number | string
}

export const POST = withError(async (req: Request) => {
  const headerObj: Record<string, string | undefined> = {}
  req.headers.forEach((v, k) => {
    headerObj[k] = v
  })
  const ip = clientIpFromHeaders(headerObj, '127.0.0.1') ?? '0.0.0.0'
  if (!installLimit(ip)) {
    throw new HttpError(429, 'rate_limited')
  }

  // Bootstrap-token gate — closes the public-internet window between
  // app-boot and wizard-complete. Returns 401 if the token from the
  // X-Install-Token header doesn't match env.INSTALL_BOOTSTRAP_TOKEN.
  const tokenFail = requireInstallToken(req)
  if (tokenFail) return tokenFail

  // Stricter check than isInstalled() — refuse if ANY active admin
  // already exists, even if the install_state flag hasn't been set
  // yet. Prevents a race where two operators both hit the wizard
  // before the first finished.
  if (await hasAnyActiveAdmin()) {
    return new Response(
      JSON.stringify({ error: 'already_installed' }),
      {
        status: 410,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      },
    )
  }

  const body = Body.parse(await readJsonBody(req))
  const passwordHash = await hashPassword(body.password)

  // Atomic create-first-admin via `INSERT ... ON DUPLICATE KEY` on
  // the `install_state` settings row as a serialization lock.
  // `settings.key` is PRIMARY KEY, so two concurrent INSERTs of the
  // same key are serialized by InnoDB — the second one's affected
  // rows = 1 (ON DUPLICATE KEY UPDATE incremented) which we can
  // detect to refuse.
  //
  // We write a "pending" install_state row (no completedAt yet);
  // site-init later flips completedAt to mark the wizard finished.
  await db.transaction(async (tx) => {
    // 1. Pre-check admin count under the implicit serialization of
    //    the same-key settings insert below. Belt-and-suspenders:
    //    if two concurrent admin-create POSTs both pass the count
    //    check, the install_state INSERT-or-UPDATE will let only
    //    ONE of them see `affected=1, changed=0` (insert) while the
    //    OTHER sees `affected=2` (ON DUPLICATE KEY UPDATE) — we
    //    reject the second.
    const [rows] = (await tx.execute(sql`
      SELECT COUNT(*) AS n FROM users
      WHERE active = TRUE AND role = 'admin'
    `)) as unknown as [CountRow[]]
    if (Number(rows[0]?.n ?? 0) > 0) {
      throw new HttpError(410, 'already_installed')
    }

    // 2. Acquire the install lock by INSERTing the install_state
    //    sentinel. PRIMARY KEY on `settings.key` serializes this —
    //    the second concurrent INSERT triggers ON DUPLICATE KEY
    //    UPDATE which increments the `version` counter. We detect
    //    via the post-INSERT version: a fresh INSERT lands at 1; a
    //    duplicate-update lands at >= 2 → refuse.
    const pendingValue = JSON.stringify({
      adminCreatedAt: new Date().toISOString(),
    })
    await tx.execute(sql`
      INSERT INTO settings (\`key\`, value, version, updated_by)
      VALUES ('install_state', ${pendingValue}, 1, NULL)
      ON DUPLICATE KEY UPDATE
        value = VALUES(value),
        version = version + 1
    `)
    const [stateRows] = (await tx.execute(sql`
      SELECT version FROM settings WHERE \`key\` = 'install_state'
    `)) as unknown as [Array<{ version: number }>]
    if (Number(stateRows[0]?.version ?? 0) !== 1) {
      // Another concurrent request beat us to the install lock.
      // Their version is 1, ours bumped to 2+. Refuse.
      throw new HttpError(410, 'already_installed')
    }

    // 3. Create the admin user. The `users.email` UNIQUE constraint
    //    catches duplicate-email races at this point; the lock above
    //    catches the "two different emails both racing for first
    //    admin" race.
    await tx.insert(users).values({
      email: body.email.toLowerCase(),
      name: body.name,
      role: 'admin',
      active: true,
      // First-boot admin: NO must_rotate. The operator JUST chose
      // this password 30 seconds ago — making them rotate it now
      // is user-hostile. Future admins added by /admin/users get
      // the rotate-on-first-login flow as usual.
      mustRotatePassword: false,
      passwordHash,
    })
  })
  // Defense in depth: install_state was written via raw SQL inside the
  // TX, bypassing upsertSetting()'s tag-bust contract. Today
  // isInstalled() reads its own in-process cache so this is latent,
  // but any future caller that routes install_state through
  // getSetting() would otherwise see the pre-wizard registry default.
  safeRevalidate([tag.settings]).catch(() => undefined)

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
})
