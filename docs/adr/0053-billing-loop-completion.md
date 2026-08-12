# ADR-0053: Billing Loop Completion — Team Checkout and Status-Aware Enforcement

## Metadata

| Field          | Value                                  |
| -------------- | -------------------------------------- |
| **Status**     | Proposed                               |
| **Date**       | 2026-08-12                             |
| **Authors**    | AlessioBrillo                          |
| **Deciders**   | AlessioBrillo                          |
| **Supersedes** | N/A                                    |
| **Relates to** | ADR-0038, ADR-0049, ADR-0050, ADR-0037 |
| **Project**    | DOMINUS                                |

## Context

DOMINUS Cloud monetises on three paid tiers — Pro €29/mo, Team €79/mo,
Enterprise custom — per ADR-0026. The Team tier shipped as a _feature_
(PR #280: plan_limits rows, team seats, `resolvePriceId('team', …)`,
`STRIPE_PRICE_ID_TEAM_MONTHLY/YEARLY` config), but the billing loop never
closed around it: the checkout API schema only accepted `pro` and
`enterprise`, the frontend plan catalog rendered no Team card, so the
€79/mo SKU was not purchasable anywhere. Resellers cannot sell what the
checkout schema rejects.

Separately, usage enforcement (ADR-0038) consulted the subscription row for
its _plan_ but never its _status_. `UsageMeterService.record()` maps
`sub.plan` straight into `getPlanLimit()`; a tenant whose card bounced
(marked `past_due` by the Stripe webhook) or whose subscription was
canceled kept the full paid capacity until `customer.subscription.deleted`
arrived — and even that event only downgrades the row, with no read-side
status check. Enforcement therefore drifted from billing reality: the
metering chokepoint that protects usage limits was blind to the billing
state that defines them.

A third, smaller gap: `createCheckoutSession` hardcoded
`trial_period_days: 14` on every checkout session. Stripe applies a trial
per subscription; every new checkout (upgrades, re-subscribes) re-created
one, re-granting 14 free days per plan change. The trial intended to be a
first-conversion incentive was silently becoming a recurring discount.

## Decision Drivers

1. **Monetisation completeness** — the Team tier must be sellable through
   the same checkout path as Pro/Enterprise before the Cloud launch; a SKU
   that cannot be purchased is dead inventory.
2. **Fail-closed conservatism** — the project consistently fails closed on
   uncertainty (ADR-0039 consensus, ADR-0049 budgets). A lapsed payer must
   not keep paid capacity; under-serving is safer than over-granting.
3. **Trial integrity** — the 14-day trial must be a one-time conversion
   incentive, not a recurring discount on every plan change.
4. **Minimal surface** — this completes the loop with only the read-side of
   the existing subscription row; no schema change, no new webhook event
   plumbing beyond one switch case.

## Considered Options

### Option A: Status-aware effective plan, read-side only

`UsageMeterService` gains an `effectivePlanFor(sub)` helper: statuses
`active` and `trialing` map to `sub.plan`, every other status (and a
missing row) maps to `free`. All three plan-resolution call sites
(`record()`, `getUsageForPeriod()`, `getAllPlanLimitsForTenant()`) route
through it. Team joins the checkout schema and plan catalog with zero
special-casing; trial becomes conditional on the tenant having no Stripe
customer yet (`stripeCustomerId IS NULL`). `invoice.payment_failed` marks
the row `past_due` via the existing `updateStatus()`.

**Advantages:**

- Enforcement becomes correct the moment the webhook writes the status —
  no timers, no schedulers, no grace-state machine.
- One helper, three call sites, no migration, no new config.
- Conservatism matches the project's fail-closed culture: `past_due` loses
  paid capacity immediately, which also incentivises fixing payment.
- The resolution is a pure function of the DB row — trivially testable in
  both SQLite and the shared code path.

**Disadvantages:**

- A legitimate transient payment glitch downgrades the tenant instantly; a
  grace period would be friendlier (but requires a state machine).
- `trialing` status keeps paid limits for a trial that may belong to a
  different (cheaper) intent — acceptable, trials are cap-limited anyway.

**Cost Implications:** Small. ~30 lines of service code, ~30 lines of tests,
one frontend card block. No DB migration, no new dependency.

**Risk Assessment:** Low. Pure read-side change; statutory risk only if a
payer is cut off mid-glitch and churns — mitigated by `trialing`/`active`
mapping and the Stripe customer portal for re-payment.

---

### Option B: Grace-period downgrader

Keep enforcement status-unaware and add a scheduled job (scheduler slot)
that scans `tenant_subscriptions` for `past_due` rows older than N days and
downgrades them to free. Checkout/trial changes as in Option A.

**Advantages:**

- Friendlier to temporarily-broke payers; N-day grace is a common SaaS
  pattern.
- Centralises the policy in one visible place.

**Disadvantages:**

