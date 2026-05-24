import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { adminPolicy } from '@/lib/auth/adminPolicy'
import { MediaLibrary } from './MediaLibrary'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

// Admin media library — thin index over /api/cms/media (GET = list,
// DELETE /api/cms/media/[id] = soft-delete if unreferenced). The
// inline-edit MediaPicker remains the canonical browse-and-pick
// surface during editing; this page is the operator's "what's in
// the upload pool, what can I prune?" view, plus a delete control
// for unreferenced rows.

export default async function AdminMediaPage() {
  const ctx = await requireRoleOrRedirect(adminPolicy('uploadMedia'))

  return (
    <div className="max-w-6xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Library
      </p>
      <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl">
        Media
      </h1>
      <p className="mt-2 text-sm text-warm-stone max-w-2xl">
        Every image and PDF you upload lives here. Drop new files in
        below, or pick from this library inside any project or post.
      </p>
      <MediaLibrary role={ctx.role as 'admin' | 'editor'} />
    </div>
  )
}
