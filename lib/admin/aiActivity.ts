// Friendly rendering for `ai_proposal_*` audit-log rows. The activity
// feed page composes the human-readable line, but the extraction +
// shape-detection logic lives here so it can be unit-tested without
// React. Diff shapes:
//
//   ai_proposal_created (inline)
//     { token, surface: 'inline', intent, toneChip, language,
//       freeTextLength, blockId, blockType, expectedBlockVersion,
//       geminiModel, usage: { promptTokens, outputTokens, latencyMs } }
//
//   ai_proposal_created (chat)
//     { token, surface: 'chat', promptLength, opCount, opKinds,
//       toolCallCount, toolCallOk, toolCallErr,
//       geminiModel, usage: { ... } }
//
//   ai_proposal_accepted (inline)
//     { token, surface: 'inline',
//       appliedBlocks: Array<{ op, blockId, blockVersion? }> }
//
//   ai_proposal_accepted (chat)
//     { token, surface: 'chat', acceptedIndices, opCount, opKinds,
//       appliedBlocks: Array<{ op, blockId, blockVersion }> }
//
//   ai_proposal_dismissed
//     { token, surface }
//
// The renderer is forgiving on missing fields — the friendly line
// degrades gracefully when an unexpected diff shape lands rather than
// crashing the row.

export type AiAction =
  | 'ai_proposal_created'
  | 'ai_proposal_accepted'
  | 'ai_proposal_dismissed'

export function isAiAction(action: string): action is AiAction {
  return (
    action === 'ai_proposal_created' ||
    action === 'ai_proposal_accepted' ||
    action === 'ai_proposal_dismissed'
  )
}

interface DiffShape {
  surface?: string
  intent?: string
  toneChip?: string | null
  language?: string | null
  blockType?: string
  blockId?: number
  appliedBlocks?: Array<{ op?: string; blockId?: number | null }>
  opCount?: number
  opKinds?: Record<string, number>
  geminiModel?: string
  usage?: { outputTokens?: number; promptTokens?: number }
}

function asDiff(raw: unknown): DiffShape {
  // mysql2 returns JSON columns as raw strings by default; Drizzle's
  // execute() path doesn't auto-parse. Accept both shapes so the
  // renderer works whether the caller pre-parsed or not. Arrays are
  // rejected explicitly so a tampered audit row carrying `[1,2,3]`
  // doesn't slip through as DiffShape — downstream property reads
  // would yield undefined and the friendly line would degrade to a
  // bare "Someone proposed a proposal" with no signal that the diff
  // was malformed.
  if (raw == null) return {}
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as DiffShape
      }
    } catch {
      /* malformed string → empty */
    }
    return {}
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw as DiffShape
}

const MODEL_LABELS: Record<string, string> = {
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-3-flash-preview': 'Gemini 3 Flash (preview)',
  'gemini-3.1-pro-preview': 'Gemini 3 Pro (preview)',
  'gemini-3.5-flash': 'Gemini 3.5 Flash',
}

function modelLabel(id: string | undefined): string {
  if (!id) return ''
  return MODEL_LABELS[id] ?? id
}

const INTENT_LABELS: Record<string, string> = {
  rewrite: 'Rewrite',
  translate: 'Translation',
  suggest: 'Suggestion',
  fillin: 'Fill-in',
}

function intentLabel(id: string | undefined): string {
  if (!id) return ''
  return INTENT_LABELS[id] ?? id
}

/** Friendly single-line summary for one AI audit row. Format aims to
 *  read at a glance: subject — what + where — context. */
