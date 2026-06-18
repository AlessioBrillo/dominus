# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.4.x   | :white_check_mark: |
| 0.3.x   | :white_check_mark: |
| < 0.3.0 | :x:                |

## Reporting a Vulnerability

DOMINUS Community is a self-hosted tool with no multi-tenancy, no user
authentication, and no network-exposed attack surface beyond the REST API
bound to localhost by default. DOMINUS Cloud is a managed multi-tenant service
with authenticated access.

If you discover a security issue in either edition:

1. **Do not open a public GitHub issue.**
2. Send details to the repository owner via a [private vulnerability report]
   on GitHub.
3. You should receive a response within 7 days.

## Security Design

DOMINUS follows these security principles:

### No Secrets in Code
- All API keys and credentials are read from environment variables (`.env`
  file, gitignored).
- The `.env.example` file documents every variable without real values.
- No tokens, keys, or passwords are hardcoded or committed.

### SQL Injection Prevention
- Every SQL query uses parameterised statements via `better-sqlite3.prepare()`
  or parameterised PostgreSQL queries.
- No string concatenation or template literals are used in SQL queries.

### Input Validation
- Domain names are validated against RFC-1123 rules before any provider call.
- CSV imports are validated for schema compliance before processing.
- File paths are resolved safely (no directory traversal).
- All API inputs are validated with Zod schemas.

### Network Exposure
- The Express API binds to `127.0.0.1` by default (localhost only).
- In Docker, `HOST=0.0.0.0` is required for container ingress — access
  should be restricted by reverse proxy or firewall.
- All standard HTTP security headers are set (`X-Content-Type-Options`,
  `X-Frame-Options`, `X-XSS-Protection`, `Strict-Transport-Security`).

### Authentication (Community Edition)
- Static API key from environment variable — single-key, single-user.
- No session management, password hashing, or user registration.
- API key should be treated as a secret and rotated periodically.

### Authentication (DOMINUS Cloud)
- JWT-based authentication with short-lived access tokens (15 minutes) and
  refresh tokens (7 days).
- Auth0/Clerk managed identity provider for OAuth, password hashing, and
  brute-force protection.
- API keys for CLI access are hashed with bcrypt (never stored in plaintext).
- Row-Level Security on PostgreSQL enforces tenant isolation at the database
  level.

### Dependency Management
- Dependencies are scanned for known vulnerabilities before addition.
- Dependabot is configured for weekly npm updates.
- Only well-maintained, widely-used libraries are selected.

### Database Safety
- Community edition: SQLite WAL mode for safe concurrent access. The database
  file is stored in a gitignored `data/` directory. Automatic backups via
  `dominus maintenance backup` (VACUUM INTO).
- DOMINUS Cloud: Managed PostgreSQL with automated daily backups, point-in-time
  recovery, and encrypted storage at rest.

### Multi-Tenant Isolation (DOMINUS Cloud)
- Tenant isolation is enforced at three layers:
  1. **Application**: all queries filter by `tenant_id` column
  2. **Database**: PostgreSQL Row-Level Security policies on every table
  3. **Network**: tenants are isolated at the application layer (no direct
     database access)
- Cross-tenant data access is validated in CI with integration tests.
