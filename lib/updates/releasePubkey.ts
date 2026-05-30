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

// Trusted Ed25519 release-signing public keys. TODAY this list holds
// exactly ONE key (PRODUCTION_PEM), so verification behaviour is
// byte-identical to a single-key anchor. The list SHAPE exists so a
// FUTURE key rotation can ship a "bridge" release that trusts BOTH the
// old and the new key — letting the whole fleet learn the new key
// before we cut over to signing with it. Without the list, a rotation
// would lock out every install (each trusts only the old key, with no
// channel to learn a replacement). To begin a rotation: append the new
// PEM as a SECOND array entry, ship a bridge release signed with the
// OLD key, wait for fleet saturation, then start signing with the new
// key. Order matters only for which key is tried first (cosmetic).
const PRODUCTION_PEMS: string[] = [PRODUCTION_PEM]

// Back-compat single-key export — the FIRST trusted key. Callers that
// only ever need one anchor (and the dev-build staging override) keep
// working unchanged.
export const RELEASE_PUBKEY_PEM: string =
  process.env.CAVECMS_DEV_BUILD === '1' &&
  process.env.CAVECMS_RELEASE_PUBKEY_PEM
    ? process.env.CAVECMS_RELEASE_PUBKEY_PEM
    : PRODUCTION_PEM

// Full trusted-key list. The apply route forwards this (concatenated)
// to the update orchestrator, which tries each key. The dev-build
// staging override is prepended so it verifies first while the
// production key(s) stay trusted.
export const RELEASE_PUBKEYS_PEM: string[] =
  process.env.CAVECMS_DEV_BUILD === '1' &&
  process.env.CAVECMS_RELEASE_PUBKEY_PEM
    ? [process.env.CAVECMS_RELEASE_PUBKEY_PEM, ...PRODUCTION_PEMS]
    : PRODUCTION_PEMS
