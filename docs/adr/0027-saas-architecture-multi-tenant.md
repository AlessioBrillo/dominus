# ADR-0027: SaaS Architecture — Multi-Tenancy, Database, and Authentication

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-06-18 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | ADR-0001 (partial — revises database and single-user assumptions), ADR-0005 (partial — extends to PostgreSQL) |
| **Relates to** | ADR-0025, ADR-0026, ADR-0028 |
| **Project** | DOMINUS |

## Context

DOMINUS currently runs on SQLite via `better-sqlite3` with WAL mode — a deliberate choice for the single-user, single-process architecture documented in ADR-0001. This design delivers sub-millisecond queries, zero operational overhead, and a portable database file that can be copied with `cp`.

The SaaS transition (ADR-0026) introduces multi-tenancy: multiple users and teams sharing a managed instance while maintaining strict data isolation. SQLite's single-writer model does not scale to concurrent multi-tenant writes. A new database architecture is required.

Additionally, the current authentication model — a static API key from an environment variable (`API_KEYS`) — does not support user registration, login sessions, tenant resolution, or team management. A full authentication system is needed.

This ADR defines the database architecture, multi-tenancy strategy, and authentication system for DOMINUS Cloud.

## Decision Drivers

1. **Tenant isolation** — One tenant must never be able to access another tenant's data. The isolation mechanism must be enforced at the database level, not just the application layer.

2. **Migration path** — Existing single-user SQLite installations must have a clear, documented migration path to the new architecture. The community edition retains SQLite indefinitely — PostgreSQL is optional for self-hosters.

3. **Community edition compatibility** — The community edition (AGPL, self-hosted) continues to use SQLite as the default database. The codebase must support both SQLite and PostgreSQL without conditional forks or extensive `#ifdef`-style branching.

4. **Solo-maintainer complexity** — The architecture must minimise operational complexity. PostgreSQL is preferred over exotic distributed databases. Schema-per-tenant is preferred over database-per-tenant (simpler connection management).

5. **Cost control** — The free tier of DOMINUS Cloud must be sustainable at €0/month. PostgreSQL hosting costs must be predictable and low at small scales (€10-30/month for the first 100 tenants).

## Considered Options

### Option A: SQLite Per-Tenant

Each tenant gets an isolated SQLite database file stored on a shared filesystem. The application resolves the tenant ID to a file path at connection time.

**Advantages:**
- Maximum isolation — each tenant's data is in a separate file
- No migration pain — existing SQLite code works identically
- Trivial backup — `cp` each database file independently
- No new query patterns — all existing `better-sqlite3` code is reusable
- Horizontal scaling — tenants can be distributed across servers by database file

**Disadvantages:**
- Connection management — each tenant requires a separate `better-sqlite3` connection pool. With 100 concurrent tenants, this is 100 WAL connections.
- File system limits — single filesystem may hit inode limits or IOPS bottlenecks at scale
- No unified querying — cross-tenant analytics (admin reports, usage metrics) require iterating over all database files
- Migration complexity — schema changes must be applied to N database files atomically
- Not cloud-native — no managed SQLite service exists. Self-managed on VPS only.
- Write concurrency per tenant is same as current (single-writer) — limiting for team collaboration features

**Cost Implications:** Zero database service cost. Storage: ~1MB per 1000 domains per tenant.

**Risk Assessment:** Medium. Works well at small scale (<100 tenants). At larger scale, the filesystem and migration issues compound. Not suitable for a managed cloud service with growth ambitions.

---

### Option B: PostgreSQL — Shared Database, Tenant ID Column

A single PostgreSQL instance (or cluster) with all tenant data in shared tables, differentiated by a `tenant_id` column on every table. Row-Level Security (RLS) enforces isolation at the database level.

**Advantages:**
- Industry standard for multi-tenant SaaS — every major cloud provider offers managed PostgreSQL (RDS, Cloud SQL, Supabase)
- RLS provides database-enforced isolation: even if application middleware is compromised, a query without the correct `tenant_id` policy returns zero rows
- Single connection pool shared across tenants — efficient resource usage
- Unified querying for cross-tenant analytics, billing, and admin operations
- Rich ecosystem for backups (pg_dump, pgBarman, WAL archiving), point-in-time recovery
- Scalability path: read replicas → connection pooling (PgBouncer) → sharding

**Disadvantages:**
- Requires porting all 24 SQLite migrations to PostgreSQL DDL
- Query patterns change: `better-sqlite3` synchronous API → `pg` async API
- Existing repositories expect synchronous SQLite queries — a database abstraction layer is needed
- RLS adds a small query overhead per row (measured single-digit microseconds)
- `tenant_id` must be present on every query — forgetting it leaks data to the wrong tenant (mitigated by RLS as defence-in-depth)

