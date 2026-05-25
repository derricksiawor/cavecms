// Client-safe Gemini model allowlist.
//
// `lib/cms/settings-registry.ts` is a server-only module (it imports
// `env`, which throws when a server-only env var is missing). The
// admin Settings → AI page is a CLIENT surface — its <select> needs
// to list the same models the registry validates. Putting the list
// in this thin module lets both sides import the same source of
// truth without dragging the registry into the client bundle.
//
// Mirror in shape pattern of `lib/cms/mobileCtaIcons.ts` — same
// rationale (server registry + client UI sharing one const tuple).
//
// Gemini API model IDs verified against
// https://ai.google.dev/gemini-api/docs/models on 2026-05-25. Exact
// strings matter — these get passed verbatim to the @google/genai
// SDK, so an unrecognised value would 400 the verify endpoint and
// silently break inline / chat at runtime. When Google deprecates a
// preview ID, this list updates and the post-migrate gate fails any
// DB rows still pointing at the dead ID (the operator re-picks from
// the dashboard).

export const AI_MODEL_IDS = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-3-flash-preview',
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash',
] as const

export type AiModelId = (typeof AI_MODEL_IDS)[number]
