// PURE, EDGE-SAFE. No '@/db', no 'node:*', no 'server-only' — the Edge
// middleware imports this. RegExp / Map / string only.
import { z } from 'zod'

export type RedirectMatchType = 'exact' | 'wildcard' | 'regex'
export type RedirectAction = 'redirect' | 'gone'
// Only two query modes are meaningful in this model (the source is a path,
// not a path+query): 'passthrough' carries the original query onto the
// target, 'ignore' drops it. (An 'exact' mode was removed — it had no
// matching-time semantics and would have silently behaved like passthrough.)
export type QueryHandling = 'passthrough' | 'ignore'
export const REDIRECT_STATUS_CODES = [301, 302, 307, 308] as const
export type RedirectStatus = (typeof REDIRECT_STATUS_CODES)[number]

// Longest pathname we will run operator-supplied regex/wildcard rules
// against. Pathnames longer than this never legitimately match a redirect
// rule. Exponential patterns are rejected up front (hasUnsafeQuantifier), so
// this cap only needs to bound the remaining POLYNOMIAL backtracking — 1024
// keeps a degree-2 pattern at ~1M steps (sub-millisecond).
const MAX_REGEX_INPUT = 1024

// The DB-shaped rule the matcher consumes (subset projected by the feed).
export interface RedirectRule {
  id: number
  source: string
  matchType: RedirectMatchType
  action: RedirectAction
  target: string | null
  statusCode: number | null
  queryHandling: QueryHandling
  caseInsensitive: boolean
}

// Snake_case row shape returned by the feed/test SQL projections. Shared so
// the middleware feed and the admin "Test a URL" route map identically.
export interface RedirectFeedRow {
  id: number
  source: string
  match_type: RedirectMatchType
  action: RedirectAction
  target: string | null
  status_code: number | null
  query_handling: QueryHandling
  case_insensitive: number
}

export function rowToRule(r: RedirectFeedRow): RedirectRule {
  return {
    id: r.id,
    source: r.source,
    matchType: r.match_type,
    action: r.action,
    target: r.target,
    statusCode: r.status_code,
    queryHandling: r.query_handling,
    caseInsensitive: r.case_insensitive === 1,
  }
}

// Operator input for create/update. Coerced + bounded by Zod.
export const RedirectInput = z
  .object({
    source: z.string().min(1).max(512),
    matchType: z.enum(['exact', 'wildcard', 'regex']),
    action: z.enum(['redirect', 'gone']),
    target: z.string().max(2048).nullable().optional(),
    statusCode: z.number().int().nullable().optional(),
    queryHandling: z.enum(['passthrough', 'ignore']),
    caseInsensitive: z.boolean(),
    enabled: z.boolean(),
    notes: z.string().max(255).nullable().optional(),
  })
  .strict()
export type RedirectInputT = z.infer<typeof RedirectInput>

export type ValidateResult =
  | { ok: true; value: RedirectInputT }
  | { ok: false; error: string }

// Path normalization shared by validation, the matcher, and the admin
// "Test a URL" box so they agree. Strips a trailing slash (except root)
// and collapses duplicate slashes. Case is handled by the caller.
export function normalizePath(p: string): string {
  let out = p.replace(/\/{2,}/g, '/')
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  return out || '/'
}

