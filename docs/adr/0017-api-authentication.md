# ADR-0017: API Authentication

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0004 (provider abstraction pattern) |
| **Project** | DOMINUS |

## Context

DOMINUS v0.2.0 exposes its REST API on a configurable host:port (default
`127.0.0.1:3000`). The API has no authentication — any process that can
reach the port can read scores, modify the portfolio, and trigger pipeline
runs. The original design relied on localhost binding as the sole security
measure, which is acceptable for a purely local tool but insufficient when:

- The operator runs DOMINUS behind a reverse proxy on a VPS.
- The operator uses Docker with port mapping exposed to a LAN.
- A future frontend dashboard (React + Vite + Tailwind) needs network
  access to the API.

This ADR introduces opt-in API key authentication for the REST API while
preserving backward compatibility for local-only setups.

## Decision Drivers

1. **Backward compatibility**: Existing local-only setups must work without
   configuration changes. Auth must be opt-in.
2. **No external dependencies**: Zero-cost mandate (ADR-0001) prohibits
   adding an OAuth provider, identity server, or paid auth service.
3. **Provider pattern**: Follow ADR-0004 — authentication logic must be
   behind an interface, not hardcoded into middleware.
4. **Health endpoint exclusion**: The `/api/health` endpoint must remain
   accessible without auth for Docker HEALTHCHECK and monitoring tools.
5. **Minimal operational complexity**: No database schema changes, no
   migration, no key management UI at this stage.

## Considered Options

### Option 1: API Key via Environment Variable (Chosen)

A comma-separated list of API keys in the `API_KEYS` environment variable.
Supports optional named keys: `admin=sk-admin,readonly=sk-readonly`.

**Pros:**
- Zero infrastructure: no database, no file storage.
- Atomic key rotation: restart the process with a new env var.
- Familiar pattern (analogous to `CF-API-Token` or `Authorization: Bearer`).
- Follows ADR-0004: `AuthProvider` interface with `EnvApiKeyProvider`.

**Cons:**
- Key rotation requires process restart.
- No per-key granularity beyond a name label.
- Keys in env var may leak into process listings or logs (mitigated by
  DOMINUS being single-user).

### Option 2: API Keys in SQLite Database

Store API keys in a new `api_keys` table with CLI commands for
`generate`, `revoke`, `list`.

**Pros:**
- Key rotation without restart.
- Audit trail of key creation/revocation timestamps.
- Multiple active keys with different scopes.

**Cons:**
- New migration, schema, and repository class.
- CLI commands for key management add 50+ lines.
- Over-engineered for a single-user tool with no planned multi-tenant use.
- Database dependency for auth creates a chicken-and-egg bootstrap problem.

### Option 3: JWT Bearer Tokens

Issue JWTs signed with a configurable secret (`JWT_SECRET`).

**Pros:**
- Industry standard, works with any HTTP client.
- Token expiry forces regular re-authentication.
- Claims can encode key name and scope.

**Cons:**
- Higher complexity: token generation, refresh, expiry handling.
- Requires a token-issuance endpoint (a mini identity API).
- JWT libraries add a dependency and audit surface.
- No tangible benefit over simple API keys for a single-user tool.

### Option 4: No Authentication (Status Quo)

Continue relying on localhost-only binding.

**Pros:**
- Zero implementation cost.
- Zero operational friction.

**Cons:**
- Blocks all future use cases (VPS deployment, frontend dashboard, LAN
  sharing).
- Violates security best practice for any network-exposed service.

## Decision

**Chosen: Option 1 — API Key via Environment Variable.**

The implementation follows ADR-0004: an `AuthProvider` interface in
`src/providers/auth/auth-provider.ts` and a concrete
`EnvApiKeyProvider` in `src/providers/auth/env-api-key-provider.ts`.
The Express auth middleware in `src/api/middleware/auth.ts` validates
`Authorization: Bearer <key>` headers against the provider.

### Key design details

1. **Auth is opt-in**: When `API_KEYS` is unset or empty, the middleware
   is still mounted but rejects all unauthenticated requests. The server
   logs a start-up warning. The operator enables auth by setting the env var.
2. **Provider pattern**: `AuthProvider` interface allows future
   implementations (database-backed, hashed keys) without middleware changes.
3. **Health endpoint open**: `/api/health` is mounted before the auth
   middleware so Docker HEALTHCHECK and monitoring tools work without keys.
4. **401 vs 403**: Missing or malformed Authorization header → 401
   (unauthenticated). Valid format but wrong key → 403 (forbidden).

### Implementation files

| File | Purpose |
|------|---------|
| `src/providers/auth/auth-provider.ts` | `AuthProvider` interface + `AuthResult` |
| `src/providers/auth/env-api-key-provider.ts` | Env var implementation |
| `src/providers/auth/index.ts` | Barrel exports |
| `src/api/middleware/auth.ts` | Express middleware |
| `src/index.ts` | Wiring: mount middleware on protected routes |
| `src/config.ts` | `API_KEYS` env var in Zod schema |

### Example configuration

```bash
# Single key (name defaults to 'default')
API_KEYS=sk-my-secret-key

# Multiple named keys
API_KEYS=admin=sk-admin-key,readonly=sk-readonly-key
```

## Positive Consequences

- API is now safe to expose behind a reverse proxy or Docker port mapping.
- Future frontend dashboard can authenticate without localhost binding.
- Provider pattern allows swapping to database-backed keys later.
- Zero dependencies added — no new npm packages.

## Negative Consequences

- Operators who relied on localhost-only security and now expose the API
  must configure `API_KEYS` explicitly.
- Key rotation requires a process restart.
- Named keys in `API_KEYS` env var are plaintext — no hashing at this
  stage (acceptable for single-user context).

## Compliance

- ADR-0001 (zero-cost): ✅ No paid service or dependency.
- ADR-0004 (provider pattern): ✅ `AuthProvider` interface.
- ADR-0006 (TM gate non-bypassable): ✅ Auth is a transport-layer concern,
  orthogonal to the trademark gate.
