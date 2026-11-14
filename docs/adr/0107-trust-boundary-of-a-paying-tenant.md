# ADR-0107: The trust boundary of a paying tenant

## Metadata

| Field          | Value                                                                 |
|----------------|-----------------------------------------------------------------------|
| **Status**     | Accepted                                                              |
| **Date**       | 2026-11-12                                                            |
| **Authors**    | Alessio Brillo                                                        |
| **Deciders**   | Alessio Brillo                                                        |
| **Supersedes** | -                                                                     |
| **Relates to** | ADR-0038, ADR-0034, ADR-0104, ADR-0106, ADR-0018, ADR-0023          |
| **Project**    | DOMINUS                                                               |

## Context

The community edition of DOMINUS is a single-tenant engine: the operator
runs it, and the database holds their data. The Cloud edition is a
shared-schema multi-tenant deployment, and every row carries a `tenant_id`.

The trust boundary of the Cloud is the set of places where the isolation
between two customers can fail. A scan of that boundary before the public
launch found four gaps, each of them on a path a stranger walks in the
first minutes of the product.

### 1. The signup handed a workspace to whoever typed the address

`POST /api/v1/auth/register` accepted an optional email address, created
the owner seat **with that address as the user identifier**, and returned
an admin API key. The single-sign-on resolver then re-linked the seat to
the first identity-provider subject that presented the same address
(`IdentityTenantResolver.resolve`).

The two halves together are a pre-account takeover:

1. somebody registers `colleague@company.com` and receives an admin key on
   a workspace that carries their colleague's address;
2. the colleague signs in with single sign-on, their address is verified by
   the identity provider, the seat is re-linked to their subject, and they
   land in that workspace — while the first writer keeps a working key.

The verification of the identity provider proves that the *colleague* owns
the mailbox. It proves nothing about who wrote the address down. The
address was never proven, and the seat was claimable anyway.

### 2. The scheduled jobs ran outside any tenant

The scheduler defines the jobs of the platform (the renewal check, the
portfolio rescore, the watchlist poll, the prune). The repositories
resolve the tenant from the ambient context (`resolveTenantId()`), and the
scheduler never opened one: it fell back to `'default'`, a tenant that
belongs to nobody. In the Cloud, the automation of every customer was a
silent no-op — and the operator's channels received the alerts.

### 3. The isolation was 15 tables out of 32, and it failed open

The registry of the tenant-scoped tables knew 32 tables; the row-level
security policies of migration 0030 covered 15. The other 17 relied on the
repository filter alone.

Worse, the policy itself failed open: `tenant_id = COALESCE(
current_setting('app.tenant_id', true), 'default')`. A query made outside
a tenant context did not fail — it read and wrote the rows of the
`'default'` tenant. A missing context was invisible.

### 4. The alerts of a customer went to the operator

The notification channels were built once from the operator's environment
(`NOTIFIER_WEBHOOK_URL`, `NOTIFIER_TELEGRAM_*`, `NOTIFIER_EMAIL_TO`).
Every alert of every tenant went to the operator: the customer never heard
about the renewal of their own domain, and the operator received data that
is not theirs.

## Decision Drivers

1. **A stranger must not be able to take a workspace** — not by guessing
   an address, not by being the first to type it.
2. **A missing tenant context must fail closed** — the database must be
   the backstop of the isolation, not a witness of it.
3. **The work of the platform must be the work of the customers** — the
   renewal of a customer's domain must be checked, and told, to that
   customer.
4. **One queue, many customers** — the queue is shared, the isolation and
   the fairness are not negotiable.

## Decision

### The email address is proven before the workspace exists

The signup creates the tenant, the subscription and a **pending** seat, and
**no API key**. A single-use token is emailed to the address; opening the
link consumes the token (once), activates the seat, records that the
address is proven, **revokes every key issued before the proof**, and
issues a fresh one.

