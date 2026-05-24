import 'server-only'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { ArrowUpRight } from 'lucide-react'
import { db } from '@/db/client'
import { statusLabel } from '../_shared/labels'
import { RevealOnView } from '../_shared/RevealOnView'

// Server-rendered "similar projects" rail. Single SQL query joining
// the project list with hero media variants. Ranking prioritises:
//   1. Same location (exact match — `location` is operator-supplied
//      free-text, so we don't fuzzy-search)
//   2. Same status enum
//   3. `featured_order` then `name`
// The current project is always excluded. LIMIT 3 keeps the rail
// to one row at most.
//
// Returns null when zero other published projects exist — better
// than rendering an empty rail with a "Similar projects" headline
// and no cards underneath.

interface RailRow {
  slug: string
  name: string
  tagline: string | null
  status: string
  location: string | null
  variants: string | { md?: string; lg?: string } | null
}

export async function SimilarProjectsRailSection({
  projectId,
  projectStatus,
  projectLocation,
}: {
  projectId: number
  projectStatus: string
  projectLocation: string | null
}): Promise<ReactNode> {
  // Drizzle's `sql` template binds these as positional params; no
  // string interpolation hits the SQL itself, so the location field
  // is safe to pass even though it originates as operator-controlled
  // text in the projects table.
  const [rows] = (await db.execute(sql`
    SELECT
      p.slug,
      p.name,
      p.tagline,
      p.status,
      p.location,
      m.variants
    FROM projects p
    LEFT JOIN media m
      ON m.id = p.hero_image_id AND m.deleted_at IS NULL
    WHERE p.published = TRUE
      AND p.deleted_at IS NULL
      AND p.id <> ${projectId}
    ORDER BY
      CASE WHEN p.location IS NOT NULL AND p.location = ${projectLocation} THEN 0 ELSE 1 END,
      CASE WHEN p.status = ${projectStatus} THEN 0 ELSE 1 END,
      p.featured_order IS NULL,
      p.featured_order,
      p.name
    LIMIT 3
  `)) as unknown as [RailRow[]]

  if (rows.length === 0) return null

  const items = rows.map((r) => {
    // Defensive parse — a malformed media.variants cell should
    // collapse to a placeholder thumb, not 500 the page. Mirrors the
    // pattern in lib/cms/hydrate.ts (which try/catches every JSON
    // column read for the same reason).
    let v: { md?: string; lg?: string } | null = null
    if (typeof r.variants === 'string') {
      try {
        v = JSON.parse(r.variants) as { md?: string; lg?: string }
      } catch {
        v = null
      }
    } else {
      v = r.variants as { md?: string; lg?: string } | null
    }
    return {
      slug: r.slug,
      name: r.name,
      tagline: r.tagline,
      status: r.status,
      location: r.location,
      thumb: v?.md ?? v?.lg ?? null,
    }
  })

  return (
    <RevealOnView
      as="section"
      animation="slide-up"
      className="bg-cream py-20 sm:py-28"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
              Keep exploring
            </p>
            <h2 className="mt-3 font-serif text-3xl sm:text-4xl md:text-5xl font-semibold tracking-tight text-near-black">
              Similar residences
            </h2>
          </div>
          <Link
            href="/projects"
            className="inline-flex items-center gap-2 text-sm font-semibold tracking-wide text-near-black underline-offset-4 hover:text-copper-700 hover:underline min-h-[44px]"
          >
            See every project
            <ArrowUpRight className="h-4 w-4" strokeWidth={2} />
          </Link>
        </div>

        <ul className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((p, i) => (
            <li
              key={p.slug}
              className="bwc-stagger-item animate-bwc-fade-in"
              style={{ ['--stagger-index' as string]: i }}
            >
              <Link
                href={`/projects/${p.slug}`}
                className="group block overflow-hidden rounded-2xl border border-near-black/8 bg-cream-50 shadow-sm shadow-near-black/5 transition-all duration-standard ease-standard hover:-translate-y-1 hover:shadow-xl hover:shadow-near-black/10 hover:border-copper-300"
              >
                <div className="relative aspect-[4/3] overflow-hidden bg-cream-200">
                  {p.thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.thumb}
                      alt={p.name}
                      loading="lazy"
                      className="absolute inset-0 h-full w-full object-cover transition-transform duration-elegant ease-standard group-hover:scale-105"
                    />
                  ) : (
                    <div className="absolute inset-0 grid place-items-center text-warm-stone">
                      <span className="text-xs uppercase tracking-[0.28em]">
                        No image yet
                      </span>
                    </div>
                  )}
                  <span className="absolute left-4 top-4 inline-flex items-center gap-2 rounded-full bg-near-black/60 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.24em] text-cream backdrop-blur-sm">
                    {statusLabel(p.status)}
                  </span>
                </div>
                <div className="p-6">
                  <h3 className="font-serif text-xl font-semibold tracking-tight text-near-black">
                    {p.name}
                  </h3>
                  {p.tagline && (
                    <p className="mt-2 line-clamp-2 text-sm text-warm-stone leading-relaxed">
                      {p.tagline}
                    </p>
                  )}
                  {p.location && (
                    <p className="mt-4 text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-700">
                      {p.location}
                    </p>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </RevealOnView>
  )
}
