# ADR-0032: Cloud Authentication — External Identity Provider (Auth0)

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-06-26 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | ADR-0017 (extends — community edition retains env-var API keys) |
| **Relates to** | ADR-0027, ADR-0034 |
| **Project** | DOMINUS |

## Context

DOMINUS currently authenticates API requests via a static API key stored in the `API_KEYS` environment variable (`EnvApiKeyProvider`), as documented in ADR-0017. This model works for the community edition (single-user, localhost or LAN deployment) but has five fundamental limitations that block DOMINUS Cloud:

1. **No user registration or login flow** — Users cannot sign up, log in, or manage their account without editing environment variables.
2. **No tenant resolution** — The current auth middleware has no concept of `tenant_id`. Cloud requires extracting the tenant from the authentication context and injecting it into every database query (see ADR-0034).
3. **No role-based access** — Every authenticated request is equivalent. Cloud needs at least `admin` and `member` roles per tenant.
4. **No key rotation without restart** — Changing the API key requires restarting the process, which is unacceptable for a multi-tenant cloud service.
5. **No session management** — No token expiry, refresh tokens, or revocation support.

The `AuthProvider` interface already exists in `src/providers/auth/auth-provider.ts` as a clean abstraction. This ADR adds a second implementation (`Auth0Provider`) for DOMINUS Cloud while preserving the existing `EnvApiKeyProvider` unchanged for the community edition.

The choice of *which* provider to use is made at startup via the `AUTH_PROVIDER` configuration variable, wired in the composition root (`src/app/provider-factory.ts`).

## Decision Drivers

1. **Security surface reduction** — Handling password hashing, email verification, MFA, and OAuth flows in-house is a significant security liability for a solo-founder project. An external IdP offloads this to a SOC2-compliant platform.

2. **Multi-tenant token architecture** — The JWT must encode `sub` (user ID), `org_id` (tenant ID), and `role` (admin/member). The middleware extracts these claims and injects them into the request context without additional database lookups.

3. **Community edition unchanged** — The `EnvApiKeyProvider` must continue to work identically. No existing user should be forced to adopt Auth0. The two providers coexist via the existing interface.

4. **Cost discipline** — The external IdP must have a viable free tier for small teams. Auth0's free tier (7,500 active users, unlimited tenants) covers DOMINUS Cloud's expected launch scale.

5. **API key support for CLI** — The cloud edition must still support API keys for CLI access (many users prefer terminal workflows). These are generated per-user, stored as bcrypt hashes, and scoped to a tenant.

## Considered Options

### Option A: Auth0 — External OpenID Connect Provider

Auth0 is a managed identity platform that supports OAuth 2.0, OpenID Connect, social logins, passwordless, and enterprise SSO. The application delegates authentication to Auth0 and validates JWTs via JWKS endpoint.

**Advantages:**
- SOC2, ISO 27001, HIPAA compliant — password hashing, MFA, breach detection managed by Auth0
- 7,500 free active users — covers the entire expected launch phase
- JWKS-based JWT validation — no outbound API calls to Auth0 on every request (key rotation is automatic)
- Built-in support for social login (Google, GitHub, Apple) — reduces friction for self-serve signup
- Extensible with Actions/Rules — custom claims (tenant ID, role) added to tokens via Auth0 Actions
- Well-documented Node.js SDK (`express-oauth2-jwt-bearer`, `auth0` npm packages)
- Tenant resolution via Auth0 Organizations feature — `org_id` claim in JWT, org management via Auth0 Dashboard
- Rate limiting and brute-force protection managed by Auth0

**Disadvantages:**
- External dependency — if Auth0 has an outage, login is blocked (mitigated by JWT validation being offline after initial JWKS fetch)
- Vendor lock-in — migrating away from Auth0 requires changing the JWT validation logic and user migration
- Configuration complexity — Auth0 Dashboard requires tenant setup, application registration, API definition, Actions for custom claims, and organization setup
- Free tier limits: 7,500 MAU, 2 social connections, 1 enterprise connection — may require upgrade at scale
- Auth0 Actions for custom claims run on their infrastructure — adds ~50-200ms to login flow (one-time cost per session)

