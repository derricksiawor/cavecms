import { z } from 'zod'
import { SLUG_MAX, SLUG_MIN, SLUG_RE } from './slug'

// Pages CMS Zod schemas — single source of truth for body validation
// across server (API routes) AND client (editor inline-field validation).
//
// Each pair (Create*, *Patch) is role-branched: the Editor schema is a
// proper subset of the Admin schema. Editor-role requests parse via the
// smaller schema with `.strict()`; any extra key (e.g. `published`,
// `isHome`, `slug`) trips the strict rejection and the route emits a
// rbac_field_reject audit row + 403. Admin-role requests parse via the
// extended schema and the same extra-key rejection becomes a normal
// validation error for unknown fields.
//
// Spec refs: §3.4 (create), §4.3 (PATCH), §4.5 (restore).

const titleSchema = z.string().min(1).max(220)
const slugSchema = z
  .string()
  .min(SLUG_MIN)
  .max(SLUG_MAX)
  .regex(SLUG_RE)
const seoTitleSchema = z.string().max(180).nullable().optional()
const seoDescriptionSchema = z.string().max(320).nullable().optional()
const mediaIdSchema = z.number().int().positive().nullable().optional()

// ─── CREATE ───────────────────────────────────────────────────────────
//
// Template enum is ROLE-BRANCHED (spec §3.4 + role matrix §0): clone-*
// templates are admin-only — the system About / Services / Contact pages
// are seeded content and an editor cloning one would exfiltrate a tree
// of admin-curated blocks they otherwise can't read. The editor schema
// admits only `template: 'blank'` (which is also the default — no
// template means blank); the admin schema extends with the full enum.
// `.strict()` on the editor side rejects any non-'blank' literal AND
// rejects `published` as an extra key (the rbac_field_reject audit row
// fires from the route, mirroring posts §195-230).

export const CreatePageEditorBody = z
  .object({
    title: titleSchema,
    slug: slugSchema,
    template: z.literal('blank').optional(),
  })
  .strict()

export const CreatePageAdminBody = z
  .object({
    title: titleSchema,
    slug: slugSchema,
    template: z
      .enum(['blank', 'clone-about', 'clone-services', 'clone-contact'])
      .optional(),
    published: z.boolean().optional(),
  })
  .strict()

export type CreatePageEditorInput = z.infer<typeof CreatePageEditorBody>
export type CreatePageAdminInput = z.infer<typeof CreatePageAdminBody>

// ─── PATCH ────────────────────────────────────────────────────────────

export const PageEditorPatch = z
  .object({
    title: titleSchema.optional(),
    seoTitle: seoTitleSchema,
    seoDescription: seoDescriptionSchema,
    heroImageId: mediaIdSchema,
    ogImageId: mediaIdSchema,
    // Optimistic-lock token. Required on every PATCH so a concurrent
    // edit from another tab/operator surfaces as 409 stale_version
    // instead of silently overwriting.
    version: z.number().int().nonnegative(),
  })
  .strict()

export const PageAdminPatch = PageEditorPatch.extend({
  slug: slugSchema.optional(),
  published: z.boolean().optional(),
  isHome: z.boolean().optional(),
}).strict()

export type PageEditorPatchInput = z.infer<typeof PageEditorPatch>
export type PageAdminPatchInput = z.infer<typeof PageAdminPatch>

// ─── RESTORE ──────────────────────────────────────────────────────────

// Restore body: empty restores under the original slug; `asSlug`
// overrides when the original slug has been stolen by another live
// page. Both ends of the redirect write are validated server-side
// against reserved set + LOGIN_PATH (§4.5 step 5).
export const RestorePageBody = z
  .object({
    asSlug: slugSchema.optional(),
  })
  .strict()

export type RestorePageInput = z.infer<typeof RestorePageBody>
