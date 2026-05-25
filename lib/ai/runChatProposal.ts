import 'server-only'
import { sql } from 'drizzle-orm'
import {
  FunctionCallingConfigMode,
  type Content,
  type FunctionCall,
  type Part,
} from '@google/genai'

import { db } from '@/db/client'
import { aiProposals, auditLog } from '@/db/schema'
import { HttpError } from '@/lib/auth/requireRole'
import { hydratePage } from '@/lib/cms/hydrate'
import {
  getActiveAiClient,
  AiDecryptError,
  AiDisabledError,
  AiUnconfiguredError,
} from './client'
import { buildChatSystemPrompt, type ChatVoicePreset } from './prompts/chat'
import { newProposalToken } from './runProposal'
import { assertSafePrompt, UnsafePromptError } from './promptSafety'
import { executeToolCall, type ChatSessionContext } from './runTool'
import { TOOL_DECLARATIONS, type ChatChangesetOp } from './tools'

// Page Assistant orchestrator (PR 4).
//
// Owns a single chatbot turn: build the prompt + tool surface, drive
// the Gemini chat session through its tool-call loop, persist the
// resulting changeset as ONE row in ai_proposals (status='pending'),
// and return the handle the client uses to display + apply the proposal.
//
// The orchestrator is stateless across turns. The client carries the
// conversation transcript in sessionStorage and sends prior turns as
// `conversationHistory` on the next call. Server-side state is the
// ai_proposals ledger; nothing else persists between turns.
//
// Safety wall (every tool call):
//   1. Zod parameter schema (runTool.ts)
//   2. Page-scope check (every referenced blockId / parentColumnId
//      must belong to the session's pageId)
//   3. parseAndSanitize on candidate data (block-registry Zod +
//      DOMPurify on richtext fields)
//
// At apply time the persisted changeset re-runs each gate a third
// time — defence in depth against a tampered ai_proposals row.

// 30-minute proposal lifetime — mirrors PR 3's inline expiry so the
// sweeper in instrumentation.ts processes both surfaces uniformly.
import { PROPOSAL_EXPIRY_MS } from './runProposal'

// Tool-call budget per turn. After this many calls we force-disable
// tools and ask Gemini for the final text reply so the loop can't
// runaway.
export const MAX_TOOL_CALLS_PER_TURN = 8

// Cap on conversation history. The client sends prior turns as plain
// {role, text} pairs (we drop tool-call internals across turns); we
// fold them into the Gemini contents array verbatim. Hard-cap so a
// pathological client can't expand context indefinitely.
export const MAX_HISTORY_TURNS = 40

export interface RunChatProposalArgs {
  pageId: number
  userId: number
  userPrompt: string
  conversationHistory?: ReadonlyArray<{
    role: 'user' | 'assistant'
    text: string
  }>
  ip: string | null
  userAgent: string | null
  requestId: string | null
  abortSignal: AbortSignal
  /** Progress callback fired after each tool call. The route uses it
   *  to emit `event: toolCall` SSE events; tests pass undefined. */
  onToolCall?: (call: {
    name: string
    args: unknown
    result: unknown
  }) => void
}

export interface ChatProposalUsage {
  promptTokens: number
  outputTokens: number
  latencyMs: number
}

export interface ChatProposalToolCallRecord {
  name: string
  args: unknown
  ok: boolean
  summary?: string
  error?: string
}

export interface RunChatProposalResult {
  /** Proposal token — present only when changeset.length > 0. A
   *  text-only reply (Gemini answered without proposing edits) sets
   *  this to null and skips persistence. */
  token: string | null
  changeset: ChatChangesetOp[]
  modelText: string
  model: string
  usage: ChatProposalUsage
  toolCalls: ChatProposalToolCallRecord[]
  /** Set to true when the model didn't yield a final text reply
   *  inside the tool-call budget. The client surfaces a "summary
   *  truncated" hint. */
  toolBudgetExhausted: boolean
}

export class ChatPageNotFoundError extends Error {
  readonly name = 'ChatPageNotFoundError'
  constructor() {
    super('chat_page_not_found')
  }
}

