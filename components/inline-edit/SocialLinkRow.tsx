'use client'
import { useState } from 'react'
import clsx from 'clsx'
import { Input } from '@/components/ui/Input'

// Preset list of known social platforms. The first match (case-insensitive
// substring on host or platform name) drives the icon + placeholder.
// "Other" is the fallback that lets the editor type any custom platform
// name when none of the presets fit.
export const SOCIAL_PRESETS = [
  { value: 'Instagram', host: 'instagram.com', placeholder: 'https://instagram.com/yourhandle' },
  { value: 'Facebook', host: 'facebook.com', placeholder: 'https://facebook.com/yourpage' },
  { value: 'LinkedIn', host: 'linkedin.com', placeholder: 'https://linkedin.com/company/yourbrand' },
  { value: 'YouTube', host: 'youtube.com', placeholder: 'https://youtube.com/@yourchannel' },
  { value: 'TikTok', host: 'tiktok.com', placeholder: 'https://tiktok.com/@yourhandle' },
  { value: 'X (Twitter)', host: 'x.com', placeholder: 'https://x.com/yourhandle' },
  { value: 'Pinterest', host: 'pinterest.com', placeholder: 'https://pinterest.com/yourbrand' },
  { value: 'Threads', host: 'threads.net', placeholder: 'https://threads.net/@yourhandle' },
] as const

export interface SocialLinkValue {
  platform: string
  url: string
}

