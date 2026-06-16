import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { hashResetToken } from '@/lib/auth/passwordReset'
import { ResetForm } from './ResetForm'
import { ResetExpired } from './ResetExpired'

export const dynamic = 'force-dynamic'

export function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

// Public landing page for an admin-issued password-reset link. We validate the
// token server-side (exists, unconsumed, unexpired) WITHOUT consuming it — the
// consume happens only when the user submits a new password. Invalid/expired
// links render a friendly dead-end (no login-path leak, no enumeration). The
// raw token is passed to the form so the POST can present it.
export default async function ResetPasswordPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const tokenHash = hashResetToken(token)

  const [rows] = (await db.execute(sql`
    SELECT id FROM password_reset_tokens
    WHERE token_hash = ${tokenHash}
      AND consumed_at IS NULL
      AND expires_at > now(3)
    LIMIT 1
  `)) as unknown as [Array<{ id: number }>]

  if (rows.length === 0) {
    return <ResetExpired />
  }

  return <ResetForm token={token} />
}