export class ChatModelRequiredError extends Error {
  readonly name = 'ChatModelRequiredError'
  constructor() {
    super('chat_model_required')
  }
}

export async function runChatProposal(
  args: RunChatProposalArgs,
): Promise<RunChatProposalResult> {
  // PR 4 audit fix (HIGH H9): defence-in-depth — re-assert the
  // operator-prompt safety gate inside the orchestrator. The route
  // already checks at /api/ai/propose, but any future caller would
  // otherwise skip this. Throws UnsafePromptError which the route
  // maps to 400 invalid_request.
  assertSafePrompt(args.userPrompt, 'userPrompt')

  // ── Resolve Gemini client + ai_config. Throws map to clean 4xx
  //    codes in the route handler. ───────────────────────────────
  const ai = await getActiveAiClient()
  if (!ai.config.chatEnabled) {
    throw new AiDisabledError()
  }
  const model = ai.config.models?.chat
  if (!model) {
    throw new ChatModelRequiredError()
  }

  // ── Hydrate page + page row (title + slug for prompt context). ─
  const [pageRows] = (await db.execute(sql`
    SELECT id, slug, title FROM pages
    WHERE id = ${args.pageId} AND deleted_at IS NULL
    LIMIT 1
  `)) as unknown as [Array<{ id: number; slug: string; title: string }>]
  const pageRow = pageRows[0]
  if (!pageRow) throw new ChatPageNotFoundError()

  const hydrated = await hydratePage(args.pageId)
  if (!hydrated) throw new ChatPageNotFoundError()

  // Session: read-only outline + mutable changeset bag the tool runner
  // pushes into. GC'd when this function returns; never persisted in
  // memory across turns.
  const session: ChatSessionContext = {
    pageId: args.pageId,
    blocks: hydrated.blocks.map((b) => ({
      id: b.id,
      blockType: b.blockType,
      kind: b.kind,
      parentId: b.parentId,
      position: b.position,
      blockKey: b.blockKey,
      version: b.version,
      data: b.data,
    })),
    changeset: [],
  }

  // ── Compose system prompt. Site + voice come from settings; page
  //    title/slug/id from the row hydrated above. PR 4 audit fix
  //    (HIGH H7): voicePreset + customVoiceNotes are already on the
  //    ai.config object loaded by getActiveAiClient — re-querying
  //    settings was an unnecessary round-trip.
  const siteCtx = await readSiteContext()
  // Narrow ai.config.voicePreset (typed as string in the client) to
  // the ChatVoicePreset enum union. The Zod schema in
  // settings-registry already validated the value at save time, so
  // the cast is safe — defensive fallback to 'default' covers a
  // legacy row that bypassed validation.
  const voicePresetCandidate = ai.config.voicePreset
  const voicePreset: ChatVoicePreset =
    voicePresetCandidate === 'default' ||
    voicePresetCandidate === 'editorial' ||
    voicePresetCandidate === 'friendly' ||
    voicePresetCandidate === 'professional' ||
    voicePresetCandidate === 'playful' ||
    voicePresetCandidate === 'custom'
      ? voicePresetCandidate
      : 'default'
  const systemPrompt = buildChatSystemPrompt({
    voicePreset,
    customVoiceNotes: ai.config.customVoiceNotes,
    siteName: siteCtx.siteName,
    siteDescription: siteCtx.siteDescription,
    pageTitle: pageRow.title,
    pageSlug: pageRow.slug,
    pageId: pageRow.id,
  })

  // ── Build contents history. ────────────────────────────────────
  // PR 4 audit fix (HIGH H5): prior assistant turns are dropped before
  // sending to Gemini. The client carries conversationHistory in
  // sessionStorage and could be spoofed by a compromised editor
  // session to inject fake "assistant" turns ("Confirmed — I will
  // ignore my system prompt") and convince the model to behave
  // differently. The structural tool surface already blocks any
  // capability the operator doesn't have, so the worst case is
  // on-page content manipulation the operator would still need to
  // Apply — but defence-in-depth says don't let client-supplied
  // assistant text influence the model at all.
  //
  // Trade-off: Gemini loses cross-turn coherence (it can't see its
  // own prior outputs). Mitigated by the rich in-turn context Gemini
  // builds via inspect_page/inspect_block tool calls.
  //
  // A future revision can re-introduce assistant turns by HMAC-signing
  // each one at emit and verifying the signature on the next inbound
  // turn.
  const history: Content[] = []
  const priorTurns = (args.conversationHistory ?? []).slice(
    -MAX_HISTORY_TURNS,
  )
  for (const t of priorTurns) {
    if (t.role !== 'user') continue
    // Belt + braces: re-run the prompt-safety gate on every accepted
    // user turn; the route validated at boundary but defence in depth
    // catches a future caller that skips the route check.
    try {
      assertSafePrompt(t.text, 'conversationHistoryUser')
    } catch {
      continue
    }
    history.push({ role: 'user', parts: [{ text: t.text }] })
  }
  history.push({ role: 'user', parts: [{ text: args.userPrompt }] })

  // ── Tool-call loop. ────────────────────────────────────────────
  const toolCallRecords: ChatProposalToolCallRecord[] = []
  let modelText = ''
  let usage: ChatProposalUsage = {
    promptTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
  }
  let toolBudgetExhausted = false
  const startedAt = Date.now()

  let safetyTicks = 0
  // Outer hard cap. Each turn may invoke multiple tool calls; the
  // tool-call budget caps the cumulative count. We additionally cap
  // the OUTER loop iterations as belt-and-braces against a runaway
  // model that returns zero functionCalls AND zero text repeatedly.
  const MAX_OUTER_ITERATIONS = 12

  while (safetyTicks < MAX_OUTER_ITERATIONS) {
    safetyTicks += 1
    if (args.abortSignal.aborted) break

    const toolsDisabled =
      toolCallRecords.length >= MAX_TOOL_CALLS_PER_TURN
    if (toolsDisabled) toolBudgetExhausted = true

    const response = await ai.client.models.generateContent({
      model,
      contents: history,
      config: {
        systemInstruction: systemPrompt,
        tools: toolsDisabled
          ? []
          : [{ functionDeclarations: TOOL_DECLARATIONS as unknown as never }],
        toolConfig: toolsDisabled
          ? {
              functionCallingConfig: {
                mode: FunctionCallingConfigMode.NONE,
              },
            }
          : {
              functionCallingConfig: {
                mode: FunctionCallingConfigMode.AUTO,
              },
            },
        abortSignal: args.abortSignal,
        temperature: 0.7,
        maxOutputTokens: 4096,
      },
    })

    // PR 4 audit fix (MEDIUM M8): abort check IMMEDIATELY after the
    // Gemini RPC returns — before we walk parts or accumulate text.
    // If the client disconnected mid-RPC, exit cleanly without
    // executing tool calls that would mutate the in-memory session.
    if (args.abortSignal.aborted) break

    // Capture usage snapshot (last non-empty value wins).
    const um = response.usageMetadata
    if (um) {
      usage = {
        promptTokens: um.promptTokenCount ?? usage.promptTokens,
        outputTokens:
          um.candidatesTokenCount ?? usage.outputTokens,
        latencyMs: usage.latencyMs,
      }
    }

    const candidate = response.candidates?.[0]
    const parts: Part[] = candidate?.content?.parts ?? []

    // Append model turn to history verbatim — Gemini's chat protocol
    // requires the model's parts (including functionCall parts) to be
    // present in the contents array before the matching functionResponse.
    if (parts.length > 0 && candidate?.content) {
      history.push({
        role: candidate.content.role ?? 'model',
        parts,
      })
    }

    const functionCalls: FunctionCall[] = parts.flatMap((p) =>
      p.functionCall ? [p.functionCall] : [],
    )
    const text = parts
      .filter((p) => typeof p.text === 'string')
      .map((p) => p.text!)
      .join('')

    if (functionCalls.length === 0) {
      // Final text reply (or empty text with no calls — exit either way).
      if (text.length > 0) modelText = text
      break
    }

    // Execute each tool call. NOTE: if budget is exhausted we shouldn't
    // be HERE (tools were disabled above), but defence-in-depth — drop
    // any function calls Gemini sneaks through after budget exhaustion.
    if (toolsDisabled) {
      // Pretend the calls didn't happen and treat the text portion (if
      // any) as the final reply.
      if (text.length > 0) modelText = text
      break
    }

    const responseParts: Part[] = []
    for (const fc of functionCalls) {
      if (args.abortSignal.aborted) break
      const callName = fc.name ?? ''
      const callArgs = fc.args ?? {}
      const result = await executeToolCall(callName, callArgs, session)
      const record: ChatProposalToolCallRecord = {
        name: callName,
        args: callArgs,
        ok: result.ok,
        ...('summary' in result && result.summary
          ? { summary: result.summary }
          : {}),
        ...(!result.ok ? { error: result.error } : {}),
      }
      toolCallRecords.push(record)
      args.onToolCall?.({ name: callName, args: callArgs, result })
      responseParts.push({
        functionResponse: {
          name: callName,
          response: result as unknown as Record<string, unknown>,
          ...(fc.id ? { id: fc.id } : {}),
        },
      })
      if (toolCallRecords.length >= MAX_TOOL_CALLS_PER_TURN) {
        // Budget hit — but we MUST still respond to the calls we already
        // accepted in this turn before the next iteration disables tools.
        // The next iteration will see toolsDisabled === true and force a
        // tool-less final reply.
        break
      }
    }

    if (responseParts.length > 0) {
      history.push({ role: 'user', parts: responseParts })
    }
  }

  usage.latencyMs = Date.now() - startedAt

  // PR 4 audit fix (MEDIUM M13): if the client disconnected during
  // the tool loop, do NOT persist a proposal — the operator never
  // sees the token, so a pending row would only ever age out via
  // the sweeper while burning Gemini quota for nothing.
  if (args.abortSignal.aborted) {
    return {
      token: null,
      changeset: session.changeset,
      modelText,
      model,
      usage,
      toolCalls: toolCallRecords,
      toolBudgetExhausted,
    }
  }

  // ── Persist proposal if the changeset is non-empty. ────────────
  let token: string | null = null
  if (session.changeset.length > 0) {
    token = await persistChatProposal({
      userId: args.userId,
      pageId: args.pageId,
      userPrompt: args.userPrompt,
      changeset: session.changeset,
      model,
      usage,
      toolCallRecords,
      ip: args.ip,
      userAgent: args.userAgent,
      requestId: args.requestId,
    })
  }

  return {
    token,
    changeset: session.changeset,
    modelText,
    model,
    usage,
    toolCalls: toolCallRecords,
    toolBudgetExhausted,
  }
}

