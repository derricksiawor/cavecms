import 'server-only'
import { sql } from 'drizzle-orm'

// When an operator changes a permalink base segment (blog or projects) from
// `old` → `new`, every existing link + indexed URL under `/old/...` must keep
// working. We register a catch-all wildcard 301 in the operator `redirects`
// table — `/old/*` → `/new/$1` — which the Edge middleware's redirect matcher
// (RE2JS, linear-time, ReDoS-safe) picks up within its cache TTL. Also redirect
// the bare `/old` → `/new`. This reuses the EXISTING redirect infra (no new
// table) so the operator can see / tweak / delete the rule under Settings →
// Redirects like any other.
//
// Idempotent: upsert on the (source, match_type) unique key so repeated saves
// don't accumulate duplicate rows, and a re-rename (new → newer) replaces the
// `/old/*` rule's target rather than leaving a stale chain. Existing POST
// `slug_redirects` (a SEPARATE table, the auto old-slug→new-slug chain) are
// untouched.
//
// Wildcard semantics (lib/cms/redirects): `*` compiles to an anchored `(.*)`
// group, and `$1` in the target substitutes it — so `/old/*`→`/new/$1` maps
// `/old/a/b` to `/new/a/b`. RE2JS makes the compiled pattern backtracking-free.
//
// `tx` is the same transaction object the settings PATCH route runs the UPDATE
// in (drizzle Tx OR the db handle) so the redirect registration commits
// atomically with the segment change — a half-applied state (segment changed
// but no redirect) can never leak.

type Execable = {
  execute: (q: ReturnType<typeof sql>) => Promise<unknown>
}

/** Upsert one redirect rule (source, matchType) → target. Position 100 keeps
 *  these system-registered rules after the operator's own hand-authored
 *  wildcard/regex rules (which default to position 0) so an operator override
 *  for a specific old path still wins. */
async function upsertRedirect(
  tx: Execable,
  source: string,
  matchType: 'exact' | 'wildcard',
  target: string,
  createdBy: number | null,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO redirects
      (source, match_type, action, target, status_code, query_handling,
       case_insensitive, enabled, position, notes, created_by)
    VALUES
      (${source}, ${matchType}, 'redirect', ${target}, 301, 'passthrough',
       1, 1, 100, 'Auto-registered when a permalink base segment changed.',
       ${createdBy})
    ON DUPLICATE KEY UPDATE
      action = 'redirect',
      target = VALUES(target),
      status_code = 301,
      query_handling = 'passthrough',
      enabled = 1,
      notes = VALUES(notes),
      updated_at = NOW(3)
  `)
}

/**
 * Register old→new redirects for a permalink base-segment change. No-op when
 * `oldSegment === newSegment` (the PATCH no-op path never calls this anyway).
 * Registers BOTH the bare `/old` → `/new` (exact) and `/old/*` → `/new/$1`
 * (wildcard) so the index AND every sub-path survive.
 *
 * LOOP SAFETY (H1): `newSegment` is the now-LIVE base — visitors hit
 * `/new/...` and the segment rewrite (middleware) resolves them to the file
 * route. But the redirect matcher runs BEFORE that rewrite, so ANY existing
 * redirect rule whose source is `/new` or `/new/*` would shadow the live
 * segment. The classic trap is a 2-cycle: an earlier rename news→press left
 * `/news`→`/press` + `/news/*`→`/press/$1`; renaming press→news now would make
 * `/news/...` redirect to `/press/...` while `/press/...` redirects back to
 * `/news/...` — an infinite 301 loop. So we DELETE any rule whose source is
 * exactly `/new` or `/new/*` in the SAME transaction, before upserting the
 * old→new rules. (The deleted `/news/*`→`/press/$1` rule is exactly what broke
 * the live `/news/...` path; removing it restores resolution.)
 *
 * CHAIN COLLAPSE (multi-hop): after news→press→media, the original
 * `/news/*`→`/press/$1` rule still points at `/press` (the now-old base). We
 * retarget any rule whose TARGET resolves under `/old` to point under `/new`
 * instead, collapsing the chain to one hop. This is cleanly expressible with
 * the existing schema (the target is a literal path with a `$1` capture ref):
 * rewrite the `/old` prefix in the target to `/new`. Bounded to the two prefix
 * shapes the segment-change rules ever produce (`/old` exact, `/old/...`
 * wildcard); operator-authored rules with unrelated targets are untouched.
 */
export async function registerSegmentChangeRedirects(
  tx: Execable,
  oldSegment: string,
  newSegment: string,
  createdBy: number | null,
): Promise<void> {
  if (oldSegment === newSegment) return

  // 1. DELETE any rule whose source is the now-LIVE base (`/new` or `/new/*`).
  //    Removing these breaks a re-rename 2-cycle (the prior `/new/*`→/old rule
  //    would otherwise shadow + loop the live segment). Idempotent — deleting
  //    absent rows is a no-op. Both source forms in one parameterized statement.
  await tx.execute(sql`
    DELETE FROM redirects
    WHERE source IN (${`/${newSegment}`}, ${`/${newSegment}/*`})
  `)

  // 2. Retarget any rule that currently points under `/old` so it points under
  //    `/new` instead — collapses a multi-hop chain (news→press→media) to one
  //    hop. The two target shapes a prior segment-change ever wrote are
  //    `/old` (exact-rule target) and `/old/$1` (wildcard-rule target); rewrite
  //    just the `/old` prefix. We exclude the rules we're about to upsert below
  //    (source `/old` / `/old/*`) so the retarget doesn't touch the soon-to-be
  //    self-referential rows. Parameterized; the CONCAT replaces the leading
  //    `/old` segment of the target.
  const oldExactTarget = `/${oldSegment}`
  const oldWildcardTargetPrefix = `/${oldSegment}/`
  await tx.execute(sql`
    UPDATE redirects
    SET target = CASE
          WHEN target = ${oldExactTarget} THEN ${`/${newSegment}`}
          ELSE CONCAT(${`/${newSegment}/`}, SUBSTRING(target, ${oldWildcardTargetPrefix.length + 1}))
        END,
        updated_at = NOW(3)
    WHERE action = 'redirect'
      AND source NOT IN (${`/${oldSegment}`}, ${`/${oldSegment}/*`})
      AND (target = ${oldExactTarget} OR target LIKE ${`${oldWildcardTargetPrefix}%`})
  `)

  // 3. Upsert the fresh old→new rules.
  // Bare index: /old → /new (exact). 308 would be more correct for a permanent
  // move, but the operator redirect model is 301-by-convention here + matches
  // the wildcard rule below; both are permanent and SEO-equivalent for GET.
  await upsertRedirect(tx, `/${oldSegment}`, 'exact', `/${newSegment}`, createdBy)
  // Everything under it: /old/* → /new/$1 (wildcard).
  await upsertRedirect(tx, `/${oldSegment}/*`, 'wildcard', `/${newSegment}/$1`, createdBy)
}
