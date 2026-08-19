# ADR-0062: Enterprise SSO — OIDC Authorization Code + PKCE with backend session cookies

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-19 |
| **Authors** | Alessio Brillo |
| **Deciders** | Alessio Brillo |
| **Supersedes** | ADR-0032 (cloud authentication direction) |
| **Relates to** | ADR-0027, ADR-0057, ADR-0034 |
| **Project** | DOMINUS |

## Context

DOMINUS Cloud authenticates tenants through `AUTH_PROVIDER` (`env` for the
community edition, `db`/`auth0` for managed identity). The `Auth0Provider`
already validates JWT bearer tokens against the Auth0 JWKS (`issuer` +
`audience`, mapping `sub`/`org_id`/`role`), and the roadmap promises an
Enterprise tier that includes SSO. The missing piece is the *interactive
login loop*: a browser flow that lets an enterprise user sign in through
their identity provider and land on the dashboard with a usable session.

Three forces shape the decision:

1. **Enterprise expectation** — buyers of the Enterprise tier expect SSO
   against their IdP (Auth0, Okta, Azure AD) with no API-key ceremony.
2. **Tenant isolation must survive** — the suspended-tenant gate
   (ADR-0057), usage enforcement (ADR-0038) and `requireTenant` semantics
   (ADR-0034) all key on `req.tenantId` being populated and trustworthy.
   Any SSO flow must feed the same identity fields, not a parallel universe.
3. **Security posture** — the community edition already stores API keys in
   the SPA's localStorage. An enterprise SSO flow that followed that pattern
   (tokens in localStorage) would inherit its XSS exposure and add refresh
   management to the SPA. The enterprise tier is where the bar must be
   raised, not lowered.

ADR-0032 (`Cloud authentication — external identity provider (Auth0)`) was
never ratified past `Proposed` despite the code being wired. This ADR
ratifies the direction, pins the flow, and supersedes it.

## Decision Drivers

1. **IdP-agnostic core** — the login flow must not hardcode Auth0 calls into
   business logic; the repo's provider-abstraction principle (ADR-0004) is
   non-negotiable. Swapping the IdP must be a new implementation file.
2. **Revocable sessions** — a session that the tenant operator or platform
   admin can kill must survive IdP-side token revocation latency. Stateless
   bearer tokens in localStorage cannot be revoked server-side.
3. **Fail-closed by default** — the SSO endpoints must not exist unless
   fully configured; a misconfigured Cloud deploy must degrade to no-SSO,
   never to a permissive fallback.
4. **Minimal new configuration** — operators already manage the Auth0
   domain, audience, and JWKS. The OIDC flow adds only the application
   client credentials and a callback URL.

## Considered Options

### Option A: SPA-direct OIDC with PKCE (no backend session)

The SPA redirects to Auth0, Auth0 redirects back to the SPA, and the SPA
exchanges the code for tokens directly at the IdP, storing them in
localStorage and sending them as `Authorization: Bearer`. The backend only
keeps its existing JWKS validation.

**Advantages:**
- Smallest implementation — no session infrastructure, no cookies.
- Standard Auth0 SPA pattern, well-trodden docs.

**Disadvantages:**
- Access tokens in localStorage — the XSS exposure the enterprise tier
  should be eliminating.
- Refresh tokens cannot be stored safely in a SPA; silent renewal needs a
  hidden iframe + `prompt=none`, which breaks for many enterprise IdP
  tenants (third-party cookies, iframe-blocking policies).
- Session revocation requires waiting for the IdP token expiry or a
  blocklist — the suspended-tenant gate (ADR-0057) would not take effect
  until token expiry.
- No logout control from the backend.

**Cost Implications:** ~0.5 day. **Risk Assessment:** Medium — XSS token
theft, weak revocation, IdP-dependent renewal.

---

### Option B: Backend-mediated OIDC with httpOnly session cookie

The SPA redirects to `GET /api/v1/auth/oidc/start`; the backend generates a
PKCE verifier + state, stores them in a signed httpOnly transient cookie,
and 302-redirects to Auth0. Auth0 redirects to `GET
/api/v1/auth/oidc/callback`; the backend verifies the state, exchanges the
code with the verifier, validates the ID token against the JWKS (reusing
`Auth0Provider`), and mints an internal session JWT set as a second httpOnly
cookie (`dominus_session`). All subsequent browser requests authenticate via
the cookie; API/CLI clients keep the Bearer path.

**Advantages:**
- No tokens reach the SPA — XSS surface unchanged from today (cookies are
  httpOnly).
- Sessions are server-mintable and revocable: logout clears the cookie, and
  rotating `AUTH0_CLIENT_SECRET` invalidates every session immediately.
- The suspended-tenant gate and `requireTenant` apply unchanged — the
  middleware accepts the session cookie and populates `req.tenantId`/`auth`
  identically to the Bearer path.
- Refresh tokens stay server-side (the IdP refresh flow is opaque to the
  SPA; a long-lived session TTL covers the dashboard without one today).
