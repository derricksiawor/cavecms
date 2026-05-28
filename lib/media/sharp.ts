import 'server-only'
import sharp from 'sharp'

// Cap sharp's internal cache + concurrency. Single image pipeline at
// a time — the upload route already serializes via busyToken, so
// raising concurrency only invites two malicious payloads to saturate
// libvips's worker pool simultaneously.
sharp.cache({ memory: 100 })
sharp.concurrency(1)

// Variant widths. `lg` is the variant the public hero/cover renderers
// pull (LxCoverImage + LxFigure default to `variant="lg"`). Bumped from
// 1600 → 2400 in the premium-template pass — at 1600px wide, screen-
// height covers on 4K / Retina monitors looked softened/compressed.
// 2400 paired with q88 lands near print-quality without ballooning
// page weight beyond what a luxury template earns.
const WIDTHS = { thumb: 320, md: 768, lg: 2400 } as const
// Reject anything denser than 24 MP at decode time. Defends against
// bomb images that decode to multi-GB pixel buffers.
const LIMIT_INPUT_PIXELS = 24_000_000
// Per-pipeline timeout (sharp ≥ 0.32). Defends against legitimate-
// format heavy-pixel-work attacks — deeply tiled AVIF/HEIF, animated
// payloads with hundreds of frames, etc. The upload-route's 30s
// watchdog releases the busyToken; sharp's own timeout aborts the
// libvips pipeline so its worker doesn't keep churning past the
// release.
//
// Two regimes:
//   PIPELINE_TIMEOUT_MS — upload-route default. User is waiting; a
//     legit user complaining is better than a 1-minute hang. 10s is
//     generous for a 24MP single-frame resize on production hardware.
//   PIPELINE_TIMEOUT_RELEASE_MS — release builder. Publisher box may
//     be a laptop under battery, cold libvips cache, network hiccups.
//     30s prevents one slow image from bricking a release build for
//     the wrong reason.
const PIPELINE_TIMEOUT_MS = 10_000
const PIPELINE_TIMEOUT_RELEASE_MS = 30_000

export interface ProcessedImage {
  width: number
  height: number
  variants: { thumb: string; md: string; lg: string; og: string }
}

export interface ProcessedVariants {
  width: number
  height: number
  /** Absolute filesystem paths the variants were written to. */
  paths: { thumb: string; md: string; lg: string; og: string }
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
 * Decode the buffer, EXIF-rotate, mime/format cross-check, and return
 * the post-rotate base sharp instance + dimensions ready for resize.
 * Shared by processImage() (upload path) + processToVariants() (release
 * bundler) so the validation + decode pipeline cannot diverge.
 */
async function decodeAndPrepare(
  buf: Buffer,
  sniffedMime: string,
  timeoutMs: number,
): Promise<{ base: sharp.Sharp; width: number; height: number }> {
  const meta = await sharp(buf, { limitInputPixels: LIMIT_INPUT_PIXELS })
    .timeout({ seconds: Math.ceil(timeoutMs / 1000) })
    .rotate()
    .metadata()
  if (!meta.width || !meta.height) throw new Error('bad_image')

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
    .timeout({ seconds: Math.ceil(timeoutMs / 1000) })
    .rotate()
    .keepIccProfile()

  return { base, width: meta.width, height: meta.height }
}

/**
 * Internal: write the four variants (thumb/md/lg.webp + og.jpg) to
 * an arbitrary set of destination paths. Both processImage() and
 * processToVariants() route through here so the encoder settings stay
 * unified.
 */
async function emitVariants(
  base: sharp.Sharp,
  outPaths: { thumb: string; md: string; lg: string; og: string },
): Promise<void> {
  for (const [name, w] of Object.entries(WIDTHS) as Array<[keyof typeof WIDTHS, number]>) {
    // q88 for hero/cover-sized variants (lg), q82 for thumb/md where the
    // pixel count is small enough that the operator never perceives the
    // difference. lg at q82 was the "compressed" tell on premium
    // templates — q88 adds ~25 % file size, removes the artifact.
    const quality = name === 'lg' ? 88 : 82
    await base
      .clone()
      .resize({ width: w, withoutEnlargement: true })
      .webp({ quality })
      .toFile(outPaths[name])
  }
  await base
    .clone()
    .resize({ width: 1200, height: 630, fit: 'cover' })
    .jpeg({ quality: 86 })
    .toFile(outPaths.og)
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
  const { base, width, height } = await decodeAndPrepare(
    buf,
    sniffedMime,
    PIPELINE_TIMEOUT_MS,
  )

  await emitVariants(base, {
    thumb: `${tmpDir}/thumb.webp`,
    md: `${tmpDir}/md.webp`,
    lg: `${tmpDir}/lg.webp`,
    og: `${tmpDir}/og.jpg`,
  })

  return {
    width,
    height,
    variants: {
      thumb: `/uploads/variants/${uuid}-thumb.webp`,
      md: `/uploads/variants/${uuid}-md.webp`,
      lg: `/uploads/variants/${uuid}-lg.webp`,
      og: `/uploads/variants/${uuid}-og.jpg`,
    },
  }
}

/**
 * Release-bundler variant of processImage. Used by
 * scripts/release/build-template-media.mjs to pre-process bundled
 * stock imagery at release-build time. Writes directly to the final
 * named files (no tmp+rename — the release dist tree is the final
 * artifact). Identical decode + validate + encode pipeline so customer
 * installs receive variants byte-identical to what they'd get from a
 * direct upload to their Media Library.
 *
 *   processToVariants(buf, '/dist/template-media/hotel-solenne/variants/',
 *                     'hero-exterior', 'image/jpeg')
 *   → writes:
 *       hero-exterior-thumb.webp
 *       hero-exterior-md.webp
 *       hero-exterior-lg.webp
 *       hero-exterior-og.jpg
 *
 * outDir must already exist (caller's responsibility — release scripts
 * provision the dist tree).
 */
export async function processToVariants(
  buf: Buffer,
  outDir: string,
  baseFilename: string,
  sniffedMime: string,
): Promise<ProcessedVariants> {
  // Release-time pipeline gets the longer timeout — publisher boxes
  // are higher-variance than production servers, and one slow image
  // shouldn't brick a release build.
  const { base, width, height } = await decodeAndPrepare(
    buf,
    sniffedMime,
    PIPELINE_TIMEOUT_RELEASE_MS,
  )

  const paths = {
    thumb: `${outDir}/${baseFilename}-thumb.webp`,
    md: `${outDir}/${baseFilename}-md.webp`,
    lg: `${outDir}/${baseFilename}-lg.webp`,
    og: `${outDir}/${baseFilename}-og.jpg`,
  }
  await emitVariants(base, paths)
  return { width, height, paths }
}
