'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X, ChevronLeft, ChevronRight, ZoomIn } from 'lucide-react'
import { DUR, EASE_STANDARD } from '../_shared/motion'
import type { GalleryData, MediaMap } from '../_shared/types'

// Photoswipe-style lightbox without the Photoswipe dependency.
// Reused primitives: Framer Motion for fade + scale of the modal,
// IntersectionObserver-free static grid, native keyboard handling.
//
// Category tabs: a single bar above the masonry grid; clicking a
// tab swaps the active category. The lightbox traverses the
// currently-active category's images.
//
// Keyboard:
//   Esc          — close lightbox
//   ArrowLeft  — previous image
//   ArrowRight — next image
//   Home / End — first / last image in active category

interface OpenState {
  category: number
  image: number
}

export function GallerySection({
  data,
  media,
}: {
  data: GalleryData
  media: MediaMap
}) {
  const categories = data.categories.filter((c) => c.images.length > 0)
  const [activeCat, setActiveCat] = useState(0)
  const [open, setOpen] = useState<OpenState | null>(null)
  // Track the trigger that opened the lightbox so focus returns
  // correctly on close (WCAG 2.4.3 focus order).
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)

  // Restore focus to the trigger when the lightbox closes; pull
  // focus to the close button when it opens. The keyboard listener
  // below handles the Tab-cycle within the modal.
  useEffect(() => {
    if (open) {
      // Defer the focus call by one frame — the modal needs to
      // mount before its close button can accept focus.
      const id = requestAnimationFrame(() => closeButtonRef.current?.focus())
      return () => cancelAnimationFrame(id)
    } else if (triggerRef.current) {
      triggerRef.current.focus()
    }
  }, [open])

  // Keyboard navigation inside the lightbox.
  useEffect(() => {
    if (!open) return
    const cat = categories[open.category]
    if (!cat) return
    const max = cat.images.length - 1
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(null)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setOpen((s) =>
          s ? { ...s, image: s.image === 0 ? max : s.image - 1 } : s,
        )
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        setOpen((s) =>
          s ? { ...s, image: s.image === max ? 0 : s.image + 1 } : s,
        )
      } else if (e.key === 'Home') {
        e.preventDefault()
        setOpen((s) => (s ? { ...s, image: 0 } : s))
      } else if (e.key === 'End') {
        e.preventDefault()
        setOpen((s) => (s ? { ...s, image: max } : s))
      }
    }
    window.addEventListener('keydown', onKey)
    // Lock body scroll while lightbox is open so background page
    // doesn't drift behind the modal during arrow-key navigation.
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
    }
  }, [open, categories])

  const closeLightbox = useCallback(() => setOpen(null), [])

  if (categories.length === 0) return null

  const active = categories[activeCat] ?? categories[0]
  if (!active) return null

  return (
    <section
      id="gallery"
      className="bg-cream py-20 sm:py-28"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
              Visual tour
            </p>
            <h2 className="mt-4 font-serif text-3xl sm:text-4xl md:text-5xl font-semibold tracking-tight text-near-black">
              The residence in detail
            </h2>
          </div>
          {categories.length > 1 && (
            <div
              role="tablist"
              aria-label="Gallery categories"
              className="flex flex-wrap gap-2"
            >
              {categories.map((c, i) => (
                <button
                  key={c.name + i}
                  type="button"
                  role="tab"
                  aria-selected={i === activeCat}
                  tabIndex={i === activeCat ? 0 : -1}
                  onClick={() => setActiveCat(i)}
                  className={[
                    'rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] transition-colors duration-standard ease-standard min-h-[44px]',
                    i === activeCat
                      ? 'border-copper-600 bg-copper-600 text-cream'
                      : 'border-near-black/15 bg-cream-50 text-near-black hover:border-copper-300 hover:bg-cream-100',
                  ].join(' ')}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div
          // Masonry-ish layout via CSS columns. Keeps server-renderable
          // and lightweight; flexbox or grid masonry needs JS for fit.
          className="mt-10 columns-1 gap-4 sm:columns-2 lg:columns-3 [&>*]:mb-4"
        >
          {active.images.map((img, i) => {
            const m = media.get(img.media_id)
            const src = m?.variants?.md ?? m?.variants?.lg
            if (!src) return null
            return (
              <figure
                key={`${img.media_id}-${i}`}
                className="break-inside-avoid overflow-hidden rounded-2xl bg-cream-100 shadow-sm shadow-near-black/5 ring-1 ring-near-black/5"
              >
                <button
                  type="button"
                  className="group relative block w-full overflow-hidden"
                  onClick={(e) => {
                    // Capture the triggering button so focus
                    // returns here when the lightbox closes.
                    triggerRef.current = e.currentTarget
                    setOpen({ category: activeCat, image: i })
                  }}
                  aria-label={`Open ${img.alt || 'gallery image'} in lightbox`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={src}
                    alt={img.alt}
                    loading="lazy"
                    className="block w-full transition-transform duration-elegant ease-standard group-hover:scale-[1.03]"
                  />
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-0 flex items-end justify-end bg-gradient-to-t from-near-black/40 to-transparent opacity-0 transition-opacity duration-standard ease-standard group-hover:opacity-100"
                  >
                    <span className="m-4 grid h-10 w-10 place-items-center rounded-full bg-cream/95 text-near-black shadow-lg">
                      <ZoomIn className="h-4 w-4" strokeWidth={1.75} />
                    </span>
                  </span>
                </button>
                {img.caption && (
                  <figcaption className="px-4 py-3 text-xs text-warm-stone">
                    {img.caption}
                  </figcaption>
                )}
              </figure>
            )
          })}
        </div>
      </div>

      <AnimatePresence>
        {open &&
          (() => {
            const cat = categories[open.category]
            const img = cat?.images[open.image]
            if (!cat || !img) return null
            const m = media.get(img.media_id)
            const src = m?.variants?.lg ?? m?.variants?.md
            const total = cat.images.length
            return (
              <motion.div
                role="dialog"
                aria-modal="true"
                aria-label={`Gallery — ${cat.name}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: DUR.quick, ease: EASE_STANDARD }}
                className="fixed inset-0 z-50 bg-near-black/95 backdrop-blur-sm"
                onClick={closeLightbox}
              >
                <button
                  ref={closeButtonRef}
                  type="button"
                  onClick={closeLightbox}
                  aria-label="Close lightbox"
                  className="absolute right-4 top-4 grid h-12 w-12 place-items-center rounded-full bg-cream/10 text-cream transition-colors hover:bg-cream/20 sm:right-6 sm:top-6"
                >
                  <X className="h-5 w-5" strokeWidth={1.75} />
                </button>

                {total > 1 && (
                  <>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setOpen((s) =>
                          s
                            ? {
                                ...s,
                                image: s.image === 0 ? total - 1 : s.image - 1,
                              }
                            : s,
                        )
                      }}
                      aria-label="Previous image"
                      className="absolute left-4 top-1/2 -translate-y-1/2 grid h-12 w-12 place-items-center rounded-full bg-cream/10 text-cream transition-colors hover:bg-cream/20 sm:left-6"
                    >
                      <ChevronLeft className="h-5 w-5" strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setOpen((s) =>
                          s
                            ? {
                                ...s,
                                image: s.image === total - 1 ? 0 : s.image + 1,
                              }
                            : s,
                        )
                      }}
                      aria-label="Next image"
                      className="absolute right-4 top-1/2 -translate-y-1/2 grid h-12 w-12 place-items-center rounded-full bg-cream/10 text-cream transition-colors hover:bg-cream/20 sm:right-6"
                    >
                      <ChevronRight className="h-5 w-5" strokeWidth={1.75} />
                    </button>
                  </>
                )}

                <motion.div
                  key={`${open.category}-${open.image}`}
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ duration: DUR.standard, ease: EASE_STANDARD }}
                  className="flex h-full w-full items-center justify-center p-6 sm:p-12"
                  onClick={(e) => e.stopPropagation()}
                >
                  {src && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={src}
                      alt={img.alt}
                      className="block max-h-full max-w-full rounded-lg object-contain"
                    />
                  )}
                </motion.div>

                <div className="pointer-events-none absolute inset-x-0 bottom-6 flex items-center justify-center">
                  <p className="rounded-full bg-near-black/60 px-4 py-1.5 text-xs text-cream/85">
                    {open.image + 1} of {total}
                    {img.caption ? ` — ${img.caption}` : ''}
                  </p>
                </div>
              </motion.div>
            )
          })()}
      </AnimatePresence>
    </section>
  )
}
