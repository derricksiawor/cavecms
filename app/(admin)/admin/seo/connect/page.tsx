import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { registry } from '@/lib/cms/settings-registry'
import { getSiteOrigin } from '@/lib/cms/getSiteOrigin'
import { ConnectVerifyClient } from './ConnectVerifyClient'

// Connect & Verify — the search-console hub. Three things:
//   1. Ownership verification codes (Google / Bing / Yandex / Pinterest /
//      Baidu / Naver) → each renders the EXACT <meta> tag to paste, plus a
//      step-by-step guide.
//   2. IndexNow — enable, generate + display the auto-hosted key, pick
//      engines, submit-on-publish, and a manual "Submit all now".
//   3. Google Indexing API — a reauth-gated service-account paste (only for
//      job-posting / live-event pages), exactly like Settings → AI.
//
// Credential redaction: seo_indexing_api.serviceAccountJson is the
// AES-GCM-encrypted GCP key envelope. We strip it server-side before the
// value reaches the client (same discipline as ai_config.apiKey), sending
// only the operator-visible serviceAccountEmail + a "key on file" flag.

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

interface SettingRow {
  key: string
  value: unknown
  version: number
}

type ConnectKey = 'seo_webmaster' | 'seo_indexnow' | 'seo_indexing_api'

function parseValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export default async function ConnectVerifyPage() {
  await requireRoleOrRedirect(['admin'])

  const [rawRows] = (await db.execute(sql`
    SELECT \`key\`, value, version
    FROM settings
    WHERE \`key\` IN ('seo_webmaster', 'seo_indexnow', 'seo_indexing_api')
  `)) as unknown as [SettingRow[]]

  const byKey = new Map(
    rawRows.map((r) => [r.key, { ...r, value: parseValue(r.value) }]),
  )

  // Synthesize missing rows from the registry default at version 0 so the
  // form can save them on first edit (the PATCH route handles the INSERT
  // path when version=0).
  function rowFor(key: ConnectKey) {
    const existing = byKey.get(key)
    if (existing) return existing
    return { key, value: registry[key].default, version: 0 }
  }

  const webmaster = rowFor('seo_webmaster')
  const indexnow = rowFor('seo_indexnow')
  const indexingApiRow = rowFor('seo_indexing_api')

  // Redact the encrypted service-account JSON before it reaches the
  // client. Keep only serviceAccountEmail (display) + a keyOnFile flag.
  const apiVal =
    indexingApiRow.value && typeof indexingApiRow.value === 'object'
      ? (indexingApiRow.value as Record<string, unknown>)
      : {}
  const keyOnFile = !!apiVal.serviceAccountJson
  const redactedApi = {
    enabled: apiVal.enabled === true,
    serviceAccountEmail:
      typeof apiVal.serviceAccountEmail === 'string'
        ? apiVal.serviceAccountEmail
        : undefined,
  }

  const origin = await getSiteOrigin()

  return (
    <div className="max-w-4xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Search engine optimisation
      </p>
      <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl">
        Connect &amp; Verify
      </h1>
      <p className="mt-4 max-w-2xl text-sm font-medium leading-relaxed text-warm-stone">
        Prove you own this site to each search console, then tell engines the
        moment a page changes. We&rsquo;ll show you the exact code to paste and
        walk you through each console step by step.{' '}
        <Link
          href="/admin/seo"
          className="font-medium text-copper-700 underline-offset-2 hover:underline"
        >
          Back to the SEO overview →
        </Link>
      </p>

      <ConnectVerifyClient
        webmaster={{ value: webmaster.value, version: webmaster.version }}
        indexnow={{ value: indexnow.value, version: indexnow.version }}
        indexingApi={{
          value: redactedApi,
          version: indexingApiRow.version,
          keyOnFile,
        }}
        origin={origin}
        defaults={{
          seo_webmaster: registry.seo_webmaster.default,
          seo_indexnow: registry.seo_indexnow.default,
          // seo_indexing_api's registry default holds no credential
          // (just { enabled: false }) — pass only the non-sensitive
          // `enabled` so no encrypted envelope can ever reach the client.
          seo_indexing_api: { enabled: registry.seo_indexing_api.default.enabled },
        }}
      />
    </div>
  )
}
