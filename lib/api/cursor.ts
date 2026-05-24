// Shared cursor format helpers for keyset pagination across admin
// endpoints. Two flavors:
//
//   - idCursor: `<id>` for endpoints that sort by id alone
//     (audit-log, alerts). Tighter regex than the previous
//     /^\d+$/ — rejects "0" because autoincrement starts at 1.
//
//   - createdAtIdCursor: `<iso>_<id>` for endpoints that sort by
//     (created_at, id) DESC (leads). ISO timestamps contain no
//     underscore so the first underscore is the unambiguous
//     separator. Bounds length so a pathological URL can't burn
//     CPU on a malformed parse.
//
// Both parsers return null on invalid input — callers fall back to
// page-1 instead of 400-ing, matching the user-tolerance baseline
// established by /api/admin/leads.

// Max length defenses against pathological cursor values. ISO is
// 24 chars (`2026-05-13T00:00:00.000Z`), id at most a 32-bit signed
// (10 digits), plus one underscore: 35. 60 = comfortable upper bound.
const MAX_CURSOR_LEN = 60

// id-only: positive integer, no leading zeros, fits in i32 range.
const ID_RE = /^[1-9]\d{0,9}$/

export interface IdCursor {
  beforeId: number
}

export function parseIdCursor(s: string | null | undefined): IdCursor | null {
  if (!s) return null
  if (s.length > MAX_CURSOR_LEN) return null
  if (!ID_RE.test(s)) return null
  const n = Number(s)
  if (!Number.isInteger(n) || n <= 0 || n > 2_147_483_647) return null
  return { beforeId: n }
}

export function formatIdCursor(id: number): string {
  return String(id)
}

export interface CreatedAtIdCursor {
  beforeCreatedAt: Date
  beforeId: number
}

export function parseCreatedAtIdCursor(
  s: string | null | undefined,
): CreatedAtIdCursor | null {
  if (!s) return null
  if (s.length > MAX_CURSOR_LEN) return null
  const idx = s.lastIndexOf('_')
  if (idx <= 0 || idx >= s.length - 1) return null
  const isoPart = s.slice(0, idx)
  const idPart = s.slice(idx + 1)
  if (!ID_RE.test(idPart)) return null
  const id = Number(idPart)
  if (!Number.isInteger(id) || id <= 0 || id > 2_147_483_647) return null
  const d = new Date(isoPart)
  if (Number.isNaN(d.getTime())) return null
  // Re-format the parsed Date back to ISO and compare to detect
  // unusual inputs like `2026-13-99T..` that Date silently
  // "corrects" — those would land on different rows than the
  // operator's bookmarked link expected.
  if (d.toISOString() !== isoPart) return null
  return { beforeCreatedAt: d, beforeId: id }
}

export function formatCreatedAtIdCursor(createdAt: Date, id: number): string {
  return `${createdAt.toISOString()}_${id}`
}
