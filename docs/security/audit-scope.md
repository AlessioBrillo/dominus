# Third-party security audit — scope and rules of engagement

**Status: not started.** The decision on record is that the audit happens
**before** the paid tiers are enabled, not after (ADR-0090, ADR-0094).
This document is what the auditor receives first; the report goes back
into `docs/security/` with a filename containing `external` or
`third-party`, which is what `npm run launch:check -- --paid` looks for.

It is written to be usable as the statement of work. If the auditor
proposes a different scope, the difference is negotiated in writing and
this file is updated; the four areas below are the minimum, not a menu.

---

## 1. The system in one page

DOMINUS is a domain-investment decision-support application. Two editions
share the same codebase:

| Edition | Runtime | Identity | Data |
|---|---|---|---|
| Community | one Node.js process, SQLite in WAL mode | one static `API_KEYS` value or none | one operator's portfolio |
| Cloud | api + worker + scheduler, PostgreSQL 16 with RLS, Redis | database-backed API keys or OIDC (Auth0-compatible) | many tenants, one database |

The Cloud is the paid service. The attack surface that matters is the
one that is new in the Cloud: the tenant boundary, the managed identity,
the public anonymous namespace, the billing webhook, and the data-rights
endpoints. The scoring engine and the provider integrations are the
product's core but are not the audit's centre of gravity; they are in
scope only where a malicious input reaches them from an untrusted
surface.

### Trust boundaries

```
 Internet
    │
    ├── /public/*            anonymous, rate-limited, no session
    ├── /api/v1/*            API key or OIDC session, tenant-scoped
    ├── /api/v1/webhooks/*   Stripe signature, unauthenticated route
    └── /api/health          unauthenticated, no upstream dependencies
    │
 Caddy ──► api  ──► PostgreSQL (RLS, app role ≠ owner)
             │
             ├── Redis (queue, rate limits, locks — availability, not trust)
             ├── worker (job payloads from the queue)
             └── scheduler (cron, enqueues jobs)
```

The two invariants the audit exists to test:

1. **No tenant can read or write another tenant's rows**, through the
   API, through a job payload, through an export, or through a bug in the
   RLS policy. The application connects as `dominus_app`, which is
   neither a superuser nor `BYPASSRLS`, and every tenant-scoped query runs
   inside `runWithTenant`; the owner role is used only for migrations.
2. **No unauthenticated caller can make the service spend money,
   exfiltrate data, or poison a shared cache.** The public namespace is
   the only surface a stranger reaches, and it has its own budget,
   rate limits and cache.

---

## 2. In scope

### 2.1 Tenant isolation and the data layer

- `src/db/` — the tenant context, `runWithTenant`, the repositories, the
  RLS policies and the migration that creates them.
- The `dominus_app` role: `NOSUPERUSER`, `NOBYPASSRLS`, table grants,
  `FORCE ROW LEVEL SECURITY` on every tenant table.
- Connection pooling: a connection returned to the pool must not leak a
  tenant context to the next request. Look for `SET`/`reset` behaviour,
  transaction-scoped settings, and error paths that skip the reset.
- Cross-tenant paths that are legitimate and must be proven legitimate:
  the operator CLI (`keys create`, `tenant`), the scheduler, the Stripe
  webhook, and the public scoring cache.
- Data-rights endpoints: `GET /api/v1/tenant/export`,
  `DELETE /api/v1/tenant`, the confirmation token, and the guarantee that
  erasure touches only the calling tenant.

### 2.2 Authentication, session and CSRF

- API keys: storage (scrypt hash, no plaintext), comparison, rotation,
  revocation, scope/role checks, timing behaviour.
- OIDC: `/api/v1/auth/oidc/*`, PKCE S256, state HMAC, the transient
  cookie, the session JWT (HS256 pinned, HKDF-derived key), logout and
  key rotation.
- CSRF: which cookie-authenticated routes are state-changing, which
  carry a CSRF token, and whether `SameSite` is actually enforced on the
  paths that need it.
- The invitation/seat boundary: a valid IdP user without a seat must not
  become a tenant member.
- Rate limiting on the auth routes, and the proxy-depth configuration
  (`TRUST_PROXY_DEPTH`) that decides what "per-IP" means.

