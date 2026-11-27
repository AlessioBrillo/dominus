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
2. The mobile client stores the token in a platform secure store when a
   verified plugin is installed and falls back to `localStorage`. The
   adapter detects the plugin at runtime; no unverified plugin is pinned.
   `sessionStorage` stays the storage for API keys in the desktop SPA.
3. Push subscriptions are tenant-scoped rows keyed by the device session.
   **This increment implements browser push only** (`platform='web'`,
   VAPID). Native FCM/APNs delivery is a follow-up: it needs vendor
   credentials and a project on the operator's account, neither of which
   exists yet. A subscription carries the endpoint, its encryption keys,
   the owning device session and per-topic preferences (renewal, watchlist,
   verdict). Endpoints that fail are put in a one-hour cooldown, not silenced
   forever; endpoints rejected as gone (404/410) are deleted.
4. The service worker handles `push` and `notificationclick`; a notification
   opens the exact decision (`/alerts`, `/portfolio`, `/score/...`) instead of
   the app root.
5. Device tokens and push subscriptions are tenant data: they are included in
   the export registry, deleted on erasure, and never used by the operator to
   reach a customer (ADR-0107). `push_subscriptions` is RLS-protected;
   `mobile_device_sessions` is control-plane like `api_keys` because it is
   read before a tenant context exists. Both hide their secret columns in
   the data-subject export.

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