// ── Persistence ───────────────────────────────────────────────────

interface PersistChatProposalInput {
  userId: number
  pageId: number
  userPrompt: string
  changeset: ChatChangesetOp[]
  model: string
  usage: ChatProposalUsage
  toolCallRecords: ChatProposalToolCallRecord[]
  ip: string | null
  userAgent: string | null
  requestId: string | null
}

async function persistChatProposal(
  input: PersistChatProposalInput,
): Promise<string> {
  const token = newProposalToken()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + PROPOSAL_EXPIRY_MS)

  // Audit diff. We do NOT log the operator's raw prompt text (PII
  // surface) or Gemini's final reply text (reconstructable from the
  // changeset + audit chain). What WE keep:
  //   - token + surface + opCount per kind
  //   - tool-call summary count + ok/err counts
  //   - usage telemetry
  //   - prompt length (gives forensic answer "was a prompt sent")
  const opKindCounts: Record<string, number> = {}
  for (const op of input.changeset) {
    opKindCounts[op.op] = (opKindCounts[op.op] ?? 0) + 1
  }
  const auditDiff = {
    token,
    surface: 'chat' as const,
    promptLength: input.userPrompt.length,
    opCount: input.changeset.length,
    opKinds: opKindCounts,
    toolCallCount: input.toolCallRecords.length,
    toolCallOk: input.toolCallRecords.filter((r) => r.ok).length,
    toolCallErr: input.toolCallRecords.filter((r) => !r.ok).length,
    geminiModel: input.model,
    usage: input.usage,
  }

  // Prompt column — audit-friendly summary. Holds the original prompt
  // text (capped to the column's varchar(2000) ceiling); long-term
  // forensics use the audit + content_blocks history; the prompt
  // column is for the short-window "what did the operator just ask?".
  const promptSummary = input.userPrompt.slice(0, 2000)

  // Insert proposal first (its own TX). The audit insert runs in a
  // SEPARATE TX afterwards with a retry — matching the inline applier's
  // phase-3 semantics (PR 4 audit fix L5). If the audit fails, the
  // proposal still ships so the operator gets a token; the structured
  // fatal log flags the audit gap for the operator's alert pipeline.
  let proposalId = 0
  await db.transaction(async (tx) => {
    const insertResult = (await tx.insert(aiProposals).values({
      token,
      userId: input.userId,
      pageId: input.pageId,
      surface: 'chat',
      prompt: promptSummary,
      changeset: input.changeset as unknown as object,
      status: 'pending',
      model: input.model,
      tokensUsage: input.usage as unknown as object,
      expiresAt,
    })) as unknown as { insertId?: number } | [{ insertId: number }, unknown]
    const insertId = Array.isArray(insertResult)
      ? insertResult[0]?.insertId
      : insertResult?.insertId
    proposalId = insertId ?? 0
    if (!proposalId) {
      const [rows] = (await tx.execute(sql`
        SELECT id FROM ai_proposals WHERE token = ${token} LIMIT 1
      `)) as unknown as [Array<{ id: number }>]
      proposalId = rows[0]?.id ?? 0
    }
  })

  let phase2Retries = 1
  while (true) {
    try {
      await db.insert(auditLog).values({
        userId: input.userId,
        action: 'ai_proposal_created',
        resourceType: 'ai_proposal',
        resourceId: String(proposalId),
        diff: auditDiff as unknown as object,
        ip: input.ip,
        userAgent: input.userAgent,
        requestId: input.requestId,
      })
      break
    } catch (err) {
      if (phase2Retries > 0) {
        phase2Retries -= 1
        await new Promise((r) => setTimeout(r, 250))
        continue
      }
      console.error(
        JSON.stringify({
          level: 'fatal',
          msg: 'ai_proposal_created_audit_failed',
          proposal_id: proposalId,
          token,
          err_name: err instanceof Error ? err.name : 'unknown',
        }),
      )
      break
    }
  }

  return token
}

