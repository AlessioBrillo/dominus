// SPDX-License-Identifier: AGPL-3.0-only
// An invitation link must survive the SSO round-trip: the IdP redirects back to
// the app root, so the token is parked in sessionStorage while the user signs in.
const KEY = 'dominus_pending_invite';

export function rememberInvite(token: string): void {
  try {
    sessionStorage.setItem(KEY, token);
  } catch {
    /* storage can be blocked; the user can re-open the link */
  }
}

/** Returns the parked token once and forgets it. */
export function takeInvite(): string | null {
  try {
    const token = sessionStorage.getItem(KEY);
    if (token !== null) sessionStorage.removeItem(KEY);
    return token;
  } catch {
    return null;
  }
}

export function forgetInvite(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* non-fatal */
  }
}

/** Matches the SPA route /invite/:token and returns the token. */
export function inviteTokenFromPath(pathname: string): string | null {
  return /^\/invite\/([A-Za-z0-9_-]{16,256})\/?$/.exec(pathname)?.[1] ?? null;
}