**Cost Implications:** Free tier (7,500 MAU). Paid tier starts at ~€23/month for 1,000 MAU with all features. Estimated Cloud launch cost: €0/month.

**Risk Assessment:** Low-Medium. Auth0 is a mature platform with 99.99%+ uptime. The JWT validation path is offline after the initial JWKS fetch, so a brief Auth0 outage doesn't block authenticated API requests. Token refresh would fail during an outage, requiring re-login after token expiry (configurable, default 24h for refresh tokens).

---

### Option B: Clerk — External Identity Platform

Clerk is a newer identity platform with a developer-focused API, React/Next.js SDKs, and built-in organization (tenant) management.

**Advantages:**
- First-class React SDK with hooks (`useUser`, `useAuth`, `useOrganization`)
- Built-in organization management — no Auth0 Actions needed for multi-tenant claims
- Simpler setup — less configuration surface than Auth0
- Free tier: 10,000 MAU, unlimited organizations — more generous than Auth0
- Webhook support for user lifecycle events (signup, delete, org membership change)

**Disadvantages:**
- Smaller ecosystem — fewer SDKs, fewer community resources than Auth0
- No Node.js Express native middleware — requires calling Clerk's API or building a custom JWT validation layer
- JWT validation requires an API call to Clerk unless using their SDK middleware (which is Next.js-specific)
- CLI API key model would need custom implementation — Clerk doesn't natively support long-lived API keys
- Less mature for B2B use cases — organizations feature is newer than Auth0's
- Vendor risk — smaller company, less established than Auth0 (Okta)

**Cost Implications:** Free tier (10,000 MAU, unlimited orgs). Paid tier starts at ~€20/month.

**Risk Assessment:** Medium. Clerk is growing fast but lacks Express-native JWT validation. The React-first model conflicts with DOMINUS's client-side SPA architecture where auth is handled by the Express backend, not React. Would require building a custom JWT validation middleware that calls Clerk's JWKS endpoint.

---

### Option C: Self-Hosted JWT with bcrypt + refresh tokens

Build a complete authentication system from scratch: user registration, login, password hashing (bcrypt), JWT generation, refresh token rotation, email verification, and MFA.

**Advantages:**
- Zero external dependencies — no third-party service required
- Full control over the auth flow — custom claims, custom token format, custom policies
- No per-user fees — unlimited users at €0 operational cost
- No vendor lock-in
- Community edition can optionally use the same system

**Disadvantages:**
- Massive security surface — password hashing, timing attacks, token theft, CSRF, email verification, rate limiting on login, brute-force protection — all must be correctly implemented
- Estimated 80-120h of development for a production-grade auth system (registration, login, password reset, email verification, MFA, session management, API key management, admin panel)
- Ongoing maintenance — security patches, vulnerability monitoring, dependency updates
- Solo-founder risk — a single security vulnerability in the auth system could expose all tenant data
- Email delivery — requires integrating SendGrid/Mailgun/SES for verification and password reset emails (adds cost and complexity)
- No social login without building OAuth clients for each provider

**Cost Implications:** €0 operational cost. ~100h development time. Email delivery: ~€10-20/month for transactional emails at scale.

**Risk Assessment:** High. The solo-founder security burden is the deciding factor. Authentication is the most security-critical subsystem — a vulnerability here compromises all tenants. The cost of getting it wrong far exceeds the cost of Auth0's paid tier.

---

### Option D: Supabase Auth

Supabase offers a hosted Auth service as part of their PostgreSQL platform. It uses GoTrue (the open-source auth server behind Netlify Identity) and supports JWT, social login, and Row-Level Security integration.

**Advantages:**
- Tightly integrated with PostgreSQL — RLS policies use `auth.uid()` and `auth.jwt()` directly
- Supabase provides database, auth, and storage in one platform
- Open-source GoTrue server — can be self-hosted if needed
- Free tier: 50,000 MAU, unlimited projects
- Well-documented PostgreSQL + RLS integration

