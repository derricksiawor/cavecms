// Ed25519 release-signing public key — the trust anchor for in-app
// updates. The signed counterpart lives at
//   ~/.cavecms-release-private.pem (publisher box only)
//
// This MUST stay identical to packages/create-cavecms/bin/create-cavecms.mjs
// BUNDLED_PUBKEY_PEM_LITERAL so the CLI install and the in-app
// updater anchor against the same key. Rotation requires updating
// BOTH files in lockstep, signing the first release with the new key,
// and shipping a CLI build that bundles the new public key.
//
// The dev-build override (CAVECMS_RELEASE_PUBKEY_PEM env var, only
// honoured when CAVECMS_DEV_BUILD=1) mirrors the CLI's escape hatch
// for local test installs. In production builds the literal is the
// only source of truth.

const PRODUCTION_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAgfwWFnEmpbmRzmmdExV5rjAG5YTeI44tGG1hziyWnJ8=
-----END PUBLIC KEY-----
`

export const RELEASE_PUBKEY_PEM: string =
  process.env.CAVECMS_DEV_BUILD === '1' &&
  process.env.CAVECMS_RELEASE_PUBKEY_PEM
    ? process.env.CAVECMS_RELEASE_PUBKEY_PEM
    : PRODUCTION_PEM