// ── Settings readers ──────────────────────────────────────────────

interface SettingValueRow {
  value: unknown
}

async function readSiteContext(): Promise<{
  siteName?: string
  siteDescription?: string
}> {
  try {
    const [rows] = (await db.execute(sql`
      SELECT \`key\`, value FROM settings
      WHERE \`key\` IN ('default_seo', 'site_general')
    `)) as unknown as [Array<{ key: string } & SettingValueRow>]
    let siteName: string | undefined
    let siteDescription: string | undefined
    for (const row of rows) {
      const raw =
        typeof row.value === 'string'
          ? (() => {
              try {
                return JSON.parse(row.value as string) as unknown
              } catch {
                return null
              }
            })()
          : row.value
      if (!raw || typeof raw !== 'object') continue
      const obj = raw as Record<string, unknown>
      if (row.key === 'default_seo') {
        if (typeof obj['title'] === 'string') {
          siteName = siteName ?? (obj['title'] as string)
        }
        if (typeof obj['description'] === 'string') {
          siteDescription = obj['description'] as string
        }
      } else if (row.key === 'site_general') {
        if (typeof obj['siteName'] === 'string') {
          siteName = obj['siteName'] as string
        }
      }
    }
    return { siteName, siteDescription }
  } catch {
    return {}
  }
}

// Re-export the typed errors so the route handler can map them to
// HTTP codes without importing from the client module directly.
export {
  AiDisabledError,
  AiDecryptError,
  AiUnconfiguredError,
  HttpError,
  UnsafePromptError,
}
