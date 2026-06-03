import type { createDestination } from './cloud/destination.mjs'
export function pullFromCloud(a: { env?: Record<string, string | undefined>; createDest?: typeof createDestination }): Promise<{ archivePath: string; encrypted: boolean }>
