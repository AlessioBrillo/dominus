# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.2.x   | :white_check_mark: |
| < 0.2.0 | :x:                |

## Reporting a Vulnerability

DOMINUS is a single-user tool with no multi-tenancy, no user authentication,
and no network-exposed attack surface beyond the REST API bound to localhost
by default. Security vulnerabilities are unlikely but not impossible.

If you discover a security issue:

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
- Every SQL query uses parameterised statements via `better-sqlite3.prepare()`.
- No string concatenation or template literals are used in SQL queries.

### Input Validation
- Domain names are validated against RFC-1123 rules before any provider call.
- CSV imports are validated for schema compliance before processing.
- File paths are resolved safely (no directory traversal).

### Network Exposure
- The Express API binds to `127.0.0.1` by default (localhost only).
- In Docker, `HOST=0.0.0.0` is required for container ingress — access
  should be restricted by reverse proxy or firewall.
- All standard HTTP security headers are set (`X-Content-Type-Options`,
  `X-Frame-Options`, `X-XSS-Protection`).

### Dependency Management
- Dependencies are scanned for known vulnerabilities before addition.
- Dependabot is configured for weekly npm updates.
- Only well-maintained, widely-used libraries are selected.

### Database Safety
- SQLite WAL mode is enabled for safe concurrent access.
- The database file is stored in a gitignored `data/` directory.
- Automatic backups via `dominus maintenance backup` (VACUUM INTO).
