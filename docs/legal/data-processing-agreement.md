# Data processing agreement (GDPR art. 28) — template

**Status: template, not yet executed.** The fields marked `[●]` are filled by
the operator before the agreement is signed. This is the processor agreement
for DOMINUS Cloud: the customer is the controller, DOMINUS Cloud is the
processor.

The sub-processor list and the technical measures below are the ones the
service actually implements; the retention periods are the defaults of the
configuration and can be tightened by the operator in the appendix.

> The commercial review of this document is open work. It is written against
> art. 28 GDPR and the Italian Consumer Code, and it is published as a
> starting point for the accountant and the lawyer, not as a final contract.
> See ADR-0090 for why the legal texts ship without a formal review, and
> `docs/releases/cloud-launch-readiness.md` for the launch blockers.

---

## Parties

- **Controller**: `[●]` (the customer), `[● address]`
- **Processor**: `[●]` (the operator of DOMINUS Cloud), `[● address]`,
  `[● VAT ID]`, `[● PEC]`
- **Contact for data protection matters**: `[●]`

## 1. Subject matter and duration

The processor makes available to the controller the DOMINUS Cloud service:
domain valuation, portfolio tracking, renewal verdicts and, when explicitly
enabled, the post-acquisition automation pipeline. The agreement starts when
the service is provisioned and ends when the service is cancelled and the
data has been deleted or returned, as described in section 6.

## 2. Nature and purpose of the processing

The processor processes personal data on behalf of the controller solely to
provide the service, on the controller's instructions:

| Purpose | Data | Art. 6(1) basis |
|---|---|---|
| Authentication and access control | email address, API key metadata, session tokens, SSO identifiers | art. 6(1)(b) — the contract with the controller |
| Team administration | team membership, seat allocation, invitation records | art. 6(1)(b) |
| Usage metering and plan enforcement | number of pipeline runs and API calls per tenant | art. 6(1)(b) |
| Billing and accounting | customer identifier, invoice and tax details, payment records | art. 6(1)(c) — legal obligation |
| Service operation | the domains, candidates, scores, portfolio entries, listings, automation journals | art. 6(1)(b) |
| Automated actions audit | the automation journal and audit trail | art. 6(1)(b) and (f) — legitimate interest in evidencing automated actions |
| Security and diagnostics | IP address, request identifiers, user agent, error traces | art. 6(1)(f) — legitimate interest in operating and securing the service |

## 3. Categories of data subjects and personal data

- **Categories of data subjects**: the controller's users, team members and
  invited users; the persons designated as contacts in the service
  configuration.
- **Categories of personal data**: identification and contact data
  (email address, name, role), authentication data, usage and billing data,
  and the business data the controller enters into the service (which may
  itself contain personal data, for example when a domain portfolio records
  the contact of a counterparty).

The controller is responsible for the lawfulness of the personal data it
enters into the service.

## 4. Sub-processors

The processor engages the following sub-processors, which are bound by
written agreements that impose data protection obligations no less
protective than those in this agreement:

| Sub-processor | Purpose | Location |
|---|---|---|
| Hetzner Online GmbH | Hosting of the application and the database | Germany |
| Backblaze Inc. | Off-host backup storage (when enabled) | United States |
| Stripe Payments Europe Ltd. | Subscription billing and tax calculation | Ireland / United States |
| Okta, Inc. (Auth0) | Single sign-on (when used) | United States |
| The controller's SMTP provider | Delivery of the team invitations | As configured by the controller |

Transfers outside the European Union are covered by the European Commission's
standard contractual clauses and, where the recipient is certified, the
EU-US Data Privacy Framework.

The processor informs the controller of any intended change to this list and
gives the controller the opportunity to object. The current list is published
in the privacy notice of the deployment.

## 5. Security measures

Technical and organisational measures, implemented in the service:

- TLS for data in transit; encryption at rest for the provider credentials
  held in the tenant credential vault;
- tenant isolation enforced in the database with row-level security, not
  only in the application, with the application role separated from the
  database owner;
- append-only audit trail of the automated actions, with a bounded retention;
- daily backups with point-in-time recovery, and a documented restore drill;
- request correlation identifiers, structured logs without payload content,
  and per-tenant fair-share rate limits;
- no third-party analytics, advertising or tracking in the web interface.

## 6. Return and deletion

At the end of the agreement, and on the controller's request, the processor
returns or deletes the personal data, unless the law requires retention
(invoices are kept for the period required by tax and accounting law).

Two limits are declared and accepted by the controller:

- **Backups.** Deletion does not reach copies that are part of a rolling
  backup window of about thirty days; those copies are overwritten by the
  rotation and are not restored except in a disaster, in which case the
  deletion is re-applied after the restore.
- **Invoices and accounting records.** Records required by law are kept for
  the statutory period and are not deleted on request.

The controller can exercise the export and deletion functions of the API
itself; the processor provides them on request for the remaining cases.

## 7. Assistance to the controller

The processor assists the controller, taking into account the nature of the
processing, in responding to data-subject requests, in the security
obligations of art. 32, and in the assessment of the impact of a
high-risk processing operation.

## 8. Audit

The processor makes available the information necessary to demonstrate
compliance with art. 28 and art. 32, and allows audits, including
inspections, conducted by the controller or by an auditor mandated by the
controller, on reasonable notice and not more than once per year unless a
personal data breach or a supervisory authority requires more.

## 9. Liability

Liability between the parties is governed by the Terms of Service of
DOMINUS Cloud, without prejudice to the mandatory provisions of applicable
law.

## 10. Governing law and jurisdiction

Italian law. The jurisdiction provisions of the Terms of Service apply.

---

## Appendix — configuration the operator may tighten

| Setting | Default |
|---|---|
| `AUTOMATION_AUDIT_RETENTION_DAYS` | 90 |
| `PUBLIC_SCORES_RETENTION_DAYS` | 90 |
| `EVENTS_RETENTION_DAYS` | 180 |
| `BACKUP_RETENTION_DAYS` | 30 |

## Appendix — records of processing activities (art. 30)

The processor keeps its own record of processing activities for the service
and makes it available to the controller on request.
