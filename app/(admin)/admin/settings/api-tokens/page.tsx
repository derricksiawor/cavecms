import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { listApiTokens } from '@/lib/auth/apiToken'
import { ApiTokensClient, type TokenListItem } from './ApiTokensClient'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

const iso = (v: Date | string | null): string | null =>
  v === null ? null : new Date(v).toISOString()

export default async function AdminApiTokens() {
  await requireRoleOrRedirect(['admin'])
  const rows = await listApiTokens()

  // Derive the badge status here on the server (one clock read) so SSR and
  // the first client paint agree — see TokenListItem.status.
  const now = Date.now()
  const initial: TokenListItem[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    token_prefix: r.token_prefix,
    role: r.role,
    created_at: iso(r.created_at)!, // created_at is NOT NULL in the DB
    last_used_at: iso(r.last_used_at),
    expires_at: iso(r.expires_at),
    revoked_at: iso(r.revoked_at),
    created_by_email: r.created_by_email,
    status:
      r.revoked_at !== null
        ? 'revoked'
        : r.expires_at !== null && new Date(r.expires_at).getTime() <= now
          ? 'expired'
          : 'active',
  }))

  return (
    <div className="max-w-5xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Settings
      </p>
      <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl">
        API Tokens
      </h1>
      <p className="mt-4 max-w-2xl text-sm font-medium leading-relaxed text-warm-stone">
        Generate a token so external tools and AI assistants can edit your
        content through the API &mdash; fast, with no browser needed. A token
        acts with the role you choose and can never touch user accounts or
        security settings. We&rsquo;ll ask for your password before creating or
        revoking one. Signing out or changing your password does{' '}
        <strong className="font-semibold text-near-black">not</strong> disable a
        token &mdash; revoke it here (or give it an expiry), and it stops working
        the moment the person who created it is removed.
      </p>
      <ApiTokensClient initial={initial} />
    </div>
  )
}
