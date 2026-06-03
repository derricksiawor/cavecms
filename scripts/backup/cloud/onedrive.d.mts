import type { CloudEntry } from './destination.mjs'
type Ctx = { token: { getAccessToken: (f?: boolean) => Promise<string> }; folderId?: string }
export function ensureFolder(ctx: Ctx): Promise<string>
export function upload(ctx: Ctx, localPath: string, remoteName: string, onProgress?: (s: number, t: number) => void): Promise<{ remoteId: string }>
export function list(ctx: Ctx): Promise<CloudEntry[]>
export function download(ctx: Ctx, remoteId: string, destPath: string, onProgress?: (s: number, t: number) => void): Promise<{ destPath: string }>
export function remove(ctx: Ctx, remoteId: string): Promise<void>
export function quota(ctx: Ctx): Promise<{ usedBytes: number | null; totalBytes: number | null } | null>
