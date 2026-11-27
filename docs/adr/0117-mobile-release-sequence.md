# ADR-0117: Mobile release sequence — PWA first, stores after evidence

## Metadata

| Field          | Value                                                        |
| -------------- | ------------------------------------------------------------ |
| **Status**     | Accepted                                                     |
| **Date**       | 2026-11-27                                                   |
| **Authors**    | Alessio Brillo                                               |
| **Deciders**   | Alessio Brillo                                               |
| **Relates to** | ADR-0108, ADR-0112, ADR-0114, ADR-0115                       |

## Context

ADR-0114 chose a PWA as the validation substrate and a Capacitor shell for
store distribution. The owner confirmed the sequence after reviewing the
state of the project: the Cloud has never been applied, paid mode is off,
`dominus.app` is parked, there are no design partners and no store accounts.

A store app cannot fix any of those. It adds review risk (App Store 4.2
minimum functionality and 3.1.1 digital goods), enrolment cost, 14 days of
Google closed testing, privacy labels and a macOS build pipeline for iOS —
before there is evidence that anyone wants the product.

## Decision

1. **Phase A — public web + installable PWA.** The product is reachable at a
   canonical origin, the mobile shell covers three decision jobs (appraise,
   alerts, portfolio), web push works, and design partners use it. No store
   artifacts are submitted.
2. **Phase B — store evidence gate.** Proceed to Capacitor only when the
   funnel targets of `docs/releases/founding-cohort.md` are met (≥60%
   verified→first score, ≥40% first score→import) and at least 20 design
   partners have made a real keep/drop decision.
3. **Phase C — Android first, iOS second.** Android builds on the owner's
   Windows machine; iOS uses a cloud macOS runner. Both ship the same bundled
   web assets; no remote URL is loaded in the webview.
4. The app is **free** and contains no prices, checkout or upgrade button.
   The plan is shown as a fact; account management stays on the web (ADR-0114).
5. The operator identity, fiscal position and third-party audit remain gates
   for **paid mode**, not gates for the free PWA (ADR-0108, ADR-0112).

## Considered alternatives

| Alternative                 | Why rejected                                                        |
| --------------------------- | ------------------------------------------------------------------- |
| Both stores at once         | Highest cost and review risk before demand is proven.               |
| Native rewrite with Expo    | Second codebase, three extra months, engine already web-first.      |
| In-app purchase from day one | Two billing systems, 30% commission, review risk (ADR-0114).        |

## Consequences

- The store build is a compile-time variant (`VITE_APP_VARIANT=store`) of the
  same SPA; there is no second UI codebase.
- The macOS runner and developer accounts are budgeted in Phase C, not before.
- `launch:check --cloud` and the first-apply runbook remain the gate for Phase
  A; store review is the gate for Phase C.
