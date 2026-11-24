# ADR-0111: One inclusive price for the hosted plan

## Metadata

| Field          | Value                                   |
| -------------- | --------------------------------------- |
| **Status**     | Accepted                                |
| **Date**       | 2026-11-24                              |
| **Authors**    | Alessio Brillo                          |
| **Deciders**   | Alessio Brillo                          |
| **Supersedes** | the launch pricing table of ADR-0026    |
| **Relates to** | ADR-0025, ADR-0026, ADR-0108, ADR-0109   |

## Context

ADR-0026 described a three-tier hosted shop (Free, Pro, Team) with prices
shown net of VAT. Two problems appeared when the front door was built:

1. A consumer-facing price in the EU must be the price the customer pays. The
   old UI multiplied the net figure by 22% for consumers and showed a
   different figure for businesses, so the same product had two published
   prices. The landing copy — "VAT 22% included — €29 + VAT for business" —
   was read as a contradiction by a reasonable buyer.
2. The intended customer has 50–500 domains. The old Pro plan tracked 250,
   forcing that customer to buy a ten-seat Team plan to track 400 domains.
   The packaging axis was wrong: the scarce resource is portfolio size, not
   the number of humans in the workspace.

There are no paying customers yet. Two visible tiers without a single
customer add copy, Stripe prices and support obligations without producing
evidence about willingness to pay.

## Decision

1. One hosted self-service plan at launch: **€29 per month, total payable**.
   The published figure already contains VAT where it applies. Stripe Prices
   are created with `tax_behavior: 'inclusive'`; a validated VAT ID moves the
   invoice to reverse charge without changing the amount paid.
2. Pro tracks **500 domains** (not 250) and scores 500 candidates per month,
   with 3 seats and 5 machine keys. Team and Enterprise are not sold
   self-service; dedicated infrastructure is arranged by agreement.
3. The self-hosted community edition remains unlimited and free. The hosted
   free tier is an evaluation: 25 appraisals and 5 tracked domains per month.
   The upgrade trigger is the portfolio and its history, not a punitive cap
   on reading a single score.
4. No percentage launch discount. A founding annual price may be locked for
   the first 50 customers; annual billing stays at ten monthly payments.
5. The paid path remains off until the operator identity and fiscal position
   exist (ADR-0108). This ADR fixes the shape of the price, not the decision
   to open checkout.

## Consequences

- The landing page shows one hosted price and one community option. The
  "€29 + VAT for business" line disappears, and the method of displaying the
  price no longer depends on guessing the operator's VAT regime.
- Net revenue per consumer sale is €23.77 before Stripe fees at the 22% rate;
  any future ARPU target must be met by volume or by a different list price,
  not by a hidden net figure.
- A paying annual customer prepays €290; a monthly customer pays €29.
- Usage metering and the enforcement path remain unchanged: only a plan
  limit and the public copy move.
