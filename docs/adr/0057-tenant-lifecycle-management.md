# ADR-0057: Tenant Lifecycle Management (Admin Operations Loop)

## Metadata

| Field          | Value                                  |
| -------------- | -------------------------------------- |
| **Status**     | Proposed                               |
| **Date**       | 2026-08-13                             |
| **Authors**    | AlessioBrillo                          |
| **Deciders**   | AlessioBrillo                          |
| **Supersedes** | N/A                                    |
| **Relates to** | ADR-0027, ADR-0032, ADR-0038, ADR-0053 |
| **Project**    | DOMINUS                                |

## Context

DOMINUS Cloud processes real Stripe payments (ADR-0053) and meters usage at
chokepoints (ADR-0038), but the platform admin surface (`/api/v1/admin`) is
strictly **read-only**: `GET /overview`, `GET /tenants`, `GET /tenants/:id`.
An operator cannot suspend a tenant that stops paying, violates the terms of
service, or abuses the platform without direct database surgery. There is no
way to grant an ad-hoc plan (enterprise trials, SLA-compensation credits)
either, and no per-tenant usage history beyond the current month's totals.

For a paid multi-tenant service the abuse-response loop is a prerequisite,
not a nice-to-have: every day without tenant suspension is a day a tenant
can burn provider budgets (WHOIS/RDAP/DNS fair-share, ADR-0041) or rack up
scoring cost while non-paying.

The community edition is unaffected: tenant admin flags are only ever
written through the admin role surface, which is only reachable with a
CLI-minted admin key (ADR-0032). The enforcement reads an indexed primary
key row that is empty by default, so self-hosted installs pay one PK lookup
per request at most.

## Decision Drivers

1. **Operator capability, not automation** — suspend/unsuspend and plan
   override are deliberate human actions; there is no auto-suspension
   policy in this ADR (dunning remains subscription-status-driven,
   ADR-0053).
2. **Fail-closed enforcement at every boundary** — suspension must block
   the HTTP surface and the pipeline chokepoints, not just the admin UI.
3. **Payment escape hatch** — a suspended tenant must still reach
   `GET /billing` (subscription state + Stripe portal link) so they can
   recover by paying; everything else returns `403 TENANT_SUSPENDED`.
4. **Community zero-risk** — SQLite single-tenant installs must observe
   no behavior change; the check is a cheap PK lookup on an empty table.
5. **Control-plane only** — like the rest of the admin surface (ADR-0038
   tenant isolation), tenant admin flags live in control-plane tables
   outside FORCE ROW LEVEL SECURITY, so the same SQL runs on SQLite and
   PostgreSQL.

## Considered Options

### Option A: dedicated `tenant_admin_flags` control-plane table (chosen)

A small table keyed by `tenant_id` holding `suspended_at`,
`suspended_reason`, `plan_override` and `updated_at`. Enforcement reads it
at the API boundary (middleware) and at the pipeline chokepoint
(`PipelineUsageEnforcer`). The admin service is the only writer, so the
flag lifecycle is auditable through the operator action log.

**Pros:** one indexed PK lookup per request; no schema churn on the
RLS-protected entity tables; SQLite/PostgreSQL identical DDL; a row's
absence means "tenant not suspended, no override" — the safe default.

**Cons:** a second read per metered request; requires wiring a repo
reference into the middleware and the enforcer.

### Option B: columns on `tenant_subscriptions`

Suspend state attached to the subscription row.

**Pros:** no new table; subscription already loaded at enforcement time.

**Cons:** conflates billing state with operator state; a tenant with no
subscription row (free-tier, pre-provision) cannot be suspended; Stripe
webhook upserts would need to preserve the operator columns; RLS-relevant
shape changes.

### Option C: application-level allowlist (suspended tenants in config/Redis)

Keep a suspended-tenant set in Redis or config.

**Pros:** zero DB reads.

**Cons:** lost on Redis eviction (volatile-lru, see B1) — exactly when the
platform is under memory pressure the abuse block could silently disappear;
not durable across restarts; no audit trail.

## Decision

Adopt Option A. Introduce the `tenant_admin_flags` control-plane table and
four operator endpoints on the admin surface:

- `POST /api/v1/admin/tenants/:tenantId/suspend` `{ reason?: string }`
- `POST /api/v1/admin/tenants/:tenantId/unsuspend`
- `POST /api/v1/admin/tenants/:tenantId/plan-override` `{ plan: string | null }`
  (`null` clears the override)
- `GET /api/v1/admin/tenants/:tenantId/usage?days=N` — daily usage series
  for the operator drill-down

Enforcement:

- **HTTP boundary** — `createTenantStatusMiddleware` mounted on the
  protected router right after auth. A suspended tenant receives
  `403 TENANT_SUSPENDED` on every protected route except the `/billing`
  subtree (payment escape hatch). Callers with the `admin` role are never
  blocked (operator keys must keep working).
- **Pipeline chokepoint** — `PipelineUsageEnforcer.checkAndRecord` throws
  `TenantSuspendedError` (mapped to `403 TENANT_SUSPENDED` by the error
  handler) when the tenant is suspended. Jobs already enqueued before the
  suspension are allowed to drain: suspension is preventive, not a
  mid-flight abort (documented limitation).
- **Plan override** — `UsageMeterService` resolves the effective plan via
  an injected `planOverrideProvider`; a non-null override wins over the
  subscription-derived plan (including past_due fallback). The override is
  an explicit operator grant and is deliberately not covered by
  auto-downgrade. Clearing the override restores subscription-driven
  enforcement. Team-seat limits remain subscription-driven (documented
  limitation: the override targets metered features, the money path).

### Positive Consequences

- Operators can stop abuse and enforce payment without touching the DB.
- Plan overrides enable enterprise trials and SLA compensation without
  Stripe gymnastics.
- Daily usage series give the operator the drill-down needed to spot
  runaway tenants before they exhaust budgets.
- Community edition behavior is unchanged (empty table, no admin keys).

### Negative Consequences

- One extra indexed PK lookup on the metered request path.
- Overrides can diverge from Stripe state if misused — mitigated by the
  operator-action-only write path and audit logs.
- Team seats do not honor the override (documented limitation).

## References

- ADR-0032 (Cloud authentication, admin role minting via CLI)
- ADR-0038 (usage enforcement at chokepoints, tenant isolation)
- ADR-0041 (per-tenant fair share on shared provider budgets)
- ADR-0053 (billing loop completion, status-aware enforcement)
