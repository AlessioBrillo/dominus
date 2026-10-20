# ADR-0093: The granted plan is derived from the price, not from the metadata

## Metadata

| Field          | Value                                                     |
| -------------- | --------------------------------------------------------- |
| **Status**     | Accepted                                                  |
| **Date**       | 2026-10-20                                                |
| **Authors**    | Alessio Brillo                                            |
| **Deciders**   | Alessio Brillo                                            |
| **Supersedes** | —                                                         |
| **Relates to** | ADR-0053, ADR-0090                                        |
| **Project**    | DOMINUS                                                   |

## Context

When a checkout completes, Stripe sends `checkout.session.completed` and the
handler decides which plan the tenant has bought. The handler read the plan
from `session.metadata.plan`, and used the price id — when it had one — only
to look up a negotiated "custom price".

Two problems, both invisible until the paid tiers were about to open:

1. **The price id was usually not there.** Stripe does not include
   `line_items` in the `checkout.session.completed` payload unless the
   session is retrieved with `expand: ['line_items']`. The handler never
   expanded it. So the price id was `undefined` on the normal path, and the
   branch that verified the custom price — tenant match and amount match —
   was dead code. The verification that the first-party security review
   called "operator-config error only, not exploitable by clients" was, in
   practice, not running.
2. **The plan was not derived from what was paid.** The plan came from a
   metadata field the server wrote at checkout creation. A client cannot
   forge it, but a misconfigured price id grants a plan the customer did not
   pay for, and nothing in the handler compared the two.

The subscription lifecycle events (`customer.subscription.created/updated`)
already derived the plan from the price id. The two paths disagreed, and the
one that granted the entitlement first was the weaker one.

## Decision Drivers

1. **The grant must follow the payment.** A plan is a claim about money;
   the price id is the receipt. Everything else is a copy of it.
2. **A failure must not grant.** An unknown price id is an operator
   configuration error, and the correct answer to it is "no entitlement",
   not "a default plan".
3. **The negotiated prices must be verified.** The custom-price path exists
   for a reason: a tenant on a negotiated price must pay that price.
4. **The webhook must not retry forever.** An event that can never succeed
   must not hold the claim open.

## Considered Options

### Option A: Keep trusting `session.metadata.plan`

**Advantages:** no change.

**Disadvantages:** the plan and the payment are two independent statements,
and only one of them is a receipt. The custom-price verification does not
run.

### Option B: Read the price id from the event payload only

**Advantages:** one lookup, no extra API call.

**Disadvantages:** the payload does not carry the price id. The branch would
still be dead code.

### Option C: Retrieve the session with the line items expanded, and derive the plan from the price

**Advantages:** the price id is authoritative and always available; the
custom-price verification becomes reachable; the plan and the receipt cannot
disagree.

**Disadvantages:** one extra Stripe API call per completed checkout.

## Decision

**Option C.**

- The price id is read from the event payload when it is there, and
  otherwise by retrieving the session with
  `stripe.checkout.sessions.retrieve(session.id, { expand: ['line_items.data.price'] })`.
  A retrieval failure is logged and the handler falls back to the metadata
  path, so a Stripe outage cannot block a subscription that Stripe has
  already confirmed.
- The plan is derived with the existing `resolvePlanForPriceId(priceId,
  tenantId)` — the same resolution the subscription lifecycle events use.
  One helper, one truth.
- An unresolvable price id grants **nothing**: the handler logs the event
  id, the tenant id and the price id, and returns. It does not throw, so
  Stripe does not retry a permanently unknown price id forever, and the
  event claim is not held open.
- The custom-price verification is unchanged in intent and now reachable:
  the tenant must match, and `amount_total` must equal the expected amount,
  or the grant is refused.

## Consequences

### Positive

- The entitlement follows the payment.
- A misconfigured price id cannot grant a plan.
- The negotiated-price verification actually runs.
- The two webhook paths agree on how a plan is determined.

### Negative

- One extra Stripe API call per completed checkout. It happens once per
  subscription, on a path that is not latency-sensitive.
- A Stripe API failure at that moment falls back to the metadata path, so
  the grant is still possible in that narrow window. The fallback is logged.
- A price id that is configured for a plan that has been retired now grants
  nothing instead of the previous plan. That is the intended behaviour, and
  it surfaces as a warning in the logs.

## Links

- `src/services/billing-service.ts` — the handler and the price resolution.
- `src/services/__tests__/billing-service.test.ts` — the plan-derivation
  cases.
- `docs/security/audit-2026-08.md` — the first-party review that flagged the
  metadata trust.
