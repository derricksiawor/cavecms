// Resolve the currently-running CaveCMS revision from build-time env.
//
// `CAVECMS_COMMIT` is written by `scripts/deploy.sh` into the per-env file
// (`/etc/cavecms/env.<env-name>`) on every production deploy, and is the
// short SHA of the release that the running pm2 process loaded.
// `CAVECMS_RELEASE_TS` is the matching ISO timestamp for that deploy.
//
// Local dev never sets these — Zod in `lib/env.ts` falls back to the
// string `"unknown"` for the commit. From the Updates UI's perspective
// that should surface as "you are on dev — there's nothing to update
// against".

export interface CurrentVersion {
  /** Short git SHA (or `'dev'` when running locally / pre-deploy). */
  sha: string
  /** ISO timestamp of the deploy. `null` when running locally. */
  ts: string | null
}

export function getCurrentVersion(): CurrentVersion {
  // Read directly off process.env (NOT through lib/env.ts) so the
  // Updates feature can run inside a freshly-spawned test process or
  // CLI script without dragging the full env validator in. The env
  // validator already covers the deploy-time enforcement.
  const rawSha = process.env.CAVECMS_COMMIT
  const rawTs = process.env.CAVECMS_RELEASE_TS

  if (!rawSha || rawSha === 'unknown') {
    return { sha: 'dev', ts: null }
  }
  // Hex-shape validation. CAVECMS_COMMIT is meant to be a git short
  // SHA (7-64 hex chars) — that's what scripts/deploy.sh and the
  // orchestrator's env-rewrite write. A non-hex value here means
  // env tampering, a malformed deploy, or a manual edit. The Update
  // surface uses this value as a *directory name* (snapshot path),
  // so falling through with an arbitrary string would let a value
  // like `../../etc` redirect snapshot/restore primitives outside
  // SNAPSHOT_ROOT. Coerce to 'dev' (the safe "no update available"
  // signal) so the orchestrator's apply-time check at /api/admin/
  // updates/apply refuses cleanly.
  if (!/^[0-9a-f]{7,64}$/i.test(rawSha)) {
    return { sha: 'dev', ts: null }
  }
  return {
    sha: rawSha,
    ts: rawTs ?? null,
  }
}
