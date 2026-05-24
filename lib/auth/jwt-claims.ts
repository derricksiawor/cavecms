// JWT issuer/audience claim constants. Extracted into a server-and-
// test-safe module (no `server-only` import) so the e2e test
// harnesses that mint session tokens out-of-process can reference
// the same values without copy-paste drift.
//
// If ISS/AUD ever rotates, every JWT in flight at deploy time is
// invalidated — change must be coordinated with a token-issue bump
// (tokens_valid_after = NOW()) in the same release.

export const JWT_ISS_SESSION = 'bwc.cms'
export const JWT_AUD_SESSION = 'bwc.web'
export const JWT_ISS_PREVIEW = 'bwc.preview'
export const JWT_AUD_PREVIEW = 'bwc.preview'
