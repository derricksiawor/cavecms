import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { adminPolicy } from '@/lib/auth/adminPolicy'
import { NewPostForm } from './NewPostForm'

export const dynamic = 'force-dynamic'

// Thin shell for the create-post form. Server-side requireRole gate
// runs before the client form renders — drops viewers (read-only)
// straight to a 403-equivalent redirect via the layout's HttpError
// catch. The actual POST goes through /api/cms/posts (csrfFetch on
// the client), which centralises slug validation + audit + cache
// invalidation. Keeps this page free of duplicated insert logic.
export default async function NewPost() {
  await requireRoleOrRedirect(adminPolicy('createPost'))
  return (
    <section className="max-w-2xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Content
      </p>
      <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black">
        New blog post
      </h1>
      <p className="mt-4 text-warm-stone">
        Pick a working title and a web address. You can add the body,
        cover photo, search-engine details, and publish whenever you&rsquo;re ready.
      </p>
      <div className="mt-8">
        <NewPostForm />
      </div>
    </section>
  )
}