- More moving parts: a new scheduled job, a config knob
  (`BILLING_GRACE_DAYS`), replica coordination for the scan.
- Between webhook arrival and the grace-scan the paid capacity continues to
  be spent _while billing fails_ — the exact revenue-leak window this ADR
  closes.
- Enforcement still lags reality by definition; the drift is bounded but
  never zero.

**Cost Implications:** Medium. Scheduler slot + config + tests; runtime
cost of periodic table scans (small at this scale).

**Risk Assessment:** Medium. Introduces timing semantics that are hard to
reason about in multi-replica deployments; the scan is a new failure
surface in the scheduler.

---

### Option C: Stripe API revalidation at enforcement time

On every `record()`, additionally call Stripe (`GET /v1/subscriptions/:id`)
to validate live status instead of trusting the local row.

**Advantages:**

- Perfect billing truth; immune to webhook delivery delays or dedup bugs.

**Disadvantages:**

- One Stripe API round-trip per metered unit — 2500 candidate scores/day
  on Team alone multiplies Stripe load and latency on a hot path, and
  makes enforcement dependent on Stripe API availability.
- Violates the cost discipline of ADR-0001 and adds a network dependency to
  a chokepoint that must stay deterministic.
- Webhook dedup (billing-service `#claimEvent`) is already designed to
  protect exactly this drift; re-validating is belt-and-braces at the
  wrong place.

**Cost Implications:** High. API call volume per metered unit, latency
added to every pipeline run, new failure mode (Stripe being down blocks
scoring).

**Risk Assessment:** High. Turns a local deterministic check into a remote
dependent one; worst case the hot path requires Stripe uptime.

## Decision

**Chosen option: Option A — status-aware effective plan, read-side only.**

Option A closes the enforcement gap at the instant the webhook writes the
status, with one pure helper and zero new infrastructure — the smallest
change that makes billing state authoritative on the metering path. It
rejects Option B because a grace window is precisely the window in which a
failing payer keeps consuming paid capacity: the conservative default for a
domain-investment tool whose scoring is already fail-closed philosophy-wide
(ADR-0039) is to cut first and restore on payment, which Stripe does
transparently via the customer portal. The grace period can be layered on
later, if churn data demands it, without changing the read-side contract.
It rejects Option C because enforcement must stay deterministic and
local — ADR-0038's chokepoints exist to meter usage, not to paginate the
Stripe API; the webhook pipeline already converges the local row within
seconds of any Stripe state change.

For the Team SKU, the choice is unremarkable by design: checkouting the
new tier is a schema widening plus a catalog entry — no per-tier logic in
the core, the price/features copy lives in the frontend card. Trial-once
(no `subscription_data` when the tenant already has a Stripe customer)
removes the silent recurring discount without any new config knob.

## Consequences

### Positive

- The Team tier becomes purchasable; the €79/mo SKU matches the shipped
  capability in PR #280 (plan_limits, seats, Slack support).
- `invoice.payment_failed` downgrades the effective plan to free within
  one webhook delivery — the revenue-leak window shrinks from
  "until a manual/event-of-last-resort cleanup" to seconds.
- Trial semantics are now unambiguous: 14 days, once, per Stripe customer.
- The enforcement contract is a pure function of the subscription row —
  unit-testable without any network or scheduler.

### Negative

- A payer in transient card trouble loses paid capacity until they settle
  or re-pay; no automatic grace. Accepted as the conservative default,
  revisit if churn metrics demand it.
- One more webhook event type (`invoice.payment_failed`) is processed;
  Stripe can send it repeatedly per failed attempt — dedup handles it.

### Compliance and Security Implications

- Enforcement of entitlements now tracks payment reality; no change to
  PII handling (event payloads are read for `customer` id only).
- Webhook path remains signature-verified (existing `constructEvent`
  gate); no new unauthenticated surface.

### Migration and Monitoring Plan

- Ship read-side first (enforcement + checkout), which takes effect
  immediately for the community edition (no subscribers, no status rows
  beyond `active` free-plan defaults — behaviour unchanged).
- On the Cloud, the first `invoice.payment_failed` begins exercising the
  new path; monitor the existing webhook logs and `tenant_subscriptions`
  status distribution.
- Success metrics: Team checkouts complete; `past_due` rows appear within
  seconds of a failed invoice; no pager from tenants over free limits.
- Rollback: revert is a code revert — the read-side helper and schema
  widening have no data migration, so rollback is a deploy, nothing more.

### Validation

- Unit tests: effective-plan mapping for every status; trial-once checkout
  call shape; Team plan resolution and checkout; route-level team
  acceptance and rejection of un-sellable plans.
- Integration: existing billing webhook tests extended with
  `invoice.payment_failed`; full `ci:backend` and `ci:frontend` gates must
  pass before merge.

---

_This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs should be consistent with the ADR series starting at `docs/adr/0001-project-architecture.md`. Template: `.claude/skills/adr/template.md`._