**Cost Implications:** Managed PostgreSQL: ~€10-30/month (small instance, sufficient for 100+ tenants). Self-hosted PostgreSQL: €0 (on the same VPS as the application).

**Risk Assessment:** Low. PostgreSQL multi-tenancy is a solved problem with decades of production use. RLS is mature (PostgreSQL 9.5+, now 15+).

---

### Option C: PostgreSQL — Schema-Per-Tenant

A single PostgreSQL database with separate schemas per tenant (`tenant_1`, `tenant_2`, ...). Each schema contains the same set of tables. The `search_path` is set per connection.

**Advantages:**
- Better isolation than column-based: a query without schema qualification cannot accidentally cross tenants
- Schema drop is a single command for tenant deletion (vs. `DELETE FROM ... WHERE tenant_id = ?`)
- Easier to verify isolation in audits — each schema is a self-contained unit
- No RLS performance overhead
- Can be combined with the community edition: SQLite per-tenant locally, PostgreSQL schema-per-tenant in the cloud

**Disadvantages:**
- Migration requires applying DDL to N schemas (solved with dynamic SQL loops)
- Connection management is more complex: each connection has a `search_path` context
- Harder to query across tenants for analytics (requires `UNION ALL` or `information_schema` iteration)
- PostgreSQL has a practical limit of ~10,000 schemas before catalog lookup becomes slow
- Application must manage schema creation/recycling logic

**Cost Implications:** Same as Option B. No additional cost.

**Risk Assessment:** Low-medium. Schema-per-tenant is a common pattern for B2B SaaS with a moderate number of tenants (<1000). At expected DOMINUS scale (hundreds, not thousands of tenants), it is viable.

---

### Option D: Database Abstraction Layer (CHOSEN)

A `DatabaseProvider` interface that abstracts over SQLite and PostgreSQL. The community edition uses SQLite (synchronous, `better-sqlite3`). DOMINUS Cloud uses PostgreSQL (async, `pg` with RLS and tenant-ID column). The composition root (`composition-root.ts`) wires the appropriate implementation.

**Advantages:**
- Single codebase supports both SQLite (community) and PostgreSQL (cloud) without conditional compilation
- Community edition is never forced to adopt PostgreSQL — it remains a lightweight SQLite app
- Cloud edition gets full PostgreSQL benefits (RLS, PITR, managed backups, connection pooling)
- Migration path is documented and incremental: users can stay on SQLite forever
- All existing repository code is preserved — only the database access layer changes
- Testing can use an in-memory SQLite database (as today) for fast CI, with a separate PostgreSQL integration test suite

**Disadvantages:**
- Requires designing and maintaining an abstraction layer that doesn't leak either database's idiosyncrasies
- SQLite and PostgreSQL have subtle SQL dialect differences (JSON functions, date/time handling, `INSERT ... ON CONFLICT` syntax) — the abstraction must normalise these
- Query performance may differ between the two backends — some optimisations are backend-specific
- The abstraction layer adds complexity to what was a simple, direct database access pattern

**Cost Implications:** ~40h development for the abstraction layer + migration of existing repositories. Ongoing maintenance: ~5h/month for dialect compatibility.

**Risk Assessment:** Low. The abstraction layer is isolated to a single `src/db/provider/` module. Existing code continues to work unchanged during the transition.

---

## Decision

**Chosen option: Option D — Database Abstraction Layer with SQLite (community) and PostgreSQL (cloud), tenant-ID column + RLS for DOMINUS Cloud**

The rationale:

1. **Community edition preservation**: SQLite remains the default and only database for the community edition. No user is forced to adopt PostgreSQL. This is critical for ADR-0018 (zero-cost principle) and ADR-0026 (community edition is fully functional).

2. **Single codebase**: The `DatabaseProvider` interface allows the same repository classes to work against both backends. The composition root swaps the implementation. No feature branching, no `#ifdef`-style conditional code.

3. **RLS for defence-in-depth**: Row-Level Security provides a database-enforced isolation guarantee. Even if the application middleware is compromised, a query without the correct `tenant_id` policy returns zero rows. The `tenant_id` column is the application-level fallback — RLS is the safety net.

4. **Proven pattern**: Supabase uses this exact model (SQLite locally via PGlite, PostgreSQL in production). The abstraction layer is well-understood in the Node.js ecosystem.

### Architecture Overview

