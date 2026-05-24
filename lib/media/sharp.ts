import 'server-only'
import sharp from 'sharp'

// Cap sharp's internal cache + concurrency. Single image pipeline at
// a time — the upload route already serializes via busyToken, so
// raising concurrency only invites two malicious payloads to saturate
// libvips's worker pool simultaneously.
sharp.cache({ memory: 100 })
sharp.concurrency(1)

const WIDTHS = { thumb: 320, md: 768, lg: 1600 } as const
// Reject anything denser than 24 MP at decode time. Defends against
// bomb images that decode to multi-GB pixel buffers.
const LIMIT_INPUT_PIXELS = 24_000_000
// Per-pipeline timeout (sharp ≥ 0.32). Defends against legitimate-
// format heavy-pixel-work attacks — deeply tiled AVIF/HEIF, animated
// payloads with hundreds of frames, etc. The upload-route's 30s
// watchdog releases the busyToken; sharp's own timeout aborts the
// libvips pipeline so its worker doesn't keep churning past the
// release. 10s is generous for a 24MP single-frame resize.
const PIPELINE_TIMEOUT_MS = 10_000

export interface ProcessedImage {
  width: number
  height: number
  variants: { thumb: string; md: string; lg: string; og: string }
}

// Map sniffed MIME → sharp's `meta.format` string. Mismatch rejects the
// upload (defense against polyglot files: valid PNG header followed by
// HTML/zip/exe payload — file-type accepts the prefix, sharp decodes the
// pixel data, but the archived original carries arbitrary trailing bytes).
const MIME_TO_FORMAT: Record<string, string> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'heif', // sharp reports AVIF as 'heif' (libheif backend)
}

export class MimeFormatMismatchError extends Error {
  constructor(public readonly expected: string, public readonly actual: string) {
    super('mime_format_mismatch')
    this.name = 'MimeFormatMismatchError'
  }
}

/**
 * Decode → strip EXIF → auto-rotate → emit four variants under tmpDir.
 * Returns dimensions + the public URL paths for each variant. Caller
 * (route handler) renames the variants from tmpDir → /variants/<uuid>-*
 * atomically before writing the variants JSON to the DB.
 *
 *  - thumb (320w webp q82) — list views, lazy-loaded
 *  - md (768w webp q82) — body images on mobile + small cards
 *  - lg (1600w webp q82) — hero / detail / full-width on desktop
 *  - og (1200x630 jpg q86, cover) — Open Graph; jpg for cross-platform
 *
 * withMetadata({exif: {}}) clears EXIF (no GPS, no camera info) but
 * preserves color profile so the rendered output matches what the editor
 * uploaded. The first rotate() consumes EXIF Orientation so the
 * post-strip pipeline applies the rotation it implied.
 */
export async function processImage(
  buf: Buffer,
  tmpDir: string,
  uuid: string,
  sniffedMime: string,
): Promise<ProcessedImage> {
  const meta = await sharp(buf, { limitInputPixels: LIMIT_INPUT_PIXELS })
    .timeout({ seconds: Math.ceil(PIPELINE_TIMEOUT_MS / 1000) })
    .rotate()
    .metadata()
  if (!meta.width || !meta.height) throw new Error('bad_image')

  // Cross-check sharp's decoded format against the buffer-prefix sniff.
  // Mismatch = polyglot (file-type approved by prefix, sharp decoded by
  // a different codec). Reject before any file is written.
  const expectedFormat = MIME_TO_FORMAT[sniffedMime]
  if (!expectedFormat || meta.format !== expectedFormat) {
    throw new MimeFormatMismatchError(expectedFormat ?? sniffedMime, meta.format ?? 'unknown')
  }

  // sharp 0.33+: by default ALL metadata is stripped (EXIF, XMP, IPTC).
  // We explicitly keep ONLY the ICC color profile so rendered output
  // matches the editor's upload. Calling `.withMetadata(...)` would
  // PRESERVE everything (or write what we pass) — that's the opposite
  // of what we want for EXIF strip. .keepIccProfile() is the sharp 0.33
  // primitive for "preserve color, drop sensitive metadata".
  const base = sharp(buf, { limitInputPixels: LIMIT_INPUT_PIXELS })
    .timeout({ seconds: Math.ceil(PIPELINE_TIMEOUT_MS / 1000) })
    .rotate()
    .keepIccProfile()

  const outPath = (kind: string) => `${tmpDir}/${kind}.webp`
  for (const [name, w] of Object.entries(WIDTHS)) {
    await base
      .clone()
      .resize({ width: w, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(outPath(name))
  }
  const ogPath = `${tmpDir}/og.jpg`
  await base
    .clone()
    .resize({ width: 1200, height: 630, fit: 'cover' })
    .jpeg({ quality: 86 })
    .toFile(ogPath)

  return {
    width: meta.width,
    height: meta.height,
    variants: {
      thumb: `/uploads/variants/${uuid}-thumb.webp`,
      md: `/uploads/variants/${uuid}-md.webp`,
      lg: `/uploads/variants/${uuid}-lg.webp`,
      og: `/uploads/variants/${uuid}-og.jpg`,
    },
  }
}