export function SocialLinkRow({
  value,
  onChange,
}: {
  value: SocialLinkValue
  onChange: (v: SocialLinkValue) => void
}) {
  const preset = SOCIAL_PRESETS.find(
    (p) =>
      p.value.toLowerCase() === value.platform.trim().toLowerCase() ||
      (value.url && value.url.toLowerCase().includes(p.host)),
  )
  const [custom, setCustom] = useState(!preset && value.platform.trim().length > 0)

  const hostValid =
    value.url === '' || /^https:\/\/.+/i.test(value.url)
  const platformMatchesUrl =
    !preset ||
    value.url === '' ||
    value.url.toLowerCase().includes(preset.host)

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[200px_1fr] gap-3 items-start">
      <div>
        <label className="text-[11px] font-medium uppercase tracking-[0.18em] text-warm-stone">
          Platform
        </label>
        <div className="mt-1.5">
          {!custom ? (
            <PlatformSelect
              value={preset?.value ?? value.platform}
              onChange={(v) => {
                if (v === '__custom__') {
                  setCustom(true)
                  onChange({ ...value, platform: '' })
                } else {
                  onChange({ ...value, platform: v })
                }
              }}
            />
          ) : (
            <div className="flex gap-2">
              <Input
                value={value.platform}
                onChange={(e) => onChange({ ...value, platform: e.target.value })}
                placeholder="Custom platform"
                maxLength={40}
              />
              <button
                type="button"
                onClick={() => {
                  setCustom(false)
                  onChange({ ...value, platform: '' })
                }}
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-warm-stone/25 text-warm-stone hover:border-copper-400 hover:text-copper-700 transition-colors"
                title="Use a preset"
                aria-label="Use preset"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <polyline points="9 11 12 14 22 4" />
                  <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                </svg>
              </button>
            </div>
          )}
        </div>
      </div>
      <div>
        <label className="text-[11px] font-medium uppercase tracking-[0.18em] text-warm-stone">
          Profile URL
        </label>
        <div className="mt-1.5 flex gap-2 items-start">
          <span
            className={clsx(
              'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border bg-cream-50 transition-colors',
              preset ? 'border-copper-300/60 text-copper-700' : 'border-warm-stone/25 text-warm-stone',
            )}
            aria-hidden
          >
            <PlatformIcon value={preset?.value ?? value.platform} />
          </span>
          <div className="flex-1">
            <Input
              type="url"
              value={value.url}
              onChange={(e) => onChange({ ...value, url: e.target.value })}
              placeholder={preset?.placeholder ?? 'https://…'}
              maxLength={500}
            />
            {!hostValid && (
              <p className="mt-1 text-[11px] text-red-600">
                URL must start with https://
              </p>
            )}
            {hostValid && !platformMatchesUrl && preset && (
              <p className="mt-1 text-[11px] text-copper-700">
                Tip: this URL doesn’t look like a {preset.value} link.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function PlatformSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="relative">
      <select
        value={SOCIAL_PRESETS.some((p) => p.value === value) ? value : '__custom__'}
        onChange={(e) => onChange(e.target.value)}
        className="w-full appearance-none rounded-xl border border-warm-stone/25 bg-cream-50/80 px-4 py-3 pr-10 text-sm text-near-black transition-all hover:border-warm-stone/40 focus:border-copper-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-copper-300/40 min-h-[44px]"
      >
        <option value="" disabled hidden>
          Choose a platform…
        </option>
        {SOCIAL_PRESETS.map((p) => (
          <option key={p.value} value={p.value}>
            {p.value}
          </option>
        ))}
        <option value="__custom__">Other (custom)…</option>
      </select>
      <span aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-warm-stone">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </span>
    </div>
  )
}

export function PlatformIcon({ value }: { value: string }) {
  const k = value.toLowerCase()
  if (k.includes('instagram')) {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="3" y="3" width="18" height="18" rx="5" />
        <circle cx="12" cy="12" r="4" />
        <circle cx="17.5" cy="6.5" r="0.8" fill="currentColor" />
      </svg>
    )
  }
  if (k.includes('facebook')) {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M13 22v-8h3l.5-4H13V7.5c0-1.1.3-1.9 2-1.9h2V2.1C16.5 2 15.5 2 14.5 2 12 2 10 3.5 10 6.5V10H7v4h3v8z" />
      </svg>
    )
  }
  if (k.includes('linkedin')) {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M4 4h4v4H4zM4 10h4v10H4zM10 10h3.5v1.7c.7-1.2 2-1.9 3.5-1.9 3 0 4 2 4 5V20H17v-4.5c0-1.3-.4-2.5-2-2.5s-2 1.2-2 2.5V20h-3z" />
      </svg>
    )
  }
  if (k.includes('youtube')) {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M22 7s-.2-1.4-.8-2c-.7-.8-1.6-.8-2-.9C16 4 12 4 12 4s-4 0-7.2.1c-.4 0-1.3 0-2 .9C2.2 5.6 2 7 2 7S1.8 8.6 1.8 10.2v1.6C1.8 13.4 2 15 2 15s.2 1.4.8 2c.7.8 1.7.8 2.1.9 1.5.2 6.6.2 6.6.2s4 0 7.2-.2c.4-.1 1.3-.1 2-.9.6-.6.8-2 .8-2s.2-1.6.2-3.2v-1.6C22.2 8.6 22 7 22 7zM10 14V8l5 3z" />
      </svg>
    )
  }
  if (k.includes('tiktok')) {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M19 8.7a6.5 6.5 0 0 1-4-1.3v7.2A5.4 5.4 0 1 1 9.6 9.2v3a2.4 2.4 0 1 0 1.7 2.3V2h2.7A4.4 4.4 0 0 0 19 6z" />
      </svg>
    )
  }
  if (k.includes('twitter') || k === 'x' || k.includes('(twitter)')) {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M17 3h3.5l-7.6 8.7L22 21h-6.9l-5.4-7-6.2 7H0l8.1-9.3L0 3h7.1l4.9 6.4zm-1.2 16h1.9L6.3 5H4.3z" />
      </svg>
    )
  }
  if (k.includes('pinterest')) {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M12 2a10 10 0 0 0-3.6 19.3c-.1-.8-.2-2 0-2.8.2-.7 1.2-4.7 1.2-4.7s-.3-.6-.3-1.5c0-1.5.8-2.6 1.9-2.6.9 0 1.3.7 1.3 1.5 0 .9-.6 2.2-.9 3.5-.2 1 .5 1.9 1.6 1.9 1.9 0 3.4-2 3.4-5 0-2.6-1.9-4.4-4.5-4.4-3.1 0-4.9 2.3-4.9 4.7 0 .9.4 1.9.8 2.5l.1.4c-.1.3-.2 1-.3 1.1 0 .2-.2.2-.4.1-1.4-.7-2.3-2.8-2.3-4.5 0-3.6 2.6-7 7.6-7 4 0 7.1 2.8 7.1 6.6 0 4-2.5 7.2-6 7.2-1.2 0-2.3-.6-2.7-1.4l-.7 2.8c-.3 1-1 2.3-1.5 3A10 10 0 1 0 12 2z" />
      </svg>
    )
  }
  if (k.includes('threads')) {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M12 2a10 10 0 0 1 10 10c0 5.5-4 10-10 10S2 17.5 2 12 6.5 2 12 2zm3.5 13.5c1-.7 1.5-1.6 1.5-2.7 0-2.5-2-3.5-4.4-3.7C14 8.7 14.5 8 15.7 8c.8 0 1.4.3 1.8 1L18.5 8c-.7-1.3-2-2-3.8-2-2.5 0-4 1.4-4.1 3.6h.2c1.2-1 2.6-1.5 4.1-1.4 1 .1 1.8.6 2 1.4-1.5-.5-3-.4-4 .3-.9.5-1.4 1.3-1.4 2.2.1 1.6 1.3 2.6 3 2.6 1 0 2-.5 2.5-1.3 0 .9-.3 1.7-.7 2.2-1 1.1-3 1.4-4.4.6-1.5-.9-2.4-2.5-2.4-4.7 0-4 2.5-6 6.8-6 1.4 0 2.6.4 3.5 1.1l.2.2-1 1c-.1 0-.1-.1-.2-.2-.6-.5-1.5-.8-2.5-.8-2.5 0-3.6 1.3-3.6 3.4 0 1.5.5 2.6 1.4 3.1.7.4 1.7.2 2-.3z" />
      </svg>
    )
  }
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" />
    </svg>
  )
}
