'use client'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/Button'

// The standard SEO settings card. Mirrors the SettingCard pattern in
// app/(admin)/admin/settings/SettingsForm.tsx exactly so every SEO page
// reads as the same surface the operator already knows: an eyebrow, a
// serif heading, an optional help line, the body, and a Save / Undo
// footer with the copper "Unsaved changes" pulse dot.
//
// State is OWNED BY THE PARENT — this card is presentational. The parent
// composes one card per settings key, tracks per-card dirty state via
// structuralEqual, and passes `dirty` + `busy` + the two handlers in.
// Keeping the card stateless means a page with several cards never has
// to thread refs through it, and the dirty/save mechanics stay identical
// to the rest of the admin.
export function SeoCard({
  title,
  eyebrow = 'SEO',
  help,
  children,
  dirty,
  busy,
  onSave,
  onUndo,
  /** Optional extra controls rendered in the footer, left of Save (e.g.
   *  a "Submit all now" or "Test connection" button). */
  footerExtra,
  /** Label for the save button. Defaults to "Save". */
  saveLabel = 'Save',
  /** When true the card omits its own Save/Undo footer — used by cards
   *  whose only action is a non-dirty operation (e.g. a pure read-only
   *  explainer or a card that saves through a child control). */
  hideFooter = false,
}: {
  title: string
  eyebrow?: string
  help?: ReactNode
  children: ReactNode
  dirty: boolean
  busy: boolean
  onSave: () => void
  onUndo: () => void
  footerExtra?: ReactNode
  saveLabel?: string
  hideFooter?: boolean
}) {
  return (
    <article className="rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-6 backdrop-blur-sm">
      <header className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-600">
          {eyebrow}
        </p>
        <h2 className="mt-1 font-serif text-xl font-bold tracking-tight text-near-black">
          {title}
        </h2>
        {help && (
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-warm-stone">
            {help}
          </p>
        )}
      </header>

      <div className="mt-6">{children}</div>

      {!hideFooter && (
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          {footerExtra}
          <Button
            type="button"
            size="sm"
            onClick={onSave}
            disabled={busy || !dirty}
            className="w-full sm:w-auto"
          >
            {busy ? 'Saving…' : saveLabel}
          </Button>
          {dirty && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onUndo}
              disabled={busy}
              className="w-full sm:w-auto"
            >
              Undo changes
            </Button>
          )}
          {dirty && (
            <span className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-copper-700">
              <span className="inline-flex h-2 w-2 rounded-full bg-copper-500 animate-cavecms-pulse-copper" />
              Unsaved changes
            </span>
          )}
        </div>
      )}
    </article>
  )
}
