// PURE, EDGE-SAFE. No '@/db', no 'node:*', no 'server-only' — the Edge
// middleware imports this. RegExp / Map / string only.
import { z } from 'zod'

export type RedirectMatchType = 'exact' | 'wildcard' | 'regex'
export type RedirectAction = 'redirect' | 'gone'
export type QueryHandling = 'passthrough' | 'ignore' | 'exact'
export const REDIRECT_STATUS_CODES = [301, 302, 307, 308] as const
export type RedirectStatus = (typeof REDIRECT_STATUS_CODES)[number]

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

// Operator input for create/update. Coerced + bounded by Zod.
export const RedirectInput = z
  .object({
    source: z.string().min(1).max(512),
    matchType: z.enum(['exact', 'wildcard', 'regex']),
    action: z.enum(['redirect', 'gone']),
    target: z.string().max(2048).nullable().optional(),
    statusCode: z.number().int().nullable().optional(),
    queryHandling: z.enum(['passthrough', 'ignore', 'exact']),
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

export function validateRedirect(raw: unknown): ValidateResult {
  const parsed = RedirectInput.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid' }
  }
  const v = parsed.data
  if (!v.source.startsWith('/')) {
    return { ok: false, error: 'Source must start with "/"' }
  }
  if (v.matchType === 'regex') {
    // Reject patterns that don't compile and cap length (ReDoS surface).
    if (v.source.length > 300) {
      return { ok: false, error: 'Regex source too long' }
    }
    try {
      // eslint-disable-next-line no-new
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
  // exact: normalized key (lowercased when caseInsensitive) → rule
  exact: Map<string, RedirectRule>
  // ordered wildcard + regex, evaluated in array order (feed pre-sorts by position)
  dynamic: CompiledDynamic[]
}

function wildcardToRegExpBody(source: string): string {
  // Escape regex metachars, then turn the escaped '\*' back into '(.*)'.
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return '^' + escaped.replace(/\\\*/g, '(.*)') + '$'
}

export function compileRules(rules: RedirectRule[]): CompiledRuleset {
  const exact = new Map<string, RedirectRule>()
  const dynamic: CompiledDynamic[] = []
  for (const r of rules) {
    try {
      if (r.matchType === 'exact') {
        const key = r.caseInsensitive
          ? normalizePath(r.source).toLowerCase()
          : normalizePath(r.source)
        // First rule wins on duplicate key (feed is ordered).
        if (!exact.has(key)) exact.set(key, r)
      } else {
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
  return { exact, dynamic }
}

function applyQuery(
  target: string,
  search: string,
  mode: QueryHandling,
): string {
  if (mode === 'ignore' || !search) return target
  // passthrough (and 'exact', which only affects matching, not output):
  // append the original query to the target, merging if it already has one.
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

  // 1) exact (try both case-sensitive and lowered key)
  const exactRule = c.exact.get(norm) ?? c.exact.get(norm.toLowerCase())
  if (exactRule) {
    const res = buildResult(exactRule, search, null, norm)
    if (res) return res
  }

  // 2) dynamic (wildcard / regex), first match wins
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
