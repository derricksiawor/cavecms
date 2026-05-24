'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import type { Role } from '@/lib/auth/requireRole'
import { shouldRenderAdminBar } from '@/lib/admin-bar/shouldRender'
import { canCreate, type EditTargetKind } from '@/lib/admin-bar/roleAllowlist'
import { AdminBarInteractive } from './AdminBarInteractive'

// Client shell for the public admin bar. Decides visibility per
// navigation via `usePathname()` (root layout doesn't re-render on
// soft nav, so visibility MUST be a client concern) and keeps the
// "Edit X" pill in sync by refetching the resolver on each path
// change via /api/admin-bar/edit-target.
//
// Mount lifecycle:
//   - First server render: usePathname returns the request path; the
//     shell either renders the bar or returns null. Hydration sees
//     the same path -> no mismatch.
//   - Subsequent Link nav: usePathname updates synchronously; the
//     shell re-evaluates visibility AND kicks off an editTarget
//     refetch if the new path is bar-eligible.
//
// editTarget shape mirrors `resolveEditTarget`'s return — kept inline
// here so this client file doesn't import the server-only module.

interface EditTarget {
  kind: EditTargetKind
  id: number
  slug: string
  label: string
}

export function AdminBarShell({
  email,
  role,
  initialPathname,
  initialEditTarget,
  editMode,
}: {
  email: string
  role: Role
  initialPathname: string
  initialEditTarget: EditTarget | null
  editMode: boolean
}) {
  const pathname = usePathname() ?? initialPathname
  const allowed = shouldRenderAdminBar(pathname)
  const [editTarget, setEditTarget] = useState<EditTarget | null>(
    initialEditTarget,
  )

  // Refetch editTarget on every pathname change (post-mount). The
  // first render uses the server-resolved value so there's no flash
  // of stale/missing Edit pill at initial paint.
  useEffect(() => {
    // Skip on first render if pathname matches the initial — server
    // already gave us the right value.
    if (pathname === initialPathname) return
    if (!allowed) {
      setEditTarget(null)
      return
    }
    let cancelled = false
    const ctrl = new AbortController()
    const url = `/api/admin-bar/edit-target?path=${encodeURIComponent(pathname)}`
    fetch(url, {
      credentials: 'include',
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    })
      .then(async (r) => {
        if (!r.ok) return null
        const j = (await r.json()) as { target: EditTarget | null }
        return j.target
      })
      .then((t) => {
        if (cancelled) return
        setEditTarget(t)
      })
      .catch(() => {
        if (cancelled) return
        setEditTarget(null)
      })
    return () => {
      cancelled = true
      ctrl.abort()
    }
    // initialPathname is stable per mount — intentionally excluded
    // from deps to avoid re-firing on prop identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, allowed])

  if (!allowed) return null

  const canNewProject = canCreate('project', role)
  const canNewPost = canCreate('post', role)
  const canNewPage = canCreate('page', role)
  const canUploadMedia = canCreate('media', role)
  const canInviteUser = canCreate('user', role)

  return (
    <>
      {/* In-flow placeholder reserves layout space so page content
          starts below the bar. CLS = 0 since the placeholder is in
          the SSR'd HTML (or hydrated immediately on first paint). */}
      <div
        aria-hidden
        className="h-[var(--admin-bar-h)] md:h-[var(--admin-bar-h-md)] print:hidden"
      />
      <div
        role="region"
        aria-label="Site administration"
        className="fixed inset-x-0 top-0 z-[60] flex h-[var(--admin-bar-h)] items-stretch gap-2 border-t-2 border-copper-500 bg-near-black/95 px-3 text-cream-50/85 shadow-[0_8px_20px_-12px_rgba(5,5,5,0.45)] backdrop-blur-sm md:h-[var(--admin-bar-h-md)] md:gap-3 md:px-4 print:hidden"
      >
        <AdminBarInteractive
          email={email}
          role={role}
          editTarget={editTarget}
          editMode={editMode}
          canNewProject={canNewProject}
          canNewPost={canNewPost}
          canNewPage={canNewPage}
          canUploadMedia={canUploadMedia}
          canInviteUser={canInviteUser}
        />
      </div>
    </>
  )
}
