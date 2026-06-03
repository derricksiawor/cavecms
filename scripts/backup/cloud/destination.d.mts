export const CHUNK_BYTES: number
export function chunkSize(): number
export function makeTokenProvider(a: { provider: string; clientId: string; clientSecret?: string; refreshToken: string; onRotate?: (rt: string) => void }): { getAccessToken: (force?: boolean) => Promise<string>; getRefreshToken: () => string }
export function clearAccessTokenCache(provider?: string): void
export function fetchRetry(url: string, opts?: Record<string, unknown>, cfg?: { attempts?: number; timeoutMs?: number }): Promise<{ status: number; ok: boolean; headers: { get: (k: string) => string | null }; json: () => Promise<unknown>; body?: unknown }>
export function readChunk(fh: unknown, start: number, len: number): Promise<Buffer>
export function withOpenFile<T>(path: string, fn: (fh: unknown) => Promise<T>): Promise<T>
export interface CloudEntryMeta { version: string; createdAt: string | null; encrypted: boolean; includeEnv: boolean; migratorEncoding: string }
export interface CloudEntry { remoteId: string; name: string; sizeBytes: number; createdAt: string | null; meta?: CloudEntryMeta }
export interface UploadOpts { appProperties?: Record<string, string> }
export interface Destination {
  provider: string
  getRefreshToken: () => string
  getFolderId: () => string | undefined
  ensureFolder: () => Promise<string>
  upload: (localPath: string, remoteName: string, onProgress?: (sent: number, total: number) => void, opts?: UploadOpts) => Promise<{ remoteId: string }>
  list: () => Promise<CloudEntry[]>
  download: (remoteId: string, destPath: string, onProgress?: (sent: number, total: number) => void) => Promise<{ destPath: string }>
  delete: (remoteId: string) => Promise<void>
  quota: () => Promise<{ usedBytes: number | null; totalBytes: number | null } | null>
}
export function createDestination(a: { provider: string; clientId: string; clientSecret?: string; refreshToken: string; folderId?: string; onRotate?: (rt: string) => void }): Destination

export function sha256FileStream(path: string): Promise<string>
