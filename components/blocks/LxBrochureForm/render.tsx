import type { ReactNode } from 'react'
import { BrochureSection } from '@/components/project-sections/Brochure/render'
import { ProjectFullBleed } from '../_project/FullBleed'
import type { BlockData } from '@/lib/cms/block-registry'
import type { BrochureData } from '@/components/project-sections/_shared/types'
import type { RenderContext } from '@/components/blocks'

// Block wrapper around the project BrochureSection — the lead-gated PDF
// download that posts to /api/leads/brochure. The PDF itself stays
// canonical on projects.brochure_pdf_id (the lead route reads THAT);
// the block carries only the gate copy. The renderer synthesises the
// section's `pdf` gate from project.brochure_pdf_id so BrochureSection
// returns null when no brochure is wired (replicating the legacy
// "no PDF → render nothing" behaviour, which avoids a dead CTA that
// would lose real leads). Emits id="brochure".
export function LxBrochureForm({
  data,
  project,
  csrf,
  preview,
}: {
  data: BlockData<'lx_brochure_form'>
  project?: RenderContext['project']
  csrf?: RenderContext['csrf']
  preview?: RenderContext['preview']
}): ReactNode {
  if (!project || project.brochure_pdf_id === null) return null
  const sectionData: BrochureData = {
    // The section only uses `pdf` as a "is there a brochure?" gate — the
    // stylised card it renders never resolves the media row, and the
    // actual file is fetched server-side by the lead route from
    // projects.brochure_pdf_id. alt is unused on this surface.
    pdf: { media_id: project.brochure_pdf_id, alt: '' },
    gate_message_richtext: data.gate_message_richtext,
    // Presentation controls flow through to BrochureSection, which
    // honours them (absent === current behavior).
    card_surface: data.card_surface,
    field_style: data.field_style,
  }
  return (
    <ProjectFullBleed>
      <BrochureSection
        data={sectionData}
        ctx={{
          preCsrf: csrf ?? '',
          previewMode: preview ?? false,
          projectId: project.id,
          projectName: project.name,
          projectTagline: project.tagline,
          projectStatus: project.status,
        }}
      />
    </ProjectFullBleed>
  )
}
