# The legal surface

DOMINUS publishes three documents — the legal notice, the terms of service
and the privacy notice — and links them from every page it serves. This page
explains what is published, who publishes it, and what the operator has to
configure.

The decision behind this design is [ADR-0090](../adr/0090-legal-surface-and-launch-gate.md).

## What is published

| Document | Route | Content |
|---|---|---|
| Legal notice | `/legal-notice` | The operator's identity and the commercial information art. 7 of D.Lgs. 70/2003 requires: name, registered address, VAT ID, business register number, certified email, contacts. |
| Terms of service | `/terms` | The contract: what the service is, acceptable use, the trademark gate, automated actions, payments and taxes, the right of withdrawal, liability, governing law. |
| Privacy notice | `/privacy` | The controller, the data and the legal bases, the sub-processors and the transfers, cookies, the retention table, the data-subject rights, the security measures. |
| The whole set, as data | `GET /public/legal` | The same content, structured. Unauthenticated, so it is readable by anyone and by the crawlers. |

The server-rendered public pages (`/public/domain/:domain`,
`/public/for-sale/:domain`, `/public/compare/…`) carry the operator identity
and the three links in their footer. Immediate reachability from every page
is the standard art. 7 applies; a link buried in a terms page is not that.

## Two sets of documents, not one

The deployment publishes **different documents** depending on what it is:

- **DOMINUS Cloud** (`CLOUD_MODE=true`, i.e. PostgreSQL or a managed identity
  provider): the commercial contract, the operator identity, the payments and
  the withdrawal rules.
- **The self-hosted community edition**: what applies to a deployment run by
  whoever installed it — the AGPL licence, the fact that the data never
  leaves the machine, and the fact that the Cloud commercial terms do not
  apply. The operator identity is **not** published: the deployer is the
  data controller, not the DOMINUS authors.

## What the operator must configure

The identity is configuration, not code. Set these variables in the
deployment (see `.env.example`):

| Variable | Meaning |
|---|---|
| `LEGAL_ENTITY_NAME` | Registered name of the operator. |
| `LEGAL_ENTITY_KIND` | `individual` or `company`. |
| `LEGAL_REGISTERED_ADDRESS` | The registered address, as it must appear. |
| `LEGAL_VAT_ID` | VAT identification number (Partita IVA). |
| `LEGAL_REA_NUMBER` | Business register number — companies only. |
| `LEGAL_PEC` | Certified electronic address — companies only. |
| `LEGAL_CONTACT_EMAIL` | General contact address. |
| `LEGAL_PRIVACY_EMAIL` | Address for data-subject requests. |
| `LEGAL_SUPERVISORY_AUTHORITY` | Supervisory authority; defaults to the Italian Garante. |

Until they are set, a cloud deployment starts with a warning and the launch
gate refuses to call it launchable. A placeholder is treated as a missing
value: a published notice with `privacy@dominus.example` looks compliant
without being so, which is worse than an absent one.

## The two checks

- **Repository guardrail** — `npm run check:legal-placeholders`, part of
  `npm run gate`. Fails when a placeholder reaches the published text, when
  the notice stops rendering an identity field, when a required clause
  (withdrawal, reverse charge, sub-processors, supervisory authority) is
  removed, when the public pages stop carrying the footer, or when an
  identity variable leaves the configuration or `.env.example`.
- **Deployment gate** — the launch gate, run against a live deployment. It
  applies the same rules to the real configured values and checks the rest
  of the launch checklist.

## Changing the text

The documents are in `src/services/legal-content.ts`, as structured sections.
Changing them means changing the data, not the components: the same text is
rendered by the SPA and by the server-rendered pages, and the i18n increment
planned for v1.4.0 will translate it as a catalogue.

After changing the text, bump `LEGAL_DOCUMENTS_UPDATED_AT` in the same file.
The launch gate warns when the published notice is older than the staleness
threshold it is given.
