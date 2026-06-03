// Shared "apply an extracted bundle directory into a staged push" engine.
//
// This is the hardened post-extraction half of POST /api/cms/sync/stage,
// lifted verbatim into one place so BOTH callers share a single apply path:
//   • the stage ROUTE — after it has streamed + size-capped + link-guarded +
//     extracted the uploaded .tgz into a temp dir (the REMOTE wire-protocol leg);
//   • the PULL orchestrator (lib/sync/orchestrate.ts) — after it has downloaded
//     a source install's /export + media into a temp bundle dir (the in-process
//     apply-to-THIS-install leg).
//
// Everything here runs AFTER extraction: read the bundle's JSON files, parse +
// preflight-validate, then (additively) provision the bundle's media into the
// live media set and persist the resolved payload as a `sync_stage` row — media
// rows + stage row committing together in one transaction. The `written[]`
// file-cleanup-on-throw contract lives here too: a media file copied before a
// mid-stage failure is unlinked, because the rolled-back transaction takes the
// media ROWS but not the copied FILES.
//
// server-only: it imports `db`, the media filesystem layer, and the login-path
// resolver — never reachable from the Edge / a browser bundle.

import 'server-only'
import { readFileSync, statSync, existsSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { db } from '@/db/client'
import { HttpError } from '@/lib/auth/requireRole'
import { SyncBundle } from '@/lib/sync/bundleTypes'
import { validateBundle, type PreflightResult } from '@/lib/sync/preflight'
import { provisionBundleMedia, resolveStagedContent } from '@/lib/sync/mediaRemap'
import { putStage } from '@/lib/sync/stageStore'
import { buildBundleContent, contentGraphOf } from '@/lib/sync/serializeLocal'
import { canonicalContentHash } from '@/lib/sync/contentHash'
import { getResolvedLoginPath } from '@/lib/security/getResolvedLoginPath'

// Per content/*.json parse cap — a single bundle JSON file may not exceed this
// (a hostile bundle could otherwise pin memory parsing a multi-GB "settings").
const MAX_JSON_BYTES = 64 * 1024 * 1024

// The two terminal shapes of a stage attempt. `ok: false` carries the
// preflight errors + summary so the caller can return the 422 body verbatim;
// `ok: true` carries the persisted stageId.
export type StageFromDirResult =
  | { ok: true; stageId: string; contentHash: string; summary: PreflightResult['summary'] }
  | { ok: false; errors: PreflightResult['errors']; summary: PreflightResult['summary'] }

interface StageFromDirOpts {
  // When true, run preflight only and return the validation result WITHOUT
  // provisioning media or writing a stage row (matches the route's
  // ?validateOnly=1 + the orchestrator's dryRun push leg).
  validateOnly?: boolean
}

/**
 * Read + validate + (unless validateOnly) provision-media + persist a staged
 * push from an already-EXTRACTED, already-link-guarded bundle directory.
 *
 * Callers MUST have performed the streaming/size/decompression/symlink-tar
 * guards before invoking this — `extractDir` is trusted to be a confined,
 * link-free tree. This function only reads regular JSON files out of it and
 * delegates media file copies to provisionBundleMedia's own safeCopy (which
 * re-asserts path containment + regular-file-only as defence in depth).
 */
export async function stageBundleFromDir(
  extractDir: string,
  userId: number,
  opts: StageFromDirOpts = {},
): Promise<StageFromDirResult> {
  const read = (rel: string): unknown => {
    const p = path.join(extractDir, rel)
    if (!existsSync(p)) throw new HttpError(400, `bundle_missing:${rel}`)
    if (statSync(p).size > MAX_JSON_BYTES) throw new HttpError(413, `bundle_json_too_large:${rel}`)
    return JSON.parse(readFileSync(p, 'utf8'))
  }
  const readOptional = (rel: string, fallback: unknown): unknown => {
    const p = path.join(extractDir, rel)
    if (!existsSync(p)) return fallback
    if (statSync(p).size > MAX_JSON_BYTES) throw new HttpError(413, `bundle_json_too_large:${rel}`)
    return JSON.parse(readFileSync(p, 'utf8'))
  }
  const candidate = {
    manifest: read('manifest.json'),
    pages: read('content/pages.json'),
    posts: read('content/posts.json'),
    projects: read('content/projects.json'),
    settings: read('content/settings.json'),
    settingsMediaRefs: readOptional('content/settings-media-refs.json', {}),
    media: read('media/manifest.json'),
  }
  const parsed = SyncBundle.safeParse(candidate)
  if (!parsed.success) throw new HttpError(422, 'bundle_malformed')
  const bundle = parsed.data

  // Resolve the target's live login path so preflight can reject a pushed
  // page that would shadow it (best-effort — a resolver hiccup just skips the
  // login-path check; RESERVED slugs are still enforced).
  const loginPath = await getResolvedLoginPath().catch(() => undefined)
  const pre = validateBundle(bundle, { loginPath })
  if (!pre.ok) {
    return { ok: false, errors: pre.errors, summary: pre.summary }
  }
  if (opts.validateOnly) {
    return { ok: true, stageId: '', contentHash: bundle.manifest.contentHash, summary: pre.summary }
  }

  // Drift baseline = the TARGET's (== THIS install's) content hash AT STAGE
  // TIME, computed server-side. The cutover later compares the target's live
  // hash against THIS, so it detects a concurrent edit landing between stage
  // and cutover. (The bundle's own manifest.baselineContentHash is source-side
  // provenance and meaningless as a target baseline — using it made every
  // local→prod push fire drift and forced --force.)
  const targetBaseline = canonicalContentHash(contentGraphOf(await buildBundleContent()))

  // Atomic: media rows + the stage row commit together. On rollback the media
  // ROWS are gone; the catch below unlinks the copied FILES (in `written`).
  const written: string[] = []
  try {
    const stageId = await db.transaction(async (tx) => {
      const keyToMedia = await provisionBundleMedia(tx, bundle.media, extractDir, written)
      const staged = resolveStagedContent(
        {
          pages: bundle.pages,
          posts: bundle.posts,
          projects: bundle.projects,
          settings: bundle.settings,
          settingsMediaRefs: bundle.settingsMediaRefs,
        },
        keyToMedia,
      )
      return putStage(staged, bundle.manifest.contentHash, targetBaseline, userId, tx)
    })
    return { ok: true, stageId, contentHash: bundle.manifest.contentHash, summary: pre.summary }
  } catch (e) {
    // Unlink media files copied before a mid-stage failure (the rows are gone
    // with the rolled-back transaction; only the files would leak).
    for (const p of written) {
      try {
        unlinkSync(p)
      } catch {
        /* already gone */
      }
    }
    throw e
  }
}
