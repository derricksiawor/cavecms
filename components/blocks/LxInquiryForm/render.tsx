import type { ReactNode } from 'react'
import { InquirySection } from '@/components/project-sections/InquiryForm/render'
import { ProjectFullBleed } from '../_project/FullBleed'
import type { BlockData } from '@/lib/cms/block-registry'
import type { RenderContext } from '@/components/blocks'

// Block wrapper around the project InquirySection — the lead form that
// posts to /api/leads/inquiry. project_id + the visible project name
// come from RenderContext.project; the public preCsrf nonce from
// RenderContext.csrf (minted page-level in renderCmsPage when this
// block is on the tree); previewMode from RenderContext.preview so
// admin QA of an unpublished project never produces a false success.
// Emits id="inquiry-form" (the hero / sticky-header CTA target).
//
// Off a project page (no project context) there is no project to scope
// the lead to — render nothing rather than an orphaned form.
export function LxInquiryForm({
  data,
  project,
  csrf,
  preview,
}: {
  data: BlockData<'lx_inquiry_form'>
  project?: RenderContext['project']
  csrf?: RenderContext['csrf']
  preview?: RenderContext['preview']
}): ReactNode {
  if (!project) return null
  return (
    <ProjectFullBleed>
      <InquirySection
        data={data}
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
