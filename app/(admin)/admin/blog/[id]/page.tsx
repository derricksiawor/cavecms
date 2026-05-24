import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { adminPolicy } from '@/lib/auth/adminPolicy'
import { MediaPickerProvider } from '@/components/inline-edit/MediaPickerProvider'
import { Editor, type EditorPost } from './Editor'

export const dynamic = 'force-dynamic'

const ID_PATTERN = /^[1-9][0-9]{0,9}$/

interface PostEditorRow {
  id: number
  slug: string
  title: string
  excerpt: string | null
  body_md: string
  hero_image_id: number | null
  hero_alt: string | null
  og_image_id: number | null
  og_alt: string | null
  seo_title: string | null
  seo_description: string | null
  version: number
  published: number
}

type Params = Promise<{ id: string }>

export default async function PostEditor({ params }: { params: Params }) {
  const ctx = await requireRoleOrRedirect(adminPolicy('editPost'))
  const { id: rawId } = await params
  if (!ID_PATTERN.test(rawId)) notFound()
  const id = Number(rawId)

  // Pull current media alt text alongside the post so the picker's
  // initial UI shows a meaningful label, not just `image #N`. LEFT
  // JOINs because both image fields are nullable; deleted_at IS NULL
  // hides media that was soft-deleted out from under the post.
  const [rows] = (await db.execute(sql`
    SELECT p.id, p.slug, p.title, p.excerpt, p.body_md, p.version,
           p.published,
           p.hero_image_id, hm.alt_text AS hero_alt,
           p.og_image_id, om.alt_text AS og_alt,
           p.seo_title, p.seo_description
    FROM posts p
    LEFT JOIN media hm ON hm.id = p.hero_image_id AND hm.deleted_at IS NULL
    LEFT JOIN media om ON om.id = p.og_image_id AND om.deleted_at IS NULL
    WHERE p.id = ${id} AND p.deleted_at IS NULL
  `)) as unknown as [PostEditorRow[]]
  const row = rows[0]
  if (!row) notFound()

  const post: EditorPost = {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    body_md: row.body_md,
    hero: row.hero_image_id
      ? { media_id: row.hero_image_id, alt: row.hero_alt ?? '' }
      : null,
    og: row.og_image_id
      ? { media_id: row.og_image_id, alt: row.og_alt ?? '' }
      : null,
    seo_title: row.seo_title,
    seo_description: row.seo_description,
    version: row.version,
    published: row.published === 1,
  }

  return (
    <MediaPickerProvider>
      <Editor
        post={post}
        canPublish={ctx.role === 'admin'}
        readonly={ctx.role === 'viewer'}
      />
    </MediaPickerProvider>
  )
}