### 2.3 The public namespace

- `/public/*`: domain validation, input size limits, normalization, and
  the paths that reach the scoring engine.
- `AnonScoringService`: the cache key, the shared cache, the anonymous
  budget gate, and whether one caller can exhaust another's capacity.
- The trademark gate's budget and fail-closed behaviour: an unavailable
  source must never produce a `clear` verdict or a buy recommendation.
- The sitemap and the cache keys derived from `Host`: Host-header
  poisoning of canonical/OG/sitemap URLs (ADR-0030, C3).
- The `robots.txt`, `IndexNow` key file, and the public HTML/JSON
  renderers: escaping, JSON-LD injection, and the legal footer.
- The `/public/scores` POST: body limits, content type, error shape, and
  whether an error leaks an internal path or a stack.

### 2.4 Billing and the Stripe webhook

- `src/services/billing-service.ts` and the webhook route: signature
  verification, raw-body handling, idempotency (event id), replay, and
  the mapping from a Stripe price id to a plan — the plan must never be
  read from session metadata (ADR-0093).
- Checkout: `automatic_tax`, the billing address, the VAT id, the
  art. 59(1)(o) consent, and the success/cancel redirects.
- The customer portal and subscription state: who can open it, what a
  stale event does, and what happens when Stripe is unreachable.
- Secrets: the webhook secret, the live/test separation, and the
  `BILLING_NOT_CONFIGURED` fail-closed path.

### 2.5 Operations and the release path

- The launch gate (`scripts/launch-check.mjs`): can a failed deployment
  still be declared launchable? Are the checks reading the environment
  they claim to read?
- The acceptance suite (`scripts/acceptance/cloud-acceptance.mjs`) and
  the rehearsal (`scripts/launch-rehearse.mjs`): do they assert the
  property or only the happy path?
- Secret handling: `.env` rendering in cloud-init, Terraform state,
  logs, error messages, the evidence files. A secret must never appear in
  an artifact that is attached to a release.
- Backup and restore: the base backup, the WAL archive, the restore
  drill, and the access control on the B2 bucket.
- The deploy pipeline: migrate-before-roll, the migration gate, the
  approval on `production`, and the image pinning.

### 2.6 Supply chain

- `npm audit` on the root and the frontend, the lockfile, and the
  provenance/trusted-publishing configuration.
- The Docker base images and the pinned digests.
- The GitHub Actions workflows: third-party actions pinned by SHA, the
  token permissions, and the release path's ability to publish.

---

## 3. Out of scope

| Area | Why |
|---|---|
| the correctness of the scoring model, the comps data and the buy thresholds | a product and financial question, not a security boundary; the conservatism rules are in the ADRs |
| the internal security of RDAP, WHOIS, USPTO, EUIPO, Stripe, Hetzner and Backblaze B2 | third parties; the audit covers how DOMINUS calls them and what it does with an answer |
| the legal text, the fiscal position and the DPA | a lawyer's and an accountant's review, tracked separately in the launch checklist |
| the React UI's visual design and WCAG conformance | covered by the a11y gate, not by a security audit |
| a penetration test of the Hetzner network or the host OS | infrastructure hardening is in `deploy/terraform`; a host-level test is a separate engagement |
| the community edition's single-operator deployment | the Cloud is the paid surface; the community edition shares the code but not the multi-tenant boundary |

If the auditor finds a critical issue in an out-of-scope area while
working, it is reported anyway. Scope is a priority, not a gag.

---

## 4. Rules of engagement

1. **Staging, not production.** The target is the staging deployment
   described in [first-apply.md](../deployment/first-apply.md), with its
   own domain, database and B2 bucket. Production data is never used.
2. **Test accounts are provided.** Two tenants, one admin and one member
   per tenant, one expired invitation, one revoked API key, one Stripe
   test-mode subscription. The fixtures are created by the operator
   before the engagement and destroyed after it.
3. **No denial of service against shared infrastructure.** Rate-limit
   testing is coordinated and bounded; the staging nodes are disposable
   but the domain and the alerting are not.
4. **No social engineering, no physical access, no third-party
   accounts.** The engagement is remote and application-level.
5. **Findings are reported as they are found** if they are critical
   (remote code execution, cross-tenant read/write, authentication
   bypass, live secret exposure). The operator acknowledges within one
   business day and decides on a fix or a documented acceptance.
