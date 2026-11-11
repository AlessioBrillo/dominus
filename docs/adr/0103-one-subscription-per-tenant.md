# ADR-0103: One subscription per tenant, and the plan comes only from the price

## Metadata

| Field          | Value                                                                 |
|----------------|-----------------------------------------------------------------------|
| **Status**     | Accepted                                                              |
| **Date**       | 2026-11-11                                                            |
| **Authors**    | Alessio Brillo                                                        |
| **Deciders**   | Alessio Brillo                                                        |
| **Supersedes** | -                                                                     |
| **Relates to** | ADR-0053, ADR-0093, ADR-0026                                          |
| **Project**    | DOMINUS                                                               |

## Context

The billing surface was built around one Stripe Checkout session per
purchase, and the local subscription row followed the payment provider
through the webhook. Three defects followed from that shape, and none of
them was visible in the automated acceptance suite, which only exercised a
single `checkout.session.completed` event.

1. **A plan change created a second subscription.** The only way to buy a
   different plan was another Checkout session. Stripe creates a *new*
   subscription for a customer who already has one: the customer ended up
   with two active subscriptions and two invoices, and the local row
   followed whichever event arrived last. This is the most expensive defect
   a subscription product can ship: it takes money from a customer who
   believes they paid for one plan.

2. **The plan could be granted from the session metadata.** ADR-0093
   established that the plan is derived from the Stripe price id, because
   the metadata is written by us and proves nothing about what was paid.
   The implementation nevertheless fell back to `session.metadata.plan`
   when the price id could not be resolved - and defaulted to `pro` when
   even that was missing. The fallback was reachable exactly when Stripe
   was unreachable, which is when granting the wrong plan is most
   expensive.

3. **The subscription event could be lost.** Stripe delivers
   `customer.subscription.created` and `customer.subscription.updated`
   *before* `checkout.session.completed` often enough that the tenant
   could not be identified: the subscription carried no tenant metadata,
   and the local row (which held the Stripe customer id) did not exist
   yet. The event was logged as "Subscription event for unknown customer"
   and dropped. The plan, the trial end and the period boundaries were
   then missing until the next event.

4. **The erasure did not stop the invoice.** `DELETE /api/v1/tenant`
   removed the rows of a tenant, including the local subscription row. The
   invoice is issued by Stripe, so a customer who deleted their account
   kept being charged for a service they had cancelled.

## Decision

1. **A tenant has at most one Stripe subscription, and it is mutated in
   place.** `POST /api/v1/billing/subscription` with `action: "change"`
   replaces the price item on the existing subscription and lets Stripe
   prorate the difference (`proration_behavior: create_prorations`).
   `action: "cancel"` cancels immediately or at the end of the period.
   A tenant without a subscription is answered `NO_SUBSCRIPTION`: the
   checkout remains the only way to start one.

2. **The plan is granted only from a price id that maps to a plan.** The
   metadata fallback is removed. When the price id cannot be *resolved*
   (a transient failure), the event is released and Stripe redelivers it;
   when the price id resolves to *no known plan*, nothing is granted and
   the event is acknowledged. The two failures are different and are
   treated differently on purpose: one is worth a retry, the other is a
   decision.

3. **The subscription carries the tenant.** The checkout writes
   `subscription_data.metadata = { tenantId, plan }`, so every
   `customer.subscription.*` event identifies the tenant without depending
   on the customer lookup. An event that arrives before the checkout event
   creates the local row instead of being dropped.

4. **The status mapping is fail-closed.** Only `active` and `trialing`
   grant the paid plan. `unpaid` and `paused` are recorded as `past_due`;
   an unknown status is recorded as `incomplete`, which grants nothing.

5. **The erasure cancels the subscription first.** The data-subject
   deletion calls the billing service before it deletes the rows. A
   cancellation failure never blocks the erasure (a data-subject right is
   not held hostage by a third party), but the report says so
   (`subscriptionCancelled: false`) and the CLI writes it to stderr.

## Consequences

### Positive

- A customer who switches plan keeps one subscription and one invoice.
- The plan a customer pays for is the plan the price id says it is; the
  metadata cannot grant a plan.
- A subscription event is never lost to an ordering race.
- A tenant that erases its account stops being invoiced.

### Negative / trade-offs

- The local row follows the webhook: between the Stripe mutation and the
  event there is a window of a few seconds in which the old plan is still
  enforced. The window is short and the direction is conservative (the
  customer is served the plan they had, not the one they bought).
- A plan change needs one extra Stripe call (the subscription is
  retrieved to learn its price item id).
- The erasure can now fail to cancel the subscription, which the operator
  has to follow up. The alternative - blocking the erasure - would let a
  third party hold a data-subject right hostage.

### When this is revisited

If the product ever sells metadd-on seats (a subscription plus
per-seat items), the one-subscription-per-tenant rule needs an explicit
answer: several items on one subscription, or several subscriptions with
a clear ownership rule.
