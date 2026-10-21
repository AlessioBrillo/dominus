# ADR-0095: The Cloud acceptance suite: production parity before the first paid deployment

## Metadata

| Field          | Value                                                     |
| -------------- | --------------------------------------------------------- |
| **Status**     | Accepted                                                  |
| **Date**       | 2026-10-20                                                |
| **Authors**    | Alessio Brillo                                            |
| **Deciders**   | Alessio Brillo                                            |
| **Supersedes** | —                                                         |
| **Relates to** | ADR-0038, ADR-0054, ADR-0061, ADR-0090, ADR-0091, ADR-0094 |
| **Project**    | DOMINUS                                                   |

## Context

The Cloud edition had never been exercised as a running system before
the paid launch. What existed was:

- a **SQLite** test suite (thousands of tests) and a SQLite Playwright
  suite: the community topology, where a single tenant sees everything and
  the database has no row-level security;
- a **PostgreSQL** test job that runs the repository and adapter tests
  against a real PostgreSQL: the dialect, the migrations and the RLS
  policies, but no running application;
- a **docker smoke** that booted the community stack and one endpoint of
  the production overlay;
- a Terraform stack that had never been applied (ADR-0094).

Between them, those gates covered every component and none of the
system. The things that only exist in the Cloud — a non-superuser
application role behind `FORCE ROW LEVEL SECURITY`, a job queue shared by
three processes through Redis, a tenant resolved from an API key, a
Stripe webhook that grants a plan, a usage meter that rejects a tenant
over its limit, a GDPR erasure — were each covered by a unit test in
isolation, and none of them had ever run together.

That is the shape of the failure this ADR closes. A multi-tenant SaaS
does not fail because a unit test is wrong; it fails because two correct
components disagree about who the caller is.

## Decision Drivers

1. **The paid launch needs evidence, not confidence.** The launch
   checklist asks for a restore drill, an external probe and an audit. A
   drill on a stack that has never run is a rehearsal of a rehearsal.
2. **A test that cannot fail is not a test.** The suite must assert the
   behaviour that matters (isolation, entitlements, erasure) and not the
   behaviour that is easy to assert (the process starts, the port is
   open).
3. **The environment must be the production one.** A SQLite acceptance
   run would pass while the Cloud is broken; a mock acceptance run would
   pass while the real tenant resolution is broken.
4. **The suite must not become a second implementation.** Re-implementing
   the scoring engine or the provider contracts in a test harness creates
   a second thing to maintain and a second thing to be wrong.
5. **It must run before a deployment exists, not after.** The point of an
   acceptance suite is to change the deployment, not to explain it.

## Considered Options

### Option A: keep the unit and integration suites, and rehearse on staging

**Advantages:** no new harness; the production stack is the environment.

**Disadvantages:** the rehearsal happens on the infrastructure the paid
customers will use, and only after it exists — the first apply of the
Terraform, the first migration on the real database, the first webhook
are all first-time events. It also cannot run on every pull request, so
a regression is found in staging instead of in the branch.

### Option B: a full end-to-end suite of the real providers (live DNS, RDAP, USPTO, EUIPO)

**Advantages:** the strongest possible evidence.

**Disadvantages:** the suite becomes non-deterministic and rate-limited:
a live trademark lookup changes the outcome over time, a DNS timeout
turns a green build red for reasons that have nothing to do with the
code, and the run becomes slow enough that nobody runs it. It also
duplicates the provider contract tests that already exist.

### Option C: a production-parity stack with deterministic fixtures

**Advantages:** the topology is the real one (PostgreSQL with RLS, the
non-superuser app role, Redis, the api/worker/scheduler split, the real
images built from the working tree); the assertions are about the wiring
that only the Cloud has; the run is deterministic and fast enough for
every pull request.

**Disadvantages:** it is another topology to maintain, and the boundaries
have to be stated out loud — a suite that claims more than it proves is
worse than no suite.

### Option D: no automated Cloud evidence; rely on the external audit

**Advantages:** no harness to maintain.