The revocation is what closes the loop in both directions: a workspace
created with somebody else's address cannot be claimed by that somebody
while the first writer keeps a working key.

The identity resolver only re-links a seat whose address is **verified**.
An unverified seat is never claimable through single sign-on, and when
several workspaces share one verified address, **none** of them is linked:
"the most recent one" is a coin toss, and the wrong choice silently moves
a person into somebody else's workspace.

`SIGNUP_EMAIL_VERIFICATION=optional` exists for the deployments with no
mail transport (a private beta, the acceptance stack): the key is issued
immediately and the seat stays unverified, so the takeover stays closed
either way. The default is `required`, and a deployment in that mode
**refuses to create a workspace** when no mail transport is configured: a
workspace whose verification link can never be delivered is a workspace
nobody can use.

The lost API key is replaced through the same mechanism (`/auth/recover`):
the key is shown exactly once, only its hash is stored, and the endpoints
that ask for a link always answer the same, so they are not an oracle
about which mailboxes have an account.

### The scheduled jobs run once per tenant

Every job that touches tenant data is declared `tenant-scoped`. The
scheduler enumerates the tenants and runs the job **inside the tenant
context**, once per tenant, collecting the failures: one customer that
breaks does not stop the others. The jobs of the platform (the backup, the
PITR health check, the weight tuner) stay global and run once.

The tenant of a queued job is a **column** (`job_queue.tenant_id`), not a
field of the payload: a per-tenant depth cap cannot be expressed against a
JSON blob, the erasure cannot remove the work of an account, and the
scheduler cannot enumerate the tenants it has to run for.

Two defects sat on this path and are fixed here: the scheduler entrypoint
never called `start()` (the catalogue was built but the cron timers were
never armed, so the platform automation never ran for anybody), and the
condition that separates "define the catalogue" from "arm the timers" was
inverted.

### The queue is fair

Two caps: a tenant may not have more than `JOB_QUEUE_MAX_DEPTH_PER_TENANT`
jobs pending, and may not occupy more than `WORKER_MAX_RUNNING_PER_TENANT`
workers at the same time. One customer with a thousand queued jobs no
longer keeps every worker busy while the others wait.

### The isolation is complete and it fails closed

The registry of the tenant-scoped tables now classifies every table:

- `rls` — the boundary is the database. The policy is
  `tenant_id = current_setting('app.tenant_id', true)::TEXT`: with no
  tenant context the row is invisible, and an INSERT that does not belong
  to the current tenant raises a policy violation instead of landing
  somewhere else. The seven tenant tables that had no policy at all are
  covered now.
- `control-plane` — the boundary is the repository: the tables that must
  be read before a tenant context exists (the auth tables, the billing
  rows) or that are shared by the platform (the queue, the operator's own
  tables).

The classification is asserted by a test, against the migration that
installs the policies: a table cannot be declared RLS-protected without a
policy, and a policy cannot exist without the declaration.

The `public_scores` table keeps its public read (the anonymous SEO surface
reads it with the `'public'` tenant).

### The alerts of a customer go to the customer

The channels of a tenant live in `tenant_notification_settings` (email,
webhook URL, Telegram chat). The webhook URL is a bearer secret: it is
encrypted with the operator master key, in the same envelope as the
credential vault, and it is never returned by the API.

The notifier chain is **tenant-scoped**: with a tenant context (an API
request, a worker job, a per-tenant scheduled job) the alert goes to that
tenant's channels and to nobody else; without one, the operator's channels
are used, exactly as before. The console always logs the alert: that is
the server log, and the operator is the processor of it.

### The operator surfaces are operator surfaces

The queue is global: its stats and its dead letters are the work of every
customer, and a dead letter carries the job type and the error of
somebody else's job. `/api/v1/system/worker` is behind the operator
role, like `/api/v1/scheduler` (the scheduler drives the work of every
tenant) and `/api/v1/admin`.

## Consequences

### Positive

