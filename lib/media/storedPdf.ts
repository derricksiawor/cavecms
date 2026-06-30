import 'server-only'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { PATHS } from './storage'

// Shared resolution of a gated PDF stored in brochures-private. Owns the
// security guards (uuid shape + soft-delete + pdf-mime) and the readable
// download-name logic that BOTH the HTTP delivery route
// (app/api/files/deliver/[token]) and the email-attachment path
// (lib/email/queue + the lx_form deliver_file `attach` mode) rely on, so
// those guards live in exactly one place.

// media.filename_uuid is assigned by the upload pipeline and is always
// [A-Za-z0-9._-]; this regex is belt-and-braces against a hypothetical INSERT
// bypass that wrote `..` or `/` into the column. Mismatch → refuse, never read.
export const FILENAME_OK = /^[A-Za-z0-9._-]{1,80}$/

// Cap on a streamed download (the HTTP route). A misconfigured 2GB PDF burns
// bandwidth on every redemption (no-store, so no CDN help). 50MB matches the
// historical brochure cap.
export const MAX_DELIVER_FILE_BYTES = 50 * 1024 * 1024

// Cap on an EMAIL ATTACHMENT. Far smaller than the streamed cap — a 10MB PDF
// base64-encodes to ~13.6MB on the wire, which is the practical ceiling many
// SMTP relays accept. A file above this is delivered as a secure link instead
// (the lx_form deliver_file `attach` mode degrades gracefully to `email`).
export const MAX_EMAIL_ATTACHMENT_BYTES = 10 * 1024 * 1024

// A readable, safe download filename from the operator-uploaded original_name:
// strip to an ASCII slug, force a .pdf extension, fall back to download.pdf.
export function safeDownloadName(original: string | null): string {
  const base = (original ?? '')
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9._ -]/g, '')
    .trim()
    .slice(0, 80)
  return (base || 'download') + '.pdf'
}

/** The absolute on-disk path for a stored PDF's filename_uuid. */
export function storedPdfPath(filenameUuid: string): string {
  return path.join(PATHS.brochures, `${filenameUuid}.pdf`)
}

export interface StoredPdfMeta {
  filenameUuid: string
  mimeType: string
  byteSize: number
  originalName: string | null
}

// Why a stored PDF can't be used, in priority order. `missing` covers an
// unknown id, a soft-deleted row, or a tampered filename_uuid; `not_pdf` a
// non-application/pdf mime; `oversized` a byte_size over the supplied cap.
export type StoredPdfReason = 'missing' | 'not_pdf' | 'oversized'

export type StoredPdfCheck =
  | { ok: true; meta: StoredPdfMeta }
  | { ok: false; reason: StoredPdfReason; byteSize?: number }

/**
 * Metadata-only check (NO filesystem read). Resolves the media row and
 * validates it is a live PDF within `maxBytes`. Used on the request path
 * (lx_form submit) to decide attach-vs-link without paying an fs.stat — the
 * actual file read is deferred to send time (buildPdfAttachment).
 */
export async function checkStoredPdf(
  mediaId: number,
  maxBytes: number,
): Promise<StoredPdfCheck> {
  if (!Number.isInteger(mediaId) || mediaId <= 0) {
    return { ok: false, reason: 'missing' }
  }
  const [rows] = (await db.execute(sql`
    SELECT filename_uuid, mime_type, byte_size, original_name
    FROM media
    WHERE id = ${mediaId}
      AND deleted_at IS NULL
  `)) as unknown as [
    Array<{
      filename_uuid: string
      mime_type: string
      byte_size: number
      original_name: string | null
    }>,
  ]
  const m = rows[0]
  if (!m || !FILENAME_OK.test(m.filename_uuid)) return { ok: false, reason: 'missing' }
  if (m.mime_type !== 'application/pdf') return { ok: false, reason: 'not_pdf' }
  const byteSize = Number(m.byte_size)
  if (!Number.isFinite(byteSize) || byteSize > maxBytes) {
    return { ok: false, reason: 'oversized', byteSize }
  }
  return {
    ok: true,
    meta: {
      filenameUuid: m.filename_uuid,
      mimeType: m.mime_type,
      byteSize,
      originalName: m.original_name,
    },
  }
}

export interface PdfAttachment {
  filename: string
  path: string
  contentType: 'application/pdf'
  contentDisposition: 'attachment'
}

/**
 * Send-time resolution: re-validates the media row AND stat()s the file on
 * disk, returning a nodemailer attachment descriptor (streamed from `path`,
 * never buffered). Returns null when the file can't be attached — a
 * soft-delete, an oversized row, or a vanished/oversized file on disk — so the
 * caller can degrade (send without the attachment) instead of throwing.
 */
export async function buildPdfAttachment(
  mediaId: number,
): Promise<PdfAttachment | null> {
  const check = await checkStoredPdf(mediaId, MAX_EMAIL_ATTACHMENT_BYTES)
  if (!check.ok) return null
  const filePath = storedPdfPath(check.meta.filenameUuid)
  let stats
  try {
    stats = await stat(filePath)
  } catch {
    return null
  }
  // The on-disk size is authoritative — guard against a byte_size column that
  // drifted from the real file (e.g. a partial write the row never reflected).
  if (stats.size > MAX_EMAIL_ATTACHMENT_BYTES) return null
  return {
    filename: safeDownloadName(check.meta.originalName),
    path: filePath,
    contentType: 'application/pdf',
    contentDisposition: 'attachment',
  }
}
