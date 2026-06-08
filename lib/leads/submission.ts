// The structured form-submission shape persisted in leads.payload for lx_form
// (source='form') leads: the raw [{label,value}] of every submitted field.
// Lives in its own module so the [id] detail route (parse) and the LeadsTable
// drawer (render, type-only import) share ONE source of truth.
export type SubmissionField = { label: string; value: string }

// Parse the leads.payload JSON column into a clean, well-formed array.
// mysql2 returns a JSON column as a STRING on MariaDB (which aliases JSON to
// LONGTEXT) but as an ALREADY-PARSED array on MySQL-native JSON — handle both,
// matching the codebase's universal `typeof === 'string' ? JSON.parse : raw`
// json-column guard. A malformed / hand-edited row → null (caller falls back
// to the flattened `message`). Pure + isomorphic — no server-only deps.
export function parseSubmission(raw: unknown): SubmissionField[] | null {
  if (raw == null) return null
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!Array.isArray(v)) return null
  const out = v
    .filter(
      (x): x is SubmissionField =>
        !!x &&
        typeof x === 'object' &&
        typeof (x as Record<string, unknown>).label === 'string' &&
        typeof (x as Record<string, unknown>).value === 'string',
    )
    // Re-apply the writer's cap (form route inserts z.array(...).max(20)) so a
    // hand-edited / restored row can't make the admin drawer render unbounded
    // rows — mirrors lxFormActionsSchema's read-path .max() re-bound.
    .slice(0, 20)
  return out.length > 0 ? out : null
}
