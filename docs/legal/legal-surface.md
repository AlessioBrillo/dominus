# The legal surface

DOMINUS publishes three documents - the legal notice, the terms of service
and the privacy notice - and links them from every page it serves. This page
explains what is published, who publishes it, and what the operator has to
configure.

The decision behind this design is [ADR-0090](../adr/0090-legal-surface-and-launch-gate.md).

## What is published

| Document | Route | Content |
|---|---|---|
| Legal notice | `/legal-notice` | The operator's identity and the commercial information art. 7 of D.Lgs. 70/2003 requires: name and legal form, registered address, VAT ID, business register number and office, certified email, contacts. |
| Terms of service | `/terms` | The contract: what the service is, acceptable use, the trademark gate, automated actions, payments and taxes, the right of withdrawal, liability, governing law. While the hosted edition is a waitlist, the paid clauses are explicitly dormant. |
| Privacy notice | `/privacy` | The controller, the data and the legal bases, the sub-processors and the transfers, cookies and browser storage, the retention table, the data-subject rights, the security measures. |
| The whole set, as data | `GET /public/legal` | The same content, structured, with `mode`, `status`, `version`, `updatedAt` and the identity. Unauthenticated, so it is readable by anyone and by the crawlers. |

The server-rendered public pages (`/public/domain/:domain`,
`/public/for-sale/:domain`, `/public/compare/...`) carry the operator
identity and the three links in their footer. The signed-in SPA carries the
same links in the application footer. Immediate reachability from every page
is the standard art. 7 applies; a link buried in a terms page is not that.

A fourth document, the data processing agreement (art. 28 GDPR) for business
customers, is **not published yet**. It is a precondition of the paid launch,
not of the community edition: it must be complete with annexes and signature
blocks before `CLOUD_PAID_ENABLED` is turned on.

## Three service states, not one

The deployment publishes **different documents** depending on what it is:

- **DOMINUS Cloud, paid** (`CLOUD_PAID_ENABLED=true`): the commercial
  contract, the operator identity, the payments, the consumer withdrawal
  rules and the business reverse charge. The server refuses to boot unless
  the identity is a complete registered business (`sole_trader` or `company`
  with VAT ID, register office, REA number and PEC).
- **DOMINUS Cloud, waitlist** (cloud topology, `CLOUD_PAID_ENABLED=false`):
  the website and the waitlist. No price is an offer, no checkout is active,
  no workspace is created through self-serve signup, and the paid clauses
  are dormant. A Stripe key in the environment does not change this.
- **The self-hosted community edition**: what applies to a deployment run by
  whoever installed it - the AGPL licence, the fact that the data never
  leaves the machine, and the fact that the Cloud commercial terms do not
  apply. The operator identity is **not** published: the deployer is the
  data controller, not the DOMINUS authors.

## What the operator must configure

The identity is configuration, not code. Set these variables in the
deployment (see `.env.example`):

| Variable | Meaning |
|---|---|
| `LEGAL_ENTITY_NAME` | Registered name of the operator. |
| `LEGAL_ENTITY_KIND` | `individual`, `sole_trader` or `company`. |
| `LEGAL_REGISTERED_ADDRESS` | The registered address, as it must appear. |
| `LEGAL_VAT_ID` | VAT identification number (Partita IVA). Business entities only. |
| `LEGAL_REGISTRO_IMPRESE` | Register office, e.g. "Registro Imprese di Roma". Business entities only. |
| `LEGAL_REA_NUMBER` | Business register number. Business entities only. |
| `LEGAL_PEC` | Certified electronic address. Business entities only. |
| `LEGAL_VAT_REGIME` | `ordinary`, `forfettario` or `none`; changes how prices are described. |
| `LEGAL_CONTACT_EMAIL` | General contact address. |
| `LEGAL_PRIVACY_EMAIL` | Address for data-subject requests. |
| `LEGAL_SUPERVISORY_AUTHORITY` | Supervisory authority; defaults to the Italian Garante. |
| `SECURITY_CONTACT_EMAIL` | Contact published in `/.well-known/security.txt`; falls back to the privacy and legal contacts. |

The profiles differ:

- an **individual** publishes name, address and contacts. That is enough for
  the project website and the waitlist, and it can never enable the paid
  service;
- a **sole trader** or a **company** also publishes VAT ID, register office,
  REA number and PEC. A paid Cloud refuses to boot while any of them is
  missing or still a placeholder.

A placeholder is treated as a missing value: a published notice with
`privacy@dominus.example` looks compliant without being so, which is worse
than an absent one.

## The two checks

- **Repository guardrail** - `npm run check:legal-placeholders`, part of
  `npm run gate`. Fails when a placeholder reaches the published text, when
  the notice stops rendering an identity field, when a required clause
  (withdrawal and pro-rata, reverse charge, e-invoicing, sub-processors,
  transfer safeguards, supervisory authority, the art. 1341 specific
  approval, the "not an appraisal" disclaimer) is removed, when the
  art. 59(1)(o) waiver reappears, when the waitlist mode stops closing
  checkout or signup, when the public pages stop carrying the footer, or
  when an identity variable leaves the configuration or `.env.example`.
- **Deployment gate** - `npm run launch:check`, run against a live
  deployment. It applies the same rules to the real configured values, and
  `--paid` (or `CLOUD_PAID_ENABLED=true`) makes the paid identity
  requirements hard failures instead of warnings.

## Changing the text

The documents are in `src/services/legal-content.ts`, as structured sections.
Changing them means changing the data, not the components: the same text is
rendered by the SPA and by the server-rendered pages. The text is English
only; there is no Italian version, and the documents say that the English
text is the only binding version.

After changing the text, bump `LEGAL_DOCUMENTS_UPDATED_AT` in the same file.
The version served to the SPA and the effective date shown on the legal
pages come from that constant, so a document and its date cannot drift apart.

## Known limits

The texts are written without formal legal review, as ADR-0090 records. The
open points are tracked in the ADR and must be closed before the paid launch:
the operator's registration (Registro Imprese, REA, PEC, Partita IVA), the
VAT regime confirmed by the accountant, the data processing agreement with
its annexes, and the transfer impact assessments for the US sub-processors.
