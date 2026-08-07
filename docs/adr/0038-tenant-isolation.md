# ADR-0038: Multi-Tenant Tenant Isolation Model

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-07 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0027, ADR-0030, ADR-0031, ADR-0032, ADR-0034 |
| **Project** | DOMINUS |

## Context

DOMINUS Cloud is a shared-schema multi-tenant PostgreSQL deployment (ADR-0034).
Every entity table carries a `tenant_id` column, repositories append
`tenant_id = ?` filters, and the request middleware scopes each query to the
authenticated tenant through `app.tenant_id` on a per-connection lease
(PostgresAdapter `#withConnection`), backed by a `tenant_isolation_*`
Row-Level Security policy created in migration `0030_enable_rls`.

The existing model has one coarse-grained security hole: PostgreSQL applyies
RLS enforcement **only to non-owner roles unless `FORCE ROW LEVEL SECURITY` is
set on the table**. The application pool connects with a single privileged
credential, which in practice is the database owner (or a superuser created
by `POSTGRES_USER` in the prod Compose overlay). Under that wiring the policy
is a no-op for the connecting role, and tenant isolation rests *entirely* on
the discipline of repository-level `WHERE tenant_id = ?` clauses — a single
missed filter in new code (or a buggy JOIN in a future query) becomes a
cross-tenant data exposure with no database-layer backstop.

This ADR closes that hole: make the database enforce isolation even when the
application executes as the table owner, and stop giving the application a
role that can bypass RLS.

## Decision Drivers

1. **Security by default** — isolation must be enforced by the database, not
   hoped for in every application query; a new feature that forgets its filter
   must fail closed, not silently leak.
2. **Least privilege** — the runtime should never connect as a superuser or
   as a role that can run DDL/DCL (`CREATE ROLE`, `GRANT`), limiting the blast
   radius of any SQL-injection or compromised-credential incident.
3. **Ops simplicity** — the change must not require per-tenant databases,
   schema rewrites, or a migration of row data; it must be deployable onto the
   existing shared-schema layout with the existing migration runner.

## Considered Options

### Option A: FORCE ROW LEVEL SECURITY + dedicated non-superuser app role

Enable `FORCE ROW LEVEL SECURITY` on every tenant-scoped table (new migration
0047) so the existing `tenant_isolation_*` policy applies **to the table owner
as well**, and provision a dedicated `dominus_app` login role
(`deploy/postgres/init-app-role.sh`) with `USAGE`/`CREATE` on the schema and
table/sequence DML grants. Default privileges (`ALTER DEFAULT PRIVILEGES`)
make future migration-created tables automatically grantable to the app role.
The app `DATABASE_URL` switches to `dominus_app`; the superuser/admin user is
only used for migrations and operations.

**Advantages:**
- Isolation is enforced at the DB layer for the app role and the owner both.
- Least-privilege: a compromised app credential cannot `CREATE ROLE`, cannot
  modify other schema objects, cannot read another tenant directly.
- Reuses the existing policy + tenant-scoping entirely; small migration.

**Disadvantages:**
- Requires ownership on the entity tables for `ALTER TABLE ... FORCE` (fresh
  deploys created by the app role are fine; pre-existing tables may need
  `ALTER TABLE ... OWNER TO dominus_app`).
- `pg_dump` of app-backed backups must still run with a permitted role.
- Two credentials to manage in each tenant environment.

**Cost Implications:** one extra migration, one init script, a few Devops env
vars. No runtime performance cost.

**Risk Assessment:** low technical risk; the main operational migration risk
is role/ownership ordering on existing databases, mitigated by a documented
init script and validation test.

---

### Option B: Keep single owner/superuser pool, rely on application filters

Retain the current wiring: owner-level connection, app-scoped `tenant_id`
clauses in every repository, RLS policy only protecting non-owner roles.

**Advantages:**
- Zero migration, zero infra change; nothing to re-provision.
- Simpler credential story.

**Disadvantages:**
- No database-layer backstop: a missed `tenant_id` filter is a cross-tenant
  leak, with no failure line at query time.
