# ADR-0114: Mobile-first PWA first, Capacitor shell for the stores

## Metadata

| Field          | Value                                                        |
| -------------- | ------------------------------------------------------------ |
| **Status**     | Accepted                                                     |
| **Date**       | 2026-11-26                                                   |
| **Authors**    | Alessio Brillo                                               |
| **Deciders**   | Alessio Brillo                                               |
| **Supersedes** | part of ADR-0028 (desktop-first dashboard priority)          |
| **Relates to** | ADR-0028, ADR-0108, ADR-0111, ADR-0112, ADR-0113             |

## Context

The shipped SPA is a desktop professional dashboard: a fixed 224 px sidebar,
wide tables and a 30-route navigation. There is no web app manifest, no service
worker, no push channel and no mobile viewport in the Playwright configuration.
On a 390 px phone the product is effectively unusable.

The owner wants a public mobile application. The Cloud is still behind the
stranger test of ADR-0112: no applied infrastructure, no real SMTP relay, no
measured restore drill, no external probe and no third-party audit. A native
rewrite would add a second codebase before the first customer exists, and a
thin web wrapper around the desktop dashboard would be rejected under the App
Store's minimum-functionality rule.

The paid model is web checkout (ADR-0111) and the app is free: no prices and no
purchase button may live inside the mobile shell. The interface stays English
only, consistent with the binding legal text (ADR-0109).

## Decision

1. The mobile experience is built **in the existing React SPA** as a
   mobile-first shell: a bottom tab bar for the five decision-first screens
   (Today, Score, Portfolio, Alerts, Account), with the remaining desktop
   routes reachable from a secondary menu. The desktop dashboard stays intact.
2. The first installable artifact is a **PWA**: manifest, icons, app-shell
   service worker with read-only offline cache and web push where the platform
   supports it. It is the validation substrate and the single source of the
   bundled assets.
3. Store distribution uses a **Capacitor shell** around the same built assets,
   adding native push (FCM/APNs), secure token storage, biometric unlock, share
   and deep links. The app is bundled locally; no remote URL is loaded.
4. The app contains **no prices, no checkout and no upgrade button**. It shows
   the current plan and a link to web account management. If store review
   rejects even that link, it is removed and in-app purchase is deferred to a
   later version.
5. Mobile screens are kept to a five-tab scope; the pipeline builder, backtest,
   provider configuration, admin, automation and other operator surfaces remain
   desktop-only.
6. A mobile Chromium project is added to the end-to-end suite so the shell
   cannot regress silently.

## Considered alternatives

| Alternative | Why rejected |
| ----------- | ------------ |
| Native rewrite with Expo | A second codebase and three extra months before the first paying customer; the engine and the API are already web-first. |
| Publish a Capacitor wrapper of the desktop dashboard now | The layout is unusable at phone width and a thin wrapper fails the App Store minimum-functionality rule. |
| Mobile web only, no stores | Cheaper, but gives up store discovery and the perception of a real app, which are part of the stated goal. |
| Web checkout plus in-app purchase from day one | Two billing systems, two tax stories and a review risk; the owner chose web checkout. |

## Consequences

- The frontend gains a mobile shell, PWA assets and a mobile E2E project; the
  desktop navigation labels remain unchanged so existing tests keep their
  contract.
- Push token registration, per-tenant preferences and a push notifier are a
  follow-up increment; the PWA can show OS-level notifications where supported
  before native push exists.
- Store listing assets, privacy labels and the closed-test logistics are
  operational tasks, not code, and remain in the launch plan.
- The decision does not change the Cloud launch gate of ADR-0112: the stranger
  test still gates paid mode.
