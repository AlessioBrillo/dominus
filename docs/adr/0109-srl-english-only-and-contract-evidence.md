# ADR-0109: S.r.l. operator, English-only binding text, and first-party contract evidence

> **Note (2026-11-27):** the operator form decided here is superseded by
> ADR-0118 (registered sole trader). The English-only language decision and
> the first-party contract-evidence decision remain in force.

## Metadata

| Field          | Value                                                                   |
| -------------- | ----------------------------------------------------------------------- |
| **Status**     | Partially superseded by ADR-0118 (operator form only)                   |
| **Date**       | 2026-11-23                                                              |
| **Authors**    | Alessio Brillo                                                          |
| **Deciders**   | Alessio Brillo                                                          |
| **Supersedes** | part of ADR-0090 (language prevalence) and the pricing table of ADR-0026 |
| **Relates to** | ADR-0090, ADR-0103, ADR-0106, ADR-0108                                  |

## Context

The managed edition can take money, but for most of its life the project had
no registered operator and no durable evidence that a customer accepted the
terms. Three defects followed:

1. A self-hosted "Community" card on the landing page advertised Cloud
   Free-tier limits, while the README called the self-hosted edition
   unlimited. One word described two different products.
2. The terms promised that a business customer's approval of the clauses that
   limit its rights (art. 1341 c.c.) was "collected separately at checkout";
   the checkout had one Stripe checkbox and no first-party record.
3. The data processing agreement was published as a Markdown template with
   `[●]` fields and was simultaneously described as incorporated into the
   paid terms. A blank form is not an agreement.

The owner decided that the operator will be an Italian **S.r.l.** and that the
**English text is the only binding version** of the legal documents.

## Decision

### Operator and tax posture

The Cloud operator is a company, so `LEGAL_ENTITY_KIND=company` and
`LEGAL_VAT_REGIME=ordinary`. The Italian forfettario regime is reserved to
natural persons (art. 1, commi 54-89, L. 190/2014) and is refused at boot for a
company (`validateIdentity` in `legal-identity.ts`). The legal notice
publishes the exact legal form, share capital, Registro Imprese, REA and PEC
required by art. 2250 c.c. and art. 7 D.Lgs. 70/2003. The paid terms keep the
reverse charge for EU businesses and require the SDI destination code or PEC
before the first electronic invoice.

### Language

The English text is the only binding version of all three documents. This
closes the contradiction in ADR-0090, which had described an Italian version
as prevailing. An Italian courtesy version of the legal notice and the privacy
notice is **recommended but not implemented**: an Italian consumer buying from
an Italian company may need clear information under art. 33 and art. 49 of the
Consumer Code and art. 12 GDPR. The residual risk is accepted here and must be
confirmed by counsel before the paid launch.

### Contract evidence

A new append-only ledger, `contract_acceptances`, records four distinct acts:
acceptance of the terms at signup, acceptance of the terms at checkout, the
express request for immediate performance (art. 57(3) Consumer Code), and the
specific approval of sections 13, 14 and 17 for business customers
(art. 1341 c.c.). Each record stores the document version and the SHA-256 of
the published text, so the exact words accepted can be reproduced. The entity
kind and the VAT regime are validated across fields; a company cannot boot
with forfettario. Stripe's own checkbox is only the matching disclosure — the
ledger is the authoritative evidence.

The data processing agreement is generated at request time from the operator
identity and the published sub-processor list and served at `/public/dpa`.
Without a complete identity the route returns 404; a template with blanks is
never served as an agreement.

### Public presentation

The landing page describes the self-hosted edition without Cloud limits; the
paid tier is named "Cloud Free" in the application. The product performs a
**trademark screening**, never a "clearance". For-sale pages emit a schema.org
`Offer` only after DNS TXT proof of control; without it they state that
ownership is unverified. An accessibility statement is published voluntarily;
whether the microenterprise exemption under article 4(5) of Directive (EU)
2019/882 applies depends on the operator and is not asserted by the page.

## Consequences

- A paid checkout cannot start without a matching acceptance of the current
  document version. The version hash is part of the legal content response.
- Signup refuses a registration that the ledger cannot tie to a document
  version.
- The acceptance records are personal data: they are included in the tenant
  erasure path and listed in the tenant-data registry as control-plane.
- Two guardrails run in the gate: `check:legal-placeholders` and
  `check-public-claims`. They cover placeholders, forbidden claims, the
  art. 59(1)(o) waiver, the company/forfettario impossibility and the presence
  of the ledger wiring.
- The waitlist is first-party when no external URL is configured: consent
  version, acceptance time and double opt-in are stored in `waitlist_signups`.
- For-sale pages require DNS TXT proof of control before emitting a
  structured `Offer`; the verification token is stored hashed.
- The formal EUIPO/TMview search, the signable DPA review and the SMA/VAT
  confirmation remain human launch blockers, recorded in
  `docs/legal/trademark-search.md` and `docs/legal/compliance-matrix.md`.

## Alternatives considered

- Keeping one checkbox in Stripe and treating the message as consent: rejected,
  because the terms already promised a separate approval and the operator
  cannot export Stripe's record as evidence of a specific document version.
- Publishing the DPA as a static Markdown template: rejected, because a
  document with blank fields cannot be incorporated into a contract.
- Translating the legal text into Italian and making it prevail: rejected by
  the owner; the residual risk is recorded above.
