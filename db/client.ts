import 'server-only'
import { db } from './client-node'
export { db, pool } from './client-node'

// Drizzle's `db.transaction` callback parameter — extracted once so
// helpers (durableRevalidate, mediaCheck, …) all type their `tx` arg
// against the same alias. Single source prevents drift if the
// underlying client / driver / schema changes.
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
