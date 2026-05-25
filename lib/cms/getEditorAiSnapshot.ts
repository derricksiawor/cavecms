import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { registry } from '@/lib/cms/settings-registry'

// Editor-side AI config snapshot.
//
// The inline AI sparkle reads ai_config at page render time so the
// per-block sparkle button can decide whether to render without
// per-block fetches. The snapshot is intentionally narrow:
//
//   - `enabled` (master switch — gates all AI surfaces)
//   - `inlineEnabled` (gates the inline sparkle surface)
//   - `chatEnabled` (gates the PR 4 Page Assistant chatbot)
//   - `keyOnFile` (true when an encrypted apiKey is stored)
//   - `inlineModel` (operator's per-surface choice; null when unpicked)
//   - `chatModel`  (operator's per-surface choice; null when unpicked)
//   - `voicePreset` (label only, for the popover footer chip)
//
// Explicitly NOT included:
//   - The encrypted apiKey envelope (NEVER reaches the client)
//   - apiKeyLast4 (would leak partial credential into the public-page
//     edit chrome bundle; not needed for the sparkle UI — the dashboard
//     is the surface that shows it)

export interface EditorAiSnapshot {
  enabled: boolean
  inlineEnabled: boolean
  chatEnabled: boolean
  keyOnFile: boolean
  inlineModel: string | null
  chatModel: string | null
  voicePreset:
    | 'default'
    | 'editorial'
    | 'friendly'
    | 'professional'
    | 'playful'
    | 'custom'
}

interface SettingValueRow {
  value: unknown
}

/** Read + parse + project ai_config into the editor-safe snapshot.
 *  Returns a fully-disabled snapshot on missing/corrupt rows so the
 *  edit chrome falls back cleanly (sparkle hidden, no toast spam). */
export async function getEditorAiSnapshot(): Promise<EditorAiSnapshot> {
  const empty: EditorAiSnapshot = {
    enabled: false,
    inlineEnabled: false,
    chatEnabled: false,
    keyOnFile: false,
    inlineModel: null,
    chatModel: null,
    voicePreset: 'default',
  }
  try {
    const [rows] = (await db.execute(sql`
      SELECT value FROM settings WHERE \`key\` = 'ai_config'
    `)) as unknown as [SettingValueRow[]]
    if (!rows[0]) return empty
    const raw = rows[0].value
    const obj =
      typeof raw === 'string'
        ? (() => {
            try {
              return JSON.parse(raw) as unknown
            } catch {
              return null
            }
          })()
        : raw
    if (obj === null) return empty
    const parsed = registry.ai_config.schema.safeParse(obj)
    if (!parsed.success) return empty
    const cfg = parsed.data
    return {
      enabled: cfg.enabled,
      inlineEnabled: cfg.inlineEnabled,
      chatEnabled: cfg.chatEnabled,
      keyOnFile: !!cfg.apiKey,
      inlineModel: cfg.models?.inline ?? null,
      chatModel: cfg.models?.chat ?? null,
      voicePreset: cfg.voicePreset,
    }
  } catch {
    return empty
  }
}
