# ADR-0116: Device sessions and push for the mobile client

## Metadata

| Field          | Value                                                        |
| -------------- | ------------------------------------------------------------ |
| **Status**     | Accepted                                                     |
| **Date**       | 2026-11-27                                                   |
| **Authors**    | Alessio Brillo                                               |
| **Deciders**   | Alessio Brillo                                               |
| **Relates to** | ADR-0107, ADR-0110, ADR-0114                                 |

## Context

The SPA keeps the API key in `sessionStorage` (`frontend/src/api/client.ts`).
That is correct for a desktop tab: the key is bound to the browsing session
and disappears when the tab dies. A installed mobile app has a different
lifecycle: the process is suspended and killed constantly, `sessionStorage`
is not durable, and a cookie set by a system browser during a magic-link flow
is not visible to the app webview.

The server already has an origin allowlist (`CORS_ORIGIN` in `src/index.ts`),
so adding `capacitor://localhost` and `https://localhost` is configuration, not
new middleware. What is missing is a credential that survives a process kill,
can be revoked per device, and does not leak into logs.

## Decision

1. An authenticated user can mint a **device session** with a label. The
   server stores only a SHA-256 hash of a high-entropy token and returns the
   token once. The token is a Bearer credential accepted by the same auth
   middleware as an API key; it is tenant-scoped and revocable per device.
2. The mobile client stores the token in a platform secure store when one is
   available (Capacitor secure storage / Keychain / Keystore) and falls back
   to `localStorage` in the plain PWA, with an explicit "this browser" label.
   `sessionStorage` stays the storage for API keys in the desktop SPA.
3. Push subscriptions are tenant-scoped rows keyed by the device session. A
   subscription carries a platform (`web` or `android`/`ios`), an endpoint,
   the VAPID/FCM/APNs token and per-topic preferences (renewal, watchlist,
   verdict). Invalid subscriptions are deleted on delivery failure.
4. The service worker handles `push` and `notificationclick`; a notification
   opens the exact decision (`/alerts`, `/portfolio`, `/score/...`) instead of
   the app root.
5. Device tokens and push subscriptions are tenant data: they are covered by
   RLS, included in the export registry, deleted on erasure, and never used
   by the operator to reach a customer (ADR-0107).

## Considered alternatives

| Alternative                              | Why rejected                                                       |
| ---------------------------------------- | ------------------------------------------------------------------ |
| Reuse the API key in the app             | Long-lived, unlabelled, cannot be revoked per phone.               |
| Rely on the magic-link cookie            | Set in the system browser, invisible to the webview after install. |
| Store the token in Capacitor Preferences | Not encrypted; it is a plain key/value store.                      |

## Consequences

- The app's first sign-in still needs an existing credential (API key or
  magic link). A device-code email flow is a follow-up ADR if activation
  data shows it is needed.
- Web push requires VAPID keys in the deployment environment; the routes
  404 when they are absent, matching the fail-closed posture of the magic
  link router.
- A device token counts as a machine key for plan-quota purposes only if the
  operator configures it as such; this increment does not change billing.
