// Client-side registry of media uploaded during the current editor session.
//
// Section/column background images resolve their URL through the SSR `media`
// map (media_id → variants), which is frozen at page-render time. A file the
// operator uploads mid-session is NOT in that map, so the background couldn't
// resolve its URL until a full refresh re-fetched media. The MediaPicker
// registers a freshly-uploaded media here (id → variants, fetched right after
// the upload), and the background renderers (renderShell's SectionFrame /
// ColumnFrame) consult this as a fallback — so the image appears immediately,
// no refresh.
//
// Why plain module state and not React context: the only read happens on the
// re-render that selecting the background media itself triggers (the meta
// update), so reactivity from the registry isn't needed. The map is only ever
// WRITTEN from the client (MediaPicker), so on the server it stays empty and
// SSR / public rendering is unaffected — it simply falls through to the
// SSR-provided media map there.

type MediaVariants = Record<string, string> | null

const registry = new Map<number, { variants: MediaVariants }>()

/** Record a just-uploaded media's resolved variants so backgrounds keyed on
 *  its id can render before the next page fetch. No-op for invalid ids. */
export function registerUploadedMedia(id: number, variants: MediaVariants): void {
  if (!Number.isInteger(id) || id <= 0) return
  registry.set(id, { variants })
}

/** Look up a session-uploaded media by id. Returns undefined when absent
 *  (the caller falls back to / starts from the SSR media map). */
export function getUploadedMedia(
  id: number,
): { variants: MediaVariants } | undefined {
  return registry.get(id)
}