**Disadvantages:** the audit is a point-in-time review of the code, not a
statement that the system works. It is also the most expensive step in
the launch, and it is scheduled last: by the time the auditor arrives,
the interesting questions ("does the tenant actually see only its own
rows?") should already have answers.

## Decision

**Option C.** A Cloud acceptance suite (`npm run acceptance:cloud`) that
builds the working tree's images, starts PostgreSQL with the production
init script, applies the migrations as the **owner** role, starts the
api, the worker and the scheduler against the **app** role, and then
asserts:

- **tenant isolation at the API level** — each tenant lists only its own
  rows, and a write against another tenant's row is a 404;
- **tenant isolation at the database level** — the application role sees
  no row without a tenant context, exactly one row with its own, and is
  neither a superuser nor `BYPASSRLS`; the RLS policies are enabled
  *and* forced;
- **the Stripe webhook** — a signed `checkout.session.completed` grants
  the plan, the replay is a no-op, and a tampered signature is refused;
- **the plan and usage surface**;
- **GDPR art. 15 and art. 17** — the export contains the tenant's data,
  the erasure removes it and touches nothing else, and the confirmation
  must match;
- **the metrics token** — unauthenticated is refused, authenticated is
  not;
- **the public legal surface**;
- **the scheduler → queue → worker path** — a job enqueued by the
  scheduler is completed by the worker;
- **the SPA against the same data** — three browser smokes: a tenant
  signs in and sees its own portfolio and not the other tenant's, the
  second tenant sees the other side of the isolation, and the billing
  page shows the plan the webhook granted.

The suite states its boundaries as explicitly as its assertions, because
the boundaries are the work list for the phases that follow:

| Covered here                                   | Not covered here                              | Covered by                          |
| ---------------------------------------------- | ---------------------------------------------- | ----------------------------------- |
| PostgreSQL, RLS, the app role, Redis           | the real DNS/RDAP/trademark providers          | the provider suites; one staging run |
| the api/worker/scheduler split                  | the interactive SSO login and the CSRF guard    | a manual smoke with a real IdP      |
| the Stripe webhook, the plan, the usage meter  | the Stripe tax engine and SCA                  | the test-mode matrix in billing-tax-verification.md |
| the GDPR export and erasure                    | the point-in-time recovery                     | the staging restore drill (ADR-0054) |
| the SPA against tenant-scoped data              | the TLS terminator, the monitoring stack        | the Terraform apply and the probe  |

The suite runs in CI on every pull request (Linux), and locally on
demand. It is deliberately **not** part of `npm run gate`: the gate is
the fast feedback loop, and the acceptance suite needs Docker and a few
minutes.

## Consequences

### Positive

- The first paid deployment is not the first time the Cloud topology
  runs. The isolation guarantees, the entitlements and the erasure are
  proven before a customer exists, and the proof is a command.
- The suite is the evidence the launch checklist asks for, and the same
  suite can be re-run against a candidate image to prove that a release
  candidate is the thing that was tested.
- The boundaries of the automated evidence are written down, so the
  staging phase and the audit start from a list instead of from a
  hypothesis.

### Negative

- A second topology to maintain: a compose file, a runner and a browser
  project. A drift between it and the production compose file is
  possible — the acceptance stack deliberately does not try to be the
  production stack (no TLS, no monitoring, no backups); it is the
  *data* topology that is reproduced, and the rest is covered by the
  Terraform apply.
- The suite does not run on Windows in CI (Docker on a Windows runner is
  a different platform); it runs on Linux and locally on Docker Desktop.
- The RLS assertions depend on the PostgreSQL version's behaviour around
  `current_setting(..., true)`; the policy falls back to the `default`
  tenant when the GUC is unset, so "no tenant context" is asserted as
  "no rows for the `default` tenant" — which is the behaviour, not an
  accident of the fixture.

### Neutral

- The suite does not replace the external audit, and it does not
  replace the staging restore drill. It replaces the *unknown* with a
  *known*, which is what the audit and the drill are then pointed at.

## Links

- [ADR-0038](../adr/0038-tenant-isolation.md) — the tenant isolation
  model the RLS assertions check.
- [ADR-0038](../adr/0038-usage-enforcement.md) — the plan limits the usage
  meter enforces.
- [ADR-0054](../adr/0054-pitr-backup-strategy.md) — the restore drill
  that stays outside the suite.
- [ADR-0090](../adr/0090-legal-surface-and-launch-gate.md) — the legal
  surface the public pages serve.
- [ADR-0091](../adr/0091-verified-published-artifact.md) — the same
  principle applied to the published artifact.
- [ADR-0094](../adr/0094-launch-posture-single-replica-external-probe.md) —
  the launch posture this suite produces evidence for.
- `scripts/acceptance/cloud-acceptance.mjs` — the suite.
- `docs/releases/cloud-acceptance.md` — how to run it, what it proves and
  what it does not.