- Connection operates with maximal privileges; the blast radius of SQL
  injection is the whole database.

**Cost Implications:** none.

**Risk Assessment:** High — this is precisely the gap the decision addresses.
A single regression in a query-building repo changes the attack surface of
every tenant's data.

---

### Option C: Force RLS but keep the app role as table owner

Pair `FORCE ROW LEVEL SECURITY` with the current single connection, where one
role both owns the tables and runs the app.

**Advantages:**
- Gives the owner-protection benefit of RLS enforcement.

**Disadvantages:**
- The app role then needs `CREATE`/DDL on the schema (migrations) — so it is
  already half-privileged; a SQL-injection still lets the attacker `CREATE
  TABLE`, `DROP`, or read via `pg_read_file` paths.
- Does not reach the least-privilege goal of the decision drives.

**Cost Implications:** same migration cost as Option A.

**Risk Assessment:** Medium — improved isolation, but weaker than A on
credential compromise containment.

---

## Decision

**Chosen option: Option A (FORCE ROW LEVEL SECURITY + dedicated app role).**

Option A turns the isolation guarantee into a database-enforced invariant and
aligns with least privilege. The decisive argument is asymmetric risk: with
Option B the cost of a single missing `tenant_id` filter is a cross-tenant
breach — a legal/PR event whose cost far outweighs the one-time
role-provisioning work of A. Option A also preserves the existing mechanism:
the tenant-scoped `#withConnection` + policy path does not change; we only
force the policy so it applies to tables the app owns and connect with a role
that cannot bypass RLS.

The `public_scores` table stays on the same FORCE + policy mechanism (its
policy additionally admits the `'public'` tenant for anonymous reads); the
public SEO surface is unchanged.

## Consequences

### Positive
- Cross-tenant reads/writes and row access are prevented by PostgreSQL even
  when the application runs with full table ownership.
- The application runs with the least privileges needed; a compromised app
  credential cannot create roles or schema in other tenants' tables.
- New feature code gets a DB-level safety net, so a missed repository filter
  fails closed (empty result) rather than leaking.

### Negative
- Two credentials per environment (the migrations/admin user and the app
  role), and existing deployments must reassign table ownership to
  `dominus_app` if the schema was originally built under a different user.
- RLS evaluation adds a per-row predicate over `current_setting('app.tenant_id')`
  to tenant-scoped queries; the connection-cached indexing impact is low.

### Compliance and Security Implications
- Tenant isolation becomes a provable database property, supporting DPAs
  and audit evidence for the Cloud product's tenancy boundary.
- Superusers still bypass RLS: ops must never point `DATABASE_URL` at a
  login role with `rolsuper = true`; the `init-app-role.sh` bootstrap and
  the `.env.example` documented model enforce that.

### Migration and Monitoring Plan
- Phase 1: land migration 0047 (no-op on SQLite, FORCE on PG) + the init
  script + compose volume mount.
- Phase 2: for environments with existing PG data, run one manual DDL step to
  assign ownership of tenant tables to `dominus_app` (documented).
- Phase 3: switch `DATABASE_URL` to the `dominus_app` connection in the prod
  compose / .env; restart; verify health + a tenant-scoped smoke query.
- Rollback plan: `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY` per table
  restores pre-change behaviour; the app role remains valid either way.
- Monitoring success: `npm run test:integration` (with DATABASE_URL) runs the
  RLS isolation suite; Prometheus has no change; watch for an increase in
  'no rows' errors for each service (fail-closed is expected at a stable
  baseline).

### Validation
- `src/db/provider/__tests__/rls-isolation.pg.test.ts` (opt-in via
  DATABASE_URL) asserts: (1) a cross-tenant SELECT returns nothing when run
  as a non-superuser with FORCE + policy; (2) every tenant-scoped table in a
  migrated database has `relforcerowsecurity = true`.
- Production smoke: sign in under two tenants, confirm no rows from the other
  tenant appear in portfolio/outcomes/keys.

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs
should be consistent with the ADR series starting at
`docs/adr/0001-project-architecture.md`.*