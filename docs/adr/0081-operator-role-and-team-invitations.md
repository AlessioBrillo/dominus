# ADR-0081: Platform operator role, SSO tenant resolution and team invitations

## Metadata

| Field          | Value                                                      |
| -------------- | ---------------------------------------------------------- |
| **Status**     | Accepted                                                   |
| **Date**       | 2026-10-08                                                 |
| **Authors**    | Alessio Brillo                                             |
| **Deciders**   | Alessio Brillo                                             |
| **Supersedes** | N/A                                                        |
| **Relates to** | ADR-0032, ADR-0034, ADR-0038, ADR-0053, ADR-0057, ADR-0062 |
| **Project**    | DOMINUS                                                    |

## Context

Three problems met in the v1.1.0 audit of the Cloud edition:

1. **Every tenant admin was a platform operator.** Self-signup minted an API key
   with role `admin`, and the same role gated the cross-tenant `/api/v1/admin`
   surface (all tenants, suspend, plan override). Anyone who registered could
   read and change other tenants. A suspended tenant's own admin also bypassed
   the suspension gate, which keyed on `admin`.
2. **Team seats were decorative.** `team_seats.user_id` held opaque strings,
   "inviting" wrote a pending row nobody could accept, nothing was delivered,
   and the OIDC login put the IdP's `org_id` claim (or nothing) in the session
   instead of the tenant the user actually belongs to. Pending invitations did
   not count against the plan, so seat limits could be exceeded.
3. **No email.** There was no way to tell a person they had been invited.

## Decision Drivers

1. Least privilege: the cross-tenant surface must be unreachable by any
   self-service flow.
2. The team seat is the source of truth for humans; the IdP only proves identity.
3. €0 community edition: email must be optional, never a requirement.
4. No new runtime dependency unless the feature needs it.

## Considered Options

### Option A: Reuse `admin` and add a `platform` flag on the tenant

Mark the operator's tenant (`tenant_admin_flags`) and let only that tenant's
admins into `/admin`.

**Advantages:** no new role; reuses the flags table.

**Disadvantages:** any admin of the operator tenant is an operator; membership
changes silently change who can suspend customers; the operator tenant is a
privileged tenant that billing and usage logic would have to special-case.

**Cost Implications:** small. **Risk Assessment:** medium, privilege tied to a mutable tenant.

---

### Option B: New `operator` role granted only by an environment allowlist (chosen)

`OPERATOR_SUBJECTS` lists OIDC/JWT subjects and `key:<id>` database key ids.
The auth middleware resolves the effective role; an `operator` claimed by a key
row or a token is ignored. `operator` satisfies every role check, `admin` stays
tenant-scoped.

**Advantages:** privilege is explicit, auditable and outside the data a tenant
can edit; empty allowlist fails closed; no schema change.

**Disadvantages:** changing operators needs a config change and restart.

**Cost Implications:** small. **Risk Assessment:** low.

---

### Option C: A separate operator application or database

**Advantages:** hard separation.

**Disadvantages:** a second deployable for a handful of read/suspend actions;
the existing admin router and tests already work.

**Cost Implications:** high. **Risk Assessment:** low, disproportionate.

## Decision Outcome

Chosen option: **B**.

- `OPERATOR_SUBJECTS` (comma-separated). The operator panel and the
  suspended-tenant bypass require `operator`. `GET /api/v1/me` and
  `/auth/oidc/me` report the effective role so the SPA shows the Admin link
  only to operators.
- OIDC sign-in resolves the tenant from the user's most recently joined active
  team seat and derives the role from the seat (`owner`/`admin` -> `admin`).
  Without a seat, an IdP `org_id` is honoured; otherwise a tenant is created
  with the user as admin when `OIDC_AUTO_PROVISION_TENANTS` is on (opt-in; the
  tenant id derives from the user so concurrent first sign-ins converge).
- Invitations are email-addressed single-use bearer links (`team_invitations`,
  only the SHA-256 stored, 7-day default lifetime). A pending invitation holds a
  seat. Acceptance requires the signed-in user's **verified** ID-token email to
  equal the invited address (checked before the token is claimed, so a wrong
  person cannot burn it), then claims the token atomically, creates the seat and
  re-issues the session for the team's tenant (`POST /auth/oidc/accept-invitation`).
- Email is a `Mailer` provider (ADR-0004): `SmtpMailer` (nodemailer, loaded only
  when `SMTP_URL` is set) or `NullMailer`. Without SMTP the API returns the link
  for the admin to share.
- Cookie-authenticated, state-changing requests must come from a trusted
  `Origin`/`Referer` (CSRF guard); Bearer callers are unaffected.

### Consequences

**Positive:** self-signup can no longer reach other tenants; seats mean what the
plan says; invitations work with or without SMTP.

**Negative / limits:**

- No tenant switcher: a user in several teams lands in the most recently joined
  one at the next sign-in. A switcher is a follow-up.
- Acceptance needs an identity provider that returns a verified `email` claim
  (Auth0 does with the default scope). A session without one cannot accept.
- Existing deployments must set `OPERATOR_SUBJECTS` to keep using `/admin`
  (documented in the 1.1.0 upgrade notes).
- Sessions are re-checked against the team seat on every request: a removed or
  pending seat ends the session at once and a role change applies immediately.
  Sessions that came from an IdP `org_id` claim have no seat and keep trusting
  the JWT until it expires (8 hours by default).
