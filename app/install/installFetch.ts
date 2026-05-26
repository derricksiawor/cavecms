// Token-aware fetch for the install wizard.
//
// The CLI generates a one-shot INSTALL_BOOTSTRAP_TOKEN at install time
// and embeds it in the URL it prints (`/install?t=<token>`). The
// /install page reads it from searchParams and hands it to the
// InstallWizard component, which calls `setInstallToken(token)` once
// on mount. From then on, every step's fetch call goes through
// `installFetch`, which adds the token as an `X-Install-Token`
// header on /api/install/* requests.
//
// Module-level state instead of React context: the wizard component
// tree is shallow (one root + step children) and every step calls
// fetch directly. A context would mean a useContext lookup at every
// step boundary; the module-level pattern is simpler and equivalent.

let token: string | null = null

/**
 * Set the bootstrap token. Called once by InstallWizard from a useEffect
 * when the component mounts. Subsequent calls overwrite — but the wizard
 * never changes the token mid-flow, so this is effectively write-once.
 */
export function setInstallToken(t: string | null): void {
  token = t
}

/**
 * Drop-in fetch wrapper that adds X-Install-Token to install API calls.
 *
 * Adds the header ONLY for same-origin /api/install/* paths so external
 * fetches (if any) never leak the token. Other paths pass through
 * untouched.
 */
export async function installFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (token && url.startsWith('/api/install/')) {
    headers.set('X-Install-Token', token)
  }
  return fetch(url, { ...init, headers })
}