// ReDoS guard against EXPONENTIAL backtracking in JS's native regex engine.
// Rejects a quantified group `( … )<quant>` whose body contains EITHER:
//   - another quantifier  → "star height >= 2", e.g. (a+)+, (a*)*, (.*)+, (a{2,})+
//   - a top-level alternation `|`  → e.g. (a|a)+, (a|ab)+, (a|b)+
// Both families blow up exponentially (a 30-char request to (a|a)+ backtracks
// for ~60s, pinning the single-threaded Edge worker — a remote DoS triggerable
// by any anonymous visitor). The native RegExp engine cannot be swapped for a
// linear matcher (RE2) on the Edge runtime, so we reject these shapes at
// authoring AND compile time. This is conservative — it also rejects some
// safe quantified alternations like (a|b)+; operators should use a character
// class ([ab]+) instead. The remaining (polynomial) patterns are bounded by
// MAX_REGEX_INPUT at match time. Dependency-free; pairs with that cap.
export function hasUnsafeQuantifier(src: string): boolean {
  const quant: boolean[] = [false] // quant[d] = a quantifier seen at group depth d
  const alt: boolean[] = [false] // alt[d]   = a top-level '|' seen at group depth d
  let depth = 0
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '\\') {
      i++ // skip the escaped char
      continue
    }
    if (ch === '[') {
      // skip a character class wholesale
      i++
      while (i < src.length && src[i] !== ']') {
        if (src[i] === '\\') i++
        i++
      }
      continue
    }
    if (ch === '(') {
      depth++
      quant[depth] = false
      alt[depth] = false
      continue
    }
    if (ch === ')') {
      const ambiguousBody = quant[depth] === true || alt[depth] === true
      depth = Math.max(0, depth - 1)
      const next = src[i + 1]
      const repeated = next === '*' || next === '+' || next === '{'
      if (repeated) {
        if (ambiguousBody) return true // (…<quant>)<quant> or (…|…)<quant>
        quant[depth] = true // enclosing scope now contains a quantified group
      }
      continue
    }
    if (ch === '|') {
      alt[depth] = true
      continue
    }
    if (ch === '*' || ch === '+' || ch === '{') {
      quant[depth] = true
    }
  }
  return false
}

export function validateRedirect(raw: unknown): ValidateResult {
  const parsed = RedirectInput.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid' }
  }
  const v = parsed.data
  // Exact + wildcard sources are literal paths and must start with '/'.
  // Regex sources are patterns matched against the path and naturally begin
  // with an anchor/metachar (e.g. ^/p/(\d+)$), so the '/' rule doesn't apply.
  if (v.matchType !== 'regex' && !v.source.startsWith('/')) {
    return { ok: false, error: 'Source must start with "/"' }
  }
  if (v.matchType === 'regex') {
    if (v.source.length > 300) {
      return { ok: false, error: 'Regex source too long' }
    }
    if (hasUnsafeQuantifier(v.source)) {
      return {
        ok: false,
        error:
          'Regex looks unsafe (a repeated group with nested quantifiers or alternation can hang the server) — simplify it, e.g. use a character class like [ab]+ instead of (a|b)+',
      }
    }
    try {
      new RegExp(v.source)
    } catch {
      return { ok: false, error: 'Invalid regex pattern' }
    }
  }
  if (v.action === 'redirect') {
    const target = (v.target ?? '').trim()
    if (!target) {
      return { ok: false, error: 'Target is required for a redirect' }
    }
    // Reject control chars (CR/LF) — defence in depth against header
    // injection into the Location header (the URL sink already neutralizes
    // these, but a clean validation error is friendlier than a 500).
    if (/[\u0000-\u001f\u007f]/.test(target)) {
      return { ok: false, error: 'Target contains invalid control characters' }
    }
    const okShape = target.startsWith('/') || /^https?:\/\//i.test(target)
    if (!okShape) {
      return { ok: false, error: 'Target must be a path or an http(s) URL' }
    }
    if (!REDIRECT_STATUS_CODES.includes(v.statusCode as RedirectStatus)) {
      return { ok: false, error: 'Status code must be 301, 302, 307, or 308' }
    }
    // Self-loop guard for exact rules (wildcard/regex can't be statically
    // compared; the runtime target!==current-path skip covers those).
    if (
      v.matchType === 'exact' &&
      normalizePath(v.source) === normalizePath(target)
    ) {
      return { ok: false, error: 'Source and target are the same' }
    }
  } else {
    // action === 'gone' — no target, no status code.
    if (v.target && v.target.trim()) {
      return { ok: false, error: 'A "Gone" rule must not have a target' }
    }
    if (v.statusCode != null) {
      return { ok: false, error: 'A "Gone" rule must not have a status code' }
    }
  }
  return { ok: true, value: v }
}

// ─── Compiler + matcher ──────────────────────────────────────────────

export interface MatchResult {
  kind: 'redirect' | 'gone'
  // present when kind==='redirect'
  location?: string
  status?: number
  ruleId: number
}