6. **A retest is part of the engagement.** The report is not closed until
   every critical and high finding has been retested on the fixed
   deployment.
7. **Confidentiality.** The report and the evidence are confidential
   until the operator publishes a summary; the public summary may redact
   exploit detail but not the finding or its severity.

---

## 5. Deliverables

| # | Deliverable | Format |
|---|---|---|
| 1 | Findings report | Markdown or PDF, one section per finding: severity, affected component, reproduction, impact, recommendation, evidence |
| 2 | Severity summary | Critical / High / Medium / Low / Informational, with counts and the remediation owner |
| 3 | Retest report | the same findings, with pass/fail on the fixed deployment |
| 4 | Executive summary | one page, publishable after redaction |
| 5 | Raw evidence | requests/responses, logs and screenshots, in a private archive |

The report lands in `docs/security/audit-YYYY-MM-external.md` (or a
filename containing `third-party`). The launch gate reads the directory:
a file matching `audit-.*external.*\.md` or
`audit-.*third-party.*\.md` is the evidence that the paid precondition
is met.

Severity is CVSS-style but judged by exploitability in this system, not
by a generic score: a cross-tenant read is Critical even if it needs an
authenticated account, because the whole product promise is isolation.

---

## 6. The evidence pack

Send the auditor, in this order:

1. this document;
2. [audit-2026-08.md](audit-2026-08.md) — the first-party review of the
   same surface; it is the starting point, not a substitute;
3. the architecture record: ADR-0038 (RLS), ADR-0047 (app role),
   ADR-0053 (billing), ADR-0062 (OIDC), ADR-0090 (legal surface),
   ADR-0093 (plan from price id), ADR-0095 (acceptance suite),
   ADR-0100 (launch gate and evidence);
4. the latest `launch-evidence-*.json` and `.md` from staging;
5. `.acceptance/report.json` from the Cloud acceptance suite;
6. the restore-drill output and the measured RTO/RPO;
7. the deployed commit and the image digests;
8. the list of test accounts and their roles (not their passwords; the
   operator creates them on the day).

The auditor can reproduce the application half without credentials:

```bash
npm ci
npm run acceptance:cloud     # Docker required
npm run launch:rehearse      # gate + evidence against the stack
```

The infrastructure half needs the staging credentials, which are shared
through the operator's secret store for the duration of the engagement,
rotated afterwards, and never sent by email.

---

## 7. Selection and schedule

The auditor is selected on three criteria, in order:

1. **PostgreSQL RLS and multi-tenant isolation experience.** This is the
   finding that would end the product; a generic web-app auditor is not
   enough. Ask for a redacted report that covers a comparable boundary.
2. **Node.js/TypeScript and OIDC fluency.** The session and CSRF design
   is where the second-tier findings live.
3. **Availability within the launch window and a fixed price.** A
   time-and-materials engagement with no end date is a launch blocker of
   its own.

A realistic engagement for this surface is **5–10 person-days plus a
retest day**, with the report two weeks after kick-off. The exact price
is a market question; the scope above is what is being bought.

The sequence is:

```
staging green (gate + acceptance + restore drill)
        │
        ▼
audit kick-off ──► findings ──► fixes ──► retest ──► report on file
                                                        │
                                                        ▼
                                   launch:check --paid is green
                                                        │
                                                        ▼
                                             paid tiers enabled
```

If the audit finds a Critical or High issue that cannot be fixed before
the launch window, the paid launch moves. The community soft launch does
not depend on the audit and is not blocked by it: the community edition
has no multi-tenant boundary and no payment surface
([soft-launch-community.md](../releases/soft-launch-community.md)).

---

## 8. What "done" looks like

- [ ] the engagement letter names this scope and these rules;
- [ ] the auditor has the evidence pack and a working staging account;
- [ ] the findings report is in `docs/security/` with the right filename;
- [ ] every Critical and High finding is fixed and retested;
- [ ] every Medium is fixed or accepted in writing, with an ADR if the
      acceptance is a design decision;
- [ ] `npm run launch:check -- --cloud --url https://… --paid` is green;
- [ ] the executive summary is publishable and the public claims match
      it.
