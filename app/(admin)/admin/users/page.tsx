import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { adminPolicy } from '@/lib/auth/adminPolicy'
import { UsersTable } from './UsersTable'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

interface UserRow {
  id: number
  email: string
  name: string | null
  role: 'admin' | 'editor' | 'viewer'
  active: number
  must_rotate_password: number
  last_login_at: Date | null
  created_at: Date
}

export default async function AdminUsers() {
  const ctx = await requireRoleOrRedirect(adminPolicy('inviteUser'))
  const [rows] = (await db.execute(sql`
    SELECT id, email, name, role, active, must_rotate_password,
           last_login_at, created_at
    FROM users
    ORDER BY id
  `)) as unknown as [UserRow[]]

  return (
    <div className="max-w-5xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Access
      </p>
      <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl">
        Users
      </h1>
      <p className="mt-4 max-w-2xl text-sm font-medium leading-relaxed text-warm-stone">
        Manage who can access the admin and what they can do. We&rsquo;ll ask
        you to re-enter your password before any change goes through.
      </p>
      <UsersTable initial={rows} selfId={ctx.userId} />
    </div>
  )
}
