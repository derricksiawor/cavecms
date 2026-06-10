import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { getSession } from '@/lib/auth/getSession'
import { ChangePasswordForm } from './ChangePasswordForm'

// Your account — the self-service surface every signed-in user (admin,
// editor, viewer) reaches to manage their OWN login, starting with the
// password. Distinct from Settings → Security (site-wide, admin-only) and
// Users (an admin managing OTHER people).

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: 'Your account', robots: { index: false, follow: false } }
}

export default async function AccountPage() {
  await requireRoleOrRedirect(['admin', 'editor', 'viewer'])
  const session = await getSession()
  const email = session?.email ?? ''

  return (
    <div className="max-w-2xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Your account
      </p>
      <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl">
        Account
      </h1>
      <p className="mt-4 max-w-xl text-sm font-medium leading-relaxed text-warm-stone">
        Manage how you sign in.
        {email ? (
          <>
            {' '}
            You&rsquo;re signed in as <span className="font-semibold text-near-black">{email}</span>.
          </>
        ) : null}
      </p>

      <ChangePasswordForm />
    </div>
  )
}