export function renderAiActivityLine(args: {
  action: AiAction
  diff: unknown
  // The user_email column from audit_log JOIN. Null for system-issued
  // rows (sweeper, etc., which don't currently emit ai_proposal_*).
  userEmail: string | null
}): string {
  const diff = asDiff(args.diff)
  const who = args.userEmail ?? 'Someone'

  if (args.action === 'ai_proposal_created') {
    const surface = diff.surface === 'chat' ? 'Page Assistant' : 'Inline'
    const intent = diff.surface === 'inline' ? intentLabel(diff.intent) : ''
    const tone =
      diff.surface === 'inline' && typeof diff.toneChip === 'string'
        ? `(${diff.toneChip})`
        : ''
    const lang =
      diff.surface === 'inline' && typeof diff.language === 'string'
        ? `→ ${diff.language}`
        : ''
    const target =
      diff.surface === 'inline'
        ? blockTarget(diff)
        : opCountTarget(diff)
    const model = modelLabel(diff.geminiModel)
    const outputTokens =
      typeof diff.usage?.outputTokens === 'number'
        ? diff.usage.outputTokens
        : null
    const action = intent
      ? [`a ${intent}`, tone, lang].filter(Boolean).join(' ')
      : 'a proposal'
    const surfaceClause = `via ${surface}`
    const targetClause = target ? `on ${target}` : ''
    const tail = [
      model ? model : '',
      outputTokens !== null ? `${outputTokens} tokens` : '',
    ]
      .filter(Boolean)
      .join(', ')
    return [
      `${who} proposed ${action}`,
      surfaceClause,
      targetClause,
      tail ? `— ${tail}` : '',
    ]
      .filter(Boolean)
      .join(' ')
  }

  if (args.action === 'ai_proposal_accepted') {
    const surface = diff.surface === 'chat' ? 'Page Assistant' : 'Inline'
    // Explicit Array.isArray guard — a tampered audit row could carry
    // appliedBlocks as a string / object / null and Array operations
    // on a non-array value would either throw OR silently coerce.
    const applied = Array.isArray(diff.appliedBlocks)
      ? diff.appliedBlocks
      : []
    if (diff.surface === 'inline') {
      // Inline accept always has exactly 1 op (the original sparkle
      // edit). The diff doesn't carry blockType — only the
      // appliedBlocks[].blockId. Surface the id directly when we have
      // one; fall back to the bare proposal line otherwise.
      const first = applied[0]
      return first?.blockId != null
        ? `${who} applied an ${surface} proposal on block #${first.blockId}`
        : `${who} applied an ${surface} proposal`
    }
    const opCount = typeof diff.opCount === 'number' ? diff.opCount : applied.length
    const kinds = diff.opKinds ? formatOpKinds(diff.opKinds) : ''
    const opCountLabel = `${opCount} op${opCount === 1 ? '' : 's'}`
    const tail = [opCountLabel, kinds].filter(Boolean).join(' · ')
    return `${who} applied a ${surface} proposal — ${tail}`
  }

  // dismissed
  const surface = diff.surface === 'chat' ? 'Page Assistant' : 'Inline'
  return `${who} dismissed an ${surface} proposal`
}

function blockTarget(diff: {
  blockType?: string
  blockId?: number | null
}): string {
  if (!diff.blockType && diff.blockId == null) return ''
  const type = diff.blockType ? prettyBlockType(diff.blockType) : 'block'
  const id = diff.blockId != null ? ` #${diff.blockId}` : ''
  return `${type}${id}`
}

function opCountTarget(diff: { opCount?: number; opKinds?: Record<string, number> }): string {
  const count = typeof diff.opCount === 'number' ? diff.opCount : null
  if (count === null) return ''
  return `${count} block${count === 1 ? '' : 's'}`
}

function prettyBlockType(t: string): string {
  // Block types are stored as lx_heading, lx_text, contact_form,
  // etc. Reads better with an underscore→space transform but the
  // operator audience already recognises the prefixed names from
  // the editor. Keep verbatim; no over-prettifying.
  return t
}

function formatOpKinds(kinds: Record<string, number>): string {
  const entries = Object.entries(kinds).filter(([, n]) => n > 0)
  if (entries.length === 0) return ''
  return entries.map(([k, n]) => `${n} ${k}`).join(', ')
}
