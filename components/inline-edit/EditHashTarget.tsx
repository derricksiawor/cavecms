'use client'
import { useEffect, useRef } from 'react'
import { useSelection } from './SelectionContext'

// Honours the `#block-<id>` hash on the inline-editor URL — the target
// the admin "Edit inline" affordance in /admin/pages/[id] builds
// (`<publicUrl>?edit=1#block-<id>`). On mount (and on hashchange) it
// selects that block + scrolls it into view, so clicking "Edit inline"
// for a specific block lands the operator ON that block in the live
// editor instead of at the top of the page. No-op when the hash is
// absent or not a `#block-<id>` form.
//
// Mounted only inside the editable branch of EditableMain (so it sits
// inside SelectionProvider). The block wrapper may not be in the DOM on
// the first paint (the editable tree mounts inside a Suspense boundary),
// so the scroll retries across a few animation frames until it appears.
export function EditHashTarget() {
  const { select } = useSelection()
  // Keep the latest `select` in a ref so the mount-once effect never goes
  // stale and never re-binds the listener on selection changes (which
  // would otherwise re-scroll to the hash block on every click).
  const selectRef = useRef(select)
  selectRef.current = select

  useEffect(() => {
    const apply = () => {
      const m = /^#block-(\d+)$/.exec(window.location.hash)
      if (!m) return
      const id = Number(m[1])
      if (!Number.isInteger(id) || id <= 0) return
      selectRef.current(id)
      let tries = 0
      const scrollToBlock = () => {
        const el = document.querySelector(`[data-edit-block-id="${id}"]`)
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' })
          return
        }
        // ~30 frames (≈500ms) of grace for the Suspense tree to mount.
        if (tries++ < 30) requestAnimationFrame(scrollToBlock)
      }
      requestAnimationFrame(scrollToBlock)
    }
    apply()
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
  }, [])

  return null
}
