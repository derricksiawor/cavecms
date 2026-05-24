import 'server-only'

// Standard "neutral 200" response shared by every lead-form route.
// Pulling this into one place means a future addition (e.g. a
// `request-id` header for client-side log correlation) ripples
// once. Callers can pass extra body fields — the `hint` field is
// the conventional channel for the preCsrf 'expired' refresh
// suggestion.
export function neutralResponse(
  extra?: Record<string, unknown>,
): Response {
  return new Response(
    JSON.stringify({ ok: true, ...(extra ?? {}) }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    },
  )
}
