# ADR-0110: Passwordless browser sign-in via a verified mailbox

## Metadata

| Field          | Value                                          |
| -------------- | ---------------------------------------------- |
| **Status**     | Accepted                                       |
| **Date**       | 2026-11-24                                     |
| **Authors**    | Alessio Brillo                                 |
| **Deciders**   | Alessio Brillo                                 |
| **Supersedes** | -                                              |
| **Relates to** | ADR-0032, ADR-0062, ADR-0107, ADR-0108          |

## Context

The browser could only sign in by pasting an API key. That is a reasonable
credential for the CLI and for automation, but it is a barrier for a person
who wants to look at a domain portfolio: a consumer-facing web product does
not ask a stranger to paste a secret string into a login form.

The repository already has the pieces for a better flow: single-use hashed
tokens with atomic consumption (signup verification, ADR-0107), an httpOnly
session JWT and cookie (SSO, ADR-0062), a live seat validator, and a resolver
that maps a verified email to the workspace that owns it. What it did not
have was a way to mint a session without an identity provider.

## Decision

1. A browser user can ask for a sign-in link by email. The link is sent only
   when an **active, verified seat** exists for that address; the endpoint
   answers identically for every other address.
2. The token is 32 random bytes, stored only as a SHA-256 hash, valid for 15
   minutes and consumed atomically. Consuming it mints the **same session JWT
   and cookie** as the SSO flow; no password is created and no API key is
   shown or stored by the SPA.
3. Tenant and role come from `IdentityTenantResolver`, never from the email
   or from the token. The trust boundary of ADR-0107 is unchanged: an
   unverified address can never claim a workspace.
4. The flow is a separate, additive table (`magic_link_tokens`,
   migration 0074). The `purpose` CHECK of `signup_verifications` is not
   widened, because that would be destructive DDL.
5. `MAGIC_LINK_ENABLED` defaults to false. Enabling it requires `SMTP_URL`
   and a `SESSION_SECRET` of at least 32 characters; the server exits at
   boot otherwise. An empty signing secret would make sessions forgeable,
   and an undeliverable link is worse than no login option.
6. API keys remain the credential for the CLI and for automation; the OIDC
   flow remains the enterprise SSO path. Three explicit, non-overlapping
   lanes replace the previous confusion between a login key and a session.

## Consequences

- A member of a design-partner workspace can enter the dashboard with the
  mailbox they verified at signup, without handling a key.
- Every API request with the session cookie is still CSRF-checked against
  the trusted origins and re-validates the seat on every request, so a
  removed member loses access immediately. A deployment must configure
  `CORS_ORIGIN`; an empty trusted-origin set rejects cookie mutations.
- The control-plane token table is included in the data-subject export and
  erasure registry, because an unconsumed token is still tied to a mailbox.
- Rotating `SESSION_SECRET` signs out every magic-link session, just as
  rotating the Auth0 client secret signs out SSO sessions.