**Disadvantages:**
- Supabase Auth is PostgreSQL-specific — doesn't work with SQLite (community edition)
- Would require maintaining two auth paths: Supabase for Cloud, EnvApiKeyProvider for CE
- Supabase Auth has limited organization/tenant support — would need to build tenant management on top
- Supabase is a platform dependency — migrating away from Supabase means migrating both database AND auth
- The free tier's 50,000 MAU is generous, but the database and auth are tied together — you can't use Supabase Auth without Supabase PostgreSQL
- The auth middleware would need separate implementation paths for CE (SQLite + env keys) and Cloud (Supabase + JWT)

**Cost Implications:** Free tier. Paid tier starts at ~$25/month (Pro plan includes auth + database).

**Risk Assessment:** Medium-High. The tight coupling between Supabase Auth and Supabase PostgreSQL creates platform lock-in. The community edition cannot use Supabase Auth (it runs on SQLite), so maintaining two entirely different auth stacks is inevitable. This is more complex than Option A where both stacks share the same `AuthProvider` interface.

---

## Decision

**Chosen option: Option A — Auth0 (External OpenID Connect Provider)**

The rationale:

1. **Security delegation is the correct choice for a solo-founder project.** Authentication is the single highest-risk subsystem. Auth0's SOC2-compliant platform handles password hashing (bcrypt, with automatic algorithm upgrades), MFA, breached password detection, brute-force protection, and rate limiting. A solo founder cannot match this with 100h of custom development.

2. **The `AuthProvider` interface makes the dual-provider model clean.** The existing `EnvApiKeyProvider` remains the default for community edition (no config change needed). `Auth0Provider` is a second implementation selected via `AUTH_PROVIDER=auth0` in the environment. The composition root (`src/app/provider-factory.ts`) routes to the correct implementation. Zero changes to middleware or route handlers.

3. **Auth0 Organizations maps directly to DOMINUS tenants.** The `org_id` claim in the JWT is handled by Auth0's native Organizations feature. No custom Actions needed for tenant resolution — it's built into the platform. The middleware extracts `org_id` and injects `req.tenantId`.

4. **CLI API keys still work.** For the Cloud edition, API keys are stored as bcrypt hashes in the database, generated per-user, and scoped to a tenant via `tenant_id`. The auth middleware validates either a JWT (browser/login) or an API key (CLI) using the same `AuthProvider.validate()` interface.

5. **Rejecting Clerk (Option B):** Clerk's React-first model doesn't match DOMINUS's architecture where auth is a backend concern (the SPA is client-side and auth is handled by the Express backend). Custom JWT validation for Express would add complexity without benefit over Auth0's proven `express-oauth2-jwt-bearer`.

6. **Rejecting self-hosted (Option C):** The security risk and development cost are disproportionate for a solo-founder project. Auth0's paid tier (€23/month) is cheaper than the developer time to implement and maintain a production-grade auth system.

7. **Rejecting Supabase (Option D):** The platform lock-in and dual-stack maintenance (Supabase Auth for Cloud, env keys for CE) creates more complexity than the Auth0 approach where both providers share the same interface.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Client (SPA / CLI)                                         │
│  Authorization: Bearer <JWT or API Key>                     │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│  Express Middleware Stack                                    │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  AuthMiddleware (unchanged)                          │   │
│  │  - Reads Authorization header                        │   │
│  │  - Calls AuthProvider.validate(token)                │   │
│  │  - On success: attaches req.auth = { userId,         │   │
│  │    tenantId, role }                                  │   │
│  └────────────────────────┬─────────────────────────────┘   │
│                           │                                   │
│  ┌────────────────────────▼─────────────────────────────┐   │
│  │  AuthProvider.validate()                             │   │
│  │                                                      │   │
│  │  ┌──────────────────┐    ┌────────────────────────┐ │   │
│  │  │ EnvApiKeyProvider │    │ Auth0Provider           │ │   │
│  │  │ (CE)              │    │ (Cloud)                 │ │   │
│  │  │ - static env key  │    │ - JWT via JWKS          │ │   │
│  │  │ - no tenant       │    │ - API key via bcrypt    │ │   │
│  │  └──────────────────┘    │ - tenant from org_id    │ │   │
│  │                          └────────────────────────┘ │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### JWT Claims Contract