- Auth0 redirect flow stays standard (Authorization Code + PKCE S256).

**Disadvantages:**
- More moving parts: a transient signed cookie, a session JWT minter.
- The session JWT must be signed with a secret under operator control
  (derived via HKDF from `AUTH0_CLIENT_SECRET`, so rotating the Auth0
  application secret revokes sessions — a documented trade-off).
- CSRF surface shifts to the callback route — mitigated by the signed
  state/verifier cookie and strict state comparison.

**Cost Implications:** ~2-3 days. **Risk Assessment:** Low — standard
pattern, no new dependencies (jose is already a dependency).

---

### Option C: Native SAML 2.0

Implement a SAML 2.0 Service Provider (SP) flow with IdP-initiated and
SP-initiated SSO.

**Advantages:**
- Direct compatibility with Okta/Azure AD SAML apps and IdP-first SSO.

**Disadvantages:**
- SAML is XML-heavy; the protocol/redirect flow is substantially more code
  than OIDC, and a correct parser/validator is a security-critical surface.
- Auth0 (the reference IdP) is OIDC-first; SAML support is a conversion
  layer at the IdP.
- Adds a dependency (e.g. `samlify`) or a large hand-rolled XML layer,
  against the repo's dependency discipline.

**Cost Implications:** 5-10 days + dependency. **Risk Assessment:** High —
XML security (XXE, signature validation) is a standing vulnerability class.

## Decision

**Chosen option: Option B — Backend-mediated OIDC with httpOnly session cookie**

Option B satisfies every driver: the flow is IdP-agnostic through an
`OidcProvider` interface (`buildAuthorizeUrl`, `exchangeCode`,
`validateIdToken`, `logoutUrl`), with `Auth0OidcProvider` as the reference
implementation; sessions are httpOnly cookies minted by the backend and
revocable by logout or secret rotation; the endpoints are mounted only when
`AUTH_PROVIDER=auth0` AND `AUTH0_CLIENT_ID`/`AUTH0_CLIENT_SECRET`/
`AUTH0_CALLBACK_URL` are all present, otherwise they 404 (fail-closed); and
the configuration delta is exactly the three client credentials plus a TTL
knob (`AUTH0_SESSION_TTL_HOURS`, default 8h).

Option A was rejected because it inherits the localStorage-token exposure
and cannot revoke sessions server-side. Option C was rejected because its
cost and XML security surface are disproportionate for the reference IdP,
which is OIDC-native; a SAML adapter remains possible at the IdP layer
without touching this flow.

Session signing keys are HKDF-derived from `AUTH0_CLIENT_SECRET`
(salt `dominus-session-v1`, separate `info` labels for the session JWT and
the transient PKCE cookie). This avoids a new operator-managed secret while
making rotation of the Auth0 client secret an explicit global session
kill-switch — documented in the migration plan.

## Consequences

### Positive
- Enterprise users get an SSO button that lands them on the dashboard with
  a revocable, httpOnly session.
- The suspended-tenant gate (ADR-0057), usage enforcement (ADR-0038) and
  `requireTenant` (ADR-0034) work unchanged for browser sessions.
- No new dependencies and no tokens in the SPA.

### Negative
- Rotating `AUTH0_CLIENT_SECRET` signs every user out (accepted — it is a
  deliberate kill-switch, documented in `.env.example`).
- IdP-side global logout (`/v2/logout` redirect) is deferred; today logout
  only clears the DOMINUS session cookie.
- Refresh-token rotation and silent renewal are deferred until a session
  store exists.

### Compliance and Security Implications
- The callback route must be added to the Auth0 application's allowed
  callback URLs (documented in `.env.example`).
- The transient cookie is HMAC-signed, httpOnly, `SameSite=Lax`, `Secure`;
  the callback verifies the state strictly before exchanging the code
  (CSRF protection). PKCE S256 protects against code interception.
- The `AUTH0_CALLBACK_URL` is validated as an absolute URL by the config
  schema.

### Migration and Monitoring Plan
1. Deploy with `AUTH_PROVIDER=auth0` and the new client credentials in the
   cloud `.env`; the `/oidc` routes appear. No DB migration required.
2. Frontend ships the SSO button only when `GET /api/v1/auth/oidc/me`
   indicates the flow is mounted (the 404 case hides the button).
3. Success metrics: SSO logins per day, session-cookie auth rate on
   protected routes, and the absence of `sso_error=authentication_failed`
   spikes (alerted via request logs).
4. Rollback: remove the client credentials from `.env` — the routes 404 and
   Bearer auth is unaffected; existing sessions die at TTL.

### Validation
- Unit: session-JWT round-trip and tamper rejection; transient-cookie
  round-trip and tamper rejection; provider authorize/exchange/logout URLs;
  router happy paths and every fail-closed branch; middleware
  cookie-fallback with and without `requireTenant`.
- CI: the `release-gate` job and the backend matrix run the new suites.

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs
should be consistent with the ADR series starting at
`docs/adr/0001-project-architecture.md`.*