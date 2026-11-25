# ADR-0112: The first real customer is the release gate of v1.8.0

## Metadata

| Field          | Value                                   |
| -------------- | --------------------------------------- |
| **Status**     | Accepted                                |
| **Date**       | 2026-11-25                              |
| **Authors**    | Alessio Brillo                          |
| **Deciders**   | Alessio Brillo                          |
| **Supersedes** | —                                       |
| **Relates to** | ADR-0077, ADR-0100, ADR-0107, ADR-0111  |

## Context

v1.7.0 has a complete pipeline, a fail-closed trademark gate, a working
billing surface, an installed-and-verified artifact and a green local gate.
It has never been proven against the real world: no infrastructure has been
applied, no restore drill has been executed, no SMTP relay delivers a magic
link, no external probe measures availability, and no third-party audit has
run. The roadmap calls this work v1.8.0 — “The Contract With The Real World” —
and then a separate first staging apply. Splitting them produces two
releases that each prove nothing on their own.

Three defects are known from code inspection and are corrected in this
increment:

1. `PostgresAdapter` reset the tenant GUC to the string `'default'`. The RLS
   policy of migration 0070 denies only when the setting is NULL, so a
   connection recycled after serving the `default` tenant handed that tenant
   to the next query made without a context. The reset is now a real `RESET`.
2. `effectivePlanFor` granted paid capacity only for `active` and `trialing`.
   A failed card demoted a 500-domain workspace to the 5-domain free tier on
   the same day. A seven-day dunning grace, counted from a stable
   `past_due_since` column set only on the active → past_due transition, now
   preserves paid limits while Stripe retries without restarting on every
   retry.
3. `billing-service.ts` declared its own `StripeSdk` look-alike. It accepted
   `customers.createPortalSession` and an `idempotency_key` body field,
   neither of which exists in `stripe-node`. Typing the SDK boundary against
   the real package caught both: the portal call failed at runtime for every
   customer who asked for it.

## Decision

1. **v1.8.0 is one increment**: the real-service fixes above, a cloud verdict
   policy that never reports `available` from a single source, a staging
   apply with a measured restore drill, a real SMTP relay, an external probe
   and first-party funnel events. Its definition of done is the *stranger
   test*: an outsider signs up with a real mailbox, verifies, scores a real
   domain, imports a portfolio, checks out with a test card, cancels, erases
   their data, and the operator can see the funnel and restore a backup.
2. **Keep ADR-0077's startup fail-open.** The process survives an RDAP probe
   outage. What changes is the verdict: in cloud mode, when there is no
   independent second leg, a single-source `available` is downgraded to
   `Unknown` and reported through `rdap-independent-confirmation-unavailable`.
   A single-source `registered` remains — it is the conservative answer.
3. **Price stays €29 for the founding cohort of 50**, grandfathered, and the
   list price is raised only after the first 20 paying customers (ADR-0111).
   There is no percentage discount: the founding price is a lock, not a sale.
4. **Control-plane RLS is not enabled in this increment.** The 14
   control-plane tables are read before a tenant context exists (signup,
   magic links, API-key authentication, the worker). Enabling a default-deny
   policy without first moving those reads to a separate service-role
   connection would stop the product from booting. The `dominus_service`
   role and the audit are prepared; the enforcement is a follow-up ADR.

## Considered alternatives

| Alternative | Why rejected |
| ----------- | ------------ |
| Ship more scoring/marketplace features in v1.8.0 | The product already has more surface than evidence; features do not close the paid-launch blockers. |
| Make the RDAP startup probe fail-fast in cloud | A dead public endpoint would take down every run instead of degrading one verdict; ADR-0077 chose resilience for a reason. |
| Grant the paid plan immediately on `past_due` forever | Under-serves nobody but eventually invoices nobody; the grace is bounded at seven days. |
| Enable RLS on control-plane tables at once | Breaks pre-tenant authentication and the worker; a broken cloud is worse than a reviewed repository boundary. |

## Consequences

- The local gate gains `check:version-consistency`; the release workflow no
  longer publishes to npm, aligning code with ADR-0102.
- Stripe API drift is a compile error, not a production incident.
- A customer whose card bounces keeps paid capacity for seven days, then
  fails closed.
- A cloud deployment without a second RDAP leg produces fewer candidates,
  never a guessed `available`.
- The remaining isolation work is explicit and tracked rather than hidden in
  a “complete” claim.
