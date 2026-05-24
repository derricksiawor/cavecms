// Thin localStorage wrapper that silences QuotaExceededError,
// SecurityError (Safari private), TypeError (circular ref), and the
// ReferenceError that fires when the accessor reaches the server
// (RSC streaming, Suspense boundaries, future use). Originally lived
// inline in EditDrawer.tsx; the chunk-K resize / outline-collapse /
// custom-select work duplicated the same try/catch pattern in three
// more files. Extracted post-agent-review (chunk K) so future
// hardening (e.g., a `getJSON<T>(key, validator)` overload) is a
// one-file change.

export const safeStorage = {
  get(key: string): string | null {
    try {
      return typeof window === 'undefined'
        ? null
        : window.localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key: string, value: string): void {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(key, value)
    } catch {
      // private browsing / quota — non-fatal
    }
  },
  remove(key: string): void {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.removeItem(key)
    } catch {
      // private browsing / quota — non-fatal
    }
  },
}