```
┌─────────────────────────────────────────────────┐
│                   Application                     │
│  ┌───────────────────────────────────────────┐   │
│  │         Composition Root (DI)             │   │
│  │  SQLiteProvider ──┬── PostgreSQLProvider  │   │
│  └───────────────────┼───────────────────────┘   │
│                      │                            │
│  ┌───────────────────┼───────────────────────┐   │
│  │    Repositories   │                       │   │
│  │  (use DatabaseProvider interface)         │   │
│  └───────────────────┼───────────────────────┘   │
│                      │                            │
│         ┌────────────┴────────────┐               │
│         │  DatabaseProvider        │               │
│         │  .query(sql, params)     │               │
│         │  .execute(sql, params)   │               │
│         │  .transaction(callback)  │               │
│         └────────────┬────────────┘               │
│                      │                            │
│         ┌────────────┴────────────┐               │
│         │  Implementation          │               │
│  ┌──────┴──────┐     ┌───────────┴──────┐         │
│  │ SQLiteDB     │     │ PostgreSQLDB     │         │
│  │ (better-     │     │ (pg + RLS)       │         │
│  │  sqlite3)    │     │                  │         │
│  └─────────────┘     └──────────────────┘         │
└─────────────────────────────────────────────────┘
```

### Multi-Tenancy Strategy (DOMINUS Cloud)

| Aspect | Decision |
|--------|----------|
| **Isolation model** | Shared tables + `tenant_id` column on every entity table |
| **Enforcement** | RLS policy on every table: `tenant_id = current_setting('app.tenant_id')` |
| **Tenant context** | Set via `SET app.tenant_id = '<uuid>'` at connection or transaction start, extracted from JWT by middleware |
| **Schema migrations** | Single set of migrations applied once; both SQLite and PostgreSQL run the same logical schema (adapted for dialect) |
| **Backup** | `pg_dump` for full instance; per-tenant export via `COPY ... WHERE tenant_id = ?` |
| **Community edition** | No tenant concept — single-tenant by default, `tenant_id` column exists but is always `'default'` |

### Authentication Architecture

| Component | Decision |
|-----------|----------|
| **Identity provider** | Auth0 or Clerk for v1 (reduces security surface, managed password hashing, email verification, OAuth providers) |
| **Token format** | JWT with `sub` (user ID), `org_id` (tenant ID), `role` (admin/member) |
| **API authentication** | Bearer token header for REST API; cookie-based for browser sessions |
| **API keys** | Generated per-user for CLI access (stored as bcrypt hash in the database, shown once at creation) |
| **Community edition** | Static API key from `.env` (unchanged, backward compatible) |

## Consequences

### Positive
- Community edition retains its simplicity: SQLite, single-user, zero-config
- Cloud edition gets a production-grade database with RLS, PITR, and managed operations
- Single codebase reduces maintenance burden for a solo developer
- Clear migration path: SQLite → `DatabaseProvider` abstraction → PostgreSQL backend
- RLS provides defence-in-depth for tenant isolation
- Existing tests continue to use in-memory SQLite (fast, deterministic)

### Negative
- ~40h of development for the `DatabaseProvider` abstraction layer and PostgreSQL adapter
- Some SQL dialect differences (JSON functions, date/time, upsert syntax) require careful handling in the abstraction
- Query performance tuning may differ between SQLite and PostgreSQL for complex queries
- The abstraction layer adds indirection where there was none — a trade-off for the dual-backend support

### Compliance and Security Implications
- RLS ensures tenant isolation at the database level — a critical compliance requirement for multi-tenant SaaS
- Auth0/Clerk provide SOC2-compliant identity management, reducing the security burden on the application
- API keys for CLI access are hashed with bcrypt (never stored in plaintext)
- Session tokens are short-lived (15 min) with refresh tokens (7 days)
- All authentication is over TLS (enforced at the reverse proxy level)

### Migration and Monitoring Plan
- **Phase 1 (v0.4.0)**: Define `DatabaseProvider` interface. Convert 2-3 repositories as proof of concept. Ensure SQLite implementation passes all existing tests.
- **Phase 2 (v0.5.0)**: PostgreSQL implementation. All 16 repositories dual-backend. CI runs tests against both SQLite and PostgreSQL.
- **Phase 3 (v0.6.0)**: Auth0/Clerk integration. Login flow. API key management. Community edition retains `.env` API keys unchanged.
- **Validation**: All existing tests pass against both database backends. RLS policies are verified with integration tests that attempt cross-tenant access.

### Validation
- **Database abstraction**: 100% of existing repository tests pass against the new `DatabaseProvider` interface with both SQLite and PostgreSQL backends
- **RLS enforcement**: Integration tests verify that a query with `tenant_id = 'A'` against the PostgreSQL backend returns zero rows when the session is configured for `tenant_id = 'B'`
- **Performance**: PostgreSQL query latency under 50ms p99 for all portfolio and candidate queries at 100 concurrent tenants
- **Community edition**: No change in startup time, query latency, or database file size compared to v0.3.x

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs should be consistent with the ADR series starting at `docs/adr/0001-project-architecture.md`. Template: `.claude/skills/adr/template.md`.*
