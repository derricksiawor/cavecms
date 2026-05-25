import 'server-only'
import { getSetting } from './getSettings'

// Single source of truth for the operator's public site URL —
// stored in `settings.site_general.siteUrl`, configured via
// Settings → General in the dashboard.
//
// CaveCMS is a general-purpose CMS, so we DO NOT hard-default to
// any specific origin (CaveCMS's customer site, the project's own
// staging URL, etc.). On a freshly-installed instance with no
// site_general row, this returns `null` and callers handle the
// missing-URL case:
//
//   - sitemap.xml / robots.txt: return empty or short-circuit
//     (the operator hasn't told us their public address yet)
//   - JSON-LD `url` fields: emit relative URLs only
//   - Outbound emails (update notifications, password reset,
//     newsletter confirm): skip the send with an audit_log entry
//     so the operator can see what happened
//
// Operators see a top-of-dashboard prompt to set their Site URL on
// first login until they fill it in — same UX as WordPress's
// "Welcome to WordPress, please enter your Site Address" wizard.

export async function getSiteOrigin(): Promise<string | null> {
  const cfg = await getSetting('site_general')
  return cfg.siteUrl ?? null
}

/**
 * Same as `getSiteOrigin` but throws on missing — for callers that
 * cannot operate without an absolute URL (mostly outbound emails).
 */
export async function getSiteOriginOrThrow(): Promise<string> {
  const origin = await getSiteOrigin()
  if (!origin) {
    throw new Error('site_url_not_configured')
  }
  return origin
}

/** Site display name, for email subject lines, etc. Falls back to "CaveCMS". */
export async function getSiteName(): Promise<string> {
  const cfg = await getSetting('site_general')
  return cfg.siteName?.trim() || 'CaveCMS'
}
