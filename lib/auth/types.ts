// Tiny shared types module so both `getSession.ts` and `requireRole.ts`
// can name the Role type without creating an import cycle. (getSession
// holds the shared pipeline that requireRole consumes; both need Role.)
export type Role = 'admin' | 'editor' | 'viewer'
