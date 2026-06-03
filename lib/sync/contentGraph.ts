// Pure mapper: bundle content arrays -> the hashable ContentGraph. Shared by
// the local serializer (DB path) and the preflight validator (bundle path) so
// both compute the identical drift hash. No DB, no server-only imports.

import type { ContentGraph } from './contentHash'
import type { PageBundleT, PostBundleT, ProjectBundleT } from './bundleTypes'

export interface BundleContentArrays {
  pages: PageBundleT[]
  posts: PostBundleT[]
  projects: ProjectBundleT[]
  settings: Record<string, unknown>
  settingsMediaRefs?: Record<string, Record<string, string>>
}

export function toContentGraph(content: BundleContentArrays): ContentGraph {
  return {
    pages: content.pages.map((p) => ({
      slug: p.slug,
      title: p.title,
      isHome: p.isHome,
      system: p.system,
      published: p.published,
      seoTitle: p.seoTitle,
      seoDescription: p.seoDescription,
      ogImageKey: p.ogImageKey,
      heroImageKey: p.heroImageKey,
      sections: p.sections,
    })),
    posts: content.posts.map((p) => ({
      slug: p.slug,
      title: p.title,
      excerpt: p.excerpt,
      bodyMd: p.bodyMd,
      published: p.published,
      seoTitle: p.seoTitle,
      seoDescription: p.seoDescription,
      heroImageKey: p.heroImageKey,
      ogImageKey: p.ogImageKey,
    })),
    projects: content.projects.map((p) => ({
      slug: p.slug,
      name: p.name,
      tagline: p.tagline,
      status: p.status,
      location: p.location,
      featuredOrder: p.featuredOrder,
      published: p.published,
      seoTitle: p.seoTitle,
      seoDescription: p.seoDescription,
      heroImageKey: p.heroImageKey,
      brochurePdfKey: p.brochurePdfKey,
      ogImageKey: p.ogImageKey,
    })),
    settings: content.settings,
    settingsMediaRefs: content.settingsMediaRefs ?? {},
  }
}
