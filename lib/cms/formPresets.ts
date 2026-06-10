// lx_form presets — the canonical field/action configs for the three
// system form flows (contact page, project inquiry, gated brochure
// download). One source of truth shared by:
//   - db/seeds/systemPageBlocks.ts (the contact system-page seed)
//   - lib/cms/siteTemplates/_shared.ts (install-template contact pages)
//   - lib/cms/projectTreeBuilder.ts (the project-page generator)
//   - lib/cms/blockSeeds.ts (the operator palette presets)
//   - db/migrations/0041 (the legacy-form → lx_form data migration
//     mirrors these shapes — keep them in lockstep)
//
// Pure data builders — NO server-only imports (blockSeeds.ts is pulled
// into the client palette bundle). Every payload parses clean through
// the lx_form Zod schema (Zod fills the optional knobs via .default()).
//
// Project binding is DATA, not render-time infrastructure: the project
// forms carry a hidden `project_id` field whose defaultValue is the
// project id snapshotted at seed/migration time. The lead route
// (/api/leads/form) re-reads that value SERVER-SIDE from the stored
// block row — never from the client payload — to bind leads.project_id.

/** Reserved hidden-field name carrying the owning project's id. The
 *  lead route resolves it from the block's stored fields (not the
 *  submitted FormData) so the binding is tamper-proof. */
export const PROJECT_ID_FIELD = 'project_id'

type FormField = Record<string, unknown>

/** Contact preset — the contact system page's form (replaces the
 *  retired fixed-slot `contact_form` block). */
export function contactFormPresetData(opts: {
  heading?: string
  intro?: string
  submitLabel?: string
  successHeadline?: string
  successBody?: string
} = {}): Record<string, unknown> {
  return {
    heading: opts.heading ?? 'Send us a note.',
    intro:
      opts.intro ??
      'A short message about what you need — we will come back within one business day.',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true, role: 'name', width: 'half' },
      { name: 'email', label: 'Email', type: 'email', required: true, role: 'email', width: 'half' },
      { name: 'phone', label: 'Phone', type: 'tel', required: true, role: 'phone' },
      { name: 'message', label: 'Message', type: 'textarea', required: true },
    ],
    submitLabel: opts.submitLabel ?? 'Send message',
    successHeadline: opts.successHeadline ?? 'Thanks — we received your message.',
    successBody: opts.successBody ?? 'A member of our team will be in touch shortly.',
  }
}

/** Project-inquiry preset — the always-present lead form on a project
 *  page (replaces the retired `lx_inquiry_form`). Tour scheduling is
 *  first-class (date + time pickers); message stays as an optional
 *  free-text channel so no legacy lead detail is lost. */
export function projectInquiryFormPresetData(opts: {
  /** Snapshot of the owning project's id — omitted for the bare palette
   *  preset (the operator fills the hidden value, or leaves the form
   *  unscoped). */
  projectId?: number
  projectName?: string
  heading?: string
  intro?: string
}): Record<string, unknown> {
  const fields: FormField[] = [
    { name: 'name', label: 'Name', type: 'text', required: true, role: 'name', width: 'half' },
    { name: 'email', label: 'Email', type: 'email', required: true, role: 'email', width: 'half' },
    { name: 'phone', label: 'Phone (optional)', type: 'tel', role: 'phone' },
    { name: 'tour_date', label: 'Preferred tour date', type: 'date', width: 'half' },
    { name: 'tour_time', label: 'Preferred time', type: 'time', width: 'half' },
    { name: 'message', label: 'Message (optional)', type: 'textarea' },
  ]
  if (opts.projectId !== undefined) {
    fields.push({
      name: PROJECT_ID_FIELD,
      label: 'Project',
      type: 'hidden',
      defaultValue: String(opts.projectId),
    })
  }
  return {
    ...(opts.heading !== undefined ? { heading: opts.heading } : {}),
    ...(opts.intro !== undefined ? { intro: opts.intro } : {}),
    fields,
    submitLabel: 'Send inquiry',
    successHeadline: opts.projectName
      ? `Thanks — we've received your inquiry about ${opts.projectName}.`
      : 'Thanks — we’ve received your inquiry.',
    successBody: 'A member of our sales team will reach out soon.',
  }
}

/** Gated-download preset — trade contact details for a file. With a
 *  `file`, ships a ready deliver_file action (the project brochure
 *  flow, PDF snapshotted at seed/migration time); without one (the
 *  bare palette preset) the operator attaches the file in the drawer's
 *  After-submit tab. */
export function gatedDownloadFormPresetData(opts: {
  projectId?: number
  projectName?: string
  /** The gated media row (media_id + human label via alt). */
  file?: { media_id: number; alt: string }
  heading?: string
  intro?: string
}): Record<string, unknown> {
  const fields: FormField[] = [
    { name: 'name', label: 'Name', type: 'text', required: true, role: 'name', width: 'half' },
    { name: 'email', label: 'Email', type: 'email', required: true, role: 'email', width: 'half' },
    { name: 'phone', label: 'Phone (optional)', type: 'tel', role: 'phone' },
  ]
  if (opts.projectId !== undefined) {
    fields.push({
      name: PROJECT_ID_FIELD,
      label: 'Project',
      type: 'hidden',
      defaultValue: String(opts.projectId),
    })
  }
  return {
    ...(opts.heading !== undefined ? { heading: opts.heading } : {}),
    ...(opts.intro !== undefined ? { intro: opts.intro } : {}),
    fields,
    submitLabel: opts.projectName
      ? `Email me the ${opts.projectName} brochure`
      : 'Email me the download',
    successHeadline: 'Check your inbox.',
    successBody: 'Your download link is on its way. The link works for 7 days.',
    actions: opts.file
      ? [
          {
            kind: 'deliver_file',
            file: opts.file,
            mode: 'email',
            ...(opts.projectName
              ? {
                  emailSubject: `Your ${opts.projectName} brochure`,
                  emailBody: `Thanks for your interest in ${opts.projectName} — here is the full brochure.`,
                }
              : {}),
          },
        ]
      : [],
  }
}
