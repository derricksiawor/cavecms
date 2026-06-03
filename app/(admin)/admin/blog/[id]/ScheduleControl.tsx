'use client'

import { useId } from 'react'
import { Eye, EyeOff, Clock, CalendarClock } from 'lucide-react'
import { derivePostStatus, type PostStatus } from '@/lib/cms/postStatus'

// Phase 8 (blog-system worktree): the post publish + SCHEDULE control. Replaces
// the bare "Show on the public blog" switch with a three-state segmented control
// — Draft · Publish now · Schedule — plus a premium datetime picker that appears
// when scheduling. It drives the editor's `published` boolean AND an explicit
// `publishedAt` ISO string (the value the PATCH admin schema honours to set a
// FUTURE published_at). The derived status pill (Draft / Scheduled / Published)
// reflects exactly what the public will see.
//
// State contract (owned by the parent Editor):
//   - published: boolean — the publish flag the PATCH sends.
//   - scheduledAtIso: string | null — when the operator picks a FUTURE time,
//     this is the explicit instant; null means "publish at save time / now".
// The parent decides what to send: when scheduledAtIso is in the future it goes
// out as `publishedAt`; "Publish now" clears it so the server stamps NOW().

export type PublishMode = 'draft' | 'now' | 'schedule'

// Local datetime <-> ISO helpers. <input type="datetime-local"> works in the
// browser's LOCAL timezone with NO offset; we convert to/from a UTC ISO string
// (what the server stores + the API expects) so the operator picks "3pm my time"
// and the post goes live at 3pm their time.
function isoToLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  // Shift by the local tz offset so toISOString().slice gives the LOCAL wall
  // clock in the yyyy-MM-ddTHH:mm shape datetime-local wants.
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function localInputToIso(local: string): string | null {
  if (!local) return null
  // datetime-local has no tz → new Date(local) interprets it as LOCAL time,
  // which is what we want; toISOString() then yields the correct UTC instant.
  const d = new Date(local)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

// Smallest selectable minute = now (rounded to the minute) so the picker can't
// offer an obviously-past slot. Recomputed on render (cheap).
function nowLocalInputMin(): string {
  const d = new Date()
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function statusPill(status: PostStatus): { label: string; cls: string } {
  switch (status) {
    case 'published':
      return {
        label: 'Published',
        cls: 'bg-copper-500 text-cream-50',
      }
    case 'scheduled':
      return {
        label: 'Scheduled',
        cls: 'bg-near-black text-cream-50',
      }
    default:
      return {
        label: 'Draft',
        cls: 'border border-warm-stone/30 text-warm-stone',
      }
  }
}

export function ScheduleControl({
  published,
  scheduledAtIso,
  onChange,
  disabled = false,
}: {
  published: boolean
  /** Explicit publish instant (ISO) when scheduling for the future, else null. */
  scheduledAtIso: string | null
  /** Emits the next (published, scheduledAtIso) pair. The parent persists it. */
  onChange: (next: { published: boolean; scheduledAtIso: string | null }) => void
  disabled?: boolean
}) {
  const fieldId = useId()

  // Mode derives from the controlled state: a future scheduledAtIso → schedule;
  // published with no future date → now; not published → draft.
  const isFutureSchedule =
    scheduledAtIso !== null && new Date(scheduledAtIso).getTime() > Date.now()
  const mode: PublishMode = !published
    ? 'draft'
    : isFutureSchedule
      ? 'schedule'
      : 'now'

  // The status pill mirrors what the PUBLIC sees, computed from the same derive
  // helper the admin list + public gate use. For the "schedule" mode preview we
  // feed the chosen instant as published_at so a future pick reads "Scheduled";
  // for "publish now" (published, no future date) we feed the EFFECTIVE
  // published_at the server stamps (NOW) instead of null — after F7 a null
  // published_at on a published row derives to 'draft', so passing now keeps the
  // "Published" preview accurate.
  const previewStatus: PostStatus = derivePostStatus({
    published,
    published_at: published ? (scheduledAtIso ?? new Date()) : null,
    deleted_at: null,
  })
  const pill = statusPill(previewStatus)

  const pickMode = (next: PublishMode) => {
    if (disabled) return
    if (next === 'draft') {
      onChange({ published: false, scheduledAtIso: null })
    } else if (next === 'now') {
      onChange({ published: true, scheduledAtIso: null })
    } else {
      // Switching INTO schedule: seed a default ~1 hour out if no future date
      // is set yet, so the picker opens on a sensible, valid slot.
      const seed =
        isFutureSchedule && scheduledAtIso
          ? scheduledAtIso
          : new Date(Date.now() + 60 * 60_000).toISOString()
      onChange({ published: true, scheduledAtIso: seed })
    }
  }

  const segs: Array<{ value: PublishMode; label: string; icon: typeof Eye }> = [
    { value: 'draft', label: 'Draft', icon: EyeOff },
    { value: 'now', label: 'Publish now', icon: Eye },
    { value: 'schedule', label: 'Schedule', icon: CalendarClock },
  ]

  return (
    <div className="rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
          Visibility
        </span>
        <span
          className={`inline-flex items-center rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] ${pill.cls}`}
        >
          {pill.label}
        </span>
      </div>

      {/* Segmented control — visual, three-state (#0.59: a real picker, not a
          <select> of state names). Active segment is copper-filled. */}
      <div
        role="radiogroup"
        aria-label="Post visibility"
        className="mt-3 grid grid-cols-3 gap-1.5 rounded-xl border border-warm-stone/20 bg-white/60 p-1"
      >
        {segs.map((s) => {
          const active = mode === s.value
          const Icon = s.icon
          return (
            <button
              key={s.value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => pickMode(s.value)}
              className={[
                'inline-flex min-w-0 items-center justify-center gap-1.5 rounded-lg px-1.5 py-2 text-[11px] font-semibold tracking-wide transition-all duration-quick disabled:opacity-50',
                active
                  ? 'bg-copper-500 text-cream-50 shadow-[0_6px_16px_-8px_rgba(184,115,51,0.7)]'
                  : 'text-near-black/70 hover:bg-cream-50 hover:text-copper-700',
              ].join(' ')}
            >
              <Icon size={14} strokeWidth={2.2} className="shrink-0" aria-hidden />
              <span className="hidden whitespace-nowrap sm:inline">{s.label}</span>
            </button>
          )
        })}
      </div>

      {/* Schedule picker — only when scheduling. Premium datetime field with a
          copper focus ring + a clock affordance + a live "goes live" line. */}
      {mode === 'schedule' && (
        <div className="mt-4 animate-cavecms-fade-in">
          <label
            htmlFor={`${fieldId}-dt`}
            className="text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone"
          >
            Go live on
          </label>
          <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-warm-stone/25 bg-white/80 px-3 py-2.5 focus-within:border-copper-400 focus-within:ring-2 focus-within:ring-copper-300/40">
            <Clock
              size={16}
              strokeWidth={2}
              className="shrink-0 text-copper-600"
              aria-hidden
            />
            <input
              id={`${fieldId}-dt`}
              type="datetime-local"
              disabled={disabled}
              min={nowLocalInputMin()}
              value={isoToLocalInput(scheduledAtIso)}
              onChange={(e) => {
                const iso = localInputToIso(e.target.value)
                // An empty/cleared field falls back to "publish now".
                if (iso === null) {
                  onChange({ published: true, scheduledAtIso: null })
                } else {
                  onChange({ published: true, scheduledAtIso: iso })
                }
              }}
              className="w-full bg-transparent text-sm text-near-black focus:outline-none disabled:opacity-50"
            />
          </div>
          <p className="mt-1.5 text-[11px] text-warm-stone">
            {previewStatus === 'scheduled' && scheduledAtIso ? (
              <>
                Hidden until{' '}
                <span className="font-semibold text-near-black">
                  {new Date(scheduledAtIso).toLocaleString(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </span>
                , then it appears on the blog automatically — no further action
                needed.
              </>
            ) : (
              'Pick a future date and time. Until then the post stays hidden from visitors; the team can still preview it.'
            )}
          </p>
        </div>
      )}

      {mode === 'now' && (
        <p className="mt-3 text-[11px] text-warm-stone">
          Live for visitors as soon as you save.
        </p>
      )}
      {mode === 'draft' && (
        <p className="mt-3 text-[11px] text-warm-stone">
          Hidden — only the team can see it. Switch to Publish or Schedule when
          you&rsquo;re ready.
        </p>
      )}
    </div>
  )
}
