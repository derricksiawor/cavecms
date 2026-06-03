import { sql } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { db } from '@/db/client'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { adminPolicy } from '@/lib/auth/adminPolicy'
import { SECTION_KEYS } from '@/lib/cms/project-section-registry'
import { MediaPickerProvider } from '@/components/inline-edit/MediaPickerProvider'
import { parseSeoMeta } from '@/lib/seo/seoMeta'
import { ProjectEditor } from './Editor'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

interface ProjectMeta {
  id: number
  slug: string
  name: string
  tagline: string | null
  status: string
  location: string | null
  hero_image_id: number | null
  brochure_pdf_id: number | null
  og_image_id: number | null
  featured_order: number | null
  published: number
  seo_title: string | null
  seo_description: string | null
  focus_keyphrase: string | null
  robots_noindex: number
  robots_nofollow: number
  canonical_url: string | null
  cornerstone: number
  seo_meta: unknown
  version: number
  deleted_at: Date | null
}

interface SectionRow {
  id: number
  section_key: string
  position: number
  version: number
  data: string | Record<string, unknown>
}

interface MediaRow {
  id: number
  alt_text: string
  variants: string | Record<string, string> | null
}

const ID_PATTERN = /^[1-9][0-9]{0,9}$/

export default async function AdminProjectEdit({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const ctx = await requireRoleOrRedirect(adminPolicy('editProject'))
  const { id: rawId } = await params
  if (!ID_PATTERN.test(rawId)) notFound()
  const id = Number(rawId)

  const [projRows] = (await db.execute(sql`
    SELECT id, slug, name, tagline, status, location,
           hero_image_id, brochure_pdf_id, og_image_id, featured_order,
           published, seo_title, seo_description,
           focus_keyphrase, robots_noindex, robots_nofollow,
           canonical_url, cornerstone, seo_meta,
           version, deleted_at
    FROM projects WHERE id = ${id}
  `)) as unknown as [ProjectMeta[]]
  const project = projRows[0]
  if (!project) notFound()

  // Has this project been migrated to a CMS block tree? A live `pages`
  // row at the project's slug means its body content now lives in
  // content_blocks and is edited on the live page through the inline
  // editor — the legacy section accordion below must be hidden so it
  // can't write project_sections that the CMS render ignores (the
  // split-brain the migration is designed to avoid).
  const [cmsPageRows] = (await db.execute(sql`
    SELECT id FROM pages
    WHERE slug = ${project.slug} AND is_home = 0 AND deleted_at IS NULL
    LIMIT 1
  `)) as unknown as [Array<{ id: number }>]
  const hasCmsPage = cmsPageRows.length > 0

  const [sectionRows] = (await db.execute(sql`
    SELECT id, section_key, position, version, data
    FROM project_sections
    WHERE project_id = ${id}
    ORDER BY position
  `)) as unknown as [SectionRow[]]

  // MariaDB returns JSON as string — parse here so the client receives
  // typed objects (same workaround as lib/cms/getSettings.ts).
  const sections = sectionRows.map((s) => ({
    id: s.id,
    section_key: s.section_key,
    position: s.position,
    version: s.version,
    data:
      typeof s.data === 'string'
        ? (JSON.parse(s.data) as Record<string, unknown>)
        : s.data,
  }))

  // Fetch the project's hero / brochure / og media (for picker previews).
  const mediaIds = [
    project.hero_image_id,
    project.brochure_pdf_id,
    project.og_image_id,
  ].filter((x): x is number => x !== null)
  let media: Array<{ id: number; alt: string; thumbUrl: string | null }> = []
  if (mediaIds.length) {
    const [mediaRows] = (await db.execute(sql`
      SELECT id, alt_text, variants
      FROM media
      WHERE id IN (${sql.join(mediaIds, sql.raw(','))})
        AND deleted_at IS NULL
    `)) as unknown as [MediaRow[]]
    media = mediaRows.map((r) => {
      const variants =
        typeof r.variants === 'string'
          ? (JSON.parse(r.variants) as Record<string, string>)
          : r.variants
      return {
        id: r.id,
        alt: r.alt_text,
        thumbUrl: variants?.thumb ?? null,
      }
    })
  }

  return (
    <div className="max-w-5xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Project
      </p>
      <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl">
        {project.name}
      </h1>
      <p className="mt-2 text-xs text-warm-stone font-mono">/projects/{project.slug}</p>
      <MediaPickerProvider>
        <ProjectEditor
          role={ctx.role as 'admin' | 'editor'}
          project={{
            id: project.id,
            slug: project.slug,
            name: project.name,
            tagline: project.tagline,
            status: project.status,
            location: project.location,
            hero_image_id: project.hero_image_id,
            brochure_pdf_id: project.brochure_pdf_id,
            og_image_id: project.og_image_id,
            featured_order: project.featured_order,
            published: project.published,
            seo_title: project.seo_title,
            seo_description: project.seo_description,
            focus_keyphrase: project.focus_keyphrase,
            robots_noindex: project.robots_noindex === 1,
            robots_nofollow: project.robots_nofollow === 1,
            canonical_url: project.canonical_url,
            cornerstone: project.cornerstone === 1,
            seo_meta: parseSeoMeta(project.seo_meta),
            version: project.version,
            deleted_at: project.deleted_at,
          }}
          sections={sections}
          media={media}
          sectionKeys={SECTION_KEYS as readonly string[]}
          hasCmsPage={hasCmsPage}
        />
      </MediaPickerProvider>
    </div>
  )
}
