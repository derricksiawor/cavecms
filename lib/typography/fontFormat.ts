/**
 * Magic-byte font sniffing for the upload endpoint. NEVER trust the
 * filename/extension a client sends — detect the real format from the
 * file's signature, exactly as the media pipeline sniffs images.
 *
 * PURE module (no server-only) so it can be unit-tested.
 */

import type { FontFileFormat } from './customFonts'
import { CSS_FONT_FORMAT } from './customFonts'

export interface SniffedFont {
  format: FontFileFormat
  ext: string
  mime: string
  cssFormat: string
}

const MIME: Record<FontFileFormat, string> = {
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
}

function tag(buf: Buffer, len = 4): string {
  return buf.length >= len ? buf.toString('latin1', 0, len) : ''
}

/**
 * Returns the detected font format, or null if the bytes aren't a font we
 * accept. Order matters (woff2/woff/otf have ASCII tags; ttf is a version
 * number or one of two tags).
 */
export function sniffFontFormat(buf: Buffer): SniffedFont | null {
  if (buf.length < 4) return null
  const t = tag(buf)
  let format: FontFileFormat | null = null

  if (t === 'wOF2') format = 'woff2'
  else if (t === 'wOFF') format = 'woff'
  else if (t === 'OTTO') format = 'otf'
  else if (
    // TrueType: 0x00010000 version, or the 'true'/'ttcf' tags.
    (buf[0] === 0x00 && buf[1] === 0x01 && buf[2] === 0x00 && buf[3] === 0x00) ||
    t === 'true' ||
    t === 'ttcf'
  ) {
    format = 'ttf'
  }

  if (!format) return null
  return { format, ext: `.${format}`, mime: MIME[format], cssFormat: CSS_FONT_FORMAT[format] }
}
