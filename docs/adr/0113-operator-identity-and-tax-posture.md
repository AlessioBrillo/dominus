# ADR-0113: Registered sole trader, ordinary VAT, at first launch

## Metadata

| Field          | Value                       |
| -------------- | --------------------------- |
| **Status**     | Accepted                    |
| **Date**       | 2026-11-25                  |
| **Authors**    | Alessio Brillo              |
| **Deciders**   | Alessio Brillo, accountant  |
| **Supersedes** | —                           |
| **Relates to** | ADR-0108, ADR-0109, ADR-0111 |

## Context

The legal surface was drafted for an Italian S.r.l., and the launch-readiness
document records that as an assumption. No company has been incorporated.
The code already distinguishes `individual`, `sole_trader` and `company` in
`src/services/legal-identity.ts`: paid mode refuses `individual` because a
natural person cannot issue the invoice a subscription needs, accepts
`sole_trader`, and refuses `company` combined with the forfettario regime.
The billing path — `automatic_tax`, inclusive prices, VAT-ID collection and
reverse charge — is written and verified in test mode for the ordinary
regime. Switching tax regime after launch would require re-verifying all
three scenarios and republishing the legal text.

## Decision

1. The first paid operator is an Italian **registered sole trader**
   (`LEGAL_ENTITY_KIND=sole_trader`) under the **ordinary VAT regime**
   (`LEGAL_VAT_REGIME=ordinary`), with OSS registration when EU B2C sales
   cross the threshold.
2. An S.r.l. is formed only after roughly €50k of annual recurring revenue
   or when liability containment becomes necessary. The forfettario regime
   is revisited in a separate ADR: it lowers accounting cost but produces
   VAT-free invoices that business customers cannot use for deduction, and
   it would require re-verifying Stripe Tax.
3. The published price remains the total payable, with VAT included where it
   applies and reverse charge for validated EU VAT IDs (ADR-0111). No
   separate net price is shown to businesses.

## Considered alternatives

| Alternative | Why rejected |
| ----------- | ------------ |
| Form an S.r.l. before the first customer | Notary and annual accounting costs arrive before any revenue; the code does not require a company. |
| Start with forfettario | Cheaper, but invoices without VAT are a friction for the B2B part of the ICP and invalidate the tested tax scenario evidence. |
| Keep `individual` and issue manual receipts | The paid gate deliberately refuses it; bypassing the gate would publish an invoice-less subscription. |

## Consequences

- No code change is required: the identity is configuration and the legal
  documents are generated from it.
- The accountant must confirm OSS, the invoice series and the reverse-charge
  wording before the paid launch; the launch gate still refuses `--paid`
  without the identity.
- The three Stripe scenarios in `billing-tax-verification.md` remain the
  authoritative evidence for this posture.
