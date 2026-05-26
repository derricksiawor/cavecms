import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { registry } from '@/lib/cms/settings-registry'
import { BetaPill } from '@/components/ui/BetaPill'
import { AiAssistantClient } from './AiAssistantClient'

// Admin-only AI Assistant (Gemini, BYOK) configuration.
//
// Operator pastes their Google Gemini API key, picks which model to use
// for inline (per-block sparkle) vs chat (Page Assistant chatbot)
// surfaces, sets a voice preset, optionally writes custom voice notes.
//
// Credential redaction: the encrypted apiKey envelope is stripped from
// the payload on the server before it reaches the client form. The
// form shows "Key on file — ends in •••1234" when a key is stored;
// pasting a new value re-encrypts at write time + clears verifiedAt.

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

interface SettingRow {
  key: string
  value: unknown
  version: number
  updated_at: Date | string
}

export default async function AiAssistantSettingsPage() {
  await requireRoleOrRedirect(['admin'])

  const [rows] = (await db.execute(sql`
    SELECT \`key\`, value, version, updated_at
    FROM settings
    WHERE \`key\` = 'ai_config'
    LIMIT 1
  `)) as unknown as [SettingRow[]]

  const synthesizedNow = new Date()
  const raw = rows[0]
  const parsedValue =
    raw && typeof raw.value === 'string'
      ? (() => {
          try {
            return JSON.parse(raw.value as string)
          } catch {
            return registry.ai_config.default
          }
        })()
      : (raw?.value ?? registry.ai_config.default)

  // Server-side credential redaction. Strip the encrypted apiKey
  // envelope before it reaches the client bundle. The UI only needs
  // `apiKeyLast4` to display "ends in •••1234".
  const keyOnFile =
    !!parsedValue &&
    typeof parsedValue === 'object' &&
    !!(parsedValue as { apiKey?: unknown }).apiKey
  const redacted =
    parsedValue && typeof parsedValue === 'object' && !Array.isArray(parsedValue)
      ? (() => {
          const copy = { ...(parsedValue as Record<string, unknown>) }
          delete copy.apiKey
          return copy
        })()
      : parsedValue

  const initial = {
    key: 'ai_config' as const,
    value: redacted,
    version: raw?.version ?? 0,
    updatedAt:
      raw?.updated_at instanceof Date
        ? raw.updated_at.toISOString()
        : typeof raw?.updated_at === 'string'
          ? raw.updated_at
          : synthesizedNow.toISOString(),
    keyOnFile,
  }

  return (
    <div className="max-w-4xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Site settings
      </p>
      <div className="mt-4 flex items-baseline gap-3">
        <h1 className="font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl">
          AI Assistant
        </h1>
        <BetaPill feature="ai-assistant-settings" size="md" dismissible />
      </div>
      <p className="mt-4 max-w-2xl text-sm font-medium leading-relaxed text-warm-stone">
        Bring your own Gemini API key. The AI writing partner appears as a
        sparkle on every section and as a Page Assistant chat in the
        bottom-left. AI never touches your settings, users, or files — only
        the words inside your blocks.{' '}
        <Link
          href="/admin/help#ai-assistant"
          className="font-medium text-copper-700 underline-offset-2 hover:underline"
        >
          Read the AI Assistant guide →
        </Link>
      </p>

      <AiAssistantClient initial={initial} />
    </div>
  )
}
