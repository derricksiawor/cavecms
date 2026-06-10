import 'server-only'
import { HttpError } from '@/lib/auth/requireRole'

// Request-size backstop for CMS routes. This is NOT a content limit — it's
// raised high enough (16 MB) that no real page, legal doc, or long article in a
// single block ever approaches it; it exists only so a pathological/hostile
// payload (deeply-nested adversarial structure, runaway upload) can't OOM the
// server or blow the JSON column write limit. Per-field content caps were
// removed (see lib/cms/limits.ts) — operators write as much as they want.
const MAX_JSON_BYTES = 16 * 1024 * 1024

/**
 * Reads the request body as JSON with two guards on top of req.json():
 *   1. content-length header (if present) must be <= MAX_JSON_BYTES.
 *      Cheap reject before buffering — clients can lie but a truthful
 *      one saves us the read.
 *   2. Post-read byte length check on the buffered body. The byteLength
 *      cast catches multi-byte UTF-8 inflating past the cap even when
 *      content-length was under it.
 * Throws HttpError(413, 'body_too_large') on overflow; HttpError(400,
 * 'invalid_json') on parse failure.
 */
export async function readJsonBody(req: Request): Promise<unknown> {
  const declared = Number(req.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
    throw new HttpError(413, 'body_too_large')
  }
  const text = await req.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) {
    throw new HttpError(413, 'body_too_large')
  }
  try {
    return text.length === 0 ? null : JSON.parse(text)
  } catch {
    throw new HttpError(400, 'invalid_json')
  }
}

export { MAX_JSON_BYTES }