interface CompiledDynamic {
  rule: RedirectRule
  re: RegExp
}
export interface CompiledRuleset {
  // Case-SENSITIVE exact rules, keyed by normalized source (exact bytes).
  exactCS: Map<string, RedirectRule>
  // Case-INsensitive exact rules, keyed by lowercased normalized source.
  exactCI: Map<string, RedirectRule>
  // ordered wildcard + regex, evaluated in array order (feed pre-sorts by position)
  dynamic: CompiledDynamic[]
}

function wildcardToRegExpBody(source: string): string {
  // Escape regex metachars, then turn the escaped '\*' back into '(.*)'.
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return '^' + escaped.replace(/\\\*/g, '(.*)') + '$'
}

export function compileRules(rules: RedirectRule[]): CompiledRuleset {
  const exactCS = new Map<string, RedirectRule>()
  const exactCI = new Map<string, RedirectRule>()
  const dynamic: CompiledDynamic[] = []
  for (const r of rules) {
    try {
      if (r.matchType === 'exact') {
        if (r.caseInsensitive) {
          const key = normalizePath(r.source).toLowerCase()
          if (!exactCI.has(key)) exactCI.set(key, r) // first by position wins
        } else {
          const key = normalizePath(r.source)
          if (!exactCS.has(key)) exactCS.set(key, r)
        }
      } else {
        // ReDoS defence: never compile a catastrophic regex even if one
        // somehow reached the DB (validation blocks authoring it).
        if (r.matchType === 'regex' && hasUnsafeQuantifier(r.source)) continue
        const body =
          r.matchType === 'wildcard' ? wildcardToRegExpBody(r.source) : r.source
        const flags = r.caseInsensitive ? 'i' : ''
        dynamic.push({ rule: r, re: new RegExp(body, flags) })
      }
    } catch {
      // One bad rule must not break the whole engine — skip it.
      continue
    }
  }
  return { exactCS, exactCI, dynamic }
}

function applyQuery(
  target: string,
  search: string,
  mode: QueryHandling,
): string {
  if (mode === 'ignore' || !search) return target
  // passthrough: append the original query to the target, merging if the
  // target already carries one.
  const q = search.startsWith('?') ? search.slice(1) : search
  if (!q) return target
  return target.includes('?') ? `${target}&${q}` : `${target}?${q}`
}

export function matchRedirect(
  c: CompiledRuleset,
  pathname: string,
  search: string,
): MatchResult | null {
  const norm = normalizePath(pathname)

  // 1) exact — case-sensitive map keyed by exact bytes, then the
  //    case-insensitive map keyed by the lowercased path. A case-sensitive
  //    rule is NEVER consulted via the lowercased key, so caseInsensitive
  //    is honored on both sides.
  const exactRule = c.exactCS.get(norm) ?? c.exactCI.get(norm.toLowerCase())
  if (exactRule) {
    const res = buildResult(exactRule, search, null, norm)
    if (res) return res
  }

  // 2) dynamic (wildcard / regex), first match wins. Skip entirely for
  //    pathologically long input (ReDoS bound).
  if (norm.length > MAX_REGEX_INPUT) return null
  for (const { rule, re } of c.dynamic) {
    const m = re.exec(norm)
    if (!m) continue
    const res = buildResult(rule, search, m, norm)
    if (res) return res
  }
  return null
}

function buildResult(
  rule: RedirectRule,
  search: string,
  captures: RegExpExecArray | null,
  currentPath: string,
): MatchResult | null {
  if (rule.action === 'gone') return { kind: 'gone', ruleId: rule.id }
  let target = rule.target ?? '/'
  // Substitute $1..$9 from regex captures.
  if (captures) {
    target = target.replace(
      /\$([1-9])/g,
      (_, d: string) => captures[Number(d)] ?? '',
    )
  }
  const location = applyQuery(target, search, rule.queryHandling)
  // Loop guard: never redirect a path to itself.
  if (
    location.startsWith('/') &&
    normalizePath(location.split('?')[0] ?? location) === currentPath
  ) {
    return null
  }
  return {
    kind: 'redirect',
    location,
    status: rule.statusCode ?? 301,
    ruleId: rule.id,
  }
}

// etag helper used by the feed + middleware cache (pure).
export function rulesetEtag(count: number, maxUpdatedAtMs: number): string {
  return `${count}:${maxUpdatedAtMs}`
}
