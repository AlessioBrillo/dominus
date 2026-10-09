# Security Policy

## Supported Versions

Security fixes are released for the latest minor version of the current major
release. Upgrade to the latest `1.x` release to receive them.

| Version | Supported          |
| ------- | ------------------ |
| 1.1.x   | :white_check_mark: |
| < 1.1.0 | :x:                |

## Reporting a Vulnerability

DOMINUS has two editions with different exposure:

- **Community** is self-hosted. It authenticates with static API keys from the
  environment and runs as a single tenant.
- **DOMINUS Cloud** is multi-tenant: API keys stored hashed in the database,
  optional single sign-on (OIDC), team seats, billing and an operator panel.

If you discover a security issue in either edition:

1. **Do not open a public GitHub issue.**
2. Send details through a private vulnerability report on GitHub
   (the repository's **Security** tab).
3. You should receive a response within 7 days.

## Security Design

### No Secrets in Code

- API keys and credentials are read from environment variables (`.env`,
  gitignored) or from files named by `FILE_*` variables.
- `.env.example` documents every variable without real values, and a test keeps
  it in sync with the configuration schema.
- NameBio's API key is sent in the query string (the vendor's format); it is
  redacted from error logs.

### SQL Injection Prevention

- Queries are parameterised on both SQLite and PostgreSQL. Dynamic identifiers
  (table names in migrations) never come from user input.
- A CI check keeps SQLite-only SQL out of code that also runs on PostgreSQL.

### Input Validation

- Domain names are validated against RFC 1123 rules before any provider call.
- CSV imports are validated for schema compliance before processing.
- API bodies are validated with Zod.

### Network Exposure

- The server binds to `127.0.0.1` by default. The Docker image sets
  `HOST=0.0.0.0` for container ingress, and **the server refuses to start on an
  exposed interface without API authentication configured.**
- Standard HTTP security headers and a strict CSP are set.
- In Cloud mode the server refuses to start without `METRICS_TOKEN`, so
  `/api/v1/metrics/*` is never public.

### Authentication

**API keys** (CLI, scripts, Community edition)

- Community: static keys from `API_KEYS` / `FILE_API_KEYS`, compared in constant
  time. They act as the admin of the single tenant.
- Cloud: keys are generated server-side, shown once, and stored only as a salted
  scrypt hash. Keys carry a role (`admin` or `member`) and can be revoked.
- Failed authentication is rate limited per IP.

**Single sign-on** (Cloud, `AUTH_PROVIDER=auth0` with OIDC client credentials)

- Authorization Code flow with PKCE and `state`; the ID token is verified against
  the IdP's JWKS (issuer and audience).
- The browser session is an `HttpOnly`, `Secure`, `SameSite=Lax` cookie holding
  a signed JWT (8 hours by default). There are no refresh tokens: a session ends
  at expiry or at logout, and logout also ends the identity-provider session.
- State-changing requests authenticated by the cookie must come from a trusted
  `Origin`/`Referer` (CSRF guard). Bearer-token callers are unaffected.
- The tenant and role in a session come from the user's team seat, not from IdP
  claims.

**Roles**

- `member` and `admin` are scoped to one tenant; `admin` manages that tenant's
  team, keys and billing.
- `operator` is the cross-tenant platform role (operator panel, suspend, plan
  override). It is granted only through the `OPERATOR_SUBJECTS` allowlist; no key
  row or token claim can grant it, and an empty allowlist means nobody has it.

### Billing

- Stripe webhooks are verified with the signing secret on the raw body and
  de-duplicated durably; a failed handler releases its claim so Stripe's retry is
  processed. Custom-price grants cross-check tenant and amount.

### Multi-Tenant Isolation (DOMINUS Cloud)

Isolation is enforced in layers:

1. **Application:** repositories scope queries by `tenant_id`, and domain
   uniqueness is per tenant.
2. **Database:** PostgreSQL Row-Level Security (forced, for a non-superuser
   application role) on the entity tables (candidates, scoring runs, portfolio,
   outcomes, listings, bids, alerts, watchlist, events, onboarding, public
   scores, ...). The tenant context is reset on every pooled connection, and a
   connection whose reset fails is destroyed.
3. **Control-plane tables** (API keys, subscriptions, usage, team seats,
   invitations, tenant flags) are scoped by the application, not by RLS: they are
   read before a tenant is known (key validation, webhooks) or across tenants (the
   operator panel). Extending RLS to them needs a dedicated bypass design and is
   tracked as follow-up work.

Cross-tenant behaviour is covered by tests that run against SQLite and, in CI,
against a real PostgreSQL.

### Dependency and Image Supply Chain

- Dependencies are audited in CI (`npm audit`, secret scanning, CodeQL, image
  scanning) and Dependabot proposes updates.
- Container images are pinned by digest; runtime images drop the npm CLI and run
  as a non-root user.

### Database Safety

- Community: SQLite in WAL mode; automatic daily backups (`VACUUM INTO`).
- Cloud: PostgreSQL with WAL archiving and point-in-time recovery
  (see `docs/operations/rto-rpo.md`).
