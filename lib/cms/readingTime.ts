import { sql } from 'drizzle-orm'

// Shared reading-time SQL (F14). The ≈200-wpm estimate is computed IN SQL from
// the post body's character length so the full body text never crosses into app
// memory just to count words. The formula — ceil(chars / CHARS_PER_MINUTE), min
// 1 — assumes ≈5 chars/word and ≈200 wpm → 1000 chars/minute. body_md is the
// body source (Phase 2's lx_richtext mirrors it); an empty body floors to 1 min.
//
// This is the SINGLE source of truth for the expression — both query sites (the
// Blog Loop slice in lib/cms/hydrate and the post detail page) reference it so
// the magic constant + the formula can't drift between them.

/** Characters of body text that count as ≈1 minute of reading (≈5 chars/word ×
 *  ≈200 wpm). Exported so any non-SQL estimate (or a test) shares the constant. */
export const READING_CHARS_PER_MINUTE = 1000

/**
 * The reading-time SQL expression, parameterized on the caller's table alias so
 * each query site passes its own (`'p'` for `FROM posts p`). Returns an integer
 * ≥ 1. Use as a SELECT-list expression: `${readingTimeSql('p')} AS reading_minutes`.
 */
export function readingTimeSql(alias = 'p') {
  const col = alias ? sql.raw(`${alias}.`) : sql.raw('')
  return sql`GREATEST(1, CEIL(CHAR_LENGTH(COALESCE(${col}body_md, '')) / ${sql.raw(String(READING_CHARS_PER_MINUTE))}))`
}
