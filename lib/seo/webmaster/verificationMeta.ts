import 'server-only'
import type { SettingsValue } from '@/lib/cms/settings-registry'

// The `seo_webmaster` settings value shape: { google?, bing?, yandex?,
// pinterest?, baidu?, naver? } — each an optional, charset-restricted
// (token-safe) ownership-verification code. Imported from the registry's
// generated SettingsValue map so this helper stays in lock-step with the
// schema (no parallel hand-maintained interface to drift).
export type SeoWebmasterValue = SettingsValue<'seo_webmaster'>

export interface VerificationMeta {
  name: string
  content: string
}

// Exact <meta name="…"> attribute each search engine expects for
// HTML-tag site-ownership verification. These names are dictated by the
// respective webmaster consoles and are NOT interchangeable.
const META_NAME: Record<keyof SeoWebmasterValue, string> = {
  google: 'google-site-verification',
  bing: 'msvalidate.01',
  yandex: 'yandex-verification',
  pinterest: 'p:domain_verify',
  baidu: 'baidu-site-verification',
  naver: 'naver-site-verification',
}

// Stable emission order (matches the schema field order).
const KEYS: Array<keyof SeoWebmasterValue> = [
  'google',
  'bing',
  'yandex',
  'pinterest',
  'baidu',
  'naver',
]

// Map each NON-EMPTY verification code to its exact meta { name, content }.
// Empty / undefined codes are skipped so we never emit a content="" tag
// (an empty verification tag is meaningless and can confuse some
// consoles). The code charset is already locked by the registry schema
// (verificationCode regex), so the content is attribute-safe; callers
// that build raw markup should still escape defensively.
export function buildVerificationMetas(
  w: SeoWebmasterValue,
): VerificationMeta[] {
  const out: VerificationMeta[] = []
  for (const key of KEYS) {
    const code = w[key]
    if (typeof code === 'string' && code.length > 0) {
      out.push({ name: META_NAME[key], content: code })
    }
  }
  return out
}