| Claim | Source | Description |
|-------|--------|-------------|
| `sub` | Auth0 user ID | Unique user identifier (`auth0\|<uuid>`) |
| `org_id` | Auth0 Organization | Tenant identifier (UUID v4) |
| `role` | Auth0 Org Membership | `admin` or `member` |
| `email` | Auth0 user profile | Verified email address |
| `iat`/`exp` | Auth0 token | Issued/expiry timestamps |

### API Key Model (Cloud CLI)

| Aspect | Decision |
|--------|----------|
| **Generation** | `dominus auth create-api-key --name "dev"` — shown once, stored as bcrypt |
| **Storage** | `api_keys` table: `id, tenant_id, user_id, name, hash_bcrypt, prefix, last_used_at, created_at, revoked_at` |
| **Validation** | Auth middleware checks JWT first, falls back to API key (checks bcrypt hash) |
| **Prefix** | `dk_dominus_<random_8chars>` — displayed in CLI for key identification |
| **Revocation** | `dominus auth revoke-api-key <id>` — sets `revoked_at`, middleware checks it |
| **Rotation** | `dominus auth rotate-api-key <id>` — generates new key, revokes old one |

## Consequences

### Positive
- Auth0 handles all identity security (password hashing, MFA, breach detection, rate limiting)
- Community edition unchanged — existing `EnvApiKeyProvider` works identically
- Clean separation via `AuthProvider` interface — middleware changes are zero
- `org_id` claim provides tenant resolution without additional database queries
- CLI API keys work in Cloud edition via bcrypt-backed provider
- Free tier covers expected launch scale (7,500 MAU)
- Path to upgrade: paid Auth0 tier when MAU exceeds free tier
- No vendor lock-in at the code level — swapping to Clerk or self-hosted requires only a new `AuthProvider` implementation

### Negative
- External dependency on Auth0 for login flow — outage blocks new sessions (not existing ones if JWT is still valid)
- Auth0 Dashboard configuration required (tenant, app, API, orgs, Actions for custom claims)
- Learning curve for Auth0 Organizations feature and Actions configuration
- API key management (bcrypt hashing, database table) adds ~30 lines of middleware logic specifically for Cloud

### Compliance and Security Implications
- Auth0 is SOC2, ISO 27001, HIPAA compliant — covers DOMINUS Cloud's compliance requirements
- JWKS key rotation is automatic — no manual key management
- JWT validation is offline (no outbound API call per request) — no latency or availability dependency for authenticated requests
- API keys are hashed with bcrypt (cost factor 12) — never stored in plaintext
- Token expiry: access token 15 minutes, refresh token 24 hours, API keys don't expire (manual revocation)
- Failed auth attempts are rate-limited at the Auth0 level AND the Express middleware level (defence-in-depth)

### Migration and Monitoring Plan
1. Implement `Auth0Provider` in `src/providers/auth/auth0-provider.ts` with JWKS validation
2. Add `AUTH_PROVIDER`, `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, `AUTH0_JWKS_URI` to config schema
3. Add `api_keys` table migration for Cloud CLI API keys
4. Wire provider selection in `src/app/provider-factory.ts`
5. Test: JWT validation, API key validation, tenant extraction, role extraction, expired token rejection
6. Monitor: auth failure rate, token validation latency, JWKS fetch frequency
7. Rollback: set `AUTH_PROVIDER=env` — all Cloud users lose access, CE users unaffected

### Validation
- Integration tests verify that a valid Auth0 JWT passes `Auth0Provider.validate()` and returns correct `{ userId, tenantId, role }`
- Integration tests verify that expired, malformed, and wrong-audience JWTs are rejected
- Integration tests verify that community edition with `AUTH_PROVIDER=env` works identically to v0.5.0
- Integration tests verify that rate limiting on auth failures works for both providers
- API key integration tests verify bcrypt validation, revocation, and rotation

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs should be consistent with the ADR series starting at `docs/adr/0001-project-architecture.md`. Template: `.claude/skills/adr/template.md`.*
