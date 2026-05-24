// Pure path-gate for the public-side admin bar. Importable from BOTH
// server and client modules — does NOT import server-only env, since
// the secret LOGIN_PATH must never ship in the client bundle.
//
// Two callers, one helper:
//   - Server (AdminBar.tsx): passes `loginPath` from env so the bar
//     suppresses on /${LOGIN_PATH} at initial render.
//   - Client (AdminBarShell.tsx): omits `loginPath`; the login route
//     is only reachable via hard navigation (the bar never links to
//     it, no other page links to it from inside the bar's tree), so
//     the server-side initial render covers that case.
//
// Excludes by design (both callers):
//   /admin, /admin/*  — admin chrome has its own UX
//   /api/*            — server endpoints don't render layouts
//   /_next/*, /uploads/* — static assets, never see the root layout
//                          anyway (excluded by middleware matcher);
//                          we list them for parity with the spec
//   /auth/*           — password rotation + step-up flows; bar would
//                       clash with their centered single-purpose UX

export function shouldRenderAdminBar(
  pathname: string,
  loginPath?: string,
): boolean {
  if (!pathname) return false
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return false
  if (pathname.startsWith('/api/')) return false
  if (pathname.startsWith('/_next/')) return false
  if (pathname.startsWith('/uploads/')) return false
  if (pathname.startsWith('/auth/')) return false
  if (loginPath) {
    if (pathname === `/${loginPath}` || pathname.startsWith(`/${loginPath}/`)) {
      return false
    }
  }
  return true
}
