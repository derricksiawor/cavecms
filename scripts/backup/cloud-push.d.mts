import type { createDestination } from './cloud/destination.mjs'
export function pushToCloud(a: { archivePath: string; env?: Record<string, string | undefined>; createDest?: typeof createDestination }): Promise<{ remoteName: string; sha256: string; sizeBytes: number; encrypted: boolean }>