- A stranger cannot take a workspace: the address must be proven, the proof
  invalidates the credentials issued before it, and an unverified seat is
  never claimable through single sign-on.
- The automation of a customer works: the renewal check, the rescore, the
  watchlist poll and the prune run for that customer, and the result
  reaches them.
- A missing tenant context is an error, not a silent write to a phantom
  tenant: the isolation is enforced by the database on 22 tables.
- The erasure of an account removes its queued work: the payloads carry
  the domains of the customer.
- One customer cannot starve the others.

### Negative

- The self-serve signup needs a mail transport. A deployment without one
  cannot have a self-serve signup (the mode `optional` exists, and it
  keeps the takeover closed, but the seat is never linked to a single
  sign-on identity).
- The P&L report reads the outcomes per request instead of a snapshot
  taken at boot: one query more per report, and the report is finally
  about the customer who asked for it.
- The migration 0070 recreates the policies of 15 tables: on an existing
  deployment the policies are rewritten, and the queries that ran outside a
  tenant context (there were two) stop seeing rows. That is the point, and
  it is the reason the P&L snapshot had to go first.

### Compliance and Security Implications

- The data-subject erasure covers the queue: the registry lists the queue
  tables, and the tenant of a job is a column.
- The operator no longer receives the alerts of the customers: the
  personal data of a customer does not leave the channels of that
  customer.
- The identity of the owner of a workspace is provable: the proof is the
  click on a link that only the owner of the mailbox receives.

## Validation

- `src/services/__tests__/email-verification-service.test.ts` — the
  activation, the single use of the token, the revocation of the keys
  issued before the proof, the recovery, the expiry.
- `src/services/__tests__/identity-tenant-resolver.test.ts` — an
  unverified seat is **not** linked, a verified one is, an address shared
  by several workspaces links none.
- `src/scheduler/__tests__/scheduler-tenant-scope.test.ts` — a
  tenant-scoped job runs once per tenant, inside the tenant context, and a
  failing tenant does not stop the others.
- `src/scheduler/__tests__/scheduler-timers.test.ts` — the cron timers are
  armed by `start()` and not by `registerJobs()`.
- `src/scheduler/__tests__/scheduler-entrypoint.test.ts` — the scheduler
  process arms the timers and exits cleanly on shutdown.
- `src/app/__tests__/job-queue-tenant.test.ts` — the tenant column, the
  per-tenant depth cap, the per-tenant worker cap, the erasure.
- `src/app/__tests__/job-queue-tenant.test.ts` and
  `src/db/__tests__/postgres-tenant-statements.pg.test.ts` — the same
  statements on SQLite and on PostgreSQL: the two dialects do not agree on
  the type of a bound parameter, and the Cloud only runs PostgreSQL.
- `src/services/__tests__/tenant-notification-service.test.ts` — the
  webhook is encrypted, the channels of a tenant do not leak into another
  one, the operator's channels stay silent for a tenant alert.
- `src/db/__tests__/tenant-data-registry.test.ts` — the classification
  matches the migration.
- `src/db/provider/__tests__/rls-isolation.pg.test.ts` — the cross-tenant
  queries on PostgreSQL.
- `npm run acceptance:cloud` — the journey of a paying customer on the
  production-parity stack: the signup is inert until the emailed link is
  opened, the link works once, the key of the verified workspace works,
  the erasure removes the queued work, the notification channels belong to
  their tenant, and the scheduler surface is not a tenant surface.

## Links

- [ADR-0038: Multi-Tenant Tenant Isolation Model](0038-tenant-isolation.md)
- [ADR-0104: Identity continuity across signup and single sign-on](0104-identity-continuity-signup-and-sso.md)
- [ADR-0106: The launch posture of the SaaS surface](0106-launch-posture-of-the-saas-surface.md)

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs
should be consistent with the ADR series starting at
`docs/adr/0001-project-architecture.md`.*
