// Tiny pub/sub so a "Save as block" success can tell an already-mounted
// SavedBlocksPanel to refetch immediately. The panel only fetches on
// mount, and the widget picker keeps it mounted while the Saved tab is
// active — so without this signal a freshly-saved block doesn't appear
// until the operator switches tabs away and back (forcing a remount).
//
// Module-level (not a React context) on purpose: the producer
// (saveWidgetAsBlock in contextMenuActions.ts, a non-React module) and
// the consumer (SavedBlocksPanel) live in different parts of the tree
// with no shared provider ancestor that already threads this. A bus
// keeps them decoupled with zero plumbing.

type Listener = () => void

const listeners = new Set<Listener>()

/** Notify subscribers that the saved-blocks library changed (a block
 *  was just created). Safe to call from anywhere, including non-React
 *  code. */
export function emitSavedBlocksChanged(): void {
  for (const fn of listeners) {
    try {
      fn()
    } catch {
      // A throwing listener must not break the others or the caller.
    }
  }
}

/** Subscribe to saved-blocks-changed events. Returns an unsubscribe
 *  function — call it from a useEffect cleanup. */
export function subscribeSavedBlocksChanged(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
